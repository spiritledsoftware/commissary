/**
 * User payload rules: the final semantic barrier before an upstream request is sent.
 *
 * Go source: internal/runtime/executor/helps/payload_helpers.go (ApplyPayloadConfigWithTrackedPathsForExecutor) and
 * payload_finalizer.go. Order: built-in `disable-image-generation` stripping, then `default`, `default-raw`,
 * `override`, `override-raw`, `replace` (`replace.ts`) and `filter` rules. Rule conditions (`match`, `not-match`, `exist`, `not-exist`) are
 * evaluated against the payload as modified by the earlier rules.
 *
 * Executors must call {@link applyPayloadRules} exactly once per attempt, on a body rebuilt from scratch, after all
 * built-in translation/normalisation, and must not mutate the business payload afterwards (see AGENTS.md).
 *
 * The Codex tool-schema integer normalisation for Codex user agents (`NormalizeCodexToolIntegerTypes`) runs just
 * before this function in `executor/helps/payload.ts` (`finalizePayload`), which executors call instead.
 */
import {
  asString,
  cloneJson,
  del,
  exists,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  jsonEquals,
  set,
  tryParseJson,
} from "@commissary/json";
import type { PayloadConfig, PayloadRule } from "./schema.ts";
import {
  type HeaderInput,
  payloadModelCandidates,
  payloadModelRulesMatch,
  type PayloadMatchContext,
} from "./match.ts";
import { buildPayloadPath, payloadRuleTargetsPath, resolvePayloadRulePaths } from "./paths.ts";
import { applyPayloadReplaceRule, payloadReplaceRuleError } from "./replace.ts";

/** `multimedia.disable-image-generation`: `false` (default), `true`, `"chat"` or `"passthrough"`. */
export type DisableImageGenerationMode = boolean | "chat" | "passthrough";

/** The slice of the resolved config that payload rules need. */
export interface PayloadRulesConfig {
  readonly requests: { readonly payload: PayloadConfig };
  readonly multimedia: { readonly "disable-image-generation": DisableImageGenerationMode };
}

export interface PayloadRequest {
  /** Upstream model the executor will call (suffix already stripped). */
  readonly model: string;
  /** Model string the client sent (may carry a `(thinking)` suffix); lets rules target aliases. */
  readonly requestedModel?: string;
  /**
   * The published route's provider-qualified source (`copilot/gpt-6-sol`), which rules may also name. Go:
   * internal/runtime/executor/helps/payload_helpers.go (`ApplyPayloadConfigWithRequestDoc`, f89d408e).
   */
  readonly sourceModel?: string;
  /** Target (provider) protocol of the payload, e.g. `openai`, `claude`, `gemini`, `codex`, `antigravity`. */
  readonly protocol: string;
  /** Source (client) protocol, e.g. `openai`, `responses`, `claude`, `gemini`. */
  readonly fromProtocol?: string;
  /** Path prefix of the business payload inside the body (`"request"` for Antigravity), else empty. */
  readonly root?: string;
  /** Inbound HTTP path, used for `disable-image-generation: chat`. */
  readonly requestPath?: string;
  /** Inbound request headers, used by `headers` conditions. */
  readonly headers?: HeaderInput;
  /**
   * The client payload translated to the target format without thinking or other mutations. `default` rules do not
   * write paths present here. Must be a different object than the payload; when omitted the payload as received
   * is used.
   */
  readonly original?: Json;
  /** Paths whose modification should be reported in {@link PayloadRulesResult.touched}. */
  readonly trackedPaths?: readonly string[];
}

export interface PayloadRulesResult {
  /** The final payload (the same object as the input unless the root had to be replaced). */
  readonly payload: Json;
  /** Tracked paths (or their ancestors/descendants) targeted by an applied rule. */
  readonly touched: ReadonlySet<string>;
}

const isImagesEndpointRequestPath = (rawPath: string): boolean => {
  const path = rawPath.trim();

  if (path === "") return false;

  return (
    path === "/v1/images/generations" ||
    path === "/v1/images/edits" ||
    path.endsWith("/images/generations") ||
    path.endsWith("/images/edits")
  );
};

const shouldStripImageGeneration = (
  mode: DisableImageGenerationMode,
  requestPath: string,
): boolean => {
  if (mode === true) return true;

  if (mode === "chat") return !isImagesEndpointRequestPath(requestPath);

  return false;
};

const equalFold = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const removeToolTypeFromPayload = (payload: Json, root: string, toolType: string): Json => {
  const toolsPath = buildPayloadPath(root, "tools");
  const tools = get(payload, toolsPath);

  if (!isJsonArray(tools)) return payload;
  const isTool = (tool: Json): boolean => asString(get(tool, "type")) === toolType;

  if (!tools.some(isTool)) return payload;

  return (
    setQuietly(
      payload,
      toolsPath,
      tools.filter((tool) => !isTool(tool)),
    ) ?? payload
  );
};

const removeToolChoiceFromPayload = (payload: Json, root: string, toolType: string): Json => {
  const path = buildPayloadPath(root, "tool_choice");
  const choice = get(payload, path);

  if (choice === undefined) return payload;
  let remove = false;

  if (typeof choice === "string") {
    remove = equalFold(choice.trim(), toolType);
  } else if (isJsonObject(choice) || isJsonArray(choice)) {
    const choiceType = asString(get(choice, "type")).trim();
    remove =
      equalFold(choiceType, toolType) ||
      (equalFold(choiceType, "tool") && equalFold(asString(get(choice, "name")).trim(), toolType));
  }

  return remove ? (delQuietly(payload, path) ?? payload) : payload;
};

