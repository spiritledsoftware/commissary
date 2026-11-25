/**
 * GitHub Copilot executor (`copilot`): a signed-in Copilot account serves the Copilot CLI's preset models, each through
 * the endpoint its CLI profile names (`routes.ts`):
 *  - Chat Completions (`/chat/completions`, Gemini and Kimi models): the client mode upstream, the openai-compat
 *    stream reader (`chat.ts`);
 *  - Messages (`/v1/messages`, Claude models): Claude clients get the client mode, others a streamed answer (the
 *    Claude response translators read events), the Claude stream reader (`messages.ts`);
 *  - Responses (`/responses`, GPT, Grok and MAI models): standard Responses translation and the shared Responses
 *    shaping, always streamed upstream and collected for non-stream clients (`responses.ts`).
 * The steps every route shares are in `attempt.ts`.
 * Every request goes only to the credential's trusted `base_url` (re-checked with `isTrustedCopilotApi` before each
 * send) with the short-lived Copilot token, which the refresh machinery renews from the GitHub token
 * (`credentials/refresh/copilot.ts`). Token counting is local, in the client's format (Gemini: `totalTokens`).
 *
 * Go source: internal/runtime/executor/copilot_executor.go (`prepare`, `send`, `CountTokens`, b824c052),
 * copilot_executor_response.go (`Execute`, `ExecuteStream`, `copilotStream`: 9792ac28 translates typed events,
 * 20211183 gives the OpenAI -> Claude stream translator the stream hint). Deliberate differences (docs/ARCHITECTURE.md,
 * "GitHub Copilot"): the preset routes only (no account `/models` discovery), no in-memory turn links and no
 * server-side replay of private reasoning (the turn ids are derived, `request.ts`), Responses always stream upstream,
 * and Home dispatch is not ported.
 */
import { Effect } from "effect";
import {
  builtinTranslators,
  claudeInputTokensJson,
  geminiTokenCountJson,
  type TranslatorRegistry,
} from "@commissary/translation";
import { type Format, Formats } from "@commissary/translation/formats";
import {
  encodingForModel,
  getCodec,
  countClaudeInputTokens,
} from "@commissary/translation/tokenizer";
import { collectResponsesSse, streamResponsesSse } from "../helps/responses-sse.ts";
import {
  buildOpenAIUsageJson,
  countCodexInputTokens,
  countOpenAIChatTokens,
} from "../helps/token-count.ts";
import {
  type ExecutionContext,
  type ExecutorOptions,
  type ExecutorRequest,
  type ExecutorResponse,
  type ProviderExecutor,
  responseFormatOf,
} from "../types.ts";
import { type CopilotAttempt, resolveAttempt } from "./attempt.ts";
import { executeChat, executeChatStream, prepareChatBody } from "./chat.ts";
import { executeMessages, executeMessagesStream, prepareMessagesBody } from "./messages.ts";
import { prepareResponses, sendResponses } from "./responses.ts";
import { COPILOT_PROVIDER } from "./routes.ts";

export interface CopilotExecutorOptions {
  readonly translators?: TranslatorRegistry;
}

// --- token counting ------------------------------------------------------------------------------------------------

/** b824c052: the count in the client's format (Gemini `totalTokens`, Claude and Responses `input_tokens`). */
const tokenCountPayload = (format: Format, count: number): string => {
  switch (format) {
    case Formats.Gemini:
      return geminiTokenCountJson(count);
    case Formats.Claude:
    case Formats.OpenAIResponse:
      return claudeInputTokensJson(count);
    default:
      return buildOpenAIUsageJson(count);
  }
};

const countTokensOf = Effect.fnUntraced(function* (attempt: CopilotAttempt) {
  const { route } = attempt;
  let count: number;

  switch (route.format) {
    case Formats.Claude:
      count = countClaudeInputTokens(yield* prepareMessagesBody(attempt, false, true));
      break;
    case Formats.OpenAIResponse:
      count = countCodexInputTokens(
        getCodec(encodingForModel(route.model)),
        (yield* prepareResponses(attempt, false)).body,
      );
      break;
    default:
      count = countOpenAIChatTokens(
        getCodec(encodingForModel(route.model)),
        yield* prepareChatBody(attempt, false),
      );
  }

  return {
    payload: tokenCountPayload(responseFormatOf(attempt.options), count),
    headers: new Headers({ "x-cpa-token-count": "estimated" }),
  } satisfies ExecutorResponse;
});

export const makeCopilotExecutor = (
  executorOptions: CopilotExecutorOptions = {},
): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators;

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const attempt = yield* resolveAttempt(registry, context, request, options);

    switch (attempt.route.format) {
      case Formats.OpenAI:
        return yield* executeChat(attempt);
      case Formats.Claude:
        return yield* executeMessages(attempt);
      case Formats.OpenAIResponse:
        return yield* collectResponsesSse(yield* sendResponses(attempt));
    }
  });

  const executeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const attempt = yield* resolveAttempt(registry, context, request, options);

    switch (attempt.route.format) {
      case Formats.OpenAI:
        return yield* executeChatStream(attempt);
      case Formats.Claude:
        return yield* executeMessagesStream(attempt);
      case Formats.OpenAIResponse:
        return streamResponsesSse(yield* sendResponses(attempt));
    }
  });

  const countTokens = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    return yield* countTokensOf(yield* resolveAttempt(registry, context, request, options));
  });

  return { identifier: COPILOT_PROVIDER, execute, executeStream, countTokens };
};
