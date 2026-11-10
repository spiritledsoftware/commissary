/**
 * Gemini provider -> OpenAI Responses client: non-streaming response conversion.
 *
 * Go source: internal/translator/gemini/openai/responses/gemini_openai-responses_response.go
 * (ConvertGeminiResponseToOpenAIResponsesNonStream).
 */
import {
  asBool,
  asInt,
  asString,
  get,
  isJsonArray,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import type { ResponseContext } from "../../../registry.ts";
import { restoreSanitizedToolName, sanitizedToolNameMap } from "../../../common/tool-names.ts";
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
  echoRequestFields,
  type EvidenceState,
  finishApplyPatchArguments,
  mergeUsage,
  newNonStreamCallId,
  newResponseId,
  newUsage,
  parseCreateTime,
  pendingIdentityError,
  pickRequestJson,
  recordFunctionEvidence,
  setToolCallIdentity,
  terminalState,
  unwrapGeminiResponseRoot,
  unwrapRequestRoot,
  usageJson,
} from "./response-common.ts";
import {
  type ResponsesToolIdentity,
  unwrapResponsesCustomToolInput,
} from "../../../common/responses-tools.ts";
import { buildToolSearchCallItem, toolSearchCallItemId } from "./tool-search.ts";
import { responsesToolReverseIdentityMap } from "./tools.ts";
import {
  buildResponsesUrlCitationsForMessages,
  buildResponsesWebSearchCallItem,
  extractGroundingMetadata,
  extractGroundingQueries,
  extractGroundingSources,
  extractResponsesWebSearchQuery,
  type GeminiPartMapping,
  hasValidWebGrounding,
} from "./web-search.ts";

interface ReasoningOutput {
  text: string;
  signature: string;
  direction: string;
  targetKind: string;
}

interface FunctionOutput {
  item: JsonObject;
  signature: string;
}

interface DetachedOutput {
  signature: string;
  direction: string;
  targetKind: string;
}

interface MessageOutput {
  text: string;
  signatures: string[];
}

interface OutputOrder {
  kind: "reasoning" | "message" | "function" | "detached";
  index: number;
}

const runeLength = (text: string): number => {
  let count = 0;

  for (const _ of text) {
    void _;
    count++;
  }

  return count;
};

const stripResponsePrefix = (id: string): string => (id.startsWith("resp_") ? id.slice(5) : id);

