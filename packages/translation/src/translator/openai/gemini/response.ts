/**
 * OpenAI Chat Completions provider -> Gemini client (response).
 *
 * Go source: internal/translator/openai/gemini/openai_gemini_response.go.
 */
import {
  asInt,
  exists,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  setOwn,
} from "@commissary/json";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";
import { firstNonEmptyStringAt } from "../../common/gemini-parts.ts";
import { getStr, isArr, str } from "../common/read.ts";

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
  thoughtSignature: string;
}

/** `openAIToolCallThoughtSignature`: the Gemini thought signature an OpenAI-compatible upstream attached to a tool call. */
const openAIToolCallThoughtSignature = (toolCall: Json | undefined): string =>
  firstNonEmptyStringAt(toolCall, [
    "extra_content.google.thought_signature",
    "function.extra_content.google.thought_signature",
    "thoughtSignature",
    "thought_signature",
  ]);

/** Port of `ConvertOpenAIResponseToGeminiParams`. */
interface GeminiStreamParams {
  toolCallsAccumulator: Map<number, ToolCallAccumulator> | undefined;
  contentAccumulatorLength: number;
  /** Never set to true by the Go code, so the role-only chunk branch is unreachable (kept for parity). */
  isFirstChunk: boolean;
}

/** `mapOpenAIFinishReasonToGemini`. */
const mapOpenAIFinishReasonToGemini = (reason: string): string => {
  switch (reason) {
    case "stop":
      return "STOP";
    case "length":
      return "MAX_TOKENS";
    case "tool_calls":
      return "STOP";
    case "content_filter":
      return "SAFETY";
    default:
      return "STOP";
  }
};

const isSpace = (ch: string | undefined): boolean =>
  ch === " " || ch === "\n" || ch === "\r" || ch === "\t";

interface JsonStringToken {
  token: string;
  next: number;
}

interface BracketedSegment {
  segment: string;
  next: number;
}

const parseJsonStringToken = (text: string, start: number): JsonStringToken => {
  if (start >= text.length || text[start] !== '"') return { token: "", next: -1 };
  let i = start + 1;
  let escaped = false;

  while (i < text.length) {
    const r = text[i];

    if (r === "\\" && !escaped) {
      escaped = true;
      i++;
      continue;
    }

    if (r === '"' && !escaped) return { token: text.slice(start, i + 1), next: i + 1 };
    escaped = false;
    i++;
  }

  return { token: text.slice(start), next: -1 };
};

const jsonStringTokenToRawString = (token: string): string => {
  try {
    const parsed = JSON.parse(token);

    if (typeof parsed === "string") return parsed;
  } catch {
    // Falls through to the quote-stripping fallback below.
  }

  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) return token.slice(1, -1);

  return token;
};

const closingRune = (open: string | undefined): string | undefined => {
  switch (open) {
    case "{":
      return "}";
    case "[":
      return "]";
    default:
      return undefined;
  }
};

const captureBracketed = (text: string, i: number): BracketedSegment => {
  if (i >= text.length) return { segment: "", next: -1 };
  const startRune = text[i];
  const endRune = closingRune(startRune);

  if (endRune === undefined) return { segment: "", next: -1 };
  let depth = 0;
  let j = i;
  let inStr = false;
  let escaped = false;

  while (j < text.length) {
    const r = text[j];

    if (inStr) {
      if (r === "\\" && !escaped) {
        escaped = true;
        j++;
        continue;
      }

      if (r === '"' && !escaped) inStr = false;
      else escaped = false;
      j++;
      continue;
    }

    if (r === '"') {
      inStr = true;
      j++;
      continue;
    }

    if (r === startRune) depth++;
    else if (r === endRune) {
      depth--;

      if (depth === 0) return { segment: text.slice(i, j + 1), next: j + 1 };
    }

    j++;
  }

  return { segment: text.slice(i), next: -1 };
};

const tryParseNumber = (s: string): number | undefined => {
  if (s === "") return undefined;

  if (/^[+-]?\d+$/.test(s) || /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);

  return undefined;
};

/**
 * `tolerantParseJSONObjectRaw`: parses a JSON-like object string, tolerating bareword values (unquoted strings)
 * commonly seen in streamed tool calls, e.g. `{"location": 北京, "unit": celsius}`.
 */
