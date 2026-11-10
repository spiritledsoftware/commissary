/**
 * OpenAI Chat Completions provider -> OpenAI Responses client (response).
 *
 * Go source: internal/translator/openai/openai/responses/openai_openai-responses_response.go.
 *
 * `time.Now()` fallbacks (synthesized response ids / `created_at`) are kept; the fixtures always carry both.
 */
import {
  asBool,
  asFloat,
  asInt,
  get,
  type Json,
  type JsonObject,
  isValidJson,
} from "@commissary/json";
import { sseEvent } from "../../../../sse.ts";
import type { ResponseContext, ResponseTransform, TranslationState } from "../../../registry.ts";
import {
  ApplyPatchCallState,
  applyPatchInputDelta,
  applyPatchInputDone,
} from "../../../common/apply-patch.ts";
import { getStr, isArr, str } from "../../common/read.ts";
import { requestModelNameOf } from "../../../common/request.ts";
import { responsesToolInputFailure, shellCallItem, shellCallPlaceholder } from "./shell.ts";
import { buildToolSearchCallItem } from "../../../common/responses-tools.ts";
import { pickRequestJson, ResponsesToolIndex, unwrapCustomToolInput } from "./tools.ts";

interface ReasoningRecord {
  readonly reasoningId: string;
  readonly reasoningData: string;
  readonly outputIndex: number;
}

/** Port of `oaiToResponsesState`. */
interface ChatToResponsesState {
  toolInputError: string | undefined;
  applyPatchCalls: Map<string, ApplyPatchCallState>;
  requestJson: Json | undefined;
  toolIndex: ResponsesToolIndex;
  requestInitialized: boolean;
  seq: number;
  responseId: string;
  created: number;
  started: boolean;
  completedEmitted: boolean;
  completionPending: boolean;
  reasoningId: string;
  reasoningIndex: number;
  msgTextBuf: Map<number, string>;
  reasoningBuf: string;
  reasonings: ReasoningRecord[];
  funcArgsBuf: Map<string, string>;
  funcNames: Map<string, string>;
  funcCallIds: Map<string, string>;
  funcIdentityConflicts: Map<string, boolean>;
  funcOutputIx: Map<string, number>;
  funcArgsSent: Map<string, number>;
  msgOutputIx: Map<number, number>;
  nextOutputIx: number;
  msgItemAdded: Map<number, boolean>;
  msgContentAdded: Map<number, boolean>;
  msgItemDone: Map<number, boolean>;
  funcItemAdded: Map<string, boolean>;
  funcItemCustom: Map<string, boolean>;
  funcArgsDone: Map<string, boolean>;
  funcItemDone: Map<string, boolean>;
  /** Freeform ("custom") tool names of the request: calls to them become custom_tool_call items. */
  customToolNames: Set<string>;
  finishReason: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  usageSeen: boolean;
}

const newState = (): ChatToResponsesState => ({
  toolInputError: undefined,
  applyPatchCalls: new Map(),
  requestJson: undefined,
  toolIndex: new ResponsesToolIndex(undefined),
  requestInitialized: false,
  seq: 0,
  responseId: "",
  created: 0,
  started: false,
  completedEmitted: false,
  completionPending: false,
  reasoningId: "",
  reasoningIndex: 0,
  msgTextBuf: new Map(),
  reasoningBuf: "",
  reasonings: [],
  funcArgsBuf: new Map(),
  funcNames: new Map(),
  funcCallIds: new Map(),
  funcIdentityConflicts: new Map(),
  funcOutputIx: new Map(),
  funcArgsSent: new Map(),
  msgOutputIx: new Map(),
  nextOutputIx: 0,
  msgItemAdded: new Map(),
  msgContentAdded: new Map(),
  msgItemDone: new Map(),
  funcItemAdded: new Map(),
  funcItemCustom: new Map(),
  funcArgsDone: new Map(),
  funcItemDone: new Map(),
  customToolNames: new Set(),
  finishReason: "",
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  usageSeen: false,
});

let responseIdCounter = 0;

const emit = (event: string, payload: Json): string => sseEvent(event, JSON.stringify(payload));

const incompleteByFinishReason = (reason: string): JsonObject | undefined => {
  switch (reason) {
    case "length":
    case "max_tokens":
      return { reason: "max_output_tokens" };
    case "content_filter":
      return { reason: "content_filter" };
    default:
      return undefined;
  }
};

