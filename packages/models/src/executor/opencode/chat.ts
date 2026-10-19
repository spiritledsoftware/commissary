/**
 * OpenCode Zen/Go `chat` protocol: OpenAI Chat Completions at `{base}/chat/completions`.
 *
 * Go source (shaping and response handling): internal/runtime/executor/openai_compat_executor.go (Execute,
 * ExecuteStream, CountTokens). Per attempt: translate to Chat Completions -> thinking -> max-token field normalisation
 * (`use-max-completion-tokens` of the config model entry) -> `stream_options.include_usage` (stream) -> payload rules.
 * The stream goes through the openai-compat stream reader (`openai-compat/stream.ts`).
 *
 * A cloaked attempt (OpenCode Zen free tier, `cloak.ts`, ADR 0033) adds the stub `read` tool before the payload rules,
 * always streams upstream (a non-stream client gets the stream collected by `chat-collect.ts`), and drops the model's
 * calls to the stub from the answer.
 *
 * Deliberate deviation from Go (no OpenCode provider there): the openai-compat executor itself is not reused because
 * it reads its settings from the `openai-compatibility` group of the credential (`resolveCompatConfig`) and sends its
 * own User-Agent; no `prompt_cache_key` is derived (the gateway keys caching on `x-opencode-session`). See
 * docs/ARCHITECTURE.md "OpenCode Zen and OpenCode Go".
 */
import { Effect, Stream } from "effect";
import { splitLines } from "@commissary/translation/sse";
import { get, tryParseJson } from "@commissary/json";
import { encodingForModel, getCodec } from "@commissary/translation/tokenizer";
import { Formats } from "@commissary/translation/formats";
import {
  parseOpenAIStreamUsage,
  parseOpenAIUsage,
  responseModelOf,
  ssePayloadObject,
} from "../../usage/record.ts";
import { ensureResponsesUsageDetails } from "../codex/output.ts";
import { ExecutionError } from "../errors.ts";
import { normalizeOpenAIMaxTokens, setBoolIfDifferent } from "../helps/openai-compat-models.ts";
import { buildOpenAIUsageJson, countOpenAIChatTokens } from "../helps/token-count.ts";
import { OpenAICompatStreamReader, TOOL_INPUT_ERROR_MESSAGE } from "../openai-compat/stream.ts";
import { type ExecutorResponse, responseFormatOf, type StreamResult } from "../types.ts";
import {
  finalizeForOpenCode,
  type OpenCodeAttempt,
  type OpenCodeShaping,
  openCodeResponseContext,
  postJson,
  transportError,
  translateForOpenCode,
} from "./attempt.ts";
import { collectChatStream } from "./chat-collect.ts";
import { cloakChatBody, removeStubCalls, StubCallFilter } from "./cloak.ts";
import { openCodeHeaders } from "./headers.ts";

const PATH = "/chat/completions";

/**
 * The Chat Completions body of an attempt (payload rules applied last), and whether the cloak injected the stub `read`
 * tool (decided before the payload rules, which may rewrite the tools).
 */
export const prepareChatBody = Effect.fnUntraced(function* (
  shaping: OpenCodeShaping,
  stream: boolean,
  forCount = false,
) {
  const translated = yield* translateForOpenCode(shaping, Formats.OpenAI, stream);
  let body = translated.body;
  let stubInjected = false;

  if (!forCount) {
    body = normalizeOpenAIMaxTokens(
      body,
      shaping.resolved.entry?.["use-max-completion-tokens"] === true,
    );

    // Ask for usage in the final chunk so token statistics are captured.
    if (stream) body = setBoolIfDifferent(body, "stream_options.include_usage", true);

    if (shaping.cloaked) ({ body, stubInjected } = cloakChatBody(body));

    const effort = get(body, "reasoning_effort");
    shaping.context.usage.setReasoningEffort(typeof effort === "string" ? effort : undefined);
  }

  return {
    body: finalizeForOpenCode(shaping, Formats.OpenAI, translated.original, body),
    stubInjected,
  };
});

