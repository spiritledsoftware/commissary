/**
 * Claude tool arguments against the client's declared schemas (Gemini and Antigravity -> Claude responses).
 *
 * Go source: internal/util/translator.go (CleanClaudeToolArguments, CleanClaudeToolArgumentsWithTranslated,
 * ClaudeToolIsParameterless, MapClaudeToolName and the claude* schema analysis helpers; upstream 202b8b8c, e1fb2521).
 *
 * Request translation injects placeholder properties (`reason`, `_`) into empty object schemas and flattens unions for
 * Gemini. The function-call arguments that come back may carry those placeholders; they are removed (and parameterless
 * tools normalise to `{}`) only when the original schema proves the placeholder was not the client's own. Schemas this
 * analysis cannot resolve deterministically are left untouched.
 */
import {
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  tryParseJson,
} from "@commissary/json";
import {
  cleanJsonSchemaForAntigravity,
  PLACEHOLDER_REASON_DESCRIPTION,
} from "../gemini/util/json-schema.ts";
import { sanitizeFunctionName } from "../gemini/util/claude.ts";
import { inlineToolAdditionDefinitions } from "./claude-tool-addition.ts";
import {
  canonicalToolName,
  mapToolName,
  type NameMap,
  sanitizedFunctionNameMap,
} from "./tool-names.ts";

const MAX_SCHEMA_DEPTH = 16;

/** A path into the arguments: object keys and array indices. */
type Path = ReadonlyArray<string | number>;

/** The arguments under edit; `value` is replaced when the whole object is normalised. */
interface Holder {
  value: Json;
}

/** gjson `Result.Array()`: an array as is, an absent or null value as empty, any other value as one element. */
const arrayOf = (value: Json | undefined): Json[] => {
  if (value === undefined || value === null) return [];

  return isJsonArray(value) ? value : [value];
};

const hasKey = (value: Json | undefined, key: string): boolean =>
  isJsonObject(value) && Object.hasOwn(value, key);

const prop = (value: Json | undefined, key: string): Json | undefined =>
  isJsonObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;

const entriesOf = (value: Json | undefined): Array<[string, Json]> =>
  isJsonObject(value) ? Object.entries(value) : [];

const rawOf = (value: Json | undefined): string =>
  value === undefined ? "" : JSON.stringify(value);

const getAt = (holder: Holder, path: Path): Json | undefined => {
  let node: Json | undefined = holder.value;

  for (const key of path) {
    if (typeof key === "number") node = isJsonArray(node) ? node[key] : undefined;
    else node = prop(node, key);

    if (node === undefined) return undefined;
  }

  return node;
};

const setAt = (holder: Holder, path: Path, value: Json): void => {
  const last = path.at(-1);

  if (last === undefined) {
    holder.value = value;

    return;
  }

  const parent = getAt(holder, path.slice(0, -1));

  if (typeof last === "number" && isJsonArray(parent)) parent[last] = value;
  else if (typeof last === "string" && isJsonObject(parent)) parent[last] = value;
};

const deleteAt = (holder: Holder, path: Path): void => {
  const last = path.at(-1);

  if (last === undefined) return;
  const parent = getAt(holder, path.slice(0, -1));

  if (isJsonObject(parent) && typeof last === "string") delete parent[last];
};

const appendUniqueSchema = (schemas: Json[], value: Json): void => {
  const raw = rawOf(value);

  if (!schemas.some((existing) => rawOf(existing) === raw)) schemas.push(value);
};

interface ObjectInfo {
  properties: Map<string, Json[]>;
  required: Set<string>;
  hasProperties: boolean;
  allowsDynamic: boolean;
  forbidsDynamic: boolean;
  hasPatternProperties: boolean;
  complex: boolean;
  unsafeComplex: boolean;
  declaresObject: boolean;
  branchInfos: ObjectInfo[];
}

const newInfo = (): ObjectInfo => ({
  properties: new Map(),
  required: new Set(),
  hasProperties: false,
  allowsDynamic: false,
  forbidsDynamic: false,
  hasPatternProperties: false,
  complex: false,
  unsafeComplex: false,
  declaresObject: false,
  branchInfos: [],
});

const hasPatternProperties = (schema: Json | undefined): boolean => {
  const patterns = prop(schema, "patternProperties");

  return isJsonObject(patterns) && Object.keys(patterns).length > 0;
};

/** patternProperties permit matching keys even when additionalProperties is false, so a `false` sibling never cancels them. */
const schemaAllowsDynamic = (schema: Json | undefined): boolean => {
  if (hasPatternProperties(schema)) return true;
  const additional = prop(schema, "additionalProperties");

  return additional !== undefined && additional !== false;
};

const schemaForbidsDynamic = (schema: Json | undefined): boolean =>
  prop(schema, "additionalProperties") === false;

