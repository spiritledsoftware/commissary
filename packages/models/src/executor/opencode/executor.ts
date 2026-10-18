/**
 * OpenCode Zen (`opencode-zen`) and OpenCode Go (`opencode-go`) executor: one gateway provider key, several upstream
 * protocols chosen per model.
 *
 * Deliberate deviation from Go: CLIProxyAPI has no OpenCode provider (OpenCode is reachable there only as an
 * `openai-compatibility` entry, chat only). See docs/ARCHITECTURE.md "OpenCode Zen and OpenCode Go". Per attempt the
 * model's protocol is resolved (`protocol.ts`: config `protocol`, else the catalog's AI SDK package, else chat) and the
 * client request is translated to it and posted to the gateway:
 *  - `chat` -> `{base}/chat/completions` (`chat.ts`, openai-compat shaping and stream reader),
 *  - `responses` -> `{base}/responses`, always streamed upstream (the Responses shaping and SSE handling shared with
 *    Meta: `helps/responses-request.ts`, `helps/responses-sse.ts`),
 *  - `messages` -> `{base}/messages` (`messages.ts`, Claude stream reader),
 *  - `gemini` (Zen only) -> `{base}/models/{model}:generateContent` (`gemini.ts`, the shared Google engine),
 *  - `systemone` (Zen only, its System One models, ADR 0032) -> `{base}/systemone` (`systemone.ts`), for System One
 *    requests only (`/v1/systemone`, no streaming, no token count).
 * Every request carries the gateway headers (`headers.ts`: per-protocol auth, `x-opencode-session`, client identity);
 * gateway errors that concern one model become model-level cooldowns (`errors.ts`). Token counting is local for every
 * protocol but `systemone` (the gateway has no count endpoint). Not supported: Images/Video/Speech entry formats and
 * `/responses/compact` (501).
 */
import { Effect } from "effect";
import { asString, get } from "@commissary/json";
import { getCodec } from "@commissary/translation/tokenizer";
import { parseSuffix } from "@commissary/translation/thinking";
import { openCodeCatalogFor } from "../../registry/opencode-catalog.ts";
import { builtinTranslators, type TranslatorRegistry } from "@commissary/translation";
import { EntryOnlyFormats, Formats } from "@commissary/translation/formats";
import { notImplemented } from "../errors.ts";
import { prepareResponsesRequest } from "../helps/responses-request.ts";
import {
  collectResponsesSse,
  type ResponsesSseInput,
  streamResponsesSse,
} from "../helps/responses-sse.ts";
import { buildResponsesUsageJson, countCodexInputTokens } from "../helps/token-count.ts";
import type {
  ExecutionContext,
  ExecutorOptions,
  ExecutorRequest,
  ExecutorResponse,
  ProviderExecutor,
} from "../types.ts";
import {
  makeShaping,
  type OpenCodeAttempt,
  type OpenCodeShaping,
  openCodeEndpoint,
  postJson,
} from "./attempt.ts";
import { countChatTokens, executeChat, executeChatStream } from "./chat.ts";
import { openCodeStreamEventError } from "./errors.ts";
import { makeOpenCodeGeminiEngine } from "./gemini.ts";
import { executeOpenCodeSystemOne } from "./systemone.ts";
import { openCodeHeaders } from "./headers.ts";
import { countMessagesTokens, executeMessages, executeMessagesStream } from "./messages.ts";
import { resolveOpenCodeProtocol } from "./protocol.ts";
import { OPENCODE_SPECS, type OpenCodeProvider } from "./providers.ts";

export interface OpenCodeExecutorOptions {
  readonly translators?: TranslatorRegistry;
}

const UNSUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  EntryOnlyFormats.OpenAIImage,
  EntryOnlyFormats.OpenAIVideo,
  EntryOnlyFormats.OpenAISpeech,
  EntryOnlyFormats.CodexAlphaSearch,
]);

