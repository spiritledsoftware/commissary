/**
 * Claude Messages provider -> OpenAI Responses client (response).
 *
 * Go source: internal/translator/claude/openai/responses/claude_openai-responses_response.go.
 *
 * The Codex `apply_patch` custom tool bridge is included: a custom tool named `apply_patch` (original request
 * declaration) arrives as strict `{"input": ...}` function arguments, is streamed as `response.custom_tool_call_input`
 * deltas and any malformed or inconsistent input terminates the response with `response.failed`
 * (`state.toolInputError`, 502 for the caller). Divergence: a patch-enabled stream that ends without its
 * `message_stop` is detected through `state.finalizeToolInput` only once a line was translated.
 */
import {
  asBool,
  asFloat,
  asInt,
  get,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import {
  ApplyPatchCallState,
  applyPatchFailure,
  applyPatchInputDelta,
  applyPatchInputDone,
  isApplyPatchCustomTool,
} from "../../../common/apply-patch.ts";
import { claudeMessagesJSONToSSE } from "../../../common/claude-native-response.ts";
import { exists, isObj, isStr, str } from "../../../common/gjson.ts";
import type { ResponseContext, ResponseTransform } from "../../../registry.ts";
import {
  ClaudeToolNames,
  CLAUDE_RESPONSES_REDACTED_THINKING_PREFIX,
  splitResponsesQualifiedFunctionCall,
  type ToolDescriptor,
  responsesToolWinners,
  unwrapCustomToolInput,
} from "./tools.ts";
import {
  buildResponsesWebSearchCallItem,
  CLAUDE_WEB_SEARCH_TOOL_NAME,
  claudeWebSearchQuery,
  claudeWebSearchResultsToResponses,
  responsesWebSearchCallID,
} from "./web-search.ts";

interface WebSearchItem {
  toolUseId: string;
  outputIndex: number;
  inputBuf: string;
  results: Json | undefined;
  emitted: boolean;
  status: string;
}

interface MessageItem {
  id: string;
  outputIndex: number;
  text: string;
  annotations: Json[];
  status: string;
}

interface ReasoningItem {
  id: string;
  outputIndex: number;
  text: string;
  signature: string;
  status: string;
}

interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  hasUsage: boolean;
}

const mergeUsage = (u: UsageTokens, usage: Json | undefined): void => {
  if (!exists(usage)) return;
  u.hasUsage = true;
  const input = get(usage, "input_tokens");

  if (exists(input)) u.inputTokens = asInt(input);
  const output = get(usage, "output_tokens");

  if (exists(output)) u.outputTokens = asInt(output);
  const creation = get(usage, "cache_creation_input_tokens");

  if (exists(creation)) u.cacheCreationInputTokens = asInt(creation);
  const read = get(usage, "cache_read_input_tokens");

  if (exists(read)) u.cacheReadInputTokens = asInt(read);
};

const newUsage = (): UsageTokens => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  hasUsage: false,
});

type ResponsesUsageResult = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
};

const responsesUsage = (u: UsageTokens): ResponsesUsageResult => {
  const cachedTokens = u.cacheReadInputTokens;
  const inputTokens = u.inputTokens + u.cacheCreationInputTokens + cachedTokens;

  return {
    inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: inputTokens + u.outputTokens,
    cachedTokens,
  };
};

/** Go `claudeToResponsesState` (minus the apply_patch bridge). */
interface State {
  toolWinners: Map<string, ToolDescriptor>;
  toolNames: ClaudeToolNames;
  funcItemAdded: Map<number, boolean>;
  funcArgsSent: Map<number, number>;
  funcBlockStopped: Map<number, boolean>;
  /** Claude block index -> `apply_patch` decoder of a freeform patch call. */
  applyPatchCalls: Map<number, ApplyPatchCallState>;
  funcInputSnapshot: Map<number, string>;
  funcInputSnapshotErrors: Map<number, string>;
  funcIdentityConflicts: Map<number, boolean>;
  /** First retained `apply_patch` failure; later lines produce nothing. */
  toolInputError: string | undefined;
  completedEmitted: boolean;
  seq: number;
  responseId: string;
  createdAt: number;
  nextOutputIndex: number;
  currentMsgId: string;
  currentFcId: string;
  inTextBlock: boolean;
  inFuncBlock: boolean;
  messageOpen: boolean;
  contentPartOpen: boolean;
  messageOutputIndex: number;
  funcArgsBuf: Map<number, string>;
  funcArgsDone: Map<number, boolean>;
  funcItemDone: Map<number, boolean>;
  funcItemStatus: Map<number, string>;
  funcNames: Map<number, string>;
  funcCallIds: Map<number, string>;
  funcCustom: Map<number, boolean>;
  funcOutputIndices: Map<number, number>;
  textBuf: string;
  messageAnnotations: Json[];
  messageItems: MessageItem[];
  reasoningActive: boolean;
  reasoningDeltasDone: boolean;
  reasoningItemId: string;
  reasoningBuf: string;
  reasoningSignature: string;
  reasoningIndex: number;
  reasoningItems: ReasoningItem[];
  webSearchByBlock: Map<number, WebSearchItem>;
  webSearchByToolId: Map<string, WebSearchItem>;
  webSearchItems: WebSearchItem[];
  stopReason: string;
  usage: UsageTokens;
}

const newState = (request: Json | undefined): State => {
  const winners = responsesToolWinners(request);

  return {
    toolWinners: winners,
    toolNames: ClaudeToolNames.build(request, winners),
    funcItemAdded: new Map(),
    funcArgsSent: new Map(),
    funcBlockStopped: new Map(),
    applyPatchCalls: new Map(),
    funcInputSnapshot: new Map(),
    funcInputSnapshotErrors: new Map(),
    funcIdentityConflicts: new Map(),
    toolInputError: undefined,
    completedEmitted: false,
    seq: 0,
    responseId: "",
    createdAt: 0,
    nextOutputIndex: 0,
    currentMsgId: "",
    currentFcId: "",
    inTextBlock: false,
    inFuncBlock: false,
    messageOpen: false,
    contentPartOpen: false,
    messageOutputIndex: -1,
    funcArgsBuf: new Map(),
    funcArgsDone: new Map(),
    funcItemDone: new Map(),
    funcItemStatus: new Map(),
    funcNames: new Map(),
    funcCallIds: new Map(),
    funcCustom: new Map(),
    funcOutputIndices: new Map(),
    textBuf: "",
    messageAnnotations: [],
    messageItems: [],
    reasoningActive: false,
    reasoningDeltasDone: false,
    reasoningItemId: "",
    reasoningBuf: "",
    reasoningSignature: "",
    reasoningIndex: -1,
    reasoningItems: [],
    webSearchByBlock: new Map(),
    webSearchByToolId: new Map(),
    webSearchItems: [],
    stopReason: "",
    usage: newUsage(),
  };
};