/** `ConvertGeminiResponseToOpenAIResponsesNonStream`: `undefined` when a retained tool-input error aborts it. */
export const convertGeminiResponseToOpenAIResponsesNonStream = (
  context: ResponseContext,
  body: string,
): string | undefined => {
  const parsed = tryParseJson(body);
  const root = unwrapGeminiResponseRoot(parsed);
  const originalRequest = context.originalRequest;
  const reqJson = pickRequestJson(originalRequest, context.translatedRequest);
  const sanitizedNames = sanitizedToolNameMap(originalRequest);
  const toolIdentityMap = responsesToolReverseIdentityMap(reqJson);

  const resp: JsonObject = {
    id: "",
    object: "response",
    created_at: 0,
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
  };

  const { status, incompleteDetails } = terminalState(
    asString(get(root, "candidates.0.finishReason")),
  );

  resp["status"] = status;

  if (incompleteDetails !== undefined) resp["incomplete_details"] = incompleteDetails;

  let id = asString(get(root, "responseId"));

  if (id === "") id = newResponseId();

  if (!id.startsWith("resp_")) id = `resp_${id}`;
  resp["id"] = id;
  resp["created_at"] = parseCreateTime(get(root, "createTime")) ?? Math.floor(Date.now() / 1000);

  // Echo request fields when present; fall back to the response modelVersion for the model.
  if (reqJson !== undefined) {
    echoRequestFields(resp, "", unwrapRequestRoot(reqJson), get(root, "modelVersion"));
  } else {
    const modelVersion = get(root, "modelVersion");

    if (modelVersion !== undefined) resp["model"] = asString(modelVersion);
  }

  // Outputs from candidates[0].content.parts.
  let reasoningText = "";
  let reasoningEncrypted = "";
  let reasoningDirection = "";
  let reasoningTargetKind = "";
  const reasoningOutputs: ReasoningOutput[] = [];
  const functionOutputs: FunctionOutput[] = [];
  const messageOutputs: MessageOutput[] = [];
  const outputOrder: OutputOrder[] = [];
  const reasoningOutputSignatures = new Set<string>();

  const flushReasoningOutput = (): void => {
    if (reasoningText.length === 0 && reasoningEncrypted === "") return;
    const reasoningIndex = reasoningOutputs.length;
    reasoningOutputs.push({
      text: reasoningText,
      signature: reasoningEncrypted,
      direction: reasoningDirection,
      targetKind: reasoningTargetKind,
    });
    outputOrder.push({ kind: "reasoning", index: reasoningIndex });

    if (reasoningEncrypted !== "") reasoningOutputSignatures.add(reasoningEncrypted);
    reasoningText = "";
    reasoningEncrypted = "";
    reasoningDirection = "";
    reasoningTargetKind = "";
  };

  const detachedReasoningOutputs: DetachedOutput[] = [];
  let currentMessageText = "";
  let currentMessageSignatures: string[] = [];
  const partMappings: GeminiPartMapping[] = [];
  let currentMsgRuneOffset = 0;

  const flushMessageOutput = (): void => {
    if (currentMessageText.length === 0) return;
    const messageIndex = messageOutputs.length;
    messageOutputs.push({ text: currentMessageText, signatures: [...currentMessageSignatures] });
    outputOrder.push({ kind: "message", index: messageIndex });
    currentMessageText = "";
    currentMessageSignatures = [];
    currentMsgRuneOffset = 0;
  };

  let toolInputError: string | undefined;
  const evidenceState: EvidenceState = { toolIdentityMap, functionEvidence: undefined };
  const outputs: Json[] = [];
  let detachedOutputIndex = 0;
  const seenDetachedOutputs = new Set<string>();

  const appendDetachedOutput = (signature: string, direction: string, targetKind: string): void => {
    if (signature === "" || seenDetachedOutputs.has(signature)) return;
    seenDetachedOutputs.add(signature);
    const placement = direction === CARRIER_PREVIOUS ? "after" : "before";
    outputs.push({
      id: `rs_${stripResponsePrefix(id)}_detached_${placement}_${detachedOutputIndex}`,
      type: "reasoning",
      encrypted_content: encodeCarrier(signature, direction, targetKind),
      summary: [],
    });
    detachedOutputIndex++;
  };

  const addDetached = (signature: string, direction: string, targetKind: string): void => {
    const detachedIndex = detachedReasoningOutputs.length;
    detachedReasoningOutputs.push({ signature, direction, targetKind });
    outputOrder.push({ kind: "detached", index: detachedIndex });
  };

  /** One part; `false` stops the iteration. */
  const handlePart = (p: Json, key: number): boolean => {
    let partIdx = key;

    if (get(p, "partIndex") !== undefined) partIdx = asInt(get(p, "partIndex"));
    else if (get(p, "index") !== undefined) partIdx = asInt(get(p, "index"));
    let signature = asString(get(p, "thoughtSignature")).trim();

    if (signature === "") signature = asString(get(p, "thought_signature")).trim();
    const text = get(p, "text");

    if (asBool(get(p, "thought"))) {
      flushMessageOutput();
      currentMsgRuneOffset = 0;

      if (signature !== "" && reasoningEncrypted !== "" && signature !== reasoningEncrypted)
        flushReasoningOutput();

      if (text !== undefined) reasoningText += asString(text);

      if (signature !== "") {
        reasoningEncrypted = signature;
        reasoningDirection = CARRIER_STANDALONE;
        reasoningTargetKind = CARRIER_TEXT;
      }

      return true;
    }

    if (text !== undefined && asString(text) !== "") {
      let messageSignature = "";

      if (signature !== "") {
        if (reasoningText.length > 0 && reasoningEncrypted === "") {
          reasoningEncrypted = signature;
          reasoningDirection = CARRIER_NEXT;
          reasoningTargetKind = CARRIER_TEXT;
        } else {
          messageSignature = signature;
        }
      }

      flushReasoningOutput();

      if (
        currentMessageSignatures.length > 0 &&
        (messageSignature === "" ||
          currentMessageSignatures[currentMessageSignatures.length - 1] !== messageSignature)
      ) {
        flushMessageOutput();
        currentMsgRuneOffset = 0;
      }

      const partText = asString(text);
      partMappings.push({
        partIndex: partIdx,
        messageIndex: messageOutputs.length,
        startRuneInMsg: currentMsgRuneOffset,
        partText,
      });
      currentMsgRuneOffset += runeLength(partText);
      currentMessageText += partText;

      if (
        messageSignature !== "" &&
        (currentMessageSignatures.length === 0 ||
          currentMessageSignatures[currentMessageSignatures.length - 1] !== messageSignature)
      ) {
        currentMessageSignatures.push(messageSignature);
      }

      return true;
    }

    const fc = get(p, "functionCall");

    if (fc !== undefined) {
      if (reasoningText.length > 0 && reasoningEncrypted === "" && signature !== "") {
        reasoningEncrypted = signature;
        reasoningDirection = CARRIER_NEXT;
        reasoningTargetKind = CARRIER_FUNCTION;
        signature = "";
      }

      flushReasoningOutput();
      flushMessageOutput();
      currentMsgRuneOffset = 0;

      let explicitIndex = -1;

      if (get(p, "partIndex") !== undefined) explicitIndex = asInt(get(p, "partIndex"));
      else if (get(p, "index") !== undefined) explicitIndex = asInt(get(p, "index"));

      const evidence = recordFunctionEvidence(
        evidenceState,
        fc,
        explicitIndex,
        parsed !== undefined,
      );

      if (evidence.applyPatch && evidence.err !== undefined) {
        toolInputError = evidence.err;

        return false;
      }

      if (evidence.rawName === "") return true;
      let rawName = asString(get(fc, "name"));

      if (evidence.applyPatch) rawName = evidence.rawName;
      let identity: ResponsesToolIdentity | undefined = toolIdentityMap.get(rawName);

      if (identity === undefined) {
        identity = {
          name: restoreSanitizedToolName(sanitizedNames, rawName),
          namespace: "",
          custom: false,
          applyPatch: false,
        };
      }

      const { name, namespace } = identity;
      const isCustom = identity.custom;
      const argsValue = get(fc, "args");
      const argsStr = argsValue === undefined ? "" : JSON.stringify(argsValue);

      if (identity.applyPatch && evidence.patchCall !== undefined) {
        const finished = finishApplyPatchArguments(argsStr);

        if ("error" in finished) {
          toolInputError = finished.error;

          return false;
        }

        return true;
      }

      let callId = newNonStreamCallId();

      if ((identity.applyPatch || identity.toolSearch === true) && evidence.upstreamId !== "")
        callId = evidence.upstreamId;
      let item: JsonObject;

      if (identity.toolSearch === true) {
        item = buildToolSearchCallItem(toolSearchCallItemId(callId), callId, status, argsStr);
      } else if (isCustom) {
        let inputStr = unwrapResponsesCustomToolInput(argsStr);

        if (identity.applyPatch) {
          const finished = finishApplyPatchArguments(argsStr);

          if ("error" in finished) {
            toolInputError = finished.error;

            return false;
          }

          inputStr = finished.input;
          evidence.patchCall = {
            itemId: `ctc_${callId}`,
            callId,
            name,
            namespace,
            outputIndex: 0,
          };
        }

        item = {
          id: `ctc_${callId}`,
          type: "custom_tool_call",
          status: "completed",
          input: inputStr,
          call_id: callId,
          name: "",
        };
      } else {
        item = {
          id: `fc_${callId}`,
          type: "function_call",
          status: "completed",
          arguments: argsStr,
          call_id: callId,
          name: "",
        };
      }

      setToolCallIdentity(item, name, namespace);
      const functionIndex = functionOutputs.length;
      functionOutputs.push({ item, signature });
      outputOrder.push({ kind: "function", index: functionIndex });

      return true;
    }

    if (signature !== "") {
      if (reasoningText.length > 0) {
        if (reasoningEncrypted === "") {
          reasoningEncrypted = signature;
          reasoningDirection = CARRIER_STANDALONE;
          reasoningTargetKind = CARRIER_TEXT;
        } else if (reasoningEncrypted !== signature) {
          flushReasoningOutput();
          addDetached(signature, CARRIER_PREVIOUS, CARRIER_TEXT);
        }
      } else if (currentMessageText.length > 0) {
        if (currentMessageSignatures.length === 0) {
          currentMessageSignatures.push(signature);
        } else if (currentMessageSignatures[currentMessageSignatures.length - 1] !== signature) {
          flushMessageOutput();
          currentMsgRuneOffset = 0;
          addDetached(signature, CARRIER_PREVIOUS, CARRIER_TEXT);
        }
      } else if (functionOutputs.length > 0) {
        addDetached(signature, CARRIER_PREVIOUS, CARRIER_FUNCTION);
      } else {
        addDetached(signature, CARRIER_NEXT, CARRIER_ANY);
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

  toolInputError ??= pendingIdentityError(evidenceState);

  if (toolInputError !== undefined) {
    context.state.toolInputError = toolInputError;

    return undefined;
  }

  const activeMessageIndex = currentMessageText.length > 0 ? messageOutputs.length : -1;
  flushReasoningOutput();
  flushMessageOutput();

  // Web search from groundingMetadata.
  const groundingMetadata = extractGroundingMetadata(root);
  const hasGrounding = hasValidWebGrounding(groundingMetadata);
  let wsItem: Json | undefined;
  let messageCitations = new Map<number, Json[]>();

  if (hasGrounding) {
    const queries = extractGroundingQueries(groundingMetadata);
    let query = queries[0] ?? "";

    if (query === "" && reqJson !== undefined)
      query = extractResponsesWebSearchQuery(unwrapRequestRoot(reqJson));
    const sources = extractGroundingSources(groundingMetadata);
    wsItem = buildResponsesWebSearchCallItem(
      `ws_${stripResponsePrefix(id)}`,
      query,
      queries,
      sources,
    );
    messageCitations = buildResponsesUrlCitationsForMessages(
      groundingMetadata,
      partMappings,
      messageOutputs.map((message) => message.text),
    );
  }

  let wsAppended = false;

  for (const outputItem of outputOrder) {
    switch (outputItem.kind) {
      case "detached": {
        const detached = detachedReasoningOutputs[outputItem.index];

        if (detached === undefined) continue;

        if (!reasoningOutputSignatures.has(detached.signature)) {
          appendDetachedOutput(detached.signature, detached.direction, detached.targetKind);
        }

        break;
      }

      case "reasoning": {
        const reasoningOutput = reasoningOutputs[outputItem.index];

        if (reasoningOutput === undefined) continue;
        const rid = stripResponsePrefix(id);

        const reasoningId =
          reasoningOutputs.length > 1 ? `rs_${rid}_${outputItem.index}` : `rs_${rid}`;

        let encryptedContent = reasoningOutput.signature;

        if (encryptedContent !== "" && reasoningOutput.direction !== "") {
          encryptedContent = encodeCarrier(
            encryptedContent,
            reasoningOutput.direction,
            reasoningOutput.targetKind,
          );
        }

        const item: JsonObject = {
          id: reasoningId,
          type: "reasoning",
          encrypted_content: encryptedContent,
        };

        if (reasoningOutput.text !== "")
          set(item, "summary", [{ type: "summary_text", text: reasoningOutput.text }]);
        outputs.push(item);
        break;
      }

      case "message": {
        if (hasGrounding && !wsAppended) {
          // SAFETY: wsItem is an object literal built from Json values.
          outputs.push(wsItem as Json);
          wsAppended = true;
        }

        const messageOutput = messageOutputs[outputItem.index];

        if (messageOutput === undefined) continue;

        for (const signature of messageOutput.signatures) {
          if (!reasoningOutputSignatures.has(signature))
            appendDetachedOutput(signature, CARRIER_NEXT, CARRIER_TEXT);
        }

        const citations = messageCitations.get(outputItem.index) ?? [];
        outputs.push({
          id: `msg_${stripResponsePrefix(id)}_${outputItem.index}`,
          type: "message",
          status: outputItem.index === activeMessageIndex ? status : "completed",
          content: [
            { type: "output_text", annotations: citations, logprobs: [], text: messageOutput.text },
          ],
          role: "assistant",
        });
        break;
      }

      case "function": {
        const functionOutput = functionOutputs[outputItem.index];

        if (functionOutput === undefined) continue;
        appendDetachedOutput(functionOutput.signature, CARRIER_NEXT, CARRIER_FUNCTION);
        outputs.push(functionOutput.item);
        break;
      }
    }
  }

  if (hasGrounding && !wsAppended)
    // SAFETY: wsItem is an object literal built from Json values.
    outputs.push(wsItem as Json);

  if (outputs.length > 0) resp["output"] = outputs;

  if (hasGrounding) resp["tool_usage"] = { web_search: { num_requests: 1 } };
  const usage = newUsage();

  if (mergeUsage(usage, root)) resp["usage"] = usageJson(usage);

  return JSON.stringify(resp);
};
