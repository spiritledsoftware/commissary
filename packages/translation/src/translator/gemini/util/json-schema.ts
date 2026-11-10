/**
 * JSON schema cleaning for Gemini / Antigravity tool declarations.
 *
 * Go source: internal/util/gemini_schema.go (cleanJSONSchema and its passes, CleanJSONSchemaForGemini,
 * CleanJSONSchemaForGeminiJSONSchema, CleanJSONSchemaForAntigravity*, InlineLocalRefs) and internal/util/translator.go
 * (Walk). The Go code rewrites a JSON string through gjson/sjson paths; this port keeps the same path based passes on
 * a parsed document (`Doc`) using the gjson/sjson engine of `@commissary/json`. Pass one single schema, never a request.
 *
 * Differences: hint texts embed `JSON.stringify` of objects/arrays (Go keeps the original raw text). Local reference
 * inlining lives in `common/schema-refs.ts` (shared with the executors); a property literally named `const` is not
 * converted to an `enum` of its parent (Go would fabricate `properties.enum`).
 */
import {
  asString,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import {
  inlineLocalRefsForClean,
  isLiteralValueKeyword,
  mergeHint,
  refName,
  SCHEMA_NAME_MAP_KEYWORDS,
} from "../../common/schema-refs.ts";

export const PLACEHOLDER_REASON_DESCRIPTION = "Brief explanation of why you are calling this tool";

interface CleanOptions {
  readonly addPlaceholder?: boolean;
  readonly addMissingArrayItems?: boolean;
  readonly antigravitySemantics?: boolean;
  readonly removeToolTitle?: boolean;
  readonly removeGeminiMetadata?: boolean;
  readonly flattenUnions?: boolean;
  /** Forces multi-branch anyOf/oneOf down to the single strongest branch (a route whose upstream rejects them). */
  readonly flattenMultiBranchUnions?: boolean;
  readonly forceEnumStringType?: boolean;
  readonly dropAllEnums?: boolean;
  readonly dropBooleanEnums?: boolean;
  readonly preserveAdditionalPropertiesFalse?: boolean;
  readonly preserveAllAdditionalProperties?: boolean;
  readonly preserveStandardConstraints?: boolean;
}

/** The document being cleaned (Go threads a JSON string through every pass). */
interface Doc {
  root: Json;
}

// --- path helpers ------------------------------------------------------------------------------------------------------

const escapeKey = (key: string): string => key.replace(/[.*?]/g, (c) => `\\${c}`);

const unescapeKey = (key: string): string => {
  if (!key.includes("\\")) return key;
  let out = "";

  for (let i = 0; i < key.length; i++) {
    if (key[i] === "\\" && i + 1 < key.length) i++;
    out += key[i];
  }

  return out;
};

const splitPath = (path: string): string[] => {
  if (path === "") return [];
  const parts: string[] = [];
  let current = "";

  for (let i = 0; i < path.length; i++) {
    // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    const c = path[i] as string;

    if (c === "\\" && i + 1 < path.length) {
      current += `\\${path[i + 1]}`;
      i++;
      continue;
    }

    if (c === ".") {
      parts.push(current);
      current = "";
      continue;
    }

    current += c;
  }

  parts.push(current);

  return parts;
};

const trimSuffix = (path: string, suffix: string): string => {
  if (path === suffix.replace(/^\./, "")) return "";

  return path.endsWith(suffix) ? path.slice(0, path.length - suffix.length) : path;
};

const joinPath = (base: string, suffix: string): string =>
  base === "" ? suffix : `${base}.${suffix}`;

/** Whether `path` addresses a map keyed by author-chosen names (odd trailing run of name-map keywords). */
const isPropertyDefinition = (path: string): boolean => {
  const segments = splitPath(path);
  let trailing = 0;

  for (let i = segments.length - 1; i >= 0; i--) {
    // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    if (!SCHEMA_NAME_MAP_KEYWORDS.has(unescapeKey(segments[i] as string))) break;
    trailing++;
  }

  return trailing % 2 === 1;
};

const descriptionPath = (parentPath: string): string =>
  parentPath === "" || parentPath === "@this" ? "description" : `${parentPath}.description`;

const getAt = (doc: Doc, path: string): Json | undefined =>
  path === "" ? undefined : get(doc.root, path);

const setAt = (doc: Doc, path: string, value: Json): void => {
  try {
    doc.root = set(doc.root, path, value);
  } catch {
    // sjson ignores paths it cannot write.
  }
};

const delAt = (doc: Doc, path: string): void => {
  try {
    doc.root = del(doc.root, path);
  } catch {
    // Nothing to delete.
  }
};

const setRawAt = (doc: Doc, path: string, value: Json): void => {
  if (path === "") doc.root = value;
  else setAt(doc, path, value);
};

const appendHint = (doc: Doc, parentPath: string, hint: string): void => {
  const path = descriptionPath(parentPath);
  setAt(doc, path, mergeHint(asString(getAt(doc, path)), hint));
};

const appendHintRaw = (node: Json, hint: string): Json => {
  try {
    return set(node, "description", mergeHint(asString(get(node, "description")), hint));
  } catch {
    return node;
  }
};

const mergeDescriptionRaw = (schema: Json, parentDesc: string): Json => {
  const childDesc = asString(get(schema, "description"));

  try {
    if (childDesc === "") return set(schema, "description", parentDesc);

    if (childDesc === parentDesc) return schema;

    return set(schema, "description", `${parentDesc} (${childDesc})`);
  } catch {
    return schema;
  }
};

/**
 * `WalkSchema`: every path whose key equals `field` (arrays are walked with index keys). Literal values (`default`,
 * `example`, `examples`, `const`, `enum`) are client data, not subschemas, so the walk does not descend into them (the
 * keyword itself is still recorded); under a name map such a key is a property name, whose subschema is walked.
 */
const walk = (value: Json | undefined, path: string, field: string, paths: string[]): void => {
  const entries: Array<[string, Json]> = isJsonArray(value)
    ? value.map((item, index): [string, Json] => [String(index), item])
    : isJsonObject(value)
      ? Object.entries(value)
      : [];

  for (const [key, child] of entries) {
    const childPath = path === "" ? escapeKey(key) : `${path}.${escapeKey(key)}`;

    if (key === field) paths.push(childPath);

    if (isLiteralValueKeyword(key) && !isPropertyDefinition(path)) continue;
    walk(child, childPath, field, paths);
  }
};

const findPaths = (doc: Doc, field: string): string[] => {
  const paths: string[] = [];
  walk(doc.root, "", field, paths);

  return paths;
};

const findPathsByFields = (doc: Doc, fields: ReadonlyArray<string>): Map<string, string[]> => {
  const wanted = new Set(fields);
  const out = new Map<string, string[]>();

  const visit = (value: Json | undefined, path: string): void => {
    const entries: Array<[string, Json]> = isJsonArray(value)
      ? value.map((item, index): [string, Json] => [String(index), item])
      : isJsonObject(value)
        ? Object.entries(value)
        : [];

    for (const [key, child] of entries) {
      const childPath = path === "" ? escapeKey(key) : `${path}.${escapeKey(key)}`;

      if (wanted.has(key)) out.set(key, [...(out.get(key) ?? []), childPath]);

      // Literal values are client data; schema-looking keys inside them are not keywords.
      if (isLiteralValueKeyword(key) && !isPropertyDefinition(path)) continue;
      visit(child, childPath);
    }
  };

  visit(doc.root, "");

  return out;
};

const sortByDepth = (paths: string[]): void => {
  paths.sort((a, b) => splitPath(b).length - splitPath(a).length);
};

const strings = (doc: Doc, path: string): string[] => {
  const arr = getAt(doc, path);

  return isJsonArray(arr) ? arr.map(asString) : [];
};

// --- malformed schema repair (normalizeMalformedSchemaObjects) ----------------------------------------------------

const KNOWN_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "additionalProperties",
  "items",
  "prefixItems",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependentRequired",
  "dependencies",
  "if",
  "then",
  "else",
  "not",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentSchema",
  "additionalItems",
  "default",
  "const",
  "example",
  "examples",
  "discriminator",
  "xml",
  "externalDocs",
  "enumDescriptions",
  "enumTitles",
]);

