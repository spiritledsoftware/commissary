/**
 * OpenAI Responses client -> Gemini provider (request).
 *
 * Go source: internal/translator/gemini/openai/responses/gemini_openai-responses_request.go
 * (ConvertOpenAIResponsesRequestToGemini and helpers). Items are parsed JSON; Go's `item.Raw` clones become structured
 * clones and `gjson.Result.String()` becomes `asString`.
 */
import {
  asBool,
  asFloat,
  asInt,
  asString,
  exists,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import {
  extractResponsesCallID,
  normalizeResponsesToolCallOutputs,
} from "../../../common/responses.ts";
import { attachDefaultSafetySettings } from "../../common/safety.ts";
import {
  mergeAdjacentGeminiUserContents,
  setGeminiFunctionResponseRaw,
  setGeminiFunctionResponseResult,
} from "../../common/contents.ts";
import { UserTurnDrops } from "../../../common/parts.ts";
import {
  compatibleGeminiSignature,
  geminiReplaySignatureOrBypass,
  GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR,
  isGeminiSignatureModel,
  sanitizeGeminiRequestThoughtSignatures,
} from "../../common/signature.ts";
import { systemReminderText } from "../../../common/claude-messages.ts";
import { sanitizeFunctionName } from "../../util/claude.ts";
import {
  assistantVisibleText,
  CARRIER_ANY,
  CARRIER_FUNCTION,
  CARRIER_NEXT,
  CARRIER_PREVIOUS,
  CARRIER_SIGNATURE_FIELD,
  CARRIER_SUMMARY_FIELD,
  CARRIER_TEXT,
  carrierDirection,
  carrierTarget,
  CARRIER_DIRECTION_FIELD,
  isDetachedCarrier,
  normalizeCarriers,
} from "./carrier.ts";
import { inlineDataPart, mediaFromBlock, partFromBlock } from "./media.ts";
import { normalizeToolSearchItems } from "./tool-search.ts";
import { restoreTextSignatures } from "./trailing-signature.ts";
import {
  buildGeminiFunctionDeclarations,
  convertResponsesToolChoiceToGemini,
  mapResponsesToolName,
} from "./tools.ts";
import { qualifyResponsesNamespaceToolName } from "../../../common/responses-tools.ts";
import {
  allowsResponsesWebSearchToolChoice,
  extractResponsesWebSearchAllowedDomains,
  hasResponsesWebSearchTool,
  modelSupportsWebSearch,
} from "./web-search.ts";

const THOUGHT_SIGNATURE_BYPASS = GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR;

const typeOf = (item: Json | undefined): string => asString(get(item, "type"));

const trimmedAt = (item: Json | undefined, path: string): string =>
  asString(get(item, path)).trim();

const isToolCall = (item: Json): boolean => {
  const type = typeOf(item);

  return type === "function_call" || type === "custom_tool_call";
};

const isToolOutput = (item: Json): boolean => {
  const type = typeOf(item);

  return type === "function_call_output" || type === "custom_tool_call_output";
};

const isContentPartType = (itemType: string): boolean =>
  [
    "input_text",
    "output_text",
    "text",
    "input_image",
    "image_url",
    "image",
    "input_audio",
    "audio",
    "input_video",
    "video_url",
    "video",
    "input_file",
    "file",
  ].includes(itemType.trim().toLowerCase());

/** The content part types that carry a file, image, audio or video rather than text. */
const isAttachmentPartType = (itemType: string): boolean =>
  isContentPartType(itemType) &&
  !["input_text", "output_text", "text"].includes(itemType.trim().toLowerCase());

const geminiContent = (role: string, parts: Json[]): JsonObject => ({ role, parts });

const textPart = (text: string): JsonObject => ({ text });

/** Role a content item is sent with (`assistant`/`model` -> `model`). */
const effectiveRole = (itemRole: string): string => {
  if (itemRole === "") return "user";
  const lower = itemRole.toLowerCase();

  return lower === "assistant" || lower === "model" ? "model" : lower;
};

const withField = (item: Json, path: string, value: Json): Json => {
  const copy = structuredClone(item);
  set(copy, path, value);

  return copy;
};

// --- tool call/reasoning pairing ----------------------------------------------------------------------------------------

/** `pairOpenAIResponsesReasoningWithFunctionCalls`. */
const pairReasoningWithFunctionCalls = (items: readonly Json[]): Json[] => {
  const postCallSignature = new Map<number, string>();
  const postCallCarrier = new Set<number>();
  const consumedPostCallCarrier = new Set<number>();

  for (let groupStart = 0; groupStart < items.length;) {
    // SAFETY: `groupStart < items.length` by the loop bound; the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    if (!isToolCall(items[groupStart] as Json) && !isDetachedCarrier(items[groupStart])) {
      groupStart++;
      continue;
    }

    let groupEnd = groupStart;
    let hasFunctionCall = false;

    // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    while (
      groupEnd < items.length &&
      (isToolCall(items[groupEnd] as Json) || isDetachedCarrier(items[groupEnd]))
    ) {
      // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      hasFunctionCall = hasFunctionCall || isToolCall(items[groupEnd] as Json);
      groupEnd++;
    }

    // SAFETY: `groupEnd >= items.length` short-circuits before `items[groupEnd]`; the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    if (!hasFunctionCall || groupEnd >= items.length || !isToolOutput(items[groupEnd] as Json)) {
      groupStart = groupEnd;
      continue;
    }

    let outputEnd = groupEnd;

    // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    while (outputEnd < items.length && isToolOutput(items[outputEnd] as Json)) outputEnd++;

    // A run beginning with a carrier uses leading-carrier semantics. A run beginning with a call uses post-call
    // semantics. This preserves both carrier,call,carrier,call and call,carrier,call,carrier histories.
    // SAFETY: `groupStart < items.length` by the loop bound; the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    if (isToolCall(items[groupStart] as Json)) {
      for (let callIndex = groupStart; callIndex < groupEnd; callIndex++) {
        // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
        const item = items[callIndex] as Json;

        if (
          !isToolCall(item) ||
          trimmedAt(item, CARRIER_SIGNATURE_FIELD) !== "" ||
          callIndex + 1 >= groupEnd ||
          !isDetachedCarrier(items[callIndex + 1])
        ) {
          continue;
        }

        const direction = carrierDirection(items[callIndex + 1]);
        const target = carrierTarget(items[callIndex + 1]);

        if (
          direction !== "" &&
          (direction !== CARRIER_PREVIOUS ||
            (target !== CARRIER_FUNCTION && target !== CARRIER_ANY))
        ) {
          continue;
        }

        let carrierEnd = callIndex + 1;

        while (carrierEnd < groupEnd && isDetachedCarrier(items[carrierEnd])) {
          postCallCarrier.add(carrierEnd);
          carrierEnd++;
        }

        const callId = extractResponsesCallID(item);

        if (callId === "") continue;

        for (let outputIndex = groupEnd; outputIndex < outputEnd; outputIndex++) {
          if (extractResponsesCallID(items[outputIndex]) === callId) {
            postCallSignature.set(callIndex, trimmedAt(items[callIndex + 1], "encrypted_content"));
            consumedPostCallCarrier.add(callIndex + 1);
            break;
          }
        }
      }
    }

    groupStart = outputEnd;
  }

  const paired: Json[] = [];

  for (let index = 0; index < items.length; index++) {
    // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    const item = items[index] as Json;
    const signature = postCallSignature.get(index);

    if (signature !== undefined && signature !== "") {
      paired.push(withField(item, CARRIER_SIGNATURE_FIELD, signature));
      continue;
    }

    if (consumedPostCallCarrier.has(index)) continue;
    const direction = carrierDirection(item);
    const target = carrierTarget(item);

    const canBindFollowingCall =
      direction === "" ||
      (direction === CARRIER_NEXT && (target === CARRIER_FUNCTION || target === CARRIER_ANY));

    // SAFETY: the `&&` chain checked `index + 1 < items.length` before `items[index + 1]`; the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    if (
      typeOf(item) === "reasoning" &&
      !postCallCarrier.has(index) &&
      canBindFollowingCall &&
      !asString(get(item, "id")).includes("_detached_after_") &&
      index + 1 < items.length &&
      isToolCall(items[index + 1] as Json)
    ) {
      const rawSignature = trimmedAt(item, "encrypted_content");

      if (rawSignature !== "") {
        // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
        const functionCall = withField(
          items[index + 1] as Json,
          CARRIER_SIGNATURE_FIELD,
          rawSignature,
        );

        const summary = asString(get(item, "summary.0.text"));

        if (summary !== "") set(functionCall, CARRIER_SUMMARY_FIELD, summary);
        paired.push(functionCall);
        index++;
        continue;
      }
    }

    paired.push(item);
  }

  return paired;
};