const send = Effect.fnUntraced(function* (attempt: OpenCodeAttempt, stream: boolean) {
  const { body, stubInjected } = yield* prepareChatBody(attempt, stream);

  const headers = openCodeHeaders({
    credential: attempt.context.credential,
    options: attempt.options,
    protocol: "chat",
    providerKey: attempt.providerKey,
    stream,
    cloaked: attempt.cloaked,
  });

  const response = yield* postJson(attempt, `${attempt.baseUrl}${PATH}`, headers, body);

  return { body, response, stubInjected };
});

export const executeChat = Effect.fnUntraced(function* (attempt: OpenCodeAttempt) {
  const { context, options, registry } = attempt;
  const responseFormat = responseFormatOf(options);
  const { body, response, stubInjected } = yield* send(attempt, options.stream || attempt.cloaked);

  let text = yield* response.text.pipe(Effect.mapError(transportError));

  if (attempt.cloaked) {
    const collected = collectChatStream(text);

    if ("error" in collected) {
      context.usage.fail(collected.error.status, collected.error.message);

      return yield* collected.error;
    }

    text = stubInjected
      ? JSON.stringify(removeStubCalls(tryParseJson(collected.text) ?? null))
      : collected.text;
  }

  context.usage.observeResponseModel(responseModelOf(tryParseJson(text)));

  const out = registry.translateNonStream(
    responseFormat,
    Formats.OpenAI,
    openCodeResponseContext(attempt, body),
    text,
  );

  if (out === undefined || out === "") {
    return yield* new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE });
  }

  context.usage.publish(parseOpenAIUsage(text));

  const payload =
    responseFormat === Formats.OpenAIResponse ? ensureResponsesUsageDetails(out) : out;

  return { payload, headers: new Headers(response.headers) } satisfies ExecutorResponse;
});

export const executeChatStream = Effect.fnUntraced(function* (attempt: OpenCodeAttempt) {
  const { context, options, registry } = attempt;
  const { body, response, stubInjected } = yield* send(attempt, true);

  const reader = new OpenAICompatStreamReader({
    registry,
    responseFormat: responseFormatOf(options),
    providerFormat: Formats.OpenAI,
    context: openCodeResponseContext(attempt, body),
  });

  const filter = stubInjected ? new StubCallFilter() : undefined;

  const observe = (line: string) => {
    const usage = parseOpenAIStreamUsage(line);

    if (usage !== undefined) context.usage.publish(usage);
    context.usage.observeResponseModel(responseModelOf(ssePayloadObject(line)));
  };

  const chunks = splitLines(response.stream).pipe(
    Stream.mapError(transportError),
    Stream.mapAccum(
      () => reader,
      (state, upstream: string) => {
        const line = filter === undefined ? upstream : filter.push(upstream);
        observe(line);

        return [state, [state.push(line)]] as const;
      },
      { onHalt: (state) => [state.end()] },
    ),
    Stream.takeUntil((step) => step.stop),
    Stream.flatMap((step) => {
      const emitted = Stream.fromIterable(step.chunks);

      if (step.error === undefined) return emitted;
      const error = step.error;
      context.usage.fail(
        error.status,
        step.payloadError === true ? "upstream stream returned an error payload" : error.message,
      );

      return Stream.concat(emitted, Stream.fail(error));
    }),
    Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message))),
  );

  return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
});

/** Local token count of the Chat Completions body with the model's BPE encoding. */
export const countChatTokens = Effect.fnUntraced(function* (shaping: OpenCodeShaping) {
  const { body } = yield* prepareChatBody(shaping, false, true);
  const count = countOpenAIChatTokens(getCodec(encodingForModel(shaping.baseModel)), body);

  return {
    payload: shaping.registry.translateTokenCount(
      responseFormatOf(shaping.options),
      Formats.OpenAI,
      count,
      buildOpenAIUsageJson(count),
    ),
    headers: new Headers(),
  } satisfies ExecutorResponse;
});
