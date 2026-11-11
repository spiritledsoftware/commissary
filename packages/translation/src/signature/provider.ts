/**
 * Signature provider detection and compatibility decision table.
 *
 * Go source: internal/signature/provider_compatibility.go (`SignatureProviderFromModelName`,
 * `DetectSignatureProviderForBlock`, `DecideSignatureCompatibility*`, `CompatibleSignatureForProviderBlock`).
 * Claude envelopes are validated by `claude.ts`, Gemini envelopes by `gemini.ts`, GPT Fernet payloads by `gpt.ts`,
 * Grok blobs by `grok.ts`; this module only orders the probes and decides.
 */
import { decodeBase64Std } from "./base64.ts";
import { entropyRatio } from "./entropy.ts";
import {
  GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR,
  isGeminiThoughtSignatureBypass,
  isKnownGeminiEnvelope,
} from "./gemini.ts";
import { isValidGptReasoningSignature } from "./gpt.ts";
import { isValidMetaReasoningSignature } from "./meta.ts";
import {
  inspectClaudeCaisSignature,
  isValidClaudeCaisSignature,
  isValidClaudeThinkingSignature,
  normalizeClaudeProviderNativeThinkingSignature,
} from "./claude.ts";

export type SignatureProvider =
  | "unknown"
  | "claude"
  | "gemini"
  | "gemini_bypass"
  | "gpt"
  | "kimi"
  | "grok"
  | "swe"
  | "meta";

export type SignatureBlockKind =
  | "unknown"
  | "claude_thinking"
  | "gemini_model_part"
  | "gemini_function_call"
  | "gpt_reasoning";

export type SignatureAction =
  | "preserve"
  | "drop_block"
  | "drop_signature"
  | "replace_with_gemini_bypass"
  | "no_compatible_replacement";

export interface SignatureCompatibilityDecision {
  readonly targetProvider: SignatureProvider;
  readonly detectedProvider: SignatureProvider;
  readonly blockKind: SignatureBlockKind;
  readonly compatible: boolean;
  readonly action: SignatureAction;
  readonly replacementSignature: string;
  readonly normalizedSignature: string;
  readonly reason: string;
}

/**
 * `isMetaMuseModelName`: a Meta Muse model on a native or third-party provider (`muse`, `muse-*`, `muse_*`,
 * `meta-muse-*`) without matching unrelated substrings such as `museum` or `amuse`.
 */
const isMetaMuseModelName = (lower: string): boolean => {
  if (
    lower === "muse" ||
    lower.startsWith("muse-") ||
    lower.startsWith("muse_") ||
    lower.endsWith("/muse") ||
    lower.includes("/muse-") ||
    lower.includes("/muse_")
  ) {
    return true;
  }

  for (const prefix of ["meta-", "meta_"]) {
    const index = lower.indexOf(`${prefix}muse`);

    if (index < 0) continue;
    const rest = lower.slice(index + prefix.length + 4);

    if (rest === "" || "-_.:".includes(rest.charAt(0))) return true;
  }

  return false;
};

/**
 * `SignatureProviderFromModelName`: the provider family whose signed history can be replayed for the model. A
 * namespaced id's canonical model is its last `/` or `:` segment, so a vendor or router prefix such as
 * `openai-compatible/` does not outrank the actual family (`openai-compatible/muse-spark-1.3` is Meta, not GPT); only
 * when that segment names no family does the whole string get the substring treatment.
 */
export const signatureProviderFromModelName = (modelName: string): SignatureProvider => {
  const lower = modelName.trim().toLowerCase();

  if (lower === "") return "unknown";
  const cut = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf(":"));
  const candidate = cut >= 0 && cut < lower.length - 1 ? lower.slice(cut + 1) : lower;
  const provider = providerFromModelNameValue(candidate);

  if (provider !== "unknown" || candidate === lower) return provider;

  return providerFromModelNameValue(lower);
};

