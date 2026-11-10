/**
 * Lets payload `default` rules target a Claude `max_tokens` the caller never set.
 *
 * Go source: internal/runtime/executor/claude_executor.go (stripTranslatedDefaultMaxTokens).
 */
import { cloneJson, get, type Json, isJsonObject } from "@commissary/json";
import { Formats } from "@commissary/translation/formats";

/** Where each source protocol carries its output token limit. */
const LIMIT_PATHS = {
  [Formats.OpenAI]: ["max_tokens", "max_completion_tokens"],
  [Formats.OpenAIResponse]: ["max_output_tokens"],
  [Formats.Gemini]: ["generationConfig.maxOutputTokens"],
} as const satisfies Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * The translated original request the payload rules see (`original`): the translators fill `max_tokens` with the
 * model's default when the caller sent no limit, which would hide it from a `default` rule (those only fill absent
 * paths). Without an explicit limit in the caller's own protocol, the synthesized `max_tokens` is dropped from a copy.
 */
export const withoutTranslatedDefaultMaxTokens = (
  from: string,
  originalPayload: Json,
  originalTranslated: Json,
): Json => {
  const paths: ReadonlyArray<string> | undefined = Object.entries(LIMIT_PATHS).find(
    ([format]) => format === from,
  )?.[1];

  if (paths === undefined || !isJsonObject(originalTranslated)) return originalTranslated;

  // A null limit counts as omitted, like the translators treat it.
  if (
    paths.some(
      (path) => get(originalPayload, path) !== undefined && get(originalPayload, path) !== null,
    )
  )
    return originalTranslated;

  const copy = cloneJson(originalTranslated);

  if (isJsonObject(copy)) delete copy.max_tokens;

  return copy;
};
