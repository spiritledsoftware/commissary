/**
 * Token-event detection for time-to-first-token (TTFT): does an upstream frame carry substantive output (text,
 * reasoning, tool arguments, a terminal event) rather than container metadata?
 *
 * Go source: internal/runtime/executor/helps/{chat,claude,gemini,responses}_ttft_helpers.go (Is*TokenEvent) and
 * plugin_executor_usage.go (ObservePluginExecutorStreamTTFT protocol dispatch).
 */
import { get, isJsonArray, type Json, tryParseJson } from "@commissary/json";

/** gjson `len(x.String()) > 0`: strings must be non-empty, any other existing non-null value counts. */
const hasText = (value: Json | undefined): boolean =>
  value !== undefined && value !== null && (typeof value !== "string" || value.length > 0);

const exists = (value: Json | undefined): boolean => value !== undefined;

const array = (value: Json | undefined): ReadonlyArray<Json> => (isJsonArray(value) ? value : []);

const stringOf = (value: Json | undefined): string => (typeof value === "string" ? value : "");

/** Strips an optional `data:` prefix; `undefined` for an empty payload. */
const stripData = (text: string): string | undefined => {
  let payload = text.trim();

  if (payload.startsWith("data:")) payload = payload.slice(5).trim();

  return payload === "" ? undefined : payload;
};

/** `IsChatTokenEvent`. */
export const isChatTokenEvent = (text: string): boolean => {
  const trimmed = text.trim();

  if (trimmed === "") return false;

  if (trimmed === "data: [DONE]" || trimmed === "[DONE]") return true;
  const payload = stripData(trimmed);

  if (payload === undefined) return false;

  if (payload === "[DONE]") return true;
  const root = tryParseJson(payload);

  if (exists(get(root, "error"))) return true;

  for (const choice of array(get(root, "choices"))) {
    const delta = get(choice, "delta");

    if (exists(delta)) {
      if (hasText(get(delta, "content")) || hasText(get(delta, "reasoning_content"))) return true;

      if (hasText(get(delta, "reasoning")) || hasText(get(delta, "refusal"))) return true;

      for (const call of array(get(delta, "tool_calls"))) {
        if (hasText(get(call, "function.arguments")) || hasText(get(call, "function.name")))
          return true;

        if (hasText(get(call, "custom.input"))) return true;
      }
    }

    const message = get(choice, "message");

    if (exists(message)) {
      if (hasText(get(message, "content")) || hasText(get(message, "reasoning_content")))
        return true;

      if (hasText(get(message, "refusal"))) return true;

      for (const call of array(get(message, "tool_calls"))) {
        if (hasText(get(call, "function.arguments")) || hasText(get(call, "function.name")))
          return true;
      }
    }

    if (hasText(get(choice, "finish_reason"))) return true;
  }

  return false;
};

/** `IsClaudeTokenEvent`. */
export const isClaudeTokenEvent = (text: string): boolean => {
  let payload = text.trim();

  if (payload === "") return false;

  if (payload.startsWith("event:")) {
    const newline = payload.indexOf("\n");

    if (newline !== -1) payload = payload.slice(newline + 1).trim();
  }

  if (payload.startsWith("data:")) {
    payload = payload.slice(5).trim();

    if (payload === "") return false;
  }

  const root = tryParseJson(payload);

  switch (stringOf(get(root, "type"))) {
    case "content_block_delta": {
      const delta = get(root, "delta");

      return (
        hasText(get(delta, "text")) ||
        hasText(get(delta, "thinking")) ||
        hasText(get(delta, "partial_json")) ||
        hasText(get(delta, "signature"))
      );
    }

    case "content_block_start": {
      const block = get(root, "content_block");

      return hasText(get(block, "text")) || hasText(get(block, "thinking"));
    }

    case "message_delta":
      return hasText(get(root, "delta.stop_reason"));
    case "message_stop":
    case "error":
      return true;
    case "message_start":
    case "ping":
    case "content_block_stop":
      return false;
    default:
      return array(get(root, "content")).some(
        (block) =>
          hasText(get(block, "text")) ||
          hasText(get(block, "thinking")) ||
          (stringOf(get(block, "type")) === "tool_use" && hasText(get(block, "name"))),
      );
  }
};

