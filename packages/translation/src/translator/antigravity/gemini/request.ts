/**
 * Gemini client -> Antigravity provider (request).
 *
 * Go source: internal/translator/antigravity/gemini/antigravity_gemini_request.go.
 * Deviations: a request without `contents` is refused with a 400 `TranslationError` (Go returns an empty body that
 * the upstream rejects); Go's raw-byte optimisation paths are collapsed into direct edits of the parsed body (the
 * output is identical); logging is not ported.
 */
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
import { compatibleAntigravityClaudeThinkingSignature } from "../../../signature/claude.ts";
import { normalizeJsonSchemaNumericConstraints } from "../../common/schema.ts";
import { TranslationError } from "../../registry.ts";
import { contentHasGeminiFunctionResponse } from "../../gemini/common/contents.ts";
import { attachDefaultSafetySettings } from "../../gemini/common/safety.ts";
import { sanitizeGeminiRequestThoughtSignatures } from "../../gemini/common/signature.ts";
import { mapSanitizedFunctionName, sanitizedFunctionNameMap } from "../../common/tool-names.ts";

const DECLARATION_KEYS = ["functionDeclarations", "function_declarations"] as const;

const FUNCTION_NAME_FIELDS = [
  "functionCall",
  "functionResponse",
  "function_call",
  "function_response",
] as const;

interface FunctionCallGroup {
  readonly responsesNeeded: number;
  readonly callNames: string[];
}

const clone = <T extends Json>(value: T): T => structuredClone(value);

/** `normalizeAntigravityInlineDataPart`: an inlineData part with a mime type, or `undefined`. */
const normalizeInlineDataPart = (part: Json): JsonObject | undefined => {
  const inline = get(part, "inlineData") ?? get(part, "inline_data");

  if (inline === undefined) return undefined;
  const data = asString(get(inline, "data"));

  if (data === "") return undefined;
  let mimeType = asString(get(inline, "mimeType"));

  if (mimeType === "") mimeType = asString(get(inline, "mime_type"));

  // Cloud Code Assist ignores inlineData without mimeType.
  if (mimeType === "") mimeType = "image/png";

  return { inlineData: { mimeType, data } };
};

const attachInlineData = (response: Json, images: ReadonlyArray<JsonObject>): Json => {
  if (images.length === 0) return response;
  const target = clone(response);

  for (const image of images) set(target, "functionResponse.parts.-1", clone(image));

  return target;
};

/** `collectFunctionResponsesWithSiblingInlineData`. */
const collectFunctionResponses = (parts: Json | undefined): Json[] => {
  const responses: Json[] = [];
  let leadingImages: JsonObject[] = [];
  let current = -1;
  const items = isJsonArray(parts) ? parts : isJsonObject(parts) ? Object.values(parts) : [];

  for (const part of items) {
    if (exists(part, "functionResponse")) {
      responses.push(part);
      current = responses.length - 1;

      if (leadingImages.length > 0) {
        // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
        responses[current] = attachInlineData(responses[current] as Json, leadingImages);
        leadingImages = [];
      }

      continue;
    }

    const image = normalizeInlineDataPart(part);

    if (image === undefined) continue;

    if (current >= 0)
      // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      responses[current] = attachInlineData(responses[current] as Json, [image]);
    else leadingImages.push(image);
  }

  return responses;
};

/** `parseFunctionResponseRaw` for an object part: backfills an empty name with the matching call name. */
const functionResponsePart = (response: Json, fallbackName: string): Json => {
  if (isJsonObject(response)) {
    const name = asString(get(response, "functionResponse.name"));

    if (name.trim() === "" && fallbackName !== "")
      set(response, "functionResponse.name", fallbackName);

    return response;
  }

  return {
    functionResponse: {
      name: fallbackName === "" ? "unknown" : fallbackName,
      response: { result: asString(response) },
    },
  };
};

