/**
 * Video -> credential binding: xAI video results are only retrievable with the credential that created them.
 *
 * Go source: sdk/api/handlers/openai/openai_videos_handlers.go (videoAuthBindingStore, defaultVideoAuthBindingTTL,
 * bindVideoAuthID*, contextWithVideoAuthBinding, modelWithVideoAuthBinding). The Go store is process memory; on
 * Workers the binding lives in KV `CACHE` with a TTL (`multimedia.video-result-auth-cache-ttl`, default 3 h), keyed by
 * the hash of the video id within the org (`OrgKv`: unchanged names for `global`), so another org's request cannot
 * pin its retrieval to this org's credential.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { CurrentOrg } from "@commissary/core";
import { ModelsEnv } from "../../env.ts";
import { orgKvOf } from "../../kv.ts";

export interface VideoBinding {
  readonly authId: string;
  /** Routing model the video was created with (selection model of the retrieval). */
  readonly model: string;
}

/** KV expiration TTLs must be at least 60 s. */
const MIN_TTL_SECONDS = 60;

const nameOf = (videoId: string): string =>
  `xai/video-binding/${createHash("sha256").update(videoId.trim()).digest("hex")}`;

/** `bindVideoAuthID`: best effort (a KV failure only loses the pin). */
export const saveVideoBinding = (videoId: string, binding: VideoBinding, ttlMs: number) =>
  Effect.gen(function* () {
    const id = videoId.trim();
    const authId = binding.authId.trim();

    if (id === "" || authId === "") return;
    const env = yield* ModelsEnv;
    const org = yield* CurrentOrg;
    yield* Effect.tryPromise(() =>
      orgKvOf(env, org).put(nameOf(id), JSON.stringify({ authId, model: binding.model.trim() }), {
        expirationTtl: Math.max(MIN_TTL_SECONDS, Math.ceil(ttlMs / 1000)),
      }),
    ).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(`failed to store the video credential binding: ${String(error)}`),
      ),
      Effect.ignore,
    );
  });

/** `videoAuthBindings.getBinding`. */
export const loadVideoBinding = (videoId: string) =>
  Effect.gen(function* () {
    const id = videoId.trim();

    if (id === "") return undefined;
    const env = yield* ModelsEnv;
    const org = yield* CurrentOrg;

    const stored = yield* Effect.tryPromise(() => orgKvOf(env, org).get(nameOf(id))).pipe(
      Effect.orElseSucceed(() => null),
    );

    if (stored === null) return undefined;

    try {
      // SAFETY: the parsed value is only read through typeof-checked optional fields.
      const parsed = JSON.parse(stored) as Partial<VideoBinding>;

      return typeof parsed.authId === "string" && parsed.authId !== ""
        ? ({
            authId: parsed.authId,
            model: typeof parsed.model === "string" ? parsed.model : "",
          } satisfies VideoBinding)
        : undefined;
    } catch {
      return undefined;
    }
  });
