/**
 * Go source: internal/translator/common/request.go (RequestModelName, GenerateClaudeToolCallID, ClaudeMaxTokensRaw,
 * ClaudeStopSequences, ClaudeOutputJSONSchema).
 */
import {
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from "@commissary/json";

const requestModelName = (root: Json | undefined): string => {
  if (root === undefined) return "";

  for (const path of ["model", "request.model"]) {
    const model = get(root, path);

    if (typeof model === "string" && model.trim() !== "") return model;
  }

  return "";
};

/** Model name of the original request, falling back to the translated one. */
export const requestModelNameOf = (
  original: Json | undefined,
  translated: Json | undefined,
): string => {
  for (const root of [original, translated]) {
    const name = requestModelName(root);

    if (name !== "") return name;
  }

  return "";
};

const TOOLU_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** `GenerateClaudeToolCallID`: `toolu_` + 24 uniformly random alphanumerics. */
export const generateClaudeToolCallId = (): string => {
  const max = 256 - (256 % TOOLU_LETTERS.length);
  let out = "toolu_";
  let n = 0;
  const buffer = new Uint8Array(32);

  while (n < 24) {
    crypto.getRandomValues(buffer);

    for (const value of buffer) {
      if (value < max) {
        out += TOOLU_LETTERS[value % TOOLU_LETTERS.length];
        n++;

        if (n === 24) break;
      }
    }
  }

  return out;
};

/** Convenience: `gjson.Get(...).String()`. */
export const stringAt = (root: Json | undefined, path: string): string => asString(get(root, path));

/** `ClaudeMaxTokensRaw`: a Claude `max_tokens` forwarded as given when it is a number (0 included), else undefined. */
export const claudeMaxTokens = (value: Json | undefined): number | undefined =>
  typeof value === "number" ? value : undefined;

/** `ClaudeStopSequences`: the non-empty string entries of a Claude `stop_sequences` array; undefined if none. */
export const claudeStopSequences = (value: Json | undefined): string[] | undefined => {
  if (!isJsonArray(value)) return undefined;
  const sequences = value.filter((item): item is string => typeof item === "string" && item !== "");

  return sequences.length > 0 ? sequences : undefined;
};

/** `ClaudeOutputJSONSchema`: the schema of an `output_config.format` of type json_schema, if it is an object. */
export const claudeOutputJsonSchema = (format: Json | undefined): JsonObject | undefined => {
  if (!isJsonObject(format)) return undefined;

  if (asString(get(format, "type")).trim().toLowerCase() !== "json_schema") return undefined;
  const schema = get(format, "schema");

  return isJsonObject(schema) ? schema : undefined;
};
