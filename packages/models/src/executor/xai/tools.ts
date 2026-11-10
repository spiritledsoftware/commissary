/**
 * xAI Responses tool declarations: flattening, namespace folding and schema fixes.
 *
 * Go source: internal/runtime/executor/xai_executor_request.go (normalizeXAITools*, normalizeXAITool,
 * buildXAINamespaceDispatcherTool, promoteXAIAdditionalTools, xaiDeduplicatedToolName, collectXAINamespaceToolRefs*, qualifyXAINamespaceToolName,
 * xaiShouldFoldNamespaceTools, xaiSupportsNativeImageGeneration, collectXAIClientDeclaredToolKeys) and
 * xai_executor_response.go (normalizeXAIObjectRootUnionBranchTypes, xaiFunctionParametersNeedSimplification,
 * isXAICodexAppAutomationUpdate, xaiRequestHasNativeXSearch). All functions mutate the parsed body in place.
 *
 * xAI accepts at most {@link XAI_MAX_TOOLS} tools: when the flattened count exceeds it every `namespace` tool is folded
 * into one dispatcher function (`{name, arguments}`) that the response restorer unwraps again.
 */
import {
  asString,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { inlineLocalRefs } from "../helps/inline-refs.ts";
import { parseSuffix } from "@commissary/translation/thinking";

export const XAI_MAX_TOOLS = 200;

const SAFE_FUNCTION_PARAMETERS = '{"type":"object","properties":{},"additionalProperties":true}';

export interface NamespaceToolRef {
  readonly namespace: string;
  readonly name: string;
  readonly isDispatcher: boolean;
  /** Dispatcher refs only: the child tool names of the winning declarations (0c61b12c). */
  readonly children?: ReadonlySet<string>;
}

/** Qualified tool name (or folded namespace name) -> reference. */
export type NamespaceRefs = ReadonlyMap<string, NamespaceToolRef>;

const trimmed = (value: Json | undefined, path: string): string =>
  asString(get(value, path)).trim();

/** The one way to read a tool's declared type and name (trimmed). */
const typeOf = (tool: Json | undefined): string => trimmed(tool, "type");

const nameOf = (tool: Json | undefined): string => trimmed(tool, "name");

/** A `function` tool called `name`. */
const isNamedFunctionTool = (tool: Json, name: string): boolean =>
  typeOf(tool) === "function" && nameOf(tool) === name;

/** First declaration wins: `true` when `name` is new (and now claimed) or empty, `false` for a repeat. */
const claimFirst = (seen: Set<string>, name: string): boolean => {
  if (name === "") return true;

  if (seen.has(name)) return false;
  seen.add(name);

  return true;
};

const arrayAt = (value: Json | undefined, path: string): Json[] => {
  const found = get(value, path);

  return isJsonArray(found) ? found : [];
};

/** Top-level `tools` plus the tool lists of `additional_tools` input items (arrays by reference). */
export const toolLists = (body: Json): Json[][] => {
  const lists: Json[][] = [];
  const tools = get(body, "tools");

  if (isJsonArray(tools)) lists.push(tools);

  for (const item of arrayAt(body, "input")) {
    if (typeOf(item) !== "additional_tools") continue;
    const nested = get(item, "tools");

    if (isJsonArray(nested)) lists.push(nested);
  }

  return lists;
};

/** `qualifyXAINamespaceToolName`: `<namespace>__<tool>` unless the tool is MCP-prefixed or already qualified. */
export const qualifyNamespaceToolName = (namespaceName: string, toolName: string): string => {
  const namespace = namespaceName.trim();
  const tool = toolName.trim();

  if (namespace === "" || tool === "" || tool.startsWith("mcp__")) return tool;
  const prefix = namespace.endsWith("__") ? namespace : `${namespace}__`;

  return tool.startsWith(prefix) ? tool : prefix + tool;
};

/** `xaiHasFunctionToolNamed` (top-level tools and `additional_tools`). */
export const hasFunctionToolNamed = (body: Json, name: string): boolean => {
  if (name === "") return false;

  return toolLists(body).some((list) => list.some((tool) => isNamedFunctionTool(tool, name)));
};

/** `xaiRequestHasNativeXSearch`. */
export const requestHasNativeXSearch = (body: Json): boolean =>
  toolLists(body).some((list) => list.some((tool) => typeOf(tool) === "x_search"));

/** `xaiSupportsNativeImageGeneration`: `grok-X.Y` with X.Y >= 4.6 (the 4.20 line is an older product). */
export const supportsNativeImageGeneration = (model: string): boolean => {
  let name = parseSuffix(model.trim()).modelName.trim().toLowerCase();
  const slash = name.lastIndexOf("/");

  if (slash >= 0) name = name.slice(slash + 1);

  if (name === "" || !name.startsWith("grok-")) return false;
  const rest = name.slice("grok-".length);

  if (rest === "4.20" || rest.startsWith("4.20-")) return false;
  const match = /^(\d+)(?:\.(\d+))?/.exec(rest);

  if (match === null) return false;
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);

  return major !== 4 ? major > 4 : minor >= 6;
};

