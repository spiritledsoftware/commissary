/**
 * Request classification helpers: Claude Code client detection, probe/helper/subagent requests, model families.
 *
 * Go source: internal/runtime/executor/helps/claude_client_detection.go (DetectClaudeCodeRequest, simplified: the
 * measured Haiku "helper profile" shapes are not ported, so `ConfirmedShape` is the strong signals alone),
 * helps/claude_device_profile.go (plausibleClaude*Version), helps/claude_diagnostics.go (IsClaudeProbeOrHelperRequest,
 * IsClaudeQuotaProbeRequest, IsClaudeSubagentRequest, ClaudeSubagentRequests1h, IsClaudeNewPromptTurn,
 * ExtractClaudeBillingTags),
 * claude_executor_request.go / claude_executor_cloaking.go (model family predicates).
 */
import { get, isJsonObject, tryParseJson, type Json, type JsonObject } from "@commissary/json";
import { isArr, isObj, str, toArray } from "@commissary/translation";
import { payloadHas1hTTL } from "./cache-control.ts";
import {
  PACKAGE_VERSION,
  parseClaudeCodeUserAgent,
  parseCliVersion,
  parseSemver,
  RUNTIME_VERSION,
  compareVersions,
  type Version,
} from "./user-agent.ts";

export const DEFAULT_USER_AGENT = "claude-cli/2.1.321 (external, cli)";

export const headerValue = (headers: Headers | undefined, name: string): string =>
  headers?.get(name)?.trim() ?? "";

/**
 * Only product surfaces with verified wire behaviour pass through by default; any other first-party-looking
 * entrypoint is cloaked until it is allowlisted in `header-defaults.native-entrypoints`.
 */
const NATIVE_ENTRYPOINTS = new Set(["cli", "sdk-cli", "sdk-ts", "claude-vscode"]);

/** `isNativeClaudeEntrypoint`: the built-in set plus the configured labels (compared case-insensitively). */
export const isNativeEntrypoint = (
  entrypoint: string,
  nativeEntrypoints: readonly string[] = [],
): boolean => {
  const label = entrypoint.trim().toLowerCase();

  if (label === "") return false;

  return (
    NATIVE_ENTRYPOINTS.has(label) ||
    nativeEntrypoints.some((candidate) => candidate.trim().toLowerCase() === label)
  );
};

/** `isNativeClaudeXApp`: `cli-bg` is a Claude Code background session. */
const isNativeXApp = (value: string): boolean => value === "cli" || value === "cli-bg";

/** Claude Code CLI version used in the billing header (`DefaultClaudeVersion`). */
export const defaultClaudeVersion = (userAgent: string): string => {
  const version = parseCliVersion(userAgent) ?? parseCliVersion(DEFAULT_USER_AGENT);

  return (version ?? [2, 1, 321]).join(".");
};

/** `plausibleClaudeCLIVersion`: the baseline is a floor for patch releases of its major.minor line. */
const plausibleCliVersion = (candidate: Version, baseline: Version): boolean =>
  candidate[0] === baseline[0] && candidate[1] === baseline[1] && candidate[2] >= baseline[2];

/** `plausibleClaudeCodeUserAgent`: a well-formed UA with the baseline's major.minor and a patch >= baseline. */
export const plausibleClaudeCodeUserAgent = (
  userAgent: string,
  baselineUserAgent: string,
): boolean => {
  const parsed = parseClaudeCodeUserAgent(userAgent);
  const baseline = parseCliVersion(baselineUserAgent);

  return (
    parsed !== undefined && baseline !== undefined && plausibleCliVersion(parsed.version, baseline)
  );
};

/** `plausibleClaudePackageVersion`: a Stainless package version at or above the baseline. */
export const plausiblePackageVersion = (candidate: string, baseline: string): boolean => {
  const value = candidate.trim();

  if (!PACKAGE_VERSION.test(value)) return false;
  const parsed = parseSemver(value);
  const base = parseSemver(baseline);

  return parsed === undefined || base === undefined
    ? value === baseline.trim()
    : compareVersions(parsed, base) >= 0;
};

/** `plausibleClaudeRuntimeVersion`: a Stainless runtime version (`v26.12.1`) at or above the baseline. */
export const plausibleRuntimeVersion = (candidate: string, baseline: string): boolean => {
  const value = candidate.trim();

  if (!RUNTIME_VERSION.test(value)) return false;
  const parsed = parseSemver(value.slice(1));
  const base = parseSemver(baseline.trim().replace(/^v/, ""));

  return parsed === undefined || base === undefined
    ? value === baseline.trim()
    : compareVersions(parsed, base) >= 0;
};