const resolveLocalRef = (root: Json | undefined, ref: string): Json | undefined => {
  if (!ref.startsWith("#/")) return undefined;
  let current: Json | undefined = root;

  for (const raw of ref.slice(2).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");

    if (hasKey(current, segment)) {
      current = prop(current, segment);
    } else if (isJsonArray(current)) {
      const index = /^[+-]?\d+$/.test(segment) ? Number(segment) : Number.NaN;

      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else {
      return undefined;
    }
  }

  return current;
};

const schemaDeclaresObject = (schema: Json | undefined): boolean => {
  const type = prop(schema, "type");

  if (type === "object") return true;

  return isJsonArray(type) && type.some((item) => item === "object");
};

const isNullBranch = (branch: Json): boolean => {
  const type = prop(branch, "type");

  return type === "null" || (isJsonArray(type) && type.length === 1 && type[0] === "null");
};

interface UnionBranches {
  branches: Json[];
  ok: boolean;
}

/** The non-null `anyOf`/`oneOf` branches, de-duplicated; `ok: false` when a union keyword is not an array. */
const unionBranches = (schema: Json | undefined): UnionBranches => {
  const branches: Json[] = [];
  const seen = new Set<string>();

  for (const keyword of ["anyOf", "oneOf"]) {
    const union = prop(schema, keyword);

    if (union === undefined) continue;

    if (!isJsonArray(union)) return { branches: [], ok: false };

    for (const branch of union) {
      if (isNullBranch(branch)) continue;
      const raw = rawOf(branch);

      if (seen.has(raw)) continue;
      seen.add(raw);
      branches.push(branch);
    }
  }

  return { branches, ok: true };
};

const ANALYZED_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "description",
  "title",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "patternProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "$ref",
  "$defs",
  "definitions",
  "nullable",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "format",
  "default",
  "examples",
  "minItems",
  "maxItems",
  "maxProperties",
  "$schema",
  "$id",
  "id",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
  "example",
  "contentEncoding",
  "contentMediaType",
]);

const hasUnanalyzedKeyword = (schema: Json | undefined): boolean =>
  entriesOf(schema).some(([key]) => !key.startsWith("x-") && !ANALYZED_KEYWORDS.has(key));

const mergeInfo = (dst: ObjectInfo, src: ObjectInfo): void => {
  if (src.hasProperties) {
    dst.hasProperties = true;

    for (const [key, values] of src.properties) {
      const merged = dst.properties.get(key) ?? [];

      for (const value of values) appendUniqueSchema(merged, value);
      dst.properties.set(key, merged);
    }
  }

  for (const name of src.required) dst.required.add(name);
  dst.branchInfos.push(...src.branchInfos);
  dst.allowsDynamic ||= src.allowsDynamic;
  dst.forbidsDynamic ||= src.forbidsDynamic;
  dst.hasPatternProperties ||= src.hasPatternProperties;
  dst.complex ||= src.complex;
  dst.unsafeComplex ||= src.unsafeComplex;
  dst.declaresObject ||= src.declaresObject;
};

const collectProperties = (info: ObjectInfo, props: Json | undefined): void => {
  for (const [key, value] of entriesOf(props)) {
    const schemas = info.properties.get(key) ?? [];
    appendUniqueSchema(schemas, value);
    info.properties.set(key, schemas);
  }
};