const isKnownKeywordOrExtension = (key: string): boolean =>
  key.startsWith("x-") || KNOWN_KEYWORDS.has(key);

const isNonObjectDeclaredType = (t: Json | undefined): boolean => {
  if (typeof t === "string") return t !== "" && t.toLowerCase() !== "object";

  if (isJsonArray(t)) {
    if (t.some((item) => typeof item === "string" && item.toLowerCase() === "object")) return false;

    return t.length > 0;
  }

  return false;
};

const isArrayDeclaredType = (t: Json | undefined): boolean => {
  if (typeof t === "string") return t.toLowerCase() === "array";

  return (
    isJsonArray(t) && t.some((item) => typeof item === "string" && item.toLowerCase() === "array")
  );
};

const isApiRequestDocument = (m: JsonObject): boolean => {
  if (isJsonArray(m["tools"]) || isJsonArray(m["contents"]) || isJsonArray(m["messages"]))
    return true;

  if (isJsonArray(m["functionDeclarations"]) || isJsonArray(m["function_declarations"]))
    return true;
  const request = m["request"];

  return isJsonObject(request) && isApiRequestDocument(request);
};

const mergeStringSlices = (existing: string[], promoted: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const s of [...existing, ...promoted]) {
    if (s !== "" && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }

  return out;
};

const stringArray = (value: Json | undefined): string[] =>
  isJsonArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

type RepairSchemaListResult = { out: Json[]; modified: boolean };

const repairSchemaList = (list: Json[]): RepairSchemaListResult => {
  let modified = false;

  const out = list.map((item) => {
    if (isJsonObject(item)) {
      const repaired = repairSchemaNode(item);

      if (repaired.modified) modified = true;

      return repaired.node;
    }

    if (item === true) {
      modified = true;

      return {};
    }

    return item;
  });

  return { out, modified };
};

type RepairPropertyMapResult = { out: JsonObject; promoted: string[]; modified: boolean };

const repairPropertyMap = (props: JsonObject): RepairPropertyMapResult => {
  const out: JsonObject = {};
  const promoted: string[] = [];
  let modified = false;

  for (const [key, value] of Object.entries(props)) {
    if (value === true) {
      out[key] = {};
      modified = true;
      continue;
    }

    if (!isJsonObject(value)) {
      out[key] = value;
      continue;
    }

    const child: JsonObject = { ...value };
    const required = child["required"];

    if (typeof required === "boolean") {
      delete child["required"];
      modified = true;

      if (required) promoted.push(key);
    }

    const repaired = repairSchemaNode(child);

    if (repaired.modified) modified = true;
    out[key] = repaired.node;
  }

  promoted.sort();

  return { out, promoted, modified };
};

type RepairSchemaNodeResult = { node: JsonObject; modified: boolean };

