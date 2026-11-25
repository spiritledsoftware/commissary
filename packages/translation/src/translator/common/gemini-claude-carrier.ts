/**
 * Gemini thought signatures on Claude's wire: a signature that rides a Claude `thinking` carrier block names the
 * native Gemini part it belongs to (the text or function call before or after it, or none), so the request
 * translator restores it onto that part and never onto another block or message (91aca317).
 *
 * Go source: internal/translator/common/gemini_claude_carrier.go.
 */
import { decodeBase64Raw, encodeBase64Raw } from "../../signature/base64.ts";
import {
  isGeminiThoughtSignatureBypass,
  MAX_GEMINI_SIGNATURE_LEN,
  signaturePayloadWithoutProviderPrefix,
} from "../../signature/gemini.ts";
import { compatibleSignatureForProvider } from "../../signature/provider.ts";

export const GEMINI_CLAUDE_CARRIER_PREFIX = "cpa-gemini-carrier-v1:";

/** Where the carried signature's part is, relative to the carrier block. */
export type GeminiClaudeCarrierDirection = "next" | "previous" | "standalone";

/** What kind of part the carried signature belongs to. */
export type GeminiClaudeCarrierTarget = "text" | "function" | "any";

const DIRECTIONS: ReadonlySet<string> = new Set(["next", "previous", "standalone"]);

const TARGETS: ReadonlySet<string> = new Set(["text", "function", "any"]);

/** `EncodeGeminiClaudeCarrierSignature`: `""` for a blank signature. */
export const encodeGeminiClaudeCarrierSignature = (
  rawSignature: string,
  direction: GeminiClaudeCarrierDirection,
  target: GeminiClaudeCarrierTarget,
): string => {
  const signature = rawSignature.trim();

  return signature === ""
    ? ""
    : `${GEMINI_CLAUDE_CARRIER_PREFIX}${direction}:${target}:${encodeBase64Raw(signature)}`;
};

/** A decoded carrier: a marked one names its direction and target; a legacy (unmarked) one is the raw signature. */
export type DecodedGeminiClaudeCarrier =
  | {
      readonly marked: true;
      readonly signature: string;
      readonly direction: GeminiClaudeCarrierDirection;
      readonly target: GeminiClaudeCarrierTarget;
    }
  | { readonly marked: false; readonly signature: string };

const utf8 = new TextDecoder();

/**
 * `DecodeGeminiClaudeCarrierSignature`: unwraps and validates a marked carrier (`undefined` when it is malformed,
 * nested, oversized or its signature is not a usable Gemini one); an unmarked signature comes back as it is.
 */
export const decodeGeminiClaudeCarrierSignature = (
  rawSignature: string,
): DecodedGeminiClaudeCarrier | undefined => {
  const raw = rawSignature.trim();

  if (!raw.startsWith(GEMINI_CLAUDE_CARRIER_PREFIX)) return { marked: false, signature: raw };

  if (raw.length > Math.floor((MAX_GEMINI_SIGNATURE_LEN * 4) / 3) + 1024) return undefined;
  const body = raw.slice(GEMINI_CLAUDE_CARRIER_PREFIX.length);
  const first = body.indexOf(":");
  const second = first < 0 ? -1 : body.indexOf(":", first + 1);

  if (second < 0) return undefined;
  const direction = body.slice(0, first);
  const target = body.slice(first + 1, second);

  if (!DIRECTIONS.has(direction) || !TARGETS.has(target)) return undefined;
  const bytes = decodeBase64Raw(body.slice(second + 1));

  if (bytes === undefined || bytes.length === 0) return undefined;
  const decoded = utf8.decode(bytes);

  if (decoded.startsWith(GEMINI_CLAUDE_CARRIER_PREFIX)) return undefined;

  const normalized = compatibleSignatureForProvider(
    "gemini",
    decoded,
    target === "function" ? "gemini_function_call" : "gemini_model_part",
  );

  if (
    normalized === undefined ||
    isGeminiThoughtSignatureBypass(signaturePayloadWithoutProviderPrefix(normalized))
  )
    return undefined;

  return {
    marked: true,
    signature: normalized,
    // SAFETY: both were checked against DIRECTIONS and TARGETS above.
    direction: direction as GeminiClaudeCarrierDirection,
    // SAFETY: as above.
    target: target as GeminiClaudeCarrierTarget,
  };
};
