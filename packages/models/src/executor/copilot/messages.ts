/**
 * Copilot's Messages route (`/v1/messages`, Claude models): Claude clients get the client's stream mode, others a
 * streamed answer (the Claude response translators read events), the Claude stream reader.
 *
 * Go source: internal/runtime/executor/copilot_executor.go (`prepare`: cache breakpoints, the non-streaming limit),
 * copilot_executor_response.go (`Execute`, `ExecuteStream`).
 */
import { Effect } from "effect";
import { get, tryParseJson } from "@commissary/json";
import { Formats } from "@commissary/translation/formats";
import { extractTranslatedReasoningEffort } from "@commissary/translation/thinking";
import { responseModelOf, type UsageDetail } from "../../usage/record.ts";
import {
  injectMessagesCacheControl,
  injectSystemCacheControl,
  injectToolsCacheControl,
  shouldEnsureCacheControl,
  stripPromptCacheOptions,
} from "../claude/cache-control.ts";
import { ClaudeStreamReader, validateClaudeStreamingResponse } from "../claude/stream.ts";
import { mergeUsage, parseClaudeStreamUsage, parseClaudeUsage } from "../claude/usage.ts";
import { ensureResponsesUsageDetails } from "../codex/output.ts";
import { ExecutionError } from "../errors.ts";
import { transportError } from "../helps/transport-error.ts";
import { TOOL_INPUT_ERROR_MESSAGE } from "../openai-compat/stream.ts";
import { type ExecutorResponse, responseFormatOf, type StreamResult } from "../types.ts";
import {
  checkStreamMode,
  type CopilotAttempt,
  failed,
  finalizeForCopilot,
  readerStream,
  readUpstreamJson,
  requestError,
  responseContext,
  send,
  translateForCopilot,
} from "./attempt.ts";
import { normalizeCopilotRequest } from "./request.ts";

/** Messages body: protocol fixes, cache breakpoints, then the payload rules. */
export const prepareMessagesBody = Effect.fnUntraced(function* (
  attempt: CopilotAttempt,
  stream: boolean,
  countOnly = false,
) {
  const { request, options, route } = attempt;
  const { body, original } = yield* translateForCopilot(attempt, stream);
  normalizeCopilotRequest(body, route, options.sourceFormat, request.payload, stream);

  if (shouldEnsureCacheControl(body, false, false, request.payload, options.originalRequest)) {
    // Unlike Claude Code, Copilot also marks the tools when a system prompt exists.
    injectToolsCacheControl(body);
    injectSystemCacheControl(body);
    injectMessagesCacheControl(body);
  }

  stripPromptCacheOptions(body);
  const final = finalizeForCopilot(attempt, original, body);
  const effort = extractTranslatedReasoningEffort(final, Formats.Claude);
  attempt.context.usage.setReasoningEffort(effort !== "" ? effort : undefined);

  if (
    !countOnly &&
    !stream &&
    route.nonStreamingOutput > 0 &&
    typeof get(final, "max_tokens") === "number" &&
    Number(get(final, "max_tokens")) > route.nonStreamingOutput
  ) {
    return yield* requestError(
      400,
      `copilot: max_tokens exceeds this model's non-streaming limit of ${route.nonStreamingOutput}; lower max_tokens or enable streaming`,
    );
  }

  return final;
});

/** The usage of a whole event stream, after `validateClaudeStreamingResponse`; the answering model is recorded. */
const streamedUsage = (attempt: CopilotAttempt, data: string): UsageDetail | undefined => {
  let usage: UsageDetail | undefined;

  for (const line of data.split("\n")) {
    const parsed = parseClaudeStreamUsage(line);

    if (parsed !== undefined) usage = mergeUsage(usage, parsed);
    const trimmed = line.trim();

    if (trimmed.startsWith("data:"))
      attempt.context.usage.observeResponseModel(
        responseModelOf(tryParseJson(trimmed.slice(5).trim())),
      );
  }

  return usage;
};

/**
 * Non-stream answer. Claude clients get the upstream JSON; other clients read a streamed answer (the Claude
 * translators expect the event sequence), validated and translated in one piece.
 */
export const executeMessages = Effect.fnUntraced(function* (attempt: CopilotAttempt) {
  const { context, options, registry } = attempt;
  const responseFormat = responseFormatOf(options);
  const upstreamStream = responseFormat !== Formats.Claude;
  const body = yield* prepareMessagesBody(attempt, upstreamStream);
  yield* checkStreamMode(body, upstreamStream);
  const response = yield* send(attempt, body);
  const data = yield* response.text.pipe(Effect.mapError(transportError));
  let usage: UsageDetail | undefined;

  if (upstreamStream) {
    const invalid = validateClaudeStreamingResponse(data);

    if (invalid !== undefined)
      return yield* failed(attempt, new ExecutionError({ status: 502, message: invalid }));
    usage = streamedUsage(attempt, data);
  } else {
    yield* readUpstreamJson(attempt, data);
    usage = parseClaudeUsage(data);
  }

  const out = registry.translateNonStream(
    responseFormat,
    Formats.Claude,
    responseContext(attempt, body, upstreamStream),
    data,
  );

  if (out === undefined || out === "")
    return yield* failed(
      attempt,
      new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE }),
    );

  if (usage !== undefined) context.usage.publish(usage);

  return {
    payload: responseFormat === Formats.OpenAIResponse ? ensureResponsesUsageDetails(out) : out,
    headers: new Headers(response.headers),
  } satisfies ExecutorResponse;
});

export const executeMessagesStream = Effect.fnUntraced(function* (attempt: CopilotAttempt) {
  const { context, options, registry } = attempt;
  const body = yield* prepareMessagesBody(attempt, true);
  yield* checkStreamMode(body, true);
  const response = yield* send(attempt, body);

  const reader = new ClaudeStreamReader({
    registry,
    responseFormat: responseFormatOf(options),
    context: responseContext(attempt, body, true),
    reverseMap: new Map(),
    onUsage: (detail) => context.usage.publish(detail),
    onResponseModel: (model) => context.usage.observeResponseModel(model),
  });

  return readerStream(attempt, response, reader) satisfies StreamResult;
});