function repairSchemaNode(node: JsonObject): RepairSchemaNodeResult {
  let modified = false;
  const clone: JsonObject = { ...node };

  if (!isNonObjectDeclaredType(clone["type"])) {
    const bare: JsonObject = {};

    for (const [k, v] of Object.entries(clone)) {
      if (isJsonObject(v) && !isKnownKeywordOrExtension(k)) bare[k] = v;
    }

    if (Object.keys(bare).length > 0) {
      const repaired = repairPropertyMap(bare);

      for (const k of Object.keys(bare)) delete clone[k];
      const existing = clone["properties"];

      if (isJsonObject(existing)) {
        clone["properties"] = { ...existing, ...repaired.out };
      } else {
        clone["properties"] = repaired.out;

        if (!Object.hasOwn(clone, "type")) clone["type"] = "object";
      }

      if (repaired.promoted.length > 0) {
        clone["required"] = mergeStringSlices(stringArray(clone["required"]), repaired.promoted);
      }

      modified = true;
    }
  }

  const props = clone["properties"];

  // Declared properties are repaired without inferring a type before references are expanded: final sanitization
  // handles native object and array schemas once refs and conjunctions are resolved.
  if (isJsonObject(props)) {
    const repaired = repairPropertyMap(props);

    if (repaired.modified) {
      clone["properties"] = repaired.out;
      modified = true;
    }

    if (repaired.promoted.length > 0) {
      clone["required"] = mergeStringSlices(stringArray(clone["required"]), repaired.promoted);
      modified = true;
    }
  }

  const items = clone["items"];

  if (isJsonObject(items)) {
    const repaired = repairSchemaNode(items);

    if (repaired.modified) {
      clone["items"] = repaired.node;
      modified = true;
    }
  } else if (isJsonArray(items)) {
    const repaired = repairSchemaList(items);

    if (repaired.modified) {
      clone["items"] = repaired.out;
      modified = true;
    }
  } else if (items === true) {
    clone["items"] = {};
    modified = true;
  }

  const additional = clone["additionalProperties"];

  if (isJsonObject(additional)) {
    const repaired = repairSchemaNode(additional);

    if (repaired.modified) {
      clone["additionalProperties"] = repaired.node;
      modified = true;
    }
  }

  const pattern = clone["patternProperties"];

  if (isJsonObject(pattern)) {
    const repaired = repairPropertyMap(pattern);

    if (repaired.modified) {
      clone["patternProperties"] = repaired.out;
      modified = true;
    }
  }

  for (const key of [
    "if",
    "then",
    "else",
    "not",
    "contains",
    "propertyNames",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contentSchema",
    "additionalItems",
  ]) {
    const sub = clone[key];

    if (isJsonObject(sub)) {
      const repaired = repairSchemaNode(sub);

      if (repaired.modified) {
        clone[key] = repaired.node;
        modified = true;
      }
    } else if (sub === true) {
      clone[key] = {};
      modified = true;
    }
  }

  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const list = clone[key];

    if (isJsonArray(list)) {
      const repaired = repairSchemaList(list);

      if (repaired.modified) {
        clone[key] = repaired.out;
        modified = true;
      }
    }
  }

  for (const key of ["$defs", "definitions", "dependentSchemas", "dependencies"]) {
    const defs = clone[key];

    if (!isJsonObject(defs)) continue;
    const out: JsonObject = {};
    let defsModified = false;

    for (const [dk, dv] of Object.entries(defs)) {
      if (isJsonObject(dv)) {
        const repaired = repairSchemaNode(dv);
        out[dk] = repaired.node;

        if (repaired.modified) {
          defsModified = true;
          modified = true;
        }
      } else if (dv === true) {
        out[dk] = {};
        defsModified = true;
        modified = true;
      } else {
        out[dk] = dv;
      }
    }

    if (defsModified) clone[key] = out;
  }

  return { node: clone, modified };
}

const normalizeMalformedSchemaObjects = (doc: Doc): void => {
  const root = doc.root;

  if (root === true) {
    doc.root = {};

    return;
  }

  if (!isJsonObject(root) || isApiRequestDocument(root)) return;

  if (Object.keys(root).length === 1) {
    const inner = root["schema"];

    if (isJsonObject(inner)) {
      const repaired = repairSchemaNode(inner);

      if (repaired.modified) doc.root = { schema: repaired.node };

      return;
    }

    if (inner === true) {
      doc.root = { schema: {} };

      return;
    }
  }

  const repaired = repairSchemaNode(root);

  if (repaired.modified) doc.root = repaired.node;
};

// --- $ref handling -------------------------------------------------------------------------------------------------------

const convertRefsToHints = (doc: Doc, preserveSiblings: boolean): void => {
  const paths = findPaths(doc, "$ref");
  sortByDepth(paths);

  for (const p of paths) {
    const parentPath = trimSuffix(p, ".$ref");

    if (isPropertyDefinition(parentPath)) continue; // a property literally named "$ref", not a reference keyword
    const defName = refName(asString(getAt(doc, p)));
    let hint = `See: ${defName}`;

    if (!preserveSiblings) {
      const existing = asString(getAt(doc, descriptionPath(parentPath)));

      if (existing !== "") hint = `${existing} (${hint})`;
      setRawAt(doc, parentPath, { type: "object", description: hint });
      continue;
    }

    delAt(doc, p);
    appendHint(doc, parentPath, hint);
  }
};

// --- enum / const / constraints ------------------------------------------------------------------------------------

const convertConstToEnum = (doc: Doc): void => {
  for (const p of findPaths(doc, "const")) {
    const value = getAt(doc, p);

    if (value === undefined || isPropertyDefinition(trimSuffix(p, ".const"))) continue;
    const enumPath = `${trimSuffix(p, ".const")}.enum`;

    if (getAt(doc, enumPath) === undefined) setAt(doc, enumPath, [value]);
  }
};

const convertEnumValuesToStrings = (doc: Doc, forceStringType: boolean): void => {
  for (const p of findPaths(doc, "enum")) {
    const arr = getAt(doc, p);

    if (!isJsonArray(arr)) continue;
    setAt(doc, p, arr.map(asString));

    if (forceStringType) setAt(doc, joinPath(trimSuffix(p, ".enum"), "type"), "string");
  }
};

const addEnumHints = (doc: Doc): void => {
  for (const p of findPaths(doc, "enum")) {
    const arr = getAt(doc, p);

    if (!isJsonArray(arr) || arr.length <= 1 || arr.length > 10) continue;
    appendHint(doc, trimSuffix(p, ".enum"), `Allowed: ${arr.map(asString).join(", ")}`);
  }
};

