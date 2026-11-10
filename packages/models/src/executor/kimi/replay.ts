/**
 * Kimi thinking replay for Claude-format callers.
 *
 * Go source: internal/runtime/executor/kimi_thinking_replay.go (`kimiThinkingReplayScopeFromRequest`,
 * `prepareKimiThinkingReplayRequest`, `cacheKimiThinkingReplayResponse`, `wrapKimiThinkingReplayStream`,
 * `shouldClearKimiThinkingReplayAfterError`), internal/cache/kimi_thinking_replay_cache.go (TTL 1 h). Kimi returns
 * signed `thinking` blocks next to `tool_use`; Claude Code drops them, so the last assistant content is cached per
 * (model family, caller-isolated session) and put back into the next request. The matching/accumulator logic is the
 * shared one of `executor/claude/thinking-replay.ts`; the store is the `SessionState` Durable Object (own store name,
 * TTL 1 h) with a per-isolate in-memory fallback.
 */
import { createHash } from "node:crypto";
import { Effect, Exit, Stream } from "effect";
import { cloneJson, type Json, isJsonObject } from "@commissary/json";
import { replayScopeFromRequest } from "../codex/replay.ts";
import {
  makeMemoryReplayStore,
  makeSessionStateReplayStore,
  ReplayStreamAccumulator,
  replayContentIsReplayable,
  type ReplayScope,
  replayScopeValid,
  restoreReplayContent,
  type ThinkingReplayStore,
} from "../claude/thinking-replay.ts";
import type { ExecutionError } from "../errors.ts";
import { parseSuffix } from "@commissary/translation/thinking";
import type { ExecutorOptions, ExecutorRequest } from "../types.ts";
import { normalizeKimiUpstreamModel } from "./model.ts";

const TTL_MS = 3600_000;

const KIMI_STORE = "kimi-thinking-replay";

/** In-memory Kimi store for tests (`now` is injectable). */
export const makeKimiReplayStore = (now?: () => number): ThinkingReplayStore =>
  makeMemoryReplayStore(now, TTL_MS, KIMI_STORE);

/** Default Kimi store: the `SessionState` Durable Object when bound, else per isolate. */
export const makeSessionStateKimiReplayStore = (): ThinkingReplayStore =>
  makeSessionStateReplayStore({ store: KIMI_STORE, ttlMs: TTL_MS });

/** `kimiThinkingReplayModelFamily`: `k3` and `k3-256k` share one family, `k3.1-pro` and `k3.1-pro-highspeed` another. */
export const kimiReplayFamily = (model: string): string => {
  const normalized = normalizeKimiUpstreamModel(parseSuffix(model.trim()).modelName);

  if (normalized === "k3" || normalized === "k3-256k") return "k3";

  if (normalized === "k3.1-pro" || normalized === "k3.1-pro-highspeed") return "k3.1-pro";

  return normalized;
};

/** `xaiReasoningReplayIsolateSessionKey`: session keys are isolated per caller; no caller scope disables replay. */
const isolateSessionKey = (callerScope: string, sessionKey: string): string => {
  if (sessionKey === "") return "";

  if (sessionKey.startsWith("execution:")) return sessionKey;

  if (callerScope.trim() === "") return "";

  return `caller:${createHash("sha256").update(callerScope).digest("hex").slice(0, 16)}:${sessionKey}`;
};

export interface PreparedReplay {
  readonly request: ExecutorRequest;
  readonly scope: ReplayScope;
}

/** Restores cached thinking into (a copy of) the request payload and returns the scope for caching the answer. */
export const prepareKimiReplay = (
  store: ThinkingReplayStore,
  request: ExecutorRequest,
  options: ExecutorOptions,
): Effect.Effect<PreparedReplay> =>
  Effect.gen(function* () {
    const sessionKey = isolateSessionKey(
      options.metadata.callerScope,
      replayScopeFromRequest({
        from: "claude",
        model: request.model,
        requestPayload: request.payload,
        headers: options.headers,
        callerScope: options.metadata.callerScope,
        body: request.payload,
      }).sessionKey,
    );

    const modelFamily = kimiReplayFamily(request.model);

    const empty: ReplayScope = {
      modelFamily,
      sessionKey,
      snapshot: undefined,
      cacheReady: false,
      replayApplied: false,
    };

    if (!replayScopeValid(empty)) return { request, scope: empty };
    const stored = yield* store.get(modelFamily, sessionKey);
    const base: ReplayScope = { ...empty, snapshot: stored?.snapshot, cacheReady: true };

    if (stored === undefined || !isJsonObject(request.payload)) return { request, scope: base };
    const restored = cloneJson(request.payload);
    let applied = false;

    for (const content of stored.contents)
      if (restoreReplayContent(restored, content)) applied = true;

    return applied
      ? { request: { ...request, payload: restored }, scope: { ...base, replayApplied: true } }
      : { request, scope: base };
  });

/** `shouldClearKimiThinkingReplayAfterError`. */
export const shouldClearAfterError = (error: ExecutionError): boolean =>
  error.status === 400 || error.status === 422;

export const clearReplay = (store: ThinkingReplayStore, scope: ReplayScope): Effect.Effect<void> =>
  replayScopeValid(scope) && scope.cacheReady
    ? store
        .deleteIfUnchanged(scope.modelFamily, scope.sessionKey, scope.snapshot)
        .pipe(Effect.asVoid)
    : Effect.void;

/** `cacheKimiThinkingReplayContent`: replayable content replaces the entry, anything else clears it. */
export const cacheReplay = (
  store: ThinkingReplayStore,
  scope: ReplayScope,
  content: Json | undefined,
): Effect.Effect<void> => {
  if (!replayScopeValid(scope) || !scope.cacheReady) return Effect.void;

  return content !== undefined && replayContentIsReplayable(content)
    ? store
        .replaceIfUnchanged(scope.modelFamily, scope.sessionKey, scope.snapshot, content)
        .pipe(Effect.asVoid)
    : clearReplay(store, scope);
};

/** `wrapKimiThinkingReplayStream`: observes the client stream and caches the assistant content at its clean end. */
export const wrapReplayStream = <E extends ExecutionError>(
  chunks: Stream.Stream<string, E>,
  store: ThinkingReplayStore,
  scope: ReplayScope,
): Stream.Stream<string, E> => {
  if (!replayScopeValid(scope)) return chunks;
  const accumulator = new ReplayStreamAccumulator();

  return chunks.pipe(
    Stream.tap((chunk) =>
      Effect.sync(() => {
        for (const line of chunk.split("\n")) accumulator.observe(line);
      }),
    ),
    Stream.onExit((exit) => {
      if (!Exit.isSuccess(exit)) return Effect.void;
      const content = accumulator.content();

      return content === undefined ? Effect.void : cacheReplay(store, scope, content);
    }),
  );
};
