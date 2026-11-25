/**
 * Antigravity model catalog probes (`fetchAvailableModels`) stored in KV by the cron task.
 *
 * Go source: sdk/cliproxy/antigravity_models.go (`probeAntigravityModelCapabilityHints`,
 * `parseAntigravityModelCapabilityHints`, `nextAntigravityFailure`, `nextAntigravityAuthErrorFailure`,
 * `nextAntigravityForbiddenFailure`, `shouldSkipAntigravityModelProbe`, `resolveAntigravityModelUserAgent`,
 * `persistedAntigravityHintsExpiresAt`) and sdk/auth/antigravity_models.go (`FetchAntigravityAvailableModels`,
 * `AntigravityCapabilityRouteFingerprint`). The probe uses the first configured endpoint only (daily by default) and the
 * credential's own user agent when it has one (CLIProxyAPI 753bfa19), sending `project` only when there is one. A
 * failed probe keeps the last good entitlements and backs off with equal jitter (CLIProxyAPI f8e297aa): a transient
 * failure 2, 4, 8, 16, 30 min and a 401 10, 20, 30 min, both for the access token that failed (a refreshed token probes
 * at once); a 403 10, 20, 40, 60 min for the credential whatever its token. Disabled credentials and those whose token
 * was rejected for good are not probed (CLIProxyAPI f48975b4). A success records when it was fetched, when it expires
 * (3 h) and the route it was fetched on (CLIProxyAPI 533edd38); the cron skips a record that is still fresh for longer
 * than {@link FRESH_SLACK_MS} on the same route. The cron fires every 3 h (like `ModelsRefreshInterval`), so a backoff
 * mostly matters for manual runs. Registry snapshots read the KV records (`withAntigravityHints`).
 */
import { Effect, Match, Option } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { CurrentOrg, type OrgKv, sha256Hex } from "@commissary/core";
import { deploymentKvOf, orgKvOf } from "../../kv.ts";
import { controlPlaneOf } from "@commissary/state";
import {
  type AntigravityModelHints,
  normalizeFetchedModelId,
} from "../../registry/antigravity-hints.ts";
import type { ModelSource } from "../../registry/source.ts";
import {
  antigravityRequestUserAgent,
  antigravityUserAgent,
  currentAntigravityVersion,
} from "./version.ts";
import { ANTIGRAVITY_BASE_URL_DAILY, configuredUserAgent } from "./envelope.ts";
import { hasUnauthorizedFailure } from "../../credentials/selection/availability.ts";
import { FULL_ACCESS } from "../../credentials/ownership.ts";
import { ModelsEnv } from "../../env.ts";

export const MODELS_PATH = "/v1internal:fetchAvailableModels";

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

const MAX_FAILURES = 5;

/** `antigravityCapabilityRetryBase` (the first window is twice the base). */
const BASE_BACKOFF_MS = 60_000;

const MAX_BACKOFF_MS = 30 * 60_000;

/** `antigravityAuthErrorRetryBase`. */
const AUTH_ERROR_BACKOFF_MS = 5 * 60_000;

/** `antigravityForbiddenRetryBase`, `antigravityForbiddenRetryMax`. */
const FORBIDDEN_BACKOFF_MS = 5 * 60_000;

const MAX_FORBIDDEN_BACKOFF_MS = 60 * 60_000;

/** `antigravityCapabilityCacheTTL` (`registry.ModelsRefreshInterval`). */
export const CATALOG_TTL_MS = 3 * 60 * 60_000;

/** A record fresh for longer than this is not probed again (the cron's own timing jitter stays covered). */
export const FRESH_SLACK_MS = 15 * 60_000;

/** Failure counters older than 2x the refresh interval start over (`registry.ModelsRefreshInterval` = 3 h). */
const FAILURE_RESET_MS = 2 * 3 * 60 * 60_000;

/** KV name of a credential's entitlements within its org. */
export const antigravityModelsName = (credentialId: string): string => `ag:models:${credentialId}`;

