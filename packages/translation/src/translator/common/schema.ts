/**
 * JSON Schema keyword tables and regex-escape checks shared by translators.
 *
 * Go source: internal/util/claude_schema.go (SchemaMapKeywords, SchemaValueKeywords,
 * HasUnsupportedUnicodePropertyEscape) and internal/util/gemini_schema.go (NormalizeJSONSchemaNumericConstraints).
 */
import { isJsonArray, isJsonObject, type Json, type JsonObject } from "@commissary/json";

/** Keywords whose values are maps of subschemas. */
export const SCHEMA_MAP_KEYWORDS: readonly string[] = [
  "properties",
  "$defs",
  "definitions",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
];

/** Keywords with a single nested subschema or a list of subschemas. */
export const SCHEMA_VALUE_KEYWORDS: readonly string[] = [
  "items",
  "prefixItems",
  "contains",
  "additionalProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "additionalItems",
  "contentSchema",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
];

const NUMERIC_CONSTRAINT_KEYWORDS: ReadonlySet<string> = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
]);

/** Keywords whose value maps names to subschemas (the names themselves are never keywords). */
const SUBSCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

/** Keywords whose value is one subschema. */
const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "additionalProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "if",
  "then",
  "else",
  "not",
  "contains",
  "propertyNames",
  "contentSchema",
]);

/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set([
  "prefixItems",
  "anyOf",
  "oneOf",
  "allOf",
]);

/** A non-negative integer written canonically (no sign, no leading zeros) that a JSON number holds exactly. */
const parseSchemaNonNegativeInt = (raw: string): number | undefined => {
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) return undefined;
  const n = Number(raw);

  return Number.isSafeInteger(n) ? n : undefined;
};

const subschema = (value: Json): Json =>
  isJsonObject(value) ? normalizeNumericConstraintsNode(value) : value;

const normalizeNumericConstraintsNode = (node: JsonObject): JsonObject => {
  let out: JsonObject | undefined;

  const replace = (key: string, value: Json): void => {
    out ??= { ...node };
    out[key] = value;
  };

  for (const [key, value] of Object.entries(node)) {
    if (NUMERIC_CONSTRAINT_KEYWORDS.has(key)) {
      const parsed = typeof value === "string" ? parseSchemaNonNegativeInt(value) : undefined;

      if (parsed !== undefined) replace(key, parsed);
    } else if (SUBSCHEMA_MAP_KEYWORDS.has(key)) {
      if (!isJsonObject(value)) continue;

      const entries = Object.entries(value).map(([name, schema]): [string, Json] => [
        name,
        subschema(schema),
      ]);

      if (entries.some(([name, schema]) => schema !== value[name]))
        replace(key, Object.fromEntries(entries));
    } else if (key === "items" || SUBSCHEMA_LIST_KEYWORDS.has(key)) {
      if (isJsonArray(value)) {
        const items = value.map(subschema);

        if (items.some((item, index) => item !== value[index])) replace(key, items);
      } else if (key === "items" && isJsonObject(value)) {
        const normalized = normalizeNumericConstraintsNode(value);

        if (normalized !== value) replace(key, normalized);
      }
    } else if (SUBSCHEMA_KEYWORDS.has(key) && isJsonObject(value)) {
      const normalized = normalizeNumericConstraintsNode(value);

      if (normalized !== value) replace(key, normalized);
    }
  }

  return out ?? node;
};

/**
 * `NormalizeJSONSchemaNumericConstraints`: converts string-encoded integers on the numeric constraint keywords
 * (`minLength`, `maxLength`, `minItems`, `maxItems`, `minProperties`, `maxProperties`) to JSON numbers. Google's
 * protobuf Schema carries these int64 fields as strings, whereas a standard JSON Schema carrier such as
 * `parametersJsonSchema` needs numbers. Only schema and subschema containers are visited, so string literals
 * (`enum`, `default`, `examples`) and non-schema metadata (`x-*`, unknown keys, property names) stay untouched.
 * Returns `schema` itself when nothing changes; never mutates it.
 */
export const normalizeJsonSchemaNumericConstraints = (schema: Json): Json =>
  isJsonObject(schema) ? normalizeNumericConstraintsNode(schema) : schema;

/** `HasUnsupportedUnicodePropertyEscape`: `\p{..}`/`\P{..}` and the octal NUL escape `\0`. */
export const hasUnsupportedUnicodePropertyEscape = (pattern: string): boolean => {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "\\") continue;

    if (i + 1 >= pattern.length) break;
    const next = pattern[i + 1];

    if ((next === "p" || next === "P") && i + 2 < pattern.length && pattern[i + 2] === "{")
      return true;

    if (next === "0") return true;
    i++; // skip the escaped character (including an escaped backslash)
  }

  return false;
};
