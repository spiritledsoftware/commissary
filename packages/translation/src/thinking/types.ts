/**
 * Canonical thinking types.
 *
 * Go source: internal/thinking/types.go (ThinkingMode, ThinkingLevel, ThinkingConfig, SuffixResult,
 * ProviderApplier) and the slices of internal/registry/model_registry.go (ModelInfo, ThinkingSupport) that the
 * thinking pipeline reads.
 *
 * Bodies are parsed JSON values (`undefined` stands for an empty or unparsable Go body). Appliers and strip helpers
 * mutate the body in place and return the root, like `@commissary/json` `set`/`del`.
 */
import type { Json } from "@commissary/json";

/** Canonical mode; the string values match Go `ThinkingMode.String()`. */
export type ThinkingMode = "budget" | "level" | "none" | "auto";

/** Standard level names. A level can hold any string extracted from a request; validation rejects unknown ones. */
export const Level = {
  none: "none",
  auto: "auto",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

/**
 * Unified thinking configuration. Depending on `mode` only one of the fields is effective:
 * none → budget 0, auto → budget -1, budget → positive budget, level → `level`.
 * The empty config (`budget` mode, budget 0, no level) means "no configuration found".
 */
export interface ThinkingConfig {
  readonly mode: ThinkingMode;
  readonly budget: number;
  readonly level: string;
}

export const EMPTY_CONFIG: ThinkingConfig = { mode: "budget", budget: 0, level: "" };

export const noneConfig = (): ThinkingConfig => ({ mode: "none", budget: 0, level: "" });

export const autoConfig = (): ThinkingConfig => ({ mode: "auto", budget: -1, level: "" });

export const levelConfig = (level: string): ThinkingConfig => ({ mode: "level", budget: 0, level });

export const budgetConfig = (budget: number): ThinkingConfig => ({
  mode: "budget",
  budget,
  level: "",
});

/** Go `hasThinkingConfig`: anything other than the empty config. */
export const hasThinkingConfig = (config: ThinkingConfig): boolean =>
  config.mode !== "budget" || config.budget !== 0 || config.level !== "";

/** Go `thinkingIsFullyDisabled`. */
export const thinkingIsFullyDisabled = (config: ThinkingConfig): boolean =>
  config.mode === "none" && config.budget === 0 && config.level === "";

/** registry.ThinkingSupport: a model's thinking capabilities. Values are in provider-native token units. */
export interface ModelThinkingSupport {
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly zeroAllowed?: boolean | undefined;
  readonly dynamicAllowed?: boolean | undefined;
  /** Claude `thinking.type` that turns thinking off for this model; absent means `disabled` (`between_tools` on claude-sonnet-5-5). */
  readonly disableType?: string | undefined;
  readonly levels?: readonly string[] | undefined;
}

/**
 * The slice of registry.ModelInfo used by the thinking pipeline. The model registry slice provides richer
 * records that satisfy this structurally.
 */
export interface ThinkingModelInfo {
  readonly id: string;
  /** Model family the catalog assigns (e.g. `claude`, `gemini`, `codex`, `kimi`, `openai-compatibility`). */
  readonly type?: string | undefined;
  /** Defined through config (`models[]`): thinking is applied without validation. */
  readonly userDefined?: boolean | undefined;
  readonly thinking?: ModelThinkingSupport | undefined;
  /** Model understands Responses `configuration_update` input items. */
  readonly supportConfigurationUpdate?: boolean | undefined;
  readonly maxCompletionTokens?: number | undefined;
  /** The model can search the web (Gemini and Antigravity `web_search` tools). */
  readonly supportsWebSearch?: boolean | undefined;
  /** models.dev native capabilities; `webSearch` is tri-state like the Go `*bool` (`undefined`/`null` = unknown). */
  readonly nativeCapabilities?: { readonly webSearch?: boolean | null | undefined } | undefined;
  /** Configured `is-compat` model: assistant thinking blocks are kept for compatibility endpoints. */
  readonly isCompat?: boolean | undefined;
  /** models.json `config.override_header`: headers forced onto upstream requests (registry entries only). */
  readonly config?:
    | { readonly overrideHeader?: Readonly<Record<string, string>> | undefined }
    | undefined;
}

/** Registry lookup (`registry.LookupModelInfo(modelID, provider)`); the model registry slice supplies it. */
export type ModelInfoLookup = (modelId: string, provider: string) => ThinkingModelInfo | undefined;

export interface SuffixResult {
  /** Model name with the suffix removed (equal to the input without suffix). */
  readonly modelName: string;
  readonly hasSuffix: boolean;
  /** Content inside the parentheses. */
  readonly rawSuffix: string;
}

/**
 * Provider-specific application of a validated config. `apply` mutates and returns `body`; `undefined`
 * (empty/invalid body) is replaced by `{}` whenever something is written.
 */
export interface ProviderApplier {
  apply(
    body: Json | undefined,
    config: ThinkingConfig,
    modelInfo: ThinkingModelInfo | undefined,
  ): Json | undefined;
}

/** Go `IsUserDefinedModel`: unknown or config-defined models skip validation. */
export const isUserDefinedModel = (modelInfo: ThinkingModelInfo | undefined): boolean =>
  modelInfo === undefined || modelInfo.userDefined === true;