const HEX64 = /^[0-9a-f]{64}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `isValidUserID`: JSON `{device_id: 64 hex, account_uuid: ""|uuid, session_id: uuid}`. */
export const isValidUserID = (userID: string): boolean => {
  const value = tryParseJson(userID);

  if (!isObj(value)) return false;

  if (!HEX64.test(str(value.device_id))) return false;

  if (!UUID.test(str(value.session_id))) return false;
  const account = str(value.account_uuid);

  return account === "" || UUID.test(account);
};

export interface ClaudeCodeDetection {
  /** The strong signals hold and the entrypoint is native. */
  readonly confirmed: boolean;
  /**
   * The strong signals hold, whatever the entrypoint: under `cloak_mode: never` such a caller keeps its own headers
   * (`isEffectiveConfirmedClaudeCode`).
   */
  readonly strongSignals: boolean;
  readonly nativeClient: boolean;
  readonly entrypoint: string;
}

/** `DetectClaudeCodeRequest` without the measured helper profiles. */
export const detectClaudeCodeRequest = (
  headers: Headers | undefined,
  payload: Json | undefined,
  countTokens: boolean,
  baselineUserAgent: string = DEFAULT_USER_AGENT,
  nativeEntrypoints: readonly string[] = [],
): ClaudeCodeDetection => {
  const userAgent = parseClaudeCodeUserAgent(headerValue(headers, "user-agent"));
  const entrypoint = userAgent?.entrypoint ?? "";
  const xAppCli = isNativeXApp(headerValue(headers, "x-app"));
  const baseline = parseCliVersion(baselineUserAgent);

  const uaOk =
    userAgent !== undefined &&
    baseline !== undefined &&
    plausibleCliVersion(userAgent.version, baseline);

  const betasPresent = (headers?.get("anthropic-beta") ?? "")
    .split(",")
    .some((beta) => beta.trim() === "claude-code-20250219");

  const metadataUserId = get(payload, "metadata.user_id");
  const metadataOk = typeof metadataUserId === "string" && isValidUserID(metadataUserId);
  const nativeClient = isNativeEntrypoint(entrypoint, nativeEntrypoints);
  const strong = xAppCli && uaOk && betasPresent && (countTokens || metadataOk);

  return {
    confirmed: strong && nativeClient,
    strongSignals: strong,
    nativeClient,
    entrypoint: entrypoint === "" ? "cli" : entrypoint,
  };
};

const PROBE_TEXTS = new Set(["quota", "test", ".", "probe"]);

const isProbeRequest = (body: JsonObject): boolean => {
  const maxTokens = get(body, "max_tokens");

  if (maxTokens === undefined || Math.trunc(Number(maxTokens)) !== 1) return false;
  const tools = get(body, "tools");

  if (isArr(tools) && tools.length > 0) return false;
  const messages = get(body, "messages");

  if (!isArr(messages) || messages.length === 0) return true;

  if (messages.length !== 1) return false;
  const first = messages[0];

  if (str(get(first, "role")) !== "user") return false;
  const content = get(first, "content");

  if (typeof content === "string") return PROBE_TEXTS.has(content.trim());

  if (isArr(content)) {
    let nonReminder = 0;
    let matched = false;

    for (const part of content) {
      const text = str(get(part, "text")).trim();

      if (text.includes("<system-reminder>")) continue;
      nonReminder++;

      if (PROBE_TEXTS.has(text) || (text === "Hi" && get(part, "cache_control") !== undefined))
        matched = true;
    }

    return nonReminder === 1 && matched;
  }

  return false;
};

const matchesTitleInstruction = (text: string): boolean =>
  text.includes("naming a coding session") ||
  text.includes("Return a short title") ||
  text.includes("Write the title in the predominant language");

const anyText = (value: Json | undefined, predicate: (text: string) => boolean): boolean => {
  if (isArr(value)) return value.some((part) => predicate(str(get(part, "text"))));

  return predicate(str(value));
};