const tolerantParseJsonObject = (s: string): JsonObject => {
  const result: JsonObject = {};
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");

  if (start === -1 || end === -1 || start >= end) return result;
  const content = s.slice(start + 1, end);
  const n = content.length;
  let i = 0;

  while (i < n) {
    while (i < n && (isSpace(content[i]) || content[i] === ",")) i++;

    if (i >= n) break;

    if (content[i] !== '"') {
      while (i < n && content[i] !== ",") i++;
      continue;
    }

    const keyParsed = parseJsonStringToken(content, i);

    if (keyParsed.next === -1) break;
    const keyName = jsonStringTokenToRawString(keyParsed.token);
    i = keyParsed.next;

    while (i < n && isSpace(content[i])) i++;

    if (i >= n || content[i] !== ":") break;
    i++;

    while (i < n && isSpace(content[i])) i++;

    if (i >= n) break;

    const ch = content[i];

    if (ch === '"') {
      const valParsed = parseJsonStringToken(content, i);

      if (valParsed.next === -1) {
        setOwn(result, keyName, "");
        i = n;
      } else {
        setOwn(result, keyName, jsonStringTokenToRawString(valParsed.token));
        i = valParsed.next;
      }
    } else if (ch === "{" || ch === "[") {
      const captured = captureBracketed(content, i);

      if (captured.next === -1) {
        i = n;
      } else {
        let value: Json = captured.segment;

        try {
          value = JSON.parse(captured.segment);
        } catch {
          // Invalid JSON segments are stored as strings.
        }

        setOwn(result, keyName, value);
        i = captured.next;
      }
    } else {
      let j = i;

      while (j < n && content[j] !== ",") j++;
      const token = content.slice(i, j).trim();

      if (token === "true") setOwn(result, keyName, true);
      else if (token === "false") setOwn(result, keyName, false);
      else if (token === "null") setOwn(result, keyName, null);
      else {
        const num = tryParseNumber(token);
        setOwn(result, keyName, num !== undefined ? num : token);
      }

      i = j;
    }

    while (i < n && isSpace(content[i])) i++;

    if (i < n && content[i] === ",") i++;
  }

  return result;
};

/** `parseArgsToObjectRaw`: function arguments as an object ({} when empty or unparsable). */
export const parseArgsToObject = (argsStr: string): JsonObject => {
  const trimmed = argsStr.trim();

  if (trimmed === "" || trimmed === "{}") return {};

  try {
    const strict = JSON.parse(trimmed);

    if (isJsonObject(strict)) return strict;
  } catch {
    // Falls through to the tolerant parser.
  }

  const tolerant = tolerantParseJsonObject(trimmed);

  return Object.keys(tolerant).length > 0 ? tolerant : {};
};

/** `extractReasoningTexts`: the non-empty reasoning texts of a string, `{text}`, `reasoning.summary` or a list. */
const extractReasoningTexts = (node: Json | undefined): string[] => {
  if (node === undefined) return [];

  if (isArr(node)) return node.flatMap(extractReasoningTexts);

  if (typeof node === "string") return node === "" ? [] : [node];

  if (isJsonObject(node)) {
    const text = node.text;

    if (typeof text === "string") return text === "" ? [] : [text];

    if (str(node.type) === "reasoning.summary") {
      const summary = node.summary;

      return typeof summary === "string" && summary !== "" ? [summary] : [];
    }
  }

  return [];
};

/**
 * `collectOpenAIObjectReasoningTexts`: the reasoning texts of a message or delta, from the first of
 * `reasoning_content`, `reasoning` and `reasoning_details` that has any (2fbac976).
 */
const collectReasoningTexts = (obj: Json | undefined): string[] => {
  if (obj === undefined) return [];

  for (const path of ["reasoning_content", "reasoning", "reasoning_details"]) {
    const texts = extractReasoningTexts(get(obj, path));

    if (texts.length > 0) return texts;
  }

  return [];
};

/** `extractOpenAIContentPartThinkingText`. */
const contentPartThinkingText = (part: Json): string => {
  for (const field of ["thinking", "reasoning", "reasoning_content", "text"]) {
    const texts = extractReasoningTexts(get(part, field));

    if (texts.length > 0) return texts.join("");
  }

  return "";
};

