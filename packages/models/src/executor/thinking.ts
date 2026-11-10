/**
 * Thinking hook point for executors and the translator registry.
 *
 * Go source: internal/runtime/executor/helps/model_capabilities.go (ApplyRequestThinking),
 * internal/runtime/executor/helps/thinking.go (translatedRequestSummaryConfig), internal/thinking/apply.go
 * (ApplyThinking), internal/thinking/summary.go (ExtractTranslatedSummaryConfig, ApplySummaryConfigForModel).
 * Executors call `apply` after request translation and the upstream model rewrite, before provider shaping and payload
 * rules. {@link Thinking.live} runs the real pipeline (parse suffix -> canonical config -> validate -> provider
 * applier); {@link Thinking.noop} passes bodies through (tests that do not care about thinking).
 */
import { Context, Effect, Layer } from "effect";
import { type Json, cloneJson, del, get, isJsonArray, set } from "@commissary/json";
import type { Format } from "@commissary/translation/formats";
import {
  builtinTranslators,
  noopSummaryHooks,
  type SummaryHooks,
  summaryHooks,
  TranslatorRegistry,
} from "@commissary/translation";
import {
  applySummaryConfigForModel,
  applyThinking,
  extractExplicitSummaryConfig,
  extractSummaryConfig,
  extractTranslatedSummaryConfig,
  type SummaryConfig,
  type ModelInfoLookup,
  type ThinkingModelInfo,
  UNSPECIFIED_SUMMARY,
} from "@commissary/translation/thinking";
import { ExecutionError } from "./errors.ts";

export interface ThinkingRequest {
  /** Translated (provider-format) body; implementations may mutate and return it. */
  readonly body: Json;
  /** Model the client asked for after credential resolution, `(suffix)` kept (Go `req.Model`). */
  readonly model: string;
  /** Client format (Go `from`). */
  readonly from: Format;
  /** Provider format (Go `to`). */
  readonly to: Format;
  /** Registry/provider key used for model capability lookup (executor identifier, e.g. `openai-compatible-x`). */
  readonly provider: string;
  /** The client body of this attempt (source config, Responses `configuration_update` items). */
  readonly source?: Json;
  /** The client's original body (defaults to `source`); the baseline for the reasoning-summary intent. */
  readonly originalSource?: Json;
  /** Whether request translation changed Responses `configuration_update` items. */
  readonly configurationUpdatesChanged?: boolean;
  /**
   * Credential-resolved model capabilities (provider-key models may override the registry), `null` = resolved but unknown.
   * Without it the model is treated as unknown (user-defined, no validation).
   */
  readonly modelInfo?: ThinkingModelInfo | null | undefined;
  /** `registry.LookupModelInfo` for everything but `modelInfo` (summary visibility, cross-model rules). */
  readonly lookupModelInfo?: ModelInfoLookup | undefined;
}

const lowerFormat = (format: string): string => format.trim().toLowerCase();

/** `translatedRequestSummaryConfig`: where the reasoning-summary intent comes from after translation. */
const translatedSummaryConfig = (
  translators: TranslatorRegistry,
  request: ThinkingRequest,
  source: Json | undefined,
  originalSource: Json | undefined,
): SummaryConfig => {
  const from = lowerFormat(request.from);
  const to = lowerFormat(request.to);

  const target =
    from === to
      ? extractSummaryConfig(request.body, to)
      : extractExplicitSummaryConfig(request.body, to);

  if (target.mode !== "unspecified") return target;

  const current = extractTranslatedSummaryConfig(source, from, to);
  const original = extractTranslatedSummaryConfig(originalSource, from, to);

  if (current.mode === "unspecified") return original;

  if (!translators.hasRequestTransformer(request.from, request.to)) return UNSPECIFIED_SUMMARY;

  const candidate = applySummaryConfigForModel(cloneJson(request.body), to, request.model, current);

  if (extractExplicitSummaryConfig(candidate, to).mode !== "unspecified")
    return UNSPECIFIED_SUMMARY;

  return current;
};