const analyzeDepth = (
  schema: Json | undefined,
  root: Json | undefined,
  depth: number,
  visitedRefs: Set<string>,
): ObjectInfo => {
  const info = newInfo();

  if (depth > MAX_SCHEMA_DEPTH || !isJsonObject(schema)) {
    info.complex = true;

    return info;
  }

  if (schemaDeclaresObject(schema)) info.declaresObject = true;

  if (hasUnanalyzedKeyword(schema)) {
    // Any keyword outside the analysed set (enum, const, contains, conditionals, unevaluated*, ...) may constrain
    // legal values in ways this analysis does not model: no destructive cleaning may run on such a schema.
    info.complex = true;
    info.unsafeComplex = true;

    return info;
  }

  if (prop(schema, "anyOf") !== undefined || prop(schema, "oneOf") !== undefined) {
    const { branches, ok } = unionBranches(schema);

    if (!ok || branches.length === 0) {
      info.complex = true;

      return info;
    }

    if (branches.length > 1) {
      // Multi-branch unions stay complex so this level never normalises arguments, but every branch's declared
      // properties are collected so child recursion and placeholder protection see the full declaration. Branches are
      // alternatives: their dynamic-property policies are kept apart in `branchInfos`.
      for (const branch of branches) {
        const branchInfo = analyzeDepth(branch, root, depth + 1, visitedRefs);
        info.branchInfos.push(branchInfo);
        mergeInfo(info, branchInfo);
      }

      if (schemaAllowsDynamic(schema)) info.allowsDynamic = true;

      if (schemaForbidsDynamic(schema)) info.forbidsDynamic = true;

      if (hasPatternProperties(schema)) info.hasPatternProperties = true;

      for (const name of arrayOf(prop(schema, "required"))) info.required.add(asString(name));
      const props = prop(schema, "properties");

      if (isJsonObject(props)) {
        info.hasProperties = true;
        info.declaresObject = true;
        collectProperties(info, props);
      }

      // Sibling $ref/allOf applicators still constrain this node alongside the union.
      const ref = prop(schema, "$ref");

      if (ref !== undefined) {
        const refValue = asString(ref);

        if (!visitedRefs.has(refValue)) {
          const target = resolveLocalRef(root, refValue);

          if (target !== undefined) {
            visitedRefs.add(refValue);
            const resolved = analyzeDepth(target, root, depth + 1, visitedRefs);
            visitedRefs.delete(refValue);
            mergeInfo(info, resolved);
          }
        }
      }

      const allOf = prop(schema, "allOf");

      if (isJsonArray(allOf)) {
        for (const branch of allOf)
          mergeInfo(info, analyzeDepth(branch, root, depth + 1, visitedRefs));
      }

      info.complex = true;

      return info;
    }

    mergeInfo(info, analyzeDepth(branches[0], root, depth + 1, visitedRefs));
  }

  const ref = prop(schema, "$ref");

  if (ref !== undefined) {
    const refValue = asString(ref);

    if (visitedRefs.has(refValue)) {
      info.complex = true;

      return info;
    }

    const target = resolveLocalRef(root, refValue);

    if (target === undefined) {
      info.complex = true;

      return info;
    }

    visitedRefs.add(refValue);
    const resolved = analyzeDepth(target, root, depth + 1, visitedRefs);
    visitedRefs.delete(refValue);
    mergeInfo(info, resolved);
  }

  const allOf = prop(schema, "allOf");

  if (isJsonArray(allOf)) {
    for (const branch of allOf) mergeInfo(info, analyzeDepth(branch, root, depth + 1, visitedRefs));
  } else if (allOf !== undefined) {
    info.complex = true;
  }

  if (schemaAllowsDynamic(schema)) info.allowsDynamic = true;

  if (schemaForbidsDynamic(schema)) info.forbidsDynamic = true;

  if (hasPatternProperties(schema)) info.hasPatternProperties = true;
  const props = prop(schema, "properties");

  if (props !== undefined) {
    if (!isJsonObject(props)) {
      info.complex = true;
    } else {
      info.hasProperties = true;
      info.declaresObject = true;
      collectProperties(info, props);
    }
  }

  for (const name of arrayOf(prop(schema, "required"))) info.required.add(asString(name));

  return info;
};

const analyze = (schema: Json | undefined, root: Json | undefined): ObjectInfo =>
  analyzeDepth(schema, root, 0, new Set());

interface ToolSchema {
  /** `undefined` when the declaration has no schema at all. */
  schema: Json | undefined;
}

const toolNameOf = (tool: Json): string => {
  const name = asString(prop(tool, "name")).trim();

  return name !== "" ? name : asString(get(tool, "function.name")).trim();
};

/** Every schema is the first one, byte for byte. */
const identical = (schemas: Array<Json | undefined>): boolean =>
  schemas.every((schema) => rawOf(schema) === rawOf(schemas[0]));

/** The schema of the single tool the name resolves to; `undefined` when it is absent or ambiguous. */
const findToolSchema = (original: Json | undefined, toolName: string): ToolSchema | undefined => {
  if (toolName === "" || original === undefined) return undefined;
  const tools = get(original, "tools");

  if (!isJsonArray(tools)) return undefined;
  const exact: Array<Json | undefined> = [];
  const canonical = canonicalToolName(toolName);
  const canonicalMatches = new Map<string, Array<Json | undefined>>();

  for (const tool of tools) {
    const name = toolNameOf(tool);

    if (name === "") continue;

    const schema =
      prop(tool, "input_schema") ?? prop(tool, "parameters") ?? get(tool, "function.parameters");

    if (name === toolName) exact.push(schema);

    if (canonicalToolName(name) === canonical) {
      const group = canonicalMatches.get(name) ?? [];
      group.push(schema);
      canonicalMatches.set(name, group);
    }
  }

  if (exact.length === 1) return { schema: exact[0] };

  if (exact.length > 1) return identical(exact) ? { schema: exact[0] } : undefined;

  if (canonicalMatches.size === 1) {
    const [matches] = [...canonicalMatches.values()];

    if (matches !== undefined && identical(matches)) return { schema: matches[0] };
  }

  return undefined;
};

const infoAnyBranchAllowsDynamic = (info: ObjectInfo): boolean => {
  if (info.hasPatternProperties) return true;

  if (info.branchInfos.length === 0) return info.allowsDynamic && !info.forbidsDynamic;

  if (info.branchInfos.some(infoAnyBranchAllowsDynamic)) return true;

  return info.allowsDynamic && !info.forbidsDynamic;
};

/**
 * Whether the tool was declared with a missing schema or an explicitly closed empty object schema
 * (`additionalProperties: false`). Objects that omit `additionalProperties` are open, not parameterless (e1fb2521).
 */
export const claudeToolIsParameterless = (
  toolName: string,
  original: Json | undefined,
): boolean => {
  const found = findToolSchema(original, toolName);

  if (found === undefined) return false;

  if (found.schema === undefined) return true;
  const info = analyze(found.schema, found.schema);

  if (
    info.complex ||
    infoAnyBranchAllowsDynamic(info) ||
    !info.declaresObject ||
    !info.forbidsDynamic
  )
    return false;

  return info.required.size === 0 && (!info.hasProperties || info.properties.size === 0);
};

