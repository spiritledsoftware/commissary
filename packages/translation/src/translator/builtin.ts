/**
 * Built-in translator registrations (Go: internal/translator/init.go imports every pair's `init.go`).
 * Provider slices add their pairs here.
 */
import { registerAntigravityTranslators } from "./antigravity/register.ts";
import { registerClaudeTranslators } from "./claude/register.ts";
import { Formats } from "./formats.ts";
import { registerGeminiTranslators } from "./gemini/register.ts";
import {
  convertOpenAIRequestToOpenAI,
  openAIToOpenAIResponse,
} from "./openai/openai/chat-completions.ts";
import { registerInteractionsTranslators } from "./interactions/register.ts";
import { registerOpenAICompatTranslators } from "./openai/register.ts";
import { TranslatorRegistry } from "./registry.ts";
import { registerCodexTranslators, registerStandardResponsesRequests } from "./codex/register.ts";
import { convertClaudeRequestToCodexWithCompat } from "./codex/claude/request.ts";
import { convertOpenAIRequestToClaudeWithCompat } from "./claude/openai/chat-completions/request.ts";
import { convertOpenAIResponsesRequestToClaudeWithCompat } from "./claude/openai/responses/request.ts";
import { convertClaudeRequestToGeminiWithCompat } from "./gemini/claude/request.ts";
import { convertClaudeRequestToInteractionsWithCompat } from "./interactions/claude/request.ts";
import { convertClaudeRequestToOpenAIWithCompat } from "./openai/claude/request.ts";

/**
 * The `is-compat` request variants Go selects in `helps.translateRequestWithAPIKeyModelCompatibilityForExecutor`
 * (assistant thinking blocks survive for compatibility endpoints). Pairs without an entry use the normal transform.
 */
const registerCompatRequests = (registry: TranslatorRegistry): TranslatorRegistry =>
  registry
    .registerCompatRequest(Formats.Claude, Formats.Codex, convertClaudeRequestToCodexWithCompat)
    .registerCompatRequest(Formats.Claude, Formats.Gemini, convertClaudeRequestToGeminiWithCompat)
    .registerCompatRequest(
      Formats.Claude,
      Formats.Interactions,
      convertClaudeRequestToInteractionsWithCompat,
    )
    .registerCompatRequest(Formats.Claude, Formats.OpenAI, convertClaudeRequestToOpenAIWithCompat)
    .registerCompatRequest(Formats.OpenAI, Formats.Claude, convertOpenAIRequestToClaudeWithCompat)
    .registerCompatRequest(
      Formats.OpenAIResponse,
      Formats.Claude,
      convertOpenAIResponsesRequestToClaudeWithCompat,
    );

/** Registers every built-in pair on `registry`. */
export const registerBuiltinTranslators = (registry: TranslatorRegistry): TranslatorRegistry => {
  registry.register(
    Formats.OpenAI,
    Formats.OpenAI,
    convertOpenAIRequestToOpenAI,
    openAIToOpenAIResponse,
  );
  registerCodexTranslators(registry);
  registerClaudeTranslators(registry);
  registerGeminiTranslators(registry);
  registerInteractionsTranslators(registry);
  registerOpenAICompatTranslators(registry);
  registerAntigravityTranslators(registry);
  registerCompatRequests(registry);

  return registry;
};

/** Process-wide registry populated with the built-in translators (immutable after module load). */
export const builtinTranslators: TranslatorRegistry = registerBuiltinTranslators(
  new TranslatorRegistry(),
);

/**
 * The built-in translators with OpenAI and Claude clients converted to standard Responses rather than the Codex wire
 * (no default `reasoning.effort`, `include` or `store`; `temperature` and `top_p` pass through). Only the GitHub
 * Copilot executor's Responses route uses it (Go: helps/copilot_translation.go, `CopilotTranslationRegistry`).
 */
export const standardResponsesTranslators: TranslatorRegistry = registerStandardResponsesRequests(
  registerBuiltinTranslators(new TranslatorRegistry()),
);
