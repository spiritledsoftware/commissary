/**
 * xAI Responses request normalisation of `input` items and client output controls.
 *
 * Go source: internal/runtime/executor/xai_executor_request.go (preserveXAIResponsesOutputControls,
 * normalizeXAIInputCustomToolCalls, xaiCustomToolCallArguments, xaiCustomToolCallOutput, normalizeXAIImageRefs) and
 * xai_executor_response.go (normalizeXAIInputNamespaceToolCalls*, normalizeXAIInputReasoningItems,
 * mergeAdjacentXAIInputReasoningSummaries, sanitizeXAIInputEncryptedContent).
 * All functions mutate the parsed body in place and return it.
 */
import {
  asString,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  parseJsonOrText,
  tryParseJson,
} from "@commissary/json";
import { inspectGrokEncryptedContent, stripRouterSuffix } from "@commissary/translation/signature";
import { isOpenRouterUpstreamUrl } from "../helps/responses-signature.ts";
import { hasFunctionToolNamed, qualifyNamespaceToolName } from "./tools.ts";

const trimmed = (value: Json | undefined, path: string): string =>
  asString(get(value, path)).trim();

const inputItems = (body: Json): Json[] | undefined => {
  const input = get(body, "input");

  return isJsonArray(input) ? input : undefined;
};

/** `preserveXAIResponsesOutputControls`: OpenAI/Responses clients keep their sampling and output limits. */
export const preserveOutputControls = (
  body: Json,
  source: Json | undefined,
  from: string,
): Json => {
  let maxOutputTokens: Json | undefined;

  switch (from) {
    case "openai":
      maxOutputTokens = get(source, "max_completion_tokens");

      if (maxOutputTokens === undefined || maxOutputTokens === null)
        maxOutputTokens = get(source, "max_tokens");
      break;
    case "openai-response":
      maxOutputTokens = get(source, "max_output_tokens");
      break;
    default:
      return body;
  }

  if (maxOutputTokens !== undefined && maxOutputTokens !== null)
    set(body, "max_output_tokens", cloneJson(maxOutputTokens));

  for (const field of ["temperature", "top_p", "top_k"]) {
    const value = get(source, field);

    if (value !== undefined && value !== null) set(body, field, cloneJson(value));
  }

  return body;
};

// ---------------------------------------------------------------------------------------------------------------
// Custom tool calls
// ---------------------------------------------------------------------------------------------------------------

const customToolCallArguments = (input: Json | undefined): string => {
  if (input === undefined) return "{}";

  if (typeof input === "string") {
    const text = input.trim();

    // Not JSON: wrapped below.
    if (isJsonObject(tryParseJson(text))) return text;

    return `{"input":${JSON.stringify(input)}}`;
  }

  if (isJsonObject(input)) return JSON.stringify(input);

  return `{"input":${JSON.stringify(input)}}`;
};

const customToolCallOutput = (output: Json | undefined): string => {
  if (output === undefined) return "";

  return typeof output === "string" ? output : JSON.stringify(output);
};

/** `normalizeXAIInputCustomToolCalls`: replayed custom tool calls become function calls (custom tools are functions). */
export const normalizeInputCustomToolCalls = (body: Json): Json => {
  const input = inputItems(body);

  if (input === undefined) return body;
  let changed = false;
  const items: Json[] = [];

  for (const item of input) {
    switch (asString(get(item, "type"))) {
      case "custom_tool_call": {
        const callId = trimmed(item, "call_id");
        const name = trimmed(item, "name");
        changed = true;

        if (callId === "" || name === "") break;
        items.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: customToolCallArguments(get(item, "input")),
        });
        break;
      }

      case "custom_tool_call_output": {
        const callId = trimmed(item, "call_id");
        changed = true;

        if (callId === "") break;
        items.push({
          type: "function_call_output",
          call_id: callId,
          output: customToolCallOutput(get(item, "output")),
        });
        break;
      }

      default:
        items.push(item);
    }
  }

  return changed ? set(body, "input", items) : body;
};

// ---------------------------------------------------------------------------------------------------------------
// Namespace tool calls
// ---------------------------------------------------------------------------------------------------------------

/** `normalizeXAIInputNamespaceToolCallsWithFold`: replayed namespaced calls follow the flattened/folded tool names. */
export const normalizeInputNamespaceToolCalls = (body: Json, shouldFold: boolean): Json => {
  const input = inputItems(body);

  if (input === undefined) return body;

  for (const item of input) {
    if (!isJsonObject(item) || asString(item["type"]) !== "function_call") continue;
    const namespaceName = trimmed(item, "namespace");
    const toolName = trimmed(item, "name");

    if (namespaceName === "") continue;
    const qualified = qualifyNamespaceToolName(namespaceName, toolName);

    const folded = hasFunctionToolNamed(body, namespaceName)
      ? true
      : hasFunctionToolNamed(body, qualified)
        ? false
        : shouldFold;

    if (folded) {
      const dispatcherArgs: JsonObject = { name: toolName };
      const rawArgs = asString(item["arguments"]);

      if (rawArgs !== "") {
        dispatcherArgs["arguments"] = parseJsonOrText(rawArgs);
      }

      item["name"] = namespaceName;
      item["arguments"] = JSON.stringify(dispatcherArgs);
      delete item["namespace"];
      continue;
    }

    if (qualified === "") continue;
    item["name"] = qualified;
    delete item["namespace"];
  }

  return body;
};

// ---------------------------------------------------------------------------------------------------------------
// Reasoning items
// ---------------------------------------------------------------------------------------------------------------

