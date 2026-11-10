/**
 * Responses tool declarations <-> Chat Completions function tools.
 *
 * Go sources: internal/translator/openai/openai/responses/{openai_openai-responses_tools.go,
 * responses_tool_index.go,shell_tool.go,openai_openai-responses_tool_search.go}. A client-executed `tool_search` is bridged
 * as the function `tool_search` (8c9a7851); the tools its `tool_search_output` items loaded stay declared.
 */
import { cloneJson, get, type Json, type JsonObject, set } from "@commissary/json";
import {
  applyPatchDescription,
  applyPatchParameters,
  isApplyPatchCustomTool,
} from "../../../common/apply-patch.ts";
import { getStr, isArr, isObj, str } from "../../common/read.ts";
import { extractResponsesCallID, setResponsesToolCallIdentity } from "../../../common/responses.ts";
import {
  isResponsesClientToolSearchDeclaration,
  isResponsesClientToolSearchItem,
  RESPONSES_TOOL_SEARCH_CALL_TYPE,
  RESPONSES_TOOL_SEARCH_FUNCTION_NAME,
  RESPONSES_TOOL_SEARCH_OUTPUT_TYPE,
  RESPONSES_TOOL_SEARCH_TYPE,
} from "../../../common/responses-tools.ts";

/** Chat Completions function-name limit enforced by strict upstreams. */
export const RESPONSES_CHAT_TOOL_NAME_LIMIT = 64;

const LOCAL_SHELL = "__cpa_local_shell";

export interface ResponsesToolDeclaration {
  readonly tool: Json;
  chatName: string;
  localName: string;
  readonly namespace: string;
  readonly custom: boolean;
  readonly shell: boolean;
  /** A client `tool_search`, bridged as a function. */
  readonly search: boolean;
}

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const byteLength = (text: string): number => encoder.encode(text).length;

/** `capResponsesChatToolName`: keeps the tail of over-long names (byte-based like Go) and strips leading `_`/`-`. */
export const capResponsesChatToolName = (name: string): string => {
  if (byteLength(name) <= RESPONSES_CHAT_TOOL_NAME_LIMIT) return name;
  const bytes = encoder.encode(name);
  const truncated = decoder.decode(bytes.slice(bytes.length - RESPONSES_CHAT_TOOL_NAME_LIMIT));
  const trimmed = truncated.replace(/^[_-]+/, "");

  return trimmed !== "" ? trimmed : truncated;
};

/** `rawResponsesNamespaceQualifiedName`: the namespace-qualified name without the length cap. */
export const rawResponsesNamespaceQualifiedName = (
  namespaceName: string,
  childName: string,
): string => {
  const child = childName.trim();

  if (child === "" || namespaceName === "" || child.startsWith("mcp__")) return child;

  if (child === namespaceName || child.startsWith(`${namespaceName}__`)) return child;

  if (namespaceName.endsWith("__")) return namespaceName + child;

  return `${namespaceName}__${child}`;
};

/** `qualifyResponsesNamespaceToolName`. */
export const qualifyResponsesNamespaceToolName = (
  namespaceName: string,
  childName: string,
): string => capResponsesChatToolName(rawResponsesNamespaceQualifiedName(namespaceName, childName));

export const responsesToolName = (tool: Json | undefined): string => {
  const name = getStr(tool, "name").trim();

  return name !== "" ? name : getStr(tool, "function.name").trim();
};

export const responsesToolDescription = (tool: Json | undefined): string => {
  const description = getStr(tool, "description");

  return description !== "" ? description : getStr(tool, "function.description");
};

export const responsesToolParameters = (tool: Json | undefined): Json | undefined => {
  for (const path of [
    "parameters",
    "parametersJsonSchema",
    "input_schema",
    "function.parameters",
    "function.parametersJsonSchema",
  ]) {
    const parameters = get(tool, path);

    if (parameters !== undefined) return parameters;
  }

  return undefined;
};

/**
 * `walkResponsesToolDeclarations`: the tool declarations of a Responses request in one canonical order (top-level
 * `tools`, then Codex Desktop `additional_tools` input items; namespace children in declaration order).
 */