/** `fixCLIToolResponse`: groups function calls with their responses (responses become one `function` turn). */
const fixCliToolResponse = (root: Json): void => {
  const contents = get(root, "request.contents");

  if (contents === undefined)
    throw new TranslationError("antigravity: gemini request has no contents");
  let needsGrouping = false;
  let allObjects = true;

  const items = isJsonArray(contents)
    ? contents
    : isJsonObject(contents)
      ? Object.values(contents)
      : [];

  for (const content of items) {
    if (!isJsonObject(content)) {
      allObjects = false;
      continue;
    }

    const parts = get(content, "parts");
    const list = isJsonArray(parts) ? parts : isJsonObject(parts) ? Object.values(parts) : [];

    if (list.some((part) => exists(part, "functionResponse"))) {
      needsGrouping = true;
      break;
    }
  }

  if (isJsonArray(contents) && allObjects && !needsGrouping) return;

  const out: Json[] = [];
  const pendingGroups: FunctionCallGroup[] = [];
  let collected: Json[] = [];

  const appendResponses = (responses: Json[], callNames: string[]): void => {
    const parts = responses.map((response, index) =>
      functionResponsePart(response, callNames[index] ?? ""),
    );

    if (parts.length > 0) out.push({ parts, role: "function" });
  };

  for (const value of items) {
    const parts = get(value, "parts");
    const responses = collectFunctionResponses(parts);

    if (responses.length > 0) {
      collected.push(...responses);

      // SAFETY: the `&&` short-circuits unless `pendingGroups.length > 0`, so `pendingGroups[0]` exists; the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      while (
        pendingGroups.length > 0 &&
        collected.length >= (pendingGroups[0] as FunctionCallGroup).responsesNeeded
      ) {
        // SAFETY: the loop condition checked pendingGroups.length > 0.
        const group = pendingGroups.shift() as FunctionCallGroup;
        const groupResponses = collected.slice(0, group.responsesNeeded);
        collected = collected.slice(group.responsesNeeded);
        appendResponses(groupResponses, group.callNames);
      }

      continue;
    }

    if (!isJsonObject(value)) continue;

    if (asString(get(value, "role")) === "model") {
      const callNames: string[] = [];
      const list = isJsonArray(parts) ? parts : isJsonObject(parts) ? Object.values(parts) : [];

      for (const part of list)
        if (exists(part, "functionCall")) callNames.push(asString(get(part, "functionCall.name")));
      out.push(value);

      if (callNames.length > 0)
        pendingGroups.push({ responsesNeeded: callNames.length, callNames });
    } else {
      out.push(value);
    }
  }

  for (const group of pendingGroups) {
    if (collected.length >= group.responsesNeeded) {
      const groupResponses = collected.slice(0, group.responsesNeeded);
      collected = collected.slice(group.responsesNeeded);
      appendResponses(groupResponses, group.callNames);
    }
  }

  set(root, "request.contents", out);
};

/** `normalizeGeminiGenerationConfigResponseSchema`. */
const normalizeResponseSchema = (root: Json): void => {
  for (const container of ["request.generationConfig", "request.generation_config"]) {
    if (!exists(root, container)) continue;

    for (const schemaKey of ["responseJsonSchema", "response_json_schema"]) {
      const oldPath = `${container}.${schemaKey}`;
      const schema = get(root, oldPath);

      if (schema === undefined) continue;
      const target = `${container}.responseSchema`;

      if (!exists(root, target)) set(root, target, schema);
      del(root, oldPath);
    }
  }
};

const normalizeRoles = (root: Json): void => {
  const contents = get(root, "request.contents");

  if (!isJsonArray(contents)) return;

  if (contents.every((content) => ["user", "model"].includes(asString(get(content, "role")))))
    return;
  let previousRole = "";

  for (const content of contents) {
    let role = asString(get(content, "role"));

    if (role !== "user" && role !== "model") {
      if (contentHasGeminiFunctionResponse(content)) role = "user";
      else if (previousRole === "" || previousRole === "model") role = "user";
      else role = "model";

      if (isJsonObject(content)) content["role"] = role;
    }

    previousRole = role;
  }
};

