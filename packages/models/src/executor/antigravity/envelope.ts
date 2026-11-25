/**
 * Antigravity request envelope: `geminiToAntigravity`, endpoint selection and schema sanitisation.
 *
 * Go source: internal/runtime/executor/antigravity_executor_request.go (`buildRequest` body part,
 * `geminiToAntigravityDocForAuth`, `sanitizeAntigravityRequestSchemas`, `generateStableSessionIDFromContentsForAuth`,
 * `resolveAntigravityRequestBaseURL`). Payload rules are applied by the executor after this module (never before).
 */
import { randomUUID } from "node:crypto";
import {
  asInt,
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
  cleanJsonSchemaForAntigravityClaudeTool,
  cleanJsonSchemaForAntigravityResponse,
  cleanJsonSchemaForAntigravityTool,
  lookupModelInfo,
  normalizeAntigravityRequest,
  normalizeJsonSchemaNumericConstraints,
} from "@commissary/translation";
import { applyAgentEnvelope } from "./agent-envelope.ts";
import {
  hashAntigravitySessionId,
  scopeAntigravitySessionIdForCredential,
} from "./derived-session.ts";
import { prepareClaudeStructuredOutput } from "./structured-output.ts";

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

/** `generateSessionID`: a random signed 64-bit decimal id. */
const generateSessionId = (): string =>
  BigInt.asIntN(64, BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 16)}`)).toString();

/**
 * `generateStableSessionIDFromContentsForAuth`: the first non-empty text of the first user turn that has one (every part
 * is scanned, CLIProxyAPI 18a03e40), hashed into a signed 64-bit id (55e5a7ea). With a credential the id is scoped to it
 * (3a24d03c); without contents the id is random.
 */
export const stableSessionId = (payload: Json, credentialId = ""): string => {
  let contents = get(payload, "request.contents");

  if (!isJsonArray(contents)) contents = get(payload, "contents");

  if (!isJsonArray(contents)) return generateSessionId();
  const credential = credentialId.trim();

  for (const content of contents) {
    if (asString(get(content, "role")) !== "user") continue;
    const parts = get(content, "parts");
    let text = "";

    if (isJsonArray(parts)) {
      for (const part of parts) {
        text = asString(get(part, "text"));

        if (text !== "") break;
      }
    }

    if (text === "") continue;

    return hashAntigravitySessionId(
      credential === ""
        ? text
        : `${text}\0${credential}\0cli-proxy-api:antigravity:content-session`,
    );
  }

  return generateSessionId();
};

const setIfDifferent = (payload: Json, path: string, value: string): void => {
  if (get(payload, path) !== value) set(payload, path, value);
};

export interface EnvelopeOptions {
  /** The credential the request goes out on: session ids are scoped to it. */
  readonly credentialId: string;
  /** The org of the request (the agent sessions' namespace). */
  readonly org: string;
  /**
   * The request's session identity already scoped to the credential (`AntigravitySessionIDForAuth`), empty without
   * one.
   */
  readonly sessionId?: string;
  /** The upstream model enum of the selected model, when known (`request.labels.model_enum`). */
  readonly modelEnum?: string;
  readonly now: number;
}

/** The completed envelope, and whether it uses the agent protocol (its key order and labels). */
export interface AntigravityEnvelope {
  readonly payload: Json;
  readonly isAgent: boolean;
}

/**
 * `geminiToAntigravityDocForAuth`: completes the translator's envelope with project, session, request ids and request
 * type. Returns a copy (the caller's payload is never mutated, da21f1e5) and whether the request uses the agent
 * protocol.
 */
export const geminiToAntigravity = (
  modelName: string,
  input: Json,
  projectId: string,
  options: EnvelopeOptions,
): AntigravityEnvelope => {
  const payload = structuredClone(input);
  setIfDifferent(payload, "model", modelName);
  setIfDifferent(payload, "userAgent", "antigravity");
  const isImageModel = modelName.toLowerCase().includes("image");
  let requestType = asString(get(payload, "requestType")).trim();

  if (requestType === "") {
    requestType = isImageModel ? "image_gen" : "agent";
    set(payload, "requestType", requestType);
  }

  if (projectId !== "") setIfDifferent(payload, "project", projectId);
  else del(payload, "project");

  const credentialId = options.credentialId.trim();
  const incoming = asString(get(payload, "request.sessionId")).trim();
  const scoped = options.sessionId?.trim() ?? "";

  // `scopeIncomingAntigravitySessionID`: the request's own session identity wins over the id the client sent.
  const scopeIncoming = (): string =>
    scoped !== "" ? scoped : scopeAntigravitySessionIdForCredential(credentialId, incoming);

  if (isImageModel) {
    if (asString(get(payload, "requestId")).trim() === "")
      set(payload, "requestId", `image_gen/${options.now}/${randomUUID()}/12`);

    if (incoming !== "" && credentialId !== "") set(payload, "request.sessionId", scopeIncoming());
  } else if (requestType === "web_search") {
    if (incoming !== "" && credentialId !== "") set(payload, "request.sessionId", scopeIncoming());
  } else {
    let sessionId = "";

    if (credentialId !== "") {
      if (scoped !== "" || incoming !== "") sessionId = scopeIncoming();
    } else sessionId = incoming === "" ? scoped : incoming;

    if (sessionId === "") sessionId = stableSessionId(payload, credentialId);
    set(payload, "request.sessionId", sessionId);

    if (requestType === "agent") {
      applyAgentEnvelope(payload, {
        org: options.org,
        credentialId,
        sessionId,
        modelName,
        ...(options.modelEnum === undefined ? {} : { modelEnum: options.modelEnum }),
        now: options.now,
      });
    } else if (asString(get(payload, "requestId")).trim() === "") {
      set(payload, "requestId", `${requestType}/${randomUUID()}`);
    }
  }

  del(payload, "request.safetySettings");
  const toolConfig = get(payload, "toolConfig");

  if (toolConfig !== undefined && !exists(payload, "request.toolConfig")) {
    set(payload, "request.toolConfig", toolConfig);
    del(payload, "toolConfig");
  }

  return { payload, isAgent: !isImageModel && requestType === "agent" };
};

const DECLARATION_KEYS = ["functionDeclarations", "function_declarations"] as const;

/**
 * The schema keys of a function declaration. Only the input `parameters` become Claude `custom.input_schema` upstream
 * (and need Claude's union flattening); the others describe the function's return value.
 */
const DECLARATION_SCHEMA_KEYS: ReadonlyArray<{
  readonly key: string;
  readonly parameters: boolean;
}> = [
  { key: "parameters", parameters: true },
  { key: "parametersJsonSchema", parameters: true },
  { key: "parameters_json_schema", parameters: true },
  { key: "response", parameters: false },
  { key: "responseJsonSchema", parameters: false },
  { key: "response_json_schema", parameters: false },
];

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
const cleanNestedToolSchema = (
  schema: Json,
  options: { readonly useAntigravitySchema: boolean; readonly flattenUnions: boolean },
): Json => {
  const { useAntigravitySchema, flattenUnions } = options;

  const clean = flattenUnions
    ? cleanJsonSchemaForAntigravityClaudeTool
    : cleanJsonSchemaForAntigravityTool;

  // Numeric protobuf types and string constraints are normalized first: the cleaner's own normalization does not reach
  // under the wrapper key (Go 531aea15).
  const wrapped: Json = { schema: structuredClone(normalizeJsonSchemaNumericConstraints(schema)) };
  const cleaned = clean(wrapped, useAntigravitySchema);

  return get(cleaned, "schema") ?? clean(structuredClone(schema), useAntigravitySchema);
};

/**
 * `sanitizeAntigravityRequestSchemas`: cleans only the locations that hold a JSON schema (never functionCall args of
 * the conversation history, which would corrupt replayed tool calls).
 */
export const sanitizeRequestSchemas = (
  payload: Json,
  options: { readonly useAntigravitySchema: boolean; readonly isClaudeModel?: boolean },
): Json => {
  const { useAntigravitySchema, isClaudeModel = false } = options;
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

          for (const { key, parameters } of DECLARATION_SCHEMA_KEYS) {
            const schema = declaration[key];

            // Only declaration parameter schemas become Claude `custom.input_schema` upstream, which rejects nested
            // multi-branch unions (CLIProxyAPI 5efe9758); function return schemas keep their unions like every other
            // response-side schema, and Gemini models (which share the Antigravity schema group) accept them too.
            if (isJsonObject(schema)) {
              declaration[key] = cleanNestedToolSchema(schema, {
                useAntigravitySchema,
                flattenUnions: isClaudeModel && parameters,
              });
            }
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
 * `CapAntigravityMaxOutputTokensDoc`: the output limit becomes `request.generationConfig.maxOutputTokens`, a smaller
 * positive caller limit (under either spelling) is kept, the `max_output_tokens` alias goes, and a Claude thinking
 * budget stays below the effective limit (CLIProxyAPI 16bcf5a0).
 */
export const capMaxOutputTokens = (payload: Json, limit: number, isClaudeModel: boolean): void => {
  if (limit <= 0) return;
  let effective = limit;

  for (const path of [
    "request.generationConfig.maxOutputTokens",
    "request.generationConfig.max_output_tokens",
  ]) {
    const value = get(payload, path);

    if (typeof value === "number" && Math.trunc(value) > 0 && Math.trunc(value) < effective)
      effective = Math.trunc(value);
  }

  del(payload, "request.generationConfig.max_output_tokens");
  set(payload, "request.generationConfig.maxOutputTokens", effective);

  if (!isClaudeModel) return;

  for (const budgetPath of [
    "request.generationConfig.thinkingConfig.thinkingBudget",
    "request.generationConfig.thinkingConfig.thinking_budget",
  ]) {
    const budget = get(payload, budgetPath);

    if (budget !== undefined && asInt(budget) >= effective) set(payload, budgetPath, effective - 1);
  }
};

/** How a model's schemas are cleaned (`antigravitySchemaSanitizationFlags`). */
export interface SchemaSanitizationFlags {
  readonly useAntigravitySchema: boolean;
  readonly isClaudeModel: boolean;
}

/** `antigravitySchemaSanitizationFlags`: model families are matched case-insensitively (CLIProxyAPI 18a03e40). */
export const schemaSanitizationFlags = (modelName: string): SchemaSanitizationFlags => {
  const lower = modelName.toLowerCase();
  const isClaudeModel = lower.includes("claude");

  return {
    isClaudeModel,
    useAntigravitySchema:
      isClaudeModel || lower.includes("gemini-3-pro") || lower.includes("gemini-3.1-pro"),
  };
};

/**
 * The model-dependent shaping of `buildRequest`: Claude 5.5 structured output as a prompt (CLIProxyAPI 1d45a5f3), the
 * output cap, schema cleaning, Claude `VALIDATED` function calling (skipped when the schema became a prompt). A thinking
 * variant the credential's catalog selected (`selectedMaxOutputTokens > 0`) is capped at its own limit and keeps
 * `maxOutputTokens`; otherwise the static catalog's limit caps a larger request, and non-Claude models lose
 * `maxOutputTokens`. The result still has to go through the payload rules.
 */
export const constrainRequestPayload = (
  modelName: string,
  payload: Json,
  selectedMaxOutputTokens = 0,
): Json => {
  const promptStructuredOutput = prepareClaudeStructuredOutput(modelName, payload);
  // The native wire format (`NormalizeAntigravityRequestDoc`, CLIProxyAPI 38067a29): a payload rule or the structured
  // output prompt may have added a system instruction the translator never saw.
  normalizeAntigravityRequest(payload);
  const lower = modelName.toLowerCase();
  const { useAntigravitySchema, isClaudeModel } = schemaSanitizationFlags(modelName);

  if (selectedMaxOutputTokens > 0) {
    capMaxOutputTokens(payload, selectedMaxOutputTokens, isClaudeModel);
  } else {
    const maxOut = get(payload, "request.generationConfig.maxOutputTokens");

    if (typeof maxOut === "number") {
      const info =
        lookupModelInfo(modelName, "antigravity") ??
        (lower === modelName ? undefined : lookupModelInfo(lower, "antigravity"));

      const limit = info?.maxCompletionTokens ?? 0;

      if (limit > 0 && Math.trunc(maxOut) > limit)
        capMaxOutputTokens(payload, limit, isClaudeModel);
    }
  }

  if (needsSchemaSanitization(payload))
    sanitizeRequestSchemas(payload, { useAntigravitySchema, isClaudeModel });

  if (isClaudeModel) {
    if (!promptStructuredOutput && !toolChoiceModeIsNone(payload))
      set(payload, "request.toolConfig.functionCallingConfig.mode", "VALIDATED");
  } else if (selectedMaxOutputTokens === 0)
    del(payload, "request.generationConfig.maxOutputTokens");

  return payload;
};

/**
 * `antigravityToolChoiceModeIsNoneDoc`: the request already turns function calling off (`NONE`, under the camelCase or
 * snake_case proto-JSON names), so `VALIDATED` must not turn it back on. A non-canonical `NONE` is canonicalized in
 * place (CLIProxyAPI e0cc1cf8).
 */
const toolChoiceModeIsNone = (payload: Json): boolean => {
  for (const container of ["request.toolConfig", "request.tool_config"]) {
    for (const key of ["functionCallingConfig", "function_calling_config"]) {
      const modePath = `${container}.${key}.mode`;
      const mode = get(payload, modePath);

      if (typeof mode === "string" && mode.trim().toUpperCase() === "NONE") {
        if (mode !== "NONE") set(payload, modePath, "NONE");

        return true;
      }
    }
  }

  return false;
};