/** Request fields echoed into the terminal response (same list and order for stream and non-stream). */
const echoRequestFields = (target: JsonObject, req: Json | undefined, nonStream: boolean): void => {
  const v = (path: string): Json | undefined => get(req, path);
  const instructions = v("instructions");

  if (instructions !== undefined) target.instructions = str(instructions);
  const maxOutputTokens = v("max_output_tokens");

  if (maxOutputTokens !== undefined) target.max_output_tokens = asInt(maxOutputTokens);
  else if (nonStream) {
    // Also support max_tokens from chat completion style.
    const maxTokens = v("max_tokens");

    if (maxTokens !== undefined) target.max_output_tokens = asInt(maxTokens);
  }

  const maxToolCalls = v("max_tool_calls");

  if (maxToolCalls !== undefined) target.max_tool_calls = asInt(maxToolCalls);
  const model = v("model");

  if (model !== undefined) target.model = str(model);
  const parallel = v("parallel_tool_calls");

  if (parallel !== undefined) target.parallel_tool_calls = asBool(parallel);
  const previous = v("previous_response_id");

  if (previous !== undefined) target.previous_response_id = str(previous);
  const cacheKey = v("prompt_cache_key");

  if (cacheKey !== undefined) target.prompt_cache_key = str(cacheKey);
  const reasoning = v("reasoning");

  if (reasoning !== undefined) target.reasoning = reasoning;
  const safety = v("safety_identifier");

  if (safety !== undefined) target.safety_identifier = str(safety);
  const tier = v("service_tier");

  if (tier !== undefined) target.service_tier = str(tier);
  const store = v("store");

  if (store !== undefined) target.store = asBool(store);
  const temperature = v("temperature");

  if (temperature !== undefined) target.temperature = asFloat(temperature);
  const text = v("text");

  if (text !== undefined) target.text = text;
  const toolChoice = v("tool_choice");

  if (toolChoice !== undefined) target.tool_choice = toolChoice;
  const tools = v("tools");

  if (tools !== undefined) target.tools = tools;
  const topLogprobs = v("top_logprobs");

  if (topLogprobs !== undefined) target.top_logprobs = asInt(topLogprobs);
  const topP = v("top_p");

  if (topP !== undefined) target.top_p = asFloat(topP);
  const truncation = v("truncation");

  if (truncation !== undefined) target.truncation = str(truncation);
  const user = v("user");

  if (user !== undefined) target.user = user;
  const metadata = v("metadata");

  if (metadata !== undefined) target.metadata = metadata;
};

/** `buildResponsesCompletedEvent`. */
const buildResponsesCompletedEvent = (st: ChatToResponsesState, nextSeq: () => number): string => {
  let eventType = "response.completed";
  let status = "completed";
  const incompleteDetails = incompleteByFinishReason(st.finishReason);

  if (incompleteDetails !== undefined) {
    eventType = "response.incomplete";
    status = "incomplete";
  }

  const response: JsonObject = {
    id: st.responseId,
    object: "response",
    created_at: st.created,
    status,
    background: false,
    error: null,
  };

  const completed: JsonObject = { type: eventType, sequence_number: nextSeq(), response };

  if (incompleteDetails !== undefined) response.incomplete_details = incompleteDetails;

  if (st.requestJson !== undefined) echoRequestFields(response, st.requestJson, false);

  const outputItems: Array<{ index: number; item: Json }> = [];

  for (const r of st.reasonings) {
    outputItems.push({
      index: r.outputIndex,
      item: {
        id: r.reasoningId,
        type: "reasoning",
        summary: [{ type: "summary_text", text: r.reasoningData }],
      },
    });
  }

  for (const i of st.msgItemAdded.keys()) {
    const msgStatus =
      incompleteByFinishReason(st.finishReason) !== undefined ? "incomplete" : "completed";

    outputItems.push({
      index: st.msgOutputIx.get(i) ?? 0,
      item: {
        id: `msg_${st.responseId}_${i}`,
        type: "message",
        status: msgStatus,
        content: [
          { type: "output_text", annotations: [], logprobs: [], text: st.msgTextBuf.get(i) ?? "" },
        ],
        role: "assistant",
      },
    });
  }

  for (const key of st.funcArgsBuf.keys()) {
    if (st.funcItemDone.get(key) !== true) continue;
    const args = st.funcArgsBuf.get(key) ?? "";
    const callId = st.funcCallIds.get(key) ?? "";
    const name = st.funcNames.get(key) ?? "";

    const toolStatus =
      incompleteByFinishReason(st.finishReason) !== undefined ? "incomplete" : "completed";

    const index = st.funcOutputIx.get(key) ?? 0;

    if (st.toolIndex.isShell(name)) {
      const shell = shellCallItem(callId, args, toolStatus);

      if ("item" in shell) outputItems.push({ index, item: shell.item });
      continue;
    }

    if (st.toolIndex.isToolSearch(name)) {
      outputItems.push({ index, item: buildToolSearchCallItem(callId, toolStatus, args) });
      continue;
    }

    if (st.funcItemCustom.get(key) === true) {
      const patchCall = st.applyPatchCalls.get(key);

      const input =
        patchCall !== undefined ? patchCall.decoder.input() : unwrapCustomToolInput(args);

      const item: JsonObject = {
        id: `ctc_${callId}`,
        type: "custom_tool_call",
        status: toolStatus,
        input,
        call_id: callId,
        name: "",
      };

      st.toolIndex.applyIdentity(item, name, "");
      outputItems.push({ index, item });
      continue;
    }

    const item: JsonObject = {
      id: `fc_${callId}`,
      type: "function_call",
      status: toolStatus,
      arguments: args,
      call_id: callId,
      name: "",
    };

    st.toolIndex.applyIdentity(item, name, "");
    outputItems.push({ index, item });
  }

  outputItems.sort((a, b) => a.index - b.index);

  if (outputItems.length > 0) response.output = outputItems.map((o) => o.item);

  if (st.usageSeen) {
    const usage: JsonObject = {
      input_tokens: st.promptTokens,
      input_tokens_details: { cached_tokens: st.cachedTokens },
      output_tokens: st.completionTokens,
    };

    if (st.reasoningTokens > 0)
      usage.output_tokens_details = { reasoning_tokens: st.reasoningTokens };
    usage.total_tokens =
      st.totalTokens === 0 ? st.promptTokens + st.completionTokens : st.totalTokens;
    response.usage = usage;
  }

  return emit(eventType, completed);
};