export const collectResponsesToolDeclarations = (
  root: Json | undefined,
): ResponsesToolDeclaration[] => {
  const declarations: ResponsesToolDeclaration[] = [];

  const emit = (tool: Json, namespaceName: string): void => {
    let custom = false;
    let shell = false;
    let search = false;

    switch (getStr(tool, "type").trim()) {
      case "":
      case "function":
        break;
      case "custom":
        custom = true;
        break;
      case "shell":
        if (namespaceName !== "" || getStr(tool, "environment.type") !== "local") return;
        shell = true;
        break;
      case RESPONSES_TOOL_SEARCH_TYPE:
        if (namespaceName !== "" || !isResponsesClientToolSearchDeclaration(tool)) return;
        search = true;
        break;
      default:
        return;
    }

    let localName = responsesToolName(tool);

    if (shell) localName = LOCAL_SHELL;
    else if (search) localName = RESPONSES_TOOL_SEARCH_FUNCTION_NAME;

    if (localName === "") return;
    declarations.push({
      tool,
      chatName: qualifyResponsesNamespaceToolName(namespaceName, localName),
      localName,
      namespace: namespaceName,
      custom,
      shell,
      search,
    });
  };

  const scan = (tools: Json | undefined): void => {
    if (!isArr(tools)) return;

    for (const tool of tools) {
      if (getStr(tool, "type").trim() === "namespace") {
        const children = get(tool, "tools");

        if (isArr(children)) {
          const namespaceName = getStr(tool, "name").trim();

          for (const child of children) emit(child, namespaceName);
        }

        continue;
      }

      emit(tool, "");
    }
  };

  scan(get(root, "tools"));
  const input = get(root, "input");

  if (isArr(input)) {
    for (const item of input) {
      const type = getStr(item, "type");

      if (type === "additional_tools") scan(get(item, "tools"));
      // Tools a client search loaded stay declared on every later request, so the model can call them.
      else if (type === RESPONSES_TOOL_SEARCH_OUTPUT_TYPE && isResponsesClientToolSearchItem(item))
        scan(get(item, "tools"));
    }
  }

  // Reserve user identities before assigning the synthetic shell and tool_search names.
  const reserved = new Set<string>();

  for (const d of declarations) {
    if (!d.shell && !d.search) {
      reserved.add(d.localName);
      reserved.add(d.chatName);
      reserved.add(rawResponsesNamespaceQualifiedName(d.namespace, d.localName));
    }
  }

  let shellName = LOCAL_SHELL;

  for (let suffix = 1; reserved.has(shellName); suffix++) shellName = `${LOCAL_SHELL}_${suffix}`;

  let searchName = RESPONSES_TOOL_SEARCH_FUNCTION_NAME;

  for (let suffix = 1; reserved.has(searchName); suffix++)
    searchName = `${RESPONSES_TOOL_SEARCH_FUNCTION_NAME}_${suffix}`;

  for (const d of declarations) {
    if (d.shell) {
      d.localName = shellName;
      d.chatName = shellName;
    } else if (d.search) {
      d.localName = searchName;
      d.chatName = searchName;
    }
  }

  disambiguateResponsesChatToolNames(declarations);

  return declarations;
};

/**
 * `disambiguateResponsesChatToolNames`: rewrites flattened names in place when distinct declarations collapse onto the
 * same capped Chat Completions name (declarations with the same pre-cap qualified name are one identity). Local names
 * carried by more than one distinct identity are ambiguous and never emitted.
 */
const disambiguateResponsesChatToolNames = (declarations: ResponsesToolDeclaration[]): void => {
  const claimed = new Map<string, string>();

  const claim = (candidate: string, identity: string): boolean => {
    const owner = claimed.get(candidate);

    if (owner === undefined) {
      claimed.set(candidate, identity);

      return true;
    }

    return owner === identity;
  };

  const longDeclarations: number[] = [];
  const identities: string[] = [];
  const localOwners = new Map<string, string>();
  const ambiguousLocalNames = new Set<string>();
  declarations.forEach((d, i) => {
    const identity = rawResponsesNamespaceQualifiedName(d.namespace, d.localName);
    identities[i] = identity;

    if (byteLength(identity) > RESPONSES_CHAT_TOOL_NAME_LIMIT) longDeclarations.push(i);
    else claim(identity, identity);
    const local = d.localName;

    if (local === "" || local === identity || byteLength(local) > RESPONSES_CHAT_TOOL_NAME_LIMIT)
      return;
    const owner = localOwners.get(local);

    if (owner === undefined) localOwners.set(local, identity);
    else if (owner !== "" && owner !== identity) localOwners.set(local, "");
  });

  for (const [local, owner] of localOwners) {
    claim(local, owner);

    if (owner === "") ambiguousLocalNames.add(local);
  }

  for (const i of longDeclarations) {
    // SAFETY: longDeclarations holds positions of `declarations`, which `identities` mirrors one to one.
    const identity = identities[i] as string;
    // SAFETY: longDeclarations holds positions of `declarations`.
    const d = declarations[i] as ResponsesToolDeclaration;
    const name = d.chatName;

    if (!ambiguousLocalNames.has(name) && claim(name, identity)) continue;

    for (let suffix = 1; ; suffix++) {
      const candidate = capResponsesChatToolName(`${name}_${suffix}`);

      if (ambiguousLocalNames.has(candidate)) continue;

      if (claim(candidate, identity)) {
        d.chatName = candidate;
        break;
      }
    }
  }
};

