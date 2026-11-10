/**
 * Request normalisation for the Responses WebSocket: `response.create` / `response.append` frames become executable
 * Responses bodies, transcripts are merged or replaced, warm-ups are answered locally.
 *
 * Go source: sdk/api/handlers/openai/openai_responses_websocket_requests.go (normalizeResponsesWebsocketRequest*,
 * normalizeResponseCreateRequest, normalizeResponseSubsequentRequest (f4d3f061), shouldReplaceWebsocketTranscript,
 * inputSatisfiesPendingToolCalls, normalizeResponseTranscriptReplacement, mergeResponsesWebsocketInput, the dedupe
 * helpers, normalizeResponsesWebsocketPassthroughRequest), openai_responses_websocket_prewarm.go
 * (shouldHandleResponsesWebsocketPrewarmLocally, syntheticResponsesWebsocketPrewarmPayloads,
 * normalizeResponsesWebsocketPrewarmFollowup, inputContainsFullTranscript, inputWithoutCompactionItems).
 *
 * Pure functions over parsed JSON (inputs are never mutated; key order is preserved like sjson). Differences from Go:
 * item metadata keys (`type`, `id`, `call_id`) are matched case-insensitively like `encoding/json` does, and the
 * synthetic warm-up ids use the injected clock/uuid.
 */
import {
  asString,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from "@commissary/json";

export const REQUEST_TYPE_CREATE = "response.create";

export const REQUEST_TYPE_APPEND = "response.append";

/** Go `codexLocalCompactionSummaryPrefix`. */
const CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

/** Go `interfaces.ErrorMessage` as produced by the normalisation (status + message). */
export interface WsRequestError {
  readonly status: number;
  readonly message: string;
}

export type Normalized =
  | { readonly ok: true; readonly request: JsonObject; readonly last: JsonObject | undefined }
  | { readonly ok: false; readonly error: WsRequestError; readonly last: JsonObject | undefined };

const failure = (message: string, last: JsonObject | undefined, status = 400): Normalized => ({
  ok: false,
  error: { status, message },
  last,
});

const trimmed = (value: Json | undefined): string => asString(value).trim();

const PASSTHROUGH_KEY = "internal_chat_message_metadata_passthrough";

/**
 * Output-only fields that another credential may reject as unknown input once an upstream item is replayed as input
 * (`internal_chat_message_metadata_passthrough.content_token_count`, CLIProxyAPI 9037d543). Returns `item` itself when
 * nothing is to be removed, else a copy without the field, and without the passthrough object when it is left empty.
 * Applied only to copies of upstream output at record time; client items must round-trip unchanged.
 */
export const stripReplayOutputOnlyFields = (item: JsonObject): JsonObject => {
  const passthrough = item[PASSTHROUGH_KEY];

  if (!isJsonObject(passthrough) || !("content_token_count" in passthrough)) return item;
  const remaining: JsonObject = {};

  for (const [key, value] of Object.entries(passthrough))
    if (key !== "content_token_count") remaining[key] = value;
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(item)) {
    if (key !== PASSTHROUGH_KEY) out[key] = value;
    else if (Object.keys(remaining).length > 0) out[key] = remaining;
  }

  return out;
};

/** `previous_response_not_found`: a continuation the socket cannot serve. */
export const previousResponseNotFoundError = (): WsRequestError => ({
  status: 409,
  message:
    '{"error":{"message":"Previous response is not available on this websocket; resend the full conversation input without previous_response_id","type":"invalid_request_error","code":"previous_response_not_found","param":"previous_response_id"}}',
});

// --- item helpers -----------------------------------------------------------------------------------------------

const metadataString = (item: Json, name: string): string => {
  if (!isJsonObject(item)) return "";
  let value = "";

  // encoding/json keeps the last of several keys that match case-insensitively.
  for (const [key, candidate] of Object.entries(item)) {
    if (key.toLowerCase() !== name) continue;
    value =
      candidate === null || candidate === undefined
        ? ""
        : typeof candidate === "string"
          ? candidate.trim()
          : JSON.stringify(candidate).trim();
  }

  return value;
};