const canFinalizeResponse = (st: ChatToResponsesState): boolean => {
  if (
    st.toolInputError !== undefined ||
    st.finishReason === "" ||
    (st.msgItemAdded.size === 0 && st.funcItemAdded.size === 0)
  ) {
    return false;
  }

  for (const idx of st.msgItemAdded.keys()) if (st.msgItemDone.get(idx) !== true) return false;

  for (const key of st.funcItemAdded.keys()) if (st.funcItemDone.get(key) !== true) return false;

  return st.reasoningId === "";
};

/** Mirrors the Go `ToolInputError()` / `CanFinalizeResponseStream()` hooks into the registry state. */
const syncState = (state: TranslationState, st: ChatToResponsesState): void => {
  if (st.toolInputError !== undefined) state.toolInputError = st.toolInputError;
  else delete state.toolInputError;
  state.canFinalize =
    st.toolInputError === undefined && !st.completedEmitted && st.completionPending;
};

const parseJson = (text: string): Json | undefined => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** `ConvertOpenAIChatCompletionsResponseToOpenAIResponses`: one upstream line -> Responses SSE events. */
export const convertOpenAIChatCompletionsResponseToOpenAIResponses = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  if (context.state.value === undefined) context.state.value = newState();
  // SAFETY: this translator is the only writer of `state.value` and initialises it to a ChatToResponsesState before this read.
  const st = context.state.value as ChatToResponsesState;
  const out: string[] = [];

  try {
    return processChunk(context, st, line, out);
  } finally {
    syncState(context.state, st);
  }
};

