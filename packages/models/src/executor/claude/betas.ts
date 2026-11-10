/**
 * `anthropic-beta` assembly.
 *
 * Go source: internal/runtime/executor/claude_executor_request.go (claudeCodeCLIBetas, claudeCountTokensBetasForCredential,
 * with*Beta helpers, isManagedClaudeBeta, claudeRequestedBetas, extractAndRemoveBetas).
 */
import { get, type Json, type JsonObject } from "@commissary/json";
import { isArr, isObj, str, toArray } from "@commissary/translation";
import { payloadHas1hTTL } from "./cache-control.ts";
import {
  hasPerTurnEffort,
  hasPerTurnTiming,
  isHaiku55Model,
  isHaikuModel,
  isProbeOrHelperRequest,
  isQuotaProbeRequest,
  isSonnet5Model,
  isSubagentRequest,
  usesLegacySystemReminder,
  usesProgressDisplay,
} from "./classify.ts";

export const BETA = {
  tokenCounting: "token-counting-2024-11-01",
  fastMode: "fast-mode-2026-02-01",
  oauth: "oauth-2025-04-20",
  claudeCode: "claude-code-20250219",
  context1M: "context-1m-2025-08-07",
  midConvSystem: "mid-conversation-system-2026-04-07",
  perTurnControl: "per-turn-control-2026-07-01",
  perTurnTiming: "timing-2026-09-09",
  midConvToolChanges: "mid-conversation-tool-changes-2026-07-01",
  inlineTools: "inline-tools-2026-09-15",
  midConvSystemClearAt: "mid-conversation-system-clear-at-2026-08-21",
  dangerousToolUse: "dangerous-tool-use-2026-09-03",
  advisorTool: "advisor-tool-2026-03-01",
  advancedToolUse: "advanced-tool-use-2025-11-20",
  effort: "effort-2025-11-24",
  serverSideFallback: "server-side-fallback-2026-06-01",
  fallbackCredit: "fallback-credit-2026-06-01",
  structuredOutputs: "structured-outputs-2025-12-15",
  thinkingDisplayUpdates: "thinking-display-updates-2026-08-18",
  thinkingBinding: "thinking-binding-controls-2026-08-01",
  thinkingResumption: "thinking-resumption-2026-07-17",
  extendedCacheTTL: "extended-cache-ttl-2025-04-11",
  promptCachingEvict: "prompt-caching-evict-2026-05-12",
  cacheDiagnosis: "cache-diagnosis-2026-04-07",
  redactThinking: "redact-thinking-2026-02-12",
  afkMode: "afk-mode-2026-01-31",
  thinkingTokenCount: "thinking-token-count-2026-05-13",
  messageThreads: "message-threads-2026-08-12",
} as const;

const CONSTANT_BETAS: readonly string[] = [
  "interleaved-thinking-2025-05-14",
  BETA.redactThinking,
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
];

const TRAILING_BETAS: readonly string[] = [
  BETA.serverSideFallback,
  BETA.fallbackCredit,
  BETA.structuredOutputs,
];

const MANAGED = new Set<string>([...Object.values(BETA), ...CONSTANT_BETAS, ...TRAILING_BETAS]);

/** `isManagedClaudeBeta`: betas Commissary assembles itself (dropped from callers on first-party upstreams). */
export const isManagedBeta = (beta: string): boolean => MANAGED.has(beta.trim());

/** `claudeRequestedBetas`: caller header betas plus body `betas`. */
export const requestedBetas = (incoming: string, extra: readonly string[]): Set<string> => {
  const requested = new Set<string>();

  for (const beta of incoming.split(",")) if (beta.trim() !== "") requested.add(beta.trim());

  for (const beta of extra) if (beta.trim() !== "") requested.add(beta.trim());

  return requested;
};