interface ArrayItems {
  items: Json[];
  ok: boolean;
}

/** The `items` schemas of an array schema; `ok: false` when they cannot be resolved deterministically. */
const resolveArrayItems = (
  schema: Json | undefined,
  root: Json | undefined,
  depth: number,
  visitedRefs: Set<string>,
): ArrayItems => {
  if (depth > MAX_SCHEMA_DEPTH || !isJsonObject(schema)) return { items: [], ok: false };
  const items: Json[] = [];
  let deterministic = true;
  const ref = prop(schema, "$ref");

  if (ref !== undefined) {
    const refValue = asString(ref);

    if (visitedRefs.has(refValue)) return { items: [], ok: false };
    const target = resolveLocalRef(root, refValue);

    if (target === undefined) return { items: [], ok: false };
    visitedRefs.add(refValue);
    const resolved = resolveArrayItems(target, root, depth + 1, visitedRefs);
    visitedRefs.delete(refValue);

    if (!resolved.ok) deterministic = false;
    else for (const item of resolved.items) appendUniqueSchema(items, item);
  }

  if (prop(schema, "anyOf") !== undefined || prop(schema, "oneOf") !== undefined) {
    const { branches, ok } = unionBranches(schema);

    if (!ok || branches.length !== 1) {
      deterministic = false;
    } else {
      const resolved = resolveArrayItems(branches[0], root, depth + 1, visitedRefs);

      if (!resolved.ok) deterministic = false;
      else for (const item of resolved.items) appendUniqueSchema(items, item);
    }
  }

  const allOf = prop(schema, "allOf");

  if (isJsonArray(allOf)) {
    for (const branch of allOf) {
      const resolved = resolveArrayItems(branch, root, depth + 1, visitedRefs);

      if (!resolved.ok) {
        deterministic = false;
        continue;
      }

      for (const item of resolved.items) appendUniqueSchema(items, item);
    }
  } else if (allOf !== undefined) {
    deterministic = false;
  }

  const direct = prop(schema, "items");

  if (direct !== undefined) appendUniqueSchema(items, direct);

  return { items, ok: deterministic };
};

const arraySchemaUnsafe = (schema: Json | undefined, root: Json | undefined): boolean =>
  analyze(schema, root).unsafeComplex;

const objectHasAll = (required: ReadonlySet<string>, current: Json | undefined): boolean =>
  [...required].every((name) => hasKey(current, name));

const branchMayAccept = (info: ObjectInfo, key: string, current: Json | undefined): boolean => {
  // patternProperties permit matching keys regardless of additionalProperties.
  if (info.hasPatternProperties) return true;

  // A branch that does not forbid additional properties accepts the key by JSON Schema default. To avoid treating every
  // unconstrained sibling as permission, this implicit permission only counts when the object carries every property the
  // branch requires.
  if (!info.forbidsDynamic && objectHasAll(info.required, current)) return true;

  if (info.allowsDynamic && !info.forbidsDynamic) return true;

  for (const branch of info.branchInfos) {
    // A branch that declares the key constrains it with its own explicit schema, already among the candidates.
    if (branch.properties.has(key)) continue;

    if (branchMayAccept(branch, key, current)) return true;
  }

  return false;
};

const parentBranchAcceptsChild = (
  originalInfo: ObjectInfo,
  key: string,
  current: Json | undefined,
): boolean =>
  originalInfo.branchInfos.some(
    (branch) => !branch.properties.has(key) && branchMayAccept(branch, key, current),
  );

const candidateMayPermitChild = (
  info: ObjectInfo,
  key: string,
  current: Json | undefined,
): boolean => {
  if (info.properties.has(key)) return false;

  if (info.hasPatternProperties) return true;

  if (info.forbidsDynamic) return false;

  return objectHasAll(info.required, current);
};

const originalsMayPermitChild = (
  originals: Json[],
  root: Json | undefined,
  key: string,
  current: Json | undefined,
): boolean => {
  if (originals.length <= 1) return false;

  return originals.some((original) => {
    const info = analyze(original, root);

    return !info.complex && candidateMayPermitChild(info, key, current);
  });
};

const originalsAnyCandidateAcceptsImplicitly = (
  originals: Json[],
  root: Json | undefined,
  current: Json | undefined,
): boolean => {
  if (originals.length <= 1) return false;

  return originals.some((original) => {
    const info = analyze(original, root);

    return !info.complex && !info.forbidsDynamic && objectHasAll(info.required, current);
  });
};

const originalsAnyBranchAllowsDynamic = (originals: Json[], root: Json | undefined): boolean =>
  originals.some((original) => infoAnyBranchAllowsDynamic(analyze(original, root)));

const mergedOriginalInfo = (originals: Json[], root: Json | undefined): ObjectInfo => {
  const merged = newInfo();

  for (const original of originals) mergeInfo(merged, analyze(original, root));

  return merged;
};