const processChunk = (
  context: ResponseContext,
  st: ChatToResponsesState,
  line: string,
  out: string[],
): ReadonlyArray<string> => {
  if (st.toolInputError !== undefined || st.completedEmitted) return [];

  let rawText = line;

  if (rawText.startsWith("data:")) rawText = rawText.slice(5).trim();
  rawText = rawText.trim();

  if (!st.requestInitialized) {
    st.requestJson = pickRequestJson(context.originalRequest, context.translatedRequest);
    st.toolIndex = new ResponsesToolIndex(st.requestJson);
    st.requestInitialized = true;
  }

  if (rawText === "") return [];
  const isDone = rawText === "[DONE]";

  if (isDone && (!st.started || st.completedEmitted)) return [];

  const root: Json = isDone ? {} : (parseJson(rawText) ?? {});

  if (!isDone) {
    const obj = get(root, "object");

    if (obj !== undefined && str(obj) !== "" && str(obj) !== "chat.completion.chunk") return [];

    if (!isArr(get(root, "choices"))) return [];
  }

  const usage = get(root, "usage");

  if (usage !== undefined) {
    const prompt = get(usage, "prompt_tokens");

    if (prompt !== undefined) {
      st.promptTokens = asInt(prompt);
      st.usageSeen = true;
    }

    const cached = get(usage, "prompt_tokens_details.cached_tokens");

    if (cached !== undefined) {
      st.cachedTokens = asInt(cached);
      st.usageSeen = true;
    }

    const completion = get(usage, "completion_tokens");
    const outputTokens = get(usage, "output_tokens");

    if (completion !== undefined) {
      st.completionTokens = asInt(completion);
      st.usageSeen = true;
    } else if (outputTokens !== undefined) {
      st.completionTokens = asInt(outputTokens);
      st.usageSeen = true;
    }

    const reasoningA = get(usage, "output_tokens_details.reasoning_tokens");
    const reasoningB = get(usage, "completion_tokens_details.reasoning_tokens");

    if (reasoningA !== undefined) {
      st.reasoningTokens = asInt(reasoningA);
      st.usageSeen = true;
    } else if (reasoningB !== undefined) {
      st.reasoningTokens = asInt(reasoningB);
      st.usageSeen = true;
    }

    const total = get(usage, "total_tokens");

    if (total !== undefined) {
      st.totalTokens = asInt(total);
      st.usageSeen = true;
    }
  }

  const nextSeq = (): number => {
    st.seq++;

    return st.seq;
  };

  const allocOutputIndex = (): number => {
    const ix = st.nextOutputIx;
    st.nextOutputIx++;

    return ix;
  };

  const toolStateKey = (outputIndex: number, toolIndex: number): string =>
    `${outputIndex}:${toolIndex}`;

  const failToolInput = (error: string): void => {
    if (st.toolInputError === undefined) {
      st.toolInputError = error;
      out.push(emit("response.failed", responsesToolInputFailure(st.responseId, nextSeq(), error)));
    }
  };

  const emitToolItem = (key: string, force: boolean): void => {
    if (st.funcItemAdded.get(key) === true) return;
    let callId = st.funcCallIds.get(key) ?? "";
    let name = st.toolIndex.canonicalName(st.funcNames.get(key) ?? "");
    st.funcNames.set(key, name);

    if (!force && (callId === "" || name === "")) return;

    if (name === "") {
      const single = st.toolIndex.singleCustomName();

      if (single?.only === true) {
        name = single.name;
        st.funcNames.set(key, single.name);
      }
    }

    if (st.toolIndex.isApplyPatch(name) && st.funcIdentityConflicts.get(key) === true) {
      failToolInput("conflicting apply_patch call identity");

      return;
    }

    if (callId === "") {
      callId = `call_${st.responseId}_${key.replaceAll(":", "_")}`;
      st.funcCallIds.set(key, callId);
    }

    const outputIndex = st.funcOutputIx.get(key) ?? 0;
    const isCustomTool = st.customToolNames.has(name);
    st.funcItemCustom.set(key, isCustomTool);

    if (st.toolIndex.isShell(name)) {
      out.push(
        emit("response.output_item.added", {
          type: "response.output_item.added",
          sequence_number: nextSeq(),
          output_index: outputIndex,
          item: shellCallPlaceholder(callId),
        }),
      );
    } else if (st.toolIndex.isToolSearch(name)) {
      out.push(
        emit("response.output_item.added", {
          type: "response.output_item.added",
          sequence_number: nextSeq(),
          output_index: outputIndex,
          item: buildToolSearchCallItem(callId, "in_progress", ""),
        }),
      );
    } else if (isCustomTool) {
      if (st.toolIndex.isApplyPatch(name)) {
        const d = st.toolIndex.byChat.get(name);
        st.applyPatchCalls.set(
          key,
          new ApplyPatchCallState(
            `ctc_${callId}`,
            callId,
            d?.localName ?? "",
            d?.namespace ?? "",
            outputIndex,
          ),
        );
      }

      const o: JsonObject = {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: outputIndex,
        item: {
          id: `ctc_${callId}`,
          type: "custom_tool_call",
          status: "in_progress",
          input: "",
          call_id: callId,
          name: "",
        },
      };

      st.toolIndex.applyIdentity(o, name, "item");
      out.push(emit("response.output_item.added", o));
    } else {
      const o: JsonObject = {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: outputIndex,
        item: {
          id: `fc_${callId}`,
          type: "function_call",
          status: "in_progress",
          arguments: "",
          call_id: callId,
          name: "",
        },
      };

      st.toolIndex.applyIdentity(o, name, "item");
      out.push(emit("response.output_item.added", o));
    }

    st.funcItemAdded.set(key, true);
  };

  const emitPendingFunctionArgs = (key: string): void => {
    if (
      st.funcItemAdded.get(key) !== true ||
      st.toolInputError !== undefined ||
      st.toolIndex.isShell(st.funcNames.get(key) ?? "") ||
      st.toolIndex.isToolSearch(st.funcNames.get(key) ?? "")
    ) {
      return;
    }

    const args = st.funcArgsBuf.get(key);
    const sent = st.funcArgsSent.get(key) ?? 0;

    if (args === undefined || args.length <= sent) return;
    const delta = args.slice(sent);

    if (st.funcItemCustom.get(key) === true) {
      const patchCall = st.applyPatchCalls.get(key);

      if (patchCall !== undefined) {
        const pushed = patchCall.pushArguments(delta);

        if ("error" in pushed) failToolInput(pushed.error);
        else if (pushed.text !== "") {
          out.push(
            emit(
              "response.custom_tool_call_input.delta",
              applyPatchInputDelta(patchCall, pushed.text, nextSeq()),
            ),
          );
        }

        st.funcArgsSent.set(key, args.length);
      }

      return;
    }

    const callId = st.funcCallIds.get(key) ?? "";
    out.push(
      emit("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        sequence_number: nextSeq(),
        item_id: `fc_${callId}`,
        output_index: st.funcOutputIx.get(key) ?? 0,
        delta,
      }),
    );
    st.funcArgsSent.set(key, args.length);
  };

  if (!st.started) {
    st.responseId = getStr(root, "id");
    st.created = asInt(get(root, "created"));
    // Reset aggregation state for a new streaming response.
    st.msgTextBuf = new Map();
    st.reasoningBuf = "";
    st.reasoningId = "";
    st.reasoningIndex = 0;
    st.applyPatchCalls = new Map();
    st.funcArgsBuf = new Map();
    st.funcNames = new Map();
    st.funcCallIds = new Map();
    st.funcIdentityConflicts = new Map();
    st.funcOutputIx = new Map();
    st.funcArgsSent = new Map();
    st.msgOutputIx = new Map();
    st.nextOutputIx = 0;
    st.msgItemAdded = new Map();
    st.msgContentAdded = new Map();
    st.msgItemDone = new Map();
    st.funcItemAdded = new Map();
    st.funcItemCustom = new Map();
    st.funcArgsDone = new Map();
    st.funcItemDone = new Map();
    st.customToolNames = st.toolIndex.custom;
    st.promptTokens = 0;
    st.cachedTokens = 0;
    st.completionTokens = 0;
    st.totalTokens = 0;
    st.reasoningTokens = 0;
    st.finishReason = "";
    st.usageSeen = false;
    st.completedEmitted = false;
    st.completionPending = false;

    const created: JsonObject = {
      type: "response.created",
      sequence_number: nextSeq(),
      response: {
        id: st.responseId,
        object: "response",
        created_at: st.created,
        status: "in_progress",
        background: false,
        error: null,
        output: [],
      },
    };

    let modelName = requestModelNameOf(context.originalRequest, context.translatedRequest);

    if (modelName === "") modelName = context.model;

    if (modelName !== "") {
      // SAFETY: `created.response` is the object literal assigned when `created` was built above.
      (created.response as JsonObject).model = modelName;
    }

    out.push(emit("response.created", created));

    const inprog: JsonObject = {
      type: "response.in_progress",
      sequence_number: nextSeq(),
      response: {
        id: st.responseId,
        object: "response",
        created_at: st.created,
        status: "in_progress",
        output: [],
      },
    };

    if (modelName !== "") {
      // SAFETY: `inprog.response` is the object literal assigned when `inprog` was built above.
      (inprog.response as JsonObject).model = modelName;
    }

    out.push(emit("response.in_progress", inprog));
    st.started = true;
  }

  const stopReasoning = (text: string): void => {
    out.push(
      emit("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        sequence_number: nextSeq(),
        item_id: st.reasoningId,
        output_index: st.reasoningIndex,
        summary_index: 0,
        text,
      }),
    );
    out.push(
      emit("response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        sequence_number: nextSeq(),
        item_id: st.reasoningId,
        output_index: st.reasoningIndex,
        summary_index: 0,
        part: { type: "summary_text", text },
      }),
    );
    out.push(
      emit("response.output_item.done", {
        type: "response.output_item.done",
        item: {
          id: st.reasoningId,
          type: "reasoning",
          encrypted_content: "",
          summary: [{ type: "summary_text", text }],
        },
        output_index: st.reasoningIndex,
        sequence_number: nextSeq(),
      }),
    );
    st.reasonings.push({
      reasoningId: st.reasoningId,
      reasoningData: text,
      outputIndex: st.reasoningIndex,
    });
    st.reasoningId = "";
  };

  const emitMessageItemDone = (idx: number): void => {
    if (st.msgItemAdded.get(idx) !== true || st.msgItemDone.get(idx) === true) return;
    const msgOutputIndex = st.msgOutputIx.get(idx) ?? 0;
    const fullText = st.msgTextBuf.get(idx) ?? "";
    const itemId = `msg_${st.responseId}_${idx}`;
    out.push(
      emit("response.output_text.done", {
        type: "response.output_text.done",
        sequence_number: nextSeq(),
        item_id: itemId,
        output_index: msgOutputIndex,
        content_index: 0,
        text: fullText,
        logprobs: [],
      }),
    );
    out.push(
      emit("response.content_part.done", {
        type: "response.content_part.done",
        sequence_number: nextSeq(),
        item_id: itemId,
        output_index: msgOutputIndex,
        content_index: 0,
        part: { type: "output_text", annotations: [], logprobs: [], text: fullText },
      }),
    );

    const msgStatus =
      incompleteByFinishReason(st.finishReason) !== undefined ? "incomplete" : "completed";

    out.push(
      emit("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: msgOutputIndex,
        item: {
          id: itemId,
          type: "message",
          status: msgStatus,
          content: [{ type: "output_text", annotations: [], logprobs: [], text: fullText }],
          role: "assistant",
        },
      }),
    );
    st.msgItemDone.set(idx, true);
  };

  const finalizeOpenItems = (): void => {
    if (st.toolInputError !== undefined) return;

    if (st.msgItemAdded.size > 0) {
      const idxs = [...st.msgItemAdded.keys()].sort(
        (a, b) => (st.msgOutputIx.get(a) ?? 0) - (st.msgOutputIx.get(b) ?? 0),
      );

      for (const idx of idxs) emitMessageItemDone(idx);
    }

    if (st.reasoningId !== "") {
      stopReasoning(st.reasoningBuf);
      st.reasoningBuf = "";
    }

    if (st.funcArgsBuf.size === 0) return;

    const keys = [...st.funcArgsBuf.keys()].sort((a, b) => {
      const left = st.funcOutputIx.get(a) ?? 0;
      const right = st.funcOutputIx.get(b) ?? 0;

      return left < right || (left === right && a < b) ? -1 : left === right && a === b ? 0 : 1;
    });

    for (const key of keys) {
      if (st.funcItemDone.get(key) === true) continue;
      const buffered = st.funcArgsBuf.get(key);
      const hasArgs = buffered !== undefined && buffered.length > 0;
      const isIncomplete = incompleteByFinishReason(st.finishReason) !== undefined;
      const isExplicitToolFinish = st.finishReason === "tool_calls" || st.finishReason === "stop";

      // A stream that ended without finish_reason and without complete JSON arguments must not synthesize empty
      // arguments or complete the in-flight tool call as successful.
      let name = st.toolIndex.canonicalName(st.funcNames.get(key) ?? "");

      if (name === "") name = st.toolIndex.singleCustomName()?.name ?? "";

      if (
        !st.toolIndex.isApplyPatch(name) &&
        st.finishReason === "" &&
        (!hasArgs || !isValidJson(buffered))
      ) {
        continue;
      }

      emitToolItem(key, true);
      emitPendingFunctionArgs(key);

      if (st.toolInputError !== undefined) return;
      const callId = st.funcCallIds.get(key) ?? "";

      if (callId === "" || st.funcItemDone.get(key) === true) continue;

      const outputIndex = st.funcOutputIx.get(key) ?? 0;
      let toolStatus = "completed";
      let args = "{}";

      if (hasArgs) args = buffered;
      else if (isIncomplete || !isExplicitToolFinish) args = "";

      if (isIncomplete) toolStatus = "incomplete";

      if (st.toolIndex.isShell(name)) {
        const shell = shellCallItem(callId, args, toolStatus);

        if ("error" in shell) {
          failToolInput(shell.error);

          return;
        }

        out.push(
          emit("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: shell.item,
          }),
        );
        st.funcItemDone.set(key, true);
        st.funcArgsDone.set(key, true);
        continue;
      }

      if (st.toolIndex.isToolSearch(name)) {
        out.push(
          emit("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: buildToolSearchCallItem(callId, toolStatus, hasArgs ? buffered : ""),
          }),
        );
        st.funcItemDone.set(key, true);
        st.funcArgsDone.set(key, true);
        continue;
      }

      if (st.funcItemCustom.get(key) === true) {
        let input: string;
        const patchCall = st.applyPatchCalls.get(key);

        if (patchCall !== undefined) {
          const finished = patchCall.finishArguments(args);

          if ("error" in finished) {
            failToolInput(finished.error);

            return;
          }

          input = finished.input;

          if (finished.tail !== "") {
            out.push(
              emit(
                "response.custom_tool_call_input.delta",
                applyPatchInputDelta(patchCall, finished.tail, nextSeq()),
              ),
            );
          }

          out.push(
            emit(
              "response.custom_tool_call_input.done",
              applyPatchInputDone(patchCall, input, nextSeq()),
            ),
          );
        } else {
          input = unwrapCustomToolInput(args);
          out.push(
            emit("response.custom_tool_call_input.done", {
              type: "response.custom_tool_call_input.done",
              sequence_number: nextSeq(),
              item_id: `ctc_${callId}`,
              output_index: outputIndex,
              input,
            }),
          );
        }

        const itemDone: JsonObject = {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: outputIndex,
          item: {
            id: `ctc_${callId}`,
            type: "custom_tool_call",
            status: toolStatus,
            input,
            call_id: callId,
            name: "",
          },
        };

        st.toolIndex.applyIdentity(itemDone, st.funcNames.get(key) ?? "", "item");
        out.push(emit("response.output_item.done", itemDone));
        st.funcItemDone.set(key, true);
        st.funcArgsDone.set(key, true);
        continue;
      }

      out.push(
        emit("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          sequence_number: nextSeq(),
          item_id: `fc_${callId}`,
          output_index: outputIndex,
          arguments: args,
        }),
      );

      const itemDone: JsonObject = {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: outputIndex,
        item: {
          id: `fc_${callId}`,
          type: "function_call",
          status: toolStatus,
          arguments: args,
          call_id: callId,
          name: "",
        },
      };

      st.toolIndex.applyIdentity(itemDone, st.funcNames.get(key) ?? "", "item");
      out.push(emit("response.output_item.done", itemDone));
      st.funcItemDone.set(key, true);
      st.funcArgsDone.set(key, true);
    }
  };

  if (isDone) {
    finalizeOpenItems();

    if (st.toolInputError !== undefined) return out;

    for (const key of st.funcItemAdded.keys()) if (st.funcItemDone.get(key) !== true) return out;

    if (st.msgItemAdded.size === 0 && st.funcItemAdded.size === 0) return out;
    st.completedEmitted = true;
    out.push(buildResponsesCompletedEvent(st, nextSeq));

    return out;
  }

  const choices = get(root, "choices");

  if (isArr(choices)) {
    for (const choice of choices) {
      const idx = asInt(get(choice, "index"));
      const delta = get(choice, "delta");

      if (delta !== undefined) {
        let rc = get(delta, "reasoning_content");

        if (rc === undefined || str(rc) === "") rc = get(delta, "reasoning");

        if (rc !== undefined && str(rc) !== "") {
          const rcText = str(rc);

          if (st.reasoningId === "") {
            st.reasoningId = `rs_${st.responseId}_${idx}`;
            st.reasoningIndex = allocOutputIndex();
            out.push(
              emit("response.output_item.added", {
                type: "response.output_item.added",
                sequence_number: nextSeq(),
                output_index: st.reasoningIndex,
                item: { id: st.reasoningId, type: "reasoning", status: "in_progress", summary: [] },
              }),
            );
            out.push(
              emit("response.reasoning_summary_part.added", {
                type: "response.reasoning_summary_part.added",
                sequence_number: nextSeq(),
                item_id: st.reasoningId,
                output_index: st.reasoningIndex,
                summary_index: 0,
                part: { type: "summary_text", text: "" },
              }),
            );
          }

          st.reasoningBuf += rcText;
          out.push(
            emit("response.reasoning_summary_text.delta", {
              type: "response.reasoning_summary_text.delta",
              sequence_number: nextSeq(),
              item_id: st.reasoningId,
              output_index: st.reasoningIndex,
              summary_index: 0,
              delta: rcText,
            }),
          );
        }

        const c = get(delta, "content");

        if (c !== undefined && str(c) !== "") {
          const text = str(c);

          // Announce the message item and its first content part before any text deltas.
          if (st.reasoningId !== "") {
            stopReasoning(st.reasoningBuf);
            st.reasoningBuf = "";
          }

          if (!st.msgOutputIx.has(idx)) st.msgOutputIx.set(idx, allocOutputIndex());
          // SAFETY: the line above sets msgOutputIx[idx] when it is missing.
          const msgOutputIndex = st.msgOutputIx.get(idx) as number;
          const itemId = `msg_${st.responseId}_${idx}`;

          if (st.msgItemAdded.get(idx) !== true) {
            out.push(
              emit("response.output_item.added", {
                type: "response.output_item.added",
                sequence_number: nextSeq(),
                output_index: msgOutputIndex,
                item: {
                  id: itemId,
                  type: "message",
                  status: "in_progress",
                  content: [],
                  role: "assistant",
                },
              }),
            );
            st.msgItemAdded.set(idx, true);
          }

          if (st.msgContentAdded.get(idx) !== true) {
            out.push(
              emit("response.content_part.added", {
                type: "response.content_part.added",
                sequence_number: nextSeq(),
                item_id: itemId,
                output_index: msgOutputIndex,
                content_index: 0,
                part: { type: "output_text", annotations: [], logprobs: [], text: "" },
              }),
            );
            st.msgContentAdded.set(idx, true);
          }

          out.push(
            emit("response.output_text.delta", {
              type: "response.output_text.delta",
              sequence_number: nextSeq(),
              item_id: itemId,
              output_index: msgOutputIndex,
              content_index: 0,
              delta: text,
              logprobs: [],
            }),
          );
          st.msgTextBuf.set(idx, (st.msgTextBuf.get(idx) ?? "") + text);
        }

        const tcs = get(delta, "tool_calls");

        if (isArr(tcs) && tcs.length > 0) {
          if (st.reasoningId !== "") {
            stopReasoning(st.reasoningBuf);
            st.reasoningBuf = "";
          }

          // Close an open message before any function events to match the Codex expected ordering.
          emitMessageItemDone(idx);

          for (const tc of tcs) {
            const toolIndex = asInt(get(tc, "index"));
            const key = toolStateKey(idx, toolIndex);

            if (!st.funcArgsBuf.has(key)) {
              st.funcArgsBuf.set(key, "");
              st.funcOutputIx.set(key, allocOutputIndex());
            }

            const newId = getStr(tc, "id");
            const newName = st.toolIndex.canonicalName(getStr(tc, "function.name"));
            const oldId = st.funcCallIds.get(key) ?? "";
            const oldName = st.toolIndex.canonicalName(st.funcNames.get(key) ?? "");

            // Retain conflicting non-empty ids until the winning tool is known.
            if (newId !== "" && oldId !== "" && newId !== oldId)
              st.funcIdentityConflicts.set(key, true);

            if (st.toolIndex.isApplyPatch(oldName) || st.toolIndex.isApplyPatch(newName)) {
              if (
                st.funcIdentityConflicts.get(key) === true ||
                (newName !== "" && oldName !== "" && newName !== oldName)
              ) {
                failToolInput("conflicting apply_patch call identity");
                break;
              }
            }

            if (newId !== "" && (st.funcCallIds.get(key) ?? "") === "")
              st.funcCallIds.set(key, newId);
            const nameChunk = getStr(tc, "function.name");

            if (nameChunk !== "" && st.funcItemAdded.get(key) !== true)
              st.funcNames.set(key, nameChunk);

            const args = get(tc, "function.arguments");

            if (args !== undefined && str(args) !== "")
              st.funcArgsBuf.set(key, (st.funcArgsBuf.get(key) ?? "") + str(args));
            emitToolItem(key, false);
            emitPendingFunctionArgs(key);

            if (st.toolInputError !== undefined) break;
          }
        }
      }

      if (st.toolInputError !== undefined) break;

      // finish_reason finalises the items; the terminal event waits for [DONE] (or transport finalisation) so late
      // usage-only chunks can still populate response.usage.
      const fr = get(choice, "finish_reason");

      if (fr !== undefined && str(fr) !== "") {
        st.finishReason = str(fr);
        finalizeOpenItems();
        st.completionPending = canFinalizeResponse(st);
      }

      if (st.toolInputError !== undefined) break;
    }
  }

  return out;
};