const normalizeTools = (root: Json, nameMap: ReadonlyMap<string, string> | undefined): void => {
  const tools = get(root, "request.tools");

  if (!isJsonArray(tools)) return;
  const seen = new Set<string>();

  for (const tool of tools) {
    if (!isJsonObject(tool)) continue;

    for (const key of DECLARATION_KEYS) {
      const declarations = tool[key];

      if (!isJsonArray(declarations)) continue;
      const kept: Json[] = [];

      for (const declaration of declarations) {
        const original = asString(get(declaration, "name"));
        const mapped = mapSanitizedFunctionName(nameMap, original);

        if (mapped !== "") {
          if (seen.has(mapped)) continue;
          seen.add(mapped);
        }

        if (isJsonObject(declaration)) {
          if (typeof declaration["name"] !== "string" || mapped !== original)
            declaration["name"] = mapped;

          const parameters = declaration["parameters"];
          const parametersJsonSchema = declaration["parametersJsonSchema"];

          // String-encoded numeric constraints become numbers: the JSON Schema carrier needs them as such.
          if (parameters !== undefined) {
            declaration["parametersJsonSchema"] = normalizeJsonSchemaNumericConstraints(parameters);
            delete declaration["parameters"];
          } else if (parametersJsonSchema !== undefined) {
            declaration["parametersJsonSchema"] =
              normalizeJsonSchemaNumericConstraints(parametersJsonSchema);
          }
        }

        kept.push(declaration);
      }

      tool[key] = kept;
    }
  }

  removeEmptyFunctionTools(root);
};

/** `removeEmptyGeminiFunctionTools`. */
const removeEmptyFunctionTools = (root: Json): void => {
  const tools = get(root, "request.tools");

  if (!isJsonArray(tools)) return;

  if (tools.length === 0) {
    del(root, "request.tools");

    return;
  }

  let changed = false;
  const cleaned: Json[] = [];

  for (const tool of tools) {
    if (isJsonObject(tool)) {
      for (const key of DECLARATION_KEYS) {
        const declarations = tool[key];

        if (isJsonArray(declarations) && declarations.length === 0) {
          delete tool[key];
          changed = true;
        }
      }

      if (Object.keys(tool).length === 0) {
        changed = true;
        continue;
      }
    }

    cleaned.push(tool);
  }

  if (!changed) return;

  if (cleaned.length === 0) del(root, "request.tools");
  else set(root, "request.tools", cleaned);
};

const rewriteFunctionNames = (
  root: Json,
  nameMap: ReadonlyMap<string, string> | undefined,
): void => {
  const contents = get(root, "request.contents");

  if (isJsonArray(contents)) {
    for (const content of contents) {
      const parts = get(content, "parts");

      if (!isJsonArray(parts)) continue;

      for (const part of parts) {
        if (!isJsonObject(part)) continue;

        for (const field of FUNCTION_NAME_FIELDS) {
          const nameResult = get(part, `${field}.name`);
          const name = asString(nameResult);

          if (name === "") continue;
          const mapped = mapSanitizedFunctionName(nameMap, name);

          if (typeof nameResult === "string" && mapped === name) continue;
          set(part, `${field}.name`, mapped);
        }
      }
    }
  }

  for (const allowedPath of [
    "request.toolConfig.functionCallingConfig.allowedFunctionNames",
    "request.tool_config.function_calling_config.allowed_function_names",
  ]) {
    const allowed = get(root, allowedPath);

    if (!isJsonArray(allowed)) continue;
    let changed = false;

    const mappedNames = allowed.map((name) => {
      const mapped = mapSanitizedFunctionName(nameMap, asString(name));
      changed = changed || typeof name !== "string" || mapped !== name;

      return mapped;
    });

    if (changed) set(root, allowedPath, mappedNames);
  }
};

const SIGNATURE_KEY_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ["thoughtSignature"],
  ["thought_signature"],
  ["functionCall", "thoughtSignature"],
  ["functionCall", "thought_signature"],
  ["functionResponse", "thoughtSignature"],
  ["functionResponse", "thought_signature"],
  ["extra_content", "google", "thought_signature"],
];

