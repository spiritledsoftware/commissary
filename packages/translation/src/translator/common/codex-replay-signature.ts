/**
 * The reasoning signature a Codex-format (Responses) upstream may be sent for a target model.
 *
 * Go source: internal/translator/common/codex_replay_signature.go (`ResolveCodexReplayTargetModel`,
 * `CodexReplaySignatureForTarget`). Shared by the Claude, Gemini and Interactions -> Codex request translators and the
 * executors' Responses sanitiser.
 */
import { asString, get, type Json } from "@commissary/json";
import {
  compatibleSignatureForProvider,
  detectSignatureProvider,
  signatureProviderFromModelName,
} from "../../signature/provider.ts";
import { inspectGrokEncryptedContent } from "../../signature/grok.ts";
import { parseSuffix } from "../../thinking/suffix.ts";

/**
 * `ResolveCodexReplayTargetModel`: the model name to use for signature family checks, falling back to the client's
 * `model` field when `modelName` is an unmapped upstream deployment alias for a Responses-native family (Meta Muse,
 * Grok or GPT).
 */
export const resolveCodexReplayTargetModel = (
  modelName: string,
  rawPayload: Json | undefined,
): string => {
  if (signatureProviderFromModelName(parseSuffix(modelName).modelName) !== "unknown") {
    return modelName;
  }

  if (rawPayload === undefined) return modelName;
  const rawModel = asString(get(rawPayload, "model")).trim();

  if (rawModel === "") return modelName;

  switch (signatureProviderFromModelName(parseSuffix(rawModel).modelName)) {
    case "meta":
    case "grok":
    case "gpt":
      return rawModel;
    default:
      return modelName;
  }
};

/**
 * `CodexReplaySignatureForTarget`: the exact value that may be written as a Responses reasoning `encrypted_content`
 * for the Codex-format upstream serving `modelName`, or `undefined` when `rawSignature` must not replay there. A
 * positively detected family must match the target family exactly (an unmapped target defaults to the Codex GPT
 * family) and goes through the shared compatibility normalisation, so a cache-prefixed `gpt#...` is stripped to its
 * native payload. Grok has no detectable envelope, so it falls back to its shape inspector keyed on the target.
 */
export const codexReplaySignatureForTarget = (
  modelName: string,
  rawSignature: string,
): string | undefined => {
  const signature = rawSignature.trim();

  if (signature === "") return undefined;
  const target = signatureProviderFromModelName(parseSuffix(modelName).modelName);
  const detected = detectSignatureProvider(signature);

  if (detected !== "unknown") {
    const effectiveTarget = target === "unknown" ? "gpt" : target;

    if (detected !== effectiveTarget) return undefined;
    const normalized = compatibleSignatureForProvider(effectiveTarget, signature);

    return normalized !== undefined && normalized !== "" ? normalized : undefined;
  }

  if (target === "grok" && inspectGrokEncryptedContent(signature) !== undefined) return signature;

  return undefined;
};