const identityKey = (namespace: string, name: string): string => `${namespace}\u0000${name}`;

/** `convertResponsesFunctionToolToOpenAIChat`. */
const convertResponsesFunctionToolToOpenAIChat = (
  tool: Json,
  overrideName: string,
): JsonObject | undefined => {
  let name = overrideName.trim();

  if (name === "") name = responsesToolName(tool);

  if (name === "") return undefined;
  const fn: JsonObject = { name, description: "", parameters: {} };
  const description = responsesToolDescription(tool);

  if (description !== "") fn.description = description;
  const parameters = responsesToolParameters(tool);

  if (parameters !== undefined) fn.parameters = cloneJson(parameters);

  return { type: "function", function: fn };
};

/** `convertResponsesCustomToolToOpenAIChat`: a freeform tool as a function with a single `input` string. */
const convertResponsesCustomToolToOpenAIChat = (
  tool: Json,
  overrideName: string,
): JsonObject | undefined => {
  let name = overrideName.trim();

  if (name === "") name = responsesToolName(tool);

  if (name === "") return undefined;

  const fn: JsonObject = {
    name,
    description: "",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
  };

  const description = responsesToolDescription(tool);

  if (description !== "") fn.description = description;

  if (isApplyPatchCustomTool(tool)) {
    fn.description = applyPatchDescription(tool);
    fn.parameters = applyPatchParameters();
  }

  return { type: "function", function: fn };
};

/** `convertResponsesShellToolToOpenAIChat`. */
const convertResponsesShellToolToOpenAIChat = (name: string): JsonObject => ({
  type: "function",
  function: {
    name,
    description:
      "Request commands to execute in the client-provided local shell environment. Each commands entry is a complete shell command, not an argv element.",
    parameters: {
      type: "object",
      properties: {
        commands: { type: "array", items: { type: "string" }, minItems: 1 },
        timeout_ms: { type: "integer", minimum: 1 },
        max_output_length: { type: "integer", minimum: 1 },
      },
      required: ["commands"],
      additionalProperties: false,
    },
  },
});

const TOOL_SEARCH_DEFAULT_PARAMETERS = (): JsonObject => ({
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
});

/** `convertResponsesToolSearchToolToOpenAIChat`. */
const convertResponsesToolSearchToolToOpenAIChat = (tool: Json, name: string): JsonObject => {
  const description = responsesToolDescription(tool);
  const declared = responsesToolParameters(tool);

  return {
    type: "function",
    function: {
      name,
      description:
        description !== "" ? description : "Search for deferred tools and load the matching tools.",
      parameters: isObj(declared) ? cloneJson(declared) : TOOL_SEARCH_DEFAULT_PARAMETERS(),
    },
  };
};

/** `responsesToolIndex`: scoped to one request; history and declarations are scanned once. */
export class ResponsesToolIndex {
  readonly declarations: ResponsesToolDeclaration[];
  readonly byChat = new Map<string, ResponsesToolDeclaration>();
  readonly byIdentity = new Map<string, string>();
  readonly byRaw = new Map<string, string>();
  /** Empty string means multiple distinct emitted tools. */
  readonly byLocal = new Map<string, string>();
  readonly custom = new Set<string>();

  constructor(root: Json | undefined) {
    this.declarations = collectResponsesToolDeclarations(root);

    for (const d of this.declarations) {
      const identity = identityKey(d.namespace, d.localName);

      if (!this.byIdentity.has(identity)) this.byIdentity.set(identity, d.chatName);
      const rawName = rawResponsesNamespaceQualifiedName(d.namespace, d.localName);

      if (!this.byRaw.has(rawName)) this.byRaw.set(rawName, d.chatName);

      if (this.byChat.has(d.chatName)) continue;
      this.byChat.set(d.chatName, d);

      if (this.byLocal.has(d.localName)) this.byLocal.set(d.localName, "");
      else this.byLocal.set(d.localName, d.chatName);

      if (d.custom) this.custom.add(d.chatName);
    }
  }

