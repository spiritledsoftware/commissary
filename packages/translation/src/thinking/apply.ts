/**
 * The unified thinking entry point: route check → model capability lookup → config extraction → validation →
 * provider application → summary re-application.
 *
 * Go source: internal/thinking/apply.go (ApplyThinking, ApplyThinkingWithSummary, ApplyThinkingWithSourceAndSummary,
 * ApplyThinkingWithModelInfo[AndSummary], applyThinking, applyUserDefinedModel). The suffix (`model(high)`) wins over
 * body configuration. Unknown models (no model info) are treated as user-defined: no validation, the upstream decides.
 *
 * Differences from Go: the body is a parsed JSON value mutated in place (`undefined` = empty/unparsable body); the
 * five Go entry points collapse into {@link applyThinking} with options (see {@link ApplyThinkingOptions}); debug
 * logging is dropped; errors are returned, not thrown; plugin appliers do not exist.
 */
import { cloneJson, get, type Json } from "@commissary/json";
import {
  extractConfigurationUpdateConfig,
  isResponsesFormat,
  stripConfigurationUpdates,
  stripResponsesEffort,
} from "./configuration-update.ts";
import { convertLevelToBudget } from "./convert.ts";
import type { ThinkingError } from "./errors.ts";
import {
  extractCodexUsageConfig,
  extractSourceThinkingConfig,
  extractThinkingConfig,
} from "./extract.ts";
import { delPath, normalize } from "./json.ts";
import { getProviderApplier } from "./provider/index.ts";
import { stripThinkingConfig } from "./strip.ts";
import { parseSuffix, parseSuffixToConfig } from "./suffix.ts";
import {
  applySummaryConfigForProvider,
  extractSummaryConfig,
  type SummaryConfig,
  stripInferredClaudeSummaryActivation,
} from "./summary.ts";
import {
  EMPTY_CONFIG,
  hasThinkingConfig,
  Level,
  thinkingIsFullyDisabled,
  type ModelInfoLookup,
  type ThinkingConfig,
  type ThinkingModelInfo,
} from "./types.ts";
import {
  isBudgetCapableProvider,
  isLevelSupported,
  isSameProviderFamily,
  validateConfig,
} from "./validate.ts";

export interface ApplyThinkingOptions {
  /** Model name, optionally with a thinking suffix (`claude-sonnet-4-5(16384)`). */
  readonly model: string;
  /** Client format (`openai`, `openai-response`, `codex`, `claude`, `gemini`, ...). Empty = the target format. */
  readonly fromFormat: string;
  /** Provider format of `body` (`gemini`, `antigravity`, `claude`, `openai`, `codex`, `kimi`, `xai`, `interactions`). */
  readonly toFormat: string;
  /** Registry lookup key (may differ from `toFormat`, e.g. `openrouter` → `openai`). Defaults to `toFormat`. */
  readonly providerKey?: string;
  /**
   * The original client request when translation already changed the protocol (Go `sourceBody`). Must not alias
   * `body` unless identical (an aliased source is cloned first); an unparsable source is `undefined`.
   */
  readonly sourceBody?: Json | undefined;
  /**
   * Summary visibility intent resolved by the caller. When omitted: the summary of `sourceBody` in `fromFormat` if
   * model info was resolved and a source body is present, else of `body` in `toFormat` (Go `ApplyThinking` and
   * `ApplyThinkingWithModelInfo` defaults). Pass `UNSPECIFIED_SUMMARY` to skip summary handling.
   */
  readonly summaryConfig?: SummaryConfig;
  /** Go `normalizedUpdatesChanged`: a plugin/translator already rewrote the target's configuration updates. */
  readonly normalizedUpdatesChanged?: boolean;
  /**
   * The exact model definition selected for this attempt (provider-key models can override capabilities). `null` means
   * "resolved, but unknown" (user-defined path). When absent, `lookupModelInfo` is queried with the base model name.
   */
  readonly modelInfo?: ThinkingModelInfo | null;
  /** `registry.LookupModelInfo`; without it (and without `modelInfo`) models are unknown. */
  readonly lookupModelInfo?: ModelInfoLookup;
}

export interface ApplyThinkingResult {
  /** The target body with thinking applied; on validation failure the body with unsupported updates removed. */
  readonly body: Json | undefined;
  readonly error?: ThinkingError | undefined;
}

const shouldMapConfiguredHighIntent = (
  fromFormatRaw: string,
  toFormatRaw: string,
  modelInfo: ThinkingModelInfo,
): boolean => {
  const fromFormat = normalize(fromFormatRaw);
  const toFormat = normalize(toFormatRaw);

  if (fromFormat !== toFormat) return true;
  const modelType = normalize(modelInfo.type ?? "");

  return modelType !== "" && !isSameProviderFamily(toFormat, modelType);
};

