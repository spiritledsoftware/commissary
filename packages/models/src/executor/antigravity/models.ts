/**
 * Antigravity model catalog probes (`fetchAvailableModels`) stored in KV by the cron task.
 *
 * Go source: sdk/cliproxy/antigravity_models.go (`probeAntigravityModelCapabilityHints`,
 * `parseAntigravityModelCapabilityHints`, `nextAntigravityFailure`). The probe uses the first configured endpoint only
 * (daily by default) and the global user agent; 401/403 are auth errors, everything else transient. A failed probe keeps
 * the last good entitlements; failures back off 2, 4, 8, 16, 30 min (equal jitter). The cron fires every 3 h (like
 * `ModelsRefreshInterval`), so a backoff only matters for manual runs. Registry snapshots read the KV records
 * (`withAntigravityHints`).
 */
import { Effect, Option } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  asString,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { CurrentOrg, type OrgKv } from "@commissary/core";
import { deploymentKvOf, orgKvOf } from "../../kv.ts";
import { controlPlaneOf } from "@commissary/state";
import {
  type AntigravityModelHints,
  normalizeFetchedModelId,
} from "../../registry/antigravity-hints.ts";
import type { ModelSource } from "../../registry/source.ts";
import { antigravityUserAgent, currentAntigravityVersion } from "./version.ts";
import { ANTIGRAVITY_BASE_URL_DAILY } from "./envelope.ts";
import { FULL_ACCESS } from "../../credentials/ownership.ts";
import { ModelsEnv } from "../../env.ts";

export const MODELS_PATH = "/v1internal:fetchAvailableModels";

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

const MAX_FAILURES = 5;

const BASE_BACKOFF_MS = 2 * 60_000;

const MAX_BACKOFF_MS = 30 * 60_000;

/** Failure counters older than 2x the refresh interval start over (`registry.ModelsRefreshInterval` = 3 h). */
const FAILURE_RESET_MS = 2 * 3 * 60 * 60_000;

/** KV name of a credential's entitlements within its org. */
export const antigravityModelsName = (credentialId: string): string => `ag:models:${credentialId}`;

export interface FailureState {
  readonly count: number;
  readonly lastFailureAt: number;
  readonly nextRetryAt: number;
}

/** The stored record: last good entitlements plus failure bookkeeping. */
export interface ModelsRecord {
  readonly hints?: AntigravityModelHints;
  readonly fetchedAt?: number;
  readonly failure?: FailureState;
}

export type ProbeOutcome =
  | { readonly status: "success"; readonly hints: AntigravityModelHints }
  | { readonly status: "auth_error" | "transient" };

/** `parseAntigravityModelCapabilityHints`. */
export const parseModelHints = (body: string): AntigravityModelHints | undefined => {
  const root = tryParseJson(body);

  if (!isJsonObject(root)) return undefined;

  const ids = (list: Json | undefined): string[] =>
    isJsonArray(list)
      ? list.map((id) => normalizeFetchedModelId(asString(id))).filter((id) => id !== "")
      : [];

  const models = root["models"];
  const webSearchModelIds = ids(root["webSearchModelIds"]);

  if (isJsonObject(models)) {
    return {
      modelIds: Object.keys(models)
        .map(normalizeFetchedModelId)
        .filter((id) => id !== ""),
      webSearchModelIds,
    };
  }

  return { webSearchModelIds };
};

/** `antigravityModelBaseURLs` (first only): `base_urls`, then `base_url`, else daily. */
export const modelsBaseUrl = (
  attributes: Readonly<Record<string, string>>,
  metadata: JsonObject,
): string => {
  const list = (attributes["base_urls"] ?? "")
    .split(",")
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter((url) => url !== "");

  const [firstUrl] = list;

  if (firstUrl !== undefined) return firstUrl;

  const single =
    (attributes["base_url"] ?? "").trim() ||
    (typeof metadata["base_url"] === "string" ? metadata["base_url"].trim() : "");

  return single !== "" ? single.replace(/\/+$/, "") : ANTIGRAVITY_BASE_URL_DAILY;
};

/** The probe itself. */
export const probeAvailableModels = (input: {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly projectId: string;
  readonly userAgent: string;
}): Effect.Effect<ProbeOutcome, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const request = HttpClientRequest.post(`${input.baseUrl}${MODELS_PATH}`).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/json",
        authorization: `Bearer ${input.accessToken}`,
        "user-agent": input.userAgent,
      }),
      HttpClientRequest.bodyText(JSON.stringify({ project: input.projectId }), "application/json"),
    );

    const response = yield* client.execute(request).pipe(Effect.timeout("30 seconds"));

    if (response.status === 401 || response.status === 403)
      return { status: "auth_error" } as const;

    if (response.status < 200 || response.status >= 300) return { status: "transient" } as const;
    const text = yield* response.text;

    if (text.length > MAX_CATALOG_BYTES) return { status: "transient" } as const;
    const hints = parseModelHints(text);

    return hints === undefined
      ? ({ status: "transient" } as const)
      : ({ status: "success", hints } as const);
  }).pipe(Effect.catchCause(() => Effect.succeed({ status: "transient" } as const)));

