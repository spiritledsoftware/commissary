/**
 * Local `$ref` inlining for JSON schemas, shared by the Gemini/Antigravity schema cleaners and the executors that
 * inline references before forwarding a schema (xAI, Kimi).
 *
 * Go source: internal/util/gemini_schema.go (InlineLocalRefs, inlineLocalRefs, inlineLocalRefsForClean,
 * resolveSchemaRoot, resolveLocalRefs, resolveRefFallback, resolveSchemaEntry, resolveJSONPointer, cyclicRefFallback,
 * targetExpansionSize, mergeHint, refName, schemaNameMapKeywords, literalValueKeywords).
 *
 * References are resolved against the original schema. Every reference receives its own copy as long as the expansion
 * budget lasts (`MAX_INLINED_SCHEMA_BYTES`), conflicting sibling assertions stay conjunctive, and a cycle or an
 * exhausted budget ends as a typed hint instead of recursing or expanding without bound. Literal-value keywords
 * (`default`, `example`, `examples`, `const`, `enum`) are client data and are copied verbatim.
 *
 * Differences: Go's `json.Marshal` sorts map keys, here key order is preserved (the budget is still spent in sorted
 * key order, so which references degrade never depends on the document's key order); sizes count UTF-8 bytes and mirror
 * Go's HTML escaping so the bound stays the same.
 */
import { isJsonArray, isJsonObject, type Json, type JsonObject } from "@commissary/json";

/** Bounds the schema material copied into the output by one inlining pass (shared definitions fan out per reference). */
export const MAX_INLINED_SCHEMA_BYTES = 256 * 1024;

/** Bounds the target description copied into a degraded reference. */
const MAX_FALLBACK_DESCRIPTION_BYTES = 512;

/** Keywords whose value maps author-chosen names to subschemas: a key directly under one is a name, not a keyword. */
export const SCHEMA_NAME_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

const LITERAL_VALUE_KEYWORDS: ReadonlySet<string> = new Set([
  "default",
  "example",
  "examples",
  "const",
  "enum",
]);

/** Literal-value keywords carry client data rather than subschemas. */
export const isLiteralValueKeyword = (key: string): boolean => LITERAL_VALUE_KEYWORDS.has(key);

/** Combines a description with a hint; a hint already present is not appended again (cleaning can run twice). */
export const mergeHint = (existing: string, hint: string): string => {
  if (existing === "") return hint;

  if (existing === hint || existing.startsWith(`${hint} (`) || existing.includes(`(${hint})`))
    return existing;

  return `${existing} (${hint})`;
};

export const refName = (ref: string): string => {
  const index = ref.lastIndexOf("/");

  return index >= 0 && index + 1 < ref.length
    ? ref
        .slice(index + 1)
        .replaceAll("~1", "/")
        .replaceAll("~0", "~")
    : ref;
};

/** Resolves a `#/…` JSON Pointer against `root`. */
export const resolveJsonPointer = (
  root: Json,
  ref: string,
): { found: true; value: Json } | { found: false } => {
  let current: Json = root;

  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");

    if (isJsonObject(current)) {
      if (!Object.hasOwn(current, part)) return { found: false };
      // SAFETY: `Object.hasOwn(current, part)` was checked above, so the key is present; the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      current = current[part] as Json;
    } else if (isJsonArray(current)) {
      if (!/^-?\d+$/.test(part)) return { found: false };
      const index = Number(part);

      if (index < 0 || index >= current.length) return { found: false };
      // SAFETY: the index is in bounds (checked above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      current = current[index] as Json;
    } else {
      return { found: false };
    }
  }

  return { found: true, value: current };
};

// --- size accounting ---------------------------------------------------------------------------------------------

const utf8Length = (s: string): number => {
  let size = 0;

  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);

    if (code < 0x80) size += 1;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      size += 4;
      i++;
    } else size += 3;
  }

  return size;
};

