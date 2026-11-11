/**
 * Codex (Responses) stream/non-stream response -> OpenAI Chat Completions.
 *
 * Go source: internal/translator/codex/openai/chat-completions/codex_openai_response.go
 * (ConvertCodexResponseToOpenAI, ConvertCodexResponseToOpenAINonStream and helpers). The per-request state mirrors
 * `ConvertCliToOpenAIParams`; image de-duplication keeps the last base64 payload per item id instead of its hash.
 */
import {
  asInt,
  asString,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import {
  escapeApplyPatchInputFragment,
  isApplyPatchCustomTool,
  wrapApplyPatchInput,
} from "../../common/apply-patch.ts";
import {
  collectResponsesToolWinners,
  qualifyResponsesNamespaceToolName,
} from "../../common/responses-tools.ts";
import type { ResponseContext } from "../../registry.ts";
import { buildShortNameMap, collectRequestToolNames, customToolDefinition } from "./request.ts";

interface ToolCallStreamState {
  index: number;
  argumentsEmitted: boolean;
  patch: boolean;
  inputStarted: boolean;
  inputClosed: boolean;
  done: boolean;
}

/** Go `ConvertCliToOpenAIParams`. */
export interface ConvertCliToOpenAIParams {
  serviceTier: string;
  responseId: string;
  createdAt: number;
  model: string;
  functionCallIndex: number;
  readonly toolCallStates: Map<string, ToolCallStreamState>;
  currentToolCall: ToolCallStreamState | undefined;
  readonly citationKeys: Set<string>;
  emittedTextRunes: number;
  readonly lastImageByItemId: Map<string, string>;
  reverseNames: Map<string, string> | undefined;
}

const newParams = (model: string): ConvertCliToOpenAIParams => ({
  serviceTier: "",
  responseId: "",
  createdAt: 0,
  model,
  functionCallIndex: -1,
  toolCallStates: new Map(),
  currentToolCall: undefined,
  citationKeys: new Set(),
  emittedTextRunes: 0,
  lastImageByItemId: new Map(),
  reverseNames: undefined,
});

const runeCount = (text: string): number => {
  let count = 0;

  for (const _ of text) count++;

  return count;
};

const isToolCallType = (itemType: string): boolean =>
  itemType === "function_call" || itemType === "custom_tool_call";

const toolCallArguments = (item: Json | undefined): string =>
  asString(get(item, asString(get(item, "type")) === "custom_tool_call" ? "input" : "arguments"));

/** `buildReverseMapFromOriginalOpenAI`: shortened tool name -> original tool name. */
const reverseMapFromOriginal = (original: Json | undefined): Map<string, string> => {
  const reverse = new Map<string, string>();
  const names = collectRequestToolNames(original);

  if (names.length > 0)
    for (const [name, short] of buildShortNameMap(names)) reverse.set(short, name);

  return reverse;
};

const mimeTypeFromOutputFormat = (outputFormat: string): string => {
  if (outputFormat === "") return "image/png";

  if (outputFormat.includes("/")) return outputFormat;

  switch (outputFormat.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
};

/** `codexResponseServiceTier`: only an actual non-empty upstream tier. */
const responseServiceTier = (response: Json | undefined): string => {
  const tier = get(response, "service_tier");

  return typeof tier === "string" ? tier.trim() : "";
};

/** `setCodexCacheWriteTokens`: keeps an upstream non-negative integer count. */
const setCacheWriteTokens = (template: Json, usage: Json | undefined): Json => {
  const value = get(usage, "input_tokens_details.cache_write_tokens");

  if (value === undefined || value === null) return template;

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return template;
  template = set(template, "usage.prompt_tokens_details.cache_write_tokens", value);

  return set(template, "usage.prompt_tokens_details.cached_creation_tokens", value);
};

const setUsage = (template: Json, usage: Json | undefined): Json => {
  const output = get(usage, "output_tokens");

  if (output !== undefined) template = set(template, "usage.completion_tokens", asInt(output));
  const total = get(usage, "total_tokens");

  if (total !== undefined) template = set(template, "usage.total_tokens", asInt(total));
  const input = get(usage, "input_tokens");

  if (input !== undefined) template = set(template, "usage.prompt_tokens", asInt(input));
  const cached = get(usage, "input_tokens_details.cached_tokens");

  if (cached !== undefined)
    template = set(template, "usage.prompt_tokens_details.cached_tokens", asInt(cached));
  template = setCacheWriteTokens(template, usage);
  const reasoning = get(usage, "output_tokens_details.reasoning_tokens");

  if (reasoning !== undefined) {
    template = set(template, "usage.completion_tokens_details.reasoning_tokens", asInt(reasoning));
  }

  return template;
};

const annotationResults = (value: Json | undefined): Json[] => {
  if (value === undefined) return [];

  return isJsonArray(value) ? [...value] : [value];
};

const annotationsFromEvent = (event: Json | undefined): Json[] => {
  const annotations: Json[] = [];

  for (const path of ["annotation", "annotations", "part.annotations"]) {
    annotations.push(...annotationResults(get(event, path)));
  }

  const item = get(event, "item");

  if (item !== undefined) {
    annotations.push(...annotationResults(get(item, "annotations")));
    const content = get(item, "content");

    if (isJsonArray(content))
      for (const part of content) annotations.push(...annotationResults(get(part, "annotations")));
  }

  return annotations;
};

/** `buildCodexURLCitations`. */
const buildUrlCitations = (
  annotations: readonly Json[],
  runeOffset: number,
  seen: Set<string>,
): Json[] => {
  const citations: Json[] = [];

  for (const annotation of annotations) {
    if (asString(get(annotation, "type")) !== "url_citation") continue;
    const rawStart = asInt(get(annotation, "start_index"));
    const rawEnd = asInt(get(annotation, "end_index"));
    const start = rawStart + runeOffset;
    const end = rawEnd + runeOffset;

    if (start < 0 || end < start) continue;
    const url = asString(get(annotation, "url"));
    const id = asString(get(annotation, "id"));
    const key = url === "" ? `${id}\u0000${rawStart}` : `${url}\u0000${rawStart}`;
    const keys = [key];

    if (id !== "") keys.push(`id\u0000${id}`);

    if (keys.some((k) => seen.has(k))) continue;

    for (const k of keys) seen.add(k);
    citations.push({
      type: "url_citation",
      url,
      title: asString(get(annotation, "title")),
      start_index: start,
      end_index: end,
    });
  }

  return citations;
};

const registerToolCallState = (
  p: ConvertCliToOpenAIParams,
  event: Json | undefined,
  item: Json | undefined,
  state: ToolCallStreamState,
): void => {
  const eventItemId = asString(get(event, "item_id"));

  if (eventItemId !== "") p.toolCallStates.set(`item:${eventItemId}`, state);
  const itemId = asString(get(item, "id"));

  if (itemId !== "") p.toolCallStates.set(`item:${itemId}`, state);
  const outputIndex = get(event, "output_index");

  if (outputIndex !== undefined)
    p.toolCallStates.set(`output:${JSON.stringify(outputIndex)}`, state);
  p.currentToolCall = state;
};

const findToolCallState = (
  p: ConvertCliToOpenAIParams,
  event: Json | undefined,
  item: Json | undefined,
): ToolCallStreamState | undefined => {
  const eventItemId = asString(get(event, "item_id"));

  if (eventItemId !== "") {
    const state = p.toolCallStates.get(`item:${eventItemId}`);

    if (state !== undefined) return state;
  }

  const itemId = asString(get(item, "id"));

  if (itemId !== "") {
    const state = p.toolCallStates.get(`item:${itemId}`);

    if (state !== undefined) return state;
  }

  const outputIndex = get(event, "output_index");

  if (outputIndex !== undefined) {
    const state = p.toolCallStates.get(`output:${JSON.stringify(outputIndex)}`);

    if (state !== undefined) return state;
  }

  return p.currentToolCall;
};

/** `collectChatToolWinners`: normalizes nested Chat `custom` declarations before collecting the Responses winners. */
const collectChatToolWinners = (
  original: Json | undefined,
): ReturnType<typeof collectResponsesToolWinners> => {
  const tools = get(original, "tools");

  if (
    original === undefined ||
    !isJsonArray(tools) ||
    !tools.some((tool) => isJsonObject(get(tool, "custom")))
  ) {
    return collectResponsesToolWinners(original);
  }

  const flattened = tools.map((tool) =>
    asString(get(tool, "type")) === "custom" && isJsonObject(get(tool, "custom"))
      ? set(cloneJson(customToolDefinition(tool)), "type", "custom")
      : tool,
  );

  return collectResponsesToolWinners(set(cloneJson(original), "tools", flattened));
};

/** `isOriginalCustomPatch`: never promotes an ordinary same-name function to custom. */
const isOriginalCustomPatch = (original: Json | undefined, item: Json | undefined): boolean => {
  if (asString(get(item, "type")) !== "custom_tool_call") return false;

  const name = qualifyResponsesNamespaceToolName(
    asString(get(item, "namespace")),
    asString(get(item, "name")),
  );

  const tools = get(original, "tools");

  if (isJsonArray(tools)) {
    for (const tool of tools) {
      if (
        asString(get(tool, "type")) === "function" &&
        asString(get(tool, "function.name")) === name
      )
        return false;
    }
  }

  const winner = collectChatToolWinners(original).get(name);

  return winner !== undefined && isApplyPatchCustomTool(winner.tool);
};

const finishPatchChatArguments = (state: ToolCallStreamState, input: string): string => {
  if (state.inputClosed) return "";
  state.inputClosed = true;

  if (state.inputStarted) return '"}';

  return wrapApplyPatchInput(input);
};

const toolCallDelta = (index: number, argumentsText: string): Json => ({
  index,
  function: { arguments: argumentsText },
});

/** Adds an image (stream partial or completed item) to `choices.0.delta.images`; `undefined` = skip chunk. */
const addImage = (
  p: ConvertCliToOpenAIParams,
  template: Json,
  itemId: string,
  b64: string,
  outputFormat: string,
): Json | undefined => {
  if (b64 === "") return undefined;

  if (itemId !== "") {
    if (p.lastImageByItemId.get(itemId) === b64) return undefined;
    p.lastImageByItemId.set(itemId, b64);
  }

  const imageUrl = `data:${mimeTypeFromOutputFormat(outputFormat)};base64,${b64}`;
  const images = get(template, "choices.0.delta.images");

  if (!isJsonArray(images)) template = set(template, "choices.0.delta.images", []);
  const existing = get(template, "choices.0.delta.images");
  const imageIndex = isJsonArray(existing) ? existing.length : 0;
  const payload: JsonObject = { type: "image_url", image_url: { url: "" } };
  set(payload, "index", imageIndex);
  set(payload, "image_url.url", imageUrl);
  template = set(template, "choices.0.delta.role", "assistant");

  return set(template, "choices.0.delta.images.-1", payload);
};

const STREAM_TEMPLATE = (): Json => ({
  id: "",
  object: "chat.completion.chunk",
  created: 12345,
  model: "model",
  choices: [{ index: 0, delta: {}, finish_reason: null, native_finish_reason: null }],
});

/** `ConvertCodexResponseToOpenAI` (one upstream SSE line -> zero or one chat chunk). */
export const convertCodexResponseToOpenAI = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  if (context.state.value === undefined) context.state.value = newParams(context.model);
  // SAFETY: this translator is the only writer of `state.value` and initialises it to a ConvertCliToOpenAIParams before this read.
  const p = context.state.value as ConvertCliToOpenAIParams;

  if (!line.startsWith("data:")) return [];
  const payload = line.slice(5).trim();
  const root = tryParseJson(payload);
  let template = STREAM_TEMPLATE();

  const tier = responseServiceTier(get(root, "response"));

  if (tier !== "") p.serviceTier = tier;
  else {
    const rootTier = responseServiceTier(root);

    if (rootTier !== "") p.serviceTier = rootTier;
  }

  if (p.serviceTier !== "") template = set(template, "service_tier", p.serviceTier);

  const dataType = asString(get(root, "type"));

  if (dataType === "response.created") {
    p.responseId = asString(get(root, "response.id"));
    p.createdAt = asInt(get(root, "response.created_at"));
    p.model = asString(get(root, "response.model"));

    return [];
  }

  const eventModel = get(root, "model");

  if (eventModel !== undefined) template = set(template, "model", asString(eventModel));
  else if (p.model !== "") template = set(template, "model", p.model);
  else if (context.model !== "") template = set(template, "model", context.model);

  template = set(template, "created", p.createdAt);
  template = set(template, "id", p.responseId);

  const usage = get(root, "response.usage");

  if (usage !== undefined) template = setUsage(template, usage);

  const original = context.originalRequest;
  const reverse = (): Map<string, string> => (p.reverseNames ??= reverseMapFromOriginal(original));
  const restoreName = (name: string): string => reverse().get(name) ?? name;

  if (
    dataType === "response.reasoning_summary_text.delta" ||
    dataType === "response.reasoning_text.delta"
  ) {
    const delta = get(root, "delta");

    if (delta !== undefined) {
      template = set(template, "choices.0.delta.role", "assistant");
      template = set(template, "choices.0.delta.reasoning_content", asString(delta));
    }
  } else if (
    dataType === "response.reasoning_summary_text.done" ||
    dataType === "response.reasoning_text.done"
  ) {
    template = set(template, "choices.0.delta.role", "assistant");
    template = set(template, "choices.0.delta.reasoning_content", "\n\n");
  } else if (dataType === "response.output_text.delta") {
    const deltaValue = get(root, "delta");

    if (deltaValue !== undefined) {
      const delta = asString(deltaValue);
      template = set(template, "choices.0.delta.role", "assistant");
      template = set(template, "choices.0.delta.content", delta);
      p.emittedTextRunes += runeCount(delta);
    }
  } else if (
    dataType === "response.output_text.annotation.added" ||
    dataType === "response.output_text.done" ||
    dataType === "response.content_part.done"
  ) {
    const citations = buildUrlCitations(
      annotationsFromEvent(root),
      p.emittedTextRunes,
      p.citationKeys,
    );

    if (citations.length === 0) return [];
    template = set(template, "choices.0.delta.role", "assistant");
    template = set(template, "choices.0.delta.annotations", citations);
  } else if (dataType === "response.image_generation_call.partial_image") {
    const next = addImage(
      p,
      template,
      asString(get(root, "item_id")),
      asString(get(root, "partial_image_b64")),
      asString(get(root, "output_format")),
    );

    if (next === undefined) return [];
    template = next;
  } else if (dataType === "response.completed" || dataType === "response.incomplete") {
    let finishReason = "stop";
    let nativeFinishReason = finishReason;

    if (dataType === "response.incomplete") {
      nativeFinishReason = asString(get(root, "response.incomplete_details.reason"));

      switch (nativeFinishReason) {
        case "max_tokens":
        case "max_output_tokens":
          finishReason = "length";
          break;
        case "content_filter":
          finishReason = "content_filter";
          break;
      }
    } else if (p.functionCallIndex !== -1) {
      finishReason = "tool_calls";
      nativeFinishReason = finishReason;
    }

    template = set(template, "choices.0.finish_reason", finishReason);
    template = set(template, "choices.0.native_finish_reason", nativeFinishReason);
  } else if (dataType === "response.output_item.added") {
    const item = get(root, "item");

    if (item === undefined || !isToolCallType(asString(get(item, "type")))) return [];
    p.functionCallIndex++;

    const state: ToolCallStreamState = {
      index: p.functionCallIndex,
      argumentsEmitted: false,
      patch: isOriginalCustomPatch(original, item),
      inputStarted: false,
      inputClosed: false,
      done: false,
    };

    registerToolCallState(p, root, item, state);

    const call: JsonObject = {
      index: state.index,
      id: asString(get(item, "call_id")),
      type: "function",
      function: { name: restoreName(asString(get(item, "name"))), arguments: "" },
    };

    template = set(template, "choices.0.delta.role", "assistant");
    template = set(template, "choices.0.delta.tool_calls", []);
    template = set(template, "choices.0.delta.tool_calls.-1", call);
  } else if (
    dataType === "response.function_call_arguments.delta" ||
    dataType === "response.custom_tool_call_input.delta"
  ) {
    const state = findToolCallState(p, root, undefined);
    let deltaValue = asString(get(root, "delta"));

    if (state === undefined || state.done || deltaValue === "") return [];
    state.argumentsEmitted = true;

    if (state.patch) {
      deltaValue = escapeApplyPatchInputFragment(deltaValue);

      if (!state.inputStarted) {
        deltaValue = `{"input":"${deltaValue}`;
        state.inputStarted = true;
      }
    }

    template = set(template, "choices.0.delta.tool_calls", []);
    template = set(
      template,
      "choices.0.delta.tool_calls.-1",
      toolCallDelta(state.index, deltaValue),
    );
  } else if (
    dataType === "response.function_call_arguments.done" ||
    dataType === "response.custom_tool_call_input.done"
  ) {
    const state = findToolCallState(p, root, undefined);

    if (
      state === undefined ||
      state.done ||
      state.inputClosed ||
      (state.argumentsEmitted && !state.patch)
    )
      return [];
    // Fallback: no delta events were received, emit the full arguments as a single chunk.
    const field = dataType === "response.custom_tool_call_input.done" ? "input" : "arguments";
    state.argumentsEmitted = true;
    let fullArgs = asString(get(root, field));

    if (state.patch) fullArgs = finishPatchChatArguments(state, fullArgs);

    if (fullArgs === "") return [];
    template = set(template, "choices.0.delta.tool_calls", []);
    template = set(template, "choices.0.delta.tool_calls.-1", toolCallDelta(state.index, fullArgs));
  } else if (dataType === "response.output_item.done") {
    const item = get(root, "item");

    if (item === undefined) return [];
    const itemType = asString(get(item, "type"));

    if (itemType === "message") {
      const citations = buildUrlCitations(
        annotationsFromEvent(root),
        p.emittedTextRunes,
        p.citationKeys,
      );

      if (citations.length === 0) return [];
      template = set(template, "choices.0.delta.role", "assistant");
      template = set(template, "choices.0.delta.annotations", citations);

      return [JSON.stringify(template)];
    }

    if (itemType === "image_generation_call") {
      const next = addImage(
        p,
        template,
        asString(get(item, "id")),
        asString(get(item, "result")),
        asString(get(item, "output_format")),
      );

      return next === undefined ? [] : [JSON.stringify(next)];
    }

    if (!isToolCallType(itemType)) return [];

    const state = findToolCallState(p, root, item);

    if (state !== undefined) {
      if (state.done) return [];
      state.done = true;

      if (state.argumentsEmitted && (!state.patch || state.inputClosed)) return [];
      // The tool was announced, but no argument event arrived. Emit only the completed arguments.
      state.argumentsEmitted = true;
      let fullArgs = toolCallArguments(item);

      if (state.patch) fullArgs = finishPatchChatArguments(state, fullArgs);

      if (fullArgs === "") return [];
      template = set(template, "choices.0.delta.tool_calls", []);
      template = set(
        template,
        "choices.0.delta.tool_calls.-1",
        toolCallDelta(state.index, fullArgs),
      );

      return [JSON.stringify(template)];
    }

    // Fallback path: the upstream skipped output_item.added, so emit the complete tool call now.
    p.functionCallIndex++;

    const fallback: ToolCallStreamState = {
      index: p.functionCallIndex,
      argumentsEmitted: true,
      patch: isOriginalCustomPatch(original, item),
      inputStarted: false,
      inputClosed: false,
      done: true,
    };

    registerToolCallState(p, root, item, fallback);
    let fullArgs = toolCallArguments(item);

    if (fallback.patch) fullArgs = finishPatchChatArguments(fallback, fullArgs);

    const call: JsonObject = {
      index: fallback.index,
      id: asString(get(item, "call_id")),
      type: "function",
      function: { name: restoreName(asString(get(item, "name"))), arguments: fullArgs },
    };

    template = set(template, "choices.0.delta.tool_calls", []);
    template = set(template, "choices.0.delta.role", "assistant");
    template = set(template, "choices.0.delta.tool_calls.-1", call);
  } else {
    return [];
  }

  return [JSON.stringify(template)];
};

/** `ConvertCodexResponseToOpenAINonStream`: a terminal `response.completed|incomplete` event -> chat completion. */
export const convertCodexResponseToOpenAINonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root = tryParseJson(body);
  const responseType = asString(get(root, "type"));

  if (responseType !== "response.completed" && responseType !== "response.incomplete") return "";
  const original = context.originalRequest;
  const response = get(root, "response");

  let template: Json = {
    id: "",
    object: "chat.completion",
    created: 123456,
    model: "model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, reasoning_content: null, tool_calls: null },
        finish_reason: null,
        native_finish_reason: null,
      },
    ],
  };

  const tier = responseServiceTier(response);

  if (tier !== "") template = set(template, "service_tier", tier);
  else {
    const rootTier = responseServiceTier(root);

    if (rootTier !== "") template = set(template, "service_tier", rootTier);
  }

  const model = get(response, "model");

  if (model !== undefined) template = set(template, "model", asString(model));
  const createdAt = get(response, "created_at");
  template = set(
    template,
    "created",
    createdAt !== undefined ? asInt(createdAt) : Math.floor(Date.now() / 1000),
  );
  const id = get(response, "id");

  if (id !== undefined) template = set(template, "id", asString(id));
  const usage = get(response, "usage");

  if (usage !== undefined) template = setUsage(template, usage);

  const toolCalls: Json[] = [];
  const images: Json[] = [];
  const output = get(response, "output");

  if (isJsonArray(output)) {
    let contentText = "";
    let reasoningText = "";
    const messageAnnotations: Json[] = [];
    const annotationKeys = new Set<string>();
    let contentRuneOffset = 0;
    const reverse = reverseMapFromOriginal(original);

    for (const item of output) {
      switch (asString(get(item, "type"))) {
        case "reasoning": {
          const summary = get(item, "summary");

          if (isJsonArray(summary)) {
            for (const part of summary) {
              if (asString(get(part, "type")) === "summary_text") {
                const text = asString(get(part, "text"));

                if (text !== "") reasoningText += text;
                break;
              }
            }
          }

          const content = get(item, "content");

          if (isJsonArray(content)) {
            for (const part of content) {
              if (asString(get(part, "type")) === "reasoning_text") {
                const text = asString(get(part, "text"));

                if (text !== "") reasoningText += text;
              }
            }
          }

          break;
        }

        case "message": {
          const content = get(item, "content");

          if (!isJsonArray(content)) break;

          for (const part of content) {
            if (asString(get(part, "type")) !== "output_text") continue;
            const text = asString(get(part, "text"));
            contentText += text;
            messageAnnotations.push(
              ...buildUrlCitations(
                annotationResults(get(part, "annotations")),
                contentRuneOffset,
                annotationKeys,
              ),
            );
            contentRuneOffset += runeCount(text);
          }

          break;
        }

        case "function_call":
        case "custom_tool_call": {
          const call: JsonObject = {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          };

          const callId = get(item, "call_id");

          if (callId !== undefined) set(call, "id", asString(callId));
          const name = get(item, "name");

          if (name !== undefined) {
            const n = asString(name);
            set(call, "function.name", reverse.get(n) ?? n);
          }

          let fullArgs = toolCallArguments(item);

          if (isOriginalCustomPatch(original, item)) fullArgs = wrapApplyPatchInput(fullArgs);
          set(call, "function.arguments", fullArgs);
          toolCalls.push(call);
          break;
        }

        case "image_generation_call": {
          const b64 = asString(get(item, "result"));

          if (b64 === "") break;
          const imageUrl = `data:${mimeTypeFromOutputFormat(asString(get(item, "output_format")))};base64,${b64}`;
          const payload: JsonObject = { type: "image_url", image_url: { url: "" } };
          set(payload, "index", images.length);
          set(payload, "image_url.url", imageUrl);
          images.push(payload);
          break;
        }
      }
    }

    if (contentText !== "") template = set(template, "choices.0.message.content", contentText);

    if (reasoningText !== "")
      template = set(template, "choices.0.message.reasoning_content", reasoningText);

    if (messageAnnotations.length > 0)
      template = set(template, "choices.0.message.annotations", messageAnnotations);

    if (toolCalls.length > 0) template = set(template, "choices.0.message.tool_calls", toolCalls);

    if (images.length > 0) template = set(template, "choices.0.message.images", images);
  }

  const status = get(response, "status");

  if (status !== undefined) {
    let finishReason = "";
    let nativeFinishReason = "";

    switch (asString(status)) {
      case "completed":
        finishReason = "stop";
        nativeFinishReason = finishReason;

        if (toolCalls.length > 0) {
          finishReason = "tool_calls";
          nativeFinishReason = finishReason;
        }

        break;
      case "incomplete":
        nativeFinishReason = asString(get(response, "incomplete_details.reason"));

        switch (nativeFinishReason) {
          case "max_tokens":
          case "max_output_tokens":
            finishReason = "length";
            break;
          case "content_filter":
            finishReason = "content_filter";
            break;
          default:
            finishReason = "stop";
        }

        break;
    }

    if (finishReason !== "") {
      template = set(template, "choices.0.finish_reason", finishReason);
      template = set(template, "choices.0.native_finish_reason", nativeFinishReason);
    }
  }

  return JSON.stringify(template);
};
