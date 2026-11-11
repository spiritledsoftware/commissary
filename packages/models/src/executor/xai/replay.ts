/**
 * xAI reasoning replay cache (Claude and Responses clients).
 *
 * Go source: internal/runtime/executor/xai_reasoning_replay.go (scope, caller isolation, filterXAIReasoningReplayItemsForInput,
 * cacheXAIReasoningReplayFromCompleted, clearXAIReasoningReplayAfterCompaction) and
 * internal/cache/xai_reasoning_replay_cache.go (normalisation, sliding TTL 1 h).
 *
 * Stateless clients cannot carry the encrypted reasoning of earlier turns, so the final output items of each completed
 * response are cached per (model, session) and re-inserted into the next request. The store is an interface; the
 * default keeps the entries in the `SessionState` Durable Object (shared across isolates) and falls back to a
 * per-isolate in-memory store without the binding. The Go 10240-entry cap is replaced by per-session bounds and the
 * TTL sweep of the Durable Object.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { asString, get, isJsonArray, type Json, tryParseJson } from "@commissary/json";
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  makeMemoryBackend,
  resolveBackend,
  type SessionAddress,
} from "@commissary/state";
import { isValidGrokEncryptedContent } from "@commissary/translation/signature";
import { canonicalGrokSignatureKey } from "../helps/responses-signature.ts";
import {
  alignToolCallIds,
  comparableCallIds,
  insertIndexFor,
  replaySessionKey,
  toolCallKeys,
} from "../codex/replay.ts";
import { parseSuffix } from "@commissary/translation/thinking";

const CACHE_TTL_MS = 60 * 60 * 1000;

const CACHE_MAX_MODELS_PER_SESSION = 64;

const STORE_NAME = "xai-replay";

export interface XaiReplayStore {
  /** Normalised items of the session (a hit refreshes the TTL). */
  readonly get: (
    modelName: string,
    sessionKey: string,
  ) => Effect.Effect<ReadonlyArray<Json> | undefined>;
  /** Stores a completed turn: `stored`, or `none` when it has no replayable state (nothing is written). */
  readonly store: (
    modelName: string,
    sessionKey: string,
    items: ReadonlyArray<Json>,
  ) => Effect.Effect<"stored" | "none">;
  readonly delete: (modelName: string, sessionKey: string) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// Normalisation (cache write side)
// ---------------------------------------------------------------------------------------------------------------

const normalizeMessage = (item: Json): Json | undefined => {
  if (asString(get(item, "role")).trim().toLowerCase() !== "assistant") return undefined;
  const content = get(item, "content");

  if (!isJsonArray(content) || content.length === 0) return undefined;
  const parts: Json[] = [];

  for (const part of content) {
    const text = get(part, "text");
    const refusal = get(part, "refusal");

    switch (asString(get(part, "type")).trim()) {
      case "output_text":
        if (typeof text === "string") parts.push({ type: "output_text", text });
        break;
      case "refusal":
        if (typeof refusal === "string") parts.push({ type: "refusal", refusal });
        break;
    }
  }

  return parts.length === 0 ? undefined : { type: "message", role: "assistant", content: parts };
};

/** `normalizeXAIReasoningReplayItem`: only the minimal replayable shapes are stored. */
const normalizeItem = (item: Json): Json | undefined => {
  switch (asString(get(item, "type")).trim()) {
    case "reasoning": {
      const encrypted = get(item, "encrypted_content");

      if (
        typeof encrypted !== "string" ||
        encrypted !== encrypted.trim() ||
        !isValidGrokEncryptedContent(encrypted)
      ) {
        return undefined;
      }

      return { type: "reasoning", summary: [], content: null, encrypted_content: encrypted };
    }

    case "message":
      return normalizeMessage(item);
    case "function_call": {
      const callId = asString(get(item, "call_id")).trim();
      const name = asString(get(item, "name")).trim();
      const args = get(item, "arguments");

      if (callId === "" || name === "" || typeof args !== "string") return undefined;

      return { type: "function_call", call_id: callId, name, arguments: args };
    }

    case "custom_tool_call": {
      const callId = asString(get(item, "call_id")).trim();
      const name = asString(get(item, "name")).trim();
      const input = get(item, "input");

      if (callId === "" || name === "" || input === undefined) return undefined;
      const status = asString(get(item, "status")).trim();

      return {
        type: "custom_tool_call",
        status: status !== "" ? status : "completed",
        call_id: callId,
        name,
        input,
      };
    }

    default:
      return undefined;
  }
};

/** `normalizeXAIReasoningReplayItems`: undefined when nothing anchors a replay (no reasoning or tool call). */
export const normalizeReplayItems = (items: ReadonlyArray<Json>): Json[] | undefined => {
  const normalized = items.flatMap((item) => {
    const entry = normalizeItem(item);

    return entry === undefined ? [] : [entry];
  });

  const anchored = normalized.some((item) =>
    ["reasoning", "function_call", "custom_tool_call"].includes(asString(get(item, "type"))),
  );

  return anchored ? normalized : undefined;
};