const providerFromModelNameValue = (lower: string): SignatureProvider => {
  if (lower.includes("claude")) return "claude";

  if (lower.includes("gemini")) return "gemini";

  if (
    lower.includes("gpt") ||
    lower.includes("openai") ||
    lower.includes("codex") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  ) {
    return "gpt";
  }

  if (
    lower.includes("kimi") ||
    lower.includes("moonshot") ||
    lower.startsWith("k2") ||
    lower.startsWith("k3")
  ) {
    return "kimi";
  }

  if (lower.includes("grok")) return "grok";

  if (isMetaMuseModelName(lower)) return "meta";

  if (lower.includes("swe-")) return "swe";

  return "unknown";
};

/** `SignatureProviderFromCachePrefix`. */
const providerFromCachePrefix = (prefix: string): SignatureProvider => {
  switch (prefix.trim().toLowerCase()) {
    case "claude":
    case "anthropic":
    case "cais":
    case "claude-cais":
    case "claude_cais":
    case "ccmax":
    case "claude-code-max":
    case "claude_code_max":
      return "claude";
    case "gemini":
    case "google":
      return "gemini";
    case "openai":
    case "gpt":
    case "codex":
      return "gpt";
    case "swe":
    case "sealed":
      return "swe";
    default:
      return "unknown";
  }
};

/** `SplitSignatureProviderPrefix`. */
export const splitSignatureProviderPrefix = (
  raw: string,
): { readonly provider: SignatureProvider; readonly unprefixed: string } | undefined => {
  const trimmed = raw.trim();
  const index = trimmed.indexOf("#");

  if (index < 0) return undefined;
  const provider = providerFromCachePrefix(trimmed.slice(0, index));

  return provider === "unknown"
    ? undefined
    : { provider, unprefixed: trimmed.slice(index + 1).trim() };
};

/** `SignaturePayloadWithoutProviderPrefix`. */
export const signaturePayloadWithoutProviderPrefix = (raw: string): string =>
  splitSignatureProviderPrefix(raw)?.unprefixed ?? raw.trim();

const KIMI_LENGTHS = new Set([12946, 4340]);

const KIMI_MIN_ENTROPY_RATIO = 0.85;

/** `IsValidKimiThinkingSignature`: size, character class and entropy of an unpadded standard base64 blob. */
export const isValidKimiThinkingSignature = (raw: string): boolean => {
  const sig = raw.trim();

  if (sig === "" || sig !== raw || !KIMI_LENGTHS.has(sig.length)) return false;

  if (sig.includes("=") || !/^[A-Za-z0-9+/]+$/.test(sig)) return false;

  if (splitSignatureProviderPrefix(sig) !== undefined) return false;

  if (maybeSelfDescribingSignatureEnvelope(sig)) {
    if (sig.startsWith("gAAAA")) return false;

    if (isValidClaudeCaisSignature(sig)) return false;

    if (isValidClaudeThinkingSignature(sig, { strict: true })) return false;

    if (isRecognizedGeminiSignature(sig)) return false;
  }

  const decoded = decodeBase64Std(sig + "=".repeat((4 - (sig.length % 4)) % 4));

  return decoded !== undefined && entropyRatio(decoded) >= KIMI_MIN_ENTROPY_RATIO;
};

/**
 * `selfDescribingSignatureFirstChars`: the base64 first characters a self-describing envelope can produce, by the
 * first decoded byte: `C` Claude CAIS (0x08), `E` Claude single-layer and Gemini protobuf field 2 (0x12), `A` Gemini
 * Vertex bare-Tink (0x01), `Q` Antigravity double-layer CAQS (0x43), `R` Claude double-layer R (0x45), `g` GPT
 * Fernet (0x80). A replay-safe envelope missing from this set would fall through to the residual classes.
 */
const SELF_DESCRIBING_FIRST_CHARS = "ACEQRg";

/**
 * `maybeSelfDescribingSignatureEnvelope`: a structural pre-filter, not a classifier. False is conclusive; true only
 * narrows the candidates.
 */
export const maybeSelfDescribingSignatureEnvelope = (sig: string): boolean =>
  sig !== "" && SELF_DESCRIBING_FIRST_CHARS.includes(sig.charAt(0));

/** `isRecognizedGeminiProviderSignature`. */
const isRecognizedGeminiSignature = (raw: string): boolean =>
  !isValidClaudeCaisSignature(raw) && isKnownGeminiEnvelope(raw);