interface MergeItem {
  readonly raw: Json;
  readonly itemType: string;
  readonly id: string;
  readonly callId: string;
}

const toMergeItem = (raw: Json): MergeItem => ({
  raw,
  itemType: metadataString(raw, "type"),
  id: metadataString(raw, "id"),
  callId: metadataString(raw, "call_id"),
});

export const isToolCallType = (itemType: string): boolean =>
  itemType.trim() === "function_call" || itemType.trim() === "custom_tool_call";

export const isToolCallOutputType = (itemType: string): boolean =>
  itemType.trim() === "function_call_output" || itemType.trim() === "custom_tool_call_output";

const dedupeFunctionCalls = (items: ReadonlyArray<MergeItem>): MergeItem[] => {
  const seen = new Set<string>();

  return items.filter((item) => {
    if (isToolCallType(item.itemType) && item.callId !== "") {
      if (seen.has(item.callId)) return false;
      seen.add(item.callId);
    }

    return true;
  });
};

/**
 * `dedupeResponsesWebsocketInputItems`: items sharing an `id` collapse to the last one, but an item whose `call_id`
 * has a matching output is never replaced by one without (upstream rejects "No tool call found").
 */
export const dedupeInputItems = <
  T extends { readonly id: string; readonly callId: string; readonly itemType: string },
>(
  items: ReadonlyArray<T>,
): T[] => {
  const referenced = new Set<string>();

  for (const item of items)
    if (isToolCallOutputType(item.itemType) && item.callId !== "") referenced.add(item.callId);
  const keepIndex = new Map<string, number>();
  const keepReferenced = new Map<string, boolean>();
  items.forEach((item, index) => {
    if (item.id === "") return;
    const isReferenced = item.callId !== "" && referenced.has(item.callId);

    if (!keepIndex.has(item.id)) {
      keepIndex.set(item.id, index);
      keepReferenced.set(item.id, isReferenced);

      return;
    }

    if (isReferenced || keepReferenced.get(item.id) !== true) {
      keepIndex.set(item.id, index);
      keepReferenced.set(item.id, isReferenced);
    }
  });

  return items.filter((item, index) => item.id === "" || keepIndex.get(item.id) === index);
};

export const toInputItem = (raw: Json): MergeItem => toMergeItem(raw);

/** `inputContainsFullTranscript`: compaction markers mean the client already sent the whole conversation. */
export const inputContainsFullTranscript = (input: Json | undefined): boolean =>
  isJsonArray(input) &&
  input.some((item) => {
    const type = asString(get(item, "type"));

    return type === "compaction" || type === "compaction_summary";
  });

const inputWithoutCompactionItems = (input: Json[]): Json[] =>
  input.filter((item) => {
    const type = asString(get(item, "type"));

    return type !== "compaction" && type !== "compaction_summary";
  });

// --- transcript merging -----------------------------------------------------------------------------------------

interface PreviousInput {
  readonly items?: Json[];
  readonly error?: string;
}

const previousInput = (lastRequest: JsonObject): PreviousInput => {
  let input: Json | undefined;

  for (const [key, value] of Object.entries(lastRequest))
    if (key.toLowerCase() === "input") input = value;

  if (input === undefined || input === null) return { items: [] };

  return isJsonArray(input) ? { items: input } : { error: "invalid previous request input" };
};

/** `mergeResponsesWebsocketInput`: previous input + previous output + the appended input, deduplicated. */
export const mergeInput = (
  lastRequest: JsonObject,
  lastResponseOutput: ReadonlyArray<Json>,
  append: ReadonlyArray<Json>,
):
  | { readonly ok: true; readonly input: Json[] }
  | { readonly ok: false; readonly message: string } => {
  const previous = previousInput(lastRequest);

  if (previous.items === undefined)
    return { ok: false, message: previous.error ?? "invalid previous request input" };
  let items = previous.items.map(toMergeItem);

  if (inputContainsFullTranscript([...lastResponseOutput])) {
    items = items.filter((item) => item.itemType !== "compaction_trigger");
  }

  items.push(...lastResponseOutput.map(toMergeItem), ...append.map(toMergeItem));

  return { ok: true, input: dedupeInputItems(dedupeFunctionCalls(items)).map((item) => item.raw) };
};

