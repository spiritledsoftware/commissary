/**
 * Payload classification for Gemini response parts, shared by the translators that read Gemini responses.
 *
 * Go source: internal/translator/gemini/common/parts.go (HasUnsupportedPartPayload), mirrored file for file. The
 * field accessors and role helpers for Gemini parts, from internal/translator/common/gemini.go, live in
 * `translator/common/gemini-parts.ts`.
 */
import { isJsonObject, type Json } from "@commissary/json";

/** Part fields that carry a payload; any other field (`thought`, `thoughtSignature`, `partMetadata`) is metadata. */
const PAYLOAD_FIELDS = new Set([
  "text",
  "functionCall",
  "function_call",
  "functionResponse",
  "function_response",
  "inlineData",
  "inline_data",
  "fileData",
  "file_data",
  "executableCode",
  "executable_code",
  "codeExecutionResult",
  "code_execution_result",
  "toolCall",
  "tool_call",
  "toolResponse",
  "tool_response",
  "audioTranscription",
  "audio_transcription",
]);

/**
 * `HasUnsupportedPartPayload`: whether `part` carries a payload field the caller does not translate, so its omitted
 * payload is not mistaken for a detached signature of a neighbouring supported part.
 */
export const hasUnsupportedPartPayload = (
  part: Json | undefined,
  supportedFields: ReadonlyArray<string>,
): boolean => {
  if (!isJsonObject(part)) return false;

  return Object.keys(part).some(
    (name) => PAYLOAD_FIELDS.has(name) && !supportedFields.includes(name),
  );
};
