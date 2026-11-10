/**
 * OpenAI Responses request -> Codex request (thin: Codex is Responses-shaped).
 *
 * Go source: internal/translator/codex/openai/responses/codex_openai-responses_request.go
 * (ConvertOpenAIResponsesRequestToCodex and helpers). Like Go, the model is not set here (the executor does it).
 */
import {
  asString,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import { sanitizeOrphanResponsesToolOutputs } from "../../common/responses.ts";

const deleteFields = (body: JsonObject, ...paths: string[]): void => {
  for (const path of paths) if (get(body, path) !== undefined) del(body, path);
};

const setRequiredBool = (body: JsonObject, path: string, value: boolean): void => {
  if (get(body, path) === value) return;
  set(body, path, value);
};

const REASONING = "reasoning.encrypted_content";

const SOURCES = "web_search_call.action.sources";

/** `setCodexRequiredInclude`. */
const setRequiredInclude = (body: JsonObject): void => {
  const current = get(body, "include");
  let includeSources = false;

  if (isJsonArray(current)) {
    includeSources = current.some((value) => value === SOURCES);

    if (!includeSources && current.length === 1 && current[0] === REASONING) return;

    if (
      includeSources &&
      current.length === 2 &&
      current[0] === REASONING &&
      current[1] === SOURCES
    )
      return;
  }

  set(body, "include", includeSources ? [REASONING, SOURCES] : [REASONING]);
};

const stripPromptCacheBreakpointFromParts = (parts: Json[]): void => {
  for (const part of parts) {
    if (isJsonObject(part) && get(part, "prompt_cache_breakpoint") !== undefined)
      delete part["prompt_cache_breakpoint"];
  }
};

/** `stripCodexResponsesCacheBreakpoints`: removes `prompt_cache_breakpoint` hints from input items and their parts. */
const stripCacheBreakpoints = (body: JsonObject): void => {
  const input = get(body, "input");

  if (!isJsonArray(input)) return;

  for (const item of input) {
    if (!isJsonObject(item)) continue;

    for (const arrayPath of ["content", "output"]) {
      const array = get(item, arrayPath);

      if (isJsonArray(array)) stripPromptCacheBreakpointFromParts(array);
    }

    if (get(item, "prompt_cache_breakpoint") !== undefined) delete item["prompt_cache_breakpoint"];
  }
};

/** `convertSystemRoleToDeveloper`: Codex does not accept the `system` role in `input`. */
const convertSystemRoleToDeveloper = (body: JsonObject): void => {
  const input = get(body, "input");

  if (!isJsonArray(input)) return;

  for (const item of input) {
    if (isJsonObject(item) && asString(get(item, "role")) === "system")
      set(item, "role", "developer");
  }
};

/** `normalizeCodexBuiltinToolType`. */
const normalizeBuiltinToolType = (toolType: string): string =>
  toolType === "web_search_preview" || toolType === "web_search_preview_2025_03_11"
    ? "web_search"
    : "";

const normalizeBuiltinToolArray = (body: JsonObject, path: string): void => {
  const tools = get(body, path);

  if (!isJsonArray(tools)) return;

  for (const tool of tools) {
    const normalized = normalizeBuiltinToolType(asString(get(tool, "type")));

    if (normalized !== "") set(tool, "type", normalized);
  }
};

/** `normalizeCodexBuiltinTools`: legacy/preview built-in tool names -> stable names. */
const normalizeBuiltinTools = (body: JsonObject): void => {
  normalizeBuiltinToolArray(body, "tools");
  const normalized = normalizeBuiltinToolType(asString(get(body, "tool_choice.type")));

  if (normalized !== "") set(body, "tool_choice.type", normalized);
  normalizeBuiltinToolArray(body, "tool_choice.tools");
};

/**
 * `normalizeEmptyFunctionCallArguments`: blank string arguments on history `function_call` items become `"{}"`
 * (strict upstreams reject them as invalid JSON). Non-blank strings are left alone.
 */
const normalizeEmptyFunctionCallArguments = (body: JsonObject): void => {
  const input = get(body, "input");

  if (!isJsonArray(input)) return;

  for (const item of input) {
    if (!isJsonObject(item) || asString(get(item, "type")) !== "function_call") continue;
    const args = get(item, "arguments");

    if (typeof args === "string" && args.trim() === "") item["arguments"] = "{}";
  }
};

/** `ConvertOpenAIResponsesRequestToCodex`. */
export const convertOpenAIResponsesRequestToCodex = (
  _modelName: string,
  request: Json,
  _stream: boolean,
): Json => {
  if (!isJsonObject(request)) return request;
  const body = request;
  const input = get(body, "input");

  if (typeof input === "string") {
    set(body, "input", [
      { type: "message", role: "user", content: [{ type: "input_text", text: input }] },
    ]);
  }

  setRequiredBool(body, "stream", true);
  setRequiredBool(body, "store", false);
  // An explicit false survives; null, absent and anything else default to true (99d1698f).
  const parallelToolCalls = get(body, "parallel_tool_calls");

  if (parallelToolCalls !== false) setRequiredBool(body, "parallel_tool_calls", true);

  setRequiredInclude(body);
  // Codex Responses rejects token limit fields.
  deleteFields(body, "max_output_tokens", "max_completion_tokens", "temperature", "top_p");
  const serviceTier = get(body, "service_tier");

  if (serviceTier !== undefined) {
    if (typeof serviceTier === "string") {
      switch (serviceTier.trim().toLowerCase()) {
        case "priority":
        case "fast":
          if (serviceTier !== "priority") set(body, "service_tier", "priority");
          break;
        case "ultrafast":
          if (serviceTier !== "ultrafast") set(body, "service_tier", "ultrafast");
          break;
        default:
          deleteFields(body, "service_tier");
      }
    } else {
      deleteFields(body, "service_tier");
    }
  }

  deleteFields(body, "truncation", "prompt_cache_options", "prompt_cache_retention");
  stripCacheBreakpoints(body);
  // Codex /responses rejects context_management ("Unsupported parameter").
  deleteFields(body, "context_management");
  deleteFields(body, "user");
  convertSystemRoleToDeveloper(body);
  normalizeBuiltinTools(body);
  normalizeEmptyFunctionCallArguments(body);
  sanitizeOrphanResponsesToolOutputs(get(body, "input"));

  return body;
};
