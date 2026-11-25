/**
 * Gemini (v1beta) client -> Gemini provider: request normalisation and passthrough responses.
 *
 * Go source: internal/translator/gemini/gemini/{init.go,gemini_gemini_request.go,gemini_gemini_response.go}.
 */
import {
  asString,
  del,
  exists,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  set,
} from "@commissary/json";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";
import { contentHasGeminiFunctionResponse, geminiTokenCountJson } from "../common/contents.ts";
import { normalizeJsonSchemaNumericConstraints } from "../../common/schema.ts";
import { attachDefaultSafetySettings } from "../common/safety.ts";
import { sanitizeGeminiRequestThoughtSignatures } from "../common/signature.ts";

const nextGeminiRole = (previousRole: string): string =>
  previousRole === "" || previousRole === "model" ? "user" : "model";

/** `util.RenameKey` (new key is appended, the old one removed). */
export const renameKey = (root: Json, oldPath: string, newPath: string): Json => {
  const value = get(root, oldPath);

  if (value === undefined) return root;
  set(root, newPath, value);

  return del(root, oldPath);
};

/** Renames `functionDeclarations` -> `function_declarations` and `parameters` -> `parametersJsonSchema`. */
const normalizeTools = (body: Json): void => {
  const tools = get(body, "tools");

  if (!isJsonArray(tools)) return;

  for (const tool of tools) {
    if (!isJsonObject(tool)) continue;

    if (exists(tool, "functionDeclarations")) {
      // SAFETY: `exists(tool, "functionDeclarations")` was checked above, so the key is present; the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      tool["function_declarations"] = tool["functionDeclarations"] as Json;
      delete tool["functionDeclarations"];
    }

    const declarations = tool["function_declarations"];

    if (!isJsonArray(declarations)) continue;

    for (const declaration of declarations) {
      if (!isJsonObject(declaration)) continue;
      const parameters = declaration["parameters"];
      const parametersJsonSchema = declaration["parametersJsonSchema"];
      const snakeParametersJsonSchema = declaration["parameters_json_schema"];

      // String-encoded numeric constraints become numbers and numeric protobuf types become type names: the JSON
      // Schema carrier needs them as such.
      if (parameters !== undefined) {
        declaration["parametersJsonSchema"] = normalizeJsonSchemaNumericConstraints(parameters);
        delete declaration["parameters"];
      } else if (parametersJsonSchema !== undefined) {
        declaration["parametersJsonSchema"] =
          normalizeJsonSchemaNumericConstraints(parametersJsonSchema);
      } else if (snakeParametersJsonSchema !== undefined) {
        declaration["parameters_json_schema"] =
          normalizeJsonSchemaNumericConstraints(snakeParametersJsonSchema);
      }
    }
  }
};

/** The protobuf and JSON Schema response schema keys of each generation config casing. */
const RESPONSE_SCHEMA_KEYS = [
  {
    container: "generationConfig",
    proto: ["responseSchema", "response_schema"],
    json: ["responseJsonSchema", "response_json_schema"],
  },
  {
    container: "generation_config",
    proto: ["response_schema", "responseSchema"],
    json: ["response_json_schema", "responseJsonSchema"],
  },
] as const;

/**
 * The response schema of each generation config casing moves to the JSON Schema carrier, normalized: the protobuf
 * `responseSchema` (either casing) becomes the config's own casing of `responseJsonSchema`, and an existing JSON Schema
 * carrier is normalized in place (Go 531aea15).
 */
const normalizeResponseSchemas = (body: Json): void => {
  for (const { container, proto, json } of RESPONSE_SCHEMA_KEYS) {
    const config = get(body, container);

    if (!isJsonObject(config)) continue;
    const protoKey = proto.find((key) => config[key] !== undefined);
    const protoSchema = protoKey === undefined ? undefined : config[protoKey];

    if (protoKey !== undefined && protoSchema !== undefined) {
      config[json[0]] = normalizeJsonSchemaNumericConstraints(protoSchema);
      delete config[protoKey];
      continue;
    }

    const jsonKey = json.find((key) => config[key] !== undefined);
    const jsonSchema = jsonKey === undefined ? undefined : config[jsonKey];

    if (jsonKey !== undefined && jsonSchema !== undefined)
      config[jsonKey] = normalizeJsonSchemaNumericConstraints(jsonSchema);
  }
};

/** `backfillEmptyFunctionResponseNames`: empty functionResponse names take the preceding call names in order. */
export const backfillEmptyFunctionResponseNames = (body: Json): Json => {
  const contents = get(body, "contents");

  if (!isJsonArray(contents)) return body;
  let pending: string[] = [];

  for (const content of contents) {
    if (asString(get(content, "role")) === "model") {
      const parts = get(content, "parts");
      pending = isJsonArray(parts)
        ? parts
            .filter((part) => exists(part, "functionCall"))
            .map((part) => asString(get(part, "functionCall.name")))
        : [];
      continue;
    }

    if (pending.length === 0) continue;
    let responseIndex = 0;
    const parts = get(content, "parts");

    if (isJsonArray(parts)) {
      for (const part of parts) {
        if (!exists(part, "functionResponse")) continue;

        if (
          asString(get(part, "functionResponse.name")).trim() === "" &&
          responseIndex < pending.length
        ) {
          // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
          set(part, "functionResponse.name", pending[responseIndex] as string);
        }

        responseIndex++;
      }
    }

    pending = [];
  }

  return body;
};

/** `ConvertGeminiRequestToGemini`: role normalisation, tool field renames, signature sanitising, safety defaults. */
export const convertGeminiRequestToGemini = (
  _model: string,
  body: Json,
  _stream: boolean,
): Json => {
  const contents = get(body, "contents");

  if (contents === undefined) return attachDefaultSafetySettings(body, "safetySettings");

  normalizeTools(body);

  if (isJsonArray(contents)) {
    let prevRole = "";

    for (const content of contents) {
      let role = asString(get(content, "role"));

      if (role !== "user" && role !== "model") {
        role = contentHasGeminiFunctionResponse(content) ? "user" : nextGeminiRole(prevRole);

        if (isJsonObject(content)) content["role"] = role;
      }

      prevRole = role;
    }
  }

  sanitizeGeminiRequestThoughtSignatures(body, "contents");

  normalizeResponseSchemas(body);

  backfillEmptyFunctionResponseNames(body);

  return attachDefaultSafetySettings(body, "safetySettings");
};

/** `PassthroughGeminiResponseStream`: strips `data:` and swallows `[DONE]`. */
export const passthroughGeminiResponseStream = (
  _context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const payload = line.startsWith("data:") ? line.slice(5).trim() : line;

  return payload === "[DONE]" ? [] : [payload];
};

export const passthroughGeminiResponseNonStream = (
  _context: ResponseContext,
  body: string,
): string => body;

export const geminiToGeminiResponse: ResponseTransform = {
  stream: passthroughGeminiResponseStream,
  nonStream: passthroughGeminiResponseNonStream,
  tokenCount: geminiTokenCountJson,
};