/** `IsGeminiTokenEvent` (Gemini, Antigravity and Interactions-over-Gemini frames). */
export const isGeminiTokenEvent = (text: string): boolean => {
  const payload = stripData(text);

  if (payload === undefined) return false;
  const root = tryParseJson(payload);

  if (exists(get(root, "error")) || exists(get(root, "response.error"))) return true;
  const candidates = array(get(root, "candidates") ?? get(root, "response.candidates"));

  for (const candidate of candidates) {
    for (const part of array(get(candidate, "content.parts"))) {
      if (hasText(get(part, "text")) || hasText(get(part, "thoughtText"))) return true;
      const thought = get(part, "thought");

      if (typeof thought === "string" && thought.length > 0) return true;

      if (hasText(get(part, "functionCall.name")) || hasText(get(part, "inlineData.data")))
        return true;
    }

    if (hasText(get(candidate, "finishReason"))) return true;
  }

  return false;
};

const RESPONSES_DELTA_EVENTS = new Set([
  "response.reasoning_summary_text.delta",
  "response.reasoning.delta",
  "response.reasoning_text.delta",
  "response.output_text.delta",
  "response.text.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
  "response.code_interpreter_call_code.delta",
  "response.mcp_call_arguments.delta",
  "response.shell_call_command.delta",
  "response.refusal.delta",
  "response.audio.transcript.delta",
]);

/** Events whose single field carries the finished text. */
const RESPONSES_DONE_FIELDS: ReadonlyMap<string, string> = new Map([
  ["response.reasoning_summary_text.done", "text"],
  ["response.reasoning_text.done", "text"],
  ["response.output_text.done", "text"],
  ["response.refusal.done", "refusal"],
  ["response.function_call_arguments.done", "arguments"],
  ["response.mcp_call_arguments.done", "arguments"],
  ["response.custom_tool_call_input.done", "input"],
  ["response.code_interpreter_call_code.done", "code"],
  ["response.shell_call_command.done", "command"],
  ["response.reasoning_summary_part.done", "part.text"],
]);

const RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.incomplete",
  "response.failed",
  "error",
]);

/** `IsResponsesTokenEvent` (Responses API / Codex SSE events). */
export const isResponsesTokenEvent = (text: string): boolean => {
  const payload = stripData(text);

  if (payload === undefined) return false;
  const root = tryParseJson(payload);
  const type = stringOf(get(root, "type"));

  if (RESPONSES_DELTA_EVENTS.has(type)) return hasText(get(root, "delta"));
  const doneField = RESPONSES_DONE_FIELDS.get(type);

  if (doneField !== undefined) return hasText(get(root, doneField));

  if (RESPONSES_TERMINAL_EVENTS.has(type)) return true;

  switch (type) {
    case "response.audio.delta":
      return hasText(get(root, "delta")) || hasText(get(root, "data"));
    case "response.image_generation_call.partial_image":
      return hasText(get(root, "partial_image_b64"));
    case "response.shell_call_command.added":
      return hasText(get(root, "command"));
    case "response.content_part.done":
      return hasText(get(root, "part.text")) || hasText(get(root, "part.refusal"));
    case "response.output_item.done":
      switch (stringOf(get(root, "item.type"))) {
        case "function_call":
          return hasText(get(root, "item.arguments"));
        case "custom_tool_call":
          return hasText(get(root, "item.input"));
        case "reasoning":
          return ["item.summary", "item.content"].some((field) =>
            array(get(root, field)).some((part) => stringOf(get(part, "text")) !== ""),
          );
        case "message":
          return array(get(root, "item.content")).some(
            (content) => hasText(get(content, "text")) || hasText(get(content, "refusal")),
          );
        default:
          return false;
      }

    default:
      return false;
  }
};

/** Upstream wire protocol of a stream, for {@link isTokenEvent}. */
export type TokenEventProtocol = "chat" | "claude" | "gemini" | "responses";

/** Protocol dispatch of `ObservePluginExecutorStreamTTFT`. */
export const tokenEventProtocolOf = (protocol: string): TokenEventProtocol => {
  switch (protocol.trim().toLowerCase()) {
    case "claude":
      return "claude";
    case "gemini":
    case "antigravity":
    case "interactions":
    case "interactions-response":
      return "gemini";
    case "codex":
    case "openai-response":
      return "responses";
    default:
      return "chat";
  }
};

export const isTokenEvent = (protocol: TokenEventProtocol, text: string): boolean => {
  switch (protocol) {
    case "claude":
      return isClaudeTokenEvent(text);
    case "gemini":
      return isGeminiTokenEvent(text);
    case "responses":
      return isResponsesTokenEvent(text);
    default:
      return isChatTokenEvent(text);
  }
};
