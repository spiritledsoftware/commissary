/**
 * Claude Messages provider -> OpenAI Chat Completions client (response).
 *
 * Go source: internal/translator/claude/openai/chat-completions/claude_openai_response.go.
 */
import { asInt, get, type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { claudeMessagesJSONToSSE } from "../../../common/claude-native-response.ts";
import { exists, str } from "../../../common/gjson.ts";
import type { ResponseContext, ResponseTransform } from "../../../registry.ts";

interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** `output_tokens_details.thinking_tokens`, a subset of the output tokens; only meaningful when reported. */
  thinkingTokens: number;
  hasThinkingTokens: boolean;
  hasUsage: boolean;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  index: number;
  arguments: string;
}

/** Go `ConvertAnthropicResponseToOpenAIParams`. */
interface Params {
  createdAt: number;
  responseId: string;
  finishReason: string;
  usage: UsageTokens;
  trailingUsageSent: boolean;
  toolCallsAccumulator: Map<number, ToolCallAccumulator> | undefined;
  nextToolCallIndex: number;
}

const newUsage = (): UsageTokens => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  thinkingTokens: 0,
  hasThinkingTokens: false,
  hasUsage: false,
});

const mergeUsage = (target: UsageTokens, usage: Json | undefined): void => {
  if (usage === undefined) return;
  target.hasUsage = true;
  const input = get(usage, "input_tokens");

  if (input !== undefined) target.inputTokens = asInt(input);
  const output = get(usage, "output_tokens");

  if (output !== undefined) target.outputTokens = asInt(output);
  const creation = get(usage, "cache_creation_input_tokens");

  if (creation !== undefined) target.cacheCreationInputTokens = asInt(creation);
  const read = get(usage, "cache_read_input_tokens");

  if (read !== undefined) target.cacheReadInputTokens = asInt(read);
  const thinking = get(usage, "output_tokens_details.thinking_tokens");

  if (thinking !== undefined) {
    target.thinkingTokens = asInt(thinking);
    target.hasThinkingTokens = true;
  }
};

const setOpenAIUsage = (target: JsonObject, usage: UsageTokens): void => {
  const cached = usage.cacheReadInputTokens;
  const created = usage.cacheCreationInputTokens;
  const prompt = usage.inputTokens + created + cached;
  const completion = usage.outputTokens;
  // SAFETY: `usage` is only ever set by this translator as an object (or left absent).
  const existing = (target.usage as JsonObject | undefined) ?? {};
  target.usage = {
    ...existing,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: {
      cached_tokens: cached,
      cached_creation_tokens: created,
      cache_write_tokens: created,
    },
    // Left out when upstream did not report it, so a client never sees a false 0 (an explicit 0 stays).
    ...(usage.hasThinkingTokens
      ? { completion_tokens_details: { reasoning_tokens: usage.thinkingTokens } }
      : {}),
  };
};

const mapStopReason = (reason: string): string => {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
    case "sensitive":
      return "content_filter";
    default:
      return "stop";
  }
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

type ChunkTemplateResult = { out: JsonObject; choice: JsonObject; delta: JsonObject };

const chunkTemplate = (): ChunkTemplateResult => {
  const delta: JsonObject = {};
  const choice: JsonObject = { index: 0, delta, finish_reason: null };

  return {
    out: { id: "", object: "chat.completion.chunk", created: 0, model: "", choices: [choice] },
    choice,
    delta,
  };
};

