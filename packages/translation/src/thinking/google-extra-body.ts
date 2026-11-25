/**
 * Gemini thinking fields on OpenAI Chat requests: `generationConfig`/`generation_config` first, then
 * `extra_body.google.thinking_config` (also nested `extra_body.extra_body.google`, and a top-level `google`), each in
 * snake_case or camelCase.
 *
 * Go source: internal/thinking/google_extra_body.go.
 */
import { asInt, get, isJsonObject, type Json } from "@commissary/json";
import { autoConfig, budgetConfig, EMPTY_CONFIG, levelConfig, noneConfig } from "./types.ts";
import type { ThinkingConfig } from "./types.ts";

/** A level (lower case, trimmed, non-empty) and/or a numeric budget; both absent when nothing was found. */
interface GoogleThinkingFields {
  readonly level?: string | undefined;
  readonly budget?: number | undefined;
}

const NONE: GoogleThinkingFields = {};

const found = (fields: GoogleThinkingFields): boolean =>
  fields.level !== undefined || fields.budget !== undefined;

const fieldsFromConfig = (config: Json | undefined): GoogleThinkingFields => {
  if (!isJsonObject(config)) return NONE;
  let level: string | undefined;
  let budget: number | undefined;

  for (const key of ["thinking_level", "thinkingLevel"]) {
    const value = config[key];

    if (typeof value === "string" && value.trim() !== "") {
      level = value.trim().toLowerCase();
      break;
    }
  }

  for (const key of ["thinking_budget", "thinkingBudget"]) {
    const value = config[key];

    if (typeof value === "number") {
      budget = asInt(value);
      break;
    }
  }

  return { level, budget };
};

const firstFound = (container: Json | undefined, keys: readonly string[]): GoogleThinkingFields => {
  if (!isJsonObject(container)) return NONE;

  for (const key of keys) {
    const fields = fieldsFromConfig(container[key]);

    if (found(fields)) return fields;
  }

  return NONE;
};

const fromGoogleObject = (google: Json | undefined): GoogleThinkingFields =>
  firstFound(google, ["thinking_config", "thinkingConfig"]);

const fromExtraBody = (body: Json | undefined): GoogleThinkingFields => {
  const extraBody = get(body, "extra_body");

  if (isJsonObject(extraBody)) {
    const direct = fromGoogleObject(extraBody["google"]);

    if (found(direct)) return direct;
    const nested = fromGoogleObject(get(extraBody, "extra_body.google"));

    if (found(nested)) return nested;
  }

  return fromGoogleObject(get(body, "google"));
};

const fallbackFields = (body: Json | undefined): GoogleThinkingFields => {
  const camel = firstFound(get(body, "generationConfig"), ["thinkingConfig", "thinking_config"]);

  if (found(camel)) return camel;
  const snake = firstFound(get(body, "generation_config"), ["thinking_config", "thinkingConfig"]);

  return found(snake) ? snake : fromExtraBody(body);
};

/** The thinking config an OpenAI Chat request carries in Gemini's fields; the level wins over the budget. */
export const extractOpenAIGoogleThinkingConfig = (body: Json | undefined): ThinkingConfig => {
  const { level, budget } = fallbackFields(body);

  if (level !== undefined) {
    if (level === "none") return noneConfig();

    if (level === "auto") return autoConfig();

    return levelConfig(level);
  }

  if (budget === undefined) return EMPTY_CONFIG;

  if (budget === 0) return noneConfig();

  if (budget === -1) return autoConfig();

  return budgetConfig(budget);
};
