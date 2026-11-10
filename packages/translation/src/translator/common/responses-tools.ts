/**
 * Responses tool declarations: namespace qualification and per-name winners.
 *
 * Go source: internal/util/responses_tools.go (QualifyResponsesNamespaceToolName, CollectResponsesToolDescriptors,
 * CollectResponsesToolWinners, UnwrapResponsesCustomToolInput, ResponsesToolIdentity, ResponsesToolDescription). The
 * Gemini declaration builders of that file live in `translator/gemini/openai/responses/tools.ts`. Client-executed
 * `tool_search` (declaration, `tool_search_call` / `tool_search_output` items) is recognised here (77fd91e8).
 */
import { asBool, asString, get, isJsonArray, type Json } from "@commissary/json";
import { isApplyPatchCustomTool } from "./apply-patch.ts";

/** Resolved identity of a tool in OpenAI Responses format (`util.ResponsesToolIdentity`). */
export interface ResponsesToolIdentity {
  readonly name: string;
  readonly namespace: string;
  readonly custom: boolean;
  /** Resolved from the winning original declaration, never from the upstream name. */
  readonly applyPatch: boolean;
  /** The function shim standing in for a client-executed `tool_search` declaration. */
  readonly toolSearch?: boolean;
}

/** The Responses tool type of deferred tool discovery. */
export const RESPONSES_TOOL_SEARCH_TYPE = "tool_search";

/** The function name a client `tool_search` takes for providers without native support. */
export const RESPONSES_TOOL_SEARCH_FUNCTION_NAME = "tool_search";

/**
 * The internal forward-map key of the client `tool_search` shim. The NUL byte cannot appear in a JSON identifier, so
 * it never collides with a user-declared tool name.
 */
export const RESPONSES_CLIENT_TOOL_SEARCH_KEY = "\u0000client_tool_search";

export const RESPONSES_TOOL_SEARCH_CALL_TYPE = "tool_search_call";

export const RESPONSES_TOOL_SEARCH_OUTPUT_TYPE = "tool_search_output";

/** Source priority of tools a `tool_search_output` loaded: after declared and `additional_tools` ones. */
export const RESPONSES_DISCOVERED_TOOL_PRIORITY = 2;

/** A `tool_search` declaration the client executes itself. */
export const isResponsesClientToolSearchDeclaration = (tool: Json | undefined): boolean =>
  asString(get(tool, "type")).trim() === RESPONSES_TOOL_SEARCH_TYPE &&
  asString(get(tool, "execution")).trim() === "client";

/** A `tool_search_call` / `tool_search_output` item of client-executed search (hosted search sets `server`). */
export const isResponsesClientToolSearchItem = (item: Json | undefined): boolean => {
  const execution = asString(get(item, "execution")).trim();

  return execution === "" || execution === "client";
};

export interface ResponsesToolDescriptor {
  /** Qualified name (e.g. `functions__exec`). */
  readonly name: string;
  readonly localName: string;
  readonly namespace: string;
  readonly toolType: string;
  readonly tool: Json;
  /** 0 for top-level tools, 1 for `additional_tools` input items, 2 for `tool_search_output` items. */
  readonly sourcePriority: number;
  /** Declared directly (not as a namespace child). */
  readonly direct: boolean;
  readonly order: number;
  /** A client-executed `tool_search` declaration. */
  readonly clientSearch: boolean;
}

/** `QualifyResponsesNamespaceToolName`. */
export const qualifyResponsesNamespaceToolName = (
  namespaceName: string,
  childName: string,
): string => {
  const child = childName.trim();
  const namespace = namespaceName.trim();

  if (child === "" || namespace === "" || child.startsWith("mcp__")) return child;

  if (child === namespace || child.startsWith(`${namespace}__`)) return child;

  if (namespace.endsWith("__")) return namespace + child;

  return `${namespace}__${child}`;
};

const responsesToolName = (tool: Json | undefined): string => {
  const name = asString(get(tool, "name")).trim();

  return name !== "" ? name : asString(get(tool, "function.name")).trim();
};

/** `util.ResponsesToolDescription`. */
export const responsesToolDescriptionOf = (tool: Json | undefined): string => {
  const description = asString(get(tool, "description"));

  return description !== "" ? description : asString(get(tool, "function.description"));
};

export { responsesToolParameters as responsesToolParametersOf } from "../openai/openai/responses/tools.ts";

const toolSources = (
  root: Json | undefined,
  includeClientToolSearch: boolean,
): Array<{ readonly tools: Json[]; readonly priority: number }> => {
  const sources: Array<{ readonly tools: Json[]; readonly priority: number }> = [];
  const tools = get(root, "tools");

  if (isJsonArray(tools)) sources.push({ tools, priority: 0 });
  const input = get(root, "input");

  if (isJsonArray(input)) {
    for (const item of input) {
      if (asString(get(item, "type")) !== "additional_tools") continue;
      const extra = get(item, "tools");

      if (isJsonArray(extra)) sources.push({ tools: extra, priority: 1 });
    }

    if (includeClientToolSearch) {
      for (const item of input) {
        if (
          asString(get(item, "type")) !== RESPONSES_TOOL_SEARCH_OUTPUT_TYPE ||
          !isResponsesClientToolSearchItem(item)
        )
          continue;
        const discovered = get(item, "tools");

        if (isJsonArray(discovered))
          sources.push({ tools: discovered, priority: RESPONSES_DISCOVERED_TOOL_PRIORITY });
      }
    }
  }

  return sources;
};