// --- request normalisation --------------------------------------------------------------------------------------

const withoutKey = (object: JsonObject, ...keys: string[]): JsonObject => {
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(object)) if (!keys.includes(key)) out[key] = value;

  return out;
};

/** Copies `model` and `instructions` from the previous request when the new one omits them. */
const inheritFromLast = (
  normalized: JsonObject,
  lastRequest: JsonObject | undefined,
): JsonObject => {
  const out = { ...normalized };

  if (out["model"] === undefined) {
    const model = trimmed(lastRequest?.["model"]);

    if (model !== "") out["model"] = model;
  }

  if (out["instructions"] === undefined && lastRequest?.["instructions"] !== undefined) {
    out["instructions"] = cloneJson(lastRequest["instructions"]);
  }

  return out;
};

/** `normalizeResponseCreateRequest`: the first create of a socket (or a root of a new transcript). */
export const normalizeCreateRequest = (raw: JsonObject): Normalized => {
  const input = raw["input"];

  if (input !== undefined && !isJsonArray(input))
    return failure("websocket request requires array field: input", undefined);
  const normalized: JsonObject = { ...withoutKey(raw, "type"), stream: true };

  if (normalized["input"] === undefined) normalized["input"] = [];

  if (trimmed(normalized["model"]) === "")
    return failure("missing model in response.create request", undefined);

  return { ok: true, request: normalized, last: cloneJson(normalized) };
};

/** `normalizeResponseTranscriptReplacement`: a self-contained request that replaces the transcript. */
export const normalizeTranscriptReplacement = (
  raw: JsonObject,
  lastRequest: JsonObject | undefined,
): JsonObject =>
  cloneJson({
    ...inheritFromLast(withoutKey(raw, "type", "previous_response_id"), lastRequest),
    stream: true,
  });

/** `inputHasCodexLocalCompactionSummary`. */
const hasLocalCompactionSummary = (input: Json[]): boolean => {
  let hasSummary = false;

  for (const [index, item] of input.entries()) {
    const itemType = trimmed(get(item, "type"));

    if (itemType === "additional_tools") {
      const tools = get(item, "tools");

      if (index !== 0 || trimmed(get(item, "role")) !== "developer" || !isJsonArray(tools))
        return false;

      if (!tools.every((tool) => isJsonObject(tool) && trimmed(tool["type"]) !== "")) return false;
      continue;
    }

    if (itemType !== "" && itemType !== "message") return false;
    const role = trimmed(get(item, "role"));

    if (role !== "user" && role !== "developer") return false;

    if (
      role === "user" &&
      messageText(item).startsWith(`${CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX}\n`)
    )
      hasSummary = true;
  }

  return hasSummary;
};

const messageText = (message: Json): string => {
  const content = get(message, "content");

  if (typeof content === "string") return content;

  if (!isJsonArray(content)) return "";

  return content
    .map((part) => (trimmed(get(part, "type")) === "input_text" ? asString(get(part, "text")) : ""))
    .join("");
};

/** `shouldReplaceWebsocketTranscript`: compact replays carry historical model output. */
const shouldReplaceTranscript = (raw: JsonObject, nextInput: Json[]): boolean => {
  const requestType = trimmed(raw["type"]);

  if (requestType !== REQUEST_TYPE_CREATE && requestType !== REQUEST_TYPE_APPEND) return false;

  if (trimmed(raw["previous_response_id"]) !== "") return false;

  if (
    requestType === REQUEST_TYPE_CREATE &&
    raw["previous_response_id"] === undefined &&
    hasLocalCompactionSummary(nextInput)
  ) {
    return true;
  }

  return nextInput.some((item) => {
    switch (trimmed(get(item, "type"))) {
      case "function_call":
      case "custom_tool_call":
        return true;
      case "message":
        return trimmed(get(item, "role")) === "assistant";
      default:
        return false;
    }
  });
};