/** The encoded length of one JSON string with quotes, as Go's `encoding/json` (HTML escaping included) emits it. */
const jsonStringEncodedSize = (s: string): number => {
  let size = 2;

  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);

    if (code < 0x20) size += code === 0x0a || code === 0x0d || code === 0x09 ? 2 : 6;
    else if (code === 0x22 || code === 0x5c) size += 2;
    else if (code === 0x3c || code === 0x3e || code === 0x26) size += 6;
    else if (code < 0x80) size += 1;
    else if (code === 0x2028 || code === 0x2029) size += 6;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      size += 4;
      i++;
    } else size += 3;
  }

  return size;
};

const jsonValueSize = (value: Json): number => {
  if (value === null) return 4;

  if (typeof value === "boolean") return value ? 4 : 5;

  if (typeof value === "number") return String(value).length;

  if (typeof value === "string") return jsonStringEncodedSize(value);

  if (isJsonArray(value)) {
    let size = 2;

    for (const item of value) size += jsonValueSize(item) + 1;

    return size;
  }

  let size = 2;

  for (const [key, item] of Object.entries(value))
    size += jsonStringEncodedSize(key) + 1 + jsonValueSize(item) + 1;

  return size;
};

/**
 * What copying a target into the cleaned output costs: definitions nested inside it are deleted later and never copied,
 * so they are excluded (name maps and literal values still count in full).
 */
const cleanExpansionSize = (value: Json, inNameMap: boolean): number => {
  const cap = MAX_INLINED_SCHEMA_BYTES + 1;

  if (isJsonArray(value)) {
    let size = 2;

    for (const item of value) {
      size += cleanExpansionSize(item, false) + 1;

      if (size > cap) return cap;
    }

    return size;
  }

  if (!isJsonObject(value)) return jsonValueSize(value);
  let size = 2;

  for (const [key, item] of Object.entries(value)) {
    if (!inNameMap && (key === "$defs" || key === "definitions")) continue;

    if (!inNameMap && isLiteralValueKeyword(key)) {
      size += jsonStringEncodedSize(key) + 1 + jsonValueSize(item) + 1;
    } else {
      const childInNameMap = !inNameMap && SCHEMA_NAME_MAP_KEYWORDS.has(key);
      size += jsonStringEncodedSize(key) + 1 + cleanExpansionSize(item, childInNameMap) + 1;
    }

    if (size > cap) return cap;
  }

  return size;
};

const targetExpansionSize = (value: Json, forClean: boolean): number =>
  forClean ? cleanExpansionSize(value, false) : jsonValueSize(value);

// --- resolution ----------------------------------------------------------------------------------------------------

/** The remaining expansion budget of one inlining pass. */
interface RefState {
  budget: number;
}

type Active = Set<string>;

