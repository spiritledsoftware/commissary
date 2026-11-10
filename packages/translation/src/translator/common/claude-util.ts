/**
 * Claude naming/schema helpers.
 *
 * Go source: internal/util/claude_tool_id.go, internal/util/claude_schema.go,
 * internal/translator/common/request.go (GenerateClaudeToolCallID), internal/translator/common/file_data.go.
 */
import { createHash } from "node:crypto";
import { stableStringify, type Json, type JsonObject } from "@commissary/json";
import { isArr, isObj } from "./gjson.ts";
import { lookupModelInfo } from "../model-info.ts";

/** Ceiling for a model the catalog does not know (Go `defaultClaudeChatMaxTokens`). */
const DEFAULT_MAX_TOKENS = 32000;

/** Ceiling for Fable when the client omits its limit: conservative even when the catalog allows more. */
const DEFAULT_FABLE_MAX_TOKENS = 64000;

/**
 * The `max_tokens` a Claude request gets when the client set none (Go `defaultClaudeChatMaxTokensForModel`): the
 * catalog's output limit for the model (`maxCompletionTokens`, ADR 0020, through the translator's model-info lookup
 * rather than Go's registry), else 32000. Fable keeps its conservative ceiling. A payload `default` rule for
 * `max_tokens` can still replace it: the executor drops it from the original body it hands the rules.
 */
export const defaultClaudeMaxTokensForModel = (modelName: string): number => {
  const fable = modelName.trim().toLowerCase().includes("fable");
  const fallback = fable ? DEFAULT_FABLE_MAX_TOKENS : DEFAULT_MAX_TOKENS;
  const cap = lookupModelInfo(modelName, "claude")?.maxCompletionTokens ?? 0;

  if (cap <= 0) return fallback;

  return fable && cap >= fallback ? fallback : cap;
};

/** `SanitizeClaudeFunctionName`: `^[a-zA-Z0-9_-]{1,64}$` (non-conforming characters become `_`). */
export const sanitizeClaudeFunctionName = (name: string): string => {
  if (name === "") return "";
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/gu, "_");

  if (sanitized.length > 64) sanitized = sanitized.slice(0, 64);

  return sanitized === "" ? "_" : sanitized;
};

const EMPTY_INPUT_SCHEMA = (): JsonObject => ({ type: "object", properties: {} });

const schemaObject = (value: Json | undefined): JsonObject => (isObj(value) ? { ...value } : {});

const canBeObject = (schema: JsonObject): boolean => {
  if (!Object.hasOwn(schema, "type")) return true;
  const type = schema.type;

  if (typeof type === "string") return type === "object";

  if (!isArr(type) || !type.every((item) => typeof item === "string")) return false;

  return type.includes("object");
};

const mergeRequired = (root: JsonObject, branchRequired: Json | undefined): void => {
  if (!isArr(branchRequired) || !branchRequired.every((item) => typeof item === "string")) return;
  let required: string[] = [];

  if (isArr(root.required) && root.required.every((item) => typeof item === "string"))
    required = [...root.required];
  const seen = new Set(required);

  for (const name of branchRequired) {
    if (seen.has(name)) continue;
    required.push(name);
    seen.add(name);
  }

  if (required.length > 0) root.required = required;
};

/** `NormalizeClaudeToolInputSchema`: Claude needs an object schema without root-level unions. */
export const normalizeClaudeToolInputSchema = (schema: Json | undefined): JsonObject => {
  if (!isObj(schema)) return EMPTY_INPUT_SCHEMA();
  const root: JsonObject = { ...schema };
  const properties = schemaObject(root.properties);

  for (const unionName of ["anyOf", "oneOf", "allOf"]) {
    if (!Object.hasOwn(root, unionName)) continue;
    const union = root[unionName];
    delete root[unionName];

    if (!isArr(union)) continue;

    for (const branch of union) {
      if (!isObj(branch) || !canBeObject(branch)) continue;

      for (const [name, property] of Object.entries(schemaObject(branch.properties))) {
        if (!Object.hasOwn(properties, name)) properties[name] = property;
      }

      if (unionName === "allOf") mergeRequired(root, branch.required);
    }
  }

  root.type = "object";
  root.properties = properties;

  return root;
};

const GEMINI_CLAUDE_TOOL_USE_ID_PREFIX = "cpa_gemini_";

/** `GeminiClaudeToolUseID`: stable Claude-facing id for a provider-native Gemini function call. */
export const geminiClaudeToolUseID = (callId: string, name: string, argsRaw: string): string => {
  const call = callId.trim();
  const fn = name.trim();

  if (call === "" || fn === "") return "";
  let args = argsRaw;

  if (args.trim() !== "") {
    try {
      args = stableStringify(JSON.parse(args));
    } catch {
      args = args.trim();
    }
  }

  const digest = createHash("sha256").update([call, fn, args].join("\u0000")).digest("hex");

  return GEMINI_CLAUDE_TOOL_USE_ID_PREFIX + digest.slice(0, 32);
};

/** `IsGeminiClaudeToolUseID`. */
export const isGeminiClaudeToolUseID = (id: string): boolean => {
  const trimmedId = id.trim();

  return (
    trimmedId.startsWith(GEMINI_CLAUDE_TOOL_USE_ID_PREFIX) &&
    /^[0-9a-fA-F]{32}$/.test(trimmedId.slice(GEMINI_CLAUDE_TOOL_USE_ID_PREFIX.length))
  );
};
