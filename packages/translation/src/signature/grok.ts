/**
 * xAI/Grok `encrypted_content` validation and the any-provider "recognised reasoning signature" check.
 *
 * Go source: internal/signature/grok_validation.go (`InspectGrokEncryptedContent`, `IsValidGrokEncryptedContent`,
 * `byteEntropyRatio`) and provider_compatibility.go (`IsRecognizedReasoningSignature`).
 *
 * Grok emits no self-describing envelope, so this is a replay-safety check, not a provider classifier: callers must
 * establish provenance (cache prefix or a `grok*` target model) before asking.
 */
import { decodeBase64Raw } from "./base64.ts";
import { entropyRatio } from "./entropy.ts";
import { isValidClaudeCaisSignature, isValidClaudeThinkingSignature } from "./claude.ts";
import { isKnownGeminiEnvelope } from "./gemini.ts";
import {
  detectSignatureProvider,
  isValidKimiThinkingSignature,
  maybeSelfDescribingSignatureEnvelope,
  splitSignatureProviderPrefix,
} from "./provider.ts";

const MAX_GROK_ENCRYPTED_CONTENT_LEN = 8 * 1024 * 1024;

const MIN_GROK_DECODED_LEN = 32;

const MIN_GROK_ENTROPY_RATIO = 0.85;

const UNPADDED_BASE64 = /^[A-Za-z0-9+/]*$/;

/** `IsValidGrokEncryptedContent` (`InspectGrokEncryptedContent` returned no error). */
export const isValidGrokEncryptedContent = (raw: string): boolean => {
  const sig = raw.trim();

  if (sig === "" || sig.length > MAX_GROK_ENCRYPTED_CONTENT_LEN || sig !== raw) return false;

  if (sig.includes("=") || !UNPADDED_BASE64.test(sig)) return false;

  if (splitSignatureProviderPrefix(sig) !== undefined) return false;

  // Foreign envelopes can only start with one of the self-describing first characters.
  if (maybeSelfDescribingSignatureEnvelope(sig)) {
    if (sig.startsWith("gAAAA")) return false;

    if (isValidClaudeThinkingSignature(sig, { strict: true })) return false;

    if (isValidClaudeCaisSignature(sig)) return false;

    if (isKnownGeminiEnvelope(sig)) return false;
  }

  if (isValidKimiThinkingSignature(sig)) return false;
  const decoded = decodeBase64Raw(sig);

  return (
    decoded !== undefined &&
    decoded.length >= MIN_GROK_DECODED_LEN &&
    entropyRatio(decoded) >= MIN_GROK_ENTROPY_RATIO
  );
};

/**
 * `IsRecognizedReasoningSignature`: a structurally valid reasoning signature or `encrypted_content` payload from any
 * known provider (GPT, Claude, Gemini, Kimi, Grok, SWE, Devin).
 */
export const isRecognizedReasoningSignature = (raw: string): boolean => {
  const sig = raw.trim();

  if (sig === "") return false;

  if (detectSignatureProvider(sig) !== "unknown") return true;

  return isValidGrokEncryptedContent(sig);
};
