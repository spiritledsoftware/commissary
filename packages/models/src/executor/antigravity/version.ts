/**
 * Antigravity client version, user agents and the Hub manifest poller.
 *
 * Go source: internal/misc/antigravity_version.go. Cloud Code rejects newer models for clients older than 2.23.0, so the
 * fallback must stay >= 2.23.0. The latest version comes from the Hub updater manifest: the cron task
 * (`models/scheduled-tasks.ts`) writes it to KV `CACHE` (`antigravity:version`), executors read it through a short
 * per-isolate cache and fall back to `2.35.1` when the entry is missing or older than the 6 h TTL. A release without a
 * known changelist is pinned to the highest mapped release (CLIProxyAPI f2b00303, 093c7efa, 2d50f315).
 */
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { isJsonObject, tryParseJson } from "@commissary/json";
import { type DeploymentKv, deploymentKey } from "@commissary/core";
import { ModelsEnv } from "../../env.ts";
import { deploymentKvOf } from "../../kv.ts";

export const ANTIGRAVITY_FALLBACK_VERSION = "2.35.1";

export const ANTIGRAVITY_HUB_METADATA = "os_type=darwin; arch=arm64";

/**
 * `antigravityHubChangelists`: changelists belong to specific Hub releases. Update the fallback version and its entry
 * together; an unmapped release is pinned to the highest mapped one, so a user agent never omits `cl=` or pairs a
 * newer version with an older build's changelist.
 */
export const ANTIGRAVITY_HUB_CHANGELISTS: ReadonlyMap<string, string> = new Map([
  ["2.23.0", "998057262"],
  ["2.24.0", "1000335682"],
  ["2.29.0", "1013060670"],
  ["2.32.1", "1021296516"],
  ["2.32.2", "1022991777"],
  ["2.33.0", "1023160026"],
  ["2.34.0", "1026637980"],
  ["2.35.0", "1028447422"],
  ["2.35.1", "1029194470"],
]);

export const ANTIGRAVITY_VERSION_TTL_MS = 6 * 60 * 60 * 1000;

export const ANTIGRAVITY_NODE_API_CLIENT_UA = "google-api-nodejs-client/10.3.0";

export const ANTIGRAVITY_GOOG_API_CLIENT_UA = "gl-node/22.21.1";

export const ANTIGRAVITY_HUB_MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";

export const ANTIGRAVITY_VERSION_KEY = deploymentKey("antigravity:version");

const MANIFEST_LIMIT = 4096;

/** Isolates re-read the KV entry at most this often. */
const READ_CACHE_MS = 60_000;

/** `isValidAntigravitySemVersion`: exactly three numeric parts. */
export const isValidAntigravityVersion = (version: string): boolean =>
  /^\d+\.\d+\.\d+$/.test(version);

