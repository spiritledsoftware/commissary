/**
 * Registrations of every `* -> codex` pair (Go: the init.go of each internal/translator/codex package).
 */
import { Formats } from "../formats.ts";
import type { TranslatorRegistry } from "../registry.ts";
import { convertClaudeRequestToCodex, convertClaudeRequestToResponses } from "./claude/request.ts";
import {
  claudeTokenCount,
  convertCodexResponseToClaude,
  convertCodexResponseToClaudeNonStream,
} from "./claude/response.ts";
import { convertGeminiRequestToCodex } from "./gemini/request.ts";
import {
  convertCodexResponseToGemini,
  convertCodexResponseToGeminiNonStream,
  geminiTokenCount,
} from "./gemini/response.ts";
import { convertInteractionsRequestToCodex } from "./interactions/request.ts";
import {
  convertCodexResponseToInteractions,
  convertCodexResponseToInteractionsNonStream,
} from "./interactions/response.ts";
import {
  convertOpenAIRequestToCodex,
  convertOpenAIRequestToResponses,
} from "./openai-chat/request.ts";
import {
  convertCodexResponseToOpenAI,
  convertCodexResponseToOpenAINonStream,
} from "./openai-chat/response.ts";
import { convertOpenAIResponsesRequestToCodex } from "./openai-responses/request.ts";
import {
  convertCodexResponseToOpenAIResponses,
  convertCodexResponseToOpenAIResponsesNonStream,
} from "./openai-responses/response.ts";

export const registerCodexTranslators = (registry: TranslatorRegistry): TranslatorRegistry =>
  registry
    .register(Formats.OpenAI, Formats.Codex, convertOpenAIRequestToCodex, {
      stream: convertCodexResponseToOpenAI,
      nonStream: convertCodexResponseToOpenAINonStream,
    })
    .register(Formats.Claude, Formats.Codex, convertClaudeRequestToCodex, {
      stream: convertCodexResponseToClaude,
      nonStream: convertCodexResponseToClaudeNonStream,
      tokenCount: claudeTokenCount,
    })
    .register(Formats.Gemini, Formats.Codex, convertGeminiRequestToCodex, {
      stream: convertCodexResponseToGemini,
      nonStream: convertCodexResponseToGeminiNonStream,
      tokenCount: geminiTokenCount,
    })
    .register(Formats.Interactions, Formats.Codex, convertInteractionsRequestToCodex, {
      stream: convertCodexResponseToInteractions,
      nonStream: convertCodexResponseToInteractionsNonStream,
    })
    .register(Formats.OpenAIResponse, Formats.Codex, convertOpenAIResponsesRequestToCodex, {
      stream: convertCodexResponseToOpenAIResponses,
      nonStream: convertCodexResponseToOpenAIResponsesNonStream,
    });

/**
 * Replaces the OpenAI and Claude `-> codex` request transforms (the compat one too) with the standard Responses
 * conversions, without the Codex wire defaults; the response transforms stay. Go: helps/copilot_translation.go
 * (`copilotResponses`, 7ae771fc), the registry only a Copilot Responses attempt uses.
 */
export const registerStandardResponsesRequests = (
  registry: TranslatorRegistry,
): TranslatorRegistry =>
  registry
    .register(Formats.OpenAI, Formats.Codex, convertOpenAIRequestToResponses, {
      stream: convertCodexResponseToOpenAI,
      nonStream: convertCodexResponseToOpenAINonStream,
    })
    .register(Formats.Claude, Formats.Codex, convertClaudeRequestToResponses, {
      stream: convertCodexResponseToClaude,
      nonStream: convertCodexResponseToClaudeNonStream,
      tokenCount: claudeTokenCount,
    })
    .registerCompatRequest(Formats.Claude, Formats.Codex, convertClaudeRequestToResponses);
