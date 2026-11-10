/**
 * JSON schema cleaning for Gemini / Antigravity tool declarations.
 *
 * Go source: internal/util/gemini_schema.go (cleanJSONSchema and its passes, CleanJSONSchemaForGemini,
 * CleanJSONSchemaForGeminiJSONSchema, CleanJSONSchemaForAntigravity*, InlineLocalRefs) and internal/util/translator.go
 * (Walk). The Go code rewrites a JSON string through gjson/sjson paths; this port keeps the same path based passes on
 * a parsed document (`Doc`) using the gjson/sjson engine of `@commissary/json`. Pass one single schema, never a request.
 *
 * Differences: hint texts embed `JSON.stringify` of objects/arrays (Go keeps the original raw text).
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

export const PLACEHOLDER_REASON_DESCRIPTION = "Brief explanation of why you are calling this tool";

interface CleanOptions {
  readonly addPlaceholder?: boolean;
  readonly addMissingArrayItems?: boolean;
  readonly antigravitySemantics?: boolean;
  readonly removeToolTitle?: boolean;
  readonly removeGeminiMetadata?: boolean;
  readonly flattenUnions?: boolean;
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

const NAME_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

/** Whether `path` addresses a map keyed by author-chosen names (odd trailing run of name-map keywords). */
const isPropertyDefinition = (path: string): boolean => {
  const segments = splitPath(path);
  let trailing = 0;

  for (let i = segments.length - 1; i >= 0; i--) {
    // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    if (!NAME_MAP_KEYWORDS.has(unescapeKey(segments[i] as string))) break;
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

const mergeHint = (existing: string, hint: string): string => {
  if (existing === "") return hint;

  if (existing === hint || existing.startsWith(`${hint} (`) || existing.includes(`(${hint})`))
    return existing;

  return `${existing} (${hint})`;
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

/** `Walk`: every path whose key equals `field` (arrays are walked with index keys). */
const walk = (value: Json | undefined, path: string, field: string, paths: string[]): void => {
  const entries: Array<[string, Json]> = isJsonArray(value)
    ? value.map((item, index): [string, Json] => [String(index), item])
    : isJsonObject(value)
      ? Object.entries(value)
      : [];

  for (const [key, child] of entries) {
    const childPath = path === "" ? escapeKey(key) : `${path}.${escapeKey(key)}`;

    if (key === field) paths.push(childPath);
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

const repairSchemaList = (list: Json[], addItems: boolean): RepairSchemaListResult => {
  let modified = false;

  const out = list.map((item) => {
    if (isJsonObject(item)) {
      const repaired = repairSchemaNode(item, addItems);

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

const repairPropertyMap = (props: JsonObject, addItems: boolean): RepairPropertyMapResult => {
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

    const repaired = repairSchemaNode(child, addItems);

    if (repaired.modified) modified = true;
    out[key] = repaired.node;
  }

  promoted.sort();

  return { out, promoted, modified };
};

type RepairSchemaNodeResult = { node: JsonObject; modified: boolean };

function repairSchemaNode(node: JsonObject, addItems: boolean): RepairSchemaNodeResult {
  let modified = false;
  const clone: JsonObject = { ...node };

  if (!isNonObjectDeclaredType(clone["type"])) {
    const bare: JsonObject = {};

    for (const [k, v] of Object.entries(clone)) {
      if (isJsonObject(v) && !isKnownKeywordOrExtension(k)) bare[k] = v;
    }

    if (Object.keys(bare).length > 0) {
      const repaired = repairPropertyMap(bare, addItems);

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

  if (isJsonObject(props)) {
    if (!Object.hasOwn(clone, "type")) {
      clone["type"] = "object";
      modified = true;
    }

    const repaired = repairPropertyMap(props, addItems);

    if (repaired.modified) {
      clone["properties"] = repaired.out;
      modified = true;
    }

    if (repaired.promoted.length > 0) {
      clone["required"] = mergeStringSlices(stringArray(clone["required"]), repaired.promoted);
      modified = true;
    }
  }

  if (addItems) {
    if (isArrayDeclaredType(clone["type"])) {
      if (!Object.hasOwn(clone, "items")) {
        clone["items"] = { type: "string" };
        modified = true;
      }
    } else if (Object.hasOwn(clone, "items")) {
      if (clone["type"] === null || clone["type"] === undefined || clone["type"] === "") {
        clone["type"] = "array";
        modified = true;
      }
    }
  }

  const items = clone["items"];

  if (isJsonObject(items)) {
    const repaired = repairSchemaNode(items, addItems);

    if (repaired.modified) {
      clone["items"] = repaired.node;
      modified = true;
    }
  } else if (isJsonArray(items)) {
    const repaired = repairSchemaList(items, addItems);

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
    const repaired = repairSchemaNode(additional, addItems);

    if (repaired.modified) {
      clone["additionalProperties"] = repaired.node;
      modified = true;
    }
  }

  const pattern = clone["patternProperties"];

  if (isJsonObject(pattern)) {
    const repaired = repairPropertyMap(pattern, addItems);

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
      const repaired = repairSchemaNode(sub, addItems);

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
      const repaired = repairSchemaList(list, addItems);

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
        const repaired = repairSchemaNode(dv, addItems);
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

const normalizeMalformedSchemaObjects = (doc: Doc, addItems: boolean): void => {
  const root = doc.root;

  if (root === true) {
    doc.root = {};

    return;
  }

  if (!isJsonObject(root) || isApiRequestDocument(root)) return;

  if (Object.keys(root).length === 1) {
    const inner = root["schema"];

    if (isJsonObject(inner)) {
      const repaired = repairSchemaNode(inner, addItems);

      if (repaired.modified) doc.root = { schema: repaired.node };

      return;
    }

    if (inner === true) {
      doc.root = { schema: {} };

      return;
    }
  }

  const repaired = repairSchemaNode(root, addItems);

  if (repaired.modified) doc.root = repaired.node;
};

// --- $ref handling -------------------------------------------------------------------------------------------------------

const resolveJsonPointer = (
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
      // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      current = current[index] as Json;
    } else {
      return { found: false };
    }
  }

  return { found: true, value: current };
};

const refName = (ref: string): string => {
  const index = ref.lastIndexOf("/");

  if (index >= 0 && index + 1 < ref.length)
    return ref
      .slice(index + 1)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");

  return ref;
};

const cyclicRefFallback = (node: JsonObject, target: Json, ref: string): JsonObject => {
  const out: JsonObject = {};

  if (isJsonObject(target)) {
    for (const key of ["type", "nullable", "description"])
      if (Object.hasOwn(target, key))
        // SAFETY: `Object.hasOwn(target, key)` was checked above, so the key is present; the cast only drops the `undefined` added by noUncheckedIndexedAccess.
        out[key] = target[key] as Json;
  }

  for (const [key, value] of Object.entries(node)) if (key !== "$ref") out[key] = value;
  const hint = `See: ${refName(ref)}`;
  const description = out["description"];
  out["description"] =
    typeof description === "string" && description !== "" ? mergeHint(description, hint) : hint;

  return out;
};

const resolveLocalRefs = (root: Json, value: Json, active: Set<string>): Json => {
  if (isJsonArray(value)) return value.map((item) => resolveLocalRefs(root, item, active));

  if (!isJsonObject(value)) return value;
  const ref = value["$ref"];

  if (typeof ref === "string" && ref.startsWith("#/")) {
    const target = resolveJsonPointer(root, ref);

    if (target.found) {
      if (active.has(ref)) return cyclicRefFallback(value, target.value, ref);
      active.add(ref);
      const resolvedTarget = resolveLocalRefs(root, target.value, active);
      active.delete(ref);

      if (isJsonObject(resolvedTarget)) {
        const out: JsonObject = { ...resolvedTarget };

        for (const [key, item] of Object.entries(value)) {
          if (key !== "$ref") out[key] = resolveLocalRefs(root, item, active);
        }

        return out;
      }
    }
  }

  const out: JsonObject = {};

  for (const [key, item] of Object.entries(value)) out[key] = resolveLocalRefs(root, item, active);

  return out;
};

const inlineLocalRefs = (doc: Doc): void => {
  if (!JSON.stringify(doc.root).includes('"$ref"')) return;
  doc.root = resolveLocalRefs(doc.root, doc.root, new Set());
};

const convertRefsToHints = (doc: Doc, preserveSiblings: boolean): void => {
  const paths = findPaths(doc, "$ref");
  sortByDepth(paths);

  for (const p of paths) {
    const defName = refName(asString(getAt(doc, p)));
    const parentPath = trimSuffix(p, ".$ref");
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

    if (value === undefined) continue;
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

const flattenAnyOfOneOf = (doc: Doc): void => {
  for (const key of ["anyOf", "oneOf"]) {
    const paths = findPaths(doc, key);
    sortByDepth(paths);

    for (const p of paths) {
      const arr = getAt(doc, p);

      if (!isJsonArray(arr) || arr.length === 0) continue;
      const parentPath = trimSuffix(p, `.${key}`);
      const parent = parentPath === "" ? doc.root : getAt(doc, parentPath);
      const items = arr;

      if (isJsonObject(get(parent, "properties"))) {
        let hasNull = false;

        for (const item of items) {
          if (asString(get(item, "type")) === "null") hasNull = true;
          const branchProps = get(item, "properties");

          if (isJsonObject(branchProps)) {
            for (const [propKey, propVal] of Object.entries(branchProps)) {
              mergeMissingSchemaAtPath(
                doc,
                joinPath(parentPath, `properties.${escapeKey(propKey)}`),
                propVal,
              );
            }
          }
        }

        if (hasNull) setAt(doc, joinPath(parentPath, "nullable"), true);

        if (asString(get(parent, "type")) === "")
          setAt(doc, joinPath(parentPath, "type"), "object");
        delAt(doc, p);
        continue;
      }

      const parentDesc = asString(getAt(doc, descriptionPath(parentPath)));
      const { bestIdx, types } = selectBest(items);
      // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      let selected: Json = structuredClone(items[bestIdx] as Json);
      const hasNull = items.some((item) => asString(get(item, "type")) === "null");

      if (hasNull && asString(get(items[bestIdx], "type")) !== "null" && isJsonObject(selected)) {
        selected = set(selected, "nullable", true);
      }

      if (parentDesc !== "") selected = mergeDescriptionRaw(selected, parentDesc);

      if (types.length > 1) selected = appendHintRaw(selected, `Accepts: ${types.join(" | ")}`);
      setRawAt(doc, parentPath, selected);
    }
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

const sanitizeArrayItems = (doc: Doc): void => {
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
};

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
  normalizeMalformedSchemaObjects(doc, options.addMissingArrayItems === true);

  if (options.antigravitySemantics === true) inlineLocalRefs(doc);
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

  mergeConditionals(doc);
  mergeAllOf(doc);

  if (options.flattenUnions === true) flattenAnyOfOneOf(doc);
  flattenTypeArrays(doc, options.antigravitySemantics === true);

  removeUnsupportedKeywords(doc, options);

  if (options.removeGeminiMetadata === true) {
    removeKeywords(doc, ["nullable", "title"]);
    removePlaceholderFields(doc);
  } else if (options.removeToolTitle === true) {
    removeKeywords(doc, ["title"]);
  }

  cleanupRequiredFields(doc);
  sanitizeArrayItems(doc);
  sanitizeObjectProperties(doc);

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

/** `CleanJSONSchemaForAntigravityTool`. */
export const cleanJsonSchemaForAntigravityTool = (
  schema: Json,
  requirePlaceholder: boolean,
): Json =>
  cleanJsonSchema(schema, {
    addPlaceholder: requirePlaceholder,
    addMissingArrayItems: true,
    antigravitySemantics: true,
    removeToolTitle: !requirePlaceholder,
    flattenUnions: true,
    dropAllEnums: true,
  });

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