const dropIgnoredEnumsToHints = (doc: Doc, options: CleanOptions): void => {
  for (const path of findPaths(doc, "enum")) {
    const parentPath = trimSuffix(path, ".enum");

    const shouldDrop =
      options.dropAllEnums === true ||
      (options.dropBooleanEnums === true &&
        asString(getAt(doc, joinPath(parentPath, "type"))) === "boolean");

    if (!shouldDrop) continue;
    const enumValue = getAt(doc, path);

    if (isJsonArray(enumValue) && enumValue.length === 1) {
      appendHint(doc, parentPath, `Allowed: ${asString(enumValue[0])}`);
    }

    delAt(doc, path);
  }
};

const addAdditionalPropertiesHints = (doc: Doc): void => {
  for (const p of findPaths(doc, "additionalProperties")) {
    if (getAt(doc, p) === false)
      appendHint(doc, trimSuffix(p, ".additionalProperties"), "No extra properties allowed");
  }
};

const UNSUPPORTED_CONSTRAINTS = [
  "minLength",
  "maxLength",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "format",
  "default",
  "examples",
];

const constraintKeywords = (options: CleanOptions): string[] => {
  if (options.preserveStandardConstraints === true) return [];
  const keywords = [...UNSUPPORTED_CONSTRAINTS];

  if (options.antigravitySemantics === true) keywords.push("minimum", "maximum", "multipleOf");

  return keywords;
};

const moveConstraintsToDescription = (doc: Doc, options: CleanOptions): void => {
  const constraints = constraintKeywords(options);

  if (constraints.length === 0) return;
  const pathsByField = findPathsByFields(doc, constraints);

  for (const key of constraints) {
    for (const p of pathsByField.get(key) ?? []) {
      const value = getAt(doc, p);

      if (value === undefined) continue;
      const parentPath = trimSuffix(p, `.${key}`);

      if (isPropertyDefinition(parentPath)) continue;

      const text =
        isJsonObject(value) || isJsonArray(value) ? JSON.stringify(value) : asString(value);

      appendHint(doc, parentPath, `${key}: ${text}`);
    }
  }
};

const moveNotToDescription = (doc: Doc): void => {
  for (const path of findPaths(doc, "not")) {
    const value = getAt(doc, path);

    if (value === undefined || isPropertyDefinition(trimSuffix(path, ".not"))) continue;
    appendHint(doc, trimSuffix(path, ".not"), `not: ${JSON.stringify(value)}`);
  }
};

// --- merging -------------------------------------------------------------------------------------------------------------

const mergeMissingSchemaAtPath = (doc: Doc, destination: string, incoming: Json): void => {
  const existing = getAt(doc, destination);

  if (existing === undefined) {
    setAt(doc, destination, structuredClone(incoming));

    return;
  }

  if (!isJsonObject(existing) || !isJsonObject(incoming)) return;

  for (const [key, value] of Object.entries(incoming)) {
    mergeMissingSchemaAtPath(doc, joinPath(destination, escapeKey(key)), value);
  }
};

const mergeConditionals = (doc: Doc): void => {
  const byField = findPathsByFields(doc, ["then", "else"]);
  const paths: string[] = [];

  for (const key of ["then", "else"]) {
    for (const p of byField.get(key) ?? []) {
      if (isPropertyDefinition(trimSuffix(p, `.${key}`))) continue;
      paths.push(p);
    }
  }

  sortByDepth(paths);

  for (const p of paths) {
    const props = getAt(doc, joinPath(p, "properties"));

    if (!isJsonObject(props)) continue;
    let parentPath: string;

    if (p.endsWith(".then")) parentPath = trimSuffix(p, ".then");
    else if (p.endsWith(".else")) parentPath = trimSuffix(p, ".else");
    else if (p === "then" || p === "else") parentPath = "";
    else continue;

    for (const [key, value] of Object.entries(props)) {
      const destPath = joinPath(parentPath, `properties.${escapeKey(key)}`);

      if (getAt(doc, destPath) === undefined) setAt(doc, destPath, structuredClone(value));
    }
  }
};

const mergeAllOf = (doc: Doc): void => {
  const paths = findPaths(doc, "allOf");
  sortByDepth(paths);

  for (const p of paths) {
    const allOf = getAt(doc, p);

    if (!isJsonArray(allOf)) continue;
    const parentPath = trimSuffix(p, ".allOf");

    for (const item of allOf) {
      if (!isJsonObject(item)) continue;

      for (const [field, value] of Object.entries(item)) {
        switch (field) {
          case "required": {
            if (!isJsonArray(value)) break;
            const reqPath = joinPath(parentPath, "required");
            const current = strings(doc, reqPath);

            for (const required of value) {
              const name = asString(required);

              if (!current.includes(name)) current.push(name);
            }

            setAt(doc, reqPath, current);
            break;
          }

          case "if":
          case "then":
          case "else":
          case "allOf":
            break;
          default:
            mergeMissingSchemaAtPath(doc, joinPath(parentPath, escapeKey(field)), value);
        }
      }
    }

    delAt(doc, p);
  }
};

type SelectBestResult = { bestIdx: number; types: string[] };

const selectBest = (items: Json[]): SelectBestResult => {
  let bestScore = -1;
  let bestIdx = 0;
  const types: string[] = [];
  items.forEach((item, i) => {
    let t = asString(get(item, "type"));
    let score: number;

    if (t === "object" || get(item, "properties") !== undefined) {
      score = 3;
      t = t === "" ? "object" : t;
    } else if (t === "array" || get(item, "items") !== undefined) {
      score = 2;
      t = t === "" ? "array" : t;
    } else if (t !== "" && t !== "null") {
      score = 1;
    } else if (t === "null") {
      score = 0;
      t = "null";
    } else {
      score = 0;
      t = "";
    }

    if (t !== "") types.push(t);

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });

  return { bestIdx, types };
};