/** Carrier for the reasoning item's encrypted_content (signature, or redacted_thinking data behind a marker). */
const reasoningCarrier = (block: Json | undefined): string => {
  if (str(get(block, "type")) === "redacted_thinking") {
    const data = get(block, "data");

    return exists(data) && str(data) !== ""
      ? CLAUDE_RESPONSES_REDACTED_THINKING_PREFIX + str(data)
      : "";
  }

  const signature = get(block, "signature");

  return exists(signature) ? str(signature) : "";
};

const incompleteDetails = (stopReason: string): { details: Json } | undefined => {
  switch (stopReason.trim().toLowerCase()) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return { details: { reason: "max_output_tokens" } };
    case "refusal":
      // Safety classifiers stop the turn with a normal 200; Responses clients treat content_filter as a refusal
      // instead of a finished answer.
      return { details: { reason: "content_filter" } };
  }

  return undefined;
};

/**
 * Anthropic's server-tool iteration pause: the turn is unfinished but valid, and the client continues it by sending
 * the paused assistant content back, so Responses ends it as `completed` with `end_turn: false` (not an error).
 */
const isPauseTurn = (stopReason: string): boolean =>
  stopReason.trim().toLowerCase() === "pause_turn";

/** A paused search that never received its result stays `in_progress`, so the next request can send it back. */
const webSearchStatus = (stopReason: string, status: string, hasResults: boolean): string =>
  isPauseTurn(stopReason) && !hasResults ? "in_progress" : status;

const outputStatus = (stopReason: string): string =>
  incompleteDetails(stopReason) !== undefined ? "incomplete" : "completed";

const terminalState = (
  stopReason: string,
): { eventType: string; status: string; details: { details: Json } | undefined } => {
  const details = incompleteDetails(stopReason);

  return details !== undefined
    ? { eventType: "response.incomplete", status: "incomplete", details }
    : { eventType: "response.completed", status: "completed", details: undefined };
};

/** `pickRequestJSON`: the original request when it is valid JSON, else the translated one. */
const pickRequest = (original: Json | undefined, translated: Json | undefined): Json | undefined =>
  original ?? translated;

const requestModelName = (original: Json | undefined, translated: Json | undefined): string => {
  for (const raw of [original, translated]) {
    for (const path of ["model", "request.model"]) {
      const model = get(raw, path);

      if (isStr(model) && model.trim() !== "") return model;
    }
  }

  return "";
};

const emit = (event: string, payload: JsonObject): string =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

/** `SetResponsesToolCallIdentity` through `splitResponsesQualifiedFunctionCallFromRequest`. */
const applyNamespaceFields = (
  item: JsonObject,
  request: Json | undefined,
  qualifiedName: string,
): void => {
  const { name, namespace } = splitResponsesQualifiedFunctionCall(request, qualifiedName);
  item.name = name;

  if (namespace !== "") item.namespace = namespace;
  else delete item.namespace;
};

const allocateOutputIndex = (st: State): number => st.nextOutputIndex++;

const messageOutputIndex = (st: State): number => {
  if (st.messageOutputIndex < 0) st.messageOutputIndex = allocateOutputIndex(st);

  return st.messageOutputIndex;
};

const functionOutputIndex = (st: State, blockIndex: number): number => {
  const existing = st.funcOutputIndices.get(blockIndex);

  if (existing !== undefined) return existing;
  const index = allocateOutputIndex(st);
  st.funcOutputIndices.set(blockIndex, index);

  return index;
};

/** Registers a web search item for the block at `idx` and returns its `output_item.added` event. */
const startWebSearch = (st: State, idx: number, toolUseId: string, nextSeq: () => number) => {
  const item: WebSearchItem = {
    toolUseId,
    outputIndex: allocateOutputIndex(st),
    inputBuf: "",
    results: undefined,
    emitted: false,
    status: "",
  };

  st.webSearchByBlock.set(idx, item);
  st.webSearchByToolId.set(toolUseId, item);
  st.webSearchItems.push(item);

  return {
    item,
    added: emit("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: nextSeq(),
      output_index: item.outputIndex,
      item: {
        id: responsesWebSearchCallID(item.toolUseId),
        type: "web_search_call",
        status: "in_progress",
        action: { type: "search", query: "" },
      },
    }),
  };
};

const renderWebSearch = (item: WebSearchItem): JsonObject =>
  buildResponsesWebSearchCallItem(
    item.toolUseId,
    claudeWebSearchQuery(item.inputBuf),
    item.results,
  );

const finalizeWebSearch = (
  st: State,
  item: WebSearchItem,
  status: string,
  nextSeq: () => number,
): string[] => {
  if (item.emitted) return [];
  item.emitted = true;
  item.status = status;
  const rendered = renderWebSearch(item);
  rendered.status = status;

  return [
    emit("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: nextSeq(),
      output_index: item.outputIndex,
      item: rendered,
    }),
  ];
};

/** `isApplyPatch`: the original request's winning declaration, not the sanitised upstream name. */
const isApplyPatch = (st: State, name: string): boolean => {
  const descriptor = st.toolWinners.get(st.toolNames.identity(name));

  return (
    descriptor !== undefined &&
    descriptor.toolType === "custom" &&
    isApplyPatchCustomTool(descriptor.tool)
  );
};

/** `validateApplyPatchSnapshots`: equivalent JSON spellings pass, one patch input never silently replaces another. */
const validateApplyPatchSnapshots = (previous: string, current: string): string | undefined => {
  const call = new ApplyPatchCallState("", "", "", "", 0);

  if (previous !== "") {
    const finished = call.finishArguments(previous);

    if ("error" in finished) return finished.error;
  }

  const finished = call.finishArguments(current);

  return "error" in finished ? finished.error : undefined;
};

/**
 * `finishClaudeApplyPatchArguments`: complete streamed JSON is a complete snapshot, not a prefix a later snapshot may
 * silently extend; a partial source can still be completed by a consistent full snapshot.
 */
const finishClaudeApplyPatchArguments = (
  call: ApplyPatchCallState,
  args: string,
  snapshot: string,
): { readonly tail: string; readonly input: string } | { readonly error: string } => {
  if (snapshot === "") return call.finishArguments(args);

  if (tryParseJson(args) !== undefined) {
    const finished = call.finishArguments(args);

    if ("error" in finished) return finished;
  }

  return call.finishArguments(snapshot);
};

const CONFLICTING_IDENTITY = "conflicting apply_patch call identity";

/** `failToolInput`: retains the first failure and emits one terminal `response.failed`. */
const failToolInput = (st: State, error: string, nextSeq: () => number): string[] => {
  if (st.toolInputError !== undefined) return [];
  st.toolInputError = error;

  return [emit("response.failed", applyPatchFailure(st.responseId, nextSeq()))];
};