/** `reorderOpenAIResponsesDetachedReasoning`. */
const reorderDetachedReasoning = (items: readonly Json[]): Json[] => {
  const reordered: Json[] = [];
  items.forEach((item, itemIndex) => {
    const isReasoningCarrier = isDetachedCarrier(item);
    const markedDetached = asString(get(item, "id")).includes("_detached_after_");

    if (isReasoningCarrier && reordered.length > 0) {
      // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      const previous = reordered[reordered.length - 1] as Json;
      let previousType = typeOf(previous);

      if (previousType === "" && asString(get(previous, "role")) !== "") previousType = "message";
      let isAssistantMessage = false;

      if (previousType === "message")
        isAssistantMessage = assistantVisibleText(previous) !== undefined;

      const direction = carrierDirection(item);
      const targetKind = carrierTarget(item);

      if (direction !== "") {
        let alreadyPairedText = false;
        let alreadyPairedFunction = false;

        if (reordered.length > 1) {
          // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
          const prior = reordered[reordered.length - 2] as Json;
          const priorDirection = carrierDirection(prior);
          const priorTarget = carrierTarget(prior);

          const priorBindsFollowing =
            isDetachedCarrier(prior) &&
            (priorDirection === CARRIER_NEXT || priorDirection === CARRIER_PREVIOUS);

          alreadyPairedText =
            priorBindsFollowing && (priorTarget === CARRIER_TEXT || priorTarget === CARRIER_ANY);
          alreadyPairedFunction =
            priorBindsFollowing &&
            (priorTarget === CARRIER_FUNCTION || priorTarget === CARRIER_ANY);
        }

        const bindPreviousMessage =
          direction === CARRIER_PREVIOUS &&
          (targetKind === CARRIER_TEXT || targetKind === CARRIER_ANY) &&
          isAssistantMessage &&
          !alreadyPairedText;

        const bindPreviousFunction =
          direction === CARRIER_PREVIOUS &&
          (targetKind === CARRIER_FUNCTION || targetKind === CARRIER_ANY) &&
          (previousType === "function_call" || previousType === "custom_tool_call") &&
          trimmedAt(previous, CARRIER_SIGNATURE_FIELD) === "" &&
          !alreadyPairedFunction;

        if (bindPreviousMessage || bindPreviousFunction) {
          reordered[reordered.length - 1] = withField(item, CARRIER_DIRECTION_FIELD, CARRIER_NEXT);
          reordered.push(previous);

          return;
        }

        reordered.push(item);

        return;
      }

      if (isAssistantMessage && !markedDetached && itemIndex + 1 < items.length) {
        isAssistantMessage = assistantVisibleText(items[itemIndex + 1]) === undefined;
      }

      let alreadyPaired = false;

      if (reordered.length > 1) {
        // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
        const prior = reordered[reordered.length - 2] as Json;
        alreadyPaired =
          isDetachedCarrier(prior) && asString(get(prior, "id")).includes("_detached_after_");
      }

      if (
        !alreadyPaired &&
        (isAssistantMessage ||
          (markedDetached &&
            (previousType === "function_call" || previousType === "custom_tool_call") &&
            trimmedAt(previous, CARRIER_SIGNATURE_FIELD) === ""))
      ) {
        reordered[reordered.length - 1] = item;
        reordered.push(previous);

        return;
      }
    }

    reordered.push(item);
  });

  return reordered;
};