/** A required-only union branch (`{"required":["a"]}`) declares no shape of its own. */
const isRequiredOnlyUnionBranch = (item: Json): boolean => {
  if (!isJsonObject(item) || !isJsonArray(item["required"])) return false;

  return !["type", "properties", "items", "enum", "anyOf", "oneOf", "allOf"].some(
    (key) => item[key] !== undefined,
  );
};

/** Gives a required-only branch the parent's declarations of the properties it requires, so it stands alone. */
const materializeRequiredOnlyBranch = (
  item: JsonObject,
  parentProps: Json | undefined,
): JsonObject | undefined => {
  if (!isJsonObject(parentProps)) return undefined;
  const required = stringArray(item["required"]);

  if (required.length === 0) return undefined;
  const properties: JsonObject = {};

  for (const name of required) {
    const declaration = parentProps[name];

    if (!Object.hasOwn(parentProps, name) || declaration === undefined) return undefined;
    properties[name] = structuredClone(declaration);
  }

  return { ...item, properties, type: "object" };
};

const isNullOnlyBranch = (item: JsonObject): boolean => {
  if (item["properties"] !== undefined || item["items"] !== undefined) return false;
  const type = item["type"];

  if (typeof type === "string") return type === "null";

  return isJsonArray(type) && type.length > 0 && type.every((elem) => asString(elem) === "null");
};

interface UnionBranches {
  /** The standalone branches that survive: not null, not unsatisfiable (`false`). */
  readonly nonNull: Json[];
  readonly hasNull: boolean;
  /** Whether a branch was dropped or rewritten (`true`, `false`, a required-only branch). */
  readonly hasFiltered: boolean;
}

const partitionUnionBranches = (items: Json[], parentProps: Json | undefined): UnionBranches => {
  const nonNull: Json[] = [];
  let hasNull = false;
  let hasFiltered = false;

  for (const item of items) {
    if (item === true) {
      nonNull.push({});
      hasFiltered = true;
      continue;
    }

    if (!isJsonObject(item)) {
      hasFiltered = true;
      continue;
    }

    if (isNullOnlyBranch(item)) {
      hasNull = true;
      continue;
    }

    if (isRequiredOnlyUnionBranch(item)) {
      const materialized = materializeRequiredOnlyBranch(item, parentProps);

      if (materialized !== undefined) nonNull.push(materialized);
      hasFiltered = true;
      continue;
    }

    nonNull.push(item);
  }

  return { nonNull, hasNull, hasFiltered };
};

/**
 * `flattenAnyOfOneOf`. Multi-branch unions (2+ standalone non-null branches) are preserved so non-first branches are
 * not lost; on the native Gemini/Antigravity Schema carrier (`!preserveOneOf`) `oneOf` becomes `anyOf`, which the
 * protobuf Schema supports and `oneOf` it rejects. A null branch becomes `nullable: true`. `flattenMultiBranch` forces the
 * single strongest branch instead, for the route whose upstream rejects nested multi-branch unions.
 */
const flattenAnyOfOneOf = (doc: Doc, preserveOneOf: boolean, flattenMultiBranch: boolean): void => {
  const byField = findPathsByFields(doc, ["oneOf", "anyOf"]);
  const paths = [...(byField.get("oneOf") ?? []), ...(byField.get("anyOf") ?? [])];
  sortByDepth(paths);

  for (const p of paths) {
    const key = p === "oneOf" || p.endsWith(".oneOf") ? "oneOf" : "anyOf";
    const arr = getAt(doc, p);

    if (!isJsonArray(arr) || arr.length === 0) continue;
    const parentPath = trimSuffix(p, `.${key}`);

    if (isPropertyDefinition(parentPath)) continue;
    const parent = parentPath === "" ? doc.root : getAt(doc, parentPath);

    // A node declaring both anyOf and oneOf on a native Schema carrier cannot keep a second union (protobuf Schema has a
    // single anyOf): anyOf stays primary and the oneOf constraint becomes a description hint. Routes that flatten
    // multi-branch unions skip this: the primary union is flattened away too.
    if (
      key === "oneOf" &&
      !flattenMultiBranch &&
      !preserveOneOf &&
      isJsonArray(get(parent, "anyOf"))
    ) {
      appendHint(doc, parentPath, `oneOf: ${JSON.stringify(arr)}`);
      delAt(doc, p);
      continue;
    }

    const parentProps = get(parent, "properties");
    const { nonNull, hasNull, hasFiltered } = partitionUnionBranches(arr, parentProps);
    // An earlier union-preserving pass may already have recorded the null branch as nullable:true on this node
    // (translator -> executor chain); that marker is part of the schema contract and survives flattening.
    const nullable = hasNull || get(parent, "nullable") === true;

    if (nonNull.length >= 2 && !flattenMultiBranch) {
      const targetKey = key === "oneOf" && !preserveOneOf ? "anyOf" : key;

      if (targetKey !== key || hasNull || hasFiltered) {
        setAt(doc, joinPath(parentPath, targetKey), nonNull);

        if (targetKey !== key) delAt(doc, p);
      }

      if (hasNull) {
        setAt(doc, joinPath(parentPath, "nullable"), true);
        appendHint(doc, parentPath, "(nullable)");
      }

      continue;
    }

    // A parent that already defines properties keeps them: branch properties merge into it and the union keyword goes.
    if (isJsonObject(parentProps)) {
      for (const item of nonNull) {
        const branchProps = get(item, "properties");

        if (!isJsonObject(branchProps)) continue;

        for (const [propKey, propVal] of Object.entries(branchProps)) {
          mergeMissingSchemaAtPath(
            doc,
            joinPath(parentPath, `properties.${escapeKey(propKey)}`),
            propVal,
          );
        }
      }

      if (nullable) setAt(doc, joinPath(parentPath, "nullable"), true);

      if (asString(get(parent, "type")) === "") setAt(doc, joinPath(parentPath, "type"), "object");
      delAt(doc, p);
      continue;
    }

    const parentDesc = asString(getAt(doc, descriptionPath(parentPath)));

    if (nonNull.length === 0) {
      if (!hasNull) {
        delAt(doc, p);
        continue;
      }

      const nullOnly: Json = { type: "null" };
      setRawAt(
        doc,
        parentPath,
        parentDesc === "" ? nullOnly : mergeDescriptionRaw(nullOnly, parentDesc),
      );
      continue;
    }

    let candidates = arr;

    if (hasFiltered || nonNull.length >= 2) {
      candidates = hasNull ? [...nonNull, { type: "null" }] : nonNull;
    }

    const { types: allTypes } = selectBest(candidates);
    // The strongest non-null branch (ties keep the first).
    let selected: Json = structuredClone(nonNull[selectBest(nonNull).bestIdx] ?? nonNull[0] ?? {});

    if (nullable && isJsonObject(selected)) selected = set(selected, "nullable", true);

    if (parentDesc !== "") selected = mergeDescriptionRaw(selected, parentDesc);

    if (allTypes.length > 1) selected = appendHintRaw(selected, `Accepts: ${allTypes.join(" | ")}`);
    else if (nullable) selected = appendHintRaw(selected, "(nullable)");
    setRawAt(doc, parentPath, selected);
  }
};

