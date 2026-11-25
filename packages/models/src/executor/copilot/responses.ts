/**
 * Copilot's Responses route (`/responses`, GPT, Grok and MAI models): OpenAI and Claude clients are converted to
 * standard Responses (`standardResponsesTranslators`: no Codex wire defaults, the client's `temperature` and `top_p`
 * pass through), other clients through the Codex translators; then the shared Responses shaping, always streamed
 * upstream and collected for non-stream clients (`helps/responses-request.ts`, `helps/responses-sse.ts`).
 *
 * Go source: internal/runtime/executor/helps/copilot_translation.go (`CopilotTranslationRegistry`, 7ae771fc),
 * copilot_executor.go (`prepare`).
 */
import { Effect } from "effect";
import { get, isJsonObject, type Json } from "@commissary/json";
import { standardResponsesTranslators, type TranslatorRegistry } from "@commissary/translation";
import { Formats } from "@commissary/translation/formats";
import { prepareResponsesRequest } from "../helps/responses-request.ts";
import type { ResponsesSseInput } from "../helps/responses-sse.ts";
import { checkStreamMode, type CopilotAttempt, seedDefaults, send, str } from "./attempt.ts";
import { copilotResponseError, normalizeCopilotResponses } from "./request.ts";
import { COPILOT_PROVIDER } from "./routes.ts";

const STALL_MESSAGE = "copilot: upstream stream ended before a terminal event";

/** Go's `copilotResponses` registry covers OpenAI and Claude clients; the rest keep the attempt's translators. */
const responsesRegistry = (attempt: CopilotAttempt): TranslatorRegistry =>
  attempt.options.sourceFormat === Formats.OpenAI || attempt.options.sourceFormat === Formats.Claude
    ? standardResponsesTranslators
    : attempt.registry;

/** Responses shaping: translation, the CLI defaults before the thinking pipeline, then Copilot's protocol fixes. */
export const prepareResponses = (attempt: CopilotAttempt, stream: boolean) => {
  const { context, request, options, route } = attempt;

  return prepareResponsesRequest(
    responsesRegistry(attempt),
    context,
    request,
    options,
    {
      provider: COPILOT_PROVIDER,
      payloadProtocol: Formats.OpenAIResponse,
      signatureTargetModel: () => route.model,
      seedDefaults: (body: Json) => {
        // Upstream always streams, so the non-streaming output limit never applies here.
        if (isJsonObject(body)) seedDefaults(attempt, body, true);

        return body;
      },
      prepareTools: (body) => {
        if (!isJsonObject(body)) return body;
        body.model = route.model;
        normalizeCopilotResponses(body, route, options.sourceFormat, request.payload);

        return body;
      },
    },
    stream,
  );
};

export const sendResponses = Effect.fnUntraced(function* (attempt: CopilotAttempt) {
  const prepared = yield* prepareResponses(attempt, true);
  yield* checkStreamMode(prepared.body, true);
  const effort = str(get(prepared.body, "reasoning.effort"));
  attempt.context.usage.setReasoningEffort(effort !== "" ? effort : undefined);
  const response = yield* send(attempt, prepared.body);

  return {
    registry: responsesRegistry(attempt),
    context: attempt.context,
    request: attempt.request,
    options: attempt.options,
    prepared,
    response,
    eventError: (_event, payload) => copilotResponseError(payload),
    stallMessage: STALL_MESSAGE,
  } satisfies ResponsesSseInput;
});