  namespaceName(namespace: string, name: string): string {
    const chatName = this.byIdentity.get(identityKey(namespace, name));

    if (chatName !== undefined) return chatName;

    return this.avoidAlias(qualifyResponsesNamespaceToolName(namespace, name));
  }

  canonicalName(name: string): string {
    if (this.byChat.has(name)) return name;
    const raw = this.byRaw.get(name);

    if (raw !== undefined) return raw;
    const local = this.byLocal.get(name);

    if (local !== undefined && local !== "") return local;

    return this.avoidAlias(capResponsesChatToolName(name));
  }

  avoidAlias(candidate: string): string {
    if (!this.byChat.has(candidate)) return candidate;

    for (let suffix = 1; ; suffix++) {
      const variant = capResponsesChatToolName(`${candidate}_${suffix}`);

      if (!this.byChat.has(variant)) return variant;
    }
  }

  /** `applyIdentity`: writes the declared local name/namespace for an emitted chat name (mutates `item`). */
  applyIdentity(item: Json, qualifiedName: string, itemPath: string): Json {
    let name = qualifiedName.trim();
    let namespace = "";
    const d = this.byChat.get(name);

    if (d !== undefined) {
      name = d.localName;
      namespace = d.namespace;
    }

    return setResponsesToolCallIdentity(item, name, namespace, itemPath);
  }

  /** `singleCustomName`: the only freeform tool's chat name and whether it is the only tool at all. */
  singleCustomName(): { name: string; only: boolean } | undefined {
    if (this.custom.size !== 1) return undefined;
    const [name] = this.custom;

    // SAFETY: the `size !== 1` guard above returned, so the set has exactly one name.
    return { name: name as string, only: this.byChat.size === 1 };
  }

  /** `chatTools`: every declaration in Chat Completions form, deduplicated by function name (first wins). */
  chatTools(): JsonObject[] {
    const merged: JsonObject[] = [];
    const seen = new Set<string>();

    for (const d of this.declarations) {
      if (seen.has(d.chatName)) continue;

      const tool = d.custom
        ? convertResponsesCustomToolToOpenAIChat(d.tool, d.chatName)
        : d.shell
          ? convertResponsesShellToolToOpenAIChat(d.chatName)
          : d.search
            ? convertResponsesToolSearchToolToOpenAIChat(d.tool, d.chatName)
            : convertResponsesFunctionToolToOpenAIChat(d.tool, d.chatName);

      if (tool !== undefined) {
        merged.push(tool);
        seen.add(d.chatName);
      }
    }

    return merged;
  }

  /** `isApplyPatch`: resolves only the original winning custom declaration. */
  isApplyPatch(name: string): boolean {
    const d = this.byChat.get(name);

    return d !== undefined && d.custom && isApplyPatchCustomTool(d.tool);
  }

  isShell(name: string): boolean {
    return this.byChat.get(name)?.shell === true;
  }

  isToolSearch(name: string): boolean {
    return this.byChat.get(name)?.search === true;
  }

  toolSearchName(): string {
    for (const d of this.declarations) if (d.search) return d.chatName;

    return "";
  }

  /**
   * `toolSearchHistory`: replayed client `tool_search_call` / `tool_search_output` items as the function call pair the
   * Chat conversion already groups and pairs. Hosted (server) search items are left alone. Returns the same array
   * when nothing changed.
   */
  toolSearchHistory(items: readonly Json[]): Json[] {
    let name = "";

    const resolveName = (): string => {
      if (name !== "") return name;
      name = this.toolSearchName();

      if (name !== "") return name;

      // History of a search the client no longer declares: reserve a replay-only name.
      const reserved = new Set<string>([
        ...this.byChat.keys(),
        ...this.byRaw.keys(),
        ...this.byLocal.keys(),
      ]);

      for (const item of items) {
        const kind = getStr(item, "type");

        if (kind === "function_call" || kind === "custom_tool_call")
          reserved.add(this.canonicalName(getStr(item, "name")));
      }

      name = RESPONSES_TOOL_SEARCH_FUNCTION_NAME;

      for (let suffix = 1; reserved.has(name); suffix++)
        name = `${RESPONSES_TOOL_SEARCH_FUNCTION_NAME}_${suffix}`;

      return name;
    };

    let out: Json[] | undefined;

    items.forEach((item, i) => {
      const type = getStr(item, "type");

      if (
        (type !== RESPONSES_TOOL_SEARCH_CALL_TYPE && type !== RESPONSES_TOOL_SEARCH_OUTPUT_TYPE) ||
        !isResponsesClientToolSearchItem(item)
      ) {
        out?.push(item);

        return;
      }

      out ??= items.slice(0, i);
      out.push(
        type === RESPONSES_TOOL_SEARCH_CALL_TYPE
          ? this.toolSearchCallAsFunctionCall(item, resolveName())
          : this.toolSearchOutputAsFunctionCallOutput(item),
      );
    });

    return out ?? [...items];
  }