/**
 * `CollectResponsesToolDescriptors`. With `includeClientToolSearch` (Gemini only) the client `tool_search` declaration
 * is a descriptor, tools a `tool_search_output` loaded join at priority 2, and, when a client search exists, the
 * `defer_loading` tools it has not loaded yet are left out.
 */
export const collectResponsesToolDescriptors = (
  root: Json | undefined,
  includeClientToolSearch = false,
): ResponsesToolDescriptor[] => {
  let descriptors: ResponsesToolDescriptor[] = [];

  const append = (
    tool: Json,
    name: string,
    localName: string,
    namespace: string,
    toolType: string,
    sourcePriority: number,
    direct: boolean,
    clientSearch = false,
  ) => {
    if (name === "") return;
    descriptors.push({
      name,
      localName,
      namespace,
      toolType,
      tool,
      sourcePriority,
      direct,
      order: descriptors.length,
      clientSearch,
    });
  };

  const appendNamespaceChildren = (namespaceTool: Json, sourcePriority: number) => {
    const namespaceName = asString(get(namespaceTool, "name")).trim();
    let children = get(namespaceTool, "tools");

    if (!isJsonArray(children)) children = get(namespaceTool, "children");

    if (!isJsonArray(children)) return;

    for (const child of children) {
      const childName = responsesToolName(child);

      if (childName === "") continue;
      const qualified = qualifyResponsesNamespaceToolName(namespaceName, childName);

      switch (asString(get(child, "type")).trim()) {
        case "":
        case "function":
          append(child, qualified, childName, namespaceName, "function", sourcePriority, false);
          break;
        case "custom":
          append(child, qualified, childName, namespaceName, "custom", sourcePriority, false);
          break;
      }
    }
  };

  for (const source of toolSources(root, includeClientToolSearch)) {
    for (const tool of source.tools) {
      switch (asString(get(tool, "type")).trim()) {
        case "":
        case "function": {
          const name = responsesToolName(tool);
          append(tool, name, name, "", "function", source.priority, true);
          break;
        }

        case "custom": {
          const name = responsesToolName(tool);
          append(tool, name, name, "", "custom", source.priority, true);
          break;
        }

        case "namespace":
          appendNamespaceChildren(tool, source.priority);
          break;
        case RESPONSES_TOOL_SEARCH_TYPE:
          if (
            includeClientToolSearch &&
            source.priority < RESPONSES_DISCOVERED_TOOL_PRIORITY &&
            isResponsesClientToolSearchDeclaration(tool)
          ) {
            append(
              tool,
              RESPONSES_TOOL_SEARCH_FUNCTION_NAME,
              RESPONSES_TOOL_SEARCH_FUNCTION_NAME,
              "",
              RESPONSES_TOOL_SEARCH_TYPE,
              source.priority,
              true,
              true,
            );
          }

          break;
      }
    }
  }

  if (!includeClientToolSearch || !descriptors.some((descriptor) => descriptor.clientSearch))
    return descriptors;

  // A deferred tool stays hidden until a search loads it.
  descriptors = descriptors
    .filter(
      (descriptor) =>
        descriptor.clientSearch ||
        descriptor.sourcePriority === RESPONSES_DISCOVERED_TOOL_PRIORITY ||
        !asBool(get(descriptor.tool, "defer_loading")),
    )
    .map((descriptor, order) => ({ ...descriptor, order }));

  return descriptors;
};

/** `responsesToolDescriptorPrecedes`: declared before additional, direct before namespace child, then discovery order. */
export const responsesToolDescriptorPrecedes = (
  left: ResponsesToolDescriptor,
  right: ResponsesToolDescriptor,
): boolean => {
  if (left.sourcePriority !== right.sourcePriority)
    return left.sourcePriority < right.sourcePriority;

  if (left.direct !== right.direct) return left.direct;

  return left.order < right.order;
};

/** `CollectResponsesToolWinners`: the winning descriptor per qualified tool name. */
export const collectResponsesToolWinners = (
  root: Json | undefined,
): Map<string, ResponsesToolDescriptor> => {
  const winners = new Map<string, ResponsesToolDescriptor>();

  for (const descriptor of collectResponsesToolDescriptors(root)) {
    const current = winners.get(descriptor.name);

    if (current === undefined || responsesToolDescriptorPrecedes(descriptor, current))
      winners.set(descriptor.name, descriptor);
  }

  return winners;
};

/** `util.UnwrapResponsesCustomToolInput`. */
export const unwrapResponsesCustomToolInput = (argumentsText: string): string => {
  const trimmed = argumentsText.trim();

  if (trimmed === "" || trimmed === "{}") return "";
  let parsed: Json;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }

  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const input = parsed.input;

    if (input !== undefined) return typeof input === "string" ? input : JSON.stringify(input);
  }

  if (typeof parsed === "string") return parsed;

  return trimmed;
};

export const isApplyPatchDescriptor = (descriptor: ResponsesToolDescriptor): boolean =>
  isApplyPatchCustomTool(descriptor.tool);
