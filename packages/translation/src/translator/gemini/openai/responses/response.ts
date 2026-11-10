/**
 * Gemini provider -> OpenAI Responses client: streaming response conversion.
 *
 * Go source: internal/translator/gemini/openai/responses/gemini_openai-responses_response.go
 * (ConvertGeminiResponseToOpenAIResponses). The Go closures over `st`/`out` are kept as closures; SSE frames are
 * `event: <type>\ndata: <json>\n\n` strings. Generated ids use the wall clock (see response-common.ts).
 */
import {
  asBool,
  asInt,
  asString,
  exists,
  get,
  isJsonArray,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { sseEvent } from "../../../../sse.ts";
import { requestModelNameOf } from "../../../common/request.ts";
import type { ResponseContext } from "../../../registry.ts";
import {
  restoreSanitizedToolName,
  sanitizedToolNameMap,
  type NameMap,
} from "../../../common/tool-names.ts";
import {
  CARRIER_ANY,
  CARRIER_FUNCTION,
  CARRIER_NEXT,
  CARRIER_PREVIOUS,
  CARRIER_STANDALONE,
  CARRIER_TEXT,
  encodeCarrier,
} from "./carrier.ts";
import {
  applyPatchFailure,
  applyPatchInputDelta,
  applyPatchInputDone,
} from "../../../common/apply-patch.ts";
import {
  type ApplyPatchCall,
  echoRequestFields,
  type EvidenceState,
  finishApplyPatchArguments,
  mergeUsage,
  newResponseId,
  newStreamCallId,
  newUsage,
  parseCreateTime,
  pendingIdentityError,
  pickRequestJson,
  recordFunctionEvidence,
  type ResponsesUsage,
  setToolCallIdentity,
  terminalState,
  unwrapGeminiResponseRoot,
  unwrapRequestRoot,
  usageJson,
} from "./response-common.ts";
import { cacheTextSignatures } from "./trailing-signature.ts";
import {
  buildToolSearchCallItem,
  type ResponsesToolIdentity,
  unwrapResponsesCustomToolInput,
} from "../../../common/responses-tools.ts";
import { responsesToolReverseIdentityMap } from "./tools.ts";
import {
  allowsResponsesWebSearchToolChoice,
  buildResponsesUrlCitationsForMessages,
  buildResponsesWebSearchCallItem,
  extractGroundingMetadata,
  extractGroundingQueries,
  extractGroundingSources,
  extractResponsesWebSearchQuery,
  type GeminiPartMapping,
  hasResponsesWebSearchTool,
  hasValidWebGrounding,
  mergeCitationAnnotations,
  mergeGroundingMetadata,
  modelSupportsWebSearch,
} from "./web-search.ts";

const THOUGHT_SIGNATURE_BYPASS = "skip_thought_signature_validator";

interface DetachedReasoning {
  index: number;
  id: string;
  signature: string;
}

interface CompletedMessage {
  id: string;
  text: string;
  status: string;
  annotations: Json[];
}

interface CompletedReasoning {
  id: string;
  signature: string;
  text: string;
}

interface BufferedPart {
  partIndex: number;
  text: string;
}

interface StreamState extends EvidenceState {
  seq: number;
  responseId: string;
  createdAt: number;
  started: boolean;
  completed: boolean;
  finishReason: string;
  usage: ResponsesUsage;

  msgOpened: boolean;
  msgClosed: boolean;
  msgIndex: number;
  currentMsgId: string;
  itemTextBuf: string;

  reasoningOpened: boolean;
  reasoningIndex: number;
  reasoningItemId: string;
  reasoningEnc: string;
  reasoningDirection: string;
  reasoningTargetKind: string;
  reasoningBuf: string;
  reasoningPendingDeltas: string[];
  reasoningClosed: boolean;
  pendingReasoningSignature: string;
  detachedReasoning: Map<number, DetachedReasoning>;
  completedMessages: Map<number, CompletedMessage>;
  completedReasoning: Map<number, CompletedReasoning>;
  seenReasoningSignatures: Set<string>;
  lastSemanticKind: string;
  hiddenTextSignatures: Map<string, string[]>;

  nextIndex: number;
  funcArgsBuf: Map<number, string>;
  funcInputBuf: Map<number, string>;
  funcCustom: Map<number, boolean>;
  funcToolSearch: Map<number, boolean>;
  funcNames: Map<number, string>;
  funcNamespaces: Map<number, string>;
  funcCallIds: Map<number, string>;
  funcDone: Map<number, boolean>;
  sanitizedNameMap: NameMap;

  webSearchStreamMode: boolean;
  webSearchOpened: boolean;
  webSearchDone: boolean;
  webSearchIndex: number;
  webSearchItemId: string;
  webSearchDoneItem: Json | undefined;
  webSearchQuery: string;
  webSearchQueries: string[];
  webSearchSources: Json[];
  webSearchAnnotations: Json[];
  webSearchAnnotationsAttached: boolean;
  webSearchBufferedDeltas: string[];
  webSearchBufferedParts: BufferedPart[];
  rawGroundingMetadata: Json | undefined;
  partMappings: GeminiPartMapping[];
  streamPartIndex: number;
  currentLogicalPartIndex: number;
  currentPartKind: string;
  hasSeenFirstPart: boolean;
  textPartRunActive: boolean;
  currentMsgRuneOffset: number;
  emittedAnnotationCount: Map<number, number>;
}

const newState = (
  originalRequest: Json | undefined,
  requestJson: Json | undefined,
): StreamState => ({
  seq: 0,
  responseId: "",
  createdAt: 0,
  started: false,
  completed: false,
  finishReason: "",
  usage: newUsage(),
  msgOpened: false,
  msgClosed: false,
  msgIndex: 0,
  currentMsgId: "",
  itemTextBuf: "",
  reasoningOpened: false,
  reasoningIndex: 0,
  reasoningItemId: "",
  reasoningEnc: "",
  reasoningDirection: "",
  reasoningTargetKind: "",
  reasoningBuf: "",
  reasoningPendingDeltas: [],
  reasoningClosed: false,
  pendingReasoningSignature: "",
  detachedReasoning: new Map(),
  completedMessages: new Map(),
  completedReasoning: new Map(),
  seenReasoningSignatures: new Set(),
  lastSemanticKind: "",
  hiddenTextSignatures: new Map(),
  nextIndex: 0,
  funcArgsBuf: new Map(),
  funcInputBuf: new Map(),
  funcCustom: new Map(),
  funcToolSearch: new Map(),
  funcNames: new Map(),
  funcNamespaces: new Map(),
  funcCallIds: new Map(),
  funcDone: new Map(),
  sanitizedNameMap: sanitizedToolNameMap(originalRequest),
  toolIdentityMap: responsesToolReverseIdentityMap(requestJson),
  functionEvidence: undefined,
  webSearchStreamMode: false,
  webSearchOpened: false,
  webSearchDone: false,
  webSearchIndex: 0,
  webSearchItemId: "",
  webSearchDoneItem: undefined,
  webSearchQuery: "",
  webSearchQueries: [],
  webSearchSources: [],
  webSearchAnnotations: [],
  webSearchAnnotationsAttached: false,
  webSearchBufferedDeltas: [],
  webSearchBufferedParts: [],
  rawGroundingMetadata: undefined,
  partMappings: [],
  streamPartIndex: 0,
  currentLogicalPartIndex: 0,
  currentPartKind: "",
  hasSeenFirstPart: false,
  textPartRunActive: false,
  currentMsgRuneOffset: 0,
  emittedAnnotationCount: new Map(),
});

const runeLength = (text: string): number => {
  let count = 0;

  for (const _ of text) {
    void _;
    count++;
  }

  return count;
};

const hasEffectiveGoogleSearchTool = (request: Json | undefined): boolean => {
  if (request === undefined) return false;

  if (get(request, "requestType") === "web_search") return true;

  for (const path of ["request.tools", "tools"]) {
    const tools = get(request, path);

    if (isJsonArray(tools) && tools.some((tool) => exists(tool, "googleSearch"))) return true;
  }

  return false;
};

const isUpstreamGeminiRequest = (request: Json | undefined): boolean =>
  request !== undefined &&
  (exists(request, "requestType") ||
    exists(request, "contents") ||
    exists(request, "request.contents"));

/** `determineWebSearchStreamMode`. */
const determineWebSearchStreamMode = (
  modelName: string,
  requestModelName: string,
  original: Json | undefined,
  translated: Json | undefined,
): boolean => {
  if (original !== undefined && !allowsResponsesWebSearchToolChoice(unwrapRequestRoot(original)))
    return false;

  if (translated !== undefined) {
    const root = unwrapRequestRoot(translated);

    if (exists(root, "tool_choice") && !allowsResponsesWebSearchToolChoice(root)) return false;

    if (isUpstreamGeminiRequest(translated) || hasEffectiveGoogleSearchTool(translated)) {
      return hasEffectiveGoogleSearchTool(translated);
    }
  }

  const requestJson = pickRequestJson(original, translated);

  if (requestJson !== undefined) {
    const root = unwrapRequestRoot(requestJson);

    return (
      hasResponsesWebSearchTool(root) &&
      allowsResponsesWebSearchToolChoice(root) &&
      (modelSupportsWebSearch(modelName) || modelSupportsWebSearch(requestModelName))
    );
  }

  return false;
};

const stripResponsePrefix = (id: string): string => (id.startsWith("resp_") ? id.slice(5) : id);

/** `ConvertGeminiResponseToOpenAIResponses`. */
export const convertGeminiResponseToOpenAIResponses = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const modelName = context.model;
  const originalRequest = context.originalRequest;
  const translatedRequest = context.translatedRequest;
  const reqJson = pickRequestJson(originalRequest, translatedRequest);

  if (context.state.value === undefined) context.state.value = newState(originalRequest, reqJson);
  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  const st = context.state.value as StreamState;

  const setToolInputError = (message: string): void => {
    context.state.toolInputError = message;
  };

  let rawText = line.trim();

  if (rawText.startsWith("data:")) rawText = rawText.slice(5).trim();

  if (rawText === "" || st.completed) return [];
  const done = rawText === "[DONE]";

  if (done) {
    if (!st.started) return [];

    if (st.finishReason === "") st.finishReason = "STOP";
    rawText = "{}";
  }

  const parsed = tryParseJson(rawText);

  if (parsed === undefined) return [];
  const root = unwrapGeminiResponseRoot(parsed);
  const hasUsage = mergeUsage(st.usage, root);
  let messageStatus = "completed";

  const out: string[] = [];

  const emit = (event: string, payload: JsonObject): void => {
    out.push(sseEvent(event, JSON.stringify(payload)));
  };

  const nextSeq = (): number => ++st.seq;

  const reasoningEncryptedContent = (): string =>
    st.reasoningEnc === "" || st.reasoningDirection === ""
      ? st.reasoningEnc
      : encodeCarrier(st.reasoningEnc, st.reasoningDirection, st.reasoningTargetKind);

  const webSearchQueryFallback = (): void => {
    if (st.webSearchQuery === "" && st.webSearchQueries.length > 0)
      // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      st.webSearchQuery = st.webSearchQueries[0] as string;

    if (st.webSearchQuery === "" && reqJson !== undefined) {
      st.webSearchQuery = extractResponsesWebSearchQuery(unwrapRequestRoot(reqJson));
    }
  };

  const finalizeWebSearch = (): void => {
    if (!st.webSearchOpened || st.webSearchDone) return;
    webSearchQueryFallback();
    emit("response.web_search_call.completed", {
      type: "response.web_search_call.completed",
      sequence_number: nextSeq(),
      output_index: st.webSearchIndex,
      item_id: st.webSearchItemId,
    });

    const doneItem = buildResponsesWebSearchCallItem(
      st.webSearchItemId,
      st.webSearchQuery,
      st.webSearchQueries,
      st.webSearchSources,
    );

    st.webSearchDoneItem = doneItem;
    emit("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: nextSeq(),
      output_index: st.webSearchIndex,
      item: doneItem,
    });
    st.webSearchDone = true;
  };

  const openReasoning = (): void => {
    if (
      st.reasoningOpened ||
      st.reasoningClosed ||
      (st.reasoningBuf.length === 0 && st.reasoningEnc === "")
    )
      return;
    finalizeWebSearch();
    st.reasoningOpened = true;
    st.reasoningIndex = st.nextIndex;
    st.nextIndex++;
    st.reasoningItemId = `rs_${st.responseId}_${st.reasoningIndex}`;
    emit("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: nextSeq(),
      output_index: st.reasoningIndex,
      item: {
        id: st.reasoningItemId,
        type: "reasoning",
        status: "in_progress",
        encrypted_content: reasoningEncryptedContent(),
        summary: [],
      },
    });
    emit("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      sequence_number: nextSeq(),
      item_id: st.reasoningItemId,
      output_index: st.reasoningIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });

    for (const delta of st.reasoningPendingDeltas) {
      emit("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        sequence_number: nextSeq(),
        item_id: st.reasoningItemId,
        output_index: st.reasoningIndex,
        summary_index: 0,
        delta,
      });
    }

    st.reasoningPendingDeltas = [];
  };

  // Emits response.reasoning_summary_text.done followed by response.reasoning_summary_part.done exactly once.
  const finalizeReasoning = (): void => {
    openReasoning();

    if (!st.reasoningOpened || st.reasoningClosed) return;
    const full = st.reasoningBuf;
    emit("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      sequence_number: nextSeq(),
      item_id: st.reasoningItemId,
      output_index: st.reasoningIndex,
      summary_index: 0,
      text: full,
    });
    emit("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      sequence_number: nextSeq(),
      item_id: st.reasoningItemId,
      output_index: st.reasoningIndex,
      summary_index: 0,
      part: { type: "summary_text", text: full },
    });
    emit("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: nextSeq(),
      output_index: st.reasoningIndex,
      item: {
        id: st.reasoningItemId,
        type: "reasoning",
        encrypted_content: reasoningEncryptedContent(),
        summary: [{ type: "summary_text", text: full }],
      },
    });
    st.completedReasoning.set(st.reasoningIndex, {
      id: st.reasoningItemId,
      signature: reasoningEncryptedContent(),
      text: full,
    });
    st.reasoningClosed = true;
  };

  const resetReasoning = (): void => {
    st.reasoningOpened = false;
    st.reasoningClosed = false;
    st.reasoningIndex = 0;
    st.reasoningItemId = "";
    st.reasoningEnc = "";
    st.reasoningDirection = "";
    st.reasoningTargetKind = "";
    st.reasoningBuf = "";
    st.reasoningPendingDeltas = [];
  };

  const openWebSearch = (): void => {
    if (st.webSearchOpened) return;
    finalizeReasoning();
    st.webSearchOpened = true;
    st.webSearchIndex = st.nextIndex;
    st.nextIndex++;
    st.webSearchItemId = `ws_${stripResponsePrefix(st.responseId)}`;
    webSearchQueryFallback();
    emit("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: nextSeq(),
      output_index: st.webSearchIndex,
      item: {
        id: st.webSearchItemId,
        type: "web_search_call",
        status: "in_progress",
        action: { type: "search", query: st.webSearchQuery },
      },
    });
    emit("response.web_search_call.searching", {
      type: "response.web_search_call.searching",
      sequence_number: nextSeq(),
      output_index: st.webSearchIndex,
      item_id: st.webSearchItemId,
    });
  };

  const openMessage = (): void => {
    st.msgOpened = true;
    st.msgIndex = st.nextIndex;
    st.nextIndex++;
    st.currentMsgId = `msg_${st.responseId}_${st.msgIndex}`;
    emit("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: nextSeq(),
      output_index: st.msgIndex,
      item: {
        id: st.currentMsgId,
        type: "message",
        status: "in_progress",
        content: [],
        role: "assistant",
      },
    });
    emit("response.content_part.added", {
      type: "response.content_part.added",
      sequence_number: nextSeq(),
      item_id: st.currentMsgId,
      output_index: st.msgIndex,
      content_index: 0,
      part: { type: "output_text", annotations: [], logprobs: [], text: "" },
    });
    st.itemTextBuf = "";
    st.currentMsgRuneOffset = 0;
  };

  const textDelta = (delta: string): void => {
    emit("response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: nextSeq(),
      item_id: st.currentMsgId,
      output_index: st.msgIndex,
      content_index: 0,
      delta,
      logprobs: [],
    });
  };

  const flushWebSearchBufferedText = (): void => {
    finalizeWebSearch();

    if (st.webSearchBufferedDeltas.length === 0) return;

    if (st.msgClosed) {
      st.msgOpened = false;
      st.msgClosed = false;
      st.itemTextBuf = "";
      st.currentMsgRuneOffset = 0;
    }

    if (!st.msgOpened) openMessage();

    for (const delta of st.webSearchBufferedDeltas) {
      st.itemTextBuf += delta;
      textDelta(delta);
    }

    for (const buffered of st.webSearchBufferedParts) {
      const last = st.partMappings[st.partMappings.length - 1];

      if (
        last !== undefined &&
        last.partIndex === buffered.partIndex &&
        last.messageIndex === st.msgIndex
      ) {
        last.partText += buffered.text;
      } else {
        st.partMappings.push({
          partIndex: buffered.partIndex,
          messageIndex: st.msgIndex,
          startRuneInMsg: st.currentMsgRuneOffset,
          partText: buffered.text,
        });
      }

      st.currentMsgRuneOffset += runeLength(buffered.text);
    }

    st.webSearchBufferedDeltas = [];
    st.webSearchBufferedParts = [];
  };

  const emitNewCitationAnnotations = (
    msgIndex: number,
    itemId: string,
    annotations: readonly Json[],
  ): void => {
    const emitted = st.emittedAnnotationCount.get(msgIndex) ?? 0;

    for (let annIdx = emitted; annIdx < annotations.length; annIdx++) {
      // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      emit("response.output_text.annotation.added", {
        type: "response.output_text.annotation.added",
        sequence_number: nextSeq(),
        response_id: st.responseId,
        item_id: itemId,
        output_index: msgIndex,
        content_index: 0,
        annotation_index: annIdx,
        annotation: annotations[annIdx] as Json,
      });
    }

    if (annotations.length > emitted) st.emittedAnnotationCount.set(msgIndex, annotations.length);
  };

  // Emits new citations, then output_text.done, content_part.done and output_item.done exactly once.
  const finalizeMessage = (): void => {
    finalizeWebSearch();

    if (st.webSearchBufferedDeltas.length > 0) flushWebSearchBufferedText();

    if (!st.msgOpened || st.msgClosed) return;
    const fullText = st.itemTextBuf;
    let msgCitations: Json[] = [];

    if (st.rawGroundingMetadata !== undefined) {
      const byMessage = buildResponsesUrlCitationsForMessages(
        st.rawGroundingMetadata,
        st.partMappings,
        [fullText],
      );

      msgCitations = byMessage.get(st.msgIndex) ?? [];

      if (
        msgCitations.length === 0 &&
        st.completedMessages.size === 0 &&
        (byMessage.get(0)?.length ?? 0) > 0
      ) {
        // SAFETY: the guard above checked that the entry exists and is non-empty.
        msgCitations = byMessage.get(0) as Json[];
      }

      st.webSearchAnnotations = msgCitations;
    }

    emitNewCitationAnnotations(st.msgIndex, st.currentMsgId, msgCitations);
    emit("response.output_text.done", {
      type: "response.output_text.done",
      sequence_number: nextSeq(),
      item_id: st.currentMsgId,
      output_index: st.msgIndex,
      content_index: 0,
      text: fullText,
      logprobs: [],
    });
    emit("response.content_part.done", {
      type: "response.content_part.done",
      sequence_number: nextSeq(),
      item_id: st.currentMsgId,
      output_index: st.msgIndex,
      content_index: 0,
      part: { type: "output_text", annotations: msgCitations, logprobs: [], text: fullText },
    });

    if (msgCitations.length > 0) st.webSearchAnnotationsAttached = true;
    emit("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: nextSeq(),
      output_index: st.msgIndex,
      item: {
        id: st.currentMsgId,
        type: "message",
        status: messageStatus,
        content: [{ type: "output_text", annotations: msgCitations, logprobs: [], text: fullText }],
        role: "assistant",
      },
    });
    st.completedMessages.set(st.msgIndex, {
      id: st.currentMsgId,
      text: fullText,
      status: messageStatus,
      annotations: msgCitations,
    });
    st.msgClosed = true;
    st.currentMsgRuneOffset = 0;
  };

  const emitLateCitations = (): void => {
    if (st.rawGroundingMetadata === undefined || st.completedMessages.size === 0) return;
    const messageTexts: string[] = [];

    for (let idx = 0; idx < st.nextIndex; idx++) {
      const message = st.completedMessages.get(idx);

      if (message !== undefined) messageTexts.push(message.text);
    }

    const lateMap = buildResponsesUrlCitationsForMessages(
      st.rawGroundingMetadata,
      st.partMappings,
      messageTexts,
    );

    if (lateMap.size === 0) return;

    for (let idx = 0; idx < st.nextIndex; idx++) {
      const completed = st.completedMessages.get(idx);

      if (completed === undefined) continue;
      let lateCites = lateMap.get(idx) ?? [];

      if (
        lateCites.length === 0 &&
        st.completedMessages.size === 1 &&
        (lateMap.get(0)?.length ?? 0) > 0
      ) {
        // SAFETY: the guard above checked that the entry exists and is non-empty.
        lateCites = lateMap.get(0) as Json[];
      }

      const annotations = mergeCitationAnnotations(completed.annotations, lateCites);
      emitNewCitationAnnotations(idx, completed.id, annotations);

      if (annotations.length > 0) {
        completed.annotations = annotations;
        st.completedMessages.set(idx, completed);
      }
    }
  };

  const emitDetachedReasoning = (
    signatureInput: string,
    direction: string,
    targetKind: string,
  ): void => {
    const signature = signatureInput.trim();

    if (signature === "" || st.seenReasoningSignatures.has(signature)) return;
    finalizeReasoning();
    finalizeMessage();
    const idx = st.nextIndex;
    st.nextIndex++;
    const placement = direction === CARRIER_PREVIOUS ? "after" : "before";
    const itemId = `rs_${st.responseId}_detached_${placement}_${idx}`;
    const carrierSignature = encodeCarrier(signature, direction, targetKind);
    emit("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: nextSeq(),
      output_index: idx,
      item: {
        id: itemId,
        type: "reasoning",
        status: "in_progress",
        encrypted_content: carrierSignature,
        summary: [],
      },
    });
    emit("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: nextSeq(),
      output_index: idx,
      item: { id: itemId, type: "reasoning", encrypted_content: carrierSignature, summary: [] },
    });
    st.detachedReasoning.set(idx, { index: idx, id: itemId, signature: carrierSignature });
    st.seenReasoningSignatures.add(signature);
  };

  const emitTrailingDetachedReasoning = (signatureInput: string): void => {
    switch (st.lastSemanticKind) {
      case CARRIER_TEXT: {
        const signature = signatureInput.trim();

        if (signature === "" || st.seenReasoningSignatures.has(signature)) return;
        finalizeReasoning();
        finalizeMessage();

        // LastSemanticKind also includes thought text. Never bind a later thought signature to a visible message from
        // before that thought.
        if (!st.msgOpened || (st.reasoningOpened && st.reasoningIndex > st.msgIndex)) {
          emitDetachedReasoning(signature, CARRIER_PREVIOUS, CARRIER_TEXT);

          return;
        }

        const signatures = [...(st.hiddenTextSignatures.get(st.currentMsgId) ?? []), signature];
        // Keep failed writes in the prefix so a later successful write cannot move a newer signature ahead of an
        // earlier fallback carrier.
        st.hiddenTextSignatures.set(st.currentMsgId, signatures);

        if (cacheTextSignatures(modelName, st.currentMsgId, st.itemTextBuf, signatures)) {
          st.seenReasoningSignatures.add(signature);

          return;
        }

        // Preserve replay continuity if the cache cannot accept the signature.
        emitDetachedReasoning(signature, CARRIER_PREVIOUS, CARRIER_TEXT);

        return;
      }

      case CARRIER_FUNCTION:
        emitDetachedReasoning(signatureInput, CARRIER_PREVIOUS, CARRIER_FUNCTION);

        return;
      default:
        emitDetachedReasoning(signatureInput, CARRIER_STANDALONE, CARRIER_ANY);
    }
  };

  const failToolInput = (error: string): void => {
    setToolInputError(error);
    st.completed = true;
    emit("response.failed", applyPatchFailure(st.responseId, nextSeq()));
  };

  // Initialize per-response fields and emit created/in_progress once.
  if (!st.started) {
    st.responseId = asString(get(root, "responseId"));

    if (st.responseId === "") st.responseId = newResponseId();

    if (!st.responseId.startsWith("resp_")) st.responseId = `resp_${st.responseId}`;
    const createdAt = parseCreateTime(get(root, "createTime"));
    st.createdAt =
      createdAt === undefined || createdAt === 0 ? Math.floor(Date.now() / 1000) : createdAt;
    let requestModelName = requestModelNameOf(originalRequest, translatedRequest);

    if (requestModelName === "") requestModelName = modelName;

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

    if (requestModelName !== "")
      // SAFETY: `created.response` is the object literal built just above.
      (created["response"] as JsonObject)["model"] = requestModelName;
    emit("response.created", created);

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

    if (requestModelName !== "")
      // SAFETY: `inProgress.response` is the object literal built just above.
      (inProgress["response"] as JsonObject)["model"] = requestModelName;
    emit("response.in_progress", inProgress);
    st.started = true;
    st.nextIndex = 0;
    st.webSearchStreamMode = determineWebSearchStreamMode(
      modelName,
      requestModelName,
      originalRequest,
      translatedRequest,
    );
  }

  // Handle groundingMetadata for web search.
  const groundingMetadata = extractGroundingMetadata(root);

  if (groundingMetadata !== undefined) {
    st.rawGroundingMetadata = mergeGroundingMetadata(st.rawGroundingMetadata, groundingMetadata);
    const merged = st.rawGroundingMetadata;
    const queries = extractGroundingQueries(merged);

    if (queries.length > 0) {
      st.webSearchQueries = queries;

      if (st.webSearchQuery === "")
        // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
        st.webSearchQuery = queries[0] as string;
    }

    const sources = extractGroundingSources(merged);

    if (sources.length > 0) st.webSearchSources = sources;

    // Function calls, thoughts, or signature boundaries may finalize the search item before later grounding frames
    // arrive: keep the cached completed item aligned with the latest queries and sources.
    if (st.webSearchDone) {
      st.webSearchDoneItem = buildResponsesWebSearchCallItem(
        st.webSearchItemId,
        st.webSearchQuery,
        st.webSearchQueries,
        st.webSearchSources,
      );
    }

    if (!st.webSearchOpened && hasValidWebGrounding(merged)) openWebSearch();
    emitLateCitations();
  }

  /** One `candidates.0.content.parts` entry; `false` stops the iteration (terminal failure). */
  const handlePart = (part: Json, partIdxInChunk: number): boolean => {
    let explicitPartIndex = -1;
    const partIndexValue = get(part, "partIndex");
    const indexValue = get(part, "index");

    if (partIndexValue !== undefined) explicitPartIndex = asInt(partIndexValue);
    else if (indexValue !== undefined) explicitPartIndex = asInt(indexValue);

    let signature = asString(get(part, "thoughtSignature")).trim();

    if (signature === "") signature = asString(get(part, "thought_signature")).trim();
    const functionCall = get(part, "functionCall");
    const text = get(part, "text");
    const isThought = asBool(get(part, "thought"));
    const textString = asString(text);

    let partKind: string;

    if (isThought) partKind = "thought";
    else if (functionCall !== undefined) partKind = "function";
    else if (text !== undefined) partKind = "text";
    else partKind = "unknown";

    let currentPartIndex: number;

    if (explicitPartIndex >= 0) {
      currentPartIndex = explicitPartIndex;
      st.currentLogicalPartIndex = explicitPartIndex;
      st.currentPartKind = partKind;
      st.hasSeenFirstPart = true;
      st.textPartRunActive = partKind === "text";
    } else if (!st.hasSeenFirstPart) {
      st.hasSeenFirstPart = true;
      st.currentLogicalPartIndex = 0;
      st.currentPartKind = partKind;
      currentPartIndex = 0;

      if (partKind === "text") st.textPartRunActive = true;
    } else {
      if (partIdxInChunk > 0) {
        st.currentLogicalPartIndex++;
        st.currentPartKind = partKind;
        st.textPartRunActive = partKind === "text";
      } else if (partKind !== st.currentPartKind) {
        st.currentLogicalPartIndex++;
        st.currentPartKind = partKind;
        st.textPartRunActive = partKind === "text";
      } else if (partKind === "function") {
        st.currentLogicalPartIndex++;
        st.currentPartKind = partKind;
        st.textPartRunActive = false;
      } else if (partKind === "text" && !st.textPartRunActive) {
        st.currentLogicalPartIndex++;
        st.currentPartKind = partKind;
        st.textPartRunActive = true;
      }

      currentPartIndex = st.currentLogicalPartIndex;
    }

    st.streamPartIndex = currentPartIndex;

    if (functionCall !== undefined && st.pendingReasoningSignature !== "") {
      if (signature === "")
        emitDetachedReasoning(st.pendingReasoningSignature, CARRIER_NEXT, CARRIER_FUNCTION);
      else emitTrailingDetachedReasoning(st.pendingReasoningSignature);
      st.pendingReasoningSignature = "";
    }

    const reasoningActive =
      (st.reasoningOpened && !st.reasoningClosed) ||
      (!st.reasoningOpened && (st.reasoningBuf.length > 0 || st.reasoningEnc !== ""));

    if (signature !== "" && !isThought) {
      if (reasoningActive) {
        if (st.reasoningEnc === "" || st.reasoningEnc === signature) {
          st.reasoningEnc = signature;

          if (functionCall !== undefined) {
            st.reasoningDirection = CARRIER_NEXT;
            st.reasoningTargetKind = CARRIER_FUNCTION;
          } else if (text !== undefined && textString !== "") {
            st.reasoningDirection = CARRIER_NEXT;
            st.reasoningTargetKind = CARRIER_TEXT;
          } else {
            st.reasoningDirection = CARRIER_STANDALONE;
            st.reasoningTargetKind = CARRIER_TEXT;
          }

          st.seenReasoningSignatures.add(signature);
        } else {
          finalizeReasoning();

          if (functionCall !== undefined)
            emitDetachedReasoning(signature, CARRIER_NEXT, CARRIER_FUNCTION);
          else if (!st.seenReasoningSignatures.has(signature))
            st.pendingReasoningSignature = signature;
        }

        if (text !== undefined && textString === "" && functionCall === undefined) {
          finalizeReasoning();

          return true;
        }
      } else if (functionCall !== undefined) {
        emitDetachedReasoning(signature, CARRIER_NEXT, CARRIER_FUNCTION);
      } else if (text !== undefined && textString !== "") {
        if (st.pendingReasoningSignature !== "" && st.pendingReasoningSignature !== signature) {
          emitTrailingDetachedReasoning(st.pendingReasoningSignature);
          st.pendingReasoningSignature = "";
        }

        if (!st.seenReasoningSignatures.has(signature)) st.pendingReasoningSignature = signature;
      } else if (text !== undefined && textString === "") {
        if (st.pendingReasoningSignature !== "") {
          const pending = st.pendingReasoningSignature;
          st.pendingReasoningSignature = "";

          if (pending !== signature) emitTrailingDetachedReasoning(pending);
        }

        if (st.msgOpened || st.funcDone.size > 0 || st.webSearchBufferedDeltas.length > 0) {
          emitTrailingDetachedReasoning(signature);
        } else if (!st.seenReasoningSignatures.has(signature)) {
          st.pendingReasoningSignature = signature;
        }

        return true;
      }
    }

    // Reasoning text.
    if (isThought) {
      if (st.webSearchBufferedDeltas.length > 0) finalizeMessage();

      if (st.pendingReasoningSignature !== "" && st.msgOpened && !st.msgClosed) {
        emitTrailingDetachedReasoning(st.pendingReasoningSignature);
        st.pendingReasoningSignature = "";
      }

      let incomingSignature = "";

      if (signature !== "" && signature !== THOUGHT_SIGNATURE_BYPASS) {
        if (st.pendingReasoningSignature !== "") {
          if (st.pendingReasoningSignature !== signature) {
            emitDetachedReasoning(st.pendingReasoningSignature, CARRIER_STANDALONE, CARRIER_ANY);
          }

          st.pendingReasoningSignature = "";
        }

        incomingSignature = signature;
      } else if (st.pendingReasoningSignature !== "") {
        incomingSignature = st.pendingReasoningSignature;
        st.pendingReasoningSignature = "";
      }

      if (
        st.reasoningOpened &&
        !st.reasoningClosed &&
        incomingSignature !== "" &&
        st.reasoningEnc !== "" &&
        incomingSignature !== st.reasoningEnc
      ) {
        finalizeReasoning();
        resetReasoning();
      }

      if (st.reasoningClosed) {
        finalizeMessage();
        resetReasoning();
      } else if (
        !st.reasoningOpened &&
        st.reasoningBuf.length === 0 &&
        st.msgOpened &&
        !st.msgClosed
      ) {
        finalizeMessage();
      }

      if (incomingSignature !== "") {
        st.reasoningEnc = incomingSignature;
        st.reasoningDirection = CARRIER_STANDALONE;
        st.reasoningTargetKind = CARRIER_TEXT;
        st.seenReasoningSignatures.add(incomingSignature);
      }

      if (text !== undefined && textString !== "") {
        st.lastSemanticKind = CARRIER_TEXT;
        st.reasoningBuf += textString;

        if (st.reasoningOpened) {
          emit("response.reasoning_summary_text.delta", {
            type: "response.reasoning_summary_text.delta",
            sequence_number: nextSeq(),
            item_id: st.reasoningItemId,
            output_index: st.reasoningIndex,
            summary_index: 0,
            delta: textString,
          });
        } else {
          st.reasoningPendingDeltas.push(textString);
        }
      }

      if (!st.reasoningOpened && st.reasoningEnc !== "") openReasoning();

      return true;
    }

    // Assistant visible text.
    if (text !== undefined && textString !== "") {
      if (
        signature === "" &&
        st.pendingReasoningSignature !== "" &&
        ((st.msgOpened && !st.msgClosed) || st.webSearchBufferedDeltas.length > 0)
      ) {
        emitTrailingDetachedReasoning(st.pendingReasoningSignature);
        st.pendingReasoningSignature = "";
      }

      // Responses output items are sequential: finish reasoning before opening the visible message. A signature that
      // arrives later is cached with the message and recombined on replay.
      finalizeReasoning();

      if (st.msgClosed) {
        st.msgOpened = false;
        st.msgClosed = false;
        st.itemTextBuf = "";
        st.currentMsgRuneOffset = 0;
      }

      // In web search stream mode, deltas are buffered until web_search_call is finalized so the completed search item
      // includes incremental sources and strictly precedes the message.
      if (st.webSearchStreamMode && !st.webSearchDone) {
        st.lastSemanticKind = CARRIER_TEXT;
        st.webSearchBufferedDeltas.push(textString);
        const last = st.webSearchBufferedParts[st.webSearchBufferedParts.length - 1];

        if (last !== undefined && last.partIndex === currentPartIndex) last.text += textString;
        else st.webSearchBufferedParts.push({ partIndex: currentPartIndex, text: textString });
        st.textPartRunActive = true;

        return true;
      }

      if (!st.msgOpened) openMessage();
      st.lastSemanticKind = CARRIER_TEXT;
      st.itemTextBuf += textString;
      const last = st.partMappings[st.partMappings.length - 1];

      if (
        last !== undefined &&
        last.partIndex === currentPartIndex &&
        last.messageIndex === st.msgIndex
      ) {
        last.partText += textString;
      } else {
        st.partMappings.push({
          partIndex: currentPartIndex,
          messageIndex: st.msgIndex,
          startRuneInMsg: st.currentMsgRuneOffset,
          partText: textString,
        });
      }

      st.currentMsgRuneOffset += runeLength(textString);
      textDelta(textString);
      st.textPartRunActive = true;

      return true;
    }

    // Function call.
    if (functionCall === undefined) return true;
    // Finalize reasoning, web search and the open message before emitting function-call outputs: Responses streaming
    // requires message done events before the next output_item.added.
    finalizeReasoning();
    finalizeWebSearch();

    if (st.webSearchBufferedDeltas.length > 0) flushWebSearchBufferedText();
    finalizeMessage();
    st.lastSemanticKind = CARRIER_FUNCTION;

    const evidence = recordFunctionEvidence(st, functionCall, explicitPartIndex, true);

    if (evidence.applyPatch && evidence.err !== undefined) {
      failToolInput(evidence.err);

      return false;
    }

    if (evidence.rawName === "") return true;
    let rawName = asString(get(functionCall, "name"));

    if (evidence.applyPatch) rawName = evidence.rawName;
    let identity: ResponsesToolIdentity | undefined = st.toolIdentityMap.get(rawName);

    if (identity === undefined) {
      identity = {
        name: restoreSanitizedToolName(st.sanitizedNameMap, rawName),
        namespace: "",
        custom: false,
        applyPatch: false,
      };
    }

    const { name, namespace } = identity;
    const isCustom = identity.custom;
    const isToolSearch = identity.toolSearch === true;
    const argsValue = get(functionCall, "args");
    const argsRaw = argsValue === undefined ? "" : JSON.stringify(argsValue);

    if (evidence.applyPatch && evidence.patchCall !== undefined) {
      const finished = finishApplyPatchArguments(argsRaw);

      if ("error" in finished) {
        failToolInput(finished.error);

        return false;
      }

      return true;
    }

    const idx = st.nextIndex;
    st.nextIndex++;

    if (!st.funcArgsBuf.has(idx)) st.funcArgsBuf.set(idx, "");

    if (identity.applyPatch || isToolSearch) st.funcCallIds.set(idx, evidence.upstreamId);

    if ((st.funcCallIds.get(idx) ?? "") === "") st.funcCallIds.set(idx, newStreamCallId());
    // SAFETY: the entry was set on the line above when it was missing or empty.
    const callId = st.funcCallIds.get(idx) as string;
    st.funcNames.set(idx, name);
    st.funcNamespaces.set(idx, namespace);
    st.funcCustom.set(idx, isCustom);
    st.funcToolSearch.set(idx, isToolSearch);

    const argsJson = argsValue === undefined ? "{}" : argsRaw;

    if ((st.funcArgsBuf.get(idx) ?? "").length === 0 && argsJson !== "")
      st.funcArgsBuf.set(idx, argsJson);

    if (isToolSearch) {
      // The call is a client `tool_search_call` item: it carries its arguments as an object, so no
      // function-argument events are emitted.
      let itemStatus = "completed";
      const callFinish = asString(get(root, "candidates.0.finishReason"));

      if (callFinish !== "") itemStatus = terminalState(callFinish).status;
      else if (st.finishReason !== "") itemStatus = terminalState(st.finishReason).status;
      emit("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: idx,
        item: buildToolSearchCallItem(callId, "in_progress", argsJson),
      });

      if (st.funcDone.get(idx) !== true) {
        emit("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: idx,
          item: buildToolSearchCallItem(callId, itemStatus, argsJson),
        });
        st.funcDone.set(idx, true);
      }
    } else if (isCustom) {
      let inputStr = unwrapResponsesCustomToolInput(argsJson);
      let patchCall: ApplyPatchCall | undefined;

      if (identity.applyPatch) {
        patchCall = { itemId: `ctc_${callId}`, callId, name, namespace, outputIndex: idx };
        const finished = finishApplyPatchArguments(argsJson);

        if ("error" in finished) {
          failToolInput(finished.error);

          return false;
        }

        inputStr = finished.input;
        evidence.patchCall = patchCall;
      }

      st.funcInputBuf.set(idx, inputStr);

      const added: JsonObject = {
        id: `ctc_${callId}`,
        type: "custom_tool_call",
        status: "in_progress",
        input: "",
        call_id: callId,
        name: "",
      };

      setToolCallIdentity(added, name, namespace);
      emit("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: idx,
        item: added,
      });

      // Gemini delivers complete arguments; this delta is not an early preview.
      if (patchCall !== undefined && inputStr !== "") {
        emit(
          "response.custom_tool_call_input.delta",
          applyPatchInputDelta(patchCall, inputStr, nextSeq()),
        );
      }

      if (st.funcDone.get(idx) !== true) {
        const inputDone =
          patchCall !== undefined
            ? applyPatchInputDone(patchCall, inputStr, nextSeq())
            : {
                type: "response.custom_tool_call_input.done",
                sequence_number: nextSeq(),
                item_id: `ctc_${callId}`,
                output_index: idx,
                input: inputStr,
              };

        emit("response.custom_tool_call_input.done", inputDone);

        const itemDone: JsonObject = {
          id: `ctc_${callId}`,
          type: "custom_tool_call",
          status: "completed",
          input: inputStr,
          call_id: callId,
          name: "",
        };

        setToolCallIdentity(itemDone, name, namespace);
        emit("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: idx,
          item: itemDone,
        });
        st.funcDone.set(idx, true);
      }
    } else {
      const added: JsonObject = {
        id: `fc_${callId}`,
        type: "function_call",
        status: "in_progress",
        arguments: "",
        call_id: callId,
        name: "",
      };

      setToolCallIdentity(added, name, namespace);
      emit("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: idx,
        item: added,
      });

      // Gemini sends the full call at once; "{}" keeps the Responses event order when args are omitted.
      if (argsJson !== "") {
        emit("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          sequence_number: nextSeq(),
          item_id: `fc_${callId}`,
          output_index: idx,
          delta: argsJson,
        });
      }

      if (st.funcDone.get(idx) !== true) {
        emit("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          sequence_number: nextSeq(),
          item_id: `fc_${callId}`,
          output_index: idx,
          arguments: argsJson,
        });

        const itemDone: JsonObject = {
          id: `fc_${callId}`,
          type: "function_call",
          status: "completed",
          arguments: argsJson,
          call_id: callId,
          name: "",
        };

        setToolCallIdentity(itemDone, name, namespace);
        emit("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: idx,
          item: itemDone,
        });
        st.funcDone.set(idx, true);
      }
    }

    return true;
  };

  const parts = get(root, "candidates.0.content.parts");

  if (isJsonArray(parts)) {
    for (let index = 0; index < parts.length; index++) {
      // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      if (!handlePart(parts[index] as Json, index)) break;
    }
  }

  if (st.completed) return out;

  // Preserve the first source finish, including across a usage-only tail or [DONE].
  const finishReason = asString(get(root, "candidates.0.finishReason"));

  if (finishReason !== "" && st.finishReason === "") st.finishReason = finishReason;

  if (st.finishReason !== "") {
    const identityError = pendingIdentityError(st);

    if (identityError !== undefined) {
      failToolInput(identityError);

      return out;
    }

    if (!done && !hasUsage) return out;
    const { eventType, status, incompleteDetails } = terminalState(st.finishReason);
    messageStatus = status;

    if (st.pendingReasoningSignature !== "") {
      emitTrailingDetachedReasoning(st.pendingReasoningSignature);
      st.pendingReasoningSignature = "";
    }

    // Finalize web search with the complete incremental sources, then reasoning, then the message so web_search_call
    // precedes later output items.
    finalizeWebSearch();
    finalizeReasoning();
    finalizeMessage();

    // Close function calls in output order.
    for (const idx of [...st.funcArgsBuf.keys()].toSorted((a, b) => a - b)) {
      if (st.funcDone.get(idx) === true) continue;
      const callId = st.funcCallIds.get(idx) ?? "";

      if (st.funcToolSearch.get(idx) === true) {
        const buffered = st.funcArgsBuf.get(idx) ?? "";
        emit("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: idx,
          item: buildToolSearchCallItem(callId, status, buffered.length > 0 ? buffered : "{}"),
        });
      } else if (st.funcCustom.get(idx) === true) {
        const inputStr = st.funcInputBuf.get(idx) ?? "";
        emit("response.custom_tool_call_input.done", {
          type: "response.custom_tool_call_input.done",
          sequence_number: nextSeq(),
          item_id: `ctc_${callId}`,
          output_index: idx,
          input: inputStr,
        });

        const itemDone: JsonObject = {
          id: `ctc_${callId}`,
          type: "custom_tool_call",
          status: "completed",
          input: inputStr,
          call_id: callId,
          name: "",
        };

        setToolCallIdentity(
          itemDone,
          st.funcNames.get(idx) ?? "",
          st.funcNamespaces.get(idx) ?? "",
        );
        emit("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: idx,
          item: itemDone,
        });
      } else {
        const buffered = st.funcArgsBuf.get(idx) ?? "";
        const args = buffered.length > 0 ? buffered : "{}";
        emit("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          sequence_number: nextSeq(),
          item_id: `fc_${callId}`,
          output_index: idx,
          arguments: args,
        });

        const itemDone: JsonObject = {
          id: `fc_${callId}`,
          type: "function_call",
          status: "completed",
          arguments: args,
          call_id: callId,
          name: "",
        };

        setToolCallIdentity(
          itemDone,
          st.funcNames.get(idx) ?? "",
          st.funcNamespaces.get(idx) ?? "",
        );
        emit("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: idx,
          item: itemDone,
        });
      }

      st.funcDone.set(idx, true);
    }

    // Terminal response with the aggregated outputs and request echo fields.
    const response: JsonObject = {
      id: st.responseId,
      object: "response",
      created_at: st.createdAt,
      status,
      background: false,
      error: null,
    };

    const completed: JsonObject = { type: eventType, sequence_number: 0, response };

    if (incompleteDetails !== undefined) response["incomplete_details"] = incompleteDetails;
    completed["sequence_number"] = nextSeq();
    const requestJson = pickRequestJson(originalRequest, translatedRequest);

    if (requestJson !== undefined) echoRequestFields(response, "", unwrapRequestRoot(requestJson));

    emitLateCitations();

    // Compose outputs in output_index order.
    const outputs: Json[] = [];

    for (let idx = 0; idx < st.nextIndex; idx++) {
      if (st.webSearchDone && idx === st.webSearchIndex) {
        outputs.push(
          buildResponsesWebSearchCallItem(
            st.webSearchItemId,
            st.webSearchQuery,
            st.webSearchQueries,
            st.webSearchSources,
          ),
        );
        continue;
      }

      const completedReasoning = st.completedReasoning.get(idx);

      if (completedReasoning !== undefined) {
        outputs.push({
          id: completedReasoning.id,
          type: "reasoning",
          encrypted_content: completedReasoning.signature,
          summary: [{ type: "summary_text", text: completedReasoning.text }],
        });
        continue;
      }

      const completedMessage = st.completedMessages.get(idx);

      if (completedMessage !== undefined) {
        outputs.push({
          id: completedMessage.id,
          type: "message",
          status: completedMessage.status,
          content: [
            {
              type: "output_text",
              annotations: completedMessage.annotations,
              logprobs: [],
              text: completedMessage.text,
            },
          ],
          role: "assistant",
        });
        continue;
      }

      const detached = st.detachedReasoning.get(idx);

      if (detached !== undefined) {
        outputs.push({
          id: detached.id,
          type: "reasoning",
          encrypted_content: detached.signature,
          summary: [],
        });
        continue;
      }

      const callId = st.funcCallIds.get(idx);

      if (callId !== undefined && callId !== "") {
        if (st.funcToolSearch.get(idx) === true) {
          const buffered = st.funcArgsBuf.get(idx) ?? "";
          outputs.push(
            buildToolSearchCallItem(callId, status, buffered.length > 0 ? buffered : "{}"),
          );
        } else if (st.funcCustom.get(idx) === true) {
          const item: JsonObject = {
            id: `ctc_${callId}`,
            type: "custom_tool_call",
            status: "completed",
            input: st.funcInputBuf.get(idx) ?? "",
            call_id: callId,
            name: "",
          };

          setToolCallIdentity(item, st.funcNames.get(idx) ?? "", st.funcNamespaces.get(idx) ?? "");
          outputs.push(item);
        } else {
          const buffered = st.funcArgsBuf.get(idx) ?? "";

          const item: JsonObject = {
            id: `fc_${callId}`,
            type: "function_call",
            status: "completed",
            arguments: buffered.length > 0 ? buffered : "{}",
            call_id: callId,
            name: "",
          };

          setToolCallIdentity(item, st.funcNames.get(idx) ?? "", st.funcNamespaces.get(idx) ?? "");
          outputs.push(item);
        }
      }
    }

    if (outputs.length > 0) response["output"] = outputs;

    if (st.webSearchDone) response["tool_usage"] = { web_search: { num_requests: 1 } };

    if (st.usage.present) response["usage"] = usageJson(st.usage);
    emit(eventType, completed);
    st.completed = true;
  }

  return out;
};