const valueAtPath = (value: Json | undefined, path: ReadonlyArray<string>): Json | undefined => {
  let current: Json | undefined = value;

  for (const key of path) {
    if (!isJsonObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }

  return current;
};

const hasKeyAtPath = (value: Json, path: ReadonlyArray<string>): boolean =>
  valueAtPath(value, path) !== undefined;

type PartSignatureResult = { signature: string; hasString: boolean };

const partSignature = (part: Json): PartSignatureResult => {
  for (const path of SIGNATURE_KEY_PATHS) {
    const value = valueAtPath(part, path);

    if (typeof value === "string") return { signature: value, hasString: true };
  }

  return { signature: "", hasString: false };
};

const deleteSignatureFields = (part: JsonObject): void => {
  for (const path of SIGNATURE_KEY_PATHS) {
    const parent = path.length === 1 ? part : valueAtPath(part, path.slice(0, -1));

    if (isJsonObject(parent))
      // SAFETY: every entry of SIGNATURE_KEY_PATHS is a non-empty path, so its last segment exists; the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      delete parent[path[path.length - 1] as string];
  }
};

/** `antigravityClaudeGeminiPartHasThoughtSignatureKeyInRaw`: a signature key anywhere inside the part. */
const hasSignatureKeyAnywhere = (value: Json): boolean => {
  if (isJsonArray(value)) return value.some(hasSignatureKeyAnywhere);

  if (!isJsonObject(value)) return false;

  return Object.entries(value).some(
    ([key, item]) =>
      key === "thoughtSignature" || key === "thought_signature" || hasSignatureKeyAnywhere(item),
  );
};

/** `SanitizeAntigravityClaudeGeminiRequestSignatures`: Claude-target replay rules for Gemini-format parts. */
export const sanitizeAntigravityClaudeGeminiRequestSignatures = (root: Json): Json => {
  const contents = get(root, "request.contents");

  if (!isJsonArray(contents)) return root;
  let changed = false;
  const rewritten: Json[] = [];

  for (const content of contents) {
    const parts = get(content, "parts");

    if (!isJsonArray(parts)) {
      rewritten.push(content);
      continue;
    }

    const isModelTurn = asString(get(content, "role")) === "model";
    let contentChanged = false;
    const rewrittenParts: Json[] = [];

    for (const part of parts) {
      if (!isJsonObject(part)) {
        rewrittenParts.push(part);
        continue;
      }

      const { signature, hasString } = partSignature(part);

      const hasKey =
        hasString ||
        SIGNATURE_KEY_PATHS.some((path) => hasKeyAtPath(part, path)) ||
        hasSignatureKeyAnywhere(part);

      const rewriteWithoutSignature = (): void => {
        changed = true;
        contentChanged = true;
        const copy = clone(part);
        deleteSignatureFields(copy);
        rewrittenParts.push(copy);
      };

      if (Object.hasOwn(part, "functionResponse") || Object.hasOwn(part, "function_response")) {
        if (hasKey) rewriteWithoutSignature();
        else rewrittenParts.push(part);
        continue;
      }

      if (!isModelTurn) {
        if (hasKey) rewriteWithoutSignature();
        else rewrittenParts.push(part);
        continue;
      }

      if (part["thought"] === true) {
        const normalized = compatibleAntigravityClaudeThinkingSignature(signature);

        if (normalized === undefined) {
          changed = true;
          contentChanged = true;
          continue;
        }

        const text = typeof part["text"] === "string" ? part["text"] : "";

        if (text.trim() === "") {
          changed = true;
          contentChanged = true;
          continue;
        }

        if (normalized !== signature) {
          changed = true;
          contentChanged = true;
        }

        const copy = clone(part);
        deleteSignatureFields(copy);
        copy["thoughtSignature"] = normalized;
        rewrittenParts.push(copy);
        continue;
      }

      if (hasKey) rewriteWithoutSignature();
      else rewrittenParts.push(part);
    }

    if (rewrittenParts.length === 0) {
      changed = true;
      continue;
    }

    if (contentChanged || rewrittenParts.length !== parts.length) {
      if (isJsonObject(content)) content["parts"] = rewrittenParts;
    }

    rewritten.push(content);
  }

  if (!changed) return root;

  return set(root, "request.contents", rewritten);
};

/** `ConvertGeminiRequestToAntigravity`. */
export const convertGeminiRequestToAntigravity = (
  modelName: string,
  body: Json,
  _stream: boolean,
): Json => {
  const nameMap = sanitizedFunctionNameMap(body);
  const root: Json = { project: "", request: body, model: modelName };

  if (exists(root, "request.model")) del(root, "request.model");

  fixCliToolResponse(root);

  const systemInstruction = get(root, "request.system_instruction");

  if (systemInstruction !== undefined) {
    set(root, "request.systemInstruction", systemInstruction);
    del(root, "request.system_instruction");
  }

  normalizeResponseSchema(root);
  normalizeRoles(root);
  normalizeTools(root, nameMap);
  rewriteFunctionNames(root, nameMap);

  if (modelName.toLowerCase().includes("claude"))
    sanitizeAntigravityClaudeGeminiRequestSignatures(root);
  else sanitizeGeminiRequestThoughtSignatures(root, "request.contents");

  return attachDefaultSafetySettings(root, "request.safetySettings");
};