const flattenTypeArrays = (doc: Doc, preserveNativeNullable: boolean): void => {
  const paths = findPaths(doc, "type");
  sortByDepth(paths);
  const nullableFields = new Map<string, string[]>();

  for (const p of paths) {
    const res = getAt(doc, p);

    if (!isJsonArray(res) || res.length === 0) continue;
    let hasNull = false;
    const nonNull: string[] = [];

    for (const item of res) {
      const s = asString(item);

      if (s === "null") hasNull = true;
      else if (s !== "") nonNull.push(s);
    }

    const parentPath = trimSuffix(p, ".type");
    let firstType = "string";

    if (nonNull.length > 0) {
      if (getAt(doc, joinPath(parentPath, "items")) !== undefined && nonNull.includes("array"))
        firstType = "array";
      else if (
        getAt(doc, joinPath(parentPath, "properties")) !== undefined &&
        nonNull.includes("object")
      )
        firstType = "object";
      else
        // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
        firstType = nonNull[0] as string;
    }

    setAt(doc, p, firstType);

    if (firstType !== "array" && getAt(doc, joinPath(parentPath, "items")) !== undefined) {
      delAt(doc, joinPath(parentPath, "items"));
    }

    if (nonNull.length > 1) appendHint(doc, parentPath, `Accepts: ${nonNull.join(" | ")}`);

    if (hasNull) {
      if (preserveNativeNullable) {
        setAt(doc, joinPath(parentPath, "nullable"), true);
        appendHint(doc, parentPath, "(nullable)");
        continue;
      }

      const parts = splitPath(p);

      if (parts.length >= 3 && parts[parts.length - 3] === "properties") {
        // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
        const fieldEscaped = parts[parts.length - 2] as string;
        const fieldName = unescapeKey(fieldEscaped);
        const objectPath = parts.slice(0, parts.length - 3).join(".");
        nullableFields.set(objectPath, [...(nullableFields.get(objectPath) ?? []), fieldName]);
        appendHint(doc, joinPath(objectPath, `properties.${fieldEscaped}`), "(nullable)");
      }
    }
  }

  for (const [objectPath, fields] of nullableFields) {
    const reqPath = joinPath(objectPath, "required");
    const req = getAt(doc, reqPath);

    if (!isJsonArray(req)) continue;
    const filtered = req.map(asString).filter((name) => !fields.includes(name));

    if (filtered.length === 0) delAt(doc, reqPath);
    else setAt(doc, reqPath, filtered);
  }
};

// --- cleanup -------------------------------------------------------------------------------------------------------------

const removeExtensionFields = (doc: Doc): void => {
  const paths: string[] = [];

  const visit = (value: Json | undefined, path: string): void => {
    if (isJsonArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) visit(value[i], joinPath(path, String(i)));

      return;
    }

    if (!isJsonObject(value)) return;

    for (const [key, child] of Object.entries(value)) {
      const childPath = joinPath(path, escapeKey(key));

      if (key.startsWith("x-") && !isPropertyDefinition(path)) {
        paths.push(childPath);
        continue;
      }

      // Literal values are client data; x-* keys inside them are not schema extensions.
      if (isLiteralValueKeyword(key) && !isPropertyDefinition(path)) continue;
      visit(child, childPath);
    }
  };

  visit(doc.root, "");

  for (const p of paths) delAt(doc, p);
};

const removeUnsupportedKeywords = (doc: Doc, options: CleanOptions): void => {
  const keywords = [
    ...constraintKeywords(options),
    "$schema",
    "$defs",
    "definitions",
    "const",
    "$ref",
    "$id",
    "id",
    "additionalProperties",
    "$anchor",
    "$vocabulary",
    "$dynamicRef",
    "$dynamicAnchor",
    "propertyNames",
    "patternProperties",
    "dependentRequired",
    "dependentSchemas",
    "dependencies",
    "if",
    "then",
    "else",
    "$comment",
    "enumDescriptions",
    "enumTitles",
    "prefill",
    "deprecated",
    "encrypted",
    "discriminator",
    "readOnly",
    "writeOnly",
    "additionalItems",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contentSchema",
    "contentMediaType",
    "contentEncoding",
  ];

  if (options.antigravitySemantics === true) keywords.push("not");
  const deletePaths: string[] = [];
  const byField = findPathsByFields(doc, keywords);

  for (const key of keywords) {
    for (const p of byField.get(key) ?? []) {
      if (isPropertyDefinition(trimSuffix(p, `.${key}`))) continue;

      if (key === "additionalProperties") {
        if (options.preserveAllAdditionalProperties === true) continue;

        if (options.preserveAdditionalPropertiesFalse === true && getAt(doc, p) === false) continue;
      }

      deletePaths.push(p);
    }
  }

  sortByDepth(deletePaths);

  for (const p of deletePaths) delAt(doc, p);
  removeExtensionFields(doc);
};

