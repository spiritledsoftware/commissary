/**
 * Antigravity request envelope: `geminiToAntigravity`, endpoint selection and schema sanitisation.
 *
 * Go source: internal/runtime/executor/antigravity_executor_request.go (`buildRequest` body part,
 * `geminiToAntigravity`, `sanitizeAntigravityRequestSchemas`, `generateStableSessionID`,
 * `resolveAntigravityRequestBaseURL`). Payload rules are applied by the executor after this module (never before).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  asString,
  del,
  exists,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import {
  renameKey,
  cleanJsonSchemaForAntigravityResponse,
  cleanJsonSchemaForAntigravityTool,
  lookupModelInfo,
} from "@commissary/translation";

export const ANTIGRAVITY_BASE_URL_DAILY = "https://daily-cloudcode-pa.googleapis.com";

export const ANTIGRAVITY_GENERATE_PATH = "/v1internal:generateContent";

export const ANTIGRAVITY_STREAM_PATH = "/v1internal:streamGenerateContent";

export const ANTIGRAVITY_COUNT_TOKENS_PATH = "/v1internal:countTokens";

const attributeOrMetadata = (
  attributes: Readonly<Record<string, string>>,
  metadata: JsonObject,
  key: string,
): string => {
  const attribute = attributes[key]?.trim() ?? "";

  if (attribute !== "") return attribute;
  const value = metadata[key];

  return typeof value === "string" ? value.trim() : "";
};

/** `resolveCustomAntigravityBaseURL`: `base_url` attribute, then metadata (trailing slash trimmed). */
export const customBaseUrl = (
  attributes: Readonly<Record<string, string>>,
  metadata: JsonObject,
): string => attributeOrMetadata(attributes, metadata, "base_url").replace(/\/+$/, "");

/** `resolveAntigravityRequestBaseURL`: one endpoint, never a cross-tier fallback (daily by default). */
export const requestBaseUrl = (
  attributes: Readonly<Record<string, string>>,
  metadata: JsonObject,
): string => customBaseUrl(attributes, metadata) || ANTIGRAVITY_BASE_URL_DAILY;

/** The configured per-credential user agent (`antigravityConfiguredUserAgent`). */
export const configuredUserAgent = (
  attributes: Readonly<Record<string, string>>,
  metadata: JsonObject,
): string => attributeOrMetadata(attributes, metadata, "user_agent");

