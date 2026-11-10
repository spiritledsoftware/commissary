/**
 * Codex tool schema normalisation.
 *
 * Go source: internal/runtime/executor/helps/codex_tool_schema.go (NormalizeCodexToolSchemas, IsCodexUserAgent) and
 * internal/client/codex/tool-schema/tool_schema.go (NormalizeCodexToolIntegerTypes). Bodies are parsed JSON mutated
 * in place.
 *  - {@link normalizeCodexToolSchemas}: collapses pure-constant `oneOf`/`anyOf` unions (>= 8 branches, e.g. MCP enums)
 *    into `enum`, drops regex patterns upstream validators reject and numeric bounds outside int64 (the backend
 *    answers those with HTTP 500, 57d005fe). Runs inside the Codex executor.
 *  - {@link normalizeCodexToolIntegerTypes}: `number` -> `integer` for the numeric fields of the Codex CLI's own
 *    tools; part of the payload barrier for Codex clients targeting non-Codex executors (see `payload.ts`).
 */
import { asString, get, isJsonArray, isJsonObject, type Json, set } from "@commissary/json";
import type { HeaderInput } from "../../config/payload/index.ts";
import {
  hasUnsupportedUnicodePropertyEscape,
  SCHEMA_MAP_KEYWORDS,
  SCHEMA_VALUE_KEYWORDS,
} from "@commissary/translation";

/** Minimum union branches before a pure-constant union is rewritten into an enum. */
const COMPLEX_UNION_BRANCH_THRESHOLD = 8;

const headerValue = (headers: HeaderInput | undefined, name: string): string => {
  if (headers === undefined) return "";

  if (headers instanceof Headers) return (headers.get(name) ?? "").trim();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase() || value === undefined) continue;
    const values = typeof value === "string" ? [value] : value;

    for (const entry of values) if (entry.trim() !== "") return entry.trim();
  }

  return "";
};

/** `IsCodexUserAgent`: the `User-Agent` contains `codex`. */
export const isCodexUserAgent = (headers: HeaderInput | undefined): boolean =>
  headerValue(headers, "User-Agent").toLowerCase().includes("codex");

// ---------------------------------------------------------------------------------------------------------------
// Schema simplification
// ---------------------------------------------------------------------------------------------------------------

const NUMERIC_BOUND_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
] as const;

const INT64_LIMIT = 2 ** 63;

/**
 * `isNumericBoundOutOfInt64`, on a parsed double. Go reads the number's source text; a parsed body keeps only the
 * double, so a bound that rounds to 2^63 (`9223372036854775807` and up) counts as out of range, and a non-integral
 * bound beyond 2^53 cannot exist. Both only ever over-strip a bound the backend would see as the int64 extreme.
 */
const isOutOfInt64 = (bound: Json | undefined): boolean =>
  typeof bound === "number" && !(bound >= -INT64_LIMIT && bound < INT64_LIMIT);

/** `stripIncompatiblePatterns`: schema-aware removal of unsupported `pattern`s and out-of-int64 bounds; true when something was removed. */
const stripIncompatiblePatterns = (value: Json | undefined): boolean => {
  let changed = false;

  if (isJsonArray(value)) {
    for (const item of value) if (stripIncompatiblePatterns(item)) changed = true;

    return changed;
  }

  if (!isJsonObject(value)) return false;
  const pattern = value["pattern"];

  if (typeof pattern === "string" && hasUnsupportedUnicodePropertyEscape(pattern)) {
    delete value["pattern"];
    changed = true;
  }

  for (const boundKey of NUMERIC_BOUND_KEYWORDS) {
    if (isOutOfInt64(value[boundKey])) {
      delete value[boundKey];
      changed = true;
    }
  }

  const patternProperties = value["patternProperties"];

  if (isJsonObject(patternProperties)) {
    for (const key of Object.keys(patternProperties)) {
      if (hasUnsupportedUnicodePropertyEscape(key)) {
        delete patternProperties[key];
        changed = true;
      } else if (stripIncompatiblePatterns(patternProperties[key])) {
        changed = true;
      }
    }
  }

  for (const mapKey of SCHEMA_MAP_KEYWORDS) {
    if (mapKey === "patternProperties") continue;
    const sub = value[mapKey];

    if (isJsonObject(sub))
      for (const child of Object.values(sub)) if (stripIncompatiblePatterns(child)) changed = true;
  }

  for (const valueKey of SCHEMA_VALUE_KEYWORDS) {
    const sub = value[valueKey];

    if ((isJsonObject(sub) || isJsonArray(sub)) && stripIncompatiblePatterns(sub)) changed = true;
  }

  return changed;
};

/** `canonicalJSONValueKey`: scalar const values only. */
const canonicalValueKey = (value: Json | undefined): string | undefined => {
  switch (typeof value) {
    case "string":
      return `s:${value}`;
    case "number":
      return `n:${value}`;
    case "boolean":
      return `b:${value}`;
    default:
      return value === null ? "null" : undefined;
  }
};