/** For xhigh/max crossing families, prefers a supported level in order xhigh,max,high / max,xhigh,high. */
const mapConfiguredHighIntent = (levelRaw: string, modelInfo: ThinkingModelInfo): string => {
  const levels = modelInfo.thinking?.levels ?? [];

  if (levels.length === 0) return levelRaw;
  const level = normalize(levelRaw);
  let candidates: readonly string[];

  if (level === Level.xhigh) candidates = [Level.xhigh, Level.max, Level.high];
  else if (level === Level.max) candidates = [Level.max, Level.xhigh, Level.high];
  else return level;

  return candidates.find((candidate) => isLevelSupported(candidate, levels)) ?? level;
};

/** User-defined models: levels become budgets for budget providers (except Claude); no validation. */
const normalizeUserDefinedConfig = (config: ThinkingConfig, toFormat: string): ThinkingConfig => {
  if (config.mode !== "level" || toFormat === "claude" || !isBudgetCapableProvider(toFormat))
    return config;
  const budget = convertLevelToBudget(config.level);

  return budget === undefined ? config : { mode: "budget", budget, level: "" };
};

interface Resolved {
  readonly lookup: ModelInfoLookup | undefined;
  readonly providerKey: string;
  readonly summaryConfig: SummaryConfig;
}

const applyUserDefinedModel = (
  body: Json | undefined,
  modelInfo: ThinkingModelInfo | undefined,
  fromFormat: string,
  toFormat: string,
  suffix: ReturnType<typeof parseSuffix>,
  sourceConfig: ThinkingConfig,
  nativeResponses: boolean,
  resolved: Resolved,
): ApplyThinkingResult => {
  const modelId = modelInfo?.id ?? suffix.modelName;

  const summarize = (target: Json | undefined) =>
    applySummaryConfigForProvider(
      target,
      toFormat,
      modelId,
      resolved.providerKey,
      modelInfo,
      resolved.summaryConfig,
      resolved.lookup,
    );

  let config: ThinkingConfig;

  if (suffix.hasSuffix) {
    config = parseSuffixToConfig(suffix.rawSuffix);
  } else {
    config = sourceConfig;

    if (!hasThinkingConfig(config)) config = extractThinkingConfig(body, fromFormat);

    if (!hasThinkingConfig(config) && fromFormat !== toFormat)
      config = extractThinkingConfig(body, toFormat);
  }

  if (!hasThinkingConfig(config)) return { body: summarize(body) };

  const applier = getProviderApplier(toFormat);

  if (applier === undefined) return { body };

  config = normalizeUserDefinedConfig(config, toFormat);
  const applied = applier.apply(body, config, modelInfo);

  if (thinkingIsFullyDisabled(config) || nativeResponses) return { body: applied };

  return { body: summarize(applied) };
};

/** The caller asked for thinking off: mode none, or a zero budget. */
const thinkingRequestedOff = (config: ThinkingConfig): boolean =>
  config.mode === "none" || (config.mode === "budget" && config.budget === 0);

/**
 * Applies thinking configuration to `body` (already in the target provider format), mutating it in place.
 * Passthrough (body returned unchanged, no error) for unknown providers, and for known models without thinking
 * support when no thinking/summary configuration is present (otherwise the configuration is stripped).
 */
