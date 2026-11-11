/**
 * Claude-side helpers used by the Gemini translators.
 *
 * Go source: internal/util/util.go
 * (SanitizeFunctionName), internal/util/claude_tool_result.go (ConvertClaudeToolResult, ConvertClaudeToolResultContent). The shared
 * `translator/common` helpers (system reminders, tool-result alignment) live in `translator/common/claude-messages.ts`.
 */
import { asString, get, isJsonArray, isJsonObject, type Json } from "@commissary/json";

/** `SanitizeFunctionName`: `[^a-zA-Z0-9_.:-]` -> `_`, must start with a letter/underscore, max 64 characters. */
export const sanitizeFunctionName = (name: string): string => {
  if (name === "") return "";
  let sanitized = name.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
  const first = sanitized[0] as string;

  if (!/[a-zA-Z_]/.test(first)) {
    if (sanitized.length >= 64) sanitized = sanitized.slice(0, 63);
    sanitized = `_${sanitized}`;
  }

  return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
};

export interface ClaudeToolResultImage {
  readonly mimeType: string;
  readonly data: string;
}

export interface ClaudeToolResultContent {
  /** Value for `functionResponse.response.result`, or `.error` for a failed tool result. */
  readonly result: Json;
  /** `true` when `result` is structured JSON (set as value); `false` for a plain string. */
  readonly resultIsRaw: boolean;
  readonly images: ClaudeToolResultImage[];
}

export interface ClaudeToolResult extends ClaudeToolResultContent {
  /** An explicit `tool_result.is_error: true` failure flag (only the boolean `true` counts). */
  readonly isError: boolean;
}

const isClaudeBase64Image = (block: Json | undefined): boolean =>
  asString(get(block, "type")) === "image" && asString(get(block, "source.type")) === "base64";

const claudeImageFromBlock = (block: Json): ClaudeToolResultImage | undefined => {
  const data = asString(get(block, "source.data"));

  return data === "" ? undefined : { mimeType: asString(get(block, "source.media_type")), data };
};

/** `ConvertClaudeToolResult`: a complete `tool_result` block, keeping its success/failure semantics (CLIProxyAPI 81de4b9c). */
export const convertClaudeToolResult = (block: Json | undefined): ClaudeToolResult => ({
  ...convertClaudeToolResultContent(get(block, "content")),
  isError: get(block, "is_error") === true,
});

/** `ConvertClaudeToolResultContent`: string / structured content plus separated base64 images. */
export const convertClaudeToolResultContent = (
  content: Json | undefined,
): ClaudeToolResultContent => {
  if (typeof content === "string") return { result: content, resultIsRaw: false, images: [] };

  if (isJsonArray(content)) {
    const images: ClaudeToolResultImage[] = [];
    const nonImage: Json[] = [];

    for (const block of content) {
      if (isClaudeBase64Image(block)) {
        const image = claudeImageFromBlock(block);

        if (image !== undefined) images.push(image);
        continue;
      }

      nonImage.push(block);
    }

    if (nonImage.length === 1)
      // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      return { result: nonImage[0] as Json, resultIsRaw: true, images };

    if (nonImage.length > 1) return { result: nonImage, resultIsRaw: true, images };

    return { result: "", resultIsRaw: false, images };
  }

  if (isJsonObject(content)) {
    if (isClaudeBase64Image(content)) {
      const image = claudeImageFromBlock(content);

      return { result: "", resultIsRaw: false, images: image === undefined ? [] : [image] };
    }

    return { result: content, resultIsRaw: true, images: [] };
  }

  if (content !== undefined) return { result: content, resultIsRaw: true, images: [] };

  return { result: "", resultIsRaw: false, images: [] };
};