/** `isPureConstBranch`: an object with `const` and nothing but `description`/`title`. */
const pureConstBranch = (
  branch: Json,
): { readonly key: string; readonly value: Json } | undefined => {
  if (!isJsonObject(branch)) return undefined;
  const constant = branch["const"];

  if (constant === undefined) return undefined;

  for (const key of Object.keys(branch))
    if (key !== "const" && key !== "description" && key !== "title") return undefined;
  const key = canonicalValueKey(constant);

  return key === undefined ? undefined : { key, value: constant };
};

const equalCanonicalSets = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const setA = new Set(a);

  return setA.size === a.length && b.every((value) => setA.has(value));
};

/** `normalizeCodexPropertySchema`: true when the property object was rewritten in place. */
const normalizePropertySchema = (prop: Json): boolean => {
  if (!isJsonObject(prop)) return false;
  const hasOneOf = prop["oneOf"] !== undefined;
  const hasAnyOf = prop["anyOf"] !== undefined;

  // Both present: leave untouched to preserve compound constraints.
  if (hasOneOf === hasAnyOf) return false;
  const unionName = hasOneOf ? "oneOf" : "anyOf";
  const union = prop[unionName];

  if (!isJsonArray(union) || union.length < COMPLEX_UNION_BRANCH_THRESHOLD) return false;

  const keys: string[] = [];
  const values: Json[] = [];
  const seen = new Set<string>();

  for (const branch of union) {
    const pure = pureConstBranch(branch);

    // A duplicate value would violate oneOf exclusivity: keep the original schema.
    if (pure === undefined || seen.has(pure.key)) return false;
    seen.add(pure.key);
    keys.push(pure.key);
    values.push(pure.value);
  }

  if (values.length === 0) return false;

  const existingEnum = prop["enum"];

  if (isJsonArray(existingEnum)) {
    const existingKeys: string[] = [];

    for (const value of existingEnum) {
      const key = canonicalValueKey(value);

      if (key === undefined) return false;
      existingKeys.push(key);
    }

    if (!equalCanonicalSets(existingKeys, keys)) return false;
    delete prop[unionName];

    return true;
  }

  prop["enum"] = values;
  delete prop[unionName];

  return true;
};

/** `normalizeCodexParameters`: true when `params` changed. */
const normalizeParameters = (params: Json): boolean => {
  let changed = false;

  if (stripIncompatiblePatterns(params)) changed = true;

  const properties = get(params, "properties");

  if (isJsonObject(properties)) {
    for (const property of Object.values(properties)) {
      if (normalizePropertySchema(property)) changed = true;
    }
  }

  return changed;
};

const normalizeToolList = (tools: Json | undefined): boolean => {
  if (!isJsonArray(tools)) return false;
  let changed = false;

  for (const tool of tools) {
    if (!isJsonObject(tool)) continue;
    const toolType = asString(tool["type"]);

    if (toolType === "namespace") {
      if (normalizeToolList(tool["tools"])) changed = true;
      continue;
    }

    if (toolType !== "function" && toolType !== "custom") continue;
    const params = tool["parameters"];

    if (!isJsonObject(params)) continue;

    if (normalizeParameters(params)) changed = true;
  }

  return changed;
};

/** `NormalizeCodexToolSchemas`; mutates and returns `body`. */
export const normalizeCodexToolSchemas = <T extends Json>(body: T): T => {
  normalizeToolList(get(body, "tools"));

  return body;
};

// ---------------------------------------------------------------------------------------------------------------
// number -> integer for Codex CLI tools
// ---------------------------------------------------------------------------------------------------------------

/** Explicit schema paths relative to `parameters.properties`, not recursive field names. */
const CODEX_CLIENT_TOOL_INTEGER_FIELDS = new Map<string, readonly string[]>(
  Object.entries({
    exec_command: ["yield_time_ms", "max_output_tokens", "timeout_ms"],
    write_stdin: ["session_id", "yield_time_ms", "max_output_tokens"],
    sleep: ["duration_ms"],
    wait_agent: ["timeout_ms"],
    wait: ["yield_time_ms", "max_tokens"],
    tool_search: ["limit"],
    test_sync_tool: [
      "sleep_before_ms",
      "sleep_after_ms",
      "participants",
      "timeout_ms",
      "barrier.properties.participants",
      "barrier.properties.timeout_ms",
    ],
    create_goal: ["token_budget"],
    get_channels: ["limit"],
    list_threads: ["limit", "max_chars_per_post"],
    search_posts: ["limit", "max_chars_per_post"],
    read_thread: ["limit", "max_chars_per_post"],
    read_post: ["offset_chars", "limit_chars"],
    memories__list: ["max_results"],
    memories__read: ["line_offset", "max_lines"],
    memories__search: ["context_lines", "max_results"],
    history__list_windows: ["limit"],
    history__list_items: ["limit", "max_chars_per_item"],
    history__read_item: ["offset_chars", "limit_chars"],
    history__search_contents: ["limit"],
    notes__list_files_by_prefix: ["max_results"],
    // Codex declares signed line numbers in the first nullable union branch.
    notes__read_file: ["start_line", "stop_line", "start_line.anyOf.0", "stop_line.anyOf.0"],
    notes__search_contents: ["max_matches_per_file", "max_files"],
    image_gen__imagegen: ["num_last_images_to_include"],
    web__run: [
      "search_query.items.properties.recency",
      "image_query.items.properties.recency",
      "open.items.properties.lineno",
      "click.items.properties.id",
      "screenshot.items.properties.pageno",
      "weather.items.properties.duration",
      "sports.items.properties.num_games",
    ],
  }),
);