const emitFuncItem = (
  st: State,
  idx: number,
  request: Json | undefined,
  force: boolean,
  nextSeq: () => number,
): string[] => {
  if (st.funcItemAdded.get(idx) === true || st.toolInputError !== undefined) return [];
  let name = st.funcNames.get(idx) ?? "";
  let callId = st.funcCallIds.get(idx) ?? "";

  if (force && name === "" && st.toolWinners.size === 1) {
    for (const identity of st.toolWinners.keys()) {
      if (isApplyPatch(st, identity)) {
        name = st.toolNames.claudeName(identity);
        st.funcNames.set(idx, name);
      }
    }
  }

  if (isApplyPatch(st, name)) {
    if (st.funcIdentityConflicts.get(idx) === true)
      return failToolInput(st, CONFLICTING_IDENTITY, nextSeq);
    const snapshotError = st.funcInputSnapshotErrors.get(idx);

    if (snapshotError !== undefined) return failToolInput(st, snapshotError, nextSeq);
  }

  if (!force && (name === "" || callId === "")) return [];

  if (callId === "") {
    callId = `call_${st.responseId}_${idx}`;
    st.funcCallIds.set(idx, callId);
  }

  const descriptor = st.toolWinners.get(st.toolNames.identity(name));
  const custom = descriptor?.toolType === "custom";
  st.funcCustom.set(idx, custom);
  const outputIndex = functionOutputIndex(st, idx);
  let item: JsonObject;

  if (custom) {
    item = {
      id: `ctc_${callId}`,
      type: "custom_tool_call",
      status: "in_progress",
      input: "",
      call_id: callId,
      name: "",
    };

    if (isApplyPatch(st, name) && descriptor !== undefined) {
      st.applyPatchCalls.set(
        idx,
        new ApplyPatchCallState(
          `ctc_${callId}`,
          callId,
          descriptor.direct ? descriptor.name : descriptor.childName,
          descriptor.namespace,
          outputIndex,
        ),
      );
    }
  } else {
    item = {
      id: `fc_${callId}`,
      type: "function_call",
      status: "in_progress",
      arguments: "",
      call_id: callId,
      name: "",
    };
  }

  applyNamespaceFields(item, request, name);
  st.funcItemAdded.set(idx, true);

  return [
    emit("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: nextSeq(),
      output_index: outputIndex,
      item,
    }),
  ];
};

const emitPendingFuncArgs = (st: State, idx: number, nextSeq: () => number): string[] => {
  if (st.funcItemAdded.get(idx) !== true || st.toolInputError !== undefined) return [];
  const buf = st.funcArgsBuf.get(idx);
  const sent = st.funcArgsSent.get(idx) ?? 0;

  if (buf === undefined || buf.length <= sent) return [];
  const fragment = buf.slice(sent);
  st.funcArgsSent.set(idx, buf.length);

  if (st.funcCustom.get(idx) === true) {
    // Only the `apply_patch` bridge streams freeform input; other custom tools deliver it at completion.
    const patchCall = st.applyPatchCalls.get(idx);

    if (patchCall === undefined) return [];
    const pushed = patchCall.pushArguments(fragment);

    if ("error" in pushed) return failToolInput(st, pushed.error, nextSeq);

    return pushed.text === ""
      ? []
      : [
          emit(
            "response.custom_tool_call_input.delta",
            applyPatchInputDelta(patchCall, pushed.text, nextSeq()),
          ),
        ];
  }

  return [
    emit("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      sequence_number: nextSeq(),
      item_id: `fc_${st.funcCallIds.get(idx) ?? ""}`,
      output_index: functionOutputIndex(st, idx),
      delta: fragment,
    }),
  ];
};

const finalizeFuncItem = (
  st: State,
  idx: number,
  request: Json | undefined,
  status: string,
  nextSeq: () => number,
): string[] => {
  if (st.funcItemDone.get(idx) === true || st.toolInputError !== undefined) return [];
  const out = emitFuncItem(st, idx, request, true, nextSeq);
  out.push(...emitPendingFuncArgs(st, idx, nextSeq));

  if (st.toolInputError !== undefined) return out;
  st.funcItemDone.set(idx, true);
  st.funcItemStatus.set(idx, status);

  const outputIndex = functionOutputIndex(st, idx);
  const buf = st.funcArgsBuf.get(idx) ?? "";
  let args = buf.length > 0 ? buf : "";
  const custom = st.funcCustom.get(idx) === true;

  if (!custom && args === "" && status === "completed") args = "{}";
  let callId = st.funcCallIds.get(idx) ?? "";

  if (callId === "") callId = st.currentFcId;
  const name = st.funcNames.get(idx) ?? "";

  if (custom) {
    let input: string;
    const patchCall = st.applyPatchCalls.get(idx);

    if (patchCall !== undefined) {
      const finished = finishClaudeApplyPatchArguments(
        patchCall,
        args,
        st.funcInputSnapshot.get(idx) ?? "",
      );

      if ("error" in finished) return [...out, ...failToolInput(st, finished.error, nextSeq)];
      input = finished.input;

      if (finished.tail !== "") {
        out.push(
          emit(
            "response.custom_tool_call_input.delta",
            applyPatchInputDelta(patchCall, finished.tail, nextSeq()),
          ),
        );
      }
    } else {
      input = unwrapCustomToolInput(args);
    }

    if (st.funcArgsDone.get(idx) !== true) {
      st.funcArgsDone.set(idx, true);
      out.push(
        patchCall !== undefined
          ? emit(
              "response.custom_tool_call_input.done",
              applyPatchInputDone(patchCall, input, nextSeq()),
            )
          : emit("response.custom_tool_call_input.done", {
              type: "response.custom_tool_call_input.done",
              sequence_number: nextSeq(),
              item_id: `ctc_${callId}`,
              output_index: outputIndex,
              input,
            }),
      );
    }

    const item: JsonObject = {
      id: `ctc_${callId}`,
      type: "custom_tool_call",
      status,
      input,
      call_id: callId,
      name: "",
    };

    applyNamespaceFields(item, request, name);
    out.push(
      emit("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: outputIndex,
        item,
      }),
    );
  } else {
    if (st.funcArgsDone.get(idx) !== true) {
      st.funcArgsDone.set(idx, true);
      out.push(
        emit("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          sequence_number: nextSeq(),
          item_id: `fc_${callId}`,
          output_index: outputIndex,
          arguments: args,
        }),
      );
    }

    const item: JsonObject = {
      id: `fc_${callId}`,
      type: "function_call",
      status,
      arguments: args,
      call_id: callId,
      name: "",
    };

    applyNamespaceFields(item, request, name);
    out.push(
      emit("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: outputIndex,
        item,
      }),
    );
  }

  st.inFuncBlock = false;

  return out;
};