/** `shouldReconcileClaudeOpenAICompatToolCallReasoning`: a Claude client talking to a compat Chat Completions model. */
const shouldReconcileClaudeCompatToolCallReasoning = (request: ThinkingRequest): boolean =>
  request.modelInfo?.isCompat === true &&
  lowerFormat(request.from) === "claude" &&
  lowerFormat(request.to) === "openai";

/**
 * `reconcileClaudeOpenAICompatToolCallReasoningDoc`: after thinking resolution (suffix, capability normalisation) the
 * body's `reasoning_effort` is canonical. Active: assistant tool-call turns without non-blank reasoning get the single
 * space placeholder; inactive: a blank `reasoning_content` on them is dropped. Payload rules run afterwards.
 */
export const reconcileClaudeCompatToolCallReasoning = (body: Json): Json => {
  const messages = get(body, "messages");

  if (!isJsonArray(messages)) return body;
  const effort = get(body, "reasoning_effort");
  const resolved = typeof effort === "string" ? effort.trim().toLowerCase() : "";
  const active = resolved !== "" && resolved !== "none" && resolved !== "0" && resolved !== "false";
  let out = body;

  messages.forEach((message, index) => {
    if (get(message, "role") !== "assistant") return;
    const toolCalls = get(message, "tool_calls");

    if (!isJsonArray(toolCalls) || toolCalls.length === 0) return;
    const reasoning = get(message, "reasoning_content");
    const path = `messages.${index}.reasoning_content`;
    const text = typeof reasoning === "string" ? reasoning : "";

    if (active) {
      if (reasoning === undefined || (text.trim() === "" && text !== " "))
        out = set(out, path, " ");

      return;
    }

    if (reasoning !== undefined && text.trim() === "") out = del(out, path);
  });

  return out;
};

export class Thinking extends Context.Service<
  Thinking,
  {
    /** Applies the thinking configuration; fails with a request-scoped 400 `ExecutionError` on invalid configs. */
    readonly apply: (request: ThinkingRequest) => Effect.Effect<Json, ExecutionError>;
    /** Reasoning-summary hooks applied by the translator registry around request transforms. */
    readonly summary: SummaryHooks;
  }
>()("commissary/executor/Thinking") {
  /** Passthrough implementation (tests that do not exercise thinking). */
  static readonly noop = Layer.succeed(
    Thinking,
    Thinking.of({ apply: (request) => Effect.succeed(request.body), summary: noopSummaryHooks }),
  );

  /** The real pipeline (`@commissary/translation/thinking`). */
  static readonly live = Layer.sync(Thinking, () => makeLiveThinking(builtinTranslators));
}

/** Builds the real thinking service over a translator registry (used to decide whether a transform exists). */
export function makeLiveThinking(translators: TranslatorRegistry) {
  return Thinking.of({
    summary: summaryHooks,
    apply: (request) => {
      const source = request.source ?? request.originalSource;
      const originalSource = request.originalSource ?? source;

      const result = applyThinking(request.body, {
        model: request.model,
        fromFormat: request.from,
        toFormat: request.to,
        providerKey: request.provider,
        sourceBody: source,
        summaryConfig: translatedSummaryConfig(translators, request, source, originalSource),
        ...(request.configurationUpdatesChanged === true ? { normalizedUpdatesChanged: true } : {}),
        ...(request.modelInfo === undefined ? {} : { modelInfo: request.modelInfo }),
        ...(request.lookupModelInfo === undefined
          ? {}
          : { lookupModelInfo: request.lookupModelInfo }),
      });

      if (result.error !== undefined) {
        return Effect.fail(
          new ExecutionError({
            status: result.error.statusCode,
            message: result.error.message,
            requestScoped: true,
          }),
        );
      }

      const resolved = result.body ?? request.body;

      return Effect.succeed(
        shouldReconcileClaudeCompatToolCallReasoning(request)
          ? reconcileClaudeCompatToolCallReasoning(resolved)
          : resolved,
      );
    },
  });
}
