/**
 * Claude flavour of Responses compaction: the summary request built from the client payload, tool-block flattening of
 * the summary turn and the Responses usage/stream patching.
 *
 * Go source: internal/runtime/executor/claude_executor_compaction.go. The capsule format, its expansion before
 * translation and the checks every local route shares are `executor/helps/compaction.ts`.
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
import { parseOpenAIUsage } from "../../usage/record.ts";
import type { ExecutorOptions, ExecutorRequest } from "../types.ts";
import {
  hasResponsesCompactionTrigger,
  prepareCompactionSummaryPayload,
} from "../helps/compaction.ts";

/** `claudeResponsesCompactionRequested`. */
export const claudeCompactionRequested = (
  request: ExecutorRequest,
  options: ExecutorOptions,
): boolean =>
  options.alt === "responses/compact" ||
  hasResponsesCompactionTrigger(request.payload) ||
  hasResponsesCompactionTrigger(options.originalRequest);

/** `prepareClaudeCompactionSummaryPayload`: keeps the tool definitions Claude needs to accept `tool_use` history. */
export const prepareClaudeCompactionSummaryPayload = (payload: Json): Json => {
  const tools = get(payload, "tools");
  const additionalTools = get(payload, "additional_tools");
  const out = prepareCompactionSummaryPayload(payload);

  if (tools !== undefined) set(out, "tools", cloneJson(tools));

  if (additionalTools !== undefined) set(out, "additional_tools", cloneJson(additionalTools));

  return out;
};

const rawText = (value: Json | undefined): string =>
  value === undefined ? "" : JSON.stringify(value);

const textBlock = (text: string): JsonObject => ({ type: "text", text });

/** `flattenClaudeToolBlocksForCompaction`: tool blocks become text so Anthropic accepts orphan tool history. */
export const flattenClaudeToolBlocksForCompaction = (body: JsonObject): JsonObject => {
  const messages = body["messages"];

  if (!isJsonArray(messages)) return body;
  let changed = false;

  const rewritten = messages.map((message) => {
    const content = get(message, "content");

    if (!isJsonArray(content) || !isJsonObject(message)) return message;
    let messageChanged = false;

    const parts = content.map((part): Json => {
      switch (asString(get(part, "type"))) {
        case "tool_use":
          messageChanged = true;

          return textBlock(
            `Tool call ${asString(get(part, "name"))} (${asString(get(part, "id"))}): ${rawText(get(part, "input"))}`,
          );
        case "tool_result": {
          messageChanged = true;
          const result = get(part, "content");
          const resultText = typeof result === "string" ? result : rawText(result);

          return textBlock(`Tool result ${asString(get(part, "tool_use_id"))}: ${resultText}`);
        }

        default:
          return part;
      }
    });

    if (!messageChanged) return message;
    changed = true;

    return { ...message, content: parts };
  });

  if (changed) body["messages"] = rewritten;

  return body;
};

/**
 * `finalizeClaudeCompactionSummaryBody`: runs after built-in translation and before the payload rules. With tool
 * definitions the history stays structured and `tool_choice: none` stops the summary turn from calling a tool;
 * without them the tool history is flattened.
 */
export const finalizeClaudeCompactionSummaryBody = (body: JsonObject): JsonObject => {
  const tools = body["tools"];

  if (isJsonArray(tools) && tools.length > 0) {
    body["tool_choice"] = { type: "none" };

    return body;
  }

  return flattenClaudeToolBlocksForCompaction(body);
};

export interface CompactionUsage {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly cached: number;
}

/** `claudeCompactionResponsesUsage`: input includes cache creation and read; `cached` is the cache read. */
export const claudeCompactionUsage = (
  payload: Json | undefined,
  rawBody: string,
): CompactionUsage => {
  const usage = get(payload, "usage");

  if (usage === undefined) {
    const parsed = parseOpenAIUsage(rawBody);

    return {
      input: parsed.inputTokens,
      output: parsed.outputTokens,
      total: parsed.totalTokens,
      cached: 0,
    };
  }

  const cached = asInt(get(usage, "cache_read_input_tokens"));

  const input =
    asInt(get(usage, "input_tokens")) + asInt(get(usage, "cache_creation_input_tokens")) + cached;

  const output = asInt(get(usage, "output_tokens"));

  return { input, output, total: input + output, cached };
};

/** `patchClaudeCompactionStreamUsage`: rewrites the usage of one `event:/data:` frame. */
export const patchClaudeCompactionStreamUsage = (
  chunk: string,
  usage: {
    readonly input: number;
    readonly output: number;
    readonly total: number;
    readonly cached: number;
  },
): string => {
  const prefix = "data: ";
  const index = chunk.indexOf(prefix);

  if (index < 0) return chunk;
  const data = tryParseJson(chunk.slice(index + prefix.length).trim());

  if (data === undefined) return chunk;

  const path =
    get(data, "response.usage") !== undefined
      ? "response.usage"
      : get(data, "usage") !== undefined
        ? "usage"
        : "";

  if (path === "") return chunk;
  set(data, `${path}.input_tokens`, usage.input);
  set(data, `${path}.output_tokens`, usage.output);
  set(data, `${path}.total_tokens`, usage.total);
  set(data, `${path}.input_tokens_details.cached_tokens`, usage.cached);

  return `${chunk.slice(0, index)}${prefix}${JSON.stringify(data)}\n\n`;
};
