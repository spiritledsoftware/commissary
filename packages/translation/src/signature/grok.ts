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
import { isValidMetaReasoningSignature } from "./meta.ts";
import { splitRouterSuffix } from "./router-suffix.ts";
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

const GEMINI_CODEX_CARRIER_PREFIX = "cpa-codex-gemini-carrier-v1:";

export interface GrokEncryptedContentInfo {
  /** The length of the whole value, router suffix included. */
  readonly rawLen: number;
  readonly decodedLen: number;
  /** The router suffix OpenRouter appends after the native ciphertext, `""` for a native value. */
  readonly routerSuffix: string;
}

/**
 * `InspectGrokEncryptedContent`: the description of a (router-suffixed) xAI `encrypted_content`, or `undefined` when
 * `raw` fails the replay-safety check.
 */
export const inspectGrokEncryptedContent = (raw: string): GrokEncryptedContentInfo | undefined => {
  const sig = raw.trim();

  if (sig === "" || sig.length > MAX_GROK_ENCRYPTED_CONTENT_LEN || sig !== raw) return undefined;

  if (sig.includes("=")) return undefined;

  if (splitSignatureProviderPrefix(sig) !== undefined) return undefined;
  const split = splitRouterSuffix(sig);

  if (split === undefined || !UNPADDED_BASE64.test(split.native)) return undefined;
  const native = split.native;

  // Foreign envelopes can only start with one of the self-describing first characters.
  if (maybeSelfDescribingSignatureEnvelope(native)) {
    if (native.startsWith("gAAAA")) return undefined;

    if (isValidMetaReasoningSignature(native)) return undefined;

    if (isValidClaudeThinkingSignature(native, { strict: true })) return undefined;

    if (isValidClaudeCaisSignature(native)) return undefined;

    if (isKnownGeminiEnvelope(native)) return undefined;
  }

  if (isValidKimiThinkingSignature(native)) return undefined;
  const decoded = decodeBase64Raw(native);

  if (decoded === undefined) return undefined;

  // The Gemini Codex carrier (Go a68c7d8e) is base64 text of a prefixed string, never xAI ciphertext.
  if (
    new TextDecoder().decode(decoded.subarray(0, GEMINI_CODEX_CARRIER_PREFIX.length)) ===
    GEMINI_CODEX_CARRIER_PREFIX
  ) {
    return undefined;
  }

  if (decoded.length < MIN_GROK_DECODED_LEN || entropyRatio(decoded) < MIN_GROK_ENTROPY_RATIO) {
    return undefined;
  }

  return { rawLen: sig.length, decodedLen: decoded.length, routerSuffix: split.routerSuffix };
};

/** `IsValidGrokEncryptedContent` (`InspectGrokEncryptedContent` returned no error). */
export const isValidGrokEncryptedContent = (raw: string): boolean =>
  inspectGrokEncryptedContent(raw) !== undefined;

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