const originalDeclaresPropertyDeep = (
  schema: Json | undefined,
  root: Json | undefined,
  property: string,
  depth: number,
  visitedRefs: Set<string>,
): boolean => {
  if (depth > MAX_SCHEMA_DEPTH || !isJsonObject(schema)) return false;
  const ref = prop(schema, "$ref");

  if (ref !== undefined) {
    const refValue = asString(ref);

    if (!visitedRefs.has(refValue)) {
      const target = resolveLocalRef(root, refValue);

      if (target !== undefined) {
        visitedRefs.add(refValue);

        const declared = originalDeclaresPropertyDeep(
          target,
          root,
          property,
          depth + 1,
          visitedRefs,
        );

        visitedRefs.delete(refValue);

        if (declared) return true;
      }
    }
  }

  if (hasKey(prop(schema, "properties"), property)) return true;

  if (arrayOf(prop(schema, "required")).some((name) => asString(name) === property)) return true;

  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    for (const branch of arrayOf(prop(schema, keyword))) {
      if (originalDeclaresPropertyDeep(branch, root, property, depth + 1, visitedRefs)) return true;
    }
  }

  return false;
};

const joinPath = (path: Path, key: string | number): Path => [...path, key];

const currentAt = (holder: Holder, path: Path): Json | undefined => getAt(holder, path);

const cleanToolArray = (
  holder: Holder,
  schemas: Json[],
  root: Json | undefined,
  path: Path,
): void => {
  // Value-constraining keywords on the array itself (e.g. an enum of whole arrays) are not analysed.
  if (schemas.some((schema) => arraySchemaUnsafe(schema, root))) return;
  const itemSchemas: Json[] = [];
  let deterministic = true;

  for (const schema of schemas) {
    const { items, ok } = resolveArrayItems(schema, root, 0, new Set());

    if (!ok) {
      deterministic = false;
      continue;
    }

    // A candidate without an items schema (free-form `{}`) accepts arbitrary elements: it stays in the candidate set.
    if (items.length === 0) appendUniqueSchema(itemSchemas, schema);
    else for (const item of items) appendUniqueSchema(itemSchemas, item);
  }

  if (!deterministic || itemSchemas.length === 0) return;
  const elements = currentAt(holder, path);
  const count = isJsonArray(elements) ? elements.length : 0;

  for (let index = 0; index < count; index++) {
    const elementPath = joinPath(path, index);
    const element = getAt(holder, elementPath);

    if (isJsonObject(element)) cleanToolObject(holder, itemSchemas, root, elementPath, false);
    else if (isJsonArray(element)) cleanToolArray(holder, itemSchemas, root, elementPath);
  }
};

const cleanToolObject = (
  holder: Holder,
  schemas: Json[],
  root: Json | undefined,
  path: Path,
  topLevel: boolean,
): void => {
  const args = getAt(holder, path);

  if (!isJsonObject(args) || schemas.length === 0) return;
  const merged = newInfo();

  for (const schema of schemas) mergeInfo(merged, analyze(schema, root));

  if (merged.complex || !merged.declaresObject) return;

  const isEmptySchema =
    merged.required.size === 0 && (!merged.hasProperties || merged.properties.size === 0);

  const allDeclareObject = schemas.every((schema) => analyze(schema, root).declaresObject);

  // Closed parameterless objects only: an object that omits `additionalProperties` keeps its arguments (e1fb2521).
  if (
    isEmptySchema &&
    allDeclareObject &&
    merged.forbidsDynamic &&
    !infoAnyBranchAllowsDynamic(merged) &&
    !originalsAnyBranchAllowsDynamic(schemas, root) &&
    !originalsAnyCandidateAcceptsImplicitly(schemas, root, args)
  ) {
    if (Object.keys(args).length === 0) return;

    if (topLevel) holder.value = {};
    else setAt(holder, path, {});

    return;
  }

  for (const key of [...merged.properties.keys()].toSorted()) {
    const propertySchemas = merged.properties.get(key) ?? [];
    const childPath = joinPath(path, key);
    const child = getAt(holder, childPath);

    if (child === undefined) continue;
    const currentForBranch = currentAt(holder, path);

    if (
      parentBranchAcceptsChild(merged, key, currentForBranch) ||
      originalsMayPermitChild(schemas, root, key, currentForBranch)
    )
      continue;

    if (isJsonObject(child)) cleanToolObject(holder, propertySchemas, root, childPath, false);
    else if (isJsonArray(child)) cleanToolArray(holder, propertySchemas, root, childPath);
  }

  if (infoAnyBranchAllowsDynamic(merged)) return;
  const current = currentAt(holder, path);

  if (!isJsonObject(current)) return;

  for (const placeholder of ["reason", "_"]) {
    if (merged.properties.has(placeholder)) continue;

    if (merged.required.has(placeholder)) continue;

    if (infoAnyBranchAllowsDynamic(merged) || originalsAnyBranchAllowsDynamic(schemas, root))
      continue;

    if (parentBranchAcceptsChild(merged, placeholder, current)) continue;

    if (originalsAnyCandidateAcceptsImplicitly(schemas, root, current)) continue;

    if (hasKey(current, placeholder)) deleteAt(holder, joinPath(path, placeholder));
  }

  const cleaned = currentAt(holder, path);

  if (path.length === 0 && isJsonObject(cleaned) && Object.keys(cleaned).length === 0)
    holder.value = {};
};

