/**
 * The text of an OpenAI Responses message content part, shared by the Codex response translators.
 *
 * Go source: internal/translator/codex/openai/chat-completions/codex_openai_response.go,
 * codex/gemini/codex_gemini_response.go (the `refusal` cases of ca459712), codex/interactions/
 * interactions_codex_response.go (`codexContentText`).
 */
import { asString, get, type Json } from "@commissary/json";

export interface PartTextOptions {
  /**
   * Interactions' `codexContentText`: any part type is read, `content` is a further fallback, and only a non-empty JSON
   * string counts. Otherwise only `output_text` and `refusal` parts have text.
   */
  readonly anyPart?: boolean;
}

/**
 * A content part's text: a `refusal` part reads `refusal` first, then `text` (Go ca459712); an `output_text` part reads
 * `text`. With `anyPart` every part reads `text`, `content`, `refusal` in turn (`refusal`, `text`, `content` on a refusal
 * part) and the first non-empty string wins.
 */
export const responsesPartText = (
  part: Json | undefined,
  options: PartTextOptions = {},
): string => {
  const type = asString(get(part, "type"));
  const refusal = type === "refusal";

  if (options.anyPart !== true) {
    if (refusal) {
      const text = asString(get(part, "refusal"));

      return text !== "" ? text : asString(get(part, "text"));
    }

    return type === "output_text" ? asString(get(part, "text")) : "";
  }

  for (const path of refusal ? ["refusal", "text", "content"] : ["text", "content", "refusal"]) {
    const value = get(part, path);

    // SAFETY: only a JSON string counts (Go `value.Type == ojson.String`).
    if (typeof value === "string" && value !== "") return value;
  }

  return "";
};