export const applyThinking = (
  bodyIn: Json | undefined,
  options: ApplyThinkingOptions,
): ApplyThinkingResult => {
  let body = bodyIn;
  const model = options.model;
  let providerFormat = normalize(options.toFormat);

  if (providerFormat === "openai-response") providerFormat = "codex";
  let providerKey = normalize(options.providerKey ?? "");

  if (providerKey === "") providerKey = providerFormat;
  let fromFormat = normalize(options.fromFormat);

  if (fromFormat === "") fromFormat = providerFormat;

  const modelInfoResolved = options.modelInfo !== undefined;

  // The in-place mutations below must not leak into the source snapshot the Go code reads from a separate buffer.
  const sourceBody =
    options.sourceBody !== undefined && options.sourceBody === body
      ? cloneJson(options.sourceBody)
      : options.sourceBody;

  let summaryConfig = options.summaryConfig;

  if (summaryConfig === undefined) {
    summaryConfig =
      modelInfoResolved && sourceBody !== undefined
        ? extractSummaryConfig(sourceBody, options.fromFormat)
        : extractSummaryConfig(body, options.toFormat);
  }

  const resolved: Resolved = { lookup: options.lookupModelInfo, providerKey, summaryConfig };

  // 1. Parse the suffix and resolve the model.
  const suffix = parseSuffix(model);
  const baseModel = suffix.modelName;
  let modelInfo: ThinkingModelInfo | undefined;

  if (modelInfoResolved) modelInfo = options.modelInfo ?? undefined;
  else
    modelInfo =
      baseModel.trim() === ""
        ? undefined
        : options.lookupModelInfo?.(baseModel.trim(), providerKey);

  // Resolve source intent before stripping unsupported target input items.
  const updatesChanged = options.normalizedUpdatesChanged === true;
  let sourceConfig = EMPTY_CONFIG;

  if (isResponsesFormat(fromFormat)) {
    const sourceRequest = !updatesChanged && sourceBody !== undefined ? sourceBody : body;

    if (!updatesChanged || providerFormat === "codex" || providerFormat === "xai") {
      sourceConfig = extractCodexUsageConfig(sourceRequest);
    }
  }

  const responseTarget = providerFormat === "codex" || providerFormat === "xai";
  const supportsUpdates = modelInfo?.supportConfigurationUpdate === true;

  if (responseTarget && !supportsUpdates) body = stripConfigurationUpdates(body);
  const nativeResponses = responseTarget && isResponsesFormat(fromFormat) && supportsUpdates;

  // 2. Route check.
  const applier = getProviderApplier(providerFormat);

  if (applier === undefined) return { body };

  // 3. Model capability check.
  if (
    !suffix.hasSuffix &&
    sourceBody !== undefined &&
    isResponsesFormat(fromFormat) &&
    body === undefined &&
    hasThinkingConfig(extractConfigurationUpdateConfig(sourceBody))
  ) {
    // Do not rebuild a malformed target from a separate source update.
    return { body };
  }

  // Native Responses keeps the top-level baseline and in-turn updates as-is.
  if (nativeResponses && !suffix.hasSuffix) return { body };

  if (
    fromFormat === "claude" &&
    providerFormat === "claude" &&
    !suffix.hasSuffix &&
    get(body, "thinking") === undefined
  ) {
    // Native Claude effort is independent of thinking activation. Preserve the model's thinking default unless a
    // suffix or an explicit summary changes it.
    return {
      body: applySummaryConfigForProvider(
        body,
        providerFormat,
        baseModel,
        providerKey,
        modelInfo,
        summaryConfig,
        options.lookupModelInfo,
      ),
    };
  }

  if (modelInfo === undefined || modelInfo.userDefined === true) {
    return applyUserDefinedModel(
      body,
      modelInfo,
      fromFormat,
      providerFormat,
      suffix,
      sourceConfig,
      nativeResponses,
      resolved,
    );
  }

  if (modelInfo.thinking === undefined) {
    const config = extractThinkingConfig(body, providerFormat);

    if (hasThinkingConfig(config) || summaryConfig.mode !== "unspecified") {
      return {
        body: responseTarget
          ? stripResponsesEffort(body)
          : stripThinkingConfig(body, providerFormat),
      };
    }

    return { body };
  }

  // 4. Config: the suffix has priority over the body.
  let config: ThinkingConfig;

  if (suffix.hasSuffix) {
    config = parseSuffixToConfig(suffix.rawSuffix);
  } else {
    config = sourceConfig;

    if (
      !hasThinkingConfig(config) &&
      !updatesChanged &&
      modelInfoResolved &&
      sourceBody !== undefined
    ) {
      config = extractSourceThinkingConfig(sourceBody, fromFormat);
    }

    if (!hasThinkingConfig(config)) config = extractThinkingConfig(body, providerFormat);
  }

  if (!hasThinkingConfig(config)) {
    if (nativeResponses) return { body };

    if (
      modelInfoResolved &&
      providerFormat === "claude" &&
      fromFormat !== providerFormat &&
      extractSummaryConfig(sourceBody, fromFormat).mode === "enabled"
    ) {
      // Registry translation only sees aggregate model capabilities: for a cross-protocol summary-only request it
      // may have activated adaptive thinking solely to make display valid. The selected model is authoritative, so
      // drop that inferred activation when it supports only manual extended thinking.
      body = stripInferredClaudeSummaryActivation(body, modelInfo);
    }

    return {
      body: applySummaryConfigForProvider(
        body,
        providerFormat,
        baseModel,
        providerKey,
        modelInfo,
        summaryConfig,
        options.lookupModelInfo,
      ),
    };
  }

  if (
    modelInfoResolved &&
    config.mode === "level" &&
    shouldMapConfiguredHighIntent(fromFormat, providerFormat, modelInfo)
  ) {
    config = { ...config, level: mapConfiguredHighIntent(config.level, modelInfo) };
  }

  // 5. Validate and normalise.
  const validation = validateConfig(
    config,
    modelInfo,
    fromFormat,
    providerFormat,
    suffix.hasSuffix,
  );

  if (validation.error !== undefined) return { body, error: validation.error };

  // 6. Apply with the provider applier, then restore the target summary intent that was explicit before suffix
  // processing. A fully disabled amount takes precedence over visibility.
  let applied = applier.apply(body, validation.config, modelInfo);

  if (thinkingIsFullyDisabled(validation.config) || nativeResponses) return { body: applied };

  if (providerFormat === "claude" && thinkingRequestedOff(config)) {
    // The model cannot turn thinking off, so validation fell back to its lowest level. Drop any stale
    // block_binding from the off request and keep the caller's intent of seeing no thinking: without an explicit
    // omitted display, cloaking would add progress updates.
    applied = delPath(applied, "thinking.block_binding");
    summaryConfig = { mode: "disabled", detail: "" };
  }

  return {
    body: applySummaryConfigForProvider(
      applied,
      providerFormat,
      baseModel,
      providerKey,
      modelInfo,
      summaryConfig,
      options.lookupModelInfo,
    ),
  };
};
