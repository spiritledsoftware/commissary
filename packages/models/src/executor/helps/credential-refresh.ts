/**
 * Request-time credential preparation and the 401 -> refresh -> retry-once loop, shared by all executors.
 *
 * Go source: sdk/cliproxy/auth/conductor_refresh.go (`tryRefreshAfterUnauthorized`, which skips 401s that a configured
 * request-scoped error rule matched), conductor_execution.go
 * (`prepareRequestAuth`, `PrepareRequestAuth`; credentials.md §9.3-9.5). The token work lives in the ControlPlane
 * (`ensureFresh`, `refreshNow`: serialised per credential, persisted before returning); this module is the Worker side:
 *  - `ensureFresh` first for credentials whose snapshot cannot be used as is (Vertex without a minted token, Meta
 *    without a key, an OAuth token that is missing/expired, Antigravity within 5 minutes of expiry);
 *  - after an upstream 401, `refreshNow(id, rejectedToken)` and one repeat of the attempt with the new token.
 * The conductor wraps every attempt with {@link withCredentialRefresh}, so executors normally do not call it; executors
 * with their own transport paths (WebSocket) can use it directly with their `ExecutionContext`.
 */
import { Clock, Context, Effect, Layer, Result } from "effect";
import { accessTokenExpiry } from "../../credentials/expiry.ts";
import type { RefreshResult } from "../../credentials/refresh/index.ts";
import { metaNeedsMint } from "../../credentials/refresh/meta.ts";
import { ANTIGRAVITY_REQUEST_SAFETY_MS } from "../../credentials/refresh/schedule.ts";
import type { JsonObject } from "@commissary/json";
import { CurrentOrg, type OrgId } from "@commissary/core";
import { toExecutorSnapshot } from "../control-plane-picker.ts";
import { ExecutionError, withErrorFields } from "../errors.ts";
import type { CredentialSnapshot } from "../picker.ts";
import type { ExecutionContext } from "../types.ts";
import { matchRequestScopedAction, requestScopedRules } from "../classify.ts";
import { type ModelsBindings, ModelsEnv, modelsPartOf } from "../../env.ts";

/** The slice of the ControlPlane RPC surface used here (tests substitute their own). */
export interface RefreshApi {
  readonly refreshNow: (
    credentialId: string,
    rejectedAccessToken?: string,
  ) => PromiseLike<RefreshResult>;
  readonly ensureFresh: (credentialId: string) => PromiseLike<RefreshResult>;
}

export class CredentialRefresher extends Context.Service<
  CredentialRefresher,
  {
    readonly refreshNow: (
      credentialId: string,
      rejectedAccessToken?: string,
    ) => Effect.Effect<RefreshResult, never, ModelsEnv | CurrentOrg>;
    readonly ensureFresh: (
      credentialId: string,
    ) => Effect.Effect<RefreshResult, never, ModelsEnv | CurrentOrg>;
  }
>()("commissary/executor/CredentialRefresher") {
  /**
   * Calls the ControlPlane through `api(env, org)`; transport failures become structured `refresh_failed` results.
   */
  static readonly layerFor = (api: (env: ModelsBindings, org: OrgId) => RefreshApi) => {
    const call = (run: (api: RefreshApi) => PromiseLike<RefreshResult>) =>
      Effect.gen(function* () {
        const env = yield* ModelsEnv;
        const org = yield* CurrentOrg;

        return yield* Effect.tryPromise({
          try: async () => await run(api(env, org)),
          catch: () => "unavailable" as const,
        }).pipe(
          Effect.orElseSucceed((): RefreshResult => ({
            ok: false,
            error: { code: "refresh_failed", message: "credential store unavailable" },
            terminal: false,
          })),
        );
      });

    return Layer.succeed(
      CredentialRefresher,
      CredentialRefresher.of({
        refreshNow: (id, rejected) => call((target) => target.refreshNow(id, rejected)),
        ensureFresh: (id) => call((target) => target.ensureFresh(id)),
      }),
    );
  };

  /** Production: the ControlPlane Durable Object of the request's org. */
  static readonly controlPlane = CredentialRefresher.layerFor(modelsPartOf);

  /** No refresh support (tests with provider keys only). */
  static readonly none = Layer.succeed(
    CredentialRefresher,
    CredentialRefresher.of({
      refreshNow: () =>
        Effect.succeed({
          ok: false,
          error: { code: "not_refreshable", message: "refresh unavailable" },
          terminal: false,
        }),
      ensureFresh: () =>
        Effect.succeed({
          ok: false,
          error: { code: "not_refreshable", message: "refresh unavailable" },
          terminal: false,
        }),
    }),
  );
}

