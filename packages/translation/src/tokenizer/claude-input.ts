/**
 * Claude input token estimate: request segment collection, BPE counting and the stream `message_start` patch.
 *
 * Go source: internal/runtime/executor/helps/claude_input_tokens.go (collectClaudeInputTokenSegments,
 * CountClaudeInputTokens, ClaudeInputTokenState.apply/applyChunk). The text is counted with `o200k_base` like Go.
 * Raw JSON segments (`tool_use.input`, `input_schema`) are `JSON.stringify` output; Go compacts the raw bytes, so
 * counts only differ for numbers that are not canonical (`1.0`) or strings with unusual escapes.
 *
 * The stream patch (`applyClaudeInputTokens`) is applied by `TranslatorRegistry.translateStream` for Claude clients
 * served by a non-Claude upstream: the first `message_start` without a non-zero `input_tokens` gets the estimate of
 * the client's original request, so every executor behaves like Go's `TranslateStreamWithClaudeInputTokens`.
 */
import { asInt, get, type Json, type JsonObject, set, tryParseJson } from "@commissary/json";
import { isArr, isObj, str } from "../translator/common/gjson.ts";
import { getCodec } from "./encodings.ts";
import { goTrimSpace } from "./text.ts";

const addString = (segments: string[], value: string): void => {
  const text = goTrimSpace(value);

  if (text !== "") segments.push(text);
};

const addJson = (segments: string[], value: Json | undefined): void => {
  if (value === undefined) return;

  if (typeof value === "string") addString(segments, value);
  else addString(segments, JSON.stringify(value));
};

const collectContent = (content: Json | undefined, segments: string[]): void => {
  if (content === undefined) return;

  if (typeof content === "string") return addString(segments, content);

  if (isArr(content)) {
    for (const part of content) collectContent(part, segments);

    return;
  }

  if (!isObj(content)) return;
  const field = (name: string): string => str(content[name]);

  switch (str(content.type)) {
    case "text":
      return addString(segments, field("text"));
    case "thinking":
      return addString(segments, field("thinking"));
    case "document": {
      const source = content.source;

      if (str(get(source, "type")) !== "text") return;
      addString(segments, field("title"));
      addString(segments, field("context"));
      addString(segments, str(get(source, "data")));
      addString(segments, str(get(source, "content")));

      return;
    }

    case "tool_use":
    case "server_tool_use":
    case "mcp_tool_use":
      addString(segments, field("id"));
      addString(segments, field("name"));

      return addJson(segments, content.input);
    case "tool_result":
    case "mcp_tool_result":
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
      addString(segments, field("tool_use_id"));
      addString(segments, field("tool_call_id"));

      return collectContent(content.content, segments);
    case "web_search_result":
    case "search_result":
      if (typeof content.source === "string") addString(segments, content.source);

      for (const name of ["title", "url", "page_age"]) addString(segments, field(name));

      return collectContent(content.content, segments);
    case "web_fetch_result":
      addString(segments, field("url"));
      addString(segments, field("retrieved_at"));

      return collectContent(content.content, segments);
    case "code_execution_result":
    case "bash_code_execution_result":
    case "text_editor_code_execution_result":
      for (const name of ["stdout", "stderr", "return_code"]) addString(segments, field(name));
      collectContent(content.content, segments);

      return collectContent(content.output, segments);
    case "tool_reference":
      return addString(segments, field("tool_name"));
    case "image":
    case "input_audio":
    case "audio":
    case "video":
    case "redacted_thinking":
      return;
    case "":
      return addJson(segments, content);
    default:
      return addString(segments, field("text"));
  }
};