const finalizeReasoningDeltas = (st: State, nextSeq: () => number): string[] => {
  if (!st.reasoningActive || st.reasoningDeltasDone) return [];
  st.reasoningDeltasDone = true;
  const full = st.reasoningBuf;

  return [
    emit("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      sequence_number: nextSeq(),
      item_id: st.reasoningItemId,
      output_index: st.reasoningIndex,
      summary_index: 0,
      text: full,
    }),
    emit("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      sequence_number: nextSeq(),
      item_id: st.reasoningItemId,
      output_index: st.reasoningIndex,
      summary_index: 0,
      part: { type: "summary_text", text: full },
    }),
  ];
};

const finalizeReasoningItem = (st: State, status: string, nextSeq: () => number): string[] => {
  if (!st.reasoningActive && st.reasoningItemId === "") return [];
  const out = finalizeReasoningDeltas(st, nextSeq);
  const full = st.reasoningBuf;
  out.push(
    emit("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: nextSeq(),
      output_index: st.reasoningIndex,
      item: {
        id: st.reasoningItemId,
        type: "reasoning",
        status,
        encrypted_content: st.reasoningSignature,
        summary: [{ type: "summary_text", text: full }],
      },
    }),
  );
  st.reasoningItems.push({
    id: st.reasoningItemId,
    outputIndex: st.reasoningIndex,
    text: full,
    signature: st.reasoningSignature,
    status,
  });
  st.reasoningActive = false;
  st.reasoningItemId = "";
  st.reasoningBuf = "";
  st.reasoningSignature = "";
  st.reasoningIndex = -1;

  return out;
};

const finalizeAssistantMessage = (st: State, nextSeq: () => number): string[] => {
  if (!st.messageOpen) return [];
  const fullText = st.textBuf;
  const outputIndex = messageOutputIndex(st);
  const status = outputStatus(st.stopReason);
  const annotations = st.messageAnnotations;
  const out: string[] = [];
  out.push(
    emit("response.output_text.done", {
      type: "response.output_text.done",
      sequence_number: nextSeq(),
      item_id: st.currentMsgId,
      output_index: outputIndex,
      content_index: 0,
      text: fullText,
      logprobs: [],
    }),
  );
  out.push(
    emit("response.content_part.done", {
      type: "response.content_part.done",
      sequence_number: nextSeq(),
      item_id: st.currentMsgId,
      output_index: outputIndex,
      content_index: 0,
      part: {
        type: "output_text",
        annotations: annotations.length > 0 ? annotations : [],
        logprobs: [],
        text: fullText,
      },
    }),
  );
  out.push(
    emit("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: nextSeq(),
      output_index: outputIndex,
      item: {
        id: st.currentMsgId,
        type: "message",
        status,
        content: [
          {
            type: "output_text",
            annotations: annotations.length > 0 ? annotations : [],
            logprobs: [],
            text: fullText,
          },
        ],
        role: "assistant",
      },
    }),
  );
  st.messageItems.push({
    id: st.currentMsgId,
    outputIndex,
    text: fullText,
    annotations: [...st.messageAnnotations],
    status,
  });
  st.inTextBlock = false;
  st.messageOpen = false;
  st.contentPartOpen = false;
  st.currentMsgId = "";
  st.messageOutputIndex = -1;
  st.textBuf = "";
  st.messageAnnotations = [];

  return out;
};

/** Request fields echoed into the response object (Go key order). */
const echoRequestFields = (target: JsonObject, req: Json | undefined): void => {
  if (!exists(req)) return;
  const has = (key: string): Json | undefined => get(req, key);

  const v = (key: string, convert: (value: Json) => Json): void => {
    const value = has(key);

    if (exists(value)) target[key] = convert(value);
  };

  v("instructions", str);
  v("max_output_tokens", asInt);
  v("max_tool_calls", asInt);
  v("model", str);
  v("parallel_tool_calls", asBool);
  v("previous_response_id", str);
  v("prompt_cache_key", str);
  v("reasoning", (value) => value);
  v("safety_identifier", str);
  v("service_tier", str);
  v("store", asBool);
  v("temperature", asFloat);
  v("text", (value) => value);
  v("tool_choice", (value) => value);
  v("tools", (value) => value);
  v("top_logprobs", asInt);
  v("top_p", asFloat);
  v("truncation", str);
  v("user", (value) => value);
  v("metadata", (value) => value);
};

/** `ConvertClaudeResponseToOpenAIResponses`. */
export const convertClaudeResponseToOpenAIResponses = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const out = convertStreamLine(context, line);
  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  const st = context.state.value as State;

  if (st.toolInputError !== undefined) context.state.toolInputError = st.toolInputError;
  context.state.finalizeToolInput ??= () => finalizeToolInput(context, st);

  return out;
};

/** `FinalizeToolInput`: a patch-enabled stream that ends before `message_stop` fails instead of completing. */
const finalizeToolInput = (context: ResponseContext, st: State): ReadonlyArray<string> => {
  if (st.toolInputError !== undefined || st.completedEmitted) return [];

  if (![...st.toolWinners.keys()].some((name) => isApplyPatch(st, name))) return [];
  st.toolInputError = "upstream apply_patch stream ended before protocol completion";
  context.state.toolInputError = st.toolInputError;
  st.seq++;

  return [emit("response.failed", applyPatchFailure(st.responseId, st.seq))];
};