export interface FailureState {
  readonly count: number;
  readonly lastFailureAt: number;
  readonly nextRetryAt: number;
  /**
   * Digest of the access token that failed (transient and 401 failures): the backoff holds only while the credential
   * still has it. Absent on a 403 backoff and on records stored before it existed.
   */
  readonly token?: string;
}

/** The stored record: last good entitlements plus failure bookkeeping. */
export interface ModelsRecord {
  readonly hints?: AntigravityModelHints;
  /**
   * The catalog scope of the credential the hints were probed with (`antigravityCatalogScope`): the executor uses the
   * enums and thinking groups only while the credential still has it. Absent on records stored before it existed.
   */
  readonly scope?: string;
  readonly fetchedAt?: number;
  /** When the probed entitlements expire (`fetchedAt` + 3 h). Absent on records stored before it existed. */
  readonly expiresAt?: number;
  /** `AntigravityCapabilityRouteFingerprint` of the user agent the entitlements were probed with. */
  readonly routeFingerprint?: string;
  /** The backoff of a transient or 401 failure, for the access token in `token`. */
  readonly failure?: FailureState;
  /** The backoff of a 403, for the credential whatever its access token. */
  readonly forbidden?: FailureState;
}

export type ProbeOutcome =
  | { readonly status: "success"; readonly hints: AntigravityModelHints }
  | { readonly status: "auth_error" | "forbidden" | "transient" };

/** `antigravityMaxModelIDBytes`: longer model ids, enums and group members are ignored. */
export const MAX_MODEL_ID_BYTES = 256;

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

/** `antigravitycatalog.ValidThinkingSuffix`: ASCII alphanumeric segments joined by single hyphens. */
export const validThinkingSuffix = (suffix: string): boolean =>
  /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(suffix);

/** `parseAntigravityThinkingGroups`: each group's levels whose `<group>-<level>` member is in `models`. */
const parseThinkingGroups = (
  groupedModels: Json | undefined,
  models: JsonObject,
): Record<string, Record<string, number>> | undefined => {
  if (!isJsonObject(groupedModels) || Object.keys(models).length === 0) return undefined;
  let groups: Record<string, Record<string, number>> | undefined;

  for (const [group, entry] of Object.entries(groupedModels)) {
    if (group === "" || utf8Length(group) >= MAX_MODEL_ID_BYTES || !isJsonObject(entry)) continue;
    const declared = entry["supportedThinkingLevels"];

    if (!isJsonArray(declared)) continue;
    let levels: Record<string, number> | undefined;

    for (const item of declared) {
      if (!isJsonObject(item)) continue;
      const suffix = item["thinkingSuffix"];

      if (
        typeof suffix !== "string" ||
        utf8Length(group) + 1 + utf8Length(suffix) > MAX_MODEL_ID_BYTES ||
        !validThinkingSuffix(suffix)
      )
        continue;
      const level = suffix.toLowerCase();
      const member = models[`${group}-${level}`];

      if (!isJsonObject(member)) continue;
      // Zero records a declared member that is not eligible as a switch target.
      const limit = member["maxOutputTokens"];
      levels ??= {};
      levels[level] =
        typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
    }

    if (levels !== undefined) {
      groups ??= {};
      groups[group] = levels;
    }
  }

  return groups;
};

/** `antigravityThinkingWebSearch`: grouped members listed (by exact id) in `webSearchModelIds`. */
const thinkingWebSearchOf = (
  groups: Readonly<Record<string, Readonly<Record<string, number>>>> | undefined,
  declared: ReadonlyArray<string>,
): string[] => {
  if (groups === undefined || declared.length === 0) return [];
  const listed = new Set(declared);

  return Object.entries(groups).flatMap(([group, levels]) =>
    Object.keys(levels)
      .map((level) => `${group}-${level}`)
      .filter((id) => listed.has(id)),
  );
};

