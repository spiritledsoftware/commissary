/**
 * OpenCode Zen/Go `messages` protocol: Anthropic Messages at `{base}/messages`.
 *
 * Go source (response handling): internal/runtime/executor/claude_executor.go (Execute: non-Claude clients read a
 * streamed answer, `validateClaudeStreamingResponse`), claude_executor_stream.go (ExecuteStream). Per attempt:
 * translate to Claude Messages -> thinking -> `model`/`stream` -> payload rules. The stream goes through the Claude
 * stream reader (`claude/stream.ts`).
 *
 * Deliberate deviation from Go (no OpenCode provider there; see docs/ARCHITECTURE.md "OpenCode Zen and OpenCode
 * Go"): none of the Claude executor's Anthropic-account shaping applies (no cloaking, system prompt injection,
 * tool-name aliasing or thinking replay); the gateway is a plain provider-key Messages endpoint. The `anthropic-beta`
 * header is built by `betas.ts`: the client's betas are forwarded except the identity ones (`claude-code-*`, `oauth-*`,
 * which describe the Claude Code / Anthropic-account client, not the request schema), plus the beta the final body needs
 * (`mid-conversation-output-config-2026-07-01` for a system message with an `output_config`); a configured custom
 * `anthropic-beta` header still wins. A client's `metadata.user_id` (Claude Code puts its device, account and session
 * ids there) is replaced by a stable UUIDv5 of it before the payload rules run, so no raw client identity reaches the
 * gateway.
 */
import { Effect, Stream } from "effect";
import { splitLines } from "@commissary/translation/sse";
import { asString, get, type Json, set, tryParseJson } from "@commissary/json";
import { countClaudeInputTokens } from "@commissary/translation/tokenizer";
import { Formats } from "@commissary/translation/formats";
import { responseModelOf, type UsageDetail } from "../../usage/record.ts";
import { ClaudeStreamReader, validateClaudeStreamingResponse } from "../claude/stream.ts";
import { mergeUsage, parseClaudeStreamUsage, parseClaudeUsage } from "../claude/usage.ts";
import { ensureResponsesUsageDetails } from "../codex/output.ts";
import { setIfDifferent } from "../codex/request.ts";
import { ExecutionError } from "../errors.ts";
import { uuidV5Oid } from "../helps/uuid.ts";
import { TOOL_INPUT_ERROR_MESSAGE } from "../openai-compat/stream.ts";
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
import { messagesBetaHeader } from "./betas.ts";
import { openCodeHeaders } from "./headers.ts";

const PATH = "/messages";

/** `metadata.user_id` replaced by a stable UUIDv5 of its value (same client identity -> same upstream id). */
export const anonymizeMessagesUserId = (body: Json): Json => {
  const userId = get(body, "metadata.user_id");

  if (userId === undefined || userId === null || userId === "") return body;
  const raw = typeof userId === "string" ? userId : JSON.stringify(userId);

  return set(body, "metadata.user_id", uuidV5Oid(`opencode:user:${raw}`));
};

/** The Messages body of an attempt (payload rules applied last). */
export const prepareMessagesBody = Effect.fnUntraced(function* (
  shaping: OpenCodeShaping,
  stream: boolean,
) {
  const translated = yield* translateForOpenCode(shaping, Formats.Claude, stream);
  let body: Json = setIfDifferent(translated.body, "model", shaping.baseModel);
  body = setIfDifferent(body, "stream", stream);
  body = anonymizeMessagesUserId(body);
  const effort = asString(get(body, "output_config.effort"));
  shaping.context.usage.setReasoningEffort(effort !== "" ? effort : undefined);

  return finalizeForOpenCode(shaping, Formats.Claude, translated.original, body);
});