export const makeOpenCodeExecutor = (
  provider: OpenCodeProvider,
  executorOptions: OpenCodeExecutorOptions = {},
): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators;
  const name = OPENCODE_SPECS[provider].displayName;
  const gemini = makeOpenCodeGeminiEngine(provider, registry);

  const stallMessage = `${provider} stream error: stream disconnected before response.completed or response.incomplete`;

  const unsupported = (options: ExecutorOptions) => {
    if (UNSUPPORTED_FORMATS.has(options.sourceFormat))
      return Effect.fail(notImplemented(`${name} does not support ${options.sourceFormat}`));

    if (options.alt === "responses/compact")
      return Effect.fail(notImplemented("/responses/compact not supported"));

    return Effect.void;
  };

  /** The protocol of this attempt (a fallback to chat is logged). */
  const resolveAttempt = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    yield* unsupported(options);
    const catalog = yield* openCodeCatalogFor(context.config.models.catalog);

    const resolved = resolveOpenCodeProtocol({
      config: context.config,
      credential: context.credential,
      provider,
      model: request.model,
      catalog,
    });

    if (resolved.warning !== undefined) yield* Effect.logWarning(resolved.warning);

    // System One models serve System One requests only, and those nothing else. The model guard sees to it
    // (`handlers/resolve.ts`); this covers a config `protocol` that disagrees with the registered type.
    const systemOne = options.sourceFormat === EntryOnlyFormats.SystemOne;

    if (systemOne !== (resolved.protocol === "systemone")) {
      const model = parseSuffix(request.model).modelName;

      return yield* notImplemented(
        systemOne
          ? `${name} model ${model} is not a System One model`
          : `${name} model ${model} only serves System One requests (/v1/systemone)`,
      );
    }

    return makeShaping({ provider, registry, context, request, options, resolved });
  });

  const attemptOf = Effect.fnUntraced(function* (shaping: OpenCodeShaping) {
    const endpoint = yield* openCodeEndpoint(shaping.context, provider);

    return { ...shaping, ...endpoint } satisfies OpenCodeAttempt;
  });

  /** Responses: the body always streams upstream; non-stream callers get the aggregated terminal event. */
  const sendResponses = Effect.fnUntraced(function* (attempt: OpenCodeAttempt) {
    const { context, request, options } = attempt;

    const prepared = yield* prepareResponsesRequest(registry, context, request, options, {
      provider,
      payloadProtocol: Formats.OpenAIResponse,
    });

    const effort = asString(get(prepared.body, "reasoning.effort"));
    context.usage.setReasoningEffort(effort !== "" ? effort : undefined);

    const headers = openCodeHeaders({
      credential: context.credential,
      options,
      protocol: "responses",
      providerKey: attempt.providerKey,
      stream: true,
    });

    const response = yield* postJson(
      attempt,
      `${attempt.baseUrl}/responses`,
      headers,
      prepared.body,
    );

    return {
      registry,
      context,
      request,
      options,
      prepared,
      response,
      eventError: openCodeStreamEventError(provider),
      stallMessage,
    } satisfies ResponsesSseInput;
  });

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const shaping = yield* resolveAttempt(context, request, options);

    switch (shaping.resolved.protocol) {
      case "systemone":
        return yield* executeOpenCodeSystemOne(shaping);
      case "gemini":
        return yield* gemini.execute(context, request, options);
      case "responses":
        return yield* collectResponsesSse(yield* sendResponses(yield* attemptOf(shaping)));
      case "messages":
        return yield* executeMessages(yield* attemptOf(shaping));
      case "chat":
        return yield* executeChat(yield* attemptOf(shaping));
    }
  });

  const executeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const shaping = yield* resolveAttempt(context, request, options);

    switch (shaping.resolved.protocol) {
      case "systemone":
        return yield* notImplemented(`${name}: System One requests have no streaming`);
      case "gemini":
        return yield* gemini.executeStream(context, request, options);
      case "responses":
        return streamResponsesSse(yield* sendResponses(yield* attemptOf(shaping)));
      case "messages":
        return yield* executeMessagesStream(yield* attemptOf(shaping));
      case "chat":
        return yield* executeChatStream(yield* attemptOf(shaping));
    }
  });

  /** Local count of the upstream body of the model's protocol (Gemini bodies are counted as chat). */
  const countTokens = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const shaping = yield* resolveAttempt(context, request, options);

    switch (shaping.resolved.protocol) {
      case "responses": {
        const prepared = yield* prepareResponsesRequest(
          registry,
          context,
          request,
          options,
          { provider, payloadProtocol: Formats.OpenAIResponse },
          false,
        );

        const count = countCodexInputTokens(getCodec("o200k_base"), prepared.body);

        return {
          payload: registry.translateTokenCount(
            prepared.responseFormat,
            Formats.Codex,
            count,
            buildResponsesUsageJson(count),
          ),
          headers: new Headers(),
        } satisfies ExecutorResponse;
      }

      case "messages":
        return yield* countMessagesTokens(shaping);
      case "systemone":
        return yield* notImplemented(`${name}: System One requests have no token count`);
      case "gemini":
      case "chat":
        return yield* countChatTokens(shaping);
    }
  });

  return { identifier: provider, execute, executeStream, countTokens };
};