const convertStreamLine = (context: ResponseContext, line: string): ReadonlyArray<string> => {
  const modelName = context.model;
  context.state.value ??= newState(pickRequest(context.originalRequest, context.translatedRequest));
  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  const st = context.state.value as State;

  if (st.completedEmitted || st.toolInputError !== undefined) return [];

  if (!line.startsWith("data:")) return [];
  const root = tryParseJson(line.slice(5).trim());
  const request = pickRequest(context.originalRequest, context.translatedRequest);
  const ev = str(get(root, "type"));
  let out: string[] = [];
  const nextSeq = (): number => ++st.seq;

  switch (ev) {
    case "message_start": {
      const msg = get(root, "message");

      if (!exists(msg)) break;
      st.responseId = str(get(msg, "id"));
      st.createdAt = Math.floor(Date.now() / 1000);
      st.textBuf = "";
      st.messageAnnotations = [];
      st.messageItems = [];
      st.reasoningBuf = "";
      st.reasoningActive = false;
      st.reasoningDeltasDone = false;
      st.nextOutputIndex = 0;
      st.inTextBlock = false;
      st.inFuncBlock = false;
      st.messageOpen = false;
      st.contentPartOpen = false;
      st.currentMsgId = "";
      st.currentFcId = "";
      st.messageOutputIndex = -1;
      st.reasoningItemId = "";
      st.reasoningSignature = "";
      st.reasoningIndex = -1;
      st.reasoningItems = [];
      st.stopReason = "";
      st.funcItemAdded = new Map();
      st.funcArgsSent = new Map();
      st.funcBlockStopped = new Map();
      st.applyPatchCalls = new Map();
      st.funcInputSnapshot = new Map();
      st.funcInputSnapshotErrors = new Map();
      st.funcIdentityConflicts = new Map();
      st.funcArgsBuf = new Map();
      st.funcArgsDone = new Map();
      st.funcItemDone = new Map();
      st.funcItemStatus = new Map();
      st.funcNames = new Map();
      st.funcCallIds = new Map();
      st.funcCustom = new Map();
      st.funcOutputIndices = new Map();
      st.usage = newUsage();
      mergeUsage(st.usage, get(msg, "usage"));

      const requestModel =
        requestModelName(context.originalRequest, context.translatedRequest) || modelName;

      const created: JsonObject = {
        type: "response.created",
        sequence_number: nextSeq(),
        response: {
          id: st.responseId,
          object: "response",
          created_at: st.createdAt,
          status: "in_progress",
          background: false,
          error: null,
          output: [],
        },
      };

      if (requestModel !== "")
        // SAFETY: `response` is an object literal in the event built just above.
        (created.response as JsonObject).model = requestModel;
      out.push(emit("response.created", created));

      const inProgress: JsonObject = {
        type: "response.in_progress",
        sequence_number: nextSeq(),
        response: {
          id: st.responseId,
          object: "response",
          created_at: st.createdAt,
          status: "in_progress",
          output: [],
        },
      };

      if (requestModel !== "")
        // SAFETY: `response` is an object literal in the event built just above.
        (inProgress.response as JsonObject).model = requestModel;
      out.push(emit("response.in_progress", inProgress));
      break;
    }

    case "content_block_start": {
      const cb = get(root, "content_block");

      if (!exists(cb)) return out;
      const idx = asInt(get(root, "index"));
      const typ = str(get(cb, "type"));

      if (typ !== "text") out.push(...finalizeAssistantMessage(st, nextSeq));

      if (st.reasoningActive || st.reasoningItemId !== "")
        out.push(...finalizeReasoningItem(st, "completed", nextSeq));

      for (const prevIdx of st.funcCallIds.keys()) {
        if (st.funcItemDone.get(prevIdx) !== true && prevIdx !== idx) {
          // Patch calls may interleave; a new block is not a completion snapshot for a still-open (or unnamed) call.
          const prevName = st.funcNames.get(prevIdx) ?? "";

          if (
            (isApplyPatch(st, prevName) || prevName === "") &&
            st.funcBlockStopped.get(prevIdx) !== true
          )
            continue;
          out.push(...finalizeFuncItem(st, prevIdx, request, "completed", nextSeq));

          if (st.toolInputError !== undefined) return out;
        }
      }

      for (const item of st.webSearchItems) {
        if (!item.emitted && item.results !== undefined)
          out.push(...finalizeWebSearch(st, item, "completed", nextSeq));
      }

      if (typ === "text") {
        st.inTextBlock = true;
        const outputIndex = messageOutputIndex(st);

        if (st.currentMsgId === "")
          st.currentMsgId = `msg_${st.responseId}_${st.messageItems.length}`;

        if (!st.messageOpen) {
          out.push(
            emit("response.output_item.added", {
              type: "response.output_item.added",
              sequence_number: nextSeq(),
              output_index: outputIndex,
              item: {
                id: st.currentMsgId,
                type: "message",
                status: "in_progress",
                content: [],
                role: "assistant",
              },
            }),
          );
          st.messageOpen = true;
        }

        if (!st.contentPartOpen) {
          out.push(
            emit("response.content_part.added", {
              type: "response.content_part.added",
              sequence_number: nextSeq(),
              item_id: st.currentMsgId,
              output_index: outputIndex,
              content_index: 0,
              part: { type: "output_text", annotations: [], logprobs: [], text: "" },
            }),
          );
          st.contentPartOpen = true;
        }
      } else if (typ === "tool_use") {
        st.inFuncBlock = true;
        const callId = str(get(cb, "id"));
        const name = str(get(cb, "name"));
        const oldId = st.funcCallIds.get(idx) ?? "";
        const oldName = st.funcNames.get(idx) ?? "";

        // Pending identity evidence must survive later matching updates.
        if (callId !== "" && oldId !== "" && callId !== oldId)
          st.funcIdentityConflicts.set(idx, true);

        if (isApplyPatch(st, oldName) || isApplyPatch(st, name)) {
          if (
            st.funcIdentityConflicts.get(idx) === true ||
            (name !== "" &&
              oldName !== "" &&
              st.toolNames.identity(name) !== st.toolNames.identity(oldName))
          ) {
            return [...out, ...failToolInput(st, CONFLICTING_IDENTITY, nextSeq)];
          }
        }

        if (st.funcItemAdded.get(idx) !== true) {
          if (callId !== "" || oldId === "") st.funcCallIds.set(idx, callId);
        }

        if (name !== "" && st.funcItemAdded.get(idx) !== true) st.funcNames.set(idx, name);
        st.currentFcId = st.funcCallIds.get(idx) ?? "";
        functionOutputIndex(st, idx);

        if (!st.funcArgsBuf.has(idx)) st.funcArgsBuf.set(idx, "");
        // An empty start input is a Claude placeholder, not an arguments fragment; populated snapshots are evidence.
        const startInput = get(cb, "input");

        if (exists(startInput) && (!isObj(startInput) || Object.keys(startInput).length > 0)) {
          const rawInput = JSON.stringify(startInput);

          const snapshotError = validateApplyPatchSnapshots(
            st.funcInputSnapshot.get(idx) ?? "",
            rawInput,
          );

          if (snapshotError !== undefined && !st.funcInputSnapshotErrors.has(idx)) {
            st.funcInputSnapshotErrors.set(idx, snapshotError);
          }

          // Item completion does not seal the response: compare late snapshots against the finished decoder.
          if (st.funcItemDone.get(idx) === true) {
            const patchCall = st.applyPatchCalls.get(idx);

            if (patchCall !== undefined) {
              const finished = patchCall.finishArguments(rawInput);

              if ("error" in finished)
                return [...out, ...failToolInput(st, finished.error, nextSeq)];
            }
          }

          st.funcInputSnapshot.set(idx, rawInput);
        }

        if (isApplyPatch(st, st.funcNames.get(idx) ?? "")) {
          const snapshotError = st.funcInputSnapshotErrors.get(idx);

          if (snapshotError !== undefined)
            return [...out, ...failToolInput(st, snapshotError, nextSeq)];
        }

        out.push(...emitFuncItem(st, idx, request, false, nextSeq));
        out.push(...emitPendingFuncArgs(st, idx, nextSeq));
      } else if (typ === "server_tool_use") {
        if (str(get(cb, "name")) === CLAUDE_WEB_SEARCH_TOOL_NAME) {
          out.push(startWebSearch(st, idx, str(get(cb, "id")), nextSeq).added);
        }
      } else if (typ === "web_search_tool_result") {
        const toolUseId = str(get(cb, "tool_use_id"));
        const item = st.webSearchByToolId.get(toolUseId);

        if (item !== undefined) {
          item.results = claudeWebSearchResultsToResponses(get(cb, "content"));
        } else if (toolUseId !== "") {
          // A continuation after pause_turn delivers the result of a search whose server_tool_use arrived in the
          // previous response; surface it under the same id so the client keeps the result in its history.
          const started = startWebSearch(st, idx, toolUseId, nextSeq);
          started.item.results = claudeWebSearchResultsToResponses(get(cb, "content"));
          out.push(started.added);
        }
      } else if (typ === "thinking" || typ === "redacted_thinking") {
        st.reasoningActive = true;
        st.reasoningDeltasDone = false;
        st.reasoningIndex = allocateOutputIndex(st);
        st.reasoningBuf = "";
        st.reasoningSignature = reasoningCarrier(cb);
        st.reasoningItemId = `rs_${st.responseId}_${idx}`;
        out.push(
          emit("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: nextSeq(),
            output_index: st.reasoningIndex,
            item: {
              id: st.reasoningItemId,
              type: "reasoning",
              status: "in_progress",
              encrypted_content: st.reasoningSignature,
              summary: [],
            },
          }),
          emit("response.reasoning_summary_part.added", {
            type: "response.reasoning_summary_part.added",
            sequence_number: nextSeq(),
            item_id: st.reasoningItemId,
            output_index: st.reasoningIndex,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          }),
        );
      }

      break;
    }

    case "content_block_delta": {
      const d = get(root, "delta");

      if (!exists(d)) return out;
      const dt = str(get(d, "type"));

      if (dt === "text_delta") {
        const t = get(d, "text");

        if (exists(t)) {
          out.push(
            emit("response.output_text.delta", {
              type: "response.output_text.delta",
              sequence_number: nextSeq(),
              item_id: st.currentMsgId,
              output_index: messageOutputIndex(st),
              content_index: 0,
              delta: str(t),
              logprobs: [],
            }),
          );
          st.textBuf += str(t);
        }
      } else if (dt === "input_json_delta") {
        const idx = asInt(get(root, "index"));
        const item = st.webSearchByBlock.get(idx);
        const pj = get(d, "partial_json");

        if (item !== undefined) {
          if (exists(pj)) item.inputBuf += str(pj);

          return [];
        }

        if (exists(pj)) {
          st.funcArgsBuf.set(idx, (st.funcArgsBuf.get(idx) ?? "") + str(pj));
          out.push(...emitPendingFuncArgs(st, idx, nextSeq));
        }
      } else if (dt === "thinking_delta") {
        if (st.reasoningActive) {
          const t = get(d, "thinking");

          if (exists(t)) {
            st.reasoningBuf += str(t);
            out.push(
              emit("response.reasoning_summary_text.delta", {
                type: "response.reasoning_summary_text.delta",
                sequence_number: nextSeq(),
                item_id: st.reasoningItemId,
                output_index: st.reasoningIndex,
                summary_index: 0,
                delta: str(t),
              }),
            );
          }
        }
      } else if (dt === "signature_delta") {
        if (st.reasoningActive) {
          const signature = get(d, "signature");

          if (exists(signature) && str(signature) !== "") st.reasoningSignature = str(signature);
        }

        return [];
      } else if (dt === "citations_delta") {
        const citation = get(d, "citation");

        if (exists(citation) && citation !== null) st.messageAnnotations.push(citation);

        return [];
      }

      break;
    }

    case "content_block_stop":
      st.funcBlockStopped.set(asInt(get(root, "index")), true);

      if (st.inTextBlock) st.inTextBlock = false;
      else if (st.inFuncBlock) st.inFuncBlock = false;
      else if (st.reasoningActive) out.push(...finalizeReasoningDeltas(st, nextSeq));

      return out;
    case "message_delta": {
      mergeUsage(st.usage, get(root, "usage"));
      const stopReason = get(root, "delta.stop_reason");

      if (exists(stopReason)) st.stopReason = str(stopReason);

      return [];
    }

    case "message_stop": {
      const toolStatus = outputStatus(st.stopReason);

      if (st.reasoningActive || st.reasoningItemId !== "")
        out.push(...finalizeReasoningItem(st, toolStatus, nextSeq));
      out.push(...finalizeAssistantMessage(st, nextSeq));

      for (const idx of st.funcCallIds.keys()) {
        if (st.funcItemDone.get(idx) !== true) {
          out.push(...finalizeFuncItem(st, idx, request, toolStatus, nextSeq));

          if (st.toolInputError !== undefined) return out;
        }
      }

      for (const item of st.webSearchItems) {
        if (!item.emitted)
          out.push(
            ...finalizeWebSearch(
              st,
              item,
              webSearchStatus(st.stopReason, toolStatus, item.results !== undefined),
              nextSeq,
            ),
          );
      }

      const { eventType, status: responseStatus, details } = terminalState(st.stopReason);

      const response: JsonObject = {
        id: st.responseId,
        object: "response",
        created_at: st.createdAt,
        status: responseStatus,
        background: false,
        error: null,
      };

      const completed: JsonObject = { type: eventType, sequence_number: nextSeq(), response };

      if (details !== undefined) response.incomplete_details = details.details;

      if (isPauseTurn(st.stopReason)) response.end_turn = false;
      echoRequestFields(response, request);

      const output: Json[] = [];

      for (const reasoning of st.reasoningItems) {
        output[reasoning.outputIndex] = {
          id: reasoning.id,
          type: "reasoning",
          status: reasoning.status === "" ? "completed" : reasoning.status,
          encrypted_content: reasoning.signature,
          summary: [{ type: "summary_text", text: reasoning.text }],
        };
      }

      for (const message of st.messageItems) {
        output[message.outputIndex] = {
          id: message.id,
          type: "message",
          status: message.status,
          content: [
            {
              type: "output_text",
              annotations: message.annotations,
              logprobs: [],
              text: message.text,
            },
          ],
          role: "assistant",
        };
      }

      for (const item of st.webSearchItems) {
        const rendered = renderWebSearch(item);
        rendered.status = item.status === "" ? "completed" : item.status;
        output[item.outputIndex] = rendered;
      }

      for (const idx of [...st.funcArgsBuf.keys()].toSorted((a, b) => a - b)) {
        const funcStatus = st.funcItemStatus.get(idx) || "completed";
        const custom = st.funcCustom.get(idx) === true;
        let args = !custom && funcStatus === "completed" ? "{}" : "";
        const buf = st.funcArgsBuf.get(idx) ?? "";

        if (buf.length > 0) args = buf;
        let callId = st.funcCallIds.get(idx) ?? "";
        const name = st.funcNames.get(idx) ?? "";

        if (callId === "" && st.currentFcId !== "") callId = st.currentFcId;
        let item: JsonObject;

        if (custom) {
          const patchCall = st.applyPatchCalls.get(idx);
          item = {
            id: `ctc_${callId}`,
            type: "custom_tool_call",
            status: funcStatus,
            input:
              patchCall !== undefined ? patchCall.decoder.input() : unwrapCustomToolInput(args),
            call_id: callId,
            name: "",
          };
        } else {
          item = {
            id: `fc_${callId}`,
            type: "function_call",
            status: funcStatus,
            arguments: args,
            call_id: callId,
            name: "",
          };
        }

        applyNamespaceFields(item, request, name);
        output[st.funcOutputIndices.get(idx) ?? 0] = item;
      }

      if (output.length > 0) response.output = output;

      const reasoningLength = st.reasoningItems.reduce(
        (sum, reasoning) => sum + utf8Length(reasoning.text),
        0,
      );

      const reasoningTokens = Math.trunc(reasoningLength / 4);

      if (st.usage.hasUsage || reasoningTokens > 0) {
        const { inputTokens, outputTokens, totalTokens, cachedTokens } = responsesUsage(st.usage);

        const usage: JsonObject = {
          input_tokens: inputTokens,
          input_tokens_details: { cached_tokens: cachedTokens },
          output_tokens: outputTokens,
          output_tokens_details: { reasoning_tokens: reasoningTokens },
        };

        if (totalTokens > 0 || st.usage.hasUsage) usage.total_tokens = totalTokens;
        response.usage = usage;
      }

      st.completedEmitted = true;
      out.push(emit(eventType, completed));
      break;
    }
  }

  return out;
};

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