// ---------------------------------------------------------------------------------------------------------------
// Folding decision
// ---------------------------------------------------------------------------------------------------------------

/** `xaiCountFlattenedToolsWithSeen`: function names seen in `seen` (qualified for namespace children) count once. */
const countFlattened = (tools: Json | undefined, seen: Set<string>): number => {
  if (!isJsonArray(tools)) return 0;
  let count = 0;

  for (const tool of tools) {
    switch (typeOf(tool)) {
      case "namespace": {
        const nested = get(tool, "tools");

        if (!isJsonArray(nested)) {
          count++;
          break;
        }

        const namespaceName = nameOf(tool);

        for (const child of nested) {
          if (typeOf(child) === "tool_search") continue;
          const qualified = qualifyNamespaceToolName(namespaceName, nameOf(child));

          if (claimFirst(seen, qualified)) count++;
        }

        break;
      }

      case "tool_search":
        break;
      case "function":
      case "custom": {
        if (claimFirst(seen, nameOf(tool))) count++;
        break;
      }

      default:
        count++;
    }
  }

  return count;
};

/** `xaiTotalFlattenedToolsCount`. `hostedOnly` is the result of `toolChoiceRequiresHostedToolOnlyAny`. */
export const totalFlattenedToolsCount = (
  body: Json,
  willInjectXSearch: boolean,
  hostedOnly: boolean,
): number => {
  const seen = new Set<string>();
  let count = countFlattened(get(body, "tools"), seen);

  for (const item of arrayAt(body, "input")) {
    if (typeOf(item) === "additional_tools") count += countFlattened(get(item, "tools"), seen);
  }

  if (willInjectXSearch && !requestHasNativeXSearch(body) && !hostedOnly) count++;

  return count;
};

// ---------------------------------------------------------------------------------------------------------------
// Namespace references and client-declared tools
// ---------------------------------------------------------------------------------------------------------------

