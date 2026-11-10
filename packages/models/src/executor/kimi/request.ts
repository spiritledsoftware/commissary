/**
 * Kimi request normalisation (Chat Completions and Responses bodies).
 *
 * Go source: internal/runtime/executor/kimi_executor.go (`normalizeKimiToolMessageLinks`, `normalizeKimiTools`,
 * `normalizeKimiTemperature`, `shouldDropKimiAssistantMessage`, `fallbackAssistantReasoning`),
 * internal/runtime/executor/helps/kimi_responses.go (`NormalizeKimiResponsesInput`). All functions mutate the parsed
 * body in place and return it.
 */
import {
  asFloat,
  asString,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from "@commissary/json";
import { extractResponsesCallID } from "@commissary/translation";
import { inlineLocalRefs } from "../helps/inline-refs.ts";

export const KIMI_REASONING_UNAVAILABLE = "[reasoning unavailable]";

const usableReasoning = (reasoning: string): boolean => {
  const trimmed = reasoning.trim();

  return trimmed !== "" && trimmed !== KIMI_REASONING_UNAVAILABLE;
};

const contentPartEmpty = (part: Json | undefined): boolean => {
  if (part === undefined || part === null) return true;

  if (typeof part === "string") return part.trim() === "";

  if (!isJsonObject(part)) return false;

  if (part["text"] !== undefined) return asString(part["text"]).trim() === "";

  if (asString(part["type"]).trim() === "text") return true;

  return Object.keys(part).length === 0;
};

const assistantContentEmpty = (content: Json | undefined): boolean => {
  if (content === undefined || content === null) return true;

  if (typeof content === "string") return content.trim() === "";

  if (!isJsonArray(content)) return false;

  return content.every(contentPartEmpty);
};

const hasToolCalls = (message: JsonObject): boolean =>
  isJsonArray(message["tool_calls"]) && message["tool_calls"].length > 0;

const hasLegacyFunctionCall = (message: JsonObject): boolean => {
  const call = message["function_call"];

  if (call === undefined || call === null) return false;

  return !(isJsonObject(call) && Object.keys(call).length === 0);
};

/** `shouldDropKimiAssistantMessage`: assistant turns without content, calls or reasoning. */
const shouldDropAssistant = (message: Json): boolean => {
  if (!isJsonObject(message) || asString(message["role"]).trim() !== "assistant") return false;

  if (hasToolCalls(message) || hasLegacyFunctionCall(message)) return false;

  if (
    message["reasoning_content"] !== undefined &&
    asString(message["reasoning_content"]).trim() !== ""
  )
    return false;

  return assistantContentEmpty(message["content"]);
};

const fallbackReasoning = (message: JsonObject, latest: string | undefined): string => {
  if (latest !== undefined && usableReasoning(latest)) return latest;
  const content = message["content"];

  if (typeof content === "string") {
    const text = content.trim();

    if (text !== "") return text;
  }

  if (isJsonArray(content)) {
    const parts = content
      .map((item) => asString(get(item, "text")).trim())
      .filter((text) => text !== "");

    if (parts.length > 0) return parts.join("\n");
  }

  return KIMI_REASONING_UNAVAILABLE;
};

/**
 * `normalizeKimiToolMessageLinks`: drops empty assistant messages, repairs missing `tool_call_id`s (from `call_id`,
 * or the single pending call) and gives assistant tool calls a `reasoning_content` (latest usable reasoning, its own
 * text, or the `[reasoning unavailable]` marker).
 */
export const normalizeKimiToolMessageLinks = (body: Json): Json => {
  const messages = get(body, "messages");

  if (!isJsonArray(messages)) return body;
  const kept: Json[] = [];
  let pending: string[] = [];
  let latestReasoning: string | undefined;

  for (const message of messages) {
    if (shouldDropAssistant(message)) continue;
    kept.push(message);

    if (!isJsonObject(message)) continue;
    const role = asString(message["role"]).trim();

    if (role === "assistant") {
      const reasoning = message["reasoning_content"];

      if (reasoning !== undefined && usableReasoning(asString(reasoning)))
        latestReasoning = asString(reasoning);
      const calls = message["tool_calls"];

      if (isJsonArray(calls) && calls.length > 0) {
        if (reasoning === undefined || !usableReasoning(asString(reasoning))) {
          message["reasoning_content"] = fallbackReasoning(message, latestReasoning);
        }

        for (const call of calls) {
          const id = asString(get(call, "id")).trim();

          if (id !== "") pending.push(id);
        }
      }
    } else if (role === "tool") {
      let id = asString(message["tool_call_id"]).trim();

      if (id === "") {
        id = asString(message["call_id"]).trim();

        if (id !== "") message["tool_call_id"] = id;
      }

      const onlyPending = pending[0];

      if (id === "" && pending.length === 1 && onlyPending !== undefined) {
        id = onlyPending;
        message["tool_call_id"] = id;
      }

      if (id !== "") {
        const index = pending.indexOf(id);

        if (index >= 0) pending = [...pending.slice(0, index), ...pending.slice(index + 1)];
      }
    }
  }

  if (kept.length !== messages.length && isJsonObject(body)) body["messages"] = kept;

  return body;
};

/** `normalizeKimiParametersSchema`: inline local `$ref`s, drop `$defs`/`definitions`, default `type: object`. */
const normalizeParameters = (params: JsonObject): JsonObject => {
  const inlined = inlineLocalRefs(params);
  const out = isJsonObject(inlined) ? inlined : params;
  delete out["$defs"];
  delete out["definitions"];

  if (out["type"] === undefined) out["type"] = "object";

  return out;
};

const normalizeToolArray = (items: Json | undefined, isTools: boolean): void => {
  if (!isJsonArray(items)) return;

  for (const item of items) {
    if (!isJsonObject(item)) continue;

    if (isTools && asString(item["type"]).trim() === "namespace") {
      normalizeToolArray(item["tools"], true);
      normalizeToolArray(item["children"], true);
    }

    let holder: JsonObject | undefined;

    if (
      isTools &&
      get(item, "function.parameters") !== undefined &&
      isJsonObject(item["function"])
    ) {
      holder = item["function"];
    } else if (item["parameters"] !== undefined) {
      holder = item;
    }

    const params = holder?.["parameters"];

    if (holder !== undefined && isJsonObject(params))
      holder["parameters"] = normalizeParameters(params);
  }
};

/**
 * `normalizeKimiTools`: `tools[].function.parameters` / `.parameters` and legacy `functions[].parameters`, the nested
 * `tools` / `children` of `namespace` tools, and `input[].tools` of `additional_tools` / `tool_search_output` items.
 */
export const normalizeKimiTools = (body: Json): Json => {
  if (!isJsonObject(body)) return body;
  normalizeToolArray(body["tools"], true);
  normalizeToolArray(body["functions"], false);
  const input = body["input"];

  if (isJsonArray(input)) {
    for (const item of input) {
      if (!isJsonObject(item)) continue;
      const type = asString(item["type"]).trim();

      if (type === "additional_tools" || type === "tool_search_output")
        normalizeToolArray(item["tools"], true);
    }
  }

  return body;
};

/**
 * `normalizeKimiTemperature`: Kimi only accepts 0.6 with thinking disabled and 1.0 otherwise; any other value is
 * removed so the upstream default applies instead of a 400.
 */
export const normalizeKimiTemperature = (body: Json): Json => {
  const temperature = get(body, "temperature");

  if (temperature === undefined) return body;
  const disabled = asString(get(body, "thinking.type")).toLowerCase() === "disabled";

  if (asFloat(temperature) !== (disabled ? 0.6 : 1.0)) return del(body, "temperature");

  return body;
};

const isToolCall = (item: Json | undefined): boolean => {
  const type = asString(get(item, "type")).trim();

  return type === "function_call" || type === "custom_tool_call";
};

const isToolOutput = (item: Json | undefined): boolean => {
  const type = asString(get(item, "type")).trim();

  return type === "function_call_output" || type === "custom_tool_call_output";
};

/**
 * `NormalizeKimiResponsesInput`: after a batch of parallel tool calls Kimi needs every matching output to follow
 * contiguously; intervening non-tool items are deferred until the batch's outputs were emitted.
 */
export const normalizeKimiResponsesInput = (body: Json): Json => {
  const input = get(body, "input");

  if (!isJsonArray(input) || input.length === 0) return body;
  const items = input;
  const result: Json[] = [];
  let reordered = false;
  let i = 0;

  while (i < items.length) {
    const first = items[i];

    if (first === undefined) break;

    if (!isToolCall(first)) {
      result.push(first);
      i++;
      continue;
    }

    const startCalls = i;
    let endCalls = i;
    const callIds = new Map<string, number>();
    let callIdCount = 0;

    while (endCalls < items.length && isToolCall(items[endCalls])) {
      const callId = extractResponsesCallID(items[endCalls]);

      if (callId !== "") {
        callIds.set(callId, (callIds.get(callId) ?? 0) + 1);
        callIdCount++;
      }

      endCalls++;
    }

    result.push(...items.slice(startCalls, endCalls));

    if (callIdCount === 0) {
      i = endCalls;
      continue;
    }

    const needed = new Map(callIds);
    let remaining = callIdCount;
    let lastMatching = -1;

    for (let j = endCalls; j < items.length && remaining > 0; j++) {
      const item = items[j];

      if (item === undefined || isToolCall(item)) break;

      if (isToolOutput(item)) {
        const callId = extractResponsesCallID(item);

        if ((needed.get(callId) ?? 0) > 0) {
          needed.set(callId, (needed.get(callId) ?? 0) - 1);
          remaining--;
          lastMatching = j;
        }
      }
    }

    if (remaining === 0 && lastMatching >= endCalls) {
      const outputs: Json[] = [];
      const intervening: Json[] = [];
      const consumed = new Map(callIds);

      for (let j = endCalls; j <= lastMatching; j++) {
        const item = items[j];

        if (item === undefined) continue;

        if (isToolOutput(item)) {
          const callId = extractResponsesCallID(item);

          if ((consumed.get(callId) ?? 0) > 0) {
            consumed.set(callId, (consumed.get(callId) ?? 0) - 1);
            outputs.push(item);
            continue;
          }
        }

        intervening.push(item);
      }

      if (intervening.length > 0) reordered = true;
      result.push(...outputs, ...intervening);
      i = lastMatching + 1;
    } else {
      i = endCalls;
    }
  }

  if (reordered && isJsonObject(body)) body["input"] = result;

  return body;
};