/**
 * `forEachOpenAIContentSegment`: a message's `content`, a string or an array of parts, as visible text and inline
 * reasoning segments in order (2fbac976).
 */
const forEachContentSegment = (
  content: Json | undefined,
  emit: (isReasoning: boolean, text: string) => void,
): void => {
  if (typeof content === "string") {
    emit(false, content);

    return;
  }

  if (!isArr(content)) return;

  for (const part of content) {
    if (typeof part === "string") {
      emit(false, part);
      continue;
    }

    const text = get(part, "text");

    switch (getStr(part, "type")) {
      case "thinking":
      case "reasoning":
      case "thought":
      case "reasoning.text":
      case "reasoning_text":
        emit(true, contentPartThinkingText(part));
        break;
      case "refusal": {
        const refusal = get(part, "refusal");
        let refusalText = typeof refusal === "string" ? refusal : "";

        if (refusalText === "" && typeof text === "string") refusalText = text;
        emit(false, refusalText);
        break;
      }

      default:
        if (typeof text === "string") emit(false, text);
    }
  }
};

const tokenCountFromUsage = (usage: Json | undefined, ...paths: string[]): number | undefined => {
  for (const path of paths) {
    const v = get(usage, path);

    if (v !== undefined) return asInt(v);
  }

  return undefined;
};

const reasoningTokensFromUsage = (usage: Json | undefined): number => {
  for (const path of [
    "completion_tokens_details.reasoning_tokens",
    "output_tokens_details.reasoning_tokens",
  ]) {
    const v = get(usage, path);

    if (v !== undefined) return asInt(v);
  }

  return 0;
};

const cachedTokensFromUsage = (usage: Json | undefined): number => {
  for (const path of [
    "prompt_tokens_details.cached_tokens",
    "input_tokens_details.cached_tokens",
  ]) {
    const v = get(usage, path);

    if (v !== undefined) return asInt(v);
  }

  return 0;
};

/** `setGeminiUsageMetadataFromOpenAIUsage`: mutates and returns `out`. */
const setGeminiUsageMetadata = (out: JsonObject, usage: Json | undefined): JsonObject => {
  const prompt = tokenCountFromUsage(usage, "prompt_tokens", "input_tokens");
  const completion = tokenCountFromUsage(usage, "completion_tokens", "output_tokens");
  const total = tokenCountFromUsage(usage, "total_tokens");
  const existingMetadata = out.usageMetadata;
  const metadata: JsonObject = isJsonObject(existingMetadata) ? existingMetadata : {};
  out.usageMetadata = metadata;

  if (prompt !== undefined) metadata.promptTokenCount = prompt;

  if (completion !== undefined) metadata.candidatesTokenCount = completion;

  if (total !== undefined) metadata.totalTokenCount = total;
  else if (prompt !== undefined || completion !== undefined)
    metadata.totalTokenCount = (prompt ?? 0) + (completion ?? 0);
  const reasoning = reasoningTokensFromUsage(usage);

  if (reasoning > 0) metadata.thoughtsTokenCount = reasoning;
  const cached = cachedTokensFromUsage(usage);

  if (cached > 0) metadata.cachedContentTokenCount = cached;

  return out;
};

interface GeminiTemplate {
  out: JsonObject;
  candidate: JsonObject;
}

// SAFETY: every template comes from newTemplate (or JSON parsed from it): `candidates` holds one candidate object.
const templateCandidate = (template: JsonObject): JsonObject =>
  (template.candidates as Json[])[0] as JsonObject;

// SAFETY: newTemplate gives each candidate a `content` object, and no code path replaces it with another type.
const candidateContent = (candidate: JsonObject): JsonObject => candidate.content as JsonObject;

const templateContent = (template: JsonObject): JsonObject =>
  candidateContent(templateCandidate(template));

const newTemplate = (): GeminiTemplate => {
  const candidate: JsonObject = { content: { parts: [], role: "model" }, index: 0 };

  return { out: { candidates: [candidate] }, candidate };
};