// --- function calls and responses ---------------------------------------------------------------------------------------

const functionCallName = (item: Json, forwardMap: ReadonlyMap<string, string>): string => {
  let name = asString(get(item, "name"));
  const namespace = asString(get(item, "namespace"));

  if (namespace !== "") name = qualifyResponsesNamespaceToolName(namespace, name);

  return mapResponsesToolName(forwardMap, name);
};

/** `buildOpenAIResponsesFunctionCallPart`. */
const buildFunctionCallPart = (
  item: Json,
  signature: string,
  forwardMap: ReadonlyMap<string, string>,
): JsonObject => {
  const functionCall: JsonObject = { name: functionCallName(item, forwardMap), args: {} };
  const part: JsonObject = { functionCall };
  part["thoughtSignature"] = signature;
  functionCall["id"] = extractResponsesCallID(item);
  // SAFETY: `functionCall` was built just above with `args` set to `{}`.
  const args = functionCall["args"] as JsonObject;

  if (typeOf(item) === "custom_tool_call") {
    const input = get(item, "input");
    args["input"] = input === undefined ? "" : input;
  } else {
    const argumentsText = asString(get(item, "arguments"));

    if (argumentsText !== "") {
      let parsed: Json | undefined;

      try {
        // SAFETY: JSON.parse can only produce JSON values, which is exactly what Json models.
        parsed = JSON.parse(argumentsText) as Json;
      } catch {
        parsed = undefined;
      }

      if (parsed !== undefined && (isJsonObject(parsed) || isJsonArray(parsed)))
        functionCall["args"] = parsed;
      else args["arguments"] = argumentsText;
    }
  }

  return part;
};

const synthesizedFunctionResponsePart = (
  callId: string,
  namesByCallId: ReadonlyMap<string, string>,
): JsonObject => {
  const matched = namesByCallId.get(callId);
  const functionName = matched !== undefined && matched !== "" ? matched : "unknown";

  const functionResponse: JsonObject = {
    name: sanitizeFunctionName(functionName),
    response: { result: "call interrupted, no output" },
  };

  if (callId !== "") functionResponse["id"] = callId;

  return { functionResponse };
};

const hasMatchingOutput = (items: readonly Json[], callId: string): boolean =>
  callId !== "" &&
  items.some((item) => isToolOutput(item) && extractResponsesCallID(item) === callId);

const hasSubsequentTurn = (items: readonly Json[]): boolean =>
  items.some((item) => {
    const type = typeOf(item);
    const role = asString(get(item, "role"));

    return (
      type === "message" ||
      (type === "" && role !== "") ||
      type === "function_call" ||
      type === "custom_tool_call"
    );
  });

const standaloneToolOutputTextParts = (item: Json): Json[] => {
  const output = get(item, "output");

  if (output === undefined) return [];

  if (isJsonArray(output)) {
    const parts: Json[] = [];

    for (const part of output) {
      const text = asString(get(part, "text"));

      if (text.trim() !== "") parts.push(textPart(text));
    }

    return parts;
  }

  const text = asString(output);

  return text.trim() === "" ? [] : [textPart(text)];
};

interface ArrayOutput {
  readonly result: string;
  readonly isRaw: boolean;
  readonly images: JsonObject[];
}