/** The schemas request translation actually sent for the tool (Gemini `functionDeclarations`), or none. */
const findTranslatedToolSchemas = (
  translated: Json | undefined,
  toolName: string,
  original: Json | undefined,
): Json[] => {
  if (toolName === "" || translated === undefined) return [];
  const named: Array<{ name: string; schema: Json }> = [];

  const collect = (tools: Json | undefined): void => {
    if (!isJsonArray(tools)) return;

    for (const group of tools) {
      const declarations = prop(group, "functionDeclarations");

      if (!isJsonArray(declarations)) continue;

      for (const declaration of declarations) {
        const name = asString(prop(declaration, "name")).trim();

        if (name === "") continue;
        const schema = prop(declaration, "parametersJsonSchema") ?? prop(declaration, "parameters");

        if (isJsonObject(schema)) named.push({ name, schema });
      }
    }
  };

  collect(get(translated, "tools"));
  collect(get(translated, "request.tools"));

  if (named.length === 0) return [];
  const canonical = canonicalToolName(toolName);
  const sanitizedToolName = sanitizeFunctionName(toolName);
  // Request translation renames colliding tool names through the request-wide disambiguated map (hash suffixes); the
  // response carries the restored client name, so the sent name is derived from the same map.
  const sentName = sanitizedFunctionNameMap(original)?.get(toolName) ?? "";
  const exact: Json[] = [];
  const canonicalByName = new Map<string, Json[]>();

  for (const entry of named) {
    if (entry.name === toolName || (sentName !== "" && entry.name === sentName))
      exact.push(entry.schema);

    if (
      canonicalToolName(entry.name) === canonical ||
      entry.name === sanitizedToolName ||
      sanitizeFunctionName(entry.name) === sanitizedToolName
    ) {
      const group = canonicalByName.get(entry.name) ?? [];
      group.push(entry.schema);
      canonicalByName.set(entry.name, group);
    }
  }

  if (exact.length > 0) return exact;

  if (canonicalByName.size === 1) return [...canonicalByName.values()][0] ?? [];

  return [];
};

const cleanTranslatedArray = (
  holder: Holder,
  translatedArraySchemas: Json[],
  originalArraySchemas: Json[],
  root: Json | undefined,
  path: Path,
): void => {
  if (originalArraySchemas.some((schema) => arraySchemaUnsafe(schema, root))) return;
  const translatedItems: Json[] = [];
  const originalItems: Json[] = [];
  let deterministic = true;

  for (const schema of translatedArraySchemas) {
    const { items, ok } = resolveArrayItems(schema, schema, 0, new Set());

    if (!ok) deterministic = false;

    for (const item of items) appendUniqueSchema(translatedItems, item);
  }

  for (const schema of originalArraySchemas) {
    const { items, ok } = resolveArrayItems(schema, root, 0, new Set());

    if (!ok) deterministic = false;

    if (ok && items.length === 0) {
      appendUniqueSchema(originalItems, schema);
      continue;
    }

    for (const item of items) appendUniqueSchema(originalItems, item);
  }

  if (!deterministic || translatedItems.length === 0 || originalItems.length === 0) return;
  const elements = currentAt(holder, path);
  const count = isJsonArray(elements) ? elements.length : 0;

  for (let index = 0; index < count; index++) {
    const elementPath = joinPath(path, index);
    const element = getAt(holder, elementPath);

    if (isJsonObject(element))
      cleanByTranslatedSchema(holder, translatedItems, originalItems, root, elementPath, false);
    else if (isJsonArray(element))
      cleanTranslatedArray(holder, translatedItems, originalItems, root, elementPath);
  }
};

const requiredIncludes = (schema: Json | undefined, name: string): boolean =>
  arrayOf(prop(schema, "required")).some((item) => asString(item) === name);

/**
 * Whether the placeholder was injected for this object: the translated (actually sent) schema declares it with the
 * placeholder description or marks it required while the original declaration does not have it.
 */