/** `DetectSignatureProviderForBlock`. */
export const detectSignatureProvider = (
  raw: string,
  _blockKind: SignatureBlockKind = "unknown",
): SignatureProvider => {
  const sig = raw.trim();

  if (sig === "") return "unknown";
  const prefixed = splitSignatureProviderPrefix(sig);

  if (prefixed !== undefined) {
    // Validators may strip cache prefixes themselves; a second prefix never lets detection disagree with replay.
    if (prefixed.unprefixed.includes("#")) return "unknown";

    switch (prefixed.provider) {
      case "gemini":
        if (isGeminiThoughtSignatureBypass(prefixed.unprefixed)) return "gemini_bypass";

        if (isRecognizedGeminiSignature(prefixed.unprefixed)) return "gemini";
        break;
      case "claude":
        if (
          isValidClaudeThinkingSignature(prefixed.unprefixed, { strict: true }) ||
          isValidClaudeCaisSignature(prefixed.unprefixed)
        ) {
          return "claude";
        }

        break;
      case "gpt":
        if (isValidGptReasoningSignature(prefixed.unprefixed)) return "gpt";
        break;
      case "swe":
        if (prefixed.unprefixed.startsWith("sealed.v1.")) return "swe";
        break;
    }

    return "unknown";
  }

  if (sig.includes("#")) return "unknown";

  if (isGeminiThoughtSignatureBypass(sig)) return "gemini_bypass";

  if (sig.startsWith("sealed.v1.")) return "swe";

  if (maybeSelfDescribingSignatureEnvelope(sig)) {
    if (isValidGptReasoningSignature(sig)) return "gpt";

    if (isValidMetaReasoningSignature(sig)) return "meta";

    if (isValidClaudeCaisSignature(sig)) return "claude";

    if (isValidClaudeThinkingSignature(sig, { strict: true })) return "claude";

    if (isRecognizedGeminiSignature(sig)) return "gemini";
  }

  if (isValidKimiThinkingSignature(sig)) return "kimi";

  return "unknown";
};

const providerMatchesTarget = (target: SignatureProvider, detected: SignatureProvider): boolean => {
  switch (target) {
    case "gemini":
      return detected === "gemini" || detected === "gemini_bypass";
    case "claude":
    case "gpt":
    case "swe":
    case "meta":
    case "kimi":
      return detected === target;
    default:
      return false;
  }
};

/** `normalizeCompatibleSignatureForProvider`: the replayable payload for the target or `""`. */
const normalizeForProvider = (target: SignatureProvider, raw: string): string => {
  const payload = signaturePayloadWithoutProviderPrefix(raw);

  switch (target === "gemini_bypass" ? "gemini" : target) {
    case "claude": {
      if (isValidClaudeCaisSignature(payload)) return payload;

      try {
        return normalizeClaudeProviderNativeThinkingSignature(payload);
      } catch {
        return "";
      }
    }

    case "gemini":
      return isGeminiThoughtSignatureBypass(payload) || isRecognizedGeminiSignature(payload)
        ? payload
        : "";
    case "gpt":
      return isValidGptReasoningSignature(payload) ? payload : "";
    case "swe":
      return payload.startsWith("sealed.v1.") ? payload : "";
    case "meta":
      return isValidMetaReasoningSignature(payload) ? payload : "";
    case "kimi":
      return isValidKimiThinkingSignature(payload) ? payload : "";
    default:
      return "";
  }
};

/** `claudeCompatibleSignatureReason`: why a matching signature is replayable (traceability only). */
const matchReason = (target: SignatureProvider, raw: string, targetModel: string): string => {
  const generic = "signature provider matches target provider";

  if (target !== "claude") return generic;
  let info;

  try {
    info = inspectClaudeCaisSignature(signaturePayloadWithoutProviderPrefix(raw));
  } catch {
    return generic;
  }

  let reason: string;

  if (info.modelText !== "") {
    reason = `valid Claude CAIS signature with embedded model ${info.modelText} is compatible with any Claude target`;
  } else if (info.envelopeVersion >= 4) {
    reason = "valid Claude CAQS signature is compatible with any Claude target";
  } else {
    reason = "valid Claude CAIS signature is compatible with any Claude target";
  }

  const model = targetModel.trim();

  return model === "" ? reason : `${reason}, including target model ${model}`;
};

