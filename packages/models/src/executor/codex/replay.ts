/**
 * Codex reasoning replay cache (Claude-format callers).
 *
 * Go source: internal/runtime/executor/codex_executor_reasoning.go (scope/session key, anchor matching, insertion,
 * cacheCodexReasoningReplayFromCompleted, clearCodexReasoningReplayOnInvalidSignature) and
 * internal/cache/codex_reasoning_replay_cache.go (turn marker, normalisation, TTL and size bounds).
 *
 * Claude clients cannot carry Codex `reasoning` items, so the encrypted reasoning and tool calls of each completed
 * response are cached per (model, session) and re-inserted into the next request. The store is an interface: the
 * default keeps the entries in the `SessionState` Durable Object (shared across isolates, compare-and-swap appends,
 * TTL 1 h) and falls back to a per-isolate in-memory store without the binding; tests use `makeInMemoryReplayStore`.
 * Workers deviations: the entry bounds are per session (the Durable Object of a session holds one entry per model;
 * the Go 10240-entry cap is replaced by the TTL sweep) and session keys are isolated per caller scope.
 */
import { createHash } from "node:crypto";
import { sha256Hex } from "@commissary/core";
import { Effect } from "effect";
import {
  asString,
  cloneJson,
  get,
  isJsonArray,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import {
  isValidGptReasoningSignature,
  isValidMetaReasoningSignature,
} from "@commissary/translation/signature";
import {
  canonicalReasoningSignatureKey,
  isReplayableReasoningSignature,
} from "../helps/responses-signature.ts";
import { sanitizeClaudeToolId, shortenCodexCallIdIfNeeded } from "@commissary/translation";
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  keepValue,
  makeMemoryBackend,
  putValue,
  resolveBackend,
  type SessionAddress,
  updateEntry,
} from "@commissary/state";
import { uuidV5Oid } from "../helps/uuid.ts";

/** Marker item that opens each cached turn. */
export const CODEX_REASONING_REPLAY_TURN_TYPE = "cpa_codex_replay_turn";

const CACHE_TTL_MS = 60 * 60 * 1000;

const CACHE_MAX_MODELS_PER_SESSION = 64;

const CACHE_MAX_TURNS_PER_ENTRY = 256;

const CACHE_MAX_BYTES_PER_ENTRY = 16 << 20;

const STORE_NAME = "codex-replay";

// ---------------------------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------------------------

export interface CodexReplayStore {
  /** All cached items (turn markers and replay items) for the session, oldest first. */
  readonly get: (
    modelName: string,
    sessionKey: string,
  ) => Effect.Effect<ReadonlyArray<Json> | undefined>;
  /** Appends one turn (marker first); identical turn ids are ignored. */
  readonly append: (
    modelName: string,
    sessionKey: string,
    items: ReadonlyArray<Json>,
  ) => Effect.Effect<void>;
  readonly clear: (modelName: string, sessionKey: string) => Effect.Effect<void>;
}

const trimItems = (items: Json[]): Json[] => {
  let current = items;

  for (;;) {
    const turnStarts = [0];
    let totalBytes = 0;
    current.forEach((item, index) => {
      totalBytes += JSON.stringify(item).length;

      if (index > 0 && asString(get(item, "type")).trim() === CODEX_REASONING_REPLAY_TURN_TYPE)
        turnStarts.push(index);
    });

    if (turnStarts.length <= CACHE_MAX_TURNS_PER_ENTRY && totalBytes <= CACHE_MAX_BYTES_PER_ENTRY)
      return current;

    if (turnStarts.length <= 1) return [];
    current = current.slice(turnStarts[1]);
  }
};