/** `extractAndRemoveBetas`: lifts the body `betas` field. */
export const extractAndRemoveBetas = (body: JsonObject): string[] => {
  if (!Object.hasOwn(body, "betas")) return [];
  const betas = body.betas;
  const out: string[] = [];

  if (isArr(betas)) {
    for (const item of betas) if (str(item).trim() !== "") out.push(str(item).trim());
  } else if (str(betas).trim() !== "") {
    out.push(str(betas).trim());
  }

  delete body.betas;

  return out;
};

const thinkingDisplaySet = (body: JsonObject): boolean => {
  const display = get(body, "thinking.display");

  return typeof display === "string" && display.trim() !== "";
};

const includePerTurnTiming = (body: JsonObject, requested: Set<string>): boolean => {
  if (requested.has(BETA.perTurnTiming)) return true;

  if (!hasPerTurnTiming(str(body.model))) return false;

  if (get(body, "output_config.timing") !== undefined) return true;

  return toArray(body.messages).some(
    (message) => get(message, "output_config.timing") !== undefined,
  );
};

const includeInlineTools = (body: JsonObject, requested: Set<string>): boolean => {
  if (requested.has(BETA.inlineTools)) return true;

  return toArray(body.messages).some((message) =>
    toArray(get(message, "content")).some(
      (block) =>
        str(get(block, "type")).trim().toLowerCase() === "tool_addition" &&
        get(block, "tool.definition") !== undefined,
    ),
  );
};

const includeMidConvClearAt = (body: JsonObject, requested: Set<string>): boolean =>
  requested.has(BETA.midConvSystemClearAt) ||
  usesProgressDisplay(str(body.model)) ||
  toArray(body.messages).some((message) => get(message, "clear_at") !== undefined);

/** `claudeRequestSupportsEffort`. */
export const requestSupportsEffort = (body: JsonObject | undefined): boolean => {
  if (body === undefined || Object.keys(body).length === 0) return true;

  if (isProbeOrHelperRequest(body)) return false;
  const model = str(body.model).trim();

  // Haiku 5.5 is the first Haiku that Claude Code 2.1.321 sends effort for.
  if (isHaikuModel(model) && !isHaiku55Model(model)) return false;

  return str(get(body, "thinking.type")).trim().toLowerCase() !== "disabled";
};

const thinkingDisplayUpdates = (body: JsonObject): boolean => {
  const display = get(body, "thinking.display");

  return typeof display === "string" && display.trim().toLowerCase() === "updates";
};

const toolTypeOf = (tool: Json): string => str(get(tool, "type")).trim().toLowerCase();

const usesAdvancedToolUse = (body: JsonObject): boolean =>
  isArr(body.tools) &&
  body.tools.some(
    (tool) =>
      toolTypeOf(tool).startsWith("tool_search_tool_") ||
      get(tool, "defer_loading") === true ||
      get(tool, "input_examples") !== undefined ||
      get(tool, "allowed_callers") !== undefined,
  );

export const hasAdvisorTool = (body: JsonObject): boolean =>
  isArr(body.tools) && body.tools.some((tool) => toolTypeOf(tool).startsWith("advisor_"));

const usesFastMode = (body: JsonObject, requested: Set<string>): boolean =>
  requested.has(BETA.fastMode) || str(body.speed).trim().toLowerCase() === "fast";

/**
 * `claudeCodeCLIBetas`, as Claude Code 2.1.321 assembles it (measured upstream 2026-11-09): mid-conversation-system
 * only when requested, thinking-token-count after advisor-tool and never on quota probes, effort ahead of
 * dangerous-tool-use, claude-code after prompt-caching-scope on Haiku 5.5 and absent from quota probes, and
 * message-threads for bodies carrying a `thread` object.
 */