const addressOf = (sessionKey: string): SessionAddress => ({
  store: STORE_NAME,
  scope: "",
  session: sessionKey.trim(),
});

const parseItems = (text: string | undefined): Json[] | undefined => {
  if (text === undefined) return undefined;

  const parsed = tryParseJson(text);

  return isJsonArray(parsed) ? parsed : undefined;
};

/** Store over the `SessionState` backend of the current request (one instance per session key, one entry per model). */
export const makeSessionStateXaiReplayStore = (
  backend: BackendResolver = resolveBackend(),
): XaiReplayStore => ({
  get: (modelName, sessionKey) =>
    bestEffort(
      "xai replay get",
      undefined,
      Effect.gen(function* () {
        const state = yield* backend;

        const [result] = yield* state.run(addressOf(sessionKey), [
          { op: "get", key: modelName.trim(), extendTtlMs: CACHE_TTL_MS },
        ]);

        return result?.status === "ok" ? parseItems(result.value) : undefined;
      }),
    ),
  store: (modelName, sessionKey, items) => {
    const normalized = normalizeReplayItems(items);

    if (normalized === undefined) return Effect.succeed("none" as const);

    return bestEffort(
      "xai replay store",
      "none" as const,
      Effect.gen(function* () {
        const state = yield* backend;

        const [result] = yield* state.run(addressOf(sessionKey), [
          {
            op: "put",
            key: modelName.trim(),
            value: JSON.stringify(normalized),
            ttlMs: CACHE_TTL_MS,
            maxEntries: CACHE_MAX_MODELS_PER_SESSION,
          },
        ]);

        return result?.status === "ok" ? ("stored" as const) : ("none" as const);
      }),
    );
  },
  delete: (modelName, sessionKey) =>
    bestEffort(
      "xai replay delete",
      undefined,
      Effect.gen(function* () {
        const state = yield* backend;
        yield* state.run(addressOf(sessionKey), [{ op: "delete", key: modelName.trim() }]);
      }),
    ),
});

/** In-memory store for tests (`now` is injectable). */
export const makeInMemoryXaiReplayStore = (now?: () => number): XaiReplayStore =>
  makeSessionStateXaiReplayStore(fixedBackend(makeMemoryBackend(now)));

/** Default store: the `SessionState` Durable Object when bound, else per isolate. */
export const defaultXaiReplayStore: XaiReplayStore = makeSessionStateXaiReplayStore();

// ---------------------------------------------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------------------------------------------

export interface XaiReplayScope {
  readonly modelName: string;
  readonly sessionKey: string;
}

export const NO_REPLAY_SCOPE: XaiReplayScope = { modelName: "", sessionKey: "" };

export const replayScopeValid = (scope: XaiReplayScope): boolean =>
  scope.modelName.trim() !== "" && scope.sessionKey.trim() !== "";

/**
 * `xaiReasoningReplayIsolateSessionKey`: client-controlled session keys are namespaced by the caller so two callers
 * cannot share encrypted reasoning; callers without a scope get no replay.
 */
export const isolateSessionKey = (sessionKey: string, callerScope: string): string => {
  const key = sessionKey.trim();

  if (key === "") return "";

  if (key.startsWith("execution:")) return key;

  if (callerScope.trim() === "") return "";
  const digest = createHash("sha256").update(callerScope.trim()).digest("hex").slice(0, 16);

  return `caller:${digest}:${key}`;
};

export interface XaiReplayScopeInput {
  /** Client (source) format. */
  readonly from: string;
  readonly model: string;
  readonly requestPayload: Json;
  readonly body: Json;
  readonly headers: Headers;
  readonly callerScope: string;
}