const send = Effect.fnUntraced(function* (attempt: OpenCodeAttempt, stream: boolean) {
  const body = yield* prepareMessagesBody(attempt, stream);

  const headers = openCodeHeaders({
    anthropicBeta: messagesBetaHeader(attempt.options.headers.get("anthropic-beta"), body),
    credential: attempt.context.credential,
    options: attempt.options,
    protocol: "messages",
    providerKey: attempt.providerKey,
    stream,
  });

  const response = yield* postJson(attempt, `${attempt.baseUrl}${PATH}`, headers, body);

  return { body, response };
});

const gatewayError = (message: string) => new ExecutionError({ status: 502, message });

/**
 * Non-stream answer. Claude clients get the upstream JSON; other clients read a streamed answer (the Claude
 * translators expect the event sequence) that is validated and translated in one piece, as Go does.
 */
export const executeMessages = Effect.fnUntraced(function* (attempt: OpenCodeAttempt) {
  const { context, options, registry } = attempt;
  const responseFormat = responseFormatOf(options);
  const upstreamStream = responseFormat !== Formats.Claude;
  const { body, response } = yield* send(attempt, upstreamStream);
  const data = yield* response.text.pipe(Effect.mapError(transportError));
  let usage: UsageDetail | undefined;

  if (upstreamStream) {
    const invalid = validateClaudeStreamingResponse(data);

    if (invalid !== undefined) {
      context.usage.fail(502, invalid);

      return yield* gatewayError(invalid);
    }

    for (const line of data.split("\n")) {
      const parsed = parseClaudeStreamUsage(line);

      if (parsed !== undefined) usage = mergeUsage(usage, parsed);
      const trimmed = line.trim();

      if (trimmed.startsWith("data:"))
        context.usage.observeResponseModel(responseModelOf(tryParseJson(trimmed.slice(5).trim())));
    }
  } else {
    context.usage.observeResponseModel(responseModelOf(tryParseJson(data)));
    usage = parseClaudeUsage(data);
  }

  let out = registry.translateNonStream(
    responseFormat,
    Formats.Claude,
    openCodeResponseContext(attempt, body),
    data,
  );

  if (out === undefined || out === "") return yield* gatewayError(TOOL_INPUT_ERROR_MESSAGE);

  if (usage !== undefined) context.usage.publish(usage);

  if (responseFormat === Formats.OpenAIResponse) out = ensureResponsesUsageDetails(out);

  return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse;
});

export const executeMessagesStream = Effect.fnUntraced(function* (attempt: OpenCodeAttempt) {
  const { context, options, registry } = attempt;
  const { body, response } = yield* send(attempt, true);

  const reader = new ClaudeStreamReader({
    registry,
    responseFormat: responseFormatOf(options),
    context: openCodeResponseContext(attempt, body),
    reverseMap: new Map(),
    onUsage: (detail) => context.usage.publish(detail),
    onResponseModel: (model) => context.usage.observeResponseModel(model),
  });

  const chunks = splitLines(response.stream).pipe(
    Stream.mapError(transportError),
    Stream.mapAccum(
      () => reader,
      (state, line: string) => [state, [state.push(line)]] as const,
      { onHalt: (state) => [state.end()] },
    ),
    Stream.takeUntil((step) => step.stop),
    Stream.flatMap((step) => {
      const emitted = Stream.fromIterable(step.chunks);

      if (step.error === undefined) return emitted;
      const error = step.error;
      context.usage.fail(error.status, error.message);

      return Stream.concat(emitted, Stream.fail(error));
    }),
    Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message))),
  );

  return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
});

/** Local token count of the Messages body (Claude input segments). */
export const countMessagesTokens = Effect.fnUntraced(function* (shaping: OpenCodeShaping) {
  const body = yield* prepareMessagesBody(shaping, false);
  const count = countClaudeInputTokens(body);

  return {
    payload: shaping.registry.translateTokenCount(
      responseFormatOf(shaping.options),
      Formats.Claude,
      count,
      JSON.stringify({ input_tokens: count }),
    ),
    headers: new Headers(),
  } satisfies ExecutorResponse;
});
