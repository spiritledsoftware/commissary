/**
 * The carrier that moves a Codex (Responses) reasoning `encrypted_content` through a Gemini `thoughtSignature`.
 *
 * Go source: internal/translator/codex/gemini/codex_gemini_response.go (`geminiCodexThoughtSignatureCarrierMagic`,
 * `encodeGeminiCodexThoughtSignature`) and codex_gemini_request.go (`decodeGeminiCodexThoughtSignature`), Go 88ac14f3
 * and a4660260. The Gemini JSON wire form of a bytes field is standard padded base64, while a Responses signature is an
 * opaque string that may use the base64url alphabet without padding; written verbatim it makes an official SDK's
 * `[]byte` decoding fail. The carrier stores `magic + rawSignature` as the byte payload and relies on standard base64,
 * which every Gemini client decodes and echoes losslessly. Byte-identical with Go on purpose: clients can move between
 * Go and Commissary mid-conversation. Distinct from the Antigravity Claude carrier (`cpa-gemini-carrier-v1:`).
 */
import { decodeBase64Std, encodeBase64Std } from "./base64.ts";

export const GEMINI_CODEX_CARRIER_MAGIC = "cpa-codex-gemini-carrier-v1:";

/** `encodeGeminiCodexThoughtSignature`: `""` for an empty signature. */
export const encodeGeminiCodexThoughtSignature = (rawSignature: string): string => {
  const signature = rawSignature.trim();

  return signature === "" ? "" : encodeBase64Std(GEMINI_CODEX_CARRIER_MAGIC + signature);
};

/**
 * `decodeGeminiCodexThoughtSignature`: unwraps the carrier. A value without the carrier magic is returned unchanged
 * (trimmed), preserving legacy raw-signature echoes.
 */
export const decodeGeminiCodexThoughtSignature = (value: string): string => {
  const trimmed = value.trim();
  const decoded = decodeBase64Std(trimmed);

  if (decoded === undefined) return trimmed;
  const text = new TextDecoder().decode(decoded);

  return text.startsWith(GEMINI_CODEX_CARRIER_MAGIC)
    ? text.slice(GEMINI_CODEX_CARRIER_MAGIC.length).trim()
    : trimmed;
};