/** `parseAntigravityModelCapabilityHints`. */
export const parseModelHints = (body: string): AntigravityModelHints | undefined => {
  const root = tryParseJson(body);

  if (!isJsonObject(root)) return undefined;
  const rawWebSearch = root["webSearchModelIds"];

  const rawIds = isJsonArray(rawWebSearch)
    ? rawWebSearch.flatMap((id) => (typeof id === "string" ? [id] : []))
    : [];

  const webSearchModelIds = rawIds.map(normalizeFetchedModelId).filter((id) => id !== "");
  const models = root["models"];

  if (!isJsonObject(models)) return { webSearchModelIds };
  const modelEnums: Record<string, string> = {};

  for (const [id, entry] of Object.entries(models)) {
    if (id === "" || utf8Length(id) > MAX_MODEL_ID_BYTES) continue;
    const value = asString(get(entry, "model"));

    if (value.trim() !== "" && utf8Length(value) <= MAX_MODEL_ID_BYTES) modelEnums[id] = value;
  }

  const thinkingGroups = parseThinkingGroups(root["groupedModels"], models);
  const thinkingWebSearch = thinkingWebSearchOf(thinkingGroups, rawIds);

  return {
    modelIds: Object.keys(models)
      .map(normalizeFetchedModelId)
      .filter((id) => id !== ""),
    webSearchModelIds,
    ...(Object.keys(modelEnums).length > 0 ? { modelEnums } : {}),
    ...(thinkingGroups === undefined ? {} : { thinkingGroups }),
    ...(thinkingWebSearch.length > 0 ? { thinkingWebSearch } : {}),
  };
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

/** `AntigravityCapabilityRouteFingerprint` without a proxy (Workers has none): `""` without a user agent. */
export const routeFingerprint = (userAgent: string): string =>
  userAgent.trim() === ""
    ? ""
    : sha256Hex(`${JSON.stringify("")}/${JSON.stringify(userAgent.trim())}`);

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
      HttpClientRequest.bodyText(
        JSON.stringify(input.projectId.trim() === "" ? {} : { project: input.projectId.trim() }),
        "application/json",
      ),
    );

    const response = yield* client.execute(request).pipe(Effect.timeout("30 seconds"));

    if (response.status === 401) return { status: "auth_error" } as const;

    if (response.status === 403) return { status: "forbidden" } as const;

    if (response.status < 200 || response.status >= 300) return { status: "transient" } as const;
    const text = yield* response.text;

    if (text.length > MAX_CATALOG_BYTES) return { status: "transient" } as const;
    const hints = parseModelHints(text);

    return hints === undefined
      ? ({ status: "transient" } as const)
      : ({ status: "success", hints } as const);
  }).pipe(Effect.catchCause(() => Effect.succeed({ status: "transient" } as const)));

/** A backoff policy: the first window is twice `baseMs`, doubling up to `maxMs`. */
export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
}

/** `nextAntigravityFailure`: 2, 4, 8, 16, 30 min. */
export const TRANSIENT_BACKOFF: BackoffPolicy = { baseMs: BASE_BACKOFF_MS, maxMs: MAX_BACKOFF_MS };

/** `nextAntigravityAuthErrorFailure`: 10, 20, 30 min. */
export const AUTH_ERROR_BACKOFF: BackoffPolicy = {
  baseMs: AUTH_ERROR_BACKOFF_MS,
  maxMs: MAX_BACKOFF_MS,
};

/** `nextAntigravityForbiddenFailure`: 10, 20, 40, 60 min. */
export const FORBIDDEN_BACKOFF: BackoffPolicy = {
  baseMs: FORBIDDEN_BACKOFF_MS,
  maxMs: MAX_FORBIDDEN_BACKOFF_MS,
};

/**
 * `nextAntigravityFailureWithPolicy`: the window doubles from `2 * base` up to the policy's cap, with equal jitter
 * (`half + rand * half`); the failure count (capped at 5) carries over between policies.
 */
