/**
 * Claude structured-output instruction (system reminder helpers live in claude-messages.ts).
 *
 * Go source: internal/translator/common/claude_system.go, internal/util/claude_attribution.go.
 */
import { get, type Json, type JsonObject } from "@commissary/json";
import { parseSuffix } from "../../thinking/suffix.ts";
import { exists, isObj, str } from "./gjson.ts";

const JSON_ONLY_SUFFIX =
  "Do not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object.";

const LEGACY_PREFIXES = ["claude-3", "claude-2", "claude-instant"];

const LEGACY_MODELS = new Set([
  "claude-opus-4",
  "claude-opus-4-0",
  "claude-opus-4-20250514",
  "claude-opus-4-latest",
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-opus-4-1-latest",
  "claude-sonnet-4",
  "claude-sonnet-4-0",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-latest",
]);

/**
 * `claudeModelLacksNativeStructuredOutputs`: an older Claude model without native `output_config.format`. Unknown and
 * future model ids count as supported.
 */
const lacksNativeStructuredOutputs = (modelName: string): boolean => {
  let model = parseSuffix(modelName).modelName.trim().toLowerCase();
  model = model.slice(model.lastIndexOf("/") + 1);
  const bracket = model.indexOf("[");

  if (bracket >= 0) model = model.slice(0, bracket);
  const at = model.indexOf("@");

  if (at >= 0) model = model.slice(0, at);
  model = model.trim();

  if (model === "") return false;
  const normalized = model.endsWith("-thinking") ? model.slice(0, -"-thinking".length) : model;

  return (
    LEGACY_MODELS.has(normalized) || LEGACY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
};

/**
 * `ClaudeOutputFormatSchema`: the schema of a json_schema structured-output setting (Chat Completions
 * `response_format` or Responses `text.format`), for Claude's native `output_config.format`. Undefined for other
 * formats, a missing or non-object schema, and legacy models, which keep the system prompt instruction.
 */
export const claudeOutputFormatSchema = (
  modelName: string,
  format: Json | undefined,
): JsonObject | undefined => {
  if (str(get(format, "type")).trim().toLowerCase() !== "json_schema") return undefined;

  if (lacksNativeStructuredOutputs(modelName)) return undefined;
  let schema = get(format, "json_schema.schema");

  if (!exists(schema)) schema = get(format, "schema");

  return isObj(schema) ? schema : undefined;
};

/** The trimmed schema name and description of a structured-output setting (`claudeStructuredOutputNameAndDescription`). */
interface SchemaLabels {
  readonly name: string;
  readonly desc: string;
}

const nameAndDescription = (format: Json | undefined): SchemaLabels => {
  const jsonSchema = get(format, "json_schema");

  return {
    name: str(get(jsonSchema, "name")).trim() || str(get(format, "name")).trim(),
    desc: str(get(jsonSchema, "description")).trim() || str(get(format, "description")).trim(),
  };
};

/**
 * `BuildClaudeOutputFormatDescription`: a short system instruction keeping the schema's name and description when
 * `output_config.format` carries the schema itself; empty without a description.
 */
export const buildClaudeOutputFormatDescription = (format: Json | undefined): string => {
  const { name, desc } = nameAndDescription(format);

  if (desc === "") return "";
  let out = "Your response must follow the JSON schema given as the output format.\n";

  if (name !== "") out += `Schema Name: ${name}\n`;

  return `${out}Schema Description: ${desc}`;
};

/**
 * `BuildClaudeStructuredOutputInstruction` plus `ClaudeOutputFormatSchema`: sets `output_config.format` on `out` when
 * the model takes the schema natively and returns the system instruction to add, if any.
 */
export const applyClaudeStructuredOutput = (
  out: JsonObject,
  modelName: string,
  format: Json | undefined,
): string => {
  const schema = claudeOutputFormatSchema(modelName, format);

  if (schema === undefined) return buildClaudeStructuredOutputInstruction(format);
  const outputConfig = isObj(out.output_config) ? out.output_config : {};
  outputConfig.format = { type: "json_schema", schema };
  out.output_config = outputConfig;

  return buildClaudeOutputFormatDescription(format);
};

/** `BuildClaudeStructuredOutputInstruction` for OpenAI `response_format`. */
export const buildClaudeStructuredOutputInstruction = (format: Json | undefined): string => {
  if (!exists(format)) return "";
  const formatType = str(get(format, "type")).trim().toLowerCase();

  switch (formatType) {
    case "json_object":
      return `You must format your entire response as a valid JSON object. ${JSON_ONLY_SUFFIX}`;
    case "json_schema": {
      const jsonSchema = get(format, "json_schema");
      let schema = get(jsonSchema, "schema");

      if (!exists(schema)) schema = get(format, "schema");

      if (!exists(schema))
        return `You must format your entire response as a valid JSON object. ${JSON_ONLY_SUFFIX}`;

      let out =
        "You must format your entire response as valid JSON that conforms strictly to the following JSON schema:\n";

      const { name, desc } = nameAndDescription(format);

      if (name !== "") out += `Schema Name: ${name}\n`;

      if (desc !== "") out += `Schema Description: ${desc}\n`;
      out += `JSON Schema:\n${JSON.stringify(schema)}\n${JSON_ONLY_SUFFIX}`;

      return out;
    }

    default:
      return "";
  }
};