/** `nextAntigravityFailure`: window `min(2m * 2^(n-1), 30m)` with equal jitter (`half + rand * half`). */
export const nextFailure = (
  previous: FailureState | undefined,
  now: number,
  random: number,
): FailureState => {
  let count =
    previous === undefined || now - previous.lastFailureAt > FAILURE_RESET_MS ? 0 : previous.count;

  count = Math.min(count + 1, MAX_FAILURES);
  const window = Math.min(BASE_BACKOFF_MS * 2 ** (count - 1), MAX_BACKOFF_MS);
  const half = window / 2;

  return { count, lastFailureAt: now, nextRetryAt: now + Math.floor(half + random * half) };
};

const readRecord = async (kv: OrgKv, credentialId: string): Promise<ModelsRecord | undefined> => {
  try {
    const raw = await kv.get(antigravityModelsName(credentialId));

    // SAFETY: the cron task only stores `ModelsRecord` values under this key (see `writeRecord`).
    return raw === null ? undefined : (JSON.parse(raw) as ModelsRecord);
  } catch {
    return undefined;
  }
};

/** Reads the stored entitlements of the given Antigravity credentials of `org` (best effort). */
export const loadAntigravityHints = async (
  kv: OrgKv | undefined,
  credentialIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, AntigravityModelHints>> => {
  const out = new Map<string, AntigravityModelHints>();

  if (kv === undefined) return out;
  await Promise.all(
    credentialIds.map(async (id) => {
      const record = await readRecord(kv, id);

      if (record?.hints !== undefined) out.set(id, record.hints);
    }),
  );

  return out;
};

/** Attaches the stored entitlements to the Antigravity sources of a registry snapshot of `org`. */
export const withAntigravityHints = async (
  kv: OrgKv | undefined,
  sources: ReadonlyArray<ModelSource>,
): Promise<ReadonlyArray<ModelSource>> => {
  const ids = sources.flatMap((source) =>
    source.provider.trim().toLowerCase() === "antigravity" ? [source.id] : [],
  );

  if (ids.length === 0) return sources;
  const hints = await loadAntigravityHints(kv, ids);

  if (hints.size === 0) return sources;

  return sources.map((source) => {
    const found = hints.get(source.id);

    return found === undefined ? source : { ...source, antigravityHints: found };
  });
};

/**
 * Cron task, per org: probes every enabled Antigravity credential of the org. The token comes from the org's
 * ControlPlane (`ensureFresh` refreshes it when needed), results are written to KV; failures keep the previous
 * entitlements.
 */
export const refreshAntigravityModels = Effect.gen(function* () {
  const env = yield* ModelsEnv;
  const org = yield* CurrentOrg;
  const plane = controlPlaneOf(env, org);
  const kv = orgKvOf(env, org);
  const sources = yield* Effect.promise(() => plane.models().listModelSources(FULL_ACCESS));
  const now = Date.now();
  const version = yield* currentAntigravityVersion(deploymentKvOf(env), now);
  const results: Array<{ readonly id: string; readonly status: string }> = [];

  for (const source of sources) {
    if (source.provider.trim().toLowerCase() !== "antigravity" || source.disabled) continue;
    const previous = yield* Effect.promise(() => readRecord(kv, source.id));

    if (previous?.failure !== undefined && previous.failure.nextRetryAt > now) {
      results.push({ id: source.id, status: "backoff" });
      continue;
    }

    const prepared = yield* Effect.tryPromise(
      async () => await plane.models().ensureFresh(source.id),
    ).pipe(Effect.option);

    const credential =
      Option.isSome(prepared) && prepared.value.ok ? prepared.value.credential : undefined;

    const token =
      typeof credential?.metadata["access_token"] === "string"
        ? credential.metadata["access_token"]
        : "";

    const project =
      typeof credential?.metadata["project_id"] === "string"
        ? credential.metadata["project_id"]
        : "";

    if (credential === undefined || token === "") {
      results.push({ id: source.id, status: "no_token" });
      continue;
    }

    // The probe always uses the global user agent and ignores a per-credential override.
    const outcome = yield* probeAvailableModels({
      baseUrl: modelsBaseUrl(credential.attributes, credential.metadata),
      accessToken: token,
      projectId: project,
      userAgent: antigravityUserAgent(version),
    });

    const record: ModelsRecord =
      outcome.status === "success"
        ? { hints: outcome.hints, fetchedAt: now }
        : {
            ...(previous?.hints === undefined ? {} : { hints: previous.hints }),
            ...(previous?.fetchedAt === undefined ? {} : { fetchedAt: previous.fetchedAt }),
            failure: nextFailure(previous?.failure, now, Math.random()),
          };

    yield* Effect.tryPromise(() =>
      kv.put(antigravityModelsName(source.id), JSON.stringify(record)),
    ).pipe(Effect.catch(() => Effect.logWarning("antigravity model catalog could not be stored")));
    results.push({ id: source.id, status: outcome.status });
  }

  return results;
});