/** `parseOpenAIResponsesArrayOutput`. */
const parseArrayOutput = (output: Json[]): ArrayOutput => {
  const images: JsonObject[] = [];
  const entries: Array<{ text: string; isText: boolean; raw: string }> = [];
  let hasContentBlock = false;
  let hasNonTextBlock = false;

  for (const block of output) {
    const media = mediaFromBlock(block);

    if (media !== undefined) {
      hasContentBlock = true;
      images.push(inlineDataPart(media.mimeType, media.data));
      continue;
    }

    const type = asString(get(block, "type"));

    if (type === "input_text" || type === "output_text" || type === "text") {
      hasContentBlock = true;
      entries.push({
        text: asString(get(block, "text")),
        isText: true,
        raw: JSON.stringify(block),
      });
    } else if (typeof block === "string") {
      entries.push({ text: block, isText: true, raw: JSON.stringify(block) });
    } else {
      hasNonTextBlock = true;
      entries.push({ text: JSON.stringify(block), isText: false, raw: JSON.stringify(block) });
    }
  }

  if (!hasContentBlock) return { result: JSON.stringify(output), isRaw: true, images: [] };

  if (entries.length === 0) return { result: "", isRaw: false, images };

  if (entries.length === 1) {
    // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    const only = entries[0] as (typeof entries)[number];

    return only.isText
      ? { result: only.text, isRaw: false, images }
      : { result: only.raw, isRaw: true, images };
  }

  if (!hasNonTextBlock)
    return { result: entries.map((entry) => entry.text).join("\n"), isRaw: false, images };

  return { result: `[${entries.map((entry) => entry.raw).join(",")}]`, isRaw: true, images };
};

/** `buildOpenAIResponsesFunctionResponseParts`. */
const buildFunctionResponseParts = (
  item: Json,
  namesByCallId: ReadonlyMap<string, string>,
): Json[] => {
  const callId = extractResponsesCallID(item);
  let functionName = "unknown";
  const matched = namesByCallId.get(callId);

  if (matched !== undefined) functionName = matched;
  else if (trimmedAt(item, "name") !== "") functionName = trimmedAt(item, "name");

  let functionResponse: Json = {
    functionResponse: { name: sanitizeFunctionName(functionName), response: {} },
  };

  set(functionResponse, "functionResponse.id", callId);

  const output = get(item, "output");

  if (typeof output === "string") {
    if (output === "" || output === "null") return [functionResponse];
    // Keep it as a string instead of parsing it into JSON (a parsed file read may trigger an upstream 400).
    set(functionResponse, "functionResponse.response.result", output);

    return [functionResponse];
  }

  let imageParts: JsonObject[] = [];

  if (isJsonArray(output)) {
    const parsed = parseArrayOutput(output);
    imageParts = parsed.images;
    functionResponse = parsed.isRaw
      ? setGeminiFunctionResponseRaw(
          functionResponse,
          "functionResponse.response.result",
          parsed.result,
        )
      : set(functionResponse, "functionResponse.response.result", parsed.result);
  } else if (isJsonObject(output)) {
    const media = mediaFromBlock(output);

    if (media !== undefined) {
      imageParts.push(inlineDataPart(media.mimeType, media.data));
      functionResponse = set(functionResponse, "functionResponse.response.result", "");
    } else {
      functionResponse = setGeminiFunctionResponseResult(
        functionResponse,
        "functionResponse.response.result",
        output,
      );
    }
  } else if (output !== undefined && output !== null) {
    functionResponse = set(functionResponse, "functionResponse.response.result", asString(output));
  }

  for (const part of imageParts) {
    const inline = get(part, "inline_data");
    const fileData = get(part, "file_data");

    if (inline !== undefined) {
      set(functionResponse, "functionResponse.parts.-1", {
        inlineData: {
          mimeType: asString(get(inline, "mime_type")),
          data: asString(get(inline, "data")),
        },
      });
    } else if (fileData !== undefined) {
      set(functionResponse, "functionResponse.parts.-1", {
        fileData: {
          mimeType: asString(get(fileData, "mime_type")),
          fileUri: asString(get(fileData, "file_uri")),
        },
      });
    }
  }

  return [functionResponse];
};

type CollectFunctionCallOutputsResult = {
  readonly ordered: Json[];
  readonly consumedCount: number;
};

/** `collectOpenAIResponsesFunctionCallOutputs` + `orderOpenAIResponsesFunctionCallOutputs`. */
const collectFunctionCallOutputs = (
  items: readonly Json[],
  start: number,
  pendingCallIds: readonly string[],
): CollectFunctionCallOutputsResult => {
  let end = start + 1;

  // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
  while (end < items.length && isToolOutput(items[end] as Json)) end++;
  const outputs = items.slice(start, end);
  const used = outputs.map(() => false);
  const ordered: Json[] = [];

  for (const pendingId of pendingCallIds) {
    const match = outputs.findIndex(
      (output, index) => !used[index] && extractResponsesCallID(output) === pendingId,
    );

    if (match < 0) continue;
    used[match] = true;
    // SAFETY: `match` is a non-negative index returned by `findIndex` over `outputs` (`match < 0` was skipped above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    ordered.push(outputs[match] as Json);
  }

  outputs.forEach((output, index) => {
    if (!used[index]) ordered.push(output);
  });

  return { ordered, consumedCount: end - start };
};