/** `collectClaudeInputTokenSegments`. */
export const collectClaudeInputSegments = (body: JsonObject): string[] => {
  const segments: string[] = [];
  const system = body.system;

  if (typeof system === "string") addString(segments, system);
  else if (isArr(system)) {
    for (const part of system) {
      if (typeof part === "string") addString(segments, part);
      else if (str(get(part, "type")) === "text") addString(segments, str(get(part, "text")));
    }
  }

  if (isArr(body.messages)) {
    for (const message of body.messages) {
      addString(segments, str(get(message, "role")));
      collectContent(get(message, "content"), segments);
    }
  }

  if (isArr(body.tools)) {
    for (const tool of body.tools) {
      for (const name of ["type", "name", "description"]) addString(segments, str(get(tool, name)));
      addJson(segments, get(tool, "input_schema"));
    }
  }

  const choice = body.tool_choice;

  if (choice !== undefined) {
    if (typeof choice === "string") addString(segments, choice);
    else {
      addString(segments, str(get(choice, "type")));
      addString(segments, str(get(choice, "name")));
    }
  }

  // `collectClaudeOutputConfigTokenSegments`: a native structured-output schema counts as input.
  const format = get(body.output_config, "format");

  if (isObj(body.output_config) && isObj(format)) {
    addString(segments, str(get(format, "type")));
    addJson(segments, get(format, "schema"));
  }

  return segments;
};

/** `CountClaudeInputTokens`: `o200k_base` count of the collected segments joined by newlines. */
export const countClaudeInputTokens = (body: Json | undefined): number => {
  if (!isObj(body)) return 0;
  const segments = collectClaudeInputSegments(body);

  return segments.length === 0 ? 0 : getCodec("o200k_base").count(segments.join("\n"));
};

/** Per-attempt flag shared with the translator state: the input token update happens at most once. */
export interface ClaudeInputTokenState {
  claudeInputTokensHandled?: boolean;
}

const isSpaceOrTab = (ch: string | undefined): boolean => ch === " " || ch === "\t";

/**
 * `applyChunk`: patches the first `data:` line carrying a `message_start` event. Returns `found` once such an event
 * was seen (patched or deliberately left alone) so later chunks are not inspected.
 */
interface PatchedChunk {
  readonly chunk: string;
  readonly found: boolean;
}

const patchChunk = (chunk: string, estimate: () => number): PatchedChunk => {
  for (let lineStart = 0; lineStart < chunk.length;) {
    let lineEnd = chunk.indexOf("\n", lineStart);

    if (lineEnd < 0) lineEnd = chunk.length;
    let contentEnd = lineEnd;

    if (contentEnd > lineStart && chunk[contentEnd - 1] === "\r") contentEnd--;
    const line = chunk.slice(lineStart, contentEnd);
    let offset = 0;

    while (isSpaceOrTab(line[offset])) offset++;

    if (line.startsWith("data:", offset)) {
      let payloadOffset = offset + "data:".length;

      while (isSpaceOrTab(line[payloadOffset])) payloadOffset++;
      let payloadEnd = line.length;

      while (payloadEnd > payloadOffset && isSpaceOrTab(line[payloadEnd - 1])) payloadEnd--;
      const payload = line.slice(payloadOffset, payloadEnd);
      const event = tryParseJson(payload);

      if (str(get(event, "type")) === "message_start") {
        const existing = get(event, "message.usage.input_tokens");

        if (existing !== undefined && asInt(existing) !== 0) return { chunk, found: true };
        const count = estimate();

        if (count === 0) return { chunk, found: true };
        const updated = JSON.stringify(set(event, "message.usage.input_tokens", count));

        return {
          chunk:
            chunk.slice(0, lineStart + payloadOffset) +
            updated +
            chunk.slice(lineStart + payloadEnd),
          found: true,
        };
      }
    }

    if (lineEnd === chunk.length) break;
    lineStart = lineEnd + 1;
  }

  return { chunk, found: false };
};

/**
 * `ClaudeInputTokenState.apply`: estimates `message.usage.input_tokens` of the first `message_start` chunk whose
 * upstream reported none, from the client's original Claude request. Estimation failures leave the chunk unchanged
 * (Go logs a warning).
 */
export const applyClaudeInputTokens = (
  state: ClaudeInputTokenState,
  originalRequest: Json | undefined,
  chunks: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (state.claudeInputTokensHandled === true) return chunks;

  const estimate = (): number => {
    try {
      return countClaudeInputTokens(originalRequest);
    } catch {
      return 0;
    }
  };

  const out = [...chunks];

  for (const [i, original] of chunks.entries()) {
    const result = patchChunk(original, estimate);

    if (!result.found) continue;
    state.claudeInputTokensHandled = true;
    out[i] = result.chunk;

    return out;
  }

  return chunks;
};