export const nextFailure = (
  previous: FailureState | undefined,
  now: number,
  random: number,
  policy: BackoffPolicy = TRANSIENT_BACKOFF,
): FailureState => {
  let count =
    previous === undefined || now - previous.lastFailureAt > FAILURE_RESET_MS ? 0 : previous.count;

  count = Math.min(count, MAX_FAILURES - 1) + 1;
  let window = Math.min(2 * policy.baseMs, policy.maxMs);

  for (let step = 1; step < count && window < policy.maxMs; step++) {
    window = window > policy.maxMs / 2 ? policy.maxMs : window * 2;
  }

  const half = window / 2;

  return { count, lastFailureAt: now, nextRetryAt: now + Math.floor(half + random * half) };
};

/** Digest of an access token, the key of its token-scoped backoff. */
export const tokenDigest = (token: string): string => sha256Hex(token.trim()).slice(0, 16);

/**
 * `persistedAntigravityHintsExpiresAt`: when a record's entitlements expire on `fingerprint`'s route, `0` when they
 * already did, were fetched on another route, or carry no fetch time.
 */
export const recordExpiresAt = (
  record: ModelsRecord | undefined,
  fingerprint: string,
  now: number,
): number => {
  if (record === undefined || fingerprint === "" || record.routeFingerprint !== fingerprint)
    return 0;

  const capped =
    record.expiresAt !== undefined
      ? Math.min(
          record.expiresAt,
          record.fetchedAt === undefined ? record.expiresAt : record.fetchedAt + CATALOG_TTL_MS,
        )
      : record.fetchedAt === undefined
        ? 0
        : record.fetchedAt + CATALOG_TTL_MS;

  const expiresAt = Math.min(capped, now + CATALOG_TTL_MS);

  return expiresAt > now ? expiresAt : 0;
};

/** `resolveAntigravityModelUserAgent`: the credential's own user agent, else the Hub client's. */
export const modelsUserAgent = (
  attributes: Readonly<Record<string, string>>,
  metadata: JsonObject,
  version: string,
): string => {
  const configured = configuredUserAgent(attributes, metadata).trim();

  return configured === ""
    ? antigravityUserAgent(version)
    : antigravityRequestUserAgent(configured, version);
};

/**
 * `antigravityLocalModelEnumScope`: the grant (refresh token, else access token), project and probe endpoint the
 * catalog belongs to. Another account, project or endpoint under the same credential id never reads its enums.
 */
export const antigravityCatalogScope = (
  attributes: Readonly<Record<string, string>>,
  metadata: JsonObject,
): string => {
  const text = (key: string): string =>
    typeof metadata[key] === "string" ? metadata[key].trim() : "";

  const grant = text("refresh_token") || text("access_token");

  if (grant === "") return "";

  return sha256Hex(
    JSON.stringify([grant, text("project_id"), modelsBaseUrl(attributes, metadata)]),
  );
};

/** Go `readAntigravityModelEnumDoc`: a stored catalog over 2 MiB is not read. */
const MAX_MODELS_RECORD_BYTES = 2 << 20;

// A UTF-8 character takes one to three bytes per UTF-16 unit, so only a record in between needs encoding.
const tooLarge = (raw: string): boolean =>
  raw.length > MAX_MODELS_RECORD_BYTES ||
  (raw.length * 3 > MAX_MODELS_RECORD_BYTES && utf8Length(raw) > MAX_MODELS_RECORD_BYTES);

