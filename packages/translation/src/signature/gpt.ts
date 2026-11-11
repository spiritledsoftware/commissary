/**
 * GPT/Codex reasoning signature validation.
 *
 * Go source: internal/signature/gpt_validation.go (`InspectGPTReasoningSignature`, `IsValidGPTReasoningSignature`).
 * This is only the Fernet-like outer transport shape of `encrypted_content`; it does not prove decryptability. A router
 * such as OpenRouter may append `.<alphanumeric suffix>` to the native value (Go be9fbd94); it is reported, not validated
 * as part of the Fernet token.
 */
import { splitRouterSuffix } from "./router-suffix.ts";

const MAX_GPT_REASONING_SIGNATURE_LEN = 32 * 1024 * 1024;

const BASE64_URL = /^[A-Za-z0-9\-_=]*$/;

const base64Value = (ch: string): number => {
  const code = ch.charCodeAt(0);

  if (code >= 65 && code <= 90) return code - 65;

  if (code >= 97 && code <= 122) return code - 71;

  if (code >= 48 && code <= 57) return code + 4;

  return ch === "-" ? 62 : 63; // "-" or "_"
};

/** Decoded length and first byte of a base64url string (raw or padded), or `undefined` when it does not decode. */
const decodeBase64UrlHead = (
  sig: string,
): { readonly length: number; readonly first: number } | undefined => {
  const pad = sig.indexOf("=");
  let length: number;

  if (pad === -1) {
    if (sig.length % 4 === 1) return undefined;
    length = Math.floor((sig.length * 3) / 4);
  } else {
    if (sig.length % 4 !== 0) return undefined;
    const padding = sig.length - pad;

    if (padding > 2 || sig.slice(pad) !== "=".repeat(padding)) return undefined;
    length = (sig.length / 4) * 3 - padding;
  }

  if (sig.length < 2) return undefined;

  return {
    length,
    first: (base64Value(sig.charAt(0)) << 2) | (base64Value(sig.charAt(1)) >> 4),
  };
};

export interface GptReasoningSignatureInfo {
  /** The router suffix, `""` for a native value. */
  readonly routerSuffix: string;
}

/** `InspectGPTReasoningSignature`: `undefined` when `raw` is not a (router-suffixed) Fernet-like `encrypted_content`. */
export const inspectGptReasoningSignature = (
  raw: string,
): GptReasoningSignatureInfo | undefined => {
  const sig = raw.trim();

  if (sig === "" || sig.length > MAX_GPT_REASONING_SIGNATURE_LEN) return undefined;

  if (!sig.startsWith("gAAAA")) return undefined;
  const split = splitRouterSuffix(sig);

  if (split === undefined || !BASE64_URL.test(split.native)) return undefined;
  const decoded = decodeBase64UrlHead(split.native);

  if (decoded === undefined || decoded.length < 73 || decoded.first !== 0x80) return undefined;
  const ciphertext = decoded.length - 1 - 8 - 16 - 32;

  return ciphertext > 0 && ciphertext % 16 === 0 ? { routerSuffix: split.routerSuffix } : undefined;
};

/** `IsValidGPTReasoningSignature`: Fernet-like outer format check of Codex `encrypted_content`. */
export const isValidGptReasoningSignature = (raw: string): boolean =>
  inspectGptReasoningSignature(raw) !== undefined;