const placeholderInjected = (
  placeholder: string,
  translatedSchemas: Json[],
  originalInfo: ObjectInfo,
  topLevel: boolean,
): boolean => {
  let injected = false;

  for (const translated of translatedSchemas) {
    const placeholderSchemas = analyze(translated, translated).properties.get(placeholder);

    if (placeholderSchemas === undefined) continue;

    if (placeholder === "reason") {
      for (const placeholderSchema of placeholderSchemas) {
        if (
          requiredIncludes(translated, "reason") ||
          asString(prop(placeholderSchema, "description")) === PLACEHOLDER_REASON_DESCRIPTION
        )
          injected = true;
      }

      // Also required on union branches flattened into the analysed info.
      if (!injected && requiredIncludes(translated, "reason")) injected = true;
    } else {
      if (requiredIncludes(translated, "_")) injected = true;

      // "_" is also marked required by the empty-schema placeholder; when branch flattening drops `required`, its
      // boolean type is the fallback signal, only for nested objects.
      if (!injected && !topLevel) {
        for (const placeholderSchema of placeholderSchemas) {
          if (prop(placeholderSchema, "type") === "boolean") injected = true;
        }
      }
    }
  }

  // Union branches: the analysis only resolves single-branch unions, so scan the raw branches too. The original declares
  // the field nowhere (checked by the caller), so a required occurrence in a sent branch is the injected one.
  if (!injected) {
    for (const translated of translatedSchemas) {
      for (const keyword of ["anyOf", "oneOf"]) {
        for (const branch of arrayOf(prop(translated, keyword))) {
          if (!analyze(branch, branch).properties.has(placeholder)) continue;

          if (requiredIncludes(branch, placeholder)) injected = true;
        }
      }
    }
  }

  // The Antigravity executor re-sanitises tool schemas after translation (wrapping them so top-level objects become
  // nested), which can inject placeholders the translated request seen here does not contain yet. Re-running the same
  // cleaning on the wrapped schema reproduces the sent one. Only closed objects (`additionalProperties: false`) are
  // simulated: open objects may carry the key as user data on routes without executor injection.
  if (!injected && topLevel && originalInfo.forbidsDynamic) {
    for (const translated of translatedSchemas) {
      const recleaned = prop(
        cleanJsonSchemaForAntigravity({ schema: structuredClone(translated) }),
        "schema",
      );

      if (recleaned === undefined) continue;

      if (!analyze(recleaned, recleaned).properties.has(placeholder)) continue;

      if (requiredIncludes(recleaned, placeholder)) injected = true;
    }
  }

  return injected;
};

const cleanByTranslatedSchema = (
  holder: Holder,
  translatedSchemas: Json[],
  originals: Json[],
  root: Json | undefined,
  path: Path,
  topLevel: boolean,
): void => {
  const current = currentAt(holder, path);

  if (!isJsonObject(current) || translatedSchemas.length === 0 || originals.length === 0) return;

  if (!originals.every((original) => isJsonObject(original))) return;
  const originalInfo = mergedOriginalInfo(originals, root);

  if (originalInfo.unsafeComplex) return;

  if (originalInfo.complex) {
    // Multi-branch unions in the original cannot be analysed declaratively; the translated schema records the branches
    // actually sent.
    const hasUnion = originals.some(
      (original) => isJsonArray(prop(original, "anyOf")) || isJsonArray(prop(original, "oneOf")),
    );

    if (!hasUnion) return;
  }

  // Recurse into declared children using the matching translated child schemas.
  if (originalInfo.hasProperties) {
    for (const key of [...originalInfo.properties.keys()].toSorted()) {
      const childPath = joinPath(path, key);
      const child = getAt(holder, childPath);

      if (child === undefined) continue;
      const translatedChildren: Json[] = [];

      for (const translated of translatedSchemas) {
        for (const childSchema of analyze(translated, translated).properties.get(key) ?? [])
          appendUniqueSchema(translatedChildren, childSchema);
      }

      if (translatedChildren.length === 0) continue;
      const originalChildren = originalInfo.properties.get(key) ?? [];
      const currentForBranch = currentAt(holder, path);

      // Another alternative branch/candidate may accept this key without an explicit property schema (dynamic,
      // pattern, or implicit-open matched permission): skip destructive recursion into this subtree.
      if (
        parentBranchAcceptsChild(originalInfo, key, currentForBranch) ||
        originalsMayPermitChild(originals, root, key, currentForBranch)
      )
        continue;

      if (isJsonObject(child) && originalChildren.length > 0)
        cleanByTranslatedSchema(
          holder,
          translatedChildren,
          originalChildren,
          root,
          childPath,
          false,
        );
      else if (isJsonArray(child) && originalChildren.length > 0)
        cleanTranslatedArray(holder, translatedChildren, originalChildren, root, childPath);
    }
  }

  const afterChildren = currentAt(holder, path);

  if (!isJsonObject(afterChildren)) return;
  const toDelete: string[] = [];

  for (const placeholder of ["reason", "_"]) {
    if (originalInfo.properties.has(placeholder)) continue;

    if (originalInfo.required.has(placeholder)) continue;

    // Some alternative branch/candidate accepts dynamic keys, so the value may be the client's own data.
    if (
      infoAnyBranchAllowsDynamic(originalInfo) ||
      originalsAnyBranchAllowsDynamic(originals, root)
    )
      continue;

    if (originalsAnyCandidateAcceptsImplicitly(originals, root, afterChildren)) continue;

    if (parentBranchAcceptsChild(originalInfo, placeholder, afterChildren)) continue;

    if (
      originals.some((original) =>
        originalDeclaresPropertyDeep(original, root, placeholder, 0, new Set()),
      )
    )
      continue;

    if (!hasKey(afterChildren, placeholder)) continue;

    if (placeholderInjected(placeholder, translatedSchemas, originalInfo, topLevel))
      toDelete.push(placeholder);
  }

  for (const placeholder of toDelete) deleteAt(holder, joinPath(path, placeholder));

  // Closed parameterless objects: no declared properties and `additionalProperties: false`, without any candidate or
  // union branch permitting dynamic data, normalise to `{}`. Implicitly open objects keep non-placeholder arguments
  // once proven injected placeholders are gone (e1fb2521).
  const allCandidatesDeclareObject = originals.every(
    (original) => analyze(original, root).declaresObject,
  );

  const currentForNormalize = currentAt(holder, path);

  if (
    !originalInfo.complex &&
    allCandidatesDeclareObject &&
    originalInfo.forbidsDynamic &&
    !infoAnyBranchAllowsDynamic(originalInfo) &&
    !originalsAnyBranchAllowsDynamic(originals, root) &&
    !originalsAnyCandidateAcceptsImplicitly(originals, root, currentForNormalize) &&
    originalInfo.declaresObject &&
    originalInfo.required.size === 0 &&
    (!originalInfo.hasProperties || originalInfo.properties.size === 0)
  ) {
    if (topLevel) holder.value = {};
    else setAt(holder, path, {});

    return;
  }

  const cleaned = currentAt(holder, path);

  if (path.length === 0 && isJsonObject(cleaned) && Object.keys(cleaned).length === 0)
    holder.value = {};
};