export const claudeCodeCLIBetas = (
  body: JsonObject,
  requested: Set<string>,
  oauthToken: boolean,
): string => {
  const betas: string[] = [];
  const model = str(body.model);
  const quotaProbe = isQuotaProbeRequest(body);
  const claudeCodeAfterScope = isHaiku55Model(model);

  if (!quotaProbe && !claudeCodeAfterScope) betas.push(BETA.claudeCode);

  if (oauthToken) betas.push(BETA.oauth);

  if (requested.has(BETA.context1M)) betas.push(BETA.context1M);
  const redactThinking = !thinkingDisplaySet(body);

  for (const beta of CONSTANT_BETAS) {
    if (beta === BETA.redactThinking && !redactThinking) continue;
    betas.push(beta);
  }

  if (!quotaProbe && claudeCodeAfterScope) betas.push(BETA.claudeCode);

  const perTurnControl = requested.has(BETA.perTurnControl) || hasPerTurnEffort(model);

  if (!usesLegacySystemReminder(body)) {
    if (requested.has(BETA.midConvSystem)) betas.push(BETA.midConvSystem);

    if (perTurnControl) betas.push(BETA.perTurnControl);

    if (includePerTurnTiming(body, requested)) betas.push(BETA.perTurnTiming);

    if (!isSonnet5Model(model)) betas.push(BETA.midConvToolChanges);

    if (includeInlineTools(body, requested)) betas.push(BETA.inlineTools);
  } else {
    if (perTurnControl) betas.push(BETA.perTurnControl);

    if (includePerTurnTiming(body, requested)) betas.push(BETA.perTurnTiming);
  }

  if (requested.has(BETA.advisorTool) || hasAdvisorTool(body)) betas.push(BETA.advisorTool);

  if (!quotaProbe || requested.has(BETA.thinkingTokenCount)) betas.push(BETA.thinkingTokenCount);

  if (requested.has(BETA.advancedToolUse) || usesAdvancedToolUse(body))
    betas.push(BETA.advancedToolUse);

  if (!usesLegacySystemReminder(body) && includeMidConvClearAt(body, requested))
    betas.push(BETA.midConvSystemClearAt);

  if (requestSupportsEffort(body)) betas.push(BETA.effort);

  if (requested.has(BETA.dangerousToolUse) || get(body, "safeguards") !== undefined)
    betas.push(BETA.dangerousToolUse);
  const probeOrHelper = isProbeOrHelperRequest(body);

  if (
    !probeOrHelper &&
    (requested.has(BETA.serverSideFallback) || get(body, "fallbacks") !== undefined)
  ) {
    betas.push(BETA.serverSideFallback);
  }

  if (
    requested.has(BETA.fallbackCredit) ||
    get(body, "fallback_credit_token") !== undefined ||
    (oauthToken && get(body, "fallbacks") !== undefined)
  ) {
    betas.push(BETA.fallbackCredit);
  }

  for (const beta of TRAILING_BETAS) {
    if (beta === BETA.serverSideFallback || beta === BETA.fallbackCredit) continue;

    if (requested.has(beta)) betas.push(beta);
  }

  const thinkingType = str(get(body, "thinking.type"));

  // Cloaked bodies get the beta here; `headers.ts` (`withThinkingBindingBeta`) is the authority for it in every mode.
  if (
    requested.has(BETA.thinkingBinding) ||
    get(body, "thinking.block_binding") !== undefined ||
    (usesProgressDisplay(model) && thinkingType === "adaptive")
  ) {
    betas.push(BETA.thinkingBinding);
  }

  if (
    !probeOrHelper &&
    thinkingType !== "disabled" &&
    (requested.has(BETA.thinkingDisplayUpdates) || thinkingDisplayUpdates(body))
  ) {
    betas.push(BETA.thinkingDisplayUpdates);
  }

  if (requested.has(BETA.thinkingResumption)) betas.push(BETA.thinkingResumption);

  if (usesFastMode(body, requested)) betas.push(BETA.fastMode);

  if (requested.has(BETA.afkMode)) betas.push(BETA.afkMode);

  if (!probeOrHelper) {
    const includeExtended =
      (oauthToken && !isSubagentRequest(undefined, body)) ||
      requested.has(BETA.extendedCacheTTL) ||
      payloadHas1hTTL(body);

    if (includeExtended) betas.push(BETA.extendedCacheTTL);
  }

  if (
    requested.has(BETA.promptCachingEvict) ||
    JSON.stringify(body).includes('"evict_on_complete"')
  ) {
    betas.push(BETA.promptCachingEvict);
  }

  if (isObj(body.diagnostics)) betas.push(BETA.cacheDiagnosis);

  if (requested.has(BETA.messageThreads) || isObj(body.thread)) betas.push(BETA.messageThreads);

  return betas.join(",");
};