/** `ConvertOpenAIResponseToGemini`: one upstream SSE line -> Gemini JSON chunks. */
export const convertOpenAIResponseToGemini = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const state = context.state;

  if (state.value === undefined) {
    state.value = {
      toolCallsAccumulator: undefined,
      contentAccumulatorLength: 0,
      isFirstChunk: false,
    } satisfies GeminiStreamParams;
  }

  // SAFETY: this translator is the only writer of `state.value` and initialises it to a GeminiStreamParams before this read.
  const param = state.value as GeminiStreamParams;

  let payload = line;

  if (payload.trim() === "[DONE]") return [];

  if (payload.startsWith("data:")) payload = payload.slice(5).trim();

  let root: Json;

  try {
    root = JSON.parse(payload);
  } catch {
    return [];
  }

  if (param.toolCallsAccumulator === undefined) param.toolCallsAccumulator = new Map();

  const choices = get(root, "choices");

  if (!isArr(choices)) return [];

  if (choices.length === 0) {
    const usage = get(root, "usage");

    if (usage === undefined) return [];
    const template: JsonObject = { candidates: [], usageMetadata: {} };
    const model = get(root, "model");

    if (model !== undefined) template.model = str(model);

    return [JSON.stringify(setGeminiUsageMetadata(template, usage))];
  }

  const results: string[] = [];
  const modelValue = get(root, "model");

  for (const choice of choices) {
    const base = newTemplate();

    if (modelValue !== undefined) base.out.model = str(modelValue);
    const baseJson = JSON.stringify(base.out);
    let template: JsonObject = JSON.parse(baseJson);
    const delta = get(choice, "delta");

    const role = get(delta, "role");

    if (role !== undefined && param.isFirstChunk) {
      if (str(role) === "assistant") templateContent(template).role = "model";
      param.isFirstChunk = false;
      results.push(JSON.stringify(template));
      continue;
    }

    const chunkOutputs: string[] = [];

    for (const reasoningText of collectReasoningTexts(delta)) {
      const t: JsonObject = JSON.parse(baseJson);

      templateContent(t).parts = [{ thought: true, text: reasoningText }];
      chunkOutputs.push(JSON.stringify(t));
    }

    forEachContentSegment(get(delta, "content"), (isReasoning, segText) => {
      if (segText === "") return;
      const t: JsonObject = JSON.parse(baseJson);

      if (isReasoning) {
        templateContent(t).parts = [{ thought: true, text: segText }];
      } else {
        param.contentAccumulatorLength += segText.length;
        templateContent(t).parts = [{ text: segText }];
      }

      chunkOutputs.push(JSON.stringify(t));
    });

    if (chunkOutputs.length > 0) {
      results.push(...chunkOutputs);
      const chunkFinish = get(choice, "finish_reason");

      // A delta that also carries a finish_reason falls through to the finish handler (bdde391d).
      if (!exists(delta, "tool_calls") && !(typeof chunkFinish === "string" && chunkFinish !== ""))
        continue;
    }

    const toolCalls = get(delta, "tool_calls");
    const deltaFinish = get(choice, "finish_reason");
    const deltaFinishes = typeof deltaFinish === "string" && deltaFinish !== "";

    if (isArr(toolCalls)) {
      for (const toolCall of toolCalls) {
        const toolIndex = asInt(get(toolCall, "index"));
        const toolId = getStr(toolCall, "id");
        const toolType = getStr(toolCall, "type");
        const fn = get(toolCall, "function");
        const thoughtSignature = openAIToolCallThoughtSignature(toolCall);

        // Skip non-function tool calls explicitly marked as other types.
        if (toolType !== "" && toolType !== "function") continue;

        // Deltas may omit the type field while still carrying function data, or only a thought signature.
        if (fn === undefined && thoughtSignature === "") continue;
        const functionName = getStr(fn, "name");
        const functionArgs = getStr(fn, "arguments");
        let acc = param.toolCallsAccumulator.get(toolIndex);

        if (acc === undefined) {
          acc = { id: toolId, name: functionName, arguments: "", thoughtSignature: "" };
          param.toolCallsAccumulator.set(toolIndex, acc);
        }

        if (toolId !== "") acc.id = toolId;

        if (functionName !== "") acc.name = functionName;

        if (functionArgs !== "") acc.arguments += functionArgs;

        if (thoughtSignature !== "") acc.thoughtSignature = thoughtSignature;
      }

      // Nothing is emitted for tool call deltas: the call is output once the stream finishes, which is this very delta
      // when it carries the finish_reason.
      if (!deltaFinishes) continue;
    }

    const finishReason = get(choice, "finish_reason");

    if (typeof finishReason === "string" && finishReason !== "") {
      const candidate = templateCandidate(template);
      candidate.finishReason = mapOpenAIFinishReasonToGemini(finishReason);

      if (param.toolCallsAccumulator.size > 0) {
        // Calls are emitted in ascending index order, as Go does since 38706390 (it sorted the map's keys).
        const parts: Json[] = [];

        for (const [, accumulator] of [...param.toolCallsAccumulator.entries()].sort(
          (a, b) => a[0] - b[0],
        )) {
          const functionCall: JsonObject = {};

          if (accumulator.id !== "") functionCall.id = accumulator.id;
          functionCall.name = accumulator.name;
          functionCall.args = parseArgsToObject(accumulator.arguments);
          const part: JsonObject = { functionCall };

          if (accumulator.thoughtSignature !== "")
            part.thoughtSignature = accumulator.thoughtSignature;
          parts.push(part);
        }

        candidateContent(candidate).parts = parts;
        param.toolCallsAccumulator = new Map();
      }

      results.push(JSON.stringify(template));
      continue;
    }

    const usage = get(root, "usage");

    if (usage !== undefined) {
      template = setGeminiUsageMetadata(template, usage);
      results.push(JSON.stringify(template));
    }
  }

  return results;
};

