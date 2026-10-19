/**
 * Grok CLI client version used for the chat-proxy identity headers.
 *
 * Go source: internal/runtime/executor/helps/xai_version.go. The Go updater polls npm every 3 hours into process
 * memory; on Workers the cron task ({@link refreshXaiClientVersion}, listed in `src/scheduled-tasks.ts`) stores
 * the accepted version in KV `CACHE` and request handling reads it back ({@link currentXaiClientVersion}, cached per
 * isolate for a minute) with the compiled-in fallback when KV has nothing.
 */
import { Clock, Effect, Option } from "effect";
import { get, tryParseJson } from "@commissary/json";
import { HttpClient, HttpClientRequest } from "effect/http";
import { deploymentKey } from "@commissary/core";
import { ModelsEnv } from "../../env.ts";
import { deploymentKvOf } from "../../kv.ts";

/** Stable Grok CLI version used when npm resolution fails (`DefaultXAIFallbackClientVersion`). */
export const XAI_FALLBACK_CLIENT_VERSION = "1.0.46";

/** Minimum version the chat proxy accepts; older clients are rejected with HTTP 426. */
export const XAI_CLIENT_VERSION_FLOOR = "1.0.13";

export const XAI_VERSION_KV_KEY = deploymentKey("xai/client-version");

export const XAI_NPM_REGISTRY_URL = "https://registry.npmjs.org/@xai-official/grok/latest";

const FETCH_LIMIT_BYTES = 1 << 20;

const LOCAL_CACHE_MS = 60_000;

const isStrictSemver = (version: string): boolean => /^\d+\.\d+\.\d+$/.test(version);

const versionAtLeast = (got: string, floor: string): boolean => {
  const a = got.split(".").map(Number);
  const b = floor.split(".").map(Number);

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;

    if (left !== right) return left > right;
  }

  return true;
};

/** `acceptableXAIClientVersion`: strict numeric `x.y.z` at or above the server floor. */
export const acceptableXaiClientVersion = (version: string): boolean =>
  isStrictSemver(version) && versionAtLeast(version, XAI_CLIENT_VERSION_FLOOR);

let cached: { readonly version: string; readonly loadedAt: number } | undefined;

/** Test hook: forgets the per-isolate copy. */
export const resetXaiClientVersionCache = (): void => {
  cached = undefined;
};

/** The active client version: KV (when bindings are available), else the fallback. Never fails. */
export const currentXaiClientVersion: Effect.Effect<string> = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;

  if (cached !== undefined && now - cached.loadedAt < LOCAL_CACHE_MS) return cached.version;
  const env = yield* Effect.serviceOption(ModelsEnv);
  let version = XAI_FALLBACK_CLIENT_VERSION;

  if (Option.isSome(env)) {
    const stored = yield* Effect.tryPromise(() =>
      deploymentKvOf(env.value).get(XAI_VERSION_KV_KEY),
    ).pipe(Effect.orElseSucceed(() => null));

    if (stored !== null && acceptableXaiClientVersion(stored.trim())) version = stored.trim();
  }

  cached = { version, loadedAt: now };

  return version;
});

/**
 * `FetchXAINPMLatestVersion` + store: asks npm for the latest Grok CLI version and writes it to KV when acceptable.
 * A failing lookup keeps the stored (or fallback) version.
 */
export const refreshXaiClientVersion = (
  registryUrl: string = XAI_NPM_REGISTRY_URL,
): Effect.Effect<string | undefined, never, HttpClient.HttpClient | ModelsEnv> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const env = yield* ModelsEnv;

    const request = HttpClientRequest.get(registryUrl).pipe(
      HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "CLIProxyAPI" }),
    );

    const body = yield* client.execute(request).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? response.text
          : Effect.fail(new Error(`npm registry returned HTTP ${response.status}`)),
      ),
      Effect.map((text) => text.slice(0, FETCH_LIMIT_BYTES)),
      Effect.tapError((error) =>
        Effect.logWarning(`failed to fetch the latest Grok CLI version: ${error.message}`),
      ),
      Effect.option,
    );

    if (Option.isNone(body)) return undefined;
    const parsedVersion = get(tryParseJson(body.value), "version");
    const version = typeof parsedVersion === "string" ? parsedVersion.trim() : "";

    if (!acceptableXaiClientVersion(version)) {
      yield* Effect.logWarning("npm registry returned an unacceptable Grok CLI version");

      return undefined;
    }

    yield* Effect.tryPromise(() => deploymentKvOf(env).put(XAI_VERSION_KV_KEY, version)).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(`failed to store the Grok CLI version: ${String(error)}`),
      ),
      Effect.ignore,
    );

    return version;
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