const isTitleHelperRequest = (body: JsonObject): boolean => {
  const props = get(body, "output_config.format.schema.properties");

  if (props !== undefined) {
    if (
      isJsonObject(props) &&
      get(props, "title") !== undefined &&
      Object.keys(props).length === 1
    ) {
      const titlePrompt = (text: string): boolean =>
        matchesTitleInstruction(text) || text.includes("<session>");

      if (anyText(body.system, titlePrompt)) return true;

      return toArray(body.messages).some((message) =>
        anyText(get(message, "content"), titlePrompt),
      );
    }

    return false;
  }

  if (get(body, "output_config") === undefined) return false;

  if (anyText(body.system, matchesTitleInstruction)) return true;

  return toArray(body.messages).some(
    (message) =>
      str(get(message, "role")) === "system" &&
      anyText(get(message, "content"), matchesTitleInstruction),
  );
};

/** `IsClaudeProbeOrHelperRequest`. */
export const isProbeOrHelperRequest = (body: JsonObject): boolean =>
  isProbeRequest(body) || isTitleHelperRequest(body);

/** `IsClaudeQuotaProbeRequest`: the `max_tokens: 1` quota probe alone, without the title helper. */
export const isQuotaProbeRequest = (body: JsonObject): boolean => isProbeRequest(body);

/** `IsClaudeSubagentRequest`. */
export const isSubagentRequest = (headers: Headers | undefined, body: JsonObject): boolean => {
  if (headerValue(headers, "x-claude-code-agent-id") !== "") return true;

  if (headerValue(headers, "x-claude-code-parent-agent-id") !== "") return true;

  if (get(body, "metadata.user_id.parent_session_id") !== undefined) return true;
  const userId = str(get(body, "metadata.user_id"));

  if (userId.includes('"parent_session_id"')) return true;
  const system = body.system;

  if (isArr(system) && system.length > 0)
    return str(get(system[0], "text")).includes("cc_is_subagent=true");

  return typeof system === "string" && system.includes("cc_is_subagent=true");
};

/** `ClaudeSubagentRequests1h`. */
export const subagentRequests1h = (headers: Headers | undefined, body: JsonObject): boolean =>
  payloadHas1hTTL(body) ||
  (headers?.get("anthropic-beta") ?? "").includes("extended-cache-ttl-2025-04-11");

/** `IsClaudeNewPromptTurn`: the last message is a user turn without tool results. */
export const isNewPromptTurn = (body: JsonObject): boolean => {
  const messages = body.messages;

  if (!isArr(messages) || messages.length === 0) return true;
  const last = messages[messages.length - 1];

  if (str(get(last, "role")) !== "user") return false;
  const content = get(last, "content");

  return !(isArr(content) && content.some((part) => str(get(part, "type")) === "tool_result"));
};

const canonicalModel = (model: string): string => {
  const lower = model.trim().toLowerCase();
  const slash = lower.lastIndexOf("/");

  return slash >= 0 ? lower.slice(slash + 1) : lower;
};

export const isHaikuModel = (model: string): boolean => model.toLowerCase().includes("haiku");

export const isOpus55Model = (model: string): boolean => {
  const m = canonicalModel(model);

  return m === "claude-opus-5-5" || m.startsWith("claude-opus-5-5[");
};

export const isSonnet55Model = (model: string): boolean => {
  const m = canonicalModel(model);

  return (
    m === "claude-sonnet-5-5" ||
    m.startsWith("claude-sonnet-5-5-") ||
    m.startsWith("claude-sonnet-5-5[")
  );
};

/** `isClaudeHaiku55Model`. */
export const isHaiku55Model = (model: string): boolean => {
  const m = canonicalModel(model);

  return ["claude-haiku-5-5", "claude-haiku-5.5"].some(
    (prefix) => m === prefix || m.startsWith(`${prefix}-`) || m.startsWith(`${prefix}[`),
  );
};

/** `isClaudeFable52Model`. */
export const isFable52Model = (model: string): boolean => {
  const m = canonicalModel(model);

  return ["claude-fable-5-2", "claude-fable-5.2"].some(
    (prefix) => m === prefix || m.startsWith(`${prefix}-`) || m.startsWith(`${prefix}[`),
  );
};

/** Same shape as {@link isFable52Model}; kept apart so Mythos 5.2's progress display and per-turn betas stay as they are. */
export const isMythos52Model = (model: string): boolean => {
  const m = canonicalModel(model);

  return ["claude-mythos-5-2", "claude-mythos-5.2"].some(
    (prefix) => m === prefix || m.startsWith(`${prefix}-`) || m.startsWith(`${prefix}[`),
  );
};

