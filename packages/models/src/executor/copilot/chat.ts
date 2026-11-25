/**
 * Copilot's Chat Completions route (`/chat/completions`, Gemini and Kimi models): the client's stream mode upstream,
 * the openai-compat stream reader.
 *
 * Go source: internal/runtime/executor/copilot_executor_response.go (`Execute`, `ExecuteStream`).
 */
import { Effect } from "effect";
import { Formats } from "@commissary/translation/formats";
import {
  parseOpenAIStreamUsage,
  parseOpenAIUsage,
  responseModelOf,
  ssePayloadObject,
} from "../../usage/record.ts";
import { ensureResponsesUsageDetails } from "../codex/output.ts";
import { ExecutionError } from "../errors.ts";
import { transportError } from "../helps/transport-error.ts";
import { OpenAICompatStreamReader } from "../openai-compat/stream.ts";
import { type ExecutorResponse, responseFormatOf, type StreamResult } from "../types.ts";
import {
  checkStreamMode,
  type CopilotAttempt,
  failed,
  finalizeForCopilot,
  readerStream,
  readUpstreamJson,
  responseContext,
  send,
  str,
  translateForCopilot,
} from "./attempt.ts";
import { normalizeCopilotRequest, visibleChatReasoning } from "./request.ts";

/** Chat Completions body (payload rules last). */
export const prepareChatBody = Effect.fnUntraced(function* (
  attempt: CopilotAttempt,
  stream: boolean,
) {
  const { body, original } = yield* translateForCopilot(attempt, stream);
  normalizeCopilotRequest(
    body,
    attempt.route,
    attempt.options.sourceFormat,
    attempt.request.payload,
    stream,
  );
  attempt.context.usage.setReasoningEffort(str(body.reasoning_effort) || undefined);

  return finalizeForCopilot(attempt, original, body);
});

export const executeChat = Effect.fnUntraced(function* (attempt: CopilotAttempt) {
  const { context, options, registry } = attempt;
  const responseFormat = responseFormatOf(options);
  const body = yield* prepareChatBody(attempt, false);
  yield* checkStreamMode(body, false);
  const response = yield* send(attempt, body);
  const text = yield* response.text.pipe(Effect.mapError(transportError));
  yield* readUpstreamJson(attempt, text);

  const out = registry.translateNonStream(
    responseFormat,
    Formats.OpenAI,
    responseContext(attempt, body, false),
    responseFormat === Formats.OpenAI ? text : visibleChatReasoning(text, "message"),
  );

  if (out === undefined || out === "")
    return yield* failed(
      attempt,
      new ExecutionError({
        status: 502,
        message: "copilot: unable to translate upstream response",
      }),
    );
  context.usage.publish(parseOpenAIUsage(text));

  return {
    payload: responseFormat === Formats.OpenAIResponse ? ensureResponsesUsageDetails(out) : out,
    headers: new Headers(response.headers),
  } satisfies ExecutorResponse;
});

export const executeChatStream = Effect.fnUntraced(function* (attempt: CopilotAttempt) {
  const { context, options, registry } = attempt;
  const responseFormat = responseFormatOf(options);
  const body = yield* prepareChatBody(attempt, true);
  yield* checkStreamMode(body, true);
  const response = yield* send(attempt, body);

  const reader = new OpenAICompatStreamReader({
    registry,
    responseFormat,
    providerFormat: Formats.OpenAI,
    context: responseContext(attempt, body, true),
  });

  /** Copilot's `reasoning_text` shown to the translators as `reasoning_content` (not to a Chat client). */
  const visible = (line: string): string => {
    const trimmed = line.trim();

    if (responseFormat === Formats.OpenAI || !trimmed.startsWith("data:")) return line;
    const data = trimmed.slice(5).trim();
    const shown = visibleChatReasoning(data, "delta");

    return shown === data ? line : `data: ${shown}`;
  };

  return readerStream(attempt, response, {
    push: (line) => {
      const usage = parseOpenAIStreamUsage(line);

      if (usage !== undefined) context.usage.publish(usage);
      context.usage.observeResponseModel(responseModelOf(ssePayloadObject(line)));

      return reader.push(visible(line));
    },
    end: () => reader.end(),
  }) satisfies StreamResult;
});