/** `claudeCountTokensBetasForCredential`. */
export const countTokensBetas = (oauthToken: boolean): string => {
  const betas: string[] = [BETA.claudeCode];

  if (oauthToken) betas.push(BETA.oauth);
  betas.push(
    "interleaved-thinking-2025-05-14",
    "context-management-2025-06-27",
    BETA.tokenCounting,
  );

  return betas.join(",");
};

const splitBetas = (betas: string): string[] => {
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const beta of betas.split(",")) {
    const trimmedBeta = beta.trim();

    if (trimmedBeta !== "" && !seen.has(trimmedBeta)) {
      parts.push(trimmedBeta);
      seen.add(trimmedBeta);
    }
  }

  return parts;
};

const insertOAuth = (parts: string[]): void => {
  if (parts.includes(BETA.oauth)) return;
  parts.splice(parts[0] === BETA.claudeCode ? 1 : 0, 0, BETA.oauth);
};

/** `withClaudeCountTokensOAuthBeta`. */
export const withCountTokensOAuthBeta = (betas: string): string => {
  const parts = splitBetas(betas);
  insertOAuth(parts);

  return parts.join(",");
};

/** `withClaudeOAuthCredentialBetas`. */
export const withOAuthCredentialBetas = (
  betas: string,
  includeExtendedCacheTTL: boolean,
): string => {
  const parts = splitBetas(betas);
  insertOAuth(parts);

  if (includeExtendedCacheTTL && !parts.includes(BETA.extendedCacheTTL))
    parts.push(BETA.extendedCacheTTL);

  return parts.join(",");
};

export const withoutBeta = (betas: string, remove: string): string =>
  betas
    .split(",")
    .map((beta) => beta.trim())
    .filter((beta) => beta !== "" && beta !== remove)
    .join(",");

/** `withClaudeBetaAppended`: `beta` appended to the comma-separated list unless it is already there. */
const withBetaAppended = (betas: string, beta: string): string => {
  const parts = splitBetas(betas);

  if (!parts.includes(beta)) parts.push(beta);

  return parts.join(",");
};

export const withExtendedCacheTTLBeta = (betas: string): string =>
  withBetaAppended(betas, BETA.extendedCacheTTL);

/** The binding beta for a body carrying `thinking.block_binding`; `headers.ts` applies it in every fingerprint mode. */
export const withThinkingBindingBeta = (betas: string): string =>
  withBetaAppended(betas, BETA.thinkingBinding);

const ADVISOR_BEFORE = new Set<string>([
  BETA.advancedToolUse,
  BETA.effort,
  BETA.serverSideFallback,
  BETA.fallbackCredit,
  BETA.structuredOutputs,
  BETA.fastMode,
  BETA.afkMode,
  BETA.extendedCacheTTL,
  BETA.cacheDiagnosis,
]);

/** `withClaudeAdvisorToolBeta`. */
export const withAdvisorToolBeta = (betas: string): string => {
  if (betas.trim() === "") return BETA.advisorTool;
  const parts = splitBetas(betas).filter((beta) => beta !== BETA.advisorTool);
  let insertAt = parts.findIndex((beta) => ADVISOR_BEFORE.has(beta));

  if (insertAt < 0) insertAt = parts.length;
  parts.splice(insertAt, 0, BETA.advisorTool);

  return parts.join(",");
};
