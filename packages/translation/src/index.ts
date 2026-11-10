/**
 * `@commissary/translation`: request/response translation between the client and provider formats (the
 * `TranslatorRegistry` and its built-in translators), with the thinking pipeline (`./thinking`), thinking signatures
 * (`./signature`), token counting (`./tokenizer`), the format names (`./formats`) and SSE framing (`./sse`) as
 * subpaths. Pure: no Effect services, no Workers APIs; translators are synchronous (the signature store's
 * prefetch/flush are the only async steps, run by executors around a translation).
 *
 * The first block is the translation API; the rest are translator helpers the Worker's executors reuse.
 */

export {
  makeTranslationState,
  noopSummaryHooks,
  type RequestEnvelope,
  type ResponseContext,
  type SummaryHooks,
  TranslationError,
  type TranslationState,
  TranslatorRegistry,
} from "./translator/registry.ts";

export { builtinTranslators } from "./translator/builtin.ts";

export {
  getModelInfoLookup,
  lookupModelInfo,
  setModelInfoLookup,
  withModelInfoLookup,
} from "./translator/model-info.ts";

export { summaryHooks } from "./translator/summary-hooks.ts";

// Translator helpers the executors share.

export {
  stripEmptySignatureThinkingBlocks,
  stripInvalidBypassSignatureThinkingBlocks,
  stripInvalidGeminiSignatureThinkingBlocks,
} from "./translator/antigravity/claude/carrier.ts";

export { thinkingTextsNeedingCachedSignatures } from "./translator/antigravity/claude/request.ts";

export {
  hasAntigravityGoogleSearchTool,
  hasClaudeTypedWebSearchTool,
} from "./translator/antigravity/claude/web-search.ts";

export {
  convertOpenAIResponsesRequestToClaude,
  convertOpenAIResponsesRequestToClaudeWithCompat,
} from "./translator/claude/openai/responses/request.ts";

export { shortenCodexCallIdIfNeeded } from "./translator/codex/claude/request.ts";

export {
  ApplyPatchResponsesBridge,
  normalizeApplyPatchResponsesRequest,
} from "./translator/common/apply-patch-responses.ts";

export { isApplyPatchCustomTool, unwrapApplyPatchInput } from "./translator/common/apply-patch.ts";

export { sseEventData } from "./translator/common/bytes.ts";

export { isClaudeCodeAttributionSystemText } from "./translator/common/claude-messages.ts";

export { geminiClaudeToolUseID, isGeminiClaudeToolUseID } from "./translator/common/claude-util.ts";

export { isArr, isObj, str, toArray } from "./translator/common/gjson.ts";

export { UserRun } from "./translator/common/parts.ts";

export {
  collectResponsesToolWinners,
  qualifyResponsesNamespaceToolName,
  type ResponsesToolDescriptor,
} from "./translator/common/responses-tools.ts";

export { extractResponsesCallID } from "./translator/common/responses.ts";

export {
  hasUnsupportedUnicodePropertyEscape,
  SCHEMA_MAP_KEYWORDS,
  SCHEMA_VALUE_KEYWORDS,
} from "./translator/common/schema.ts";

export {
  mapSanitizedFunctionName,
  sanitizeClaudeToolId,
  sanitizedFunctionNameMap,
} from "./translator/common/tool-names.ts";

export { sanitizeGeminiRequestThoughtSignatures } from "./translator/gemini/common/signature.ts";

export { renameKey } from "./translator/gemini/gemini/gemini.ts";

export {
  REPLAY_CACHE_MAX_ENTRIES,
  REPLAY_CACHE_TTL_MS,
  type ReplayCache,
  replayCacheKey,
  replayItemsAcceptable,
  withReplayCache,
} from "./translator/gemini/openai/responses/replay-cache.ts";

export { responsesToolReverseIdentityMap } from "./translator/gemini/openai/responses/tools.ts";

export { textSignatureKeys } from "./translator/gemini/openai/responses/trailing-signature.ts";

export { hasResponsesWebSearchTool } from "./translator/gemini/openai/responses/web-search.ts";

export {
  cleanJsonSchemaForAntigravityResponse,
  cleanJsonSchemaForAntigravityTool,
} from "./translator/gemini/util/json-schema.ts";