/** The `version` key of the (flat) updater manifest YAML, `undefined` when absent or invalid. */
export const parseManifestVersion = (manifest: string): string | undefined => {
  for (const line of manifest.split("\n")) {
    const match = /^version:\s*(.*?)\s*$/.exec(line);

    if (match === null) continue;
    const version = (match[1] ?? "").replace(/^(["'])(.*)\1$/, "$2").trim();

    return isValidAntigravityVersion(version) ? version : undefined;
  }

  return undefined;
};

const semver = (version: string): readonly [number, number, number] | undefined => {
  if (!isValidAntigravityVersion(version)) return undefined;
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);

  return [major, minor, patch];
};

const compareSemver = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number => (a[0] - b[0] !== 0 ? a[0] - b[0] : a[1] - b[1] !== 0 ? a[1] - b[1] : a[2] - b[2]);

/** A Hub release and the changelist its user agent carries. */
export interface HubRelease {
  readonly version: string;
  readonly changelist: string;
}

/**
 * `resolveAntigravityHubVersionAndChangelist`: a mapped release keeps its own changelist; any other is pinned to the
 * highest mapped release and its changelist.
 */
export const resolveAntigravityHubVersion = (version: string): HubRelease => {
  const own = ANTIGRAVITY_HUB_CHANGELISTS.get(version);

  if (own !== undefined && own !== "") return { version, changelist: own };

  let best: (HubRelease & { readonly parsed: readonly [number, number, number] }) | undefined;

  for (const [candidate, changelist] of ANTIGRAVITY_HUB_CHANGELISTS) {
    const parsed = semver(candidate);

    if (changelist === "" || parsed === undefined) continue;

    if (best === undefined || compareSemver(parsed, best.parsed) > 0)
      best = { version: candidate, changelist, parsed };
  }

  return best === undefined
    ? {
        version: ANTIGRAVITY_FALLBACK_VERSION,
        changelist: ANTIGRAVITY_HUB_CHANGELISTS.get(ANTIGRAVITY_FALLBACK_VERSION) ?? "",
      }
    : { version: best.version, changelist: best.changelist };
};

export const antigravityUserAgent = (latest: string): string => {
  const { version, changelist } = resolveAntigravityHubVersion(latest);
  const metadata = `aidev_client; ${ANTIGRAVITY_HUB_METADATA}${changelist === "" ? "" : `; cl=${changelist}`}`;

  return `antigravity/hub/${version} (${metadata})`;
};

const isAntigravityFamily = (lower: string): boolean =>
  lower.startsWith("antigravity/hub/") || lower.startsWith("antigravity/");

/** `antigravityBaseUserAgent` / `AntigravityRequestUserAgent`: the configured UA without the node client suffix. */
export const antigravityRequestUserAgent = (configured: string, version: string): string => {
  const ua = configured.trim();

  if (ua === "") return antigravityUserAgent(version);
  const lower = ua.toLowerCase();

  if (isAntigravityFamily(lower)) {
    const index = lower.indexOf(" google-api-nodejs-client/");

    if (index >= 0) {
      const trimmed = ua.slice(0, index).trim();

      if (trimmed !== "") return trimmed;
    }
  }

  return ua;
};

/** `AntigravityVersionFromUserAgent`: without a version of its own, the effective (pinned) Hub release. */
export const antigravityVersionFromUserAgent = (configured: string, version: string): string => {
  const base = antigravityRequestUserAgent(configured, version);
  const lower = base.toLowerCase();
  const effective = resolveAntigravityHubVersion(version).version;

  for (const prefix of ["antigravity/hub/", "antigravity/"]) {
    if (lower.startsWith(prefix)) {
      const rest = base.slice(prefix.length).split(/\s/)[0]?.trim() ?? "";

      return rest === "" ? effective : rest;
    }
  }

  return effective;
};

interface StoredVersion {
  readonly version: string;
  readonly fetchedAt: number;
}

/** Value of the KV entry as the executors see it (`fallback` when missing, invalid or expired). */
export const resolveStoredVersion = (raw: string | null, now: number): string => {
  if (raw === null) return ANTIGRAVITY_FALLBACK_VERSION;

  const stored = tryParseJson(raw);

  if (isJsonObject(stored)) {
    const { version, fetchedAt } = stored;

    if (
      typeof version === "string" &&
      typeof fetchedAt === "number" &&
      isValidAntigravityVersion(version) &&
      now < fetchedAt + ANTIGRAVITY_VERSION_TTL_MS
    ) {
      return version;
    }
  }

  return ANTIGRAVITY_FALLBACK_VERSION;
};

let readCache: { readonly version: string; readonly at: number } | undefined;

/** Test hook: forgets the per-isolate version cache. */
export const resetAntigravityVersionCache = (): void => {
  readCache = undefined;
};

/** The version executors put into user agents (KV read-through, fallback {@link ANTIGRAVITY_FALLBACK_VERSION}). */
export const currentAntigravityVersion = (
  kv: DeploymentKv | undefined,
  now: number,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (kv === undefined) return ANTIGRAVITY_FALLBACK_VERSION;

    if (readCache !== undefined && now - readCache.at < READ_CACHE_MS) return readCache.version;

    const raw = yield* Effect.tryPromise(() => kv.get(ANTIGRAVITY_VERSION_KEY)).pipe(
      Effect.orElseSucceed(() => null),
    );

    const version = resolveStoredVersion(raw, now);
    readCache = { version, at: now };

    return version;
  });

/** Cron task: fetches the Hub manifest and stores the version; a failure keeps the stored value until it expires. */
export const refreshAntigravityVersion = Effect.gen(function* () {
  const env = yield* ModelsEnv;
  const client = yield* HttpClient.HttpClient;
  const now = Date.now();

  const fetched = yield* Effect.gen(function* () {
    const request = HttpClientRequest.get(ANTIGRAVITY_HUB_MANIFEST_URL).pipe(
      HttpClientRequest.setHeaders({
        "user-agent": "electron-builder",
        "cache-control": "no-cache",
      }),
    );

    const response = yield* client.execute(request).pipe(Effect.timeout("10 seconds"));

    if (response.status !== 200) return undefined;
    const text = yield* response.text;

    return parseManifestVersion(text.slice(0, MANIFEST_LIMIT));
  }).pipe(Effect.orElseSucceed(() => undefined));

  if (fetched === undefined) {
    yield* Effect.logWarning("antigravity version refresh failed, keeping the stored version");

    return { version: undefined };
  }

  const stored: StoredVersion = { version: fetched, fetchedAt: now };
  yield* Effect.tryPromise(() =>
    deploymentKvOf(env).put(ANTIGRAVITY_VERSION_KEY, JSON.stringify(stored)),
  ).pipe(Effect.catch(() => Effect.logWarning("antigravity version could not be stored")));
  resetAntigravityVersionCache();

  return { version: fetched };
});