/** `xaiReasoningReplayScopeFromRequest`: only Claude and Responses clients use the cache. */
export const replayScopeFromRequest = (input: XaiReplayScopeInput): XaiReplayScope => {
  const from = input.from.trim().toLowerCase();

  if (from !== "claude" && from !== "openai-response") return NO_REPLAY_SCOPE;

  const sessionKey = replaySessionKey({
    from: input.from,
    model: input.model,
    requestPayload: input.requestPayload,
    headers: input.headers,
    callerScope: input.callerScope,
    body: input.body,
  });

  return {
    modelName: parseSuffix(input.model).modelName,
    sessionKey: isolateSessionKey(sessionKey, input.callerScope),
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Insertion (request side)
// ---------------------------------------------------------------------------------------------------------------

interface MessagePart {
  readonly type: string;
  readonly value: string;
}

/** `xaiAssistantMessageParts`. */
const assistantMessageParts = (content: Json | undefined): MessagePart[] | undefined => {
  if (typeof content === "string") return [{ type: "output_text", value: content }];

  if (!isJsonArray(content)) return undefined;
  const parts: MessagePart[] = [];

  for (const part of content) {
    const type = asString(get(part, "type")).trim();

    if (type === "output_text") {
      const text = get(part, "text");

      if (typeof text !== "string") return undefined;
      parts.push({ type, value: text });
    } else if (type === "refusal") {
      const refusal = get(part, "refusal");

      if (typeof refusal !== "string") return undefined;
      parts.push({ type, value: refusal });
    } else {
      return undefined;
    }
  }

  return parts.length > 0 ? parts : undefined;
};

const assistantContentEqual = (left: Json | undefined, right: Json | undefined): boolean => {
  const a = assistantMessageParts(left);
  const b = assistantMessageParts(right);

  return (
    a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((part, i) => part.type === b[i]?.type && part.value === b[i]?.value)
  );
};

const lastAssistantMessage = (inputItems: readonly Json[]): Json | undefined => {
  for (const item of inputItems.toReversed()) {
    const type = asString(get(item, "type")).trim();

    if (
      (type !== "" && type !== "message") ||
      asString(get(item, "role")).trim().toLowerCase() !== "assistant"
    )
      continue;

    return item;
  }

  return undefined;
};

/** `filterXAIReasoningReplayItemsForInput`. */
export const filterReplayItemsForInput = (body: Json, items: ReadonlyArray<Json>): Json[] => {
  const input = get(body, "input");

  if (!isJsonArray(input)) return [];
  const lastAssistant = lastAssistantMessage(input);

  const cachedAssistant = items.find(
    (item) =>
      asString(get(item, "type")).trim() === "message" &&
      asString(get(item, "role")).trim().toLowerCase() === "assistant",
  );

  const messageMatches =
    lastAssistant !== undefined &&
    cachedAssistant !== undefined &&
    assistantContentEqual(get(lastAssistant, "content"), get(cachedAssistant, "content"));

  // The client's last assistant message differs from the cached one: the history diverged, replay nothing.
  if (lastAssistant !== undefined && cachedAssistant !== undefined && !messageMatches) return [];
  const existingCalls = new Set<string>();
  const existingOutputs = new Set<string>();
  const inputReasoning = new Set<string>();

  for (const item of input) {
    const type = asString(get(item, "type")).trim();

    if (type === "reasoning") {
      const encrypted = get(item, "encrypted_content");

      if (typeof encrypted === "string") inputReasoning.add(canonicalGrokSignatureKey(encrypted));
    }

    if (type === "function_call_output" || type === "custom_tool_call_output") {
      for (const id of comparableCallIds(asString(get(item, "call_id")))) existingOutputs.add(id);
    }

    for (const key of toolCallKeys(item)) existingCalls.add(key);
  }

  const filtered: Json[] = [];

  for (const item of items) {
    switch (asString(get(item, "type")).trim()) {
      case "reasoning": {
        const encrypted = canonicalGrokSignatureKey(asString(get(item, "encrypted_content")));

        if (encrypted !== "" && inputReasoning.has(encrypted)) continue;
        break;
      }

      case "message":
        if (messageMatches) continue;
        break;
      case "function_call":
      case "custom_tool_call": {
        const keys = toolCallKeys(item);

        if (keys.length === 0 || keys.some((key) => existingCalls.has(key))) continue;

        if (
          !comparableCallIds(asString(get(item, "call_id"))).some((id) => existingOutputs.has(id))
        )
          continue;

        for (const key of keys) existingCalls.add(key);
        break;
      }

      default:
        continue;
    }

    filtered.push(item);
  }

  return filtered;
};

/** `insertCodexReasoningReplayItems`: one block at the insertion point, tool call ids aligned with their outputs. */
const insertReplayItems = (body: Json, replayItems: ReadonlyArray<Json>): boolean => {
  const input = get(body, "input");

  if (!isJsonArray(input) || replayItems.length === 0) return false;
  const inputItems = [...input];
  const index = insertIndexFor(inputItems, replayItems);
  const aligned = alignToolCallIds(inputItems, [...replayItems]);
  input.splice(index, 0, ...aligned);

  return true;
};

/** `applyXAIReasoningReplayCacheRequired`. */
export const applyReplayCache = (store: XaiReplayStore, scope: XaiReplayScope, body: Json) =>
  Effect.gen(function* () {
    if (!replayScopeValid(scope)) return;
    const items = yield* store.get(scope.modelName, scope.sessionKey);

    if (items === undefined) return;
    const filtered = filterReplayItemsForInput(body, items);

    if (filtered.length > 0) insertReplayItems(body, filtered);
  });

/** `cacheXAIReasoningReplayFromCompleted`: a completed turn without replayable state clears the previous entry. */
export const cacheReplayFromCompleted = (
  store: XaiReplayStore,
  scope: XaiReplayScope,
  completed: Json,
) =>
  Effect.gen(function* () {
    if (!replayScopeValid(scope)) return;
    const output = get(completed, "response.output");

    if (!isJsonArray(output)) return;

    const items = output.filter((item) =>
      ["reasoning", "message", "function_call", "custom_tool_call"].includes(
        asString(get(item, "type")).trim(),
      ),
    );

    const result = yield* store.store(scope.modelName, scope.sessionKey, items);

    if (result === "none") yield* store.delete(scope.modelName, scope.sessionKey);
  });

/** `clearXAIReasoningReplayAfterCompaction`. */
export const clearReplayAfterCompaction = (store: XaiReplayStore, scope: XaiReplayScope) =>
  replayScopeValid(scope) ? store.delete(scope.modelName, scope.sessionKey) : Effect.void;
