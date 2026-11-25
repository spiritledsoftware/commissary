/**
 * Local input token counting for providers without a count endpoint.
 *
 * Go source: internal/runtime/executor/helps/token_helpers.go (CountOpenAIChatTokens, BuildOpenAIUsageJSON),
 * codex_executor_tokens.go (countCodexInputTokens, used by Codex and Meta) and xai_executor_tokens.go
 * (countXAIInputTokens). Each counter collects trimmed text segments from the final upstream body, joins them with
 * newlines and counts them with the provider's encoding. "Raw" JSON segments are `JSON.stringify` output (Go keeps
 * the raw bytes, so counts differ only for non-canonical numbers and unusual string escapes).
 */
import { asString, get, isJsonArray, isJsonObject, type Json } from "@commissary/json";
import { toArray } from "@commissary/translation";
import { type BpeCodec, goTrimSpace } from "@commissary/translation/tokenizer";

const raw = (value: Json): string => JSON.stringify(value);

/** `addIfNotEmpty` / `xaiAppendTokenString`: the trimmed `Result.String()` when not empty. */
const add = (segments: string[], value: Json | undefined): void => {
  const text = goTrimSpace(asString(value));

  if (text !== "") segments.push(text);
};

/** `Result.Raw` of an existing value, or the string itself for string values (`xaiAppendTokenJSON`). */
const addJsonOrString = (segments: string[], value: Json | undefined): void => {
  if (value === undefined) return;
  add(segments, typeof value === "string" ? value : raw(value));
};

const countSegments = (codec: BpeCodec, text: string): number =>
  text === "" ? 0 : codec.count(text);

/** `BuildOpenAIUsageJSON`. */
export const buildOpenAIUsageJson = (count: number): string =>
  `{"usage":{"prompt_tokens":${count},"completion_tokens":0,"total_tokens":${count}}}`;

/** `{"response":{"usage":...}}` shape handed to the Responses/Codex token count translators. */
export const buildResponsesUsageJson = (count: number): string =>
  `{"response":{"usage":{"input_tokens":${count},"output_tokens":0,"total_tokens":${count}}}}`;

// ---------------------------------------------------------------------------------------------------------------
// OpenAI Chat Completions (OpenAI-compatibility executor)
// ---------------------------------------------------------------------------------------------------------------

const collectOpenAIContent = (content: Json | undefined, segments: string[]): void => {
  if (content === undefined) return;

  if (typeof content === "string") return add(segments, content);

  if (isJsonArray(content)) {
    for (const part of content) {
      switch (asString(get(part, "type"))) {
        case "text":
        case "input_text":
        case "output_text":
          add(segments, get(part, "text"));
          break;
        case "image_url":
          add(segments, get(part, "image_url.url"));
          break;
        case "input_audio":
        case "output_audio":
        case "audio":
          add(segments, get(part, "id"));
          break;
        case "tool_result":
          add(segments, get(part, "name"));
          collectOpenAIContent(get(part, "content"), segments);
          break;
        default:
          if (isJsonArray(part)) collectOpenAIContent(part, segments);
          else if (isJsonObject(part)) add(segments, raw(part));
          else add(segments, part);
      }
    }

    return;
  }

  if (isJsonObject(content)) add(segments, raw(content));
};

const addParameters = (segments: string[], owner: Json | undefined): void => {
  const params = get(owner, "parameters");

  if (params !== undefined) add(segments, raw(params));
};

const collectOpenAIToolCalls = (calls: Json | undefined, segments: string[]): void => {
  if (!isJsonArray(calls)) return;

  for (const call of calls) {
    add(segments, get(call, "id"));
    add(segments, get(call, "type"));
    const fn = get(call, "function");

    if (fn !== undefined) {
      add(segments, get(fn, "name"));
      add(segments, get(fn, "description"));
      add(segments, get(fn, "arguments"));
      addParameters(segments, fn);
    }
  }
};

const appendToolPayload = (tool: Json | undefined, segments: string[]): void => {
  if (tool === undefined) return;
  add(segments, get(tool, "type"));
  add(segments, get(tool, "name"));
  add(segments, get(tool, "description"));
  const fn = get(tool, "function");

  if (fn !== undefined) {
    add(segments, get(fn, "name"));
    add(segments, get(fn, "description"));
    addParameters(segments, fn);
  }
};