const modelContentOf = (parts: Json[]): JsonObject => ({ role: "model", parts });

const functionCallModelContent = (
  item: Json,
  signature: string,
  forwardMap: ReadonlyMap<string, string>,
): JsonObject => modelContentOf([buildFunctionCallPart(item, signature, forwardMap)]);

const emptyReasoningFunctionCallModelContent = (
  item: Json,
  signature: string,
  forwardMap: ReadonlyMap<string, string>,
): JsonObject =>
  modelContentOf([
    { text: "", thought: true, thoughtSignature: signature },
    buildFunctionCallPart(item, signature, forwardMap),
  ]);

const reasoningFunctionCallModelContent = (
  thoughtText: string,
  item: Json,
  signature: string,
  forwardMap: ReadonlyMap<string, string>,
): JsonObject => {
  const parts: Json[] = [];

  if (thoughtText !== "") parts.push({ text: thoughtText, thought: true });
  parts.push(buildFunctionCallPart(item, signature, forwardMap));

  return modelContentOf(parts);
};

/** `buildOpenAIResponsesReasoningModelContent`: `undefined` when there is nothing to send. */
const reasoningModelContent = (
  thoughtText: string,
  visibleText: string,
  signature: string,
  nativeLayout: boolean,
): JsonObject | undefined => {
  const hasRealSignature = signature !== "" && signature !== THOUGHT_SIGNATURE_BYPASS;

  if (nativeLayout) {
    if (thoughtText === "" && visibleText === "") {
      if (!hasRealSignature) return undefined;

      return modelContentOf([{ text: "", thoughtSignature: signature }]);
    }

    const parts: Json[] = [];

    if (thoughtText !== "") {
      const thought: JsonObject = { text: thoughtText, thought: true };

      if (visibleText === "" && hasRealSignature) thought["thoughtSignature"] = signature;
      parts.push(thought);
    }

    if (visibleText !== "") {
      const visible: JsonObject = { text: visibleText };

      if (hasRealSignature) visible["thoughtSignature"] = signature;
      parts.push(visible);
    }

    return modelContentOf(parts);
  }

  const thought: JsonObject = { text: thoughtText, thought: true };

  if (hasRealSignature) thought["thoughtSignature"] = signature;

  return modelContentOf([thought]);
};

const openAIResponsesGeminiThoughtSignature = (rawSignature: string): string =>
  compatibleGeminiSignature(rawSignature) ?? "";

/** `coalesceAdjacentOpenAIResponsesModelContents`. */
const coalesceAdjacentModelContents = (contents: readonly Json[]): Json[] => {
  const coalesced: Json[] = [];

  const isModel = (content: Json | undefined): boolean =>
    trimmedAt(content, "role").toLowerCase() === "model";

  for (const content of contents) {
    const last = coalesced[coalesced.length - 1];

    if (!isModel(content) || last === undefined || !isModel(last)) {
      coalesced.push(content);
      continue;
    }

    const parts = get(content, "parts");

    if (!isJsonArray(parts)) {
      coalesced.push(content);
      continue;
    }

    if (parts.length > 0) {
      const existing = get(last, "parts");
      const merged = structuredClone(last);
      set(merged, "parts", [...(isJsonArray(existing) ? existing : []), ...parts]);
      coalesced[coalesced.length - 1] = merged;
    }
  }

  return coalesced;
};

/** `shouldStripTrailingOpenAIResponsesModelPrefill`. */
const isModelPrefill = (lastContent: Json | undefined): boolean => {
  if (asString(get(lastContent, "role")) !== "model") return false;
  const parts = get(lastContent, "parts");

  if (!isJsonArray(parts)) return false;

  return !parts.some(
    (part) =>
      asBool(get(part, "thought")) ||
      exists(part, "functionCall") ||
      trimmedAt(part, "thoughtSignature") !== "",
  );
};

/** `stripTrailingOpenAIResponsesModelPrefill`. */
const stripTrailingModelPrefill = (payload: Json): Json => {
  const contents = get(payload, "contents");

  if (
    !isJsonArray(contents) ||
    contents.length === 0 ||
    !isModelPrefill(contents[contents.length - 1])
  )
    return payload;

  return set(payload, "contents", contents.slice(0, -1));
};

/** `applyOpenAIResponsesTextFormatToGemini`. */
const applyTextFormat = (out: Json, root: Json): void => {
  const textFormat = get(root, "text.format");

  if (textFormat === undefined) return;
  const formatType = trimmedAt(textFormat, "type").toLowerCase();

  if (formatType === "json_object") {
    set(out, "generationConfig.responseMimeType", "application/json");
  } else if (formatType === "json_schema") {
    set(out, "generationConfig.responseMimeType", "application/json");
    const schema = get(textFormat, "schema") ?? get(textFormat, "json_schema.schema");

    if (schema !== undefined) set(out, "generationConfig.responseJsonSchema", schema);
  }
};

// --- main conversion ----------------------------------------------------------------------------------------------------

