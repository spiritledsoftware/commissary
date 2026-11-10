/**
 * Small gjson-style readers shared by the translators (gjson `Result` helpers over parsed JSON).
 */
import { asString, isJsonArray, isJsonObject, type Json, type JsonObject } from "@commissary/json";

/** `Result.Exists()` for a possibly missing value. */
export const exists = (value: Json | undefined): value is Json => value !== undefined;

/** `Result.String()`. */
export const str = (value: Json | undefined): string => asString(value);

/** `strings.TrimSpace(result.String())`. */
/** An empty or whitespace-only string: Anthropic answers 400 to a text block like that. */
export const isBlankText = (value: string): boolean => value.trim() === "";

export const trimmed = (value: Json | undefined): string => asString(value).trim();

/** Own property of an object value (`undefined` when `value` is not an object). */
export const field = (value: Json | undefined, key: string): Json | undefined =>
  isJsonObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;

/** `Result.Array()`: array items; a scalar/object becomes a single item; missing/null becomes empty. */
export const toArray = (value: Json | undefined): Json[] => {
  if (value === undefined || value === null) return [];

  return isJsonArray(value) ? value : [value];
};

/** `Result.ForEach` values: array items or object values. */
export const eachValue = (value: Json | undefined): Json[] => {
  if (isJsonArray(value)) return value;

  if (isJsonObject(value)) return Object.values(value);

  return [];
};

/** Own enumerable entries of an object value. */
export const entries = (value: Json | undefined): Array<[string, Json]> =>
  isJsonObject(value) ? Object.entries(value) : [];

export const isStr = (value: Json | undefined): value is string => typeof value === "string";

export const isObj = (value: Json | undefined): value is JsonObject => isJsonObject(value);

export const isArr = (value: Json | undefined): value is Json[] => isJsonArray(value);

/** Go `strings.TrimSpace` semantic is close enough to `String.prototype.trim` for translators. */
export const trimSpace = (text: string): string => text.trim();
