/**
 * The toolkit catalog's refresh (#207): cron task `toolkit-catalog-refresh` (every 3 hours, with the API Worker's other
 * deployment-wide tasks) and the management route `POST /toolkit-catalog/refresh` fetch integrations.sh's index
 * (`INTEGRATIONS_SH_INDEX_URL`), trim it (`integrations-sh.ts`) and store the trimmed registry in KV (`stored.ts`), with
 * what the attempt did for the panel. It imports neither the bundled snapshot nor the catalog (`catalog.ts`): the API
 * Worker, which runs the cron task, does not bundle them.
 *
 * Bounded: one fetch through the outbound guard, a 30 s timeout and the document size limit of `fetchDocument` (8 MiB;
 * the index is ≈2.8 MB). A failed fetch, a document that is not the index or keeps fewer than `MIN_SOURCES` sources,
 * and a KV write that fails all keep the stored registry (or the snapshot); a catalog request never fetches. One
 * refresh runs at a time across isolates, under the Platform registry's lease `toolkit_catalog_refresh`; the second
 * gets `running` without fetching. See docs/ARCHITECTURE.md, "Toolkit catalog".
 */
import { Clock, Effect, Result } from "effect";
import type { HttpClient } from "effect/http";
import { type LeaseSource, refreshRunningMessage, withPlatformLease } from "@commissary/state";
import { ToolsEnv } from "../env.ts";
import { fetchDocument } from "../http/call.ts";
import { deploymentKvOf } from "../kv.ts";
import { INTEGRATIONS_SH_INDEX_URL, trimIntegrationsSh } from "./integrations-sh.ts";
import {
  CATALOG_KEYS,
  forgetCatalog,
  readRefreshStatus,
  storedRegistry,
  writeRefreshStatus,
} from "./stored.ts";

/** The Platform registry's lease (`@commissary/state` `lease.ts`) of the refresh: `toolkit_catalog_refresh_lease`. */
const REFRESH_LEASE = "toolkit_catalog_refresh";

const TIMEOUT = "30 seconds";

export interface CatalogRefreshOutcome {
  /** `running`: another refresh holds the lease; nothing was fetched. */
  readonly status: "updated" | "unchanged" | "failed" | "running";
  /** Why it failed or who is running: a fixed text, never a URL or an upstream body. */
  readonly message?: string;
  /** Sources in the stored registry (`updated`, `unchanged`). */
  readonly sources?: number;
}

/** A message reaches the panel: at most this long. */
const MAX_MESSAGE = 200;

const clip = (message: string): string =>
  message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message;

const failed = (message: string): CatalogRefreshOutcome => ({
  status: "failed",
  message: clip(message),
});

/** The fetch-trim-store step, without the lease. Never fails: the stored registry stays on any problem. */
const refreshNow: Effect.Effect<CatalogRefreshOutcome, never, ToolsEnv | HttpClient.HttpClient> =
  Effect.gen(function* () {
    const env = yield* ToolsEnv;
    const text = yield* Effect.result(fetchDocument(INTEGRATIONS_SH_INDEX_URL, TIMEOUT));

    if (Result.isFailure(text))
      return failed(
        text.failure.reason === "http"
          ? `integrations.sh answered HTTP ${text.failure.status ?? "error"}`
          : `integrations.sh's index: ${text.failure.message}`,
      );
    const trimmed = trimIntegrationsSh(text.success);

    if (!trimmed.ok) return failed(trimmed.error);

    if (trimmed.skipped > 0)
      yield* Effect.logWarning(
        `toolkit catalog: ${trimmed.skipped} malformed records of integrations.sh's index were left out`,
      );
    const next = JSON.stringify(trimmed.value);
    const sources = trimmed.value.data.length;
    const previous = yield* storedRegistry.pipe(Effect.orElseSucceed(() => null));

    if (previous === next) return { status: "unchanged", sources };

    const stored = yield* Effect.result(
      Effect.tryPromise(() => deploymentKvOf(env).put(CATALOG_KEYS.registry, next)),
    );

    if (Result.isFailure(stored)) return failed("storing the catalog failed");
    yield* forgetCatalog;

    return { status: "updated", sources };
  });

/** Logs `outcome` and records it in KV for the panel (`GET /toolkit-catalog/status`); a KV failure is ignored. */
const record = (outcome: CatalogRefreshOutcome): Effect.Effect<void, never, ToolsEnv> =>
  Effect.gen(function* () {
    const { status } = outcome;

    if (status === "failed")
      yield* Effect.logWarning(
        `toolkit catalog refresh failed, keeping the stored catalog: ${outcome.message ?? ""}`,
      );
    else yield* Effect.logInfo(`toolkit catalog: ${status}`);

    if (status === "running") return;
    const kv = deploymentKvOf(yield* ToolsEnv);
    const now = yield* Clock.currentTimeMillis;

    const previous = yield* Effect.tryPromise(() => readRefreshStatus(kv)).pipe(
      Effect.orElseSucceed(() => undefined),
    );

    const refreshedAt = status === "failed" ? previous?.refreshedAt : now;

    yield* Effect.tryPromise(() =>
      writeRefreshStatus(kv, {
        attemptedAt: now,
        status,
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
        ...(refreshedAt === undefined ? {} : { refreshedAt }),
      }),
    ).pipe(Effect.ignore);
  });

/**
 * One refresh under the Platform registry's lease (`withPlatformLease`): cron and the panel never fetch at once,
 * whichever isolates they run in; the second gets `running`. A Platform registry that cannot be reached fails the
 * refresh (exclusivity cannot be shown).
 */
export const refreshToolkitCatalog = (
  trigger: LeaseSource,
): Effect.Effect<CatalogRefreshOutcome, never, ToolsEnv | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const ran = yield* withPlatformLease(
      yield* ToolsEnv,
      REFRESH_LEASE,
      trigger,
      refreshNow.pipe(Effect.tap(record)),
    );

    if (ran.kind === "ran") return ran.value;

    if (ran.kind === "held") return { status: "running", message: refreshRunningMessage(ran.held) };
    const outcome = failed("platform registry unavailable");

    yield* record(outcome);

    return outcome;
  });
