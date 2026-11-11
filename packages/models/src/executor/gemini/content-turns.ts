/**
 * Boundary user turns for Gemini upstreams.
 *
 * Go source: internal/runtime/executor/helps/gemini_content_turns.go (EnsureGeminiLeadingUserContent,
 * EnsureGeminiTrailingUserContent, EnsureGeminiBoundaryUserContent, DropGeminiTrailingThoughtOnlyContent).
 */
import { asString, exists, get, isJsonArray, type Json } from "@commissary/json";
import { isGeminiThoughtPart } from "@commissary/translation";

/** Options of the trailing and boundary turns. */
export interface TrailingTurnOptions {
  /**
   * Drop trailing thought-only model turns before the trailing user turn is considered (Vertex and Antigravity reject a
   * request that ends with one; CLIProxyAPI a2718314, ceb4397f).
   */
  readonly dropThoughtOnlyTail?: boolean;
}

const emptyUserTurn = (): Json => ({ role: "user", parts: [{ text: "" }] });

/** A leading `model` turn gets an empty user turn in front of it. */
export const ensureGeminiLeadingUserContent = (body: Json, path = "contents"): Json => {
  const contents = get(body, path);

  if (!isJsonArray(contents) || contents.length === 0) return body;

  if (asString(get(contents[0], "role")) !== "model") return body;
  contents.unshift(emptyUserTurn());

  return body;
};

const contentHasFunctionResponse = (content: Json | undefined): boolean => {
  const parts = get(content, "parts");

  return (
    isJsonArray(parts) &&
    parts.some((part) => exists(part, "functionResponse") || exists(part, "function_response"))
  );
};

/** `contentHasFunctionResponseMedia`: a functionResponse in the turn carries nested media parts. */
const contentHasFunctionResponseMedia = (content: Json | undefined): boolean => {
  const parts = get(content, "parts");

  return (
    isJsonArray(parts) &&
    parts.some((part) => {
      const nested = get(part, "functionResponse.parts");

      return (
        isJsonArray(nested) &&
        nested.some(
          (item) =>
            exists(item, "inlineData") ||
            exists(item, "inline_data") ||
            exists(item, "fileData") ||
            exists(item, "file_data"),
        )
      );
    })
  );
};

/**
 * A trailing `model`/`assistant` turn gets an empty user turn appended, unless it carries a functionResponse the model is
 * to answer. A functionResponse with nested media is the exception: Antigravity rejects it as the final turn with 400
 * INVALID_ARGUMENT (CLIProxyAPI 15d2148b, #6524). With `dropThoughtOnlyTail` the thought-only tail goes first.
 */
export const ensureGeminiTrailingUserContent = (
  body: Json,
  path = "contents",
  options: TrailingTurnOptions = {},
): Json => {
  if (options.dropThoughtOnlyTail === true) dropGeminiTrailingThoughtOnlyContent(body, path);
  const contents = get(body, path);

  if (!isJsonArray(contents) || contents.length === 0) return body;
  const last = contents[contents.length - 1];
  const role = asString(get(last, "role"));

  if (role !== "model" && role !== "assistant") return body;

  if (contentHasFunctionResponse(last) && !contentHasFunctionResponseMedia(last)) return body;
  contents.push(emptyUserTurn());

  return body;
};

const isThoughtOnlyModelTurn = (content: Json | undefined): boolean => {
  const role = asString(get(content, "role"));

  if (role !== "model" && role !== "assistant") return false;
  const parts = get(content, "parts");

  if (!isJsonArray(parts) || parts.length === 0) return false;

  return parts.every(
    (part) =>
      isGeminiThoughtPart(part) &&
      !exists(part, "functionCall") &&
      !exists(part, "functionResponse"),
  );
};

/**
 * Removes trailing model turns made only of thought parts, keeping at least one turn. Such a tail comes from a replayed
 * trailing reasoning item; Antigravity (#6530) and Vertex (#6630) reject a request that still ends with a model turn after
 * the synthetic empty user turn (CLIProxyAPI a2718314, ceb4397f).
 */
export const dropGeminiTrailingThoughtOnlyContent = (body: Json, path = "contents"): Json => {
  const contents = get(body, path);

  if (!isJsonArray(contents)) return body;

  while (contents.length > 1 && isThoughtOnlyModelTurn(contents[contents.length - 1]))
    contents.pop();

  return body;
};

/**
 * Leading, then trailing user turn. The thought-only tail is dropped after the leading turn is added (as Go does for
 * Vertex `generateContent`), so a conversation of thought-only model turns ends as `[emptyUser]` rather than the
 * rejected `[emptyUser, thought, emptyUser]`; Go's stream and Antigravity paths drop first and still send that shape.
 */
export const ensureGeminiBoundaryUserContent = (
  body: Json,
  path = "contents",
  options: TrailingTurnOptions = {},
): Json =>
  ensureGeminiTrailingUserContent(ensureGeminiLeadingUserContent(body, path), path, options);