const removeKeywords = (doc: Doc, keywords: string[]): void => {
  const deletePaths: string[] = [];
  const byField = findPathsByFields(doc, keywords);

  for (const key of keywords) {
    for (const p of byField.get(key) ?? []) {
      if (isPropertyDefinition(trimSuffix(p, `.${key}`))) continue;
      deletePaths.push(p);
    }
  }

  sortByDepth(deletePaths);

  for (const p of deletePaths) delAt(doc, p);
};

const removePlaceholderFields = (doc: Doc): void => {
  const paths = findPaths(doc, "_");
  sortByDepth(paths);

  for (const p of paths) {
    if (!p.endsWith(".properties._")) continue;
    delAt(doc, p);
    const parentPath = trimSuffix(p, ".properties._");
    const reqPath = joinPath(parentPath, "required");
    const req = getAt(doc, reqPath);

    if (isJsonArray(req)) {
      const filtered = req.map(asString).filter((r) => r !== "_");

      if (filtered.length === 0) delAt(doc, reqPath);
      else setAt(doc, reqPath, filtered);
    }
  }

  const reasonPaths = findPaths(doc, "reason");
  sortByDepth(reasonPaths);

  for (const p of reasonPaths) {
    if (!p.endsWith(".properties.reason")) continue;
    const parentPath = trimSuffix(p, ".properties.reason");
    const props = getAt(doc, joinPath(parentPath, "properties"));

    if (!isJsonObject(props) || Object.keys(props).length !== 1) continue;

    if (asString(getAt(doc, `${p}.description`)) !== PLACEHOLDER_REASON_DESCRIPTION) continue;
    delAt(doc, p);
    const reqPath = joinPath(parentPath, "required");
    const req = getAt(doc, reqPath);

    if (isJsonArray(req)) {
      const filtered = req.map(asString).filter((r) => r !== "reason");

      if (filtered.length === 0) delAt(doc, reqPath);
      else setAt(doc, reqPath, filtered);
    }
  }
};

const cleanupRequiredFields = (doc: Doc): void => {
  for (const p of findPaths(doc, "required")) {
    const parentPath = trimSuffix(p, ".required");
    const req = getAt(doc, p);
    const props = getAt(doc, joinPath(parentPath, "properties"));

    if (!isJsonArray(req)) continue;

    if (!isJsonObject(props)) {
      delAt(doc, p);
      continue;
    }

    const valid = req.map(asString).filter((key) => get(props, escapeKey(key)) !== undefined);

    if (valid.length !== req.length) {
      if (valid.length === 0) delAt(doc, p);
      else setAt(doc, p, valid);
    }
  }
};

/**
 * Normalizes native Schema arrays (a node declaring `items` is an array; `items` of a non-array is dropped) and, with
 * `addMissing`, gives array-typed nodes that still lack `items` after reference inlining the `{"type":"string"}`
 * placeholder Gemini requires. A node still holding a `$ref` is left alone.
 */
const sanitizeArrayItems = (doc: Doc, addMissing: boolean): void => {
  const paths = findPaths(doc, "items");
  sortByDepth(paths);

  for (const p of paths) {
    const parentPath = trimSuffix(p, ".items");

    if (isPropertyDefinition(parentPath)) continue;
    const typePath = joinPath(parentPath, "type");
    const t = asString(getAt(doc, typePath));

    if (t === "") setAt(doc, typePath, "array");
    else if (t.toLowerCase() !== "array") delAt(doc, p);
  }

  if (!addMissing) return;
  const typePaths = findPaths(doc, "type");
  sortByDepth(typePaths);

  for (const p of typePaths) {
    const parentPath = trimSuffix(p, ".type");

    if (isPropertyDefinition(parentPath) || !isArrayDeclaredType(getAt(doc, p))) continue;

    if (
      getAt(doc, joinPath(parentPath, "items")) !== undefined ||
      getAt(doc, joinPath(parentPath, "$ref")) !== undefined
    )
      continue;
    setAt(doc, joinPath(parentPath, "items"), { type: "string" });
  }
};

const hasSchemaConjunction = (doc: Doc): boolean =>
  findPaths(doc, "allOf").some((path) => isJsonArray(getAt(doc, path)));

/** Normalizes native Schema object declarations (skipped for JSON Schema conjunctions, see `cleanJsonSchema`). */
const sanitizeObjectProperties = (doc: Doc): void => {
  const paths = findPaths(doc, "properties");
  sortByDepth(paths);

  for (const p of paths) {
    const parentPath = trimSuffix(p, ".properties");

    if (isPropertyDefinition(parentPath)) continue;

    if (!isJsonObject(getAt(doc, p))) continue;
    const typePath = joinPath(parentPath, "type");

    if (asString(getAt(doc, typePath)).toLowerCase() !== "object") setAt(doc, typePath, "object");
  }
};

const addEmptySchemaPlaceholder = (doc: Doc): void => {
  const paths = findPaths(doc, "type");
  sortByDepth(paths);

  for (const p of paths) {
    if (asString(getAt(doc, p)) !== "object") continue;
    const parentPath = trimSuffix(p, ".type");
    const propsPath = joinPath(parentPath, "properties");
    const props = getAt(doc, propsPath);
    const reqPath = joinPath(parentPath, "required");
    const req = getAt(doc, reqPath);
    const hasRequired = isJsonArray(req) && req.length > 0;

    // A preserved union already constrains the node; a placeholder property would contradict its branches.
    if (
      isJsonArray(getAt(doc, joinPath(parentPath, "anyOf"))) ||
      isJsonArray(getAt(doc, joinPath(parentPath, "oneOf")))
    )
      continue;

    const needsPlaceholder =
      props === undefined || (isJsonObject(props) && Object.keys(props).length === 0);

    if (needsPlaceholder) {
      const reasonPath = joinPath(propsPath, "reason");
      setAt(doc, `${reasonPath}.type`, "string");
      setAt(doc, `${reasonPath}.description`, PLACEHOLDER_REASON_DESCRIPTION);
      setAt(doc, reqPath, ["reason"]);
      continue;
    }

    if (isJsonObject(props) && !hasRequired) {
      if (parentPath === "") continue;
      const placeholderPath = joinPath(propsPath, "_");

      if (getAt(doc, placeholderPath) === undefined)
        setAt(doc, `${placeholderPath}.type`, "boolean");
      setAt(doc, reqPath, ["_"]);
    }
  }
};