/** `inputSatisfiesPendingToolCalls`. */
export const inputSatisfiesPendingToolCalls = (
  input: Json[],
  pendingCallIds: ReadonlyArray<string>,
): boolean => {
  if (pendingCallIds.length === 0) return true;
  const outputs = new Set<string>();

  for (const item of input) {
    const type = trimmed(get(item, "type"));

    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const callId = trimmed(get(item, "call_id"));

      if (callId !== "") outputs.add(callId);
    }
  }

  return pendingCallIds.every((callId) => callId.trim() === "" || outputs.has(callId.trim()));
};

export interface ContinuationState {
  readonly lastRequest: JsonObject | undefined;
  readonly lastResponseOutput: ReadonlyArray<Json>;
  readonly lastResponseId: string;
  readonly pendingToolCallIds: ReadonlyArray<string>;
}

/** `normalizeResponseSubsequentRequest`. */
export const normalizeSubsequentRequest = (
  raw: JsonObject,
  state: ContinuationState,
  allowIncrementalInputWithPreviousResponseId: boolean,
  allowCompactionReplayBypass: boolean,
): Normalized => {
  const { lastRequest } = state;

  if (lastRequest === undefined)
    return failure("websocket request received before response.create", lastRequest);
  const nextInput = raw["input"];

  if (!isJsonArray(nextInput))
    return failure("websocket request requires array field: input", lastRequest);

  if (shouldReplaceTranscript(raw, nextInput)) {
    const normalized = normalizeTranscriptReplacement(raw, lastRequest);

    return { ok: true, request: normalized, last: cloneJson(normalized) };
  }

  let previous = trimmed(raw["previous_response_id"]);

  // Whatever the upstream does with `previous_response_id`, a call without its output must not be replayed (f4d3f061).
  if (previous === "" && !inputSatisfiesPendingToolCalls(nextInput, state.pendingToolCallIds)) {
    const normalized = normalizeTranscriptReplacement(raw, lastRequest);

    return { ok: true, request: normalized, last: cloneJson(normalized) };
  }

  if (allowIncrementalInputWithPreviousResponseId) {
    if (previous === "") previous = state.lastResponseId.trim();

    if (previous !== "") {
      const normalized = inheritFromLast(
        { ...withoutKey(raw, "type"), previous_response_id: previous },
        lastRequest,
      );

      normalized["stream"] = true;

      return { ok: true, request: normalized, last: cloneJson(normalized) };
    }
  }

  let merged: Json[];

  if (allowCompactionReplayBypass && inputContainsFullTranscript(nextInput)) {
    // The input already carries the canonical history: merging stale state would break call/output pairings.
    merged = nextInput;
  } else {
    const append = inputContainsFullTranscript(nextInput)
      ? inputWithoutCompactionItems(nextInput)
      : nextInput;

    const result = mergeInput(lastRequest, state.lastResponseOutput, append);

    if (!result.ok) return failure(result.message, lastRequest);
    merged = result.input;
  }

  const normalized = inheritFromLast(withoutKey(raw, "type", "previous_response_id"), lastRequest);
  normalized["stream"] = true;
  normalized["input"] = merged;

  return { ok: true, request: normalized, last: cloneJson(normalized) };
};