/** `ConvertOpenAIResponseToGeminiNonStream`. */
export const convertOpenAIResponseToGeminiNonStream = (
  _context: ResponseContext,
  body: string,
): string => {
  let root: Json;

  try {
    root = JSON.parse(body);
  } catch {
    root = {};
  }

  const { out } = newTemplate();
  const model = get(root, "model");

  if (model !== undefined) out.model = str(model);

  const choices = get(root, "choices");

  if (isArr(choices)) {
    // Each choice is a candidate of its own (20c60014).
    const candidates: JsonObject[] = [];

    for (const [position, choice] of choices.entries()) {
      const index = get(choice, "index");
      const choiceIdx = typeof index === "number" ? asInt(index) : position;
      const message = get(choice, "message");
      const candidate: JsonObject = { content: { parts: [], role: "model" }, index: 0 };
      const parts: JsonObject[] = [];

      for (const reasoningText of collectReasoningTexts(message))
        parts.push({ thought: true, text: reasoningText });

      forEachContentSegment(get(message, "content"), (isReasoning, segText) => {
        if (segText === "") return;
        parts.push(isReasoning ? { thought: true, text: segText } : { text: segText });
      });

      const toolCalls = get(message, "tool_calls");

      if (isArr(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (getStr(toolCall, "type") !== "function") continue;
          const fn = get(toolCall, "function");
          const functionID = getStr(toolCall, "id");
          const functionCall: JsonObject = {};

          if (functionID !== "") functionCall.id = functionID;
          functionCall.name = getStr(fn, "name");
          functionCall.args = parseArgsToObject(getStr(fn, "arguments"));
          const part: JsonObject = { functionCall };
          const thoughtSignature = openAIToolCallThoughtSignature(toolCall);

          if (thoughtSignature !== "") part.thoughtSignature = thoughtSignature;
          parts.push(part);
        }
      }

      if (parts.length > 0) candidateContent(candidate).parts = parts;
      const finishReason = get(choice, "finish_reason");

      if (typeof finishReason === "string" && finishReason !== "") {
        candidate.finishReason = mapOpenAIFinishReasonToGemini(finishReason);
      }

      candidate.index = choiceIdx;
      candidates.push(candidate);
    }

    if (candidates.length > 0) out.candidates = candidates;
  }

  const usage = get(root, "usage");

  if (usage !== undefined) setGeminiUsageMetadata(out, usage);

  return JSON.stringify(out);
};

/** `GeminiTokenCount`. */
export const geminiTokenCount = (count: number): string =>
  `{"totalTokens":${count},"promptTokensDetails":[{"modality":"TEXT","tokenCount":${count}}]}`;

export const openAIToGeminiResponse: ResponseTransform = {
  stream: convertOpenAIResponseToGemini,
  nonStream: convertOpenAIResponseToGeminiNonStream,
  tokenCount: geminiTokenCount,
};