interface OutputItem {
  outputIndex: number;
  itemType: string;
  id: string;
  callId: string;
  name: string;
  text: string;
  signature: string;
  annotations: Json[];
  args: string;
  inputSnapshot: string;
  results: Json | undefined;
}

/** `ConvertClaudeResponseToOpenAIResponsesNonStream`. */
export const convertClaudeResponseToOpenAIResponsesNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const [raw, nativeModel] = claudeMessagesJSONToSSE(body);
  const chunks: string[] = [];

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r+$/u, "");

    if (line.startsWith("data:")) chunks.push(line.slice(5));
  }

  const reqJson = pickRequest(context.originalRequest, context.translatedRequest);
  const st = newState(reqJson);
  context.state.value = st;

  /** A retained `apply_patch` failure: the failed response body, and the caller sees a translation failure. */
  const failNonStream = (error: string): string => {
    st.toolInputError = error;
    context.state.toolInputError = error;

    return JSON.stringify(get(applyPatchFailure(responseId, 0), "response"));
  };

  const out: JsonObject = {
    id: "",
    object: "response",
    created_at: 0,
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    output: [],
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: {},
      total_tokens: 0,
    },
  };

  let responseId = "";
  let createdAt = 0;
  let stopReason = "";
  const usageTokens = newUsage();
  const blockToItem = new Map<number, OutputItem>();
  const webSearchByToolId = new Map<string, OutputItem>();
  const outputItems: OutputItem[] = [];
  let nextOutputIndex = 0;
  let messageCount = 0;
  let activeMessageItem: OutputItem | undefined;
  let pendingAnnotations: Json[] = [];

  const newOutputItem = (itemType: string, blockIndex: number): OutputItem => {
    const item: OutputItem = {
      outputIndex: nextOutputIndex++,
      itemType,
      id: "",
      callId: "",
      name: "",
      text: "",
      signature: "",
      annotations: [],
      args: "",
      inputSnapshot: "",
      results: undefined,
    };

    outputItems.push(item);
    blockToItem.set(blockIndex, item);

    return item;
  };

  for (const ch of chunks) {
    const root = tryParseJson(ch.trim());
    const ev = str(get(root, "type"));

    if (ev === "message_stop") break;

    switch (ev) {
      case "message_start": {
        const msg = get(root, "message");

        if (exists(msg)) {
          responseId = str(get(msg, "id"));
          createdAt = Math.floor(Date.now() / 1000);
          mergeUsage(usageTokens, get(msg, "usage"));
        }

        break;
      }

      case "content_block_start": {
        const cb = get(root, "content_block");

        if (!exists(cb)) break;
        const idx = asInt(get(root, "index"));
        const typ = str(get(cb, "type"));

        if (typ !== "text") activeMessageItem = undefined;

        switch (typ) {
          case "text": {
            let item = activeMessageItem;

            if (item === undefined) {
              item = newOutputItem("message", idx);
              item.id = `msg_${responseId}_${messageCount}`;
              messageCount++;
            } else {
              blockToItem.set(idx, item);
            }

            if (pendingAnnotations.length > 0) {
              item.annotations.push(...pendingAnnotations);
              pendingAnnotations = [];
            }

            activeMessageItem = item;
            break;
          }

          case "tool_use": {
            let itemType = "function_call";
            const toolName = str(get(cb, "name"));

            if (st.toolWinners.get(st.toolNames.identity(toolName))?.toolType === "custom")
              itemType = "custom_tool_call";
            let item = blockToItem.get(idx);

            if (item === undefined) item = newOutputItem(itemType, idx);
            const callId = str(get(cb, "id"));

            if (callId !== "" && item.callId !== "" && callId !== item.callId)
              st.funcIdentityConflicts.set(idx, true);

            if (isApplyPatch(st, item.name) || isApplyPatch(st, toolName)) {
              if (
                st.funcIdentityConflicts.get(idx) === true ||
                (toolName !== "" &&
                  item.name !== "" &&
                  st.toolNames.identity(toolName) !== st.toolNames.identity(item.name))
              ) {
                return failNonStream(CONFLICTING_IDENTITY);
              }
            }

            if (toolName !== "") {
              item.name = toolName;
              item.itemType = itemType;
            }

            if (callId !== "") item.callId = callId;
            const startInput = get(cb, "input");

            if (exists(startInput) && (!isObj(startInput) || Object.keys(startInput).length > 0)) {
              const rawInput = JSON.stringify(startInput);
              const snapshotError = validateApplyPatchSnapshots(item.inputSnapshot, rawInput);

              if (snapshotError !== undefined && !st.funcInputSnapshotErrors.has(idx)) {
                st.funcInputSnapshotErrors.set(idx, snapshotError);
              }

              item.inputSnapshot = rawInput;
            }

            if (isApplyPatch(st, item.name)) {
              const snapshotError = st.funcInputSnapshotErrors.get(idx);

              if (snapshotError !== undefined) return failNonStream(snapshotError);
            }

            item.id =
              item.itemType === "custom_tool_call" ? `ctc_${item.callId}` : `fc_${item.callId}`;
            break;
          }

          case "server_tool_use": {
            if (str(get(cb, "name")) !== CLAUDE_WEB_SEARCH_TOOL_NAME) break;
            const toolUseId = str(get(cb, "id"));
            const item = newOutputItem("web_search_call", idx);
            item.id = responsesWebSearchCallID(toolUseId);
            item.callId = toolUseId;
            webSearchByToolId.set(toolUseId, item);
            const input = get(cb, "input");

            if (isObj(input) && claudeWebSearchQuery(JSON.stringify(input)) !== "")
              item.args += JSON.stringify(input);
            break;
          }

          case "web_search_tool_result": {
            const toolUseId = str(get(cb, "tool_use_id"));
            const item = webSearchByToolId.get(toolUseId);

            if (item !== undefined) {
              item.results = claudeWebSearchResultsToResponses(get(cb, "content"));
            } else if (toolUseId !== "") {
              // Continuation after pause_turn: the search started in the previous response; keep its result under
              // the same id.
              const continued = newOutputItem("web_search_call", idx);
              continued.id = responsesWebSearchCallID(toolUseId);
              continued.callId = toolUseId;
              continued.results = claudeWebSearchResultsToResponses(get(cb, "content"));
              webSearchByToolId.set(toolUseId, continued);
            }

            break;
          }

          case "thinking":
          case "redacted_thinking": {
            const item = newOutputItem("reasoning", idx);
            item.id = `rs_${responseId}_${idx}`;
            item.signature = reasoningCarrier(cb);
            break;
          }
        }

        break;
      }

      case "content_block_delta": {
        const d = get(root, "delta");

        if (!exists(d)) break;
        const item = blockToItem.get(asInt(get(root, "index")));

        switch (str(get(d, "type"))) {
          case "text_delta":
            if (item !== undefined && item.itemType === "message") {
              const t = get(d, "text");

              if (exists(t)) item.text += str(t);
            }

            break;
          case "input_json_delta":
            if (
              item !== undefined &&
              (item.itemType === "function_call" ||
                item.itemType === "custom_tool_call" ||
                item.itemType === "web_search_call")
            ) {
              const pj = get(d, "partial_json");

              if (exists(pj)) item.args += str(pj);
            }

            break;
          case "thinking_delta":
            if (item !== undefined && item.itemType === "reasoning") {
              const t = get(d, "thinking");

              if (exists(t)) item.text += str(t);
            }

            break;
          case "signature_delta":
            if (item !== undefined && item.itemType === "reasoning") {
              const signature = get(d, "signature");

              if (exists(signature) && str(signature) !== "") item.signature = str(signature);
            }

            break;
          case "citations_delta": {
            const citation = get(d, "citation");

            if (exists(citation) && citation !== null) {
              if (item !== undefined && item.itemType === "message")
                item.annotations.push(citation);
              else if (activeMessageItem !== undefined)
                activeMessageItem.annotations.push(citation);
              else pendingAnnotations.push(citation);
            }

            break;
          }
        }

        break;
      }

      case "message_delta": {
        mergeUsage(usageTokens, get(root, "usage"));
        const value = get(root, "delta.stop_reason");

        if (exists(value)) stopReason = str(value);
        break;
      }
    }
  }

  const { status: responseStatus, details } = terminalState(stopReason);
  out.id = responseId;
  out.created_at = createdAt;
  out.status = responseStatus;

  if (details !== undefined) out.incomplete_details = details.details;

  if (isPauseTurn(stopReason)) out.end_turn = false;
  echoRequestFields(out, reqJson);

  if (nativeModel !== "") out.model = nativeModel;

  const outputs: JsonObject[] = [];
  let failure: string | undefined;
  outputItems.forEach((outputItem, i) => {
    if (failure !== undefined) return;

    const itemStatus =
      responseStatus === "incomplete" && i === outputItems.length - 1 ? "incomplete" : "completed";

    let item: JsonObject | undefined;

    switch (outputItem.itemType) {
      case "reasoning":
        item = {
          id: outputItem.id,
          type: "reasoning",
          status: itemStatus,
          encrypted_content: outputItem.signature,
          summary: [{ type: "summary_text", text: outputItem.text }],
        };
        break;
      case "web_search_call":
        item = buildResponsesWebSearchCallItem(
          outputItem.callId,
          claudeWebSearchQuery(outputItem.args),
          outputItem.results,
        );
        item.status = webSearchStatus(stopReason, itemStatus, outputItem.results !== undefined);
        break;
      case "message":
        item = {
          id: outputItem.id,
          type: "message",
          status: itemStatus,
          content: [
            {
              type: "output_text",
              annotations: outputItem.annotations,
              logprobs: [],
              text: outputItem.text,
            },
          ],
          role: "assistant",
        };
        break;
      case "custom_tool_call": {
        let input: string;

        if (isApplyPatch(st, outputItem.name)) {
          const patchCall = new ApplyPatchCallState("", "", "", "", 0);
          const pushed = patchCall.pushArguments(outputItem.args);

          if ("error" in pushed) {
            failure = failNonStream(pushed.error);

            return;
          }

          const finished = finishClaudeApplyPatchArguments(
            patchCall,
            outputItem.args,
            outputItem.inputSnapshot,
          );

          if ("error" in finished) {
            failure = failNonStream(finished.error);

            return;
          }

          input = finished.input;
        } else {
          input = unwrapCustomToolInput(outputItem.args);
        }

        item = {
          id: outputItem.id,
          type: "custom_tool_call",
          status: itemStatus,
          input,
          call_id: outputItem.callId,
          name: "",
        };
        applyNamespaceFields(item, reqJson, outputItem.name);
        break;
      }

      case "function_call": {
        let args = outputItem.args;

        if (args === "" && itemStatus === "completed") args = "{}";
        item = {
          id: outputItem.id,
          type: "function_call",
          status: itemStatus,
          arguments: args,
          call_id: outputItem.callId,
          name: "",
        };
        applyNamespaceFields(item, reqJson, outputItem.name);
        break;
      }
    }

    if (item !== undefined) outputs.push(item);
  });

  if (failure !== undefined) return failure;

  if (outputs.length > 0) out.output = outputs;

  const { inputTokens, outputTokens, totalTokens, cachedTokens } = responsesUsage(usageTokens);
  // SAFETY: `out` was built with usage and its *_details objects by the response template above.
  const usage = out.usage as JsonObject;

  if (inputTokens !== 0) usage.input_tokens = inputTokens;

  if (cachedTokens !== 0)
    // SAFETY: `out` was built with usage and its *_details objects by the response template above.
    (usage.input_tokens_details as JsonObject).cached_tokens = cachedTokens;

  if (outputTokens !== 0) usage.output_tokens = outputTokens;

  if (totalTokens !== 0) usage.total_tokens = totalTokens;

  const reasoningLength = outputItems
    .filter((item) => item.itemType === "reasoning")
    .reduce((sum, item) => sum + utf8Length(item.text), 0);

  if (reasoningLength > 0) {
    const reasoningTokens = Math.trunc(reasoningLength / 4);

    if (reasoningTokens > 0)
      // SAFETY: `out` was built with usage and its *_details objects by the response template above.
      (usage.output_tokens_details as JsonObject).reasoning_tokens = reasoningTokens;
  }

  return JSON.stringify(out);
};

export const claudeToOpenAIResponsesResponse: ResponseTransform = {
  stream: convertClaudeResponseToOpenAIResponses,
  nonStream: convertClaudeResponseToOpenAIResponsesNonStream,
};