/** `normalizeResponsesWebsocketRequestWithIncrementalState`. */
export const normalizeRequest = (
  raw: JsonObject,
  state: ContinuationState,
  allowIncrementalInputWithPreviousResponseId: boolean,
  allowCompactionReplayBypass: boolean,
): Normalized => {
  const requestType = trimmed(raw["type"]);

  switch (requestType) {
    case REQUEST_TYPE_CREATE:
      return state.lastRequest === undefined
        ? normalizeCreateRequest(raw)
        : normalizeSubsequentRequest(
            raw,
            state,
            allowIncrementalInputWithPreviousResponseId,
            allowCompactionReplayBypass,
          );
    case REQUEST_TYPE_APPEND:
      return normalizeSubsequentRequest(
        raw,
        state,
        allowIncrementalInputWithPreviousResponseId,
        allowCompactionReplayBypass,
      );
    default:
      return failure(`unsupported websocket request type: ${requestType}`, state.lastRequest);
  }
};

/** `normalizeResponsesWebsocketPassthroughRequest`: the upstream socket keeps the state, the body goes through. */
export const normalizePassthroughRequest = (
  raw: JsonObject,
  modelName: string,
):
  | { readonly ok: true; readonly request: JsonObject }
  | { readonly ok: false; readonly error: WsRequestError } => {
  const requestType = trimmed(raw["type"]);

  if (requestType !== REQUEST_TYPE_CREATE && requestType !== REQUEST_TYPE_APPEND) {
    return {
      ok: false,
      error: { status: 400, message: `unsupported websocket request type: ${requestType}` },
    };
  }

  const normalized: JsonObject = { ...raw };

  if (trimmed(normalized["model"]) === "") {
    const model = modelName.trim();

    if (model === "")
      return {
        ok: false,
        error: { status: 400, message: "missing model in response.create request" },
      };
    normalized["model"] = model;
  }

  normalized["stream"] = true;

  return { ok: true, request: normalized };
};

// --- warm-ups -----------------------------------------------------------------------------------------------------

/** `shouldHandleResponsesWebsocketPrewarmLocally` (never when the upstream keeps the state itself). */
export const shouldHandlePrewarmLocally = (raw: JsonObject): boolean =>
  trimmed(raw["type"]) === REQUEST_TYPE_CREATE && raw["generate"] === false;

/**
 * `normalizeResponsesWebsocketPrewarmFollowup`: a synthetic warm-up acknowledges input that never reached the upstream,
 * so the follow-up request materialises it before compaction detection can mistake the delta for a transcript.
 */
export const normalizePrewarmFollowup = (
  raw: JsonObject,
  warmupRequest: JsonObject,
): Normalized => {
  const requestType = trimmed(raw["type"]);

  if (requestType !== REQUEST_TYPE_CREATE && requestType !== REQUEST_TYPE_APPEND) {
    return failure(`unsupported websocket request type: ${requestType}`, warmupRequest);
  }

  const input = raw["input"];

  if (!isJsonArray(input))
    return failure("websocket request requires array field: input", warmupRequest);
  const merged = mergeInput(warmupRequest, [], input);

  if (!merged.ok) return failure(merged.message, warmupRequest);
  const normalized = { ...normalizeTranscriptReplacement(raw, warmupRequest), input: merged.input };

  return { ok: true, request: normalized, last: cloneJson(normalized) };
};

/** `syntheticResponsesWebsocketPrewarmPayloads`: `response.created` (seq 0) + `response.completed` (seq 1). */
export const syntheticPrewarmPayloads = (
  request: JsonObject,
  now: { readonly id: string; readonly createdAt: number },
): [JsonObject, JsonObject] => {
  const responseId = `resp_prewarm_${now.id}`;
  const model = trimmed(request["model"]);

  const created: JsonObject = {
    type: "response.created",
    sequence_number: 0,
    response: {
      id: responseId,
      object: "response",
      created_at: now.createdAt,
      status: "in_progress",
      background: false,
      error: null,
      output: [],
      ...(model !== "" ? { model } : {}),
    },
  };

  const completed: JsonObject = {
    type: "response.completed",
    sequence_number: 1,
    response: {
      id: responseId,
      object: "response",
      created_at: now.createdAt,
      status: "completed",
      background: false,
      error: null,
      output: [],
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
      ...(model !== "" ? { model } : {}),
    },
  };

  return [created, completed];
};