/** `ConvertClaudeResponseToOpenAI`. */
export const convertClaudeResponseToOpenAI = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const state = context.state;

  if (state.value === undefined) {
    state.value = {
      createdAt: 0,
      responseId: "",
      finishReason: "",
      usage: newUsage(),
      trailingUsageSent: false,
      toolCallsAccumulator: undefined,
      nextToolCallIndex: 0,
    } satisfies Params;
  }

  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  const params = state.value as Params;

  if (!line.startsWith("data:")) return [];
  const root = tryParseJson(line.slice(5).trim());
  const eventType = str(get(root, "type"));
  const modelName = context.model;

  const { out, choice, delta: choiceDelta } = chunkTemplate();

  if (modelName !== "") out.model = modelName;

  if (params.responseId !== "") out.id = params.responseId;

  if (params.createdAt > 0) out.created = params.createdAt;

  switch (eventType) {
    case "message_start": {
      const message = get(root, "message");

      if (message !== undefined) {
        params.responseId = str(get(message, "id"));
        params.createdAt = nowSeconds();
        out.id = params.responseId;
        out.model = modelName;
        out.created = params.createdAt;
        choiceDelta.role = "assistant";
        params.toolCallsAccumulator ??= new Map();
        params.nextToolCallIndex = 0;
        mergeUsage(params.usage, get(message, "usage"));
      }

      return [JSON.stringify(out)];
    }

    case "content_block_start": {
      const block = get(root, "content_block");

      if (block !== undefined && str(get(block, "type")) === "tool_use") {
        params.toolCallsAccumulator ??= new Map();
        const toolCallIndex = params.nextToolCallIndex++;
        params.toolCallsAccumulator.set(asInt(get(root, "index")), {
          id: str(get(block, "id")),
          name: str(get(block, "name")),
          index: toolCallIndex,
          arguments: "",
        });
      }

      return [];
    }

    case "content_block_delta": {
      let hasContent = false;
      const delta = get(root, "delta");

      if (delta !== undefined) {
        switch (str(get(delta, "type"))) {
          case "text_delta": {
            const text = get(delta, "text");

            if (text !== undefined) {
              choiceDelta.content = str(text);
              hasContent = true;
            }

            break;
          }

          case "thinking_delta": {
            const thinking = get(delta, "thinking");

            if (thinking !== undefined) {
              choiceDelta.reasoning_content = str(thinking);
              hasContent = true;
            }

            break;
          }

          case "input_json_delta": {
            const partial = get(delta, "partial_json");

            if (partial !== undefined) {
              const accumulator = params.toolCallsAccumulator?.get(asInt(get(root, "index")));

              if (accumulator !== undefined) accumulator.arguments += str(partial);
            }
          }
        }
      }

      return hasContent ? [JSON.stringify(out)] : [];
    }

    case "content_block_stop": {
      const index = asInt(get(root, "index"));
      const accumulator = params.toolCallsAccumulator?.get(index);

      if (accumulator === undefined) return [];
      choiceDelta.tool_calls = [
        {
          index: accumulator.index,
          id: accumulator.id,
          type: "function",
          function: {
            name: accumulator.name,
            arguments: accumulator.arguments === "" ? "{}" : accumulator.arguments,
          },
        },
      ];
      params.toolCallsAccumulator?.delete(index);

      return [JSON.stringify(out)];
    }

    case "message_delta": {
      const stopReason = get(get(root, "delta"), "stop_reason");

      if (stopReason !== undefined) {
        params.finishReason = mapStopReason(str(stopReason));
        choice.finish_reason = params.finishReason;
      }

      const usage = get(root, "usage");

      if (usage !== undefined) {
        mergeUsage(params.usage, usage);
        setOpenAIUsage(out, params.usage);
      }

      return [JSON.stringify(out)];
    }

    case "message_stop": {
      if (params.usage.hasUsage && !params.trailingUsageSent) {
        params.trailingUsageSent = true;

        const usageOut: JsonObject = {
          id: "",
          object: "chat.completion.chunk",
          created: 0,
          model: "",
          choices: [],
        };

        if (params.responseId !== "") usageOut.id = params.responseId;

        if (modelName !== "") usageOut.model = modelName;

        if (params.createdAt > 0) usageOut.created = params.createdAt;
        setOpenAIUsage(usageOut, params.usage);

        return [JSON.stringify(usageOut)];
      }

      return [];
    }

    case "error": {
      const errorData = get(root, "error");

      if (errorData !== undefined) {
        return [
          JSON.stringify({
            error: { message: str(get(errorData, "message")), type: str(get(errorData, "type")) },
          }),
        ];
      }

      return [];
    }

    default:
      return [];
  }
};