/** `CountOpenAIChatTokens`: prompt tokens of a Chat Completions payload. */
export const countOpenAIChatTokens = (codec: BpeCodec, payload: Json | undefined): number => {
  if (payload === undefined) return 0;
  const segments: string[] = [];

  const messages = get(payload, "messages");

  if (isJsonArray(messages)) {
    for (const message of messages) {
      add(segments, get(message, "role"));
      add(segments, get(message, "name"));
      collectOpenAIContent(get(message, "content"), segments);
      collectOpenAIToolCalls(get(message, "tool_calls"), segments);
      const functionCall = get(message, "function_call");

      if (functionCall !== undefined) {
        add(segments, get(functionCall, "name"));
        add(segments, get(functionCall, "arguments"));
      }
    }
  }

  const tools = get(payload, "tools");

  if (isJsonArray(tools)) for (const tool of tools) appendToolPayload(tool, segments);
  else appendToolPayload(tools, segments);

  const functions = get(payload, "functions");

  if (isJsonArray(functions)) {
    for (const fn of functions) {
      add(segments, get(fn, "name"));
      add(segments, get(fn, "description"));
      addParameters(segments, fn);
    }
  }

  const choice = get(payload, "tool_choice");

  if (choice !== undefined) add(segments, typeof choice === "string" ? choice : raw(choice));

  const format = get(payload, "response_format");

  if (format !== undefined) {
    add(segments, get(format, "type"));
    add(segments, get(format, "name"));

    for (const key of ["json_schema", "schema"]) {
      const schema = get(format, key);

      if (schema !== undefined) add(segments, raw(schema));
    }
  }

  add(segments, get(payload, "input"));
  add(segments, get(payload, "prompt"));

  return countSegments(codec, goTrimSpace(segments.join("\n")));
};

// ---------------------------------------------------------------------------------------------------------------
// Responses / Codex (Codex and Meta executors)
// ---------------------------------------------------------------------------------------------------------------

/** `countCodexInputTokens`. */
export const countCodexInputTokens = (codec: BpeCodec, body: Json | undefined): number => {
  if (body === undefined) return 0;
  const segments: string[] = [];
  add(segments, get(body, "instructions"));

  const input = get(body, "input");

  if (typeof input === "string") add(segments, input);
  else if (isJsonArray(input)) {
    for (const item of input) {
      let type = asString(get(item, "type"));

      // An untyped item with a role and content is a message (Go 1ef770d9).
      if (type === "" && asString(get(item, "role")) !== "" && get(item, "content") !== undefined)
        type = "message";

      switch (type) {
        case "message": {
          const content = get(item, "content");

          if (typeof content === "string") add(segments, content);
          else if (isJsonArray(content))
            for (const part of content) add(segments, get(part, "text"));
          break;
        }

        case "function_call":
          add(segments, get(item, "name"));
          add(segments, get(item, "arguments"));
          break;
        case "function_call_output":
          add(segments, get(item, "output"));
          break;
        default:
          add(segments, get(item, "text"));
      }
    }
  }

  const tools = get(body, "tools");

  if (isJsonArray(tools)) {
    for (const tool of tools) {
      add(segments, get(tool, "name"));
      add(segments, get(tool, "description"));
      addJsonOrString(segments, get(tool, "parameters"));
    }
  }

  const format = get(body, "text.format");

  if (format !== undefined) {
    add(segments, get(format, "name"));
    addJsonOrString(segments, get(format, "schema"));
  }

  return countSegments(codec, segments.join("\n"));
};

// ---------------------------------------------------------------------------------------------------------------
// xAI Responses
// ---------------------------------------------------------------------------------------------------------------

const collectXaiContent = (content: Json | undefined, segments: string[]): void => {
  if (typeof content === "string") return add(segments, content);

  if (!isJsonArray(content)) return;

  for (const part of content) {
    switch (asString(get(part, "type"))) {
      case "text":
      case "input_text":
      case "output_text":
        add(segments, get(part, "text"));
        break;
      case "refusal":
        add(segments, get(part, "refusal"));
        break;
      case "input_image":
        add(segments, get(part, "image_url"));
        add(segments, get(part, "file_id"));
        break;
      case "input_file":
        for (const key of ["file_data", "file_url", "file_id", "filename"])
          add(segments, get(part, key));
        break;
      case "input_audio":
        add(segments, get(part, "data"));
        add(segments, get(part, "input_audio.data"));
        break;
    }
  }
};

/** `countXAIInputTokens`. */
export const countXaiInputTokens = (codec: BpeCodec, body: Json | undefined): number => {
  if (body === undefined) return 0;
  const segments: string[] = [];
  add(segments, get(body, "instructions"));

  const input = get(body, "input");

  if (typeof input === "string") add(segments, input);
  else if (isJsonArray(input)) {
    for (const item of input) {
      switch (asString(get(item, "type"))) {
        case "message":
          collectXaiContent(get(item, "content"), segments);
          break;
        case "function_call":
          add(segments, get(item, "name"));
          addJsonOrString(segments, get(item, "arguments"));
          break;
        case "function_call_output":
          addJsonOrString(segments, get(item, "output"));
          break;
        case "reasoning":
          for (const part of toArray(get(item, "summary"))) add(segments, get(part, "text"));
          break;
      }
    }
  }

  const tools = get(body, "tools");

  if (isJsonArray(tools)) {
    for (const tool of tools) {
      if (asString(get(tool, "type")) !== "function") continue;
      add(segments, get(tool, "name"));
      add(segments, get(tool, "description"));
      addJsonOrString(segments, get(tool, "parameters"));
    }
  }

  const format = get(body, "text.format");

  if (format !== undefined) {
    add(segments, get(format, "name"));
    addJsonOrString(segments, get(format, "schema"));
  }

  return countSegments(codec, segments.length === 0 ? "" : segments.join("\n"));
};