/** `collectXAINamespaceToolRefsWithFold`. */
export const collectNamespaceToolRefs = (
  body: Json,
  shouldFold: boolean,
): Map<string, NamespaceToolRef> => {
  const refs = new Map<string, NamespaceToolRef>();
  // Names already taken by a function or an earlier namespace; the first declaration wins.
  const claimed = new Set<string>();
  const childSets = new Map<string, Set<string>>();

  for (const list of toolLists(body)) {
    for (const tool of list) {
      const toolType = typeOf(tool);

      if (toolType === "function" || toolType === "custom") {
        const name = nameOf(tool);

        if (name === "") continue;
        claimed.add(name);
        const existing = refs.get(name);

        if (shouldFold && existing !== undefined && !existing.isDispatcher) refs.delete(name);
        continue;
      }

      if (toolType !== "namespace") continue;
      const namespace = nameOf(tool);

      if (namespace === "") continue;

      if (shouldFold && !claimed.has(namespace)) {
        claimed.add(namespace);
        const children = new Set<string>();
        childSets.set(namespace, children);
        refs.set(namespace, { namespace, name: "", isDispatcher: true, children });
      }

      for (const nested of arrayAt(tool, "tools")) {
        if (typeOf(nested) === "tool_search") continue;
        const name = nameOf(nested);
        const qualified = qualifyNamespaceToolName(namespace, name);

        if (qualified === "") continue;

        if (shouldFold) {
          if (refs.get(namespace)?.isDispatcher === true) childSets.get(namespace)?.add(name);

          if (!claimed.has(qualified) && !refs.has(qualified))
            refs.set(qualified, { namespace, name, isDispatcher: false });
          continue;
        }

        if (claimed.has(qualified)) continue;
        claimed.add(qualified);
        refs.set(qualified, { namespace, name, isDispatcher: false });
      }
    }
  }

  return refs;
};

/** Identity of a client-declared callable tool after restore: short name, namespace and effective upstream kind. */
export const clientToolKey = (namespace: string, name: string, toolType: string): string =>
  `${namespace}\u0000${name}\u0000${toolType}`;

const effective = (type: string): string => (type === "custom" ? "function" : type);

/** `collectXAIClientDeclaredToolKeys`: custom tools are sent upstream as functions, so they are keyed as such. */
export const collectClientDeclaredToolKeys = (body: Json): Set<string> => {
  const keys = new Set<string>();

  for (const list of toolLists(body)) {
    for (const tool of list) {
      const type = typeOf(tool);

      if (type === "namespace") {
        const namespace = nameOf(tool);

        if (namespace === "") continue;

        for (const nested of arrayAt(tool, "tools")) {
          const nestedType = typeOf(nested);

          if (nestedType !== "function" && nestedType !== "custom") continue;
          const name = nameOf(nested);

          if (name !== "") keys.add(clientToolKey(namespace, name, effective(nestedType)));
        }
      } else if (type === "function" || type === "custom") {
        const name = nameOf(tool);

        if (name !== "") keys.add(clientToolKey("", name, effective(type)));
      }
    }
  }

  return keys;
};

// ---------------------------------------------------------------------------------------------------------------
// Dispatcher (folded namespace)
// ---------------------------------------------------------------------------------------------------------------

const EMPTY_OBJECT_SCHEMA = '{"type":"object","properties":{}}';

/** `collectXAINamespaceDeclarationsByName`: every declaration of a namespace, top-level first. */
const collectNamespaceDeclarations = (body: Json): Map<string, Json[]> => {
  const byName = new Map<string, Json[]>();

  for (const list of toolLists(body)) {
    for (const tool of list) {
      if (typeOf(tool) !== "namespace") continue;
      const name = nameOf(tool);

      if (name === "") continue;
      byName.set(name, [...(byName.get(name) ?? []), tool]);
    }
  }

  return byName;
};