const parseObjectArgs = (rawArgs: string): Holder | undefined => {
  const parsed = tryParseJson(rawArgs);

  return isJsonObject(parsed) ? { value: structuredClone(parsed) } : undefined;
};

/**
 * Go `CleanClaudeToolArgumentsWithTranslated`: strips placeholder arguments (`reason`, `_`) only when the translated
 * (actually sent) tool schema shows the placeholder was injected for that object. Without a translated schema it falls
 * back to {@link cleanClaudeToolArguments}. Parameterless tools still normalise to `{}`.
 */
export const cleanClaudeToolArgumentsWithTranslated = (
  rawArgs: string,
  toolName: string,
  original: Json | undefined,
  translated: Json | undefined,
): string => {
  const translatedSchemas = findTranslatedToolSchemas(translated, toolName, original);

  if (translatedSchemas.length === 0) return cleanClaudeToolArguments(rawArgs, toolName, original);
  const trimmed = rawArgs.trim();

  if (trimmed === "" || trimmed === "{}") return "{}";
  const holder = parseObjectArgs(trimmed);

  if (holder === undefined) return rawArgs;
  const found = findToolSchema(original, toolName);

  if (found === undefined) return rawArgs;

  if (found.schema === undefined) return "{}";
  cleanByTranslatedSchema(holder, translatedSchemas, [found.schema], found.schema, [], true);

  return JSON.stringify(holder.value);
};

/**
 * Go `CleanClaudeToolArguments`: strips `reason`/`_` placeholders injected for empty object schemas when the response goes
 * back to a Claude client. A tool declared without properties and with `additionalProperties: false` normalises to `{}`;
 * placeholders are also stripped recursively from declared nested objects that did not declare them. Free-form nested
 * schemas and unions that cannot be resolved deterministically are left untouched.
 */
export const cleanClaudeToolArguments = (
  rawArgs: string,
  toolName: string,
  original: Json | undefined,
): string => {
  const trimmed = rawArgs.trim();

  if (trimmed === "" || trimmed === "{}") return "{}";
  const holder = parseObjectArgs(trimmed);

  if (holder === undefined) return rawArgs;
  const found = findToolSchema(original, toolName);

  if (found === undefined) return rawArgs;

  if (found.schema === undefined) return "{}";
  const info = analyze(found.schema, found.schema);

  if (info.complex || !info.declaresObject) return rawArgs;

  if (
    info.required.size === 0 &&
    (!info.hasProperties || info.properties.size === 0) &&
    info.forbidsDynamic &&
    !infoAnyBranchAllowsDynamic(info)
  )
    return "{}";
  cleanToolObject(holder, [found.schema], found.schema, [], true);

  return JSON.stringify(holder.value);
};

/**
 * Go `MapClaudeToolName`: restores the client-facing tool name, preferring an exact declared name over the canonical
 * (case and leading-underscore insensitive) restoration so distinct tools such as `Read` and `read` are not collapsed.
 */
export const mapClaudeToolName = (
  toolNameMap: NameMap,
  original: Json | undefined,
  name: string,
): string => {
  if (name === "") return name;
  const tools = get(original, "tools");
  const inline = inlineToolAdditionDefinitions(original);

  if (isJsonArray(tools) || inline.length > 0) {
    const canonical = canonicalToolName(name);
    const canonicalNames = new Set<string>();
    const declaredTools: Json[] = [...(isJsonArray(tools) ? tools : []), ...inline];

    for (const tool of declaredTools) {
      const declared = toolNameOf(tool);

      if (declared === name) return name;

      if (declared !== "" && canonicalToolName(declared) === canonical)
        canonicalNames.add(declared);
    }

    if (canonicalNames.size > 1) return name;
  }

  return mapToolName(toolNameMap, name);
};