const canMergeReasoningSummary = (previous: Json | undefined, current: Json): boolean => {
  if (
    asString(get(previous, "type")) !== "reasoning" ||
    asString(get(current, "type")) !== "reasoning"
  )
    return false;

  if (!isJsonArray(get(previous, "summary"))) return false;
  const summary = get(current, "summary");

  if (!isJsonArray(summary) || summary.length === 0) return false;

  return (
    isJsonObject(current) &&
    Object.keys(current).every((name) => name === "type" || name === "summary")
  );
};

/** `mergeAdjacentXAIInputReasoningSummaries`. */
export const mergeAdjacentReasoningSummaries = (body: Json): Json => {
  const input = inputItems(body);

  if (input === undefined) return body;
  let changed = false;
  const items: Json[] = [];

  for (const item of input) {
    const previous = items[items.length - 1];

    if (previous !== undefined && canMergeReasoningSummary(previous, item)) {
      const target = get(previous, "summary");
      const extra = get(item, "summary");

      if (isJsonArray(target) && isJsonArray(extra)) {
        target.push(...extra);
        changed = true;
        continue;
      }
    }

    items.push(item);
  }

  return changed ? set(body, "input", items) : body;
};

/** `normalizeXAIInputReasoningItems`: null `content`/`encrypted_content` are dropped, adjacent summaries merge. */
export const normalizeInputReasoningItems = (body: Json): Json => {
  const input = inputItems(body);

  if (input === undefined) return body;

  for (const item of input) {
    if (!isJsonObject(item) || asString(item["type"]) !== "reasoning") continue;

    if (item["content"] === null) delete item["content"];

    if (item["encrypted_content"] === null) delete item["encrypted_content"];
  }

  return mergeAdjacentReasoningSummaries(body);
};

/**
 * `sanitizeXAIInputEncryptedContent[WithOptions]`: reasoning/compaction blobs that are not replay-safe Grok ciphertext
 * are removed (the whole `compaction` item, only the `encrypted_content` of a `reasoning` item). A router suffix
 * (OpenRouter's routing tag) is kept with `allowRouterSuffix`, otherwise stripped to the native ciphertext (Go
 * a68c7d8e). Request preparation does not know the upstream yet and keeps it; `sanitizeInputEncryptedContentForBaseUrl`
 * decides once the base URL is known.
 */
export const sanitizeInputEncryptedContent = (body: Json, allowRouterSuffix = false): Json => {
  const input = inputItems(body);

  if (input === undefined) return body;
  const items: Json[] = [];
  let changed = false;

  for (const item of input) {
    const type = trimmed(item, "type");

    if (
      (type !== "reasoning" && type !== "compaction") ||
      !isJsonObject(item) ||
      !("encrypted_content" in item)
    ) {
      items.push(item);
      continue;
    }

    const encrypted = item["encrypted_content"];
    const grok = typeof encrypted === "string" ? inspectGrokEncryptedContent(encrypted) : undefined;

    if (typeof encrypted === "string" && grok !== undefined) {
      if (grok.routerSuffix !== "" && !allowRouterSuffix) {
        item["encrypted_content"] = stripRouterSuffix(encrypted, grok.routerSuffix);
        changed = true;
      }

      items.push(item);
      continue;
    }

    changed = true;

    if (type === "compaction") continue;
    delete item["encrypted_content"];
    items.push(item);
  }

  if (!changed) return body;
  set(body, "input", items);

  return mergeAdjacentReasoningSummaries(body);
};

/** `sanitizeXAIInputEncryptedContentForBaseURL`: the suffix survives on OpenRouter only. */
export const sanitizeInputEncryptedContentForBaseUrl = (body: Json, baseUrl: string): Json =>
  sanitizeInputEncryptedContent(body, isOpenRouterUpstreamUrl(baseUrl));

// ---------------------------------------------------------------------------------------------------------------
// Image references
// ---------------------------------------------------------------------------------------------------------------

const normalizeImageRef = (value: Json | undefined): boolean => {
  if (!isJsonObject(value)) return false;
  const originalUrl = typeof value["url"] === "string" ? value["url"] : "";
  let url = originalUrl.trim();
  const imageUrl = value["image_url"];
  const hasImageUrl = "image_url" in value;

  if (url === "") {
    if (typeof imageUrl === "string") url = imageUrl.trim();
    else if (isJsonObject(imageUrl) && typeof imageUrl["url"] === "string")
      url = imageUrl["url"].trim();
  }

  if (url === "") return false;

  if (url === originalUrl && !hasImageUrl) return false;
  value["url"] = url;
  delete value["image_url"];

  return true;
};

const normalizeImageRefsIn = (value: Json): void => {
  if (isJsonArray(value)) {
    for (const child of value) normalizeImageRefsIn(child);

    return;
  }

  if (!isJsonObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (key === "image") normalizeImageRef(child);
    else if ((key === "images" || key === "reference_images") && isJsonArray(child)) {
      for (const ref of child) normalizeImageRef(ref);
    }

    normalizeImageRefsIn(child);
  }
};

/**
 * `normalizeXAIImageRefs`: `{"image":{"image_url":"..."}}` becomes `{"image":{"url":"..."}}` for `image`, `images` and
 * `reference_images` anywhere in the tree (chat content parts `{"type":"image_url",...}` are untouched).
 */
export const normalizeImageRefs = (body: Json): Json => {
  normalizeImageRefsIn(body);

  return body;
};