const generateSessionId = (): string => {
  const value =
    BigInt.asUintN(63, BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 16)}`)) %
    9_000_000_000_000_000_000n;

  return `-${value}`;
};

/** `generateStableSessionID`: the first user turn's first text hashed into a stable negative-looking id. */
export const stableSessionId = (payload: Json): string => {
  const contents = get(payload, "request.contents");

  if (!isJsonArray(contents)) return generateSessionId();

  for (const content of contents) {
    if (asString(get(content, "role")) !== "user") continue;
    const text = asString(get(content, "parts.0.text"));

    if (text === "") continue;
    const digest = createHash("sha256").update(text, "utf8").digest();

    return `-${digest.readBigUInt64BE(0) & 0x7fffffffffffffffn}`;
  }

  return generateSessionId();
};

const setIfDifferent = (payload: Json, path: string, value: string): void => {
  if (get(payload, path) !== value) set(payload, path, value);
};

/** `geminiToAntigravity`: completes the translator's envelope with project, request ids and request type. */
export const geminiToAntigravity = (
  modelName: string,
  payload: Json,
  projectId: string,
  derivedSessionId = "",
  now: number = Date.now(),
): Json => {
  setIfDifferent(payload, "model", modelName);
  setIfDifferent(payload, "userAgent", "antigravity");
  const isImageModel = modelName.includes("image");
  let requestType = asString(get(payload, "requestType")).trim();

  if (requestType === "") {
    requestType = isImageModel ? "image_gen" : "agent";
    set(payload, "requestType", requestType);
  }

  if (projectId !== "") setIfDifferent(payload, "project", projectId);
  else del(payload, "project");

  if (isImageModel) {
    set(payload, "requestId", `image_gen/${now}/${randomUUID()}/12`);
  } else if (requestType !== "web_search") {
    set(payload, "requestId", `agent-${randomUUID()}`);
    let sessionId = asString(get(payload, "request.sessionId")).trim();

    if (sessionId === "") sessionId = derivedSessionId.trim();

    if (sessionId === "") sessionId = stableSessionId(payload);
    set(payload, "request.sessionId", sessionId);
  }

  del(payload, "request.safetySettings");
  const toolConfig = get(payload, "toolConfig");

  if (toolConfig !== undefined && !exists(payload, "request.toolConfig")) {
    set(payload, "request.toolConfig", toolConfig);
    del(payload, "toolConfig");
  }

  return payload;
};

const DECLARATION_KEYS = ["functionDeclarations", "function_declarations"] as const;

const DECLARATION_SCHEMA_KEYS = [
  "parameters",
  "parametersJsonSchema",
  "parameters_json_schema",
  "response",
  "responseJsonSchema",
  "response_json_schema",
] as const;

const GENERATION_CONTAINERS = ["request.generationConfig", "request.generation_config"] as const;

const GENERATION_SCHEMA_KEYS = [
  "responseSchema",
  "responseJsonSchema",
  "response_schema",
  "response_json_schema",
] as const;

/** `antigravityRequestNeedsSchemaSanitization`. */
export const needsSchemaSanitization = (payload: Json): boolean => {
  if (exists(payload, "request.tools.0")) return true;

  return GENERATION_CONTAINERS.some((container) =>
    GENERATION_SCHEMA_KEYS.some((key) => exists(payload, `${container}.${key}`)),
  );
};

/**
 * `cleanNestedSchema`: the cleaner skips placeholder insertion for a top-level schema, but Claude's VALIDATED mode
 * needs every tool schema to declare a property, so the schema is cleaned nested one level down.
 */
const cleanNestedToolSchema = (schema: Json, useAntigravitySchema: boolean): Json => {
  const wrapped: Json = { schema: structuredClone(schema) };
  const cleaned = cleanJsonSchemaForAntigravityTool(wrapped, useAntigravitySchema);

  return (
    get(cleaned, "schema") ??
    cleanJsonSchemaForAntigravityTool(structuredClone(schema), useAntigravitySchema)
  );
};

/**
 * `sanitizeAntigravityRequestSchemas`: cleans only the locations that hold a JSON schema (never functionCall args of
 * the conversation history, which would corrupt replayed tool calls).
 */
export const sanitizeRequestSchemas = (payload: Json, useAntigravitySchema: boolean): Json => {
  const tools = get(payload, "request.tools");

  if (isJsonArray(tools)) {
    for (const tool of tools) {
      if (!isJsonObject(tool)) continue;

      for (const declKey of DECLARATION_KEYS) {
        const declarations = tool[declKey];

        if (!isJsonArray(declarations)) continue;

        for (const declaration of declarations) {
          if (!isJsonObject(declaration)) continue;

          if (exists(declaration, "parametersJsonSchema"))
            renameKey(declaration, "parametersJsonSchema", "parameters");

          for (const key of DECLARATION_SCHEMA_KEYS) {
            const schema = declaration[key];

            if (isJsonObject(schema))
              declaration[key] = cleanNestedToolSchema(schema, useAntigravitySchema);
          }
        }
      }
    }
  }

  for (const container of GENERATION_CONTAINERS) {
    const generationConfig = get(payload, container);

    if (!isJsonObject(generationConfig)) continue;

    for (const key of GENERATION_SCHEMA_KEYS) {
      const schema = generationConfig[key];

      if (isJsonObject(schema))
        generationConfig[key] = cleanJsonSchemaForAntigravityResponse(structuredClone(schema));
    }
  }

  return payload;
};

/**
 * The model-dependent shaping of `buildRequest`: `maxOutputTokens` cap, schema cleaning, Claude `VALIDATED` function
 * calling (non-Claude models lose `maxOutputTokens`). The result still has to go through the payload rules.
 */
export const constrainRequestPayload = (modelName: string, payload: Json): Json => {
  const maxOut = get(payload, "request.generationConfig.maxOutputTokens");

  if (typeof maxOut === "number") {
    const info = lookupModelInfo(modelName, "antigravity");

    const limit = info?.maxCompletionTokens ?? 0;

    if (limit > 0 && Math.trunc(maxOut) > limit)
      set(payload, "request.generationConfig.maxOutputTokens", limit);
  }

  const useAntigravitySchema =
    modelName.includes("claude") ||
    modelName.includes("gemini-3-pro") ||
    modelName.includes("gemini-3.1-pro");

  if (needsSchemaSanitization(payload)) sanitizeRequestSchemas(payload, useAntigravitySchema);

  if (modelName.includes("claude"))
    set(payload, "request.toolConfig.functionCallingConfig.mode", "VALIDATED");
  else del(payload, "request.generationConfig.maxOutputTokens");

  return payload;
};