/** `buildXAINamespaceDispatcherTool`: children of repeated declarations merge, first declaration wins. */
const buildDispatcherTool = (tool: Json, extraDeclarations: readonly Json[]): Json | undefined => {
  const namespaceName = nameOf(tool);

  if (namespaceName === "") return undefined;
  let description = trimmed(tool, "description");
  const names: string[] = [];
  const entries: string[] = [];
  const seenChildren = new Set<string>();
  const children: Json[] = [];

  for (const declaration of [tool, ...extraDeclarations]) {
    if (description === "") description = trimmed(declaration, "description");
    children.push(...arrayAt(declaration, "tools"));
  }

  for (const child of children) {
    if (typeOf(child) === "tool_search") continue;
    const childName = nameOf(child);

    if (childName === "" || seenChildren.has(childName)) continue;
    seenChildren.add(childName);
    names.push(childName);
    const childDescription = trimmed(child, "description");
    let params = get(child, "parameters");

    if (params === undefined) params = get(child, "input_schema");
    let paramText = "";

    if (params !== undefined) {
      const raw = JSON.stringify(params);

      if (raw !== "" && raw !== "{}" && raw !== EMPTY_OBJECT_SCHEMA) {
        const inlined = cloneJson(inlineLocalRefs(params));

        if (isJsonObject(inlined)) {
          delete inlined["$defs"];
          delete inlined["definitions"];
        }

        paramText = JSON.stringify(inlined);
      }
    }

    const head = childDescription !== "" ? `- ${childName}: ${childDescription}` : `- ${childName}`;
    entries.push(paramText !== "" ? `${head}\n  Parameters: ${paramText}` : head);
  }

  let full = description;

  if (entries.length > 0) {
    const catalog = `Available tools in this namespace:\n${entries.join("\n")}`;
    full =
      full !== "" ? `${full}\n\n${catalog}` : `Tools in namespace ${namespaceName}.\n\n${catalog}`;
  } else if (full === "") {
    full = `Tools in namespace ${namespaceName}.`;
  }

  const nameProp: JsonObject = {
    type: "string",
    description: `Child tool name to execute in namespace ${namespaceName}`,
  };

  if (names.length > 0) nameProp["enum"] = names;

  return {
    type: "function",
    name: namespaceName,
    description: full,
    parameters: {
      type: "object",
      properties: {
        name: nameProp,
        arguments: {
          type: "object",
          description: "Arguments object matching the parameter schema of the selected child tool",
          additionalProperties: true,
        },
      },
      required: ["name"],
    },
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Per-tool normalisation
// ---------------------------------------------------------------------------------------------------------------

const isObjectOnlyType = (schemaType: Json | undefined): boolean => {
  if (typeof schemaType === "string") return schemaType.trim().toLowerCase() === "object";

  if (!isJsonArray(schemaType) || schemaType.length === 0) return false;

  return schemaType.every(
    (item) => typeof item === "string" && item.trim().toLowerCase() === "object",
  );
};

/** `isXAICodexAppAutomationUpdate`. */
const isCodexAppAutomationUpdate = (toolName: string, namespaceName: string): boolean => {
  const namespace = namespaceName
    .trim()
    .replace(/^mcp__/, "")
    .toLowerCase();

  const tool = toolName
    .trim()
    .replace(/^mcp__/, "")
    .toLowerCase();

  if (tool === "automation_update" && (namespace === "codex_app" || namespace === "codex_apps"))
    return true;

  return tool === "codex_app__automation_update" || tool === "codex_apps__automation_update";
};

/** `xaiFunctionParametersNeedSimplification` (`originalType` is the declared type before custom -> function). */
const parametersNeedSimplification = (
  originalType: string,
  toolName: string,
  parameters: Json | undefined,
  namespaceName: string,
): boolean => {
  const type = originalType.trim().toLowerCase();
  const isFunction = type === "function";

  if (!isFunction && type !== "custom") return false;

  if (isFunction && isCodexAppAutomationUpdate(toolName.trim(), namespaceName)) return true;

  for (const unionName of ["anyOf", "oneOf"]) {
    const union = get(parameters, unionName);

    if (!isJsonArray(union)) continue;

    for (const branch of union) {
      if (get(branch, "$ref") !== undefined || !isObjectOnlyType(get(branch, "type"))) return true;
    }
  }

  return false;
};

/** `normalizeXAIObjectRootUnionBranchTypes`: untyped root union branches become explicit objects. */
const normalizeRootUnionBranchTypes = (tool: JsonObject): boolean => {
  const parameters = tool["parameters"];

  if (
    !isJsonObject(parameters) ||
    typeof parameters["type"] !== "string" ||
    parameters["type"] !== "object"
  ) {
    return false;
  }

  let changed = false;

  for (const unionName of ["anyOf", "oneOf"]) {
    const union = parameters[unionName];

    if (!isJsonArray(union)) continue;

    for (const branch of union) {
      if (!isJsonObject(branch) || branch["type"] !== undefined || branch["$ref"] !== undefined)
        continue;
      branch["type"] = "object";
      changed = true;
    }
  }

  return changed;
};

/** `xaiUnsupportedWebSearchFields`: web_search options the xAI Responses API rejects with "Argument not supported". */
const UNSUPPORTED_WEB_SEARCH_FIELDS = ["external_web_access", "search_context_size"] as const;

interface NormalizedTool {
  /** `undefined` = the tool is dropped. */
  readonly tool: Json | undefined;
  readonly changed: boolean;
}

/** `normalizeXAITool`; `undefined` = unrecoverable (the caller keeps the original request). */
const normalizeTool = (
  tool: Json,
  namespaceName: string,
  keepImageGeneration: boolean,
): NormalizedTool | undefined => {
  const declaredType = typeOf(tool);

  if (declaredType === "tool_search") return { tool: undefined, changed: true };

  if (declaredType === "image_generation" && !keepImageGeneration)
    return { tool: undefined, changed: true };
  const copy = cloneJson(tool);

  if (!isJsonObject(copy)) return { tool: copy, changed: false };
  let changed = false;
  let toolType = declaredType;
  let schemaParameters: Json | undefined = copy["parameters"];

  if (toolType === "function" || toolType === "custom") {
    const parameters = copy["parameters"];

    if (parameters !== undefined) {
      const inlined = inlineLocalRefs(parameters);

      if (JSON.stringify(inlined) !== JSON.stringify(parameters)) {
        const next = cloneJson(inlined);

        if (isJsonObject(next)) {
          delete next["$defs"];
          delete next["definitions"];
        }

        copy["parameters"] = next;
        schemaParameters = next;
        changed = true;
      }
    }

    if (normalizeRootUnionBranchTypes(copy)) {
      schemaParameters = copy["parameters"];
      changed = true;
    }
  }

  if (toolType === "custom") {
    copy["type"] = "function";
    toolType = "function";
    changed = true;
  }

  if (toolType === "web_search") {
    for (const field of UNSUPPORTED_WEB_SEARCH_FIELDS) {
      if (copy[field] === undefined) continue;
      delete copy[field];
      changed = true;
    }
  }

  if (toolType === "function" && schemaParameters === undefined) {
    copy["parameters"] = tryParseJson(EMPTY_OBJECT_SCHEMA) ?? {};
    changed = true;
  }

  if (
    toolType === "function" &&
    parametersNeedSimplification(declaredType, nameOf(tool), schemaParameters, namespaceName)
  ) {
    copy["parameters"] = tryParseJson(SAFE_FUNCTION_PARAMETERS) ?? {};

    if (get(tool, "strict") === true) copy["strict"] = false;
    changed = true;
  }

  if (toolType === "function" && namespaceName.trim() !== "") {
    const qualified = qualifyNamespaceToolName(namespaceName, nameOf(tool));

    if (qualified === "") return undefined;
    copy["name"] = qualified;
    changed = true;
  }

  return { tool: copy, changed };
};

/** `xaiDeduplicatedToolName`: the name key of tools that must not repeat; hosted tools have none. */
const deduplicatedToolName = (tool: Json): string => {
  switch (typeOf(tool)) {
    case "function":
    case "custom":
    case "namespace":
      return nameOf(tool);
    default:
      return "";
  }
};

/** `normalizeXAIToolArray`. */
const normalizeToolArray = (
  tools: Json[],
  keepImageGeneration: boolean,
  shouldFold: boolean,
  namespaceDecls: ReadonlyMap<string, Json[]>,
): { readonly tools: Json[]; readonly changed: boolean } | undefined => {
  const filtered: Json[] = [];
  const seenNames = new Set<string>();
  let changed = false;

  /** Appends unless an earlier tool already carries the name; a dropped duplicate counts as a change. */
  const appendUnique = (tool: Json): void => {
    if (claimFirst(seenNames, deduplicatedToolName(tool))) filtered.push(tool);
    else changed = true;
  };

  for (const tool of tools) {
    if (typeOf(tool) === "namespace") {
      changed = true;

      if (shouldFold) {
        const dispatcher = buildDispatcherTool(tool, namespaceDecls.get(nameOf(tool)) ?? []);

        if (dispatcher !== undefined) appendUnique(dispatcher);
        continue;
      }

      const namespaceName = nameOf(tool);

      for (const nested of arrayAt(tool, "tools")) {
        const result = normalizeTool(nested, namespaceName, keepImageGeneration);

        if (result === undefined) return undefined;
        changed = changed || result.changed;

        if (result.tool !== undefined) appendUnique(result.tool);
      }

      continue;
    }

    const result = normalizeTool(tool, "", keepImageGeneration);

    if (result === undefined) return undefined;
    changed = changed || result.changed;

    if (result.tool !== undefined) appendUnique(result.tool);
  }

  return { tools: filtered, changed };
};

/** `normalizeXAIToolsWithFold` over `tools` and every `additional_tools` input item. */
export const normalizeTools = (body: Json, shouldFold: boolean): Json => {
  if (!isJsonObject(body)) return body;
  const keepImageGeneration = supportsNativeImageGeneration(asString(get(body, "model")));
  const updates: Array<readonly [path: string, tools: Json[]]> = [];

  const namespaceDecls = shouldFold
    ? collectNamespaceDeclarations(body)
    : new Map<string, Json[]>();

  const plan = (path: string): boolean => {
    const tools = get(body, path);

    if (!isJsonArray(tools)) return true;
    const result = normalizeToolArray(tools, keepImageGeneration, shouldFold, namespaceDecls);

    if (result === undefined) return false;

    if (result.changed) updates.push([path, result.tools]);

    return true;
  };

  if (!plan("tools")) return body;
  const input = get(body, "input");

  if (isJsonArray(input)) {
    for (const [index, item] of input.entries()) {
      if (typeOf(item) === "additional_tools" && !plan(`input.${index}.tools`)) return body;
    }
  }

  for (const [path, next] of updates) set(body, path, next);

  return body;
};

/** `promoteXAIAdditionalTools`: xAI rejects `additional_tools` input items, their tools move to `tools`. */
export const promoteAdditionalTools = (body: Json): Json => {
  const input = get(body, "input");

  if (!isJsonArray(input)) return body;
  const remaining: Json[] = [];
  const promoted: Json[] = [];

  for (const item of input) {
    if (typeOf(item) !== "additional_tools") {
      remaining.push(item);
      continue;
    }

    promoted.push(...arrayAt(item, "tools"));
  }

  if (remaining.length === input.length) return body;
  set(body, "input", remaining);

  if (promoted.length > 0) {
    // First wins: top-level tools stay authoritative over historical copies.
    const seen = new Set<string>();
    const merged: Json[] = [];

    for (const tool of [...arrayAt(body, "tools"), ...promoted]) {
      if (claimFirst(seen, deduplicatedToolName(tool))) merged.push(tool);
    }

    set(body, "tools", merged);
  }

  return body;
};

/** `xaiRemoveInputItemsByType`. */
export const removeInputItemsByType = (body: Json, itemType: string): Json => {
  const input = get(body, "input");

  if (!isJsonArray(input)) return body;

  return set(
    body,
    "input",
    input.filter((item) => typeOf(item) !== itemType),
  );
};

export const inputHasItemType = (body: Json, itemType: string): boolean =>
  arrayAt(body, "input").some((item) => typeOf(item) === itemType);
