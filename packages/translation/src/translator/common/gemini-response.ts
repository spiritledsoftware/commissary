/**
 * Pieces the Gemini and Antigravity response translators share.
 *
 * Go source: internal/translator/gemini/openai/chat-completions/gemini_openai_response.go (`isGeminiContentFilterFinishReason`,
 * the function-call id format) and antigravity/openai/chat-completions/antigravity_openai_response.go
 * (`isAntigravityContentFilterFinishReason`); upstream 3f5d3a16, da21f1e5.
 */
import { asString, type Json } from "@commissary/json";

/** Safety, recitation, blocklist, prohibited-content, SPII, image-safety and malformed finishReasons. */
export const isContentFilterFinishReason = (reason: string): boolean => {
  switch (reason.trim().toUpperCase()) {
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
    case "MALFORMED_RESPONSE":
    case "MALFORMED_FUNCTION_CALL":
      return true;
    default:
      return false;
  }
};

let functionCallIdCounter = 0;

/**
 * The tool-call id: the upstream functionCall `id` when present (da21f1e5), else a unique `name-<unix nano>-<counter>`
 * (Go uses `time.Now().UnixNano()`).
 */
export const functionCallId = (name: string, upstreamId?: Json): string => {
  const explicit = asString(upstreamId).trim();

  if (explicit !== "") return explicit;
  functionCallIdCounter++;

  return `${name}-${Date.now()}000000-${functionCallIdCounter}`;
};
