/**
 * Gemini part helpers.
 *
 * Go source: internal/translator/common/gemini.go (IsGeminiThoughtPart, GeminiPartFunctionCall/Response,
 * GeminiPartsHaveFunctionCall/Response, NormalizeGeminiTurnRole). The function-response checks copy the identical
 * per-translator helpers of claude_gemini_request.go, codex_gemini_request.go and interactions_gemini_common.go.
 */
import { asBool, exists, get, isJsonArray, isJsonObject, type Json } from "@commissary/json";

/** `IsGeminiThoughtPart`: the part carries hidden model thought. */
export const isGeminiThoughtPart = (part: Json | undefined): boolean =>
  asBool(get(part, "thought"));

/** The first non-empty string found at one of `paths` of `node`, or `""` (thought signatures sit at several spellings). */
export const firstNonEmptyStringAt = (node: Json | undefined, paths: readonly string[]): string => {
  for (const path of paths) {
    const value = get(node, path);

    if (typeof value === "string" && value !== "") return value;
  }

  return "";
};

/** `GeminiPartFunctionCall`: the `functionCall` or snake_case `function_call` object of a part. */
export const geminiPartFunctionCall = (part: Json | undefined): Json | undefined =>
  get(part, "functionCall") ?? get(part, "function_call");

/** `GeminiPartFunctionResponse`: the `functionResponse` or snake_case `function_response` object of a part. */
export const geminiPartFunctionResponse = (part: Json | undefined): Json | undefined =>
  get(part, "functionResponse") ?? get(part, "function_response");

const partsHave = (parts: Json | undefined, has: (part: Json) => boolean): boolean =>
  isJsonArray(parts) && parts.some(has);

/** `GeminiPartsHaveFunctionCall`. */
export const geminiPartsHaveFunctionCall = (parts: Json | undefined): boolean =>
  partsHave(parts, (part) => exists(part, "functionCall") || exists(part, "function_call"));

/** `GeminiPartsHaveFunctionResponse`. */
export const geminiPartsHaveFunctionResponse = (parts: Json | undefined): boolean =>
  partsHave(parts, (part) => exists(part, "functionResponse") || exists(part, "function_response"));

/**
 * `NormalizeGeminiTurnRole`: maps a Gemini content role to `user` or `assistant`. An omitted or unrecognised role is
 * inferred from the turn's function parts, else alternates from `previousRole`.
 */
export const normalizeGeminiTurnRole = (
  rawRole: string,
  parts: Json | undefined,
  previousRole: string,
): string => {
  switch (rawRole.trim().toLowerCase()) {
    case "model":
    case "assistant":
      return "assistant";
    case "user":
    case "function":
    case "tool":
      return "user";
    default:
      if (geminiPartsHaveFunctionCall(parts)) return "assistant";

      if (geminiPartsHaveFunctionResponse(parts)) return "user";

      return previousRole === "user" ? "assistant" : "user";
  }
};

/** A function response's `response` that is absent or an empty object. */
export const isEmptyGeminiResponseObject = (value: Json | undefined): boolean =>
  value === undefined || (isJsonObject(value) && Object.keys(value).length === 0);

/** `geminiClaudeResponseHasOnlyResultKey` (and its Codex and Interactions twins): `{ "result": ... }` and nothing else. */
export const geminiResponseHasOnlyResultKey = (response: Json | undefined): boolean =>
  isJsonObject(response) && Object.keys(response).length === 1 && Object.hasOwn(response, "result");
