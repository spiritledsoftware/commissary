/**
 * OpenAI Responses request shaping shared by the executors that post Codex-format bodies to a `/responses` endpoint
 * that always streams (Meta, OpenCode Zen/Go).
 *
 * Go source: internal/runtime/executor/meta_executor_execute.go (`prepareResponsesRequest`),
 * openai_responses_signature.go (keep-foreign reasoning sanitising, in `executor/codex/request.ts`). Order: translate
 * -> thinking -> model/stream fields -> instructions -> reasoning sanitising -> provider tool sanitising -> payload
 * rules (final barrier). The apply_patch bridge (`NormalizeApplyPatchResponsesRequest` after the field deletions,
 * `helps/apply-patch-responses.ts`) turns the Codex custom tool into a strict function; the response side uses
 * `ResponsesPrepared.applyPatch`. `is-compat` models use the compat request transforms (`helps/translate.ts`).
 *
 * The OpenCode executor reuses this shaping without Meta's web-search tool sanitising (no Go counterpart, see
 * docs/ARCHITECTURE.md "OpenCode Zen and OpenCode Go").
 */
import { modelIsCompat, translateRequestForExecutor } from "./translate.ts";
import { Effect } from "effect";
import { cloneJson, del, get, type Json } from "@commissary/json";
import { Formats } from "@commissary/translation/formats";
import type { TranslatorRegistry } from "@commissary/translation";
import { ExecutionError } from "../errors.ts";
import {
  normalizeCodexInstructions,
  sanitizeReasoningEncryptedContent,
  setIfDifferent,
} from "../codex/request.ts";
import { ApplyPatchResponsesState, normalizeApplyPatchResponses } from "./apply-patch-responses.ts";
import { finalizePayload } from "./payload.ts";
import { parseSuffix } from "@commissary/translation/thinking";
import { Thinking } from "../thinking.ts";
import {
  type ExecutionContext,
  type ExecutorOptions,
  type ExecutorRequest,
  responseFormatOf,
} from "../types.ts";

export interface ResponsesPrepared {
  readonly baseModel: string;
  /** The `model` of the body after the payload rules (the base model when a rule blanked it). */
  readonly effectiveModel: string;
  readonly body: Json;
  /** The translated body before the payload rules (translator response context). */
  readonly translated: Json;
  readonly from: string;
  readonly responseFormat: string;
  /** Request-local apply_patch bridge (`metaPreparedRequest.applyPatch`). */
  readonly applyPatch: ApplyPatchResponsesState;
}

export interface ResponsesShaping {
  /** Thinking provider key and payload-rule target executor. */
  readonly provider: string;
  /** Protocol the payload rules match against (Meta passes its executor identifier, as Go does). */
  readonly payloadProtocol: string;
  /** Provider tool sanitising, run after the reasoning sanitising (Meta: `SanitizeMetaWebSearchTools`). */
  readonly sanitizeTools?: (body: Json) => Json;
}

export const prepareResponsesRequest = Effect.fnUntraced(function* (
  registry: TranslatorRegistry,
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
  shaping: ResponsesShaping,
  /** `false` only for local token counting (Go `prepareResponsesRequest(..., false)`); upstream calls always stream. */
  stream = true,
) {
  const thinking = yield* Thinking;
  const baseModel = parseSuffix(request.model).modelName;
  const from = options.sourceFormat;
  const to = Formats.Codex;

  const translate = (payload: Json) =>
    translateRequestForExecutor(
      registry,
      from,
      to,
      { format: from, model: baseModel, stream, body: payload },
      thinking.summary,
      { headers: options.headers, config: context.config, isCompat: modelIsCompat(request) },
    );

  const translated = translate(request.payload);

  if (translated.error !== undefined) {
    return yield* new ExecutionError({
      status: translated.error.status,
      message: translated.error.message,
      requestScoped: true,
    });
  }

  const original =
    options.originalRequest === undefined || options.originalRequest === request.payload
      ? cloneJson(translated.body)
      : translate(options.originalRequest).body;

  let body = yield* thinking.apply({
    body: translated.body,
    model: request.model,
    from,
    to,
    provider: shaping.provider,
    source: request.payload,
    ...(options.originalRequest !== undefined ? { originalSource: options.originalRequest } : {}),
    configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
    modelInfo: request.modelInfo,
    lookupModelInfo: request.modelLookup,
  });

  body = setIfDifferent(body, "model", baseModel);
  body = setIfDifferent(body, "stream", stream);

  for (const field of [
    "generate",
    "prompt_cache_retention",
    "safety_identifier",
    "stream_options",
    "client_metadata",
  ]) {
    body = del(body, field);
  }

  const applyPatch = new ApplyPatchResponsesState(
    from,
    options.originalRequest ?? request.payload,
    original,
  );

  try {
    body = normalizeApplyPatchResponses(body, options.originalRequest ?? request.payload);
  } catch (error) {
    return yield* new ExecutionError({
      status: 400,
      message: error instanceof Error ? error.message : String(error),
      requestScoped: true,
    });
  }

  body = normalizeCodexInstructions(body, false);
  body = sanitizeReasoningEncryptedContent(body, true);

  if (shaping.sanitizeTools !== undefined) body = shaping.sanitizeTools(body);
  const translatedForResponse = cloneJson(body);
  body = finalizePayload(
    context.config,
    shaping.provider,
    {
      model: baseModel,
      requestedModel:
        options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model,
      protocol: shaping.payloadProtocol,
      fromProtocol: from,
      requestPath: options.metadata.requestPath,
      headers: options.headers,
      original,
    },
    body,
  );

  const effective = get(body, "model");

  return {
    baseModel,
    effectiveModel:
      typeof effective === "string" && effective.trim() !== "" ? effective.trim() : baseModel,
    body,
    translated: translatedForResponse,
    from,
    responseFormat: responseFormatOf(options),
    applyPatch,
  } satisfies ResponsesPrepared;
});