// --- entry points --------------------------------------------------------------------------------------------------------

const cleanJsonSchema = (schema: Json, options: CleanOptions): Json => {
  const doc: Doc = { root: structuredClone(schema) };
  // Array placeholders and array type inference wait for `sanitizeArrayItems` (after references are inlined and allOf
  // and unions are resolved), so a synthetic placeholder never clobbers items from a $ref target or an allOf branch.
  normalizeMalformedSchemaObjects(doc);

  // Every cleaner removes $defs/definitions later, so local references are expanded for every route.
  doc.root = inlineLocalRefsForClean(doc.root);
  convertRefsToHints(doc, options.antigravitySemantics === true);
  convertConstToEnum(doc);
  convertEnumValuesToStrings(doc, options.forceEnumStringType === true);
  addEnumHints(doc);
  dropIgnoredEnumsToHints(doc, options);

  if (
    options.preserveAdditionalPropertiesFalse !== true &&
    options.preserveAllAdditionalProperties !== true
  ) {
    addAdditionalPropertiesHints(doc);
  }

  moveConstraintsToDescription(doc, options);

  if (options.antigravitySemantics === true) moveNotToDescription(doc);

  // Once a JSON Schema contains a conjunction, local shape assumptions are unsafe in ancestors, siblings and
  // descendants alike, so the shape-rewriting passes are skipped for the whole document.
  const preserveConjunctions =
    options.preserveStandardConstraints === true && hasSchemaConjunction(doc);

  mergeConditionals(doc);

  // The JSON Schema carrier keeps conjunctions, including $ref sibling conflicts.
  if (options.preserveStandardConstraints !== true) mergeAllOf(doc);

  if (!preserveConjunctions) {
    if (options.flattenUnions === true) {
      flattenAnyOfOneOf(
        doc,
        options.preserveStandardConstraints === true,
        options.flattenMultiBranchUnions === true,
      );
    }

    flattenTypeArrays(doc, options.antigravitySemantics === true);
  }

  removeUnsupportedKeywords(doc, options);

  if (options.removeGeminiMetadata === true) {
    removeKeywords(doc, ["nullable", "title"]);
    removePlaceholderFields(doc);
  } else if (options.removeToolTitle === true) {
    removeKeywords(doc, ["title"]);
  }

  if (!preserveConjunctions) {
    cleanupRequiredFields(doc);
    sanitizeObjectProperties(doc);
    sanitizeArrayItems(doc, options.addMissingArrayItems === true);
  }

  if (options.addPlaceholder === true) addEmptySchemaPlaceholder(doc);

  return doc.root;
};

/** `CleanJSONSchemaForGemini`. */
export const cleanJsonSchemaForGemini = (schema: Json): Json =>
  cleanJsonSchema(schema, {
    addMissingArrayItems: true,
    removeGeminiMetadata: true,
    flattenUnions: true,
    forceEnumStringType: true,
  });

/** `CleanJSONSchemaForGeminiJSONSchema` (the `parametersJsonSchema` carrier keeps standard constraints). */
export const cleanJsonSchemaForGeminiJsonSchema = (schema: Json): Json =>
  cleanJsonSchema(schema, {
    addMissingArrayItems: true,
    removeGeminiMetadata: true,
    flattenUnions: true,
    forceEnumStringType: true,
    preserveAllAdditionalProperties: true,
    preserveStandardConstraints: true,
  });

const cleanAntigravityTool = (
  schema: Json,
  requirePlaceholder: boolean,
  flattenMultiBranchUnions: boolean,
): Json =>
  cleanJsonSchema(schema, {
    addPlaceholder: requirePlaceholder,
    addMissingArrayItems: true,
    antigravitySemantics: true,
    removeToolTitle: !requirePlaceholder,
    flattenUnions: true,
    flattenMultiBranchUnions,
    dropAllEnums: true,
  });

/** `CleanJSONSchemaForAntigravityTool`: multi-branch unions are preserved (Gemini models accept them). */
export const cleanJsonSchemaForAntigravityTool = (
  schema: Json,
  requirePlaceholder: boolean,
): Json => cleanAntigravityTool(schema, requirePlaceholder, false);

/**
 * `CleanJSONSchemaForAntigravityClaudeTool`: the Antigravity tool cleaner for Claude models. The Antigravity Claude
 * backend turns function declarations into Claude `custom.input_schema` and rejects nested multi-branch unions with
 * "JSON schema is invalid", so they flatten to the single strongest branch (CLIProxyAPI #3662 and its follow-up).
 */
export const cleanJsonSchemaForAntigravityClaudeTool = (
  schema: Json,
  requirePlaceholder: boolean,
): Json => cleanAntigravityTool(schema, requirePlaceholder, true);

/** `CleanJSONSchemaForAntigravity`. */
export const cleanJsonSchemaForAntigravity = (schema: Json): Json =>
  cleanJsonSchemaForAntigravityTool(schema, true);

/** `CleanJSONSchemaForAntigravityResponse`. */
export const cleanJsonSchemaForAntigravityResponse = (schema: Json): Json =>
  cleanJsonSchema(schema, {
    antigravitySemantics: true,
    flattenUnions: true,
    dropBooleanEnums: true,
    preserveAdditionalPropertiesFalse: true,
  });
