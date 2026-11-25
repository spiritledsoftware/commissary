/**
 * Responses `configuration_update` input items.
 *
 * Go source: internal/thinking/configuration_update.go.
 */
import { get, isJsonArray, isJsonObject, type Json } from "@commissary/json";
import { hasLevel } from "./convert.ts";
import type { ThinkingError } from "./errors.ts";
import { delPath, getString, isEmptyObject, normalize, setPath } from "./json.ts";
import { autoConfig, EMPTY_CONFIG, isUserDefinedModel, levelConfig, noneConfig } from "./types.ts";
import type { ProviderApplier, ThinkingConfig, ThinkingModelInfo } from "./types.ts";
import { validateConfig } from "./validate.ts";

export const isResponsesFormat = (format: string): boolean =>
  format === "codex" || format === "openai-response";

/** The last nonempty `reasoning.effort` among `configuration_update` items of `input`. */
export const extractConfigurationUpdateConfig = (body: Json | undefined): ThinkingConfig => {
  const input = get(body, "input");

  if (!isJsonArray(input)) return EMPTY_CONFIG;

  let effort = "";

  for (const item of input) {
    if (getString(item, "type") !== "configuration_update") continue;
    const value = get(item, "reasoning.effort");

    if (typeof value === "string") {
      const normalized = normalize(value);

      if (normalized !== "") effort = normalized;
    }
  }

  switch (effort) {
    case "":
      return EMPTY_CONFIG;
    case "none":
      return noneConfig();
    case "auto":
      return autoConfig();
    default:
      return levelConfig(effort);
  }
};

/** Removes unsupported `configuration_update` input items without touching other items. */
export const stripConfigurationUpdates = (body: Json | undefined): Json | undefined => {
  if (!isJsonObject(body)) return body;
  const input = body["input"];

  if (!isJsonArray(input)) return body;
  const kept = input.filter((item) => getString(item, "type") !== "configuration_update");

  if (kept.length !== input.length) body["input"] = kept;

  return body;
};

/** Removes `reasoning.effort` (and an emptied `reasoning`), leaving summary and unrelated fields intact. */
export const stripResponsesEffort = (body: Json | undefined): Json | undefined => {
  if (body === undefined || get(body, "reasoning.effort") === undefined) return body;
  const result = delPath(body, "reasoning.effort");

  return isEmptyObject(get(result, "reasoning")) ? delPath(result, "reasoning") : result;
};

/** The body with its native Responses efforts validated, or the validation error and the body so far. */
export interface NativeEffortResult {
  readonly body: Json | undefined;
  readonly error?: ThinkingError | undefined;
}

/**
 * Validates each native Responses effort (the top-level baseline unless a thinking suffix replaces it, and every
 * `configuration_update`) without collapsing the timeline: an effort the model does not list is validated and
 * rewritten with the provider's output rules (for example `none` to the lowest level of a model that cannot turn
 * thinking off), and an invalid one is an error. Models without levels, and user-defined ones, pass through.
 */
export const normalizeNativeResponsesEffort = (
  body: Json | undefined,
  modelInfo: ThinkingModelInfo | undefined,
  applier: ProviderApplier,
  fromFormat: string,
  toFormat: string,
  skipBaseline: boolean,
): NativeEffortResult => {
  const levels = modelInfo?.thinking?.levels ?? [];

  if (body === undefined || isUserDefinedModel(modelInfo) || levels.length === 0) return { body };

  const paths = skipBaseline ? [] : ["reasoning.effort"];
  const input = get(body, "input");

  if (isJsonArray(input)) {
    input.forEach((item, index) => {
      if (getString(item, "type") === "configuration_update")
        paths.push(`input.${index}.reasoning.effort`);
    });
  }

  let result: Json | undefined = body;

  for (const path of paths) {
    const effort = get(result, path);

    if (typeof effort !== "string" || effort.trim() === "" || hasLevel(levels, effort)) continue;

    const validation = validateConfig(
      levelConfig(normalize(effort)),
      modelInfo,
      fromFormat,
      toFormat,
      false,
    );

    if (validation.error !== undefined) return { body: result, error: validation.error };

    const value = get(applier.apply({}, validation.config, modelInfo), "reasoning.effort");

    if (typeof value === "string" && value !== effort) result = setPath(result, path, value);
  }

  return { body: result };
};
