/**
 * Claude tool schemas whose property names Claude rejects.
 *
 * Go source: internal/runtime/executor/helps/claude_tool_property_names.go (f0c9c2d0).
 *
 * Claude rejects a request whose tools declare an `input_schema` property key outside `^[a-zA-Z0-9_.-]{1,64}$`, while
 * OpenAI-compatible clients and MCP servers commonly use names such as `not[labels]`. Clients resend their tools every
 * turn, so one such tool fails the whole conversation. Claude shows tool schemas to the model as prompt text, so such a
 * tool is sent with an open-object `input_schema` and its original schema embedded verbatim in the description: no
 * parameter is renamed or dropped, so neither history `tool_use` inputs nor response tool calls need rewriting. `strict`
 * is removed, since structured outputs cannot apply an embedded schema. Runs before user payload rules.
 */
import { get, type Json, type JsonObject } from "@commissary/json";
import { isArr, isObj, str } from "@commissary/translation";
import { isServerToolType } from "./mcp-alias.ts";

const PROPERTY_KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

const CLAUDE_TOOL_SCHEMA_MAX_INSPECT_DEPTH = 256;

const CLAUDE_TOOL_SCHEMA_FALLBACK_PREFIX =
  "The input object must conform to the following JSON Schema. Use its property names exactly as written, including any characters such as brackets:\n";

/** `claudePropertyKeyAccepted`: whether Claude accepts `name` as an `input_schema` property key. */
export const claudePropertyKeyAccepted = (name: string): boolean => PROPERTY_KEY_PATTERN.test(name);

/**
 * `claudeSchemaHasRejectedPropertyKey`: whether `schema`, or any subschema reachable through applicator and definition
 * keywords, declares a `properties` key Claude rejects. Keywords are interpreted only at schema positions; values of
 * `const`, `default`, `enum`, `examples` and unknown annotations are data and are not inspected. A schema nested beyond
 * the inspection depth counts as rejected, so it takes the fallback, which still carries the full schema text.
 */
export const claudeSchemaHasRejectedPropertyKey = (schema: Json, depth: number): boolean => {
  if (!isObj(schema)) return false;

  if (depth > CLAUDE_TOOL_SCHEMA_MAX_INSPECT_DEPTH) return true;
  const subschema = (value: Json): boolean => claudeSchemaHasRejectedPropertyKey(value, depth + 1);

  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case "properties":
        if (!isObj(value)) break;

        for (const [name, item] of Object.entries(value)) {
          if (!claudePropertyKeyAccepted(name) || subschema(item)) return true;
        }

        break;
      case "$defs":
      case "definitions":
      case "patternProperties":
      case "dependentSchemas":
      case "dependencies":
        // Maps of named subschemas; `dependencies` may also hold name arrays, which are not objects and are skipped.
        if (isObj(value) && Object.values(value).some(subschema)) return true;
        break;
      case "allOf":
      case "anyOf":
      case "oneOf":
      case "prefixItems":
        if (isArr(value) && value.some(subschema)) return true;
        break;
      case "items":
        if (isArr(value) ? value.some(subschema) : subschema(value)) return true;
        break;
      case "additionalProperties":
      case "unevaluatedProperties":
      case "additionalItems":
      case "unevaluatedItems":
      case "contains":
      case "propertyNames":
      case "not":
      case "if":
      case "then":
      case "else":
      case "contentSchema":
        if (subschema(value)) return true;
        break;
      default:
        break;
    }
  }

  return false;
};

/** `claudeToolNeedsSchemaFallback`: a client tool declaration whose `input_schema` Claude would reject. */
const needsSchemaFallback = (tool: Json | undefined): tool is JsonObject =>
  isObj(tool) &&
  !isServerToolType(str(tool.type)) &&
  isObj(tool.input_schema) &&
  claudeSchemaHasRejectedPropertyKey(tool.input_schema, 0);

const applySchemaFallback = (tool: JsonObject): void => {
  const existing = str(tool.description);
  const prefix = existing.trim() === "" ? "" : `${existing}\n\n`;
  tool.description = `${prefix}${CLAUDE_TOOL_SCHEMA_FALLBACK_PREFIX}${JSON.stringify(tool.input_schema)}`;
  tool.input_schema = { type: "object" };
  delete tool.strict;
};

/**
 * `NormalizeClaudeToolPropertyNamesDoc`: applies the schema fallback to every client tool in `tools[]` or in an inline
 * `tool_addition` definition whose `input_schema` has a property key Claude rejects. Other tools are left unchanged.
 */
export const normalizeClaudeToolPropertyNames = (body: JsonObject): void => {
  if (isArr(body.tools)) {
    for (const tool of body.tools) {
      if (needsSchemaFallback(tool)) applySchemaFallback(tool);
    }
  }

  if (!isArr(body.messages)) return;

  for (const message of body.messages) {
    const content = get(message, "content");

    if (!isArr(content)) continue;

    for (const part of content) {
      if (
        str(get(part, "type")) !== "tool_addition" ||
        str(get(part, "tool.type")) !== "tool_definition"
      )
        continue;
      const definition = get(part, "tool.definition");

      if (needsSchemaFallback(definition)) applySchemaFallback(definition);
    }
  }
};