/** `normalizeCodexReasoningReplayItem`: only the minimal replayable shapes are stored. */
const normalizeItem = (item: Json): Json | undefined => {
  switch (asString(get(item, "type")).trim()) {
    case CODEX_REASONING_REPLAY_TURN_TYPE: {
      const id = asString(get(item, "id")).trim();

      if (id === "") return undefined;
      const out: JsonObject = { type: CODEX_REASONING_REPLAY_TURN_TYPE, id };
      const assistant = asString(get(item, "assistant_fingerprint")).trim();

      if (assistant !== "") out["assistant_fingerprint"] = assistant;
      const request = asString(get(item, "request_fingerprint")).trim();

      if (request !== "") out["request_fingerprint"] = request;
      const callIds = get(item, "call_ids");

      if (isJsonArray(callIds)) {
        const ids = callIds.map((id) => asString(id).trim()).filter((id) => id !== "");

        if (ids.length > 0) out["call_ids"] = ids;
      }

      return out;
    }

    case "reasoning": {
      const encrypted = get(item, "encrypted_content");

      if (typeof encrypted !== "string" || encrypted !== encrypted.trim()) return undefined;

      // A GPT or Meta envelope is stored as issued, router suffix included: the request that replays it runs the
      // reasoning sanitiser afterwards, which keeps the suffix on OpenRouter and strips it for every other upstream.
      if (!isValidGptReasoningSignature(encrypted) && !isValidMetaReasoningSignature(encrypted))
        return undefined;

      return { type: "reasoning", summary: [], content: null, encrypted_content: encrypted };
    }

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

const normalizeItems = (items: ReadonlyArray<Json>): Json[] =>
  trimItems(
    items.flatMap((item) => {
      const normalized = normalizeItem(item);

      return normalized === undefined ? [] : [normalized];
    }),
  );

const parseItems = (text: string | undefined): Json[] | undefined => {
  if (text === undefined) return undefined;

  const parsed = tryParseJson(text);

  return isJsonArray(parsed) ? parsed : undefined;
};

/** `CacheCodexReasoningReplayItems` merge: appends a normalised turn unless its turn id is cached already. */
export const mergeTurn = (
  existing: ReadonlyArray<Json>,
  normalized: ReadonlyArray<Json>,
): Json[] => {
  let base = [...existing];

  if (base.length > 0 && asString(get(base[0], "type")).trim() !== CODEX_REASONING_REPLAY_TURN_TYPE)
    base = [];

  const turnId =
    asString(get(normalized[0], "type")).trim() === CODEX_REASONING_REPLAY_TURN_TYPE
      ? asString(get(normalized[0], "id")).trim()
      : "";

  const duplicate =
    turnId !== "" &&
    base.some(
      (item) =>
        asString(get(item, "type")).trim() === CODEX_REASONING_REPLAY_TURN_TYPE &&
        asString(get(item, "id")).trim() === turnId,
    );

  return trimItems(duplicate ? base : [...base, ...normalized]);
};

const addressOf = (sessionKey: string): SessionAddress => ({
  store: STORE_NAME,
  scope: "",
  session: sessionKey.trim(),
});

/**
 * Store over the `SessionState` backend of the current request (Durable Object, or the per-isolate fallback): one
 * instance per session key, one entry per model. Failures of the backend degrade to a cache miss.
 */
export const makeSessionStateReplayStore = (
  backend: BackendResolver = resolveBackend(),
): CodexReplayStore => ({
  get: (modelName, sessionKey) =>
    bestEffort(
      "codex replay get",
      undefined,
      Effect.gen(function* () {
        const state = yield* backend;

        const [result] = yield* state.run(addressOf(sessionKey), [
          { op: "get", key: modelName.trim() },
        ]);

        return result?.status === "ok" ? parseItems(result.value) : undefined;
      }),
    ),
  append: (modelName, sessionKey, items) => {
    const normalized = normalizeItems(items);

    if (normalized.length === 0) return Effect.void;

    return bestEffort(
      "codex replay append",
      undefined,
      Effect.gen(function* () {
        const state = yield* backend;
        yield* updateEntry(
          state,
          addressOf(sessionKey),
          modelName.trim(),
          { ttlMs: CACHE_TTL_MS, maxEntries: CACHE_MAX_MODELS_PER_SESSION },
          (current) => {
            const combined = mergeTurn(parseItems(current) ?? [], normalized);

            return combined.length === 0 ? keepValue : putValue(JSON.stringify(combined));
          },
        );
      }),
    );
  },
  clear: (modelName, sessionKey) =>
    bestEffort(
      "codex replay clear",
      undefined,
      Effect.gen(function* () {
        const state = yield* backend;
        yield* state.run(addressOf(sessionKey), [{ op: "delete", key: modelName.trim() }]);
      }),
    ),
});

/** In-memory store for tests (`now` is injectable). */
export const makeInMemoryReplayStore = (now?: () => number): CodexReplayStore =>
  makeSessionStateReplayStore(fixedBackend(makeMemoryBackend(now)));

/** Default store: the `SessionState` Durable Object when bound, else per isolate. */
export const defaultReplayStore: CodexReplayStore = makeSessionStateReplayStore();

// ---------------------------------------------------------------------------------------------------------------
// Scope and session key
// ---------------------------------------------------------------------------------------------------------------

export interface CodexReplayScope {
  readonly modelName: string;
  readonly sessionKey: string;
  readonly requestFingerprint: string;
}

export const replayScopeValid = (scope: CodexReplayScope): boolean =>
  scope.modelName.trim() !== "" && scope.sessionKey.trim() !== "";

const itemRaw = (item: Json): string => JSON.stringify(item);

/** `codexReplayInputPrefixFingerprint`. */
const prefixFingerprint = (items: readonly Json[], end: number): string => {
  if (end < 0 || end > items.length) return "";
  const hash = createHash("sha256");

  for (const item of items.slice(0, end)) hash.update("\u0000item\u0000").update(itemRaw(item));

  return hash.digest("hex");
};

/** Answers prefix fingerprint queries from one incremental hashing pass. */
class PrefixFingerprints {
  readonly #items: readonly Json[];
  readonly #hash = createHash("sha256");
  readonly #sums: string[];

  constructor(items: readonly Json[]) {
    this.#items = items;
    this.#sums = [this.#hash.copy().digest("hex")];
  }

  at(end: number): string {
    if (end < 0 || end > this.#items.length) return "";

    while (this.#sums.length <= end) {
      const next = this.#sums.length - 1;
      const item = this.#items[next];

      if (item === undefined) return "";
      this.#hash.update("\u0000item\u0000").update(itemRaw(item));
      this.#sums.push(this.#hash.copy().digest("hex"));
    }

    return this.#sums[end] ?? "";
  }
}

const sessionKeyFromTurnMetadata = (turnMetadata: string): string => {
  const parsed = tryParseJson(turnMetadata);

  if (parsed === undefined) return "";

  const promptCacheKey = asString(get(parsed, "prompt_cache_key")).trim();

  if (promptCacheKey !== "") return `prompt-cache:${promptCacheKey}`;
  const windowId = asString(get(parsed, "window_id")).trim();

  return windowId !== "" ? `window:${windowId}` : "";
};

const sessionKeyFromPayload = (payload: Json | undefined): string => {
  if (payload === undefined) return "";
  const promptCacheKey = asString(get(payload, "prompt_cache_key")).trim();

  if (promptCacheKey !== "") return `prompt-cache:${promptCacheKey}`;
  const windowId = asString(get(payload, "client_metadata.x-codex-window-id")).trim();

  if (windowId !== "") return `window:${windowId}`;
  const turnMetadata = asString(get(payload, "client_metadata.x-codex-turn-metadata")).trim();

  return turnMetadata !== "" ? sessionKeyFromTurnMetadata(turnMetadata) : "";
};

const sessionKeyFromHeaders = (headers: Headers): string => {
  const turnMetadata = (headers.get("x-codex-turn-metadata") ?? "").trim();

  if (turnMetadata !== "") {
    const key = sessionKeyFromTurnMetadata(turnMetadata);

    if (key !== "") return key;
  }

  const windowId = (headers.get("x-codex-window-id") ?? "").trim();

  if (windowId !== "") return `window:${windowId}`;

  for (const name of ["session_id", "session-id"]) {
    const value = (headers.get(name) ?? "").trim();

    if (value !== "") return `session-id:${value}`;
  }

  const conversationId = (headers.get("conversation_id") ?? "").trim();

  return conversationId !== "" ? `conversation_id:${conversationId}` : "";
};

/** `ClaudeCodeExecutionScope`: `claude:<session>:agent:<agent>` for Claude Code requests. */
export const claudeCodeExecutionScope = (
  payload: Json | undefined,
  headers: Headers,
): string | undefined => {
  let sessionId = (headers.get("x-claude-code-session-id") ?? "").trim();

  if (sessionId === "") {
    const userId = asString(get(payload, "metadata.user_id"));
    const match = /_session_([a-f0-9-]+)$/.exec(userId);

    if (match !== null) sessionId = match[1] ?? "";
    else if (userId.startsWith("{")) {
      sessionId = asString(get(tryParseJson(userId), "session_id")).trim();
    }
  }

  if (sessionId === "") return undefined;
  const agent = (headers.get("x-claude-code-agent-id") ?? "").trim() || "main";

  return `claude:${sessionId}:agent:${agent}`;
};

export interface ReplayScopeInput {
  /** Client (source) format. */
  readonly from: string;
  readonly model: string;
  readonly requestPayload: Json;
  readonly headers: Headers;
  readonly callerScope: string;
  readonly body: Json;
}

/** `codexReasoningReplaySessionKey`. */
export const replaySessionKey = (input: ReplayScopeInput): string => {
  if (input.from.trim().toLowerCase() === "claude") {
    const scope = claudeCodeExecutionScope(input.requestPayload, input.headers);

    if (scope !== undefined) return scope;
  }

  const fromBody = sessionKeyFromPayload(input.body);

  if (fromBody !== "") return fromBody;
  const fromPayload = sessionKeyFromPayload(input.requestPayload);

  if (fromPayload !== "") return fromPayload;
  const fromHeaders = sessionKeyFromHeaders(input.headers);

  if (fromHeaders !== "") return fromHeaders;

  if (input.from.trim().toLowerCase() === "openai" && input.callerScope !== "") {
    return `prompt-cache:${uuidV5Oid(`cli-proxy-api:codex:prompt-cache:${input.callerScope}`)}`;
  }

  return "";
};

/** Workers addition: session keys are namespaced by the caller (like xAI/Kimi/Claude) so callers never share replay. */
const isolateCallerSession = (sessionKey: string, callerScope: string): string => {
  const scope = callerScope.trim();

  if (sessionKey === "" || scope === "") return sessionKey;

  return `caller:${sha256Hex(scope).slice(0, 16)}:${sessionKey}`;
};

/** `codexReasoningReplayScopeFromRequest`: only Claude-format callers use the replay cache. */
export const replayScopeFromRequest = (input: ReplayScopeInput): CodexReplayScope => {
  if (input.from.trim().toLowerCase() !== "claude")
    return { modelName: "", sessionKey: "", requestFingerprint: "" };
  let modelName = asString(get(input.body, "model")).trim();

  if (modelName === "") modelName = input.model;
  const items = get(input.body, "input");
  const inputItems = isJsonArray(items) ? items : [];

  return {
    modelName,
    sessionKey: isolateCallerSession(replaySessionKey(input), input.callerScope),
    requestFingerprint: prefixFingerprint(inputItems, inputItems.length),
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------------------------------------------

interface ReplayTurn {
  marked: boolean;
  assistantFingerprint: string;
  requestFingerprint: string;
  callIds: string[];
  items: Json[];
}

export const comparableCallIds = (callId: string): string[] => {
  const id = callId.trim();

  if (id === "") return [];
  const visible = shortenCodexCallIdIfNeeded(sanitizeClaudeToolId(id));

  return visible === "" || visible === id ? [id] : [id, visible];
};

export const toolCallKeys = (item: Json): string[] => {
  const type = asString(get(item, "type")).trim();

  if (type !== "function_call" && type !== "custom_tool_call") return [];

  return comparableCallIds(asString(get(item, "call_id"))).map((id) => `${type}:${id}`);
};

const messageRole = (item: Json): string | undefined => {
  const type = asString(get(item, "type")).trim();
  const role = asString(get(item, "role")).trim().toLowerCase();

  if (role === "" || (type !== "" && type !== "message")) return undefined;

  return role;
};

/** `codexReplayAssistantMessageFingerprint`. */
const assistantMessageFingerprint = (item: Json): string => {
  const type = asString(get(item, "type")).trim();

  if (type !== "" && type !== "message") return "";

  if (asString(get(item, "role")).trim().toLowerCase() !== "assistant") return "";
  const content = get(item, "content");
  let text = "";

  if (typeof content === "string") {
    text = content;
  } else if (isJsonArray(content)) {
    for (const part of content) {
      switch (asString(get(part, "type")).trim()) {
        case "input_text":
        case "output_text":
          text += asString(get(part, "text"));
          break;
        case "refusal":
          text += `\u0000refusal\u0000${asString(get(part, "refusal"))}`;
          break;
        default:
          return "";
      }
    }
  } else {
    return "";
  }

  return text === "" ? "" : sha256Hex(text);
};

const splitTurns = (items: ReadonlyArray<Json>): ReplayTurn[] => {
  const turns: ReplayTurn[] = [];

  let current: ReplayTurn = {
    marked: false,
    assistantFingerprint: "",
    requestFingerprint: "",
    callIds: [],
    items: [],
  };

  const flush = () => {
    if (current.items.length > 0) turns.push(current);
  };

  for (const item of items) {
    if (asString(get(item, "type")).trim() === CODEX_REASONING_REPLAY_TURN_TYPE) {
      flush();
      const callIds = get(item, "call_ids");
      current = {
        marked: true,
        assistantFingerprint: asString(get(item, "assistant_fingerprint")).trim(),
        requestFingerprint: asString(get(item, "request_fingerprint")).trim(),
        callIds: isJsonArray(callIds)
          ? callIds.map((id) => asString(id).trim()).filter((id) => id !== "")
          : [],
        items: [],
      };
      continue;
    }

    current.items.push(item);
  }

  flush();

  return turns;
};

const outputCallIds = (inputItems: readonly Json[]): Map<string, string> => {
  const out = new Map<string, string>();

  for (const item of inputItems) {
    const type = asString(get(item, "type")).trim();

    if (type !== "function_call_output" && type !== "custom_tool_call_output") continue;
    const callId = asString(get(item, "call_id")).trim();

    if (callId === "") continue;

    for (const candidate of comparableCallIds(callId)) out.set(candidate, callId);
  }

  return out;
};

/** `codexAlignReasoningReplayToolCallIDs`: replayed calls take the call id their output uses. */
export const alignToolCallIds = (inputItems: readonly Json[], replayItems: Json[]): Json[] => {
  const outputs = outputCallIds(inputItems);

  if (outputs.size === 0) return replayItems;

  return replayItems.map((item) => {
    const type = asString(get(item, "type")).trim();

    if (type !== "function_call" && type !== "custom_tool_call") return item;
    const callId = asString(get(item, "call_id")).trim();
    let outputCallId = "";

    for (const candidate of comparableCallIds(callId)) {
      const value = outputs.get(candidate);

      if (value !== undefined && value !== "") {
        outputCallId = value;
        break;
      }
    }

    if (outputCallId === "" || outputCallId === callId) return item;

    return set(cloneJson(item), "call_id", outputCallId);
  });
};

const shouldInsertBefore = (item: Json): boolean => {
  const role = messageRole(item);

  if (role === undefined) return true;

  return role !== "developer" && role !== "system";
};

/** `codexReasoningReplayInsertIndex`. */
export const insertIndexFor = (
  inputItems: readonly Json[],
  replayItems: readonly Json[],
): number => {
  const replayCallIds = new Set<string>();

  for (const item of replayItems) {
    const type = asString(get(item, "type")).trim();

    if (type !== "function_call" && type !== "custom_tool_call") continue;

    for (const id of comparableCallIds(asString(get(item, "call_id")))) replayCallIds.add(id);
  }

  if (replayCallIds.size > 0) {
    for (const [index, item] of inputItems.entries()) {
      const type = asString(get(item, "type")).trim();

      if (type !== "function_call_output" && type !== "custom_tool_call_output") continue;
      const callId = asString(get(item, "call_id")).trim();

      if (callId === "" || replayCallIds.has(callId)) return index;
    }
  }

  const lastAssistant = inputItems.findLastIndex((item) => messageRole(item) === "assistant");

  if (lastAssistant >= 0) return lastAssistant;
  const insertBefore = inputItems.findIndex((item) => shouldInsertBefore(item));

  if (insertBefore >= 0) return insertBefore;

  return inputItems.length;
};

const inputHasValidReasoning = (inputItems: readonly Json[]): boolean =>
  inputItems.some((item) => {
    if (asString(get(item, "type")).trim() !== "reasoning") return false;
    const encrypted = get(item, "encrypted_content");

    return typeof encrypted === "string" && isReplayableReasoningSignature(encrypted);
  });

/** `filterCodexReasoningReplayItemsForInput` (unmarked legacy turns). */
const filterItemsForInput = (inputItems: readonly Json[], items: readonly Json[]): Json[] => {
  const hasInputReasoning = inputHasValidReasoning(inputItems);
  const existingCalls = new Set<string>();
  const existingOutputs = new Set<string>();

  for (const item of inputItems) {
    const type = asString(get(item, "type")).trim();

    if (type === "function_call_output" || type === "custom_tool_call_output") {
      for (const id of comparableCallIds(asString(get(item, "call_id")))) existingOutputs.add(id);
    }

    for (const key of toolCallKeys(item)) existingCalls.add(key);
  }

  const filtered: Json[] = [];

  for (const item of items) {
    switch (asString(get(item, "type")).trim()) {
      case "reasoning":
        if (hasInputReasoning) continue;
        break;
      case "function_call":
      case "custom_tool_call": {
        const keys = toolCallKeys(item);

        if (keys.length === 0 || keys.some((key) => existingCalls.has(key))) continue;

        // Only inject when the request carries the matching output.
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

/** `filterCodexReasoningReplayTurnItems` (marked turns). */
const filterTurnItems = (inputItems: readonly Json[], items: readonly Json[]): Json[] => {
  const existingReasoning = new Set<string>();
  const existingCalls = new Set<string>();
  const existingOutputs = new Set<string>();

  for (const item of inputItems) {
    const type = asString(get(item, "type")).trim();

    if (type === "reasoning") {
      const encrypted = canonicalReasoningSignatureKey(asString(get(item, "encrypted_content")));

      if (encrypted !== "") existingReasoning.add(encrypted);
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      for (const id of comparableCallIds(asString(get(item, "call_id")))) existingOutputs.add(id);
    }

    for (const key of toolCallKeys(item)) existingCalls.add(key);
  }

  const filtered: Json[] = [];

  for (const item of items) {
    switch (asString(get(item, "type")).trim()) {
      case "reasoning":
        if (
          existingReasoning.has(
            canonicalReasoningSignatureKey(asString(get(item, "encrypted_content"))),
          )
        )
          continue;
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

/** `codexReasoningReplayTurnAnchorIndex`. */
const turnAnchorIndex = (
  inputItems: readonly Json[],
  turn: ReplayTurn,
  fallbackEnd: number,
  used: ReadonlySet<number>,
  prefixes: PrefixFingerprints,
): number | undefined => {
  let searchEnd = turn.requestFingerprint !== "" ? inputItems.length - 1 : fallbackEnd;

  if (searchEnd >= inputItems.length) searchEnd = inputItems.length - 1;

  const matchesPrefix = (index: number) =>
    turn.requestFingerprint === "" || prefixes.at(index) === turn.requestFingerprint;

  if (turn.callIds.length > 0) {
    const callIds = new Set<string>();

    for (const id of turn.callIds)
      for (const candidate of comparableCallIds(id)) callIds.add(candidate);

    for (let index = searchEnd; index >= 0; index--) {
      if (used.has(index) || !matchesPrefix(index)) continue;
      const item = inputItems[index];

      if (item === undefined) continue;
      const type = asString(get(item, "type")).trim();

      if (
        type !== "function_call" &&
        type !== "custom_tool_call" &&
        type !== "function_call_output" &&
        type !== "custom_tool_call_output"
      ) {
        continue;
      }

      if (
        comparableCallIds(asString(get(item, "call_id"))).some((candidate) =>
          callIds.has(candidate),
        )
      )
        return index;
    }
  }

  if (turn.assistantFingerprint !== "") {
    for (let index = searchEnd; index >= 0; index--) {
      if (used.has(index) || !matchesPrefix(index)) continue;

      const candidate = inputItems[index];

      if (
        candidate !== undefined &&
        assistantMessageFingerprint(candidate) === turn.assistantFingerprint
      )
        return index;
    }
  }

  if (turn.callIds.length === 0 && turn.assistantFingerprint === "")
    return insertIndexFor(inputItems, turn.items);

  return undefined;
};

/** `insertCodexReasoningReplayTurns`: mutates `body.input`; true when something was inserted. */
export const insertReplayTurns = (body: Json, replayItems: ReadonlyArray<Json>): boolean => {
  const input = get(body, "input");

  if (!isJsonArray(input) || replayItems.length === 0) return false;
  const inputItems = [...input];
  const turns = splitTurns(replayItems);
  const insertions = new Map<number, Json[]>();
  const used = new Set<number>();
  const prefixes = new PrefixFingerprints(inputItems);
  let fallbackAnchorEnd = inputItems.length - 1;
  let inserted = false;

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = turns[turnIndex];

    if (turn === undefined || turn.items.length === 0) continue;

    if (!turn.marked) {
      let items = filterItemsForInput(inputItems, turn.items);

      if (items.length === 0) continue;
      const index = insertIndexFor(inputItems, items);
      items = alignToolCallIds(inputItems, items);
      insertions.set(index, [...items, ...(insertions.get(index) ?? [])]);
      inserted = true;
      continue;
    }

    const anchor = turnAnchorIndex(inputItems, turn, fallbackAnchorEnd, used, prefixes);

    if (anchor === undefined) continue;
    used.add(anchor);

    if (turn.requestFingerprint === "") fallbackAnchorEnd = anchor - 1;
    let items = filterTurnItems(inputItems, turn.items);

    if (items.length === 0) continue;
    items = alignToolCallIds(inputItems, items);
    insertions.set(anchor, [...items, ...(insertions.get(anchor) ?? [])]);
    inserted = true;
  }

  if (!inserted) return false;
  const rebuilt: Json[] = [];
  inputItems.forEach((item, index) => {
    rebuilt.push(...(insertions.get(index) ?? []), item);
  });
  rebuilt.push(...(insertions.get(inputItems.length) ?? []));
  input.splice(0, input.length, ...rebuilt);

  return true;
};

/** `applyCodexReasoningReplayCacheRequired`: re-inserts the cached reasoning of earlier turns. */
export const applyReplayCache = (store: CodexReplayStore, scope: CodexReplayScope, body: Json) =>
  Effect.gen(function* () {
    if (!replayScopeValid(scope)) return;
    const items = yield* store.get(scope.modelName, scope.sessionKey);

    if (items !== undefined) insertReplayTurns(body, items);
  });

/** `cacheCodexReasoningReplayFromCompleted`: caches the reasoning and tool calls of a completed response. */
export const cacheReplayFromCompleted = (
  store: CodexReplayStore,
  scope: CodexReplayScope,
  completed: Json,
) => {
  if (!replayScopeValid(scope)) return Effect.void;
  const output = get(completed, "response.output");

  if (!isJsonArray(output)) return Effect.void;
  const replayItems: Json[] = [];
  const callIds: string[] = [];
  let assistantFingerprint = "";

  for (const item of output) {
    switch (asString(get(item, "type")).trim()) {
      case "reasoning":
        replayItems.push(item);
        break;
      case "function_call":
      case "custom_tool_call": {
        replayItems.push(item);
        const callId = asString(get(item, "call_id")).trim();

        if (callId !== "") callIds.push(callId);
        break;
      }

      case "message": {
        const fingerprint = assistantMessageFingerprint(item);

        if (fingerprint !== "") assistantFingerprint = fingerprint;
        break;
      }
    }
  }

  if (replayItems.length === 0) return Effect.void;
  const hash = createHash("sha256");
  hash.update(scope.requestFingerprint).update(`\u0000assistant\u0000${assistantFingerprint}`);

  for (const callId of callIds) hash.update(`\u0000call\u0000${callId}`);

  for (const item of replayItems) hash.update("\u0000item\u0000").update(itemRaw(item));
  const marker: JsonObject = { type: CODEX_REASONING_REPLAY_TURN_TYPE, id: hash.digest("hex") };

  if (assistantFingerprint !== "") marker["assistant_fingerprint"] = assistantFingerprint;

  if (scope.requestFingerprint !== "") marker["request_fingerprint"] = scope.requestFingerprint;

  if (callIds.length > 0) marker["call_ids"] = callIds;

  return store.append(scope.modelName, scope.sessionKey, [marker, ...replayItems]);
};
