/**
 * Registrations of the Antigravity translator pairs.
 *
 * Go source: the `init.go` files under internal/translator/antigravity/*.
 */
import { Formats } from "../formats.ts";
import type { TranslatorRegistry } from "../registry.ts";
import { convertClaudeRequestToAntigravity } from "./claude/request.ts";
import { antigravityToClaudeResponse } from "./claude/response.ts";
import { convertInteractionsRequestToAntigravity } from "./interactions/request.ts";
import { antigravityToInteractionsResponse } from "./interactions/response.ts";
import { convertGeminiRequestToAntigravity } from "./gemini/request.ts";
import { antigravityToGeminiResponse } from "./gemini/response.ts";
import { convertOpenAIRequestEnvelopeToAntigravity } from "./openai/chat-request.ts";
import { antigravityToOpenAIResponse } from "./openai/chat-response.ts";
import { convertOpenAIResponsesRequestEnvelopeToAntigravity } from "./openai/responses-request.ts";
import { antigravityToOpenAIResponsesResponse } from "./openai/responses-response.ts";

export const registerAntigravityTranslators = (registry: TranslatorRegistry): TranslatorRegistry =>
  registry
    .register(
      Formats.Gemini,
      Formats.Antigravity,
      convertGeminiRequestToAntigravity,
      antigravityToGeminiResponse,
    )
    .register(
      Formats.Claude,
      Formats.Antigravity,
      convertClaudeRequestToAntigravity,
      antigravityToClaudeResponse,
    )
    .register(
      Formats.Interactions,
      Formats.Antigravity,
      convertInteractionsRequestToAntigravity,
      antigravityToInteractionsResponse,
    )
    .register(Formats.OpenAI, Formats.Antigravity, undefined, antigravityToOpenAIResponse)
    .registerRequestEnvelope(
      Formats.OpenAI,
      Formats.Antigravity,
      convertOpenAIRequestEnvelopeToAntigravity,
    )
    .register(
      Formats.OpenAIResponse,
      Formats.Antigravity,
      undefined,
      antigravityToOpenAIResponsesResponse,
    )
    .registerRequestEnvelope(
      Formats.OpenAIResponse,
      Formats.Antigravity,
      convertOpenAIResponsesRequestEnvelopeToAntigravity,
    );