const accessTokenOf = (metadata: JsonObject): string => {
  const token = metadata["access_token"];

  return typeof token === "string" ? token.trim() : "";
};

/**
 * Whether the picked snapshot may need preparation before use. Conservative: provider-key credentials never do; OAuth
 * credentials only when the token is unusable or the provider mints tokens/keys on demand.
 */
export const needsPreparation = (credential: CredentialSnapshot, now: number): boolean => {
  if (credential.kind !== "oauth") return false;
  const metadata = credential.metadata;

  switch (credential.provider) {
    case "vertex":
      // Pick injects a cached service-account token; without one it has to be minted.
      return accessTokenOf(metadata) === "";
    case "meta":
      return metaNeedsMint(metadata);
    default: {
      const token = accessTokenOf(metadata);

      if (token === "") return true;
      const expiry = accessTokenExpiry(metadata);
      const safety = credential.provider === "antigravity" ? ANTIGRAVITY_REQUEST_SAFETY_MS : 0;

      return expiry !== undefined && expiry <= now + safety;
    }
  }
};

/** Failures that mean "nothing to prepare" rather than a broken credential. */
const BENIGN = new Set(["not_refreshable", "not_found"]);

const refreshError = (failure: Extract<RefreshResult, { ok: false }>): ExecutionError =>
  new ExecutionError({
    status:
      failure.terminal || failure.error.httpStatus === 401
        ? 401
        : (failure.error.httpStatus ?? 503),
    code: failure.error.code === "unauthorized" ? "unauthorized" : "refresh_failed",
    message: failure.error.message,
    ...(failure.terminal ? { terminalAuth: true } : {}),
  });

export interface RefreshHooks {
  /**
   * Called before the repeated attempt with the 401 error and the refreshed credential; returns the context of the
   * repeat (the conductor uses it to close the usage record of the rejected attempt and start a new one).
   */
  readonly retry?: (
    error: ExecutionError,
    credential: CredentialSnapshot,
  ) => Effect.Effect<ExecutionContext>;
}

/**
 * Runs `use` with a prepared credential and repeats it once with a refreshed token after a 401. Failing to prepare a
 * credential fails like an attempt; failing to refresh after a 401 returns the original 401 (marked `terminalAuth` when
 * the credential needs a new login). Other errors pass through untouched.
 */
export const withCredentialRefresh = <A, R>(
  context: ExecutionContext,
  use: (context: ExecutionContext) => Effect.Effect<A, ExecutionError, R>,
  hooks: RefreshHooks = {},
) =>
  Effect.gen(function* () {
    const refresher = yield* CredentialRefresher;
    let current = context;
    const now = yield* Clock.currentTimeMillis;

    if (needsPreparation(context.credential, now)) {
      const prepared = yield* refresher.ensureFresh(context.credential.id);

      if (prepared.ok) {
        current = { ...current, credential: toExecutorSnapshot(prepared.credential) };
      } else if (!BENIGN.has(prepared.error.code)) {
        return yield* refreshError(prepared);
      }
    }

    const first = yield* Effect.result(use(current));

    if (Result.isSuccess(first)) return first.success;
    const error = first.failure;

    if (error.status !== 401 || error.requestScoped === true) return yield* error;

    // A 401 a configured request-scoped rule matched is the rule's to handle (CLIProxyAPI 4138edb1): the token is
    // neither condemned nor refreshed, whatever the rule's action.
    if (
      matchRequestScopedAction(requestScopedRules(current.config, current.credential), error) !==
      undefined
    ) {
      return yield* error;
    }

    const rejected = accessTokenOf(current.credential.metadata);

    const refreshed = yield* refresher.refreshNow(
      current.credential.id,
      rejected === "" ? undefined : rejected,
    );

    if (!refreshed.ok) {
      return yield* refreshed.terminal ? withErrorFields(error, { terminalAuth: true }) : error;
    }

    const snapshot = toExecutorSnapshot(refreshed.credential);

    // The token did not change: repeating the request would only repeat the rejection.
    if (rejected !== "" && accessTokenOf(snapshot.metadata) === rejected) return yield* error;

    const next =
      hooks.retry === undefined
        ? { ...current, credential: snapshot }
        : yield* hooks.retry(error, snapshot);

    return yield* use(next);
  });
