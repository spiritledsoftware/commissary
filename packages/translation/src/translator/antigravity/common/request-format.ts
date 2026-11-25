/**
 * The native Antigravity wire format, applied as the last step of every Antigravity request translator.
 *
 * Go source: internal/translator/antigravity/gemini/antigravity_request_format.go and
 * `normalizeAntigravityMediaFieldsDocAt` in internal/translator/antigravity/gemini/antigravity_gemini_request.go.
 */
import { isJsonArray, isJsonObject, type Json, type JsonObject } from "@commissary/json";

const objectAt = (value: Json | undefined, key: string): JsonObject | undefined => {
  const item = isJsonObject(value) ? value[key] : undefined;

  return isJsonObject(item) ? item : undefined;
};

/** Moves `snake` to `camel` (unless `camel` is set already) and drops `snake`. */
const moveSnakeKeyToCamel = (target: JsonObject, snake: string, camel: string): void => {
  const value = target[snake];

  if (value === undefined) return;

  if (!Object.hasOwn(target, camel)) target[camel] = value;
  delete target[snake];
};

/** The part has a snake_case media field, or a camelCase one with snake_case members. */
const mediaNeedsNormalization = (part: JsonObject, snake: string, camel: string): boolean => {
  if (Object.hasOwn(part, snake)) return true;

  if (!Object.hasOwn(part, camel)) return false;
  const media = objectAt(part, camel);

  return (
    media !== undefined &&
    (Object.hasOwn(media, "mime_type") ||
      (camel === "fileData" && Object.hasOwn(media, "file_uri")))
  );
};

/** Renames the media field and its members to camelCase. */
const normalizeMediaField = (part: JsonObject, snake: string, camel: string): void => {
  moveSnakeKeyToCamel(part, snake, camel);
  const media = objectAt(part, camel);

  if (media === undefined) return;
  moveSnakeKeyToCamel(media, "mime_type", "mimeType");

  if (camel === "fileData") moveSnakeKeyToCamel(media, "file_uri", "fileUri");
};

/** Normalizes the media fields of `parts`, and of the parts nested in their function responses. */
const normalizeMediaParts = (parts: Json | undefined): void => {
  if (!isJsonArray(parts)) return;

  for (const part of parts) {
    if (!isJsonObject(part)) continue;

    if (mediaNeedsNormalization(part, "inline_data", "inlineData"))
      normalizeMediaField(part, "inline_data", "inlineData");

    if (mediaNeedsNormalization(part, "file_data", "fileData"))
      normalizeMediaField(part, "file_data", "fileData");

    normalizeMediaParts(objectAt(part, "functionResponse")?.["parts"]);
  }
};

/**
 * `normalizeAntigravityMediaFieldsDocAt`: inline and file data parts (in the contents, the system instruction and
 * function response parts) carry Antigravity's camelCase names (CLIProxyAPI 08098d24).
 */
export const normalizeAntigravityMediaFields = (request: Json | undefined): void => {
  const contents = isJsonObject(request) ? request["contents"] : undefined;

  if (isJsonArray(contents))
    for (const content of contents)
      normalizeMediaParts(isJsonObject(content) ? content["parts"] : undefined);

  normalizeMediaParts(objectAt(request, "systemInstruction")?.["parts"]);
};

/**
 * `normalizeAntigravitySystemInstructionDoc`: the system instruction is a user turn, and one of text parts only is
 * joined into a single part (blank texts dropped; none left drops the instruction).
 */
const normalizeSystemInstruction = (request: JsonObject): void => {
  const instruction = objectAt(request, "systemInstruction");

  if (instruction === undefined) return;
  instruction["role"] = "user";
  const parts = instruction["parts"];

  if (!isJsonArray(parts) || parts.length === 0) return;
  const texts: string[] = [];

  for (const part of parts) {
    const text = isJsonObject(part) ? part["text"] : undefined;

    if (typeof text !== "string") return;

    if (text !== "") texts.push(text);
  }

  if (texts.length === 0) {
    delete request["systemInstruction"];

    return;
  }

  instruction["parts"] = [{ text: texts.join("\n\n") }];
};

/**
 * `normalizeAntigravityFunctionResponseResultsDoc`: a function response that is only a string `result` sends it as
 * `output`.
 */
const normalizeFunctionResponseResults = (request: JsonObject): void => {
  const contents = request["contents"];

  if (!isJsonArray(contents)) return;

  for (const content of contents) {
    const parts = isJsonObject(content) ? content["parts"] : undefined;

    if (!isJsonArray(parts)) continue;

    for (const part of parts) {
      for (const field of ["functionResponse", "function_response"]) {
        const response = objectAt(objectAt(part, field), "response");

        if (
          response === undefined ||
          typeof response["result"] !== "string" ||
          Object.keys(response).length !== 1
        )
          continue;
        response["output"] = response["result"];
        delete response["result"];
      }
    }
  }
};

/** `NormalizeAntigravityRequestDoc`: the native wire format of the envelope's `request` (CLIProxyAPI 38067a29). */
export const normalizeAntigravityRequest = (root: Json): Json => {
  const request = objectAt(root, "request");

  if (request === undefined) return root;
  normalizeSystemInstruction(request);
  normalizeFunctionResponseResults(request);

  return root;
};