  private toolSearchCallAsFunctionCall(item: Json, searchName: string): JsonObject {
    const call: JsonObject = {
      type: "function_call",
      call_id: extractResponsesCallID(item),
      name: searchName,
      arguments: "{}",
    };

    const args = get(item, "arguments");

    if (typeof args === "string" && args.trim() !== "") call.arguments = args;
    else if (isObj(args)) call.arguments = JSON.stringify(args);

    return call;
  }

  private toolSearchOutputAsFunctionCallOutput(item: Json): JsonObject {
    const names: string[] = [];
    const seen = new Set<string>();

    const append = (name: string): void => {
      if (name === "" || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    };

    const tools = get(item, "tools");

    for (const tool of isArr(tools) ? tools : []) {
      if (getStr(tool, "type").trim() === "namespace") {
        const namespaceName = getStr(tool, "name").trim();
        const children = get(tool, "tools");

        for (const child of isArr(children) ? children : []) {
          const childName = responsesToolName(child);

          if (childName !== "") append(this.namespaceName(namespaceName, childName));
        }
      } else {
        const name = responsesToolName(tool);

        if (name !== "") append(this.canonicalName(name));
      }
    }

    const status = getStr(item, "status").trim();

    return {
      type: "function_call_output",
      call_id: extractResponsesCallID(item),
      output: JSON.stringify({ status: status === "" ? "completed" : status, tools: names }),
    };
  }

  shellName(): string {
    for (const d of this.declarations) if (d.shell) return d.chatName;

    return "";
  }

  /**
   * `shellHistory`: normalises shell history (shell_call -> function_call, shell_call_output -> function_call_output)
   * before call grouping and output pairing. Returns a new array; changed items are copies.
   */
  shellHistory(items: readonly Json[]): Json[] {
    const out = [...items];
    let name = this.shellName();

    if (name === "") {
      // Historical calls stay meaningful after the client withdraws the tool: reserve a replay-only name.
      const reserved = new Set<string>([
        ...this.byChat.keys(),
        ...this.byRaw.keys(),
        ...this.byLocal.keys(),
      ]);

      for (const item of items) {
        const kind = getStr(item, "type");

        if (kind === "function_call" || kind === "custom_tool_call")
          reserved.add(this.canonicalName(getStr(item, "name")));
      }

      name = LOCAL_SHELL;

      for (let suffix = 1; reserved.has(name); suffix++) name = `${LOCAL_SHELL}_${suffix}`;
    }

    out.forEach((item, i) => {
      const copy = structuredClone(item);

      switch (getStr(item, "type")) {
        case "shell_call": {
          const environment = get(item, "environment.type");

          if (environment !== undefined && str(environment) !== "local") return;
          set(copy, "type", "function_call");
          set(copy, "name", name);
          const action = get(item, "action");
          set(copy, "arguments", action === undefined ? "" : JSON.stringify(action));
          break;
        }

        case "shell_call_output":
          set(copy, "type", "function_call_output");
          set(copy, "output", JSON.stringify(item));
          break;
        default:
          return;
      }

      out[i] = copy;
    });

    return out;
  }
}

/** `unwrapCustomToolInput`: the freeform input of `{"input": "..."}` arguments (raw arguments when absent). */
export const unwrapCustomToolInput = (argumentsText: string): string => {
  let parsed: Json;

  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return argumentsText;
  }

  const input = get(parsed, "input");

  if (input === undefined) return argumentsText;

  return typeof input === "string" ? input : JSON.stringify(input);
};

/** `responsesToolOutputText`: flattens a tool output (string or array of text parts) into one text payload. */
export const responsesToolOutputText = (output: Json | undefined): string => {
  if (typeof output === "string") return output;

  if (isArr(output)) {
    let text = "";

    for (const part of output) {
      if (typeof part === "string") {
        text += part;
        continue;
      }

      const t = get(part, "text");

      if (t !== undefined) text += str(t);
    }

    return text;
  }

  return output !== undefined ? JSON.stringify(output) : "";
};

/** `pickRequestJSON`: the original request when available, else the translated one. */
export const pickRequestJson = (
  original: Json | undefined,
  translated: Json | undefined,
): Json | undefined => (original !== undefined ? original : translated);