/** The stored record of one credential (best effort; one over 2 MiB counts as none). */
export const readModelsRecord = async (
  kv: OrgKv,
  credentialId: string,
): Promise<ModelsRecord | undefined> => {
  try {
    const raw = await kv.get(antigravityModelsName(credentialId));

    if (raw !== null && tooLarge(raw)) return undefined;

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
      const record = await readModelsRecord(kv, id);

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

/** Whether a backoff still holds: a token-scoped one only for the token that failed. */
const backingOff = (failure: FailureState | undefined, token: string | undefined, now: number) =>
  failure !== undefined &&
  failure.nextRetryAt > now &&
  (token === undefined || failure.token === undefined || failure.token === token);

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
    if (source.provider.trim().toLowerCase() !== "antigravity") continue;

    // `shouldSkipAntigravityModelProbe`: a disabled credential, or one whose token was rejected for good.
    if (
      source.disabled ||
      source.state.status === "disabled" ||
      hasUnauthorizedFailure({ ...source.state })
    ) {
      results.push({ id: source.id, status: "skipped" });
      continue;
    }

    const previous = yield* Effect.promise(() => readModelsRecord(kv, source.id));

    if (backingOff(previous?.forbidden, undefined, now)) {
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
        ? credential.metadata["access_token"].trim()
        : "";

    const project =
      typeof credential?.metadata["project_id"] === "string"
        ? credential.metadata["project_id"]
        : "";

    if (credential === undefined || token === "") {
      results.push({ id: source.id, status: "no_token" });
      continue;
    }

    const digest = tokenDigest(token);

    if (backingOff(previous?.failure, digest, now)) {
      results.push({ id: source.id, status: "backoff" });
      continue;
    }

    const userAgent = modelsUserAgent(credential.attributes, credential.metadata, version);
    const fingerprint = routeFingerprint(userAgent);
    const scope = antigravityCatalogScope(credential.attributes, credential.metadata);

    // Entitlements of the same account and route fetched recently enough are kept as they are (CLIProxyAPI 533edd38).
    if (
      previous?.hints !== undefined &&
      (previous.scope === undefined || previous.scope === scope) &&
      recordExpiresAt(previous, fingerprint, now) > now + FRESH_SLACK_MS
    ) {
      results.push({ id: source.id, status: "fresh" });
      continue;
    }

    const outcome = yield* probeAvailableModels({
      baseUrl: modelsBaseUrl(credential.attributes, credential.metadata),
      accessToken: token,
      projectId: project,
      userAgent,
    });

    const kept: ModelsRecord = {
      ...(previous?.hints === undefined ? {} : { hints: previous.hints }),
      ...(previous?.fetchedAt === undefined ? {} : { fetchedAt: previous.fetchedAt }),
      ...(previous?.expiresAt === undefined ? {} : { expiresAt: previous.expiresAt }),
      ...(previous?.routeFingerprint === undefined
        ? {}
        : { routeFingerprint: previous.routeFingerprint }),
      ...(previous?.scope === undefined ? {} : { scope: previous.scope }),
    };

    // Go keys the 403 backoff by the credential's route and the others by the access token as well.
    const tokenFailure = previous?.failure?.token === digest ? previous.failure : undefined;

    const record = Match.value(outcome).pipe(
      Match.when({ status: "success" }, (success): ModelsRecord => ({
        hints: success.hints,
        fetchedAt: now,
        expiresAt: now + CATALOG_TTL_MS,
        ...(fingerprint === "" ? {} : { routeFingerprint: fingerprint }),
        ...(scope === "" ? {} : { scope }),
      })),
      Match.when({ status: "forbidden" }, (): ModelsRecord => ({
        ...kept,
        forbidden: nextFailure(previous?.forbidden, now, Math.random(), FORBIDDEN_BACKOFF),
      })),
      Match.orElse((failed): ModelsRecord => ({
        ...kept,
        ...(previous?.forbidden === undefined ? {} : { forbidden: previous.forbidden }),
        failure: {
          ...nextFailure(
            tokenFailure,
            now,
            Math.random(),
            failed.status === "auth_error" ? AUTH_ERROR_BACKOFF : TRANSIENT_BACKOFF,
          ),
          token: digest,
        },
      })),
    );

    yield* Effect.tryPromise(() =>
      kv.put(antigravityModelsName(source.id), JSON.stringify(record)),
    ).pipe(Effect.catch(() => Effect.logWarning("antigravity model catalog could not be stored")));
    results.push({ id: source.id, status: outcome.status });
  }

  return results;
});