export const isSonnet5Model = (model: string): boolean => {
  const m = canonicalModel(model);

  if (isSonnet55Model(m)) return false;

  return (
    m === "claude-sonnet-5" || m.startsWith("claude-sonnet-5-") || m.startsWith("claude-sonnet-5[")
  );
};

/** `isClaudeFable51Model`: fable/mythos 5.1 not followed by a digit. */
export const isFable51Model = (model: string): boolean => {
  const m = model.trim().toLowerCase();

  for (const target of ["fable-5-1", "fable-5.1", "mythos-5-1", "mythos-5.1"]) {
    const index = m.indexOf(target);

    if (index === -1) continue;
    const next = m[index + target.length];

    if (next === undefined || next < "0" || next > "9") return true;
  }

  return false;
};

/**
 * `isClaudePreservedThinkingModel`: the models that check replayed signed thinking against the creation-time prefix.
 * The set is the one Anthropic's preserved-thinking docs list (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking):
 * Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 and 5.2, Mythos 5.1 and 5.2. It deliberately differs from Go, which leaves
 * Mythos out (`isFable51Model` already covers Mythos 5.1).
 */
export const isPreservedThinkingModel = (model: string): boolean =>
  isOpus55Model(model) ||
  isSonnet55Model(model) ||
  isHaiku55Model(model) ||
  isFable51Model(model) ||
  isFable52Model(model) ||
  isMythos52Model(model);

/** `claudeModelUsesProgressDisplay`: Claude Code 2.1.321 added Fable 5.2 and Haiku 5.5. */
export const usesProgressDisplay = (model: string): boolean =>
  isOpus55Model(model) ||
  isFable51Model(model) ||
  isFable52Model(model) ||
  isSonnet5Model(model) ||
  isSonnet55Model(model) ||
  isHaiku55Model(model);

/** `claudeModelHasPerTurnEffort`: the 2.1.321 catalog's `per_turn_effort` models. */
export const hasPerTurnEffort = (model: string): boolean =>
  isOpus55Model(model) ||
  canonicalModel(model).startsWith("claude-fable-5-1") ||
  isFable52Model(model) ||
  isSonnet55Model(model) ||
  isHaiku55Model(model);

/** `claudeModelHasPerTurnTiming`: the catalog's `per_turn_timing` models (Haiku 5.5 has none). */
export const hasPerTurnTiming = (model: string): boolean => {
  if (isHaiku55Model(model)) return false;
  const m = canonicalModel(model);

  return (
    hasPerTurnEffort(m) ||
    m.startsWith("claude-mythos-5-1") ||
    m.startsWith("claude-mythos-5-2") ||
    m.startsWith("claude-mythos-5.2")
  );
};

const LEGACY_SYSTEM_REMINDER_MODELS = new Set([
  "claude-3-5-haiku-20241022",
  "claude-3-5-haiku-latest",
  "claude-3-7-sonnet-20250219",
  "claude-3-7-sonnet-latest",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4",
  "claude-opus-4-20250514",
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-sonnet-4",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
]);

/** `claudeUsesLegacySystemReminder`: the model rejects mid-conversation `role:"system"` messages. */
export const usesLegacySystemReminder = (body: JsonObject): boolean =>
  LEGACY_SYSTEM_REMINDER_MODELS.has(canonicalModel(str(body.model)));

/** `ExtractClaudeBillingTags`: `cc_prev_req` and `cc_prompt_id` of an existing billing block. */
export const extractBillingTags = (body: JsonObject) => {
  const system = body.system;
  let text = "";

  if (isArr(system) && system.length > 0) text = str(get(system[0], "text"));
  else if (typeof system === "string") text = system;

  if (!text.startsWith("x-anthropic-billing-header:")) return { prevReq: "", promptId: "" };

  const tag = (name: string): string => {
    const index = text.indexOf(name);

    if (index < 0) return "";
    const rest = text.slice(index + name.length);
    const end = rest.indexOf(";");

    return end >= 0 ? rest.slice(0, end) : rest;
  };

  const prev = tag("cc_prev_req=");
  const prompt = tag("cc_prompt_id=");

  return {
    prevReq: /^req_[A-Za-z0-9_-]{1,36}$/.test(prev) ? prev : "",
    promptId: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(prompt)
      ? prompt.toLowerCase()
      : "",
  };
};