/** sjson errors are swallowed by the Go caller (`continue`), so do the same. */
const setQuietly = (payload: Json, path: string, value: Json): Json | undefined => {
  try {
    return set(payload, path, value);
  } catch {
    return undefined;
  }
};

const delQuietly = (payload: Json, path: string): Json | undefined => {
  try {
    return del(payload, path);
  } catch {
    return undefined;
  }
};

/** `*-raw` values: strings are raw JSON text, other values are used as JSON; `null` is skipped. */
const payloadRawValue = (value: Json): Json | undefined => {
  if (value === null) return undefined;

  if (typeof value === "string") return tryParseJson(value);

  return value;
};

/**
 * Applies the configured payload rules to `payload` in place and reports touched tracked paths.
 * Returns the payload unchanged when there is no config.
 */
export const applyPayloadRules = (
  config: PayloadRulesConfig | undefined,
  request: PayloadRequest,
  payload: Json,
): PayloadRulesResult => {
  const touched = new Set<string>();

  if (config === undefined) return { payload, touched };

  const root = request.root ?? "";

  const trackedPaths = (request.trackedPaths ?? [])
    .map((path) => path.trim())
    .filter((path) => path !== "");

  const rules = config.requests.payload;

  const hasPayloadRules =
    rules.default.length +
      rules["default-raw"].length +
      rules.override.length +
      rules["override-raw"].length +
      rules.replace.length +
      rules.filter.length >
    0;

  // Defaults compare against the client payload; without one, the payload as received (before any mutation here).
  const source =
    request.original !== undefined && request.original !== payload
      ? request.original
      : hasPayloadRules && rules.default.length + rules["default-raw"].length > 0
        ? cloneJson(payload)
        : payload;

  let out = payload;

  const markTouched = (resolvedPath: string): void => {
    for (const tracked of trackedPaths) {
      if (payloadRuleTargetsPath(resolvedPath, tracked)) touched.add(tracked);
    }
  };

  // Built-in image_generation stripping runs first so that user rules may add the tool back.
  if (
    shouldStripImageGeneration(
      config.multimedia["disable-image-generation"],
      request.requestPath?.trim() ?? "",
    )
  ) {
    out = removeToolTypeFromPayload(out, root, "image_generation");
    out = removeToolChoiceFromPayload(out, root, "image_generation");
  }

  const model = request.model.trim();
  const requestedModel = (request.requestedModel ?? "").trim();

  const candidates = payloadModelCandidates(model, requestedModel, request.sourceModel);

  if (!hasPayloadRules || candidates.length === 0) return { payload: out, touched };

  const context: PayloadMatchContext = {
    protocol: request.protocol,
    fromProtocol: request.fromProtocol ?? "",
    headers: request.headers,
    root,
    candidates,
  };

  const matches = (rule: PayloadRule | { readonly models?: PayloadRule["models"] }): boolean =>
    payloadModelRulesMatch(rule.models, context, out);

  const appliedDefaults = new Set<string>();

  const applyDefaults = (list: readonly PayloadRule[], raw: boolean): void => {
    for (const rule of list) {
      if (!matches(rule)) continue;

      for (const [path, param] of Object.entries(rule.params ?? {})) {
        const fullPath = buildPayloadPath(root, path);

        if (fullPath === "") continue;

        for (const resolvedPath of resolvePayloadRulePaths(out, fullPath)) {
          if (exists(source, resolvedPath) || appliedDefaults.has(resolvedPath)) continue;
          const value = raw ? payloadRawValue(param) : param;

          if (value === undefined) continue;
          const updated = setQuietly(out, resolvedPath, cloneJson(value));

          if (updated === undefined) continue;
          out = updated;
          appliedDefaults.add(resolvedPath);
          markTouched(resolvedPath);
        }
      }
    }
  };

  const applyOverrides = (list: readonly PayloadRule[], raw: boolean): void => {
    for (const rule of list) {
      if (!matches(rule)) continue;

      for (const [path, param] of Object.entries(rule.params ?? {})) {
        const fullPath = buildPayloadPath(root, path);

        if (fullPath === "") continue;
        const value = raw ? payloadRawValue(param) : param;

        if (value === undefined) continue;

        for (const resolvedPath of resolvePayloadRulePaths(out, fullPath)) {
          // An identical value counts as applied without rewriting it.
          if (jsonEquals(get(out, resolvedPath), value)) {
            markTouched(resolvedPath);
            continue;
          }

          const updated = setQuietly(out, resolvedPath, cloneJson(value));

          if (updated === undefined) continue;
          out = updated;
          markTouched(resolvedPath);
        }
      }
    }
  };

  applyDefaults(rules.default, false);
  applyDefaults(rules["default-raw"], true);
  applyOverrides(rules.override, false);
  applyOverrides(rules["override-raw"], true);

  // Replace selected strings after overrides and before the final field deletion.
  for (const rule of rules.replace) {
    if (payloadReplaceRuleError(rule) !== undefined || !matches(rule)) continue;
    applyPayloadReplaceRule(out, request.protocol, root, rule, markTouched);
  }

  for (const rule of rules.filter) {
    if (!matches(rule)) continue;

    for (const path of rule.params ?? []) {
      const fullPath = buildPayloadPath(root, path);

      if (fullPath === "") continue;
      const resolvedPaths = resolvePayloadRulePaths(out, fullPath);

      for (const resolvedPath of resolvedPaths.toReversed()) {
        const updated = delQuietly(out, resolvedPath);

        if (updated === undefined) continue;
        out = updated;
        markTouched(resolvedPath);
      }
    }
  }

  return { payload: out, touched };
};