/** `ConvertOpenAIResponsesRequestToGemini`. */
export const convertOpenAIResponsesRequestToGemini = (
  modelName: string,
  request: Json,
  _stream: boolean,
): Json => {
  const drops = new UserTurnDrops();
  let useNativeLayout = isGeminiSignatureModel(modelName);
  const out: Json = { contents: [] };
  const root = request;

  const { declarations, forwardMap } = buildGeminiFunctionDeclarations(root);
  const toolBlocks: Json[] = [];

  if (
    hasResponsesWebSearchTool(root) &&
    modelSupportsWebSearch(modelName) &&
    allowsResponsesWebSearchToolChoice(root)
  ) {
    const googleSearch: JsonObject = {};
    const allowedDomains = extractResponsesWebSearchAllowedDomains(root);

    if (allowedDomains.length > 0) googleSearch["includedDomains"] = allowedDomains;
    toolBlocks.push({ googleSearch });
  }

  if (declarations.length > 0) toolBlocks.push({ functionDeclarations: declarations });

  if (toolBlocks.length > 0) set(out, "tools", toolBlocks);

  // Function calling is only configured when function declarations exist.
  if (declarations.length > 0) {
    const toolChoice = get(root, "tool_choice");

    if (toolChoice !== undefined) {
      const toolConfig = convertResponsesToolChoiceToGemini(toolChoice, forwardMap);

      if (toolConfig !== undefined) set(out, "toolConfig.functionCallingConfig", toolConfig);
    }
  }

  const systemParts: Json[] = [];
  const instructions = get(root, "instructions");

  if (instructions !== undefined) systemParts.push(textPart(asString(instructions)));

  const input = get(root, "input");

  if (isJsonArray(input)) {
    const carriers = normalizeCarriers(
      restoreTextSignatures(modelName, normalizeToolSearchItems(input, forwardMap)),
    );

    if (carriers.hasValidCarrier) useNativeLayout = true;
    const inputItems = normalizeResponsesToolCallOutputs(carriers.items);
    const items = pairReasoningWithFunctionCalls(inputItems);
    const contentItems: Json[] = [];
    const functionNamesByCallId = new Map<string, string>();
    let pendingFunctionCallIds: string[] = [];

    for (const item of items) {
      if (!isToolCall(item)) continue;
      const callId = extractResponsesCallID(item);

      if (!functionNamesByCallId.has(callId)) {
        let name = asString(get(item, "name"));
        const namespace = asString(get(item, "namespace"));

        if (namespace !== "") name = qualifyResponsesNamespaceToolName(namespace, name);
        functionNamesByCallId.set(callId, mapResponsesToolName(forwardMap, name));
      }
    }

    const normalized = useNativeLayout ? reorderDetachedReasoning(items) : items;
    const consumedOutputIndexes = new Set<number>();
    let hasEncounteredConversation = false;
    let pendingDeveloperParts: Json[] = [];

    for (let i = 0; i < normalized.length; i++) {
      if (consumedOutputIndexes.has(i)) continue;
      // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      const item = normalized[i] as Json;
      let itemType = typeOf(item);
      let itemRole = asString(get(item, "role"));

      if (itemType === "" && itemRole !== "") itemType = "message";
      else if (isContentPartType(itemType) && itemRole === "") {
        itemType = "message";
        itemRole = "user";
      }

      switch (itemType) {
        case "message": {
          const roleLower = itemRole.toLowerCase();

          if (roleLower === "system" || roleLower === "developer") {
            const content = get(item, "content");

            if (!hasEncounteredConversation) {
              pendingFunctionCallIds = [];

              if (isJsonArray(content)) {
                for (const contentItem of content)
                  systemParts.push(textPart(asString(get(contentItem, "text"))));
              } else if (typeof content === "string") {
                systemParts.push(textPart(content));
              }

              continue;
            }

            const devParts: Json[] = [];

            if (isJsonArray(content)) {
              const texts: string[] = [];

              for (const contentItem of content) {
                let text = asString(get(contentItem, "text"));

                if (text === "" && typeof contentItem === "string") text = contentItem;

                if (text !== "") texts.push(text);
              }

              if (texts.length > 0) {
                const joined = texts.join("\n");

                if (joined.trim() !== "") devParts.push(textPart(systemReminderText(joined)));
              }
            } else if (typeof content === "string" && content !== "" && content.trim() !== "") {
              devParts.push(textPart(systemReminderText(content)));
            }

            if (devParts.length > 0) {
              if (pendingFunctionCallIds.length > 0) pendingDeveloperParts.push(...devParts);
              else contentItems.push(geminiContent("user", devParts));
            }

            continue;
          }

          hasEncounteredConversation = true;

          if (assistantVisibleText(item) === undefined) {
            if (pendingFunctionCallIds.length > 0) {
              const future = normalized.slice(i);

              const anyHasFutureOutput = pendingFunctionCallIds.some((callId) =>
                hasMatchingOutput(future, callId),
              );

              if (!anyHasFutureOutput) {
                const synthesized = pendingFunctionCallIds.map((callId) =>
                  synthesizedFunctionResponsePart(callId, functionNamesByCallId),
                );

                if (synthesized.length > 0) contentItems.push(geminiContent("user", synthesized));
                pendingFunctionCallIds = [];
              }
            }

            if (pendingDeveloperParts.length > 0) {
              contentItems.push(geminiContent("user", pendingDeveloperParts));
              pendingDeveloperParts = [];
            }
          }

          // Model outputs may appear as `output_text` content items even when message.role is "user": such items are
          // split into distinct Gemini messages with roles derived from the content type.
          const contentArray = get(item, "content");
          let partsToProcess: Json[] = [];

          if (isJsonArray(contentArray)) {
            partsToProcess = contentArray;
          } else if (isContentPartType(typeOf(item))) {
            partsToProcess.push(item);

            while (i + 1 < normalized.length) {
              // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
              const nextItem = normalized[i + 1] as Json;

              if (asString(get(nextItem, "role")) === "" && isContentPartType(typeOf(nextItem))) {
                partsToProcess.push(nextItem);
                i++;
              } else {
                break;
              }
            }
          }

          if (partsToProcess.length > 0) {
            let currentRole = "";
            let currentParts: Json[] = [];
            // Counts the user parts this item really sends; an empty text part does not.
            let userSendable = 0;

            const flush = (): void => {
              if (currentRole !== "" && currentParts.length > 0)
                contentItems.push(geminiContent(currentRole, currentParts));
              currentParts = [];
            };

            for (const contentItem of partsToProcess) {
              let contentType = typeOf(contentItem);

              if (contentType === "") contentType = "input_text";
              let effRole = effectiveRole(itemRole);

              if (contentType === "output_text") effRole = "model";

              if (currentRole !== "" && effRole !== currentRole) {
                flush();
                currentRole = "";
              }

              if (currentRole === "") currentRole = effRole;

              let partJson: Json | undefined;
              let sendsContent = false;

              switch (contentType) {
                case "input_text":
                case "output_text":
                case "text": {
                  const text = get(contentItem, "text");

                  if (text !== undefined) {
                    partJson = textPart(asString(text));
                    sendsContent = asString(text) !== "";
                  }

                  break;
                }

                default: {
                  const part = partFromBlock(contentItem);

                  if (part !== undefined) {
                    partJson = part;
                    sendsContent = true;
                  } else if (effRole === "user" && isAttachmentPartType(contentType)) {
                    // Gemini has no field for a bare file id and no way to fetch the bytes.
                    drops.drop(contentType);
                  }
                }
              }

              if (partJson !== undefined) currentParts.push(partJson);

              if (sendsContent && effRole === "user") userSendable++;
            }

            flush();
            drops.endTurn(userSendable);
          } else if (typeof contentArray === "string") {
            contentItems.push(geminiContent(effectiveRole(itemRole), [textPart(contentArray)]));
          }

          break;
        }

        case "function_call":
        case "custom_tool_call": {
          hasEncounteredConversation = true;
          let signature = THOUGHT_SIGNATURE_BYPASS;
          const rawSignature = trimmedAt(item, CARRIER_SIGNATURE_FIELD);

          if (rawSignature !== "") signature = geminiReplaySignatureOrBypass(rawSignature);
          const thoughtText = asString(get(item, CARRIER_SUMMARY_FIELD));

          if (thoughtText !== "") {
            contentItems.push(
              reasoningFunctionCallModelContent(thoughtText, item, signature, forwardMap),
            );
          } else if (!useNativeLayout && rawSignature !== "") {
            contentItems.push(emptyReasoningFunctionCallModelContent(item, signature, forwardMap));
          } else {
            contentItems.push(functionCallModelContent(item, signature, forwardMap));
          }

          const callId = extractResponsesCallID(item);

          if (callId !== "") pendingFunctionCallIds.push(callId);
          break;
        }

        case "function_call_output":
        case "custom_tool_call_output": {
          hasEncounteredConversation = true;

          const { ordered, consumedCount } = collectFunctionCallOutputs(
            normalized,
            i,
            pendingFunctionCallIds,
          );

          for (let consumed = i; consumed < i + consumedCount; consumed++)
            consumedOutputIndexes.add(consumed);
          const end = i + consumedCount;
          const subsequent = hasSubsequentTurn(normalized.slice(end));

          const outputByCallId = new Map<string, Json>();
          const extraOutputs: Json[] = [];

          for (const output of ordered) {
            const id = extractResponsesCallID(output);

            if (id !== "") outputByCallId.set(id, output);
            else extraOutputs.push(output);
          }

          const anyMatched = pendingFunctionCallIds.some((pendingId) =>
            outputByCallId.has(pendingId),
          );

          const responseParts: Json[] = [];
          const stillPending: string[] = [];
          const remainingItems = normalized.slice(end);

          for (const pendingId of pendingFunctionCallIds) {
            const output = outputByCallId.get(pendingId);

            if (output !== undefined) {
              responseParts.push(...buildFunctionResponseParts(output, functionNamesByCallId));
              outputByCallId.delete(pendingId);
            } else if (
              (subsequent || anyMatched) &&
              !hasMatchingOutput(remainingItems, pendingId)
            ) {
              responseParts.push(synthesizedFunctionResponsePart(pendingId, functionNamesByCallId));
            } else {
              stillPending.push(pendingId);
            }
          }

          const standaloneContents: Json[] = [];

          // Orphan outputs (no matching function_call) must not become unpaired functionResponse parts: surface them
          // as user text instead.
          const appendStandalone = (output: Json): void => {
            const parts = standaloneToolOutputTextParts(output);

            if (parts.length > 0) standaloneContents.push(geminiContent("user", parts));
          };

          for (const output of ordered) {
            const id = extractResponsesCallID(output);

            if (outputByCallId.has(id)) {
              appendStandalone(output);
              outputByCallId.delete(id);
            }
          }

          for (const output of extraOutputs) appendStandalone(output);

          pendingFunctionCallIds = stillPending;

          if (responseParts.length > 0) contentItems.push(geminiContent("user", responseParts));
          contentItems.push(...standaloneContents);

          if (pendingFunctionCallIds.length === 0 && pendingDeveloperParts.length > 0) {
            contentItems.push(geminiContent("user", pendingDeveloperParts));
            pendingDeveloperParts = [];
          }

          break;
        }

        case "reasoning": {
          hasEncounteredConversation = true;
          const thoughtText = asString(get(item, "summary.0.text"));
          let rawSignature = asString(get(item, "encrypted_content"));
          const direction = carrierDirection(item);
          const target = carrierTarget(item);

          if (rawSignature.trim() === "" && i + 1 < normalized.length) {
            // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
            const nextReasoning = normalized[i + 1] as Json;

            if (
              typeOf(nextReasoning) === "reasoning" &&
              asString(get(nextReasoning, "id")).includes("_detached_after_") &&
              trimmedAt(nextReasoning, "summary.0.text") === "" &&
              trimmedAt(nextReasoning, "encrypted_content") !== ""
            ) {
              rawSignature = asString(get(nextReasoning, "encrypted_content"));
              i++;
            }
          }

          let signature = "";

          if (rawSignature.trim() !== "")
            signature = openAIResponsesGeminiThoughtSignature(rawSignature);

          let visibleText = "";

          if (useNativeLayout && i + 1 < normalized.length) {
            // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
            const next = normalized[i + 1] as Json;

            const canBindText =
              (direction === "" || direction === CARRIER_NEXT) &&
              (target === "" || target === CARRIER_TEXT || target === CARRIER_ANY);

            const canBindFunction =
              (direction === "" || direction === CARRIER_NEXT) &&
              (target === "" || target === CARRIER_FUNCTION || target === CARRIER_ANY);

            const visible = assistantVisibleText(next);

            if (visible !== undefined && canBindText) {
              visibleText = visible;
              i++;
            } else if (
              isToolCall(next) &&
              canBindFunction &&
              trimmedAt(next, CARRIER_SIGNATURE_FIELD) === ""
            ) {
              const functionSignature = signature === "" ? THOUGHT_SIGNATURE_BYPASS : signature;
              contentItems.push(
                reasoningFunctionCallModelContent(thoughtText, next, functionSignature, forwardMap),
              );
              const callId = extractResponsesCallID(next);

              if (callId !== "") pendingFunctionCallIds.push(callId);
              i++;
              continue;
            }
          }

          const modelContent = reasoningModelContent(
            thoughtText,
            visibleText,
            signature,
            useNativeLayout,
          );

          if (modelContent !== undefined) contentItems.push(modelContent);
          break;
        }
      }
    }

    if (pendingDeveloperParts.length > 0) {
      contentItems.push(geminiContent("user", pendingDeveloperParts));
      pendingDeveloperParts = [];
    }

    set(
      out,
      "contents",
      mergeAdjacentGeminiUserContents(coalesceAdjacentModelContents(contentItems)),
    );
  } else if (typeof input === "string") {
    set(out, "contents", [geminiContent("user", [textPart(input)])]);
  }

  if (systemParts.length > 0) set(out, "systemInstruction", { parts: systemParts });

  const maxOutputTokens = get(root, "max_output_tokens");

  if (maxOutputTokens !== undefined)
    set(out, "generationConfig", { maxOutputTokens: asInt(maxOutputTokens) });
  const temperature = get(root, "temperature");

  if (temperature !== undefined) set(out, "generationConfig.temperature", asFloat(temperature));
  const topP = get(root, "top_p");

  if (topP !== undefined) set(out, "generationConfig.topP", asFloat(topP));
  const stopSequences = get(root, "stop_sequences");

  if (isJsonArray(stopSequences)) {
    // A nil Go slice marshals to null.
    set(
      out,
      "generationConfig.stopSequences",
      stopSequences.length === 0 ? null : stopSequences.map((seq) => asString(seq)),
    );
  }

  applyTextFormat(out, root);

  // Inline translation-only mapping of reasoning.effort; capability checks happen later in ApplyThinking.
  const effort = asString(get(root, "reasoning.effort")).trim().toLowerCase();

  if (get(root, "reasoning.effort") !== undefined && effort !== "") {
    if (effort === "auto") set(out, "generationConfig.thinkingConfig.thinkingBudget", -1);
    else set(out, "generationConfig.thinkingConfig.thinkingLevel", effort);
  }

  let result = attachDefaultSafetySettings(out, "safetySettings");

  if (useNativeLayout) result = sanitizeGeminiRequestThoughtSignatures(result, "contents");
  result = stripTrailingModelPrefill(result);
  const error = drops.err(result);

  if (error !== undefined) throw error;

  return result;
};