/**
 * `DecideSignatureCompatibility[ForModel]`: the safe handling policy for replaying a signed block into
 * `targetProvider` (`targetModel` only appears in the reason).
 */
export const decideSignatureCompatibility = (
  targetProvider: SignatureProvider,
  raw: string,
  blockKind: SignatureBlockKind = "unknown",
  targetModel = "",
): SignatureCompatibilityDecision => {
  const target: SignatureProvider = targetProvider === "gemini_bypass" ? "gemini" : targetProvider;
  const detected = detectSignatureProvider(raw, blockKind);
  const base = { targetProvider: target, detectedProvider: detected, blockKind };
  const none = { replacementSignature: "", normalizedSignature: "" };

  // Recognising a Claude envelope does not authorise a Google transport wrapper on native Claude endpoints.
  if (
    target === "claude" &&
    detected === "claude" &&
    signaturePayloadWithoutProviderPrefix(raw).startsWith("Q")
  ) {
    return {
      ...base,
      ...none,
      compatible: false,
      action: "drop_block",
      reason: "Antigravity CAQS wrapper requires Antigravity replay",
    };
  }

  if (providerMatchesTarget(target, detected)) {
    const normalized = normalizeForProvider(target, raw);

    if (normalized !== "") {
      return {
        ...base,
        replacementSignature: "",
        normalizedSignature: normalized,
        compatible: true,
        action: "preserve",
        reason: matchReason(target, raw, targetModel),
      };
    }
  }

  const incompatible = { ...base, compatible: false };

  switch (target) {
    case "gemini":
      if (
        blockKind === "gemini_function_call" ||
        blockKind === "gemini_model_part" ||
        blockKind === "unknown"
      ) {
        return {
          ...incompatible,
          replacementSignature: GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR,
          normalizedSignature: "",
          action: "replace_with_gemini_bypass",
          reason: "missing or incompatible signature",
        };
      }

      return {
        ...incompatible,
        ...none,
        action: "drop_block",
        reason:
          "signature is not compatible with Gemini and this block is not a bypass-safe Gemini model part",
      };
    case "kimi":
      // Kimi never reads the field back, so only the signature is dropped.
      return {
        ...incompatible,
        ...none,
        action: "drop_signature",
        reason:
          "Kimi does not validate replayed thinking signatures, so the block survives without one",
      };
    case "claude":
      return {
        ...incompatible,
        ...none,
        action: "drop_block",
        reason: "Claude has no cross-provider bypass sentinel for thinking blocks",
      };
    case "gpt":
      return {
        ...incompatible,
        ...none,
        action: "drop_block",
        reason:
          "GPT reasoning encrypted_content cannot be synthesized from another provider signature",
      };
    case "swe":
      return {
        ...incompatible,
        ...none,
        action: "drop_block",
        reason: "SWE requires sealed.v1 signature from its own backend",
      };
    case "meta":
      return {
        ...incompatible,
        ...none,
        action: "drop_block",
        reason:
          "Meta Muse requires its native encrypted_content envelope and has no cross-provider bypass sentinel",
      };
    case "grok":
      return {
        ...incompatible,
        ...none,
        action: "drop_block",
        reason: "xAI verifies encrypted_content on replay and rejects foreign or mutated blobs",
      };
    default:
      return {
        ...incompatible,
        ...none,
        action: "no_compatible_replacement",
        reason: "unknown target provider",
      };
  }
};

/** `CompatibleSignatureForProviderBlock`. */
export const compatibleSignatureForProvider = (
  targetProvider: SignatureProvider,
  raw: string,
  blockKind: SignatureBlockKind = "unknown",
): string | undefined => {
  const decision = decideSignatureCompatibility(targetProvider, raw, blockKind);

  return decision.compatible && decision.normalizedSignature !== ""
    ? decision.normalizedSignature
    : undefined;
};