/** `ConvertClaudeResponseToOpenAINonStream`. */
export const convertClaudeResponseToOpenAINonStream = (
  _context: ResponseContext,
  body: string,
): string => {
  const [sse] = claudeMessagesJSONToSSE(body);
  const chunks: string[] = [];

  for (const line of sse.split("\n")) {
    if (line.startsWith("data:")) chunks.push(line.slice(5).trim());
  }

  const message: JsonObject = { role: "assistant", content: "" };
  const choice: JsonObject = { index: 0, message, finish_reason: "stop" };

  const out: JsonObject = {
    id: "",
    object: "chat.completion",
    created: 0,
    model: "",
    choices: [choice],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  let messageId = "";
  let model = "";
  let createdAt = 0;
  let stopReason = "";
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const usage = newUsage();
  const accumulators = new Map<number, ToolCallAccumulator>();

  for (const chunk of chunks) {
    const root = tryParseJson(chunk);

    switch (str(get(root, "type"))) {
      case "message_start": {
        const msg = get(root, "message");

        if (msg !== undefined) {
          messageId = str(get(msg, "id"));
          model = str(get(msg, "model"));
          createdAt = nowSeconds();
          mergeUsage(usage, get(msg, "usage"));
        }

        break;
      }

      case "content_block_start": {
        const block = get(root, "content_block");

        if (block !== undefined && str(get(block, "type")) === "tool_use") {
          accumulators.set(asInt(get(root, "index")), {
            id: str(get(block, "id")),
            name: str(get(block, "name")),
            index: 0,
            arguments: "",
          });
        }

        break;
      }

      case "content_block_delta": {
        const delta = get(root, "delta");

        if (delta === undefined) break;

        switch (str(get(delta, "type"))) {
          case "text_delta":
            if (exists(get(delta, "text"))) contentParts.push(str(get(delta, "text")));
            break;
          case "thinking_delta":
            if (exists(get(delta, "thinking"))) reasoningParts.push(str(get(delta, "thinking")));
            break;
          case "input_json_delta": {
            const partial = get(delta, "partial_json");

            if (partial !== undefined) {
              const accumulator = accumulators.get(asInt(get(root, "index")));

              if (accumulator !== undefined) accumulator.arguments += str(partial);
            }
          }
        }

        break;
      }

      case "content_block_stop": {
        const accumulator = accumulators.get(asInt(get(root, "index")));

        if (accumulator !== undefined && accumulator.arguments.length === 0)
          accumulator.arguments = "{}";
        break;
      }

      case "message_delta": {
        const reason = get(get(root, "delta"), "stop_reason");

        if (reason !== undefined) stopReason = str(reason);
        const msgUsage = get(root, "usage");

        if (msgUsage !== undefined) mergeUsage(usage, msgUsage);
        break;
      }
    }
  }

  if (usage.hasUsage) setOpenAIUsage(out, usage);
  out.id = messageId;
  out.created = createdAt;
  out.model = model;
  message.content = contentParts.join("");

  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");

  if (accumulators.size > 0) {
    const maxIndex = Math.max(...accumulators.keys());
    const toolCalls: Json[] = [];

    for (let i = 0; i <= maxIndex; i++) {
      const accumulator = accumulators.get(i);

      if (accumulator === undefined) continue;
      toolCalls.push({
        id: accumulator.id,
        type: "function",
        function: { name: accumulator.name, arguments: accumulator.arguments },
      });
    }

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
      // A call cut off by the token limit or the context window stays `length`.
      choice.finish_reason = mapStopReason(stopReason) === "length" ? "length" : "tool_calls";
    } else {
      const finish = mapStopReason(stopReason);

      if (finish !== "stop") choice.finish_reason = finish;
    }
  } else {
    const finish = mapStopReason(stopReason);

    if (finish !== "stop") choice.finish_reason = finish;
  }

  return JSON.stringify(out);
};

export const claudeToOpenAIResponse: ResponseTransform = {
  stream: convertClaudeResponseToOpenAI,
  nonStream: convertClaudeResponseToOpenAINonStream,
};