/** `ConvertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream`. */
export const convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root: Json = parseJson(body) ?? {};
  const requestForNamespace = pickRequestJson(context.originalRequest, context.translatedRequest);
  const toolIndex = new ResponsesToolIndex(requestForNamespace);
  const st = newState();
  context.state.value = st;

  const finishReason = getStr(root, "choices.0.finish_reason");
  const incompleteDetails = incompleteByFinishReason(finishReason);
  const isIncomplete = incompleteDetails !== undefined;

  const resp: JsonObject = {
    id: "",
    object: "response",
    created_at: 0,
    status: isIncomplete ? "incomplete" : "completed",
    background: false,
    error: null,
    incomplete_details: isIncomplete ? incompleteDetails : null,
  };

  let id = getStr(root, "id");

  if (id === "") {
    responseIdCounter += 1;
    id = `resp_${Date.now().toString(16)}000000_${responseIdCounter}`;
  }

  resp.id = id;

  let created = asInt(get(root, "created"));

  if (created === 0) created = Math.floor(Date.now() / 1000);
  resp.created_at = created;

  // Echo request fields when available (aligns with the streaming path).
  const req = context.translatedRequest;

  if (req !== undefined) {
    echoRequestFields(resp, req, true);

    if (
      resp.model === undefined &&
      get(root, "model") !== undefined &&
      get(req, "model") === undefined
    ) {
      resp.model = getStr(root, "model");
    }
  } else if (get(root, "model") !== undefined) {
    resp.model = getStr(root, "model");
  }

  const outputItems: Json[] = [];
  let rc = get(root, "choices.0.message.reasoning_content");

  if (rc === undefined || str(rc) === "") rc = get(root, "choices.0.message.reasoning");
  const rcText = str(rc);
  let includeReasoning = rcText !== "";

  if (!includeReasoning && req !== undefined)
    includeReasoning = get(req, "reasoning") !== undefined;

  if (includeReasoning) {
    let rid = id;

    if (rid.startsWith("resp_")) rid = rid.slice("resp_".length);

    const reasoningItem: JsonObject = {
      id: `rs_${rid}`,
      type: "reasoning",
      encrypted_content: "",
      summary: [],
    };

    if (rcText !== "") reasoningItem.summary = [{ type: "summary_text", text: rcText }];
    outputItems.push(reasoningItem);
  }

  const choices = get(root, "choices");

  if (isArr(choices)) {
    for (const choice of choices) {
      const msg = get(choice, "message");

      if (msg !== undefined) {
        const c = get(msg, "content");

        if (c !== undefined && str(c) !== "") {
          outputItems.push({
            id: `msg_${id}_${asInt(get(choice, "index"))}`,
            type: "message",
            status: isIncomplete ? "incomplete" : "completed",
            content: [{ type: "output_text", annotations: [], logprobs: [], text: str(c) }],
            role: "assistant",
          });
        }

        const tcs = get(msg, "tool_calls");

        if (isArr(tcs)) {
          for (const [tcIndex, tc] of tcs.entries()) {
            let callId = getStr(tc, "id");

            if (callId === "") {
              // Providers may omit tool_call ids; synthesize one so the item stays usable for Codex round-trips.
              callId = `call_${id}_${asInt(get(choice, "index"))}_${tcIndex}`;
            }

            const name = toolIndex.canonicalName(getStr(tc, "function.name"));
            const args = getStr(tc, "function.arguments");
            const toolStatus = isIncomplete ? "incomplete" : "completed";

            if (toolIndex.isShell(name)) {
              const shell = shellCallItem(callId, args, toolStatus);

              if ("error" in shell) {
                st.toolInputError = shell.error;
                break;
              }

              outputItems.push(shell.item);
              continue;
            }

            if (toolIndex.isToolSearch(name)) {
              outputItems.push(buildToolSearchCallItem(callId, toolStatus, args));
              continue;
            }

            if (toolIndex.custom.has(name)) {
              let input: string;

              if (toolIndex.isApplyPatch(name)) {
                const finished = new ApplyPatchCallState("", "", "", "", 0).finishArguments(args);

                if ("error" in finished) {
                  st.toolInputError = finished.error;
                  break;
                }

                input = finished.input;
              } else {
                input = unwrapCustomToolInput(args);
              }

              const item: JsonObject = {
                id: `ctc_${callId}`,
                type: "custom_tool_call",
                status: toolStatus,
                input,
                call_id: callId,
                name: "",
              };

              toolIndex.applyIdentity(item, name, "");
              outputItems.push(item);
              continue;
            }

            const item: JsonObject = {
              id: `fc_${callId}`,
              type: "function_call",
              status: toolStatus,
              arguments: args,
              call_id: callId,
              name: "",
            };

            toolIndex.applyIdentity(item, name, "");
            outputItems.push(item);
          }
        }
      }

      if (st.toolInputError !== undefined) break;
    }
  }

  if (st.toolInputError !== undefined) {
    context.state.toolInputError = st.toolInputError;

    return JSON.stringify(get(responsesToolInputFailure(id, 0, st.toolInputError), "response"));
  }

  if (outputItems.length > 0) resp.output = outputItems;

  const usage = get(root, "usage");

  if (usage !== undefined) {
    if (
      get(usage, "prompt_tokens") !== undefined ||
      get(usage, "completion_tokens") !== undefined ||
      get(usage, "total_tokens") !== undefined
    ) {
      const u: JsonObject = { input_tokens: asInt(get(usage, "prompt_tokens")) };
      const cached = get(usage, "prompt_tokens_details.cached_tokens");

      if (cached !== undefined) u.input_tokens_details = { cached_tokens: asInt(cached) };
      u.output_tokens = asInt(get(usage, "completion_tokens"));
      const reasoning = get(usage, "output_tokens_details.reasoning_tokens");

      if (reasoning !== undefined) u.output_tokens_details = { reasoning_tokens: asInt(reasoning) };
      u.total_tokens = asInt(get(usage, "total_tokens"));
      resp.usage = u;
    } else {
      resp.usage = usage;
    }
  }

  return JSON.stringify(resp);
};

export const openAIToOpenAIResponsesResponse: ResponseTransform = {
  stream: convertOpenAIChatCompletionsResponseToOpenAIResponses,
  nonStream: convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream,
};
