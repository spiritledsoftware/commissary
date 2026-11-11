/**
 * Reasoning-signature policy of the executors that post Responses-format bodies: which `encrypted_content` may replay
 * to which upstream.
 *
 * Go source: internal/runtime/executor/openai_responses_signature.go (`sanitizeOpenAIResponsesReasoningEncryptedContent*`,
 * `resolveResponsesSignatureTargetModel`, `resolveMetaSignatureTargetModel`, `isNativeMetaUpstreamURL`,
 * `isOpenRouterUpstreamURL`, `stripRouterSuffix`), Go 7a0b7563, 674dbe8f, cc5682c5, be9fbd94, a68c7d8e.
 *
 * - The target family comes from the upstream model (after alias resolution), falling back to the client-requested model
 *   when that names Meta, Grok or GPT; the Meta executor forces `muse-` + the base model.
 * - A router suffix (`.slug`, OpenRouter's private routing tag) is kept on `openrouter.ai` hosts and stripped to the
 *   native envelope on every other upstream (official or third-party). The native Meta host (`*.meta.ai`) accepts only
 *   native envelopes. Every other family's envelope is foreign to a Meta target.
 */
import {
  asBool,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from "@commissary/json";
import {
  compatibleSignatureForProvider,
  detectSignatureProvider,
  inspectGptReasoningSignature,
  inspectGrokEncryptedContent,
  inspectMetaReasoningSignature,
  type SignatureProvider,
  isValidGrokEncryptedContent,
  isValidMetaReasoningSignature,
  signatureProviderFromModelName,
  signaturePayloadWithoutProviderPrefix,
  splitSignatureProviderPrefix,
  stripRouterSuffix,
} from "@commissary/translation/signature";
import { parseSuffix } from "@commissary/translation/thinking";
import type { ExecutorOptions, ExecutorRequest } from "../types.ts";

/**
 * `canonicalCodexReasoningReplaySignatureKey`: a reasoning signature without its router suffix and cache prefix, so the
 * same reasoning item matches whether or not a router tagged it (Go a68c7d8e).
 */
export const canonicalReasoningSignatureKey = (raw: string): string => {
  const signature = signaturePayloadWithoutProviderPrefix(raw.trim());

  const suffix =
    inspectGptReasoningSignature(signature)?.routerSuffix ??
    inspectMetaReasoningSignature(signature)?.routerSuffix ??
    inspectGrokEncryptedContent(signature)?.routerSuffix ??
    "";

  return stripRouterSuffix(signature, suffix);
};

/** `canonicalXAIReasoningReplaySignatureKey`: the same for xAI's one family. */
export const canonicalGrokSignatureKey = (raw: string): string => {
  const signature = signaturePayloadWithoutProviderPrefix(raw.trim());

  return stripRouterSuffix(signature, inspectGrokEncryptedContent(signature)?.routerSuffix ?? "");
};

/** A reasoning signature a Codex-format upstream could have issued: GPT, Meta or xAI (Go `codexInputHasValidReasoningEncryptedContent`). */
export const isReplayableReasoningSignature = (raw: string): boolean => {
  const signature = signaturePayloadWithoutProviderPrefix(raw);

  return (
    inspectGptReasoningSignature(signature) !== undefined ||
    isValidMetaReasoningSignature(signature) ||
    isValidGrokEncryptedContent(signature)
  );
};

/** `resolveResponsesSignatureTargetModel`: the model whose family decides which signatures replay. */
export const resolveResponsesSignatureTargetModel = (
  baseModel: string,
  request: ExecutorRequest,
  options: ExecutorOptions,
): string => {
  if (signatureProviderFromModelName(baseModel) !== "unknown") return baseModel;

  const requestedModel =
    options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model;

  const requested = parseSuffix(requestedModel).modelName;

  switch (signatureProviderFromModelName(requested)) {
    case "meta":
    case "grok":
    case "gpt":
      return requested;
    default:
      return baseModel;
  }
};

/** `resolveXAISignatureTargetModel`: the Grok model that decides which signatures replay, else the family name. */
export const resolveXaiSignatureTargetModel = (
  baseModel: string,
  request: ExecutorRequest,
  options: ExecutorOptions,
): string => {
  const resolved = resolveResponsesSignatureTargetModel(baseModel, request, options);

  return signatureProviderFromModelName(resolved) === "grok" ? resolved : "grok";
};

/** `resolveMetaSignatureTargetModel`: the Meta executor serves Muse models whatever the alias is called. */
export const resolveMetaSignatureTargetModel = (
  baseModel: string,
  request: ExecutorRequest,
  options: ExecutorOptions,
): string => {
  const targetModel = resolveResponsesSignatureTargetModel(baseModel, request, options);

  return signatureProviderFromModelName(targetModel) === "meta" ? targetModel : `muse-${baseModel}`;
};

const hostOf = (rawUrl: string): string | undefined => {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/** `isNativeMetaUpstreamURL`: an empty or unparsable base URL is the native host, as is `*.meta.ai`. */
export const isNativeMetaUpstreamUrl = (rawUrl: string): boolean => {
  const trimmed = rawUrl.trim();

  if (trimmed === "") return true;
  const host = hostOf(trimmed);

  return host === undefined || host === "" || host === "api.meta.ai" || host.endsWith(".meta.ai");
};

/** `isOpenRouterUpstreamURL`: the one host whose router suffix the upstream understands. */
export const isOpenRouterUpstreamUrl = (rawUrl: string): boolean => {
  const trimmed = rawUrl.trim();

  if (trimmed === "") return false;
  const host = hostOf(trimmed);

  return host !== undefined && (host === "openrouter.ai" || host.endsWith(".openrouter.ai"));
};

/**
 * What a Meta envelope may do on this upstream: `foreign` (the target is not Meta, so a recognised Meta envelope is
 * another provider's), `native-only` (api.meta.ai: only unsuffixed envelopes), `allow-routed` (a router serving a Meta
 * model: native or suffixed envelopes replay verbatim).
 */
export type MetaSignaturePolicy = "foreign" | "native-only" | "allow-routed";

export interface ReasoningSanitizeOptions {
  /** `is-compat` models (such as DeepSeek) replay the reasoning `content` and the item ids. */
  readonly isCompat?: boolean;
  /** Blobs of unknown provenance replay as they are; only a recognisably other provider's are dropped. */
  readonly keepForeign?: boolean;
  readonly metaPolicy?: MetaSignaturePolicy;
  readonly targetProvider?: SignatureProvider;
  /** Keep a router suffix (the upstream is OpenRouter); otherwise it is stripped to the native envelope. */
  readonly allowRouterSuffix?: boolean;
}

const summaryIsEmpty = (summary: Json | undefined): boolean =>
  summary === undefined || summary === null || (isJsonArray(summary) && summary.length === 0);

/** The decision for one `encrypted_content` string: drop it (`reason`), rewrite it, or keep it. */
type Verdict = { readonly drop: string } | { readonly rewrite: string } | { readonly keep: true };

const KEEP: Verdict = { keep: true };

const decideEncrypted = (raw: string, options: ReasoningSanitizeOptions): Verdict => {
  const metaPolicy = options.metaPolicy ?? "foreign";
  const targetProvider = options.targetProvider ?? "unknown";
  const keepForeign = options.keepForeign === true;
  const allowRouterSuffix = options.allowRouterSuffix === true;

  if (raw !== raw.trim()) return { drop: "encrypted_content has leading or trailing whitespace" };

  if (metaPolicy !== "foreign") {
    const info = inspectMetaReasoningSignature(raw);

    if (info === undefined) return { drop: "not a Meta reasoning signature" };

    if (info.routerSuffix === "") return KEEP;

    if (metaPolicy === "native-only") {
      return {
        drop: "router-suffixed Meta reasoning signature is not accepted by the native Meta upstream",
      };
    }

    return allowRouterSuffix ? KEEP : { rewrite: stripRouterSuffix(raw, info.routerSuffix) };
  }

  if (targetProvider === "unknown" || targetProvider === "gpt") {
    let candidate = raw;
    let hasGptPrefix = false;
    const prefixed = splitSignatureProviderPrefix(raw);

    if (prefixed?.provider === "gpt") {
      candidate = prefixed.unprefixed;
      hasGptPrefix = true;
    }

    const gpt = inspectGptReasoningSignature(candidate);

    if (gpt !== undefined) {
      if (gpt.routerSuffix !== "" && !allowRouterSuffix) {
        return { rewrite: stripRouterSuffix(candidate, gpt.routerSuffix) };
      }

      return hasGptPrefix ? { rewrite: candidate } : KEEP;
    }

    if (keepForeign && raw !== "" && detectSignatureProvider(raw) === "unknown") return KEEP;

    return { drop: "not a GPT reasoning signature" };
  }

  let keep = false;
  let rewrite = "";

  if (raw !== "") {
    if (targetProvider === "grok") {
      const grok = inspectGrokEncryptedContent(raw);

      if (grok !== undefined) {
        keep = true;

        if (grok.routerSuffix !== "" && !allowRouterSuffix) {
          rewrite = stripRouterSuffix(raw, grok.routerSuffix);
        }
      }
    } else if (["gemini", "claude", "kimi", "swe"].includes(targetProvider)) {
      const normalized = compatibleSignatureForProvider(targetProvider, raw);

      keep = normalized !== undefined;

      if (normalized !== undefined && normalized !== "" && normalized !== raw) rewrite = normalized;
    }

    if (!keep && keepForeign) keep = detectSignatureProvider(raw) === "unknown";
  }

  if (!keep) {
    return {
      drop: `reasoning encrypted_content is not compatible with target provider ${targetProvider}`,
    };
  }

  return rewrite !== "" ? { rewrite } : KEEP;
};

/**
 * `sanitizeOpenAIResponsesReasoningEncryptedContent*`: reasoning `content` is cleared (cleartext is promoted into an
 * empty `summary`), an `encrypted_content` the upstream would not accept is dropped (or rewritten to the native
 * envelope) and, with `store` disabled, orphan reasoning ids are removed so the backend does not look them up. In place;
 * returns `body`.
 */
export const sanitizeReasoningEncryptedContent = (
  body: Json,
  options: ReasoningSanitizeOptions = {},
): Json => {
  const input = get(body, "input");

  if (!isJsonArray(input)) return body;
  const isCompat = options.isCompat === true;
  const stripOrphanIds = !asBool(get(body, "store"));

  for (const item of input) {
    if (!isJsonObject(item) || asString(item["type"]).trim() !== "reasoning") continue;
    clearReasoningContent(item, isCompat);

    if (!("encrypted_content" in item)) {
      if (!isCompat && stripOrphanIds && "id" in item) delete item["id"];
      continue;
    }

    const encrypted = item["encrypted_content"];

    const verdict: Verdict =
      typeof encrypted === "string"
        ? decideEncrypted(encrypted, options)
        : { drop: "encrypted_content must be a string" };

    if ("keep" in verdict) continue;

    if ("rewrite" in verdict) {
      item["encrypted_content"] = verdict.rewrite;
      continue;
    }

    delete item["encrypted_content"];

    if (!isCompat && stripOrphanIds && "id" in item) delete item["id"];
  }

  return body;
};

/** Official Codex sets `maxItems: 0` on `reasoning.content`: cleartext is promoted into an empty summary, then cleared. */
const clearReasoningContent = (item: JsonObject, isCompat: boolean): void => {
  const content = item["content"];

  if (isCompat || !isJsonArray(content) || content.length === 0) return;

  if (summaryIsEmpty(item["summary"])) {
    const parts: Json[] = [];

    for (const part of content) {
      if (asString(get(part, "type")).trim() !== "reasoning_text") continue;
      const text = asString(get(part, "text"));

      if (text !== "") parts.push({ type: "summary_text", text });
    }

    if (parts.length > 0) item["summary"] = parts;
  }

  item["content"] = [];
};

/**
 * `sanitizeOpenAIResponsesReasoningEncryptedContentWithCompatModelAndBaseURL`: the policy for the upstream at `baseUrl`
 * serving `targetModel`. A Meta target replays native-only on the native host and routed elsewhere; a router suffix is
 * kept on OpenRouter hosts only.
 */
export const reasoningOptionsForTarget = (input: {
  readonly isCompat: boolean;
  readonly targetModel: string;
  readonly baseUrl: string;
}): ReasoningSanitizeOptions => {
  const targetProvider = signatureProviderFromModelName(input.targetModel);
  let metaPolicy: MetaSignaturePolicy = "foreign";

  if (targetProvider === "meta") {
    metaPolicy =
      input.baseUrl.trim() !== "" && isNativeMetaUpstreamUrl(input.baseUrl)
        ? "native-only"
        : "allow-routed";
  }

  return {
    isCompat: input.isCompat,
    keepForeign: input.isCompat,
    metaPolicy,
    targetProvider,
    allowRouterSuffix: isOpenRouterUpstreamUrl(input.baseUrl),
  };
};

/**
 * `sanitizeOpenAIResponsesReasoningEncryptedContentForMetaBaseURL`: the Meta executor. The native host replays native
 * Muse envelopes only (GPT, other providers', unknown and router-suffixed values are all stripped, fail-closed); a
 * third-party Responses provider configured under the Meta key may emit and consume router-suffixed envelopes.
 */
export const reasoningOptionsForMeta = (baseUrl: string): ReasoningSanitizeOptions =>
  isNativeMetaUpstreamUrl(baseUrl)
    ? { keepForeign: true, metaPolicy: "native-only", targetProvider: "meta" }
    : {
        keepForeign: true,
        metaPolicy: "allow-routed",
        targetProvider: "meta",
        allowRouterSuffix: isOpenRouterUpstreamUrl(baseUrl),
      };