const sortedEntries = (node: JsonObject): Array<[string, Json]> =>
  Object.entries(node).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Builds a copy of `node` whose values `resolve` produces. Values are resolved in sorted key order (so the budget
 * allocation does not depend on the document's key order) and written back in the document's own order; `undefined`
 * drops the entry.
 */
const mapEntries = (
  node: JsonObject,
  resolve: (key: string, value: Json) => Json | undefined,
): JsonObject => {
  const results = new Map<string, Json>();

  for (const [key, value] of sortedEntries(node)) {
    const resolved = resolve(key, value);

    if (resolved !== undefined) results.set(key, resolved);
  }

  const out: JsonObject = {};

  for (const key of Object.keys(node)) {
    const resolved = results.get(key);

    if (resolved !== undefined) out[key] = resolved;
  }

  return out;
};

const isDefinitionsKey = (key: string): boolean => key === "$defs" || key === "definitions";

const cyclicRefFallback = (node: JsonObject, target: Json, ref: string): JsonObject => {
  const out: JsonObject = {};

  if (isJsonObject(target)) {
    for (const key of ["type", "nullable", "description"]) {
      const value = target[key];

      if (!Object.hasOwn(target, key) || value === undefined) continue;

      if (key === "description" && typeof value === "string") {
        if (utf8Length(value) > MAX_FALLBACK_DESCRIPTION_BYTES) continue;
      }

      out[key] = value;
    }
  }

  for (const [key, value] of Object.entries(node)) if (key !== "$ref") out[key] = value;
  const hint = `See: ${refName(ref)}`;
  const description = out["description"];
  out["description"] =
    typeof description === "string" && description !== "" ? mergeHint(description, hint) : hint;

  return out;
};

/**
 * A reference target that is not expanded (cycle or exhausted budget) degrades to a typed hint; the sibling subschemas
 * on the same node still resolve so their own references are not left dangling behind it.
 */
const resolveRefFallback = (
  root: Json,
  node: JsonObject,
  target: Json,
  ref: string,
  active: Active,
  state: RefState,
  forClean: boolean,
): JsonObject => {
  const out = cyclicRefFallback(node, target, ref);

  // The target description copied into the fallback is expansion output like any other: charge it to the budget. Once
  // the budget is spent a fallback carries only the short hint. Omitted descriptions are not charged.
  if (isJsonObject(target)) {
    const description = target["description"];

    if (
      typeof description === "string" &&
      description !== "" &&
      utf8Length(description) <= MAX_FALLBACK_DESCRIPTION_BYTES &&
      !Object.hasOwn(node, "description")
    ) {
      const cost = jsonStringEncodedSize(description);

      if (cost > state.budget) out["description"] = `See: ${refName(ref)}`;
      else state.budget -= cost;
    }
  }

  for (const [key, item] of sortedEntries(node)) {
    if (key === "$ref" || key === "description") continue;

    if (forClean && isDefinitionsKey(key)) {
      delete out[key];
      continue;
    }

    out[key] = resolveSchemaEntry(root, key, item, active, state, forClean);
  }

  return out;
};

/**
 * Resolves one map entry. A literal-value keyword's value is client data and is copied without resolving references
 * inside it. Under a name map ("properties" and friends) a key spelled like a literal keyword is an author-chosen
 * property name whose value is a subschema, so name-map entries resolve directly.
 */
const resolveSchemaEntry = (
  root: Json,
  key: string,
  item: Json,
  active: Active,
  state: RefState,
  forClean: boolean,
): Json => {
  if (isLiteralValueKeyword(key)) return structuredClone(item);

  if (SCHEMA_NAME_MAP_KEYWORDS.has(key) && isJsonObject(item)) {
    return mapEntries(item, (_name, schema) =>
      resolveLocalRefs(root, schema, active, state, forClean),
    );
  }

  return resolveLocalRefs(root, item, active, state, forClean);
};

/** Combines a resolved reference target with the node's own resolved siblings. */
const mergeInlinedRefSchemas = (target: JsonObject, siblings: JsonObject): JsonObject => ({
  ...target,
  ...siblings,
});

const resolveLocalRefs = (
  root: Json,
  value: Json,
  active: Active,
  state: RefState,
  forClean: boolean,
): Json => {
  if (isJsonArray(value))
    return value.map((item) => resolveLocalRefs(root, item, active, state, forClean));

  if (!isJsonObject(value)) return value;
  const ref = value["$ref"];

  if (typeof ref === "string" && ref.startsWith("#/")) {
    const target = resolveJsonPointer(root, ref);

    if (target.found) {
      if (active.has(ref))
        return resolveRefFallback(root, value, target.value, ref, active, state, forClean);
      // Charge the stored target size and let nested references charge their own costs during recursion: an
      // over-budget chain still expands its affordable outer levels and only the deepest references degrade.
      const size = targetExpansionSize(target.value, forClean);

      if (size > state.budget)
        return resolveRefFallback(root, value, target.value, ref, active, state, forClean);
      state.budget -= size;
      active.add(ref);
      const resolvedTarget = resolveLocalRefs(root, target.value, active, state, forClean);
      active.delete(ref);

      if (isJsonObject(resolvedTarget)) {
        const siblings = mapEntries(value, (key, item) => {
          if (key === "$ref" || (forClean && isDefinitionsKey(key))) return undefined;

          return resolveSchemaEntry(root, key, item, active, state, forClean);
        });

        return mergeInlinedRefSchemas(resolvedTarget, siblings);
      }
    }
  }

  return mapEntries(value, (key, item) => {
    if (forClean && isDefinitionsKey(key)) return undefined; // dropped with every other definitions container

    return resolveSchemaEntry(root, key, item, active, state, forClean);
  });
};

/**
 * Resolves references in the schema body before the definition containers: definitions only matter through
 * references, so walking them first would spend the budget on copies the cleaners delete next. Cleaning drops the
 * containers here altogether (references still resolve against the original root).
 */
const resolveSchemaRoot = (root: Json, state: RefState, forClean: boolean): Json => {
  if (!isJsonObject(root)) return resolveLocalRefs(root, root, new Set(), state, forClean);

  let out = mapEntries(root, (key, item) => {
    if (isDefinitionsKey(key)) return forClean ? undefined : null; // resolved after the body when kept

    if (key === "$ref") return item;

    return resolveSchemaEntry(root, key, item, new Set(), state, forClean);
  });

  // A root-level reference expands into the whole referenced schema; its siblings (resolved above) merge like a nested
  // reference's.
  const ref = root["$ref"];

  if (typeof ref === "string" && ref.startsWith("#/")) {
    const target = resolveJsonPointer(root, ref);

    if (target.found) {
      const size = targetExpansionSize(target.value, forClean);
      let expanded: JsonObject | undefined;

      if (size <= state.budget) {
        state.budget -= size;

        const resolvedTarget = resolveLocalRefs(
          root,
          target.value,
          new Set([ref]),
          state,
          forClean,
        );

        if (isJsonObject(resolvedTarget)) expanded = resolvedTarget;
      }

      if (expanded !== undefined) {
        const { $ref: _ref, ...siblings } = out;
        out = mergeInlinedRefSchemas(expanded, siblings);
      } else {
        out = resolveRefFallback(root, out, target.value, ref, new Set(), state, forClean);
      }

      delete out["$ref"];
    }
  }

  if (!forClean) {
    for (const key of ["$defs", "definitions"]) {
      const item = root[key];

      if (item !== undefined)
        out[key] = resolveSchemaEntry(root, key, item, new Set(), state, false);
    }
  }

  return out;
};

const hasRefKeyword = (schema: Json): boolean => JSON.stringify(schema).includes('"$ref"');

/**
 * `InlineLocalRefs`: expands every local `#/…` reference of `schema` and keeps the definition containers. Returns
 * `schema` itself when it holds no `$ref`.
 */
export const inlineLocalRefs = (schema: Json): Json =>
  hasRefKeyword(schema)
    ? resolveSchemaRoot(schema, { budget: MAX_INLINED_SCHEMA_BYTES }, false)
    : schema;

/**
 * `inlineLocalRefsForClean`: inlines local references for schema cleaning, which deletes every definition container.
 * Cleaning sometimes receives the single-key `{"schema": …}` carrier that nests a schema one level down; references
 * inside it resolve against the inner schema, not the carrier.
 */
export const inlineLocalRefsForClean = (schema: Json): Json => {
  if (!hasRefKeyword(schema)) return schema;
  const state: RefState = { budget: MAX_INLINED_SCHEMA_BYTES };

  if (isJsonObject(schema) && Object.keys(schema).length === 1) {
    const inner = schema["schema"];

    if (isJsonObject(inner)) return { schema: resolveSchemaRoot(inner, state, true) };
  }

  return resolveSchemaRoot(schema, state, true);
};
