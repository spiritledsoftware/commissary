/**
 * Helpers shared by the Antigravity response translators.
 *
 * Go source: `HasAntigravityResponsePayload` in internal/translator/common/gemini.go.
 */
import { asInt, asString, get, isJsonArray, isJsonObject, type Json } from "@commissary/json";

export const USAGE_PATHS = [
  "response.usageMetadata",
  "response.cpaUsageMetadata",
  "usageMetadata",
  "cpaUsageMetadata",
] as const;

const PAYLOAD_PART_KEYS = [
  "functionCall",
  "function_call",
  "fileData",
  "file_data",
  "executableCode",
  "executable_code",
  "codeExecutionResult",
  "code_execution_result",
] as const;

/** A part that is output: text, a call, visible media, a file or code. */
const isPayloadPart = (part: Json): boolean => {
  if (asString(get(part, "text")) !== "") return true;

  if (PAYLOAD_PART_KEYS.some((key) => get(part, key) !== undefined)) return true;

  return (
    get(part, "thought") !== true &&
    (asString(get(part, "inlineData.data")) !== "" ||
      asString(get(part, "inline_data.data")) !== "")
  );
};

/**
 * `HasAntigravityResponsePayload`: whether a chunk carries generated content (a finish reason, grounding chunks, a part
 * with output) or output token accounting. An envelope such as `{}` or `{"response":{}}`, or a signature-only empty text
 * part with zero output tokens, must not count as a started stream, otherwise a keepalive would be enough to finalize a
 * stream that produced nothing (CLIProxyAPI a3e75421).
 */
export const hasAntigravityResponsePayload = (raw: Json | undefined): boolean => {
  for (const path of ["response.candidates", "candidates"]) {
    const candidates = get(raw, path);

    if (!isJsonArray(candidates)) continue;

    for (const candidate of candidates) {
      if (asString(get(candidate, "finishReason")).trim() !== "") return true;
      const chunks = get(candidate, "groundingMetadata.groundingChunks");

      if (isJsonArray(chunks) && chunks.length > 0) return true;
      const parts = get(candidate, "content.parts");

      if (isJsonArray(parts) && parts.some(isPayloadPart)) return true;
    }
  }

  return USAGE_PATHS.some((path) => {
    const usage = get(raw, path);

    return (
      isJsonObject(usage) &&
      (asInt(usage["candidatesTokenCount"]) > 0 || asInt(usage["thoughtsTokenCount"]) > 0)
    );
  });
};