const matchCodexTargetTool = (toolName: string): readonly string[] => {
  let base = toolName.trim();

  if (base.startsWith("functions__")) base = base.slice("functions__".length);
  else if (base.startsWith("collab__")) base = base.slice("collab__".length);

  switch (base) {
    case "multi_agent_v1__wait_agent":
    case "collaboration__wait_agent":
      base = "wait_agent";
      break;
    case "collaboration__get_channels":
    case "collaboration__list_threads":
    case "collaboration__search_posts":
    case "collaboration__read_thread":
    case "collaboration__read_post":
      base = base.slice("collaboration__".length);
      break;
  }

  return CODEX_CLIENT_TOOL_INTEGER_FIELDS.get(base) ?? [];
};

const normalizeFieldTypes = (params: Json, fields: readonly string[]): boolean => {
  if (fields.length === 0 || !isJsonObject(get(params, "properties"))) return false;
  let changed = false;

  for (const field of fields) {
    const prop = get(params, `properties.${field}`);

    if (prop === undefined) continue;
    const type = get(prop, "type");

    if (type === undefined) continue;
    const typePath = `properties.${field}.type`;

    if (type === "number") {
      set(params, typePath, "integer");
      changed = true;
    } else if (isJsonArray(type)) {
      let hasNumber = false;
      const seen = new Set<string>();
      const next: string[] = [];

      for (const item of type) {
        let text = asString(item);

        if (text === "number") {
          hasNumber = true;
          text = "integer";
        }

        if (!seen.has(text)) {
          seen.add(text);
          next.push(text);
        }
      }

      if (hasNumber) {
        set(params, typePath, next);
        changed = true;
      }
    }
  }

  return changed;
};

const normalizeIntegerTypesInTool = (tool: Json, namespace: string): boolean => {
  if (!isJsonObject(tool)) return false;

  if (asString(tool["type"]) === "namespace") {
    if (namespace !== "") return false;
    const name = asString(tool["name"]);

    return name === "" ? false : normalizeIntegerTypesInArray(tool["tools"], name);
  }

  for (const key of ["function_declarations", "functionDeclarations"]) {
    const declarations = tool[key];

    if (isJsonArray(declarations)) return normalizeIntegerTypesInArray(declarations, namespace);
  }

  let toolName = asString(tool["name"]);
  let params = tool["parameters"];

  if (!isJsonObject(params)) {
    const fnParams = get(tool, "function.parameters");

    if (isJsonObject(fnParams)) {
      params = fnParams;

      if (toolName === "") toolName = asString(get(tool, "function.name"));
    } else if (isJsonObject(tool["input_schema"])) {
      params = tool["input_schema"];
    } else if (isJsonObject(tool["parametersJsonSchema"])) {
      params = tool["parametersJsonSchema"];
    } else {
      return false;
    }
  }

  if (namespace !== "") toolName = `${namespace}__${toolName}`;

  return normalizeFieldTypes(params, matchCodexTargetTool(toolName));
};

const normalizeIntegerTypesInArray = (tools: Json | undefined, namespace: string): boolean => {
  if (!isJsonArray(tools)) return false;
  let changed = false;

  for (const tool of tools) if (normalizeIntegerTypesInTool(tool, namespace)) changed = true;

  return changed;
};

/** `NormalizeCodexToolIntegerTypes`; mutates and returns `body` (no-op unless the client is a Codex client). */
export const normalizeCodexToolIntegerTypes = <T extends Json>(
  body: T,
  headers: HeaderInput | undefined,
): T => {
  if (!isCodexUserAgent(headers)) return body;
  normalizeIntegerTypesInArray(get(body, "tools"), "");
  const input = get(body, "input");

  if (isJsonArray(input)) {
    for (const item of input) {
      if (asString(get(item, "type")) === "additional_tools")
        normalizeIntegerTypesInArray(get(item, "tools"), "");
    }
  }

  return body;
};
