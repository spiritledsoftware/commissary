/**
 * Responses tool descriptors and the Responses <-> Claude tool name mapping.
 *
 * Go source: internal/translator/claude/openai/responses/claude_openai-responses_request.go (descriptor helpers) and
 * claude_openai-responses_tool_names.go.
 *
 * `nativeToolSearch` (Go `toolSearch`) is the per-attempt decision of native tool search (see `./tool-search.ts`). Off,
 * the client `tool_search` declaration is not a tool at all. On, it is the function `tool_search`, tools a
 * `tool_search_output` loaded join the declared ones (priority 2) and `defer_loading` tools stay hidden until then.
 */
import { createHash } from "node:crypto";
import { asBool, get, type Json } from "@commissary/json";
import { sanitizeClaudeFunctionName } from "../../../common/claude-util.ts";
import { exists, isArr, str } from "../../../common/gjson.ts";
import { qualifyResponsesNamespaceToolName } from "../../../common/responses-tools.ts";

export { qualifyResponsesNamespaceToolName };

export interface ToolDescriptor {
  readonly name: string;
  readonly childName: string;
  readonly namespace: string;
  readonly toolType: string;
  readonly tool: Json;
  readonly sourcePriority: number;
  readonly direct: boolean;
  readonly order: number;
  /** The client's `tool_search` declaration, which only exists with native tool search. */
  readonly clientSearch: boolean;
}

/** Source priority of tools a `tool_search_output` loaded: after every declared tool, in discovery order. */
export const DISCOVERED_TOOL_PRIORITY = 2;

export const responsesToolName = (tool: Json | undefined): string => {
  const name = str(get(tool, "name")).trim();

  return name !== "" ? name : str(get(tool, "function.name")).trim();
};

export const isUnsupportedOpenAIBuiltinToolType = (toolType: string): boolean =>
  toolType === "image_generation" ||
  toolType === "file_search" ||
  toolType === "code_interpreter" ||
  toolType === "computer_use_preview";

interface ToolSource {
  readonly tools: Json[];
  readonly priority: number;
}

const toolSources = (root: Json | undefined, nativeToolSearch: boolean): ToolSource[] => {
  const sources: ToolSource[] = [];
  const tools = get(root, "tools");

  if (isArr(tools)) sources.push({ tools, priority: 0 });
  const input = get(root, "input");

  if (isArr(input)) {
    for (const item of input) {
      if (str(get(item, "type")) !== "additional_tools") continue;
      const nested = get(item, "tools");

      if (isArr(nested)) sources.push({ tools: nested, priority: 1 });
    }

    if (nativeToolSearch) {
      for (const item of input) {
        if (str(get(item, "type")) !== "tool_search_output") continue;
        const discovered = get(item, "tools");

        if (isArr(discovered))
          sources.push({ tools: discovered, priority: DISCOVERED_TOOL_PRIORITY });
      }
    }
  }

  return sources;
};

/** A `tool_search` declaration the client executes itself (hosted search cannot run on Claude). */
export const isClientToolSearchDeclaration = (tool: Json | undefined): boolean =>
  str(get(tool, "type")).trim() === "tool_search" &&
  str(get(tool, "execution")).trim() === "client";

/**
 * Whether the client `tool_search` declaration owns the `tool_search` name. A same-named user function that wins
 * leaves no search tool, so deferred tools must stay declared.
 */
export const clientToolSearchWins = (descriptors: readonly ToolDescriptor[]): boolean => {
  let winner: ToolDescriptor | undefined;

  for (const descriptor of descriptors) {
    if (descriptor.name !== "tool_search") continue;

    if (winner === undefined || precedes(descriptor, winner)) winner = descriptor;
  }

  return winner?.clientSearch === true;
};

/** Appends the descriptors of one `tools` array (Go `appendResponsesToolDescriptors`). */
export const appendToolDescriptors = (
  descriptors: ToolDescriptor[],
  tools: readonly Json[],
  sourcePriority: number,
  nativeToolSearch: boolean,
): void => {
  const append = (
    tool: Json,
    name: string,
    childName: string,
    namespace: string,
    toolType: string,
    priority: number,
    direct: boolean,
    clientSearch = false,
  ): void => {
    if (name === "") return;
    descriptors.push({
      name,
      childName,
      namespace,
      toolType,
      tool,
      sourcePriority: priority,
      direct,
      order: descriptors.length,
      clientSearch,
    });
  };

  for (const tool of tools) {
    const toolType = str(get(tool, "type")).trim();

    switch (toolType) {
      case "":
      case "function":
        append(tool, responsesToolName(tool), "", "", "function", sourcePriority, true);
        break;
      case "custom":
        append(tool, responsesToolName(tool), "", "", "custom", sourcePriority, true);
        break;
      case "namespace": {
        const namespaceName = str(get(tool, "name")).trim();
        const children = get(tool, "tools");

        if (!isArr(children)) break;

        for (const child of children) {
          const childName = responsesToolName(child);

          if (childName === "") continue;
          const qualified = qualifyResponsesNamespaceToolName(namespaceName, childName);
          const childType = str(get(child, "type")).trim();

          if (childType === "" || childType === "function")
            append(child, qualified, childName, namespaceName, "function", sourcePriority, false);
          else if (childType === "custom")
            append(child, qualified, childName, namespaceName, "custom", sourcePriority, false);
        }

        break;
      }

      case "tool_search":
        if (isClientToolSearchDeclaration(tool)) {
          // Without native tool search the client's search is not a tool Claude can run.
          if (nativeToolSearch)
            append(tool, "tool_search", "", "", "tool_search", sourcePriority, true, true);
        } else if (!nativeToolSearch) {
          append(tool, str(get(tool, "name")).trim(), "", "", toolType, sourcePriority, true);
        }

        break;
      case "web_search": {
        const external = get(tool, "external_web_access");

        if (exists(external) && !asBool(external)) break;
        let name = str(get(tool, "name")).trim();

        if (name === "") name = "web_search";
        append(tool, name, "", "", "web_search", sourcePriority, true);
        break;
      }

      default:
        if (isUnsupportedOpenAIBuiltinToolType(toolType)) break;
        append(tool, str(get(tool, "name")).trim(), "", "", toolType, sourcePriority, true);
    }
  }
};

export const responsesToolDescriptors = (
  root: Json | undefined,
  nativeToolSearch = false,
): ToolDescriptor[] => {
  let descriptors: ToolDescriptor[] = [];

  for (const source of toolSources(root, nativeToolSearch))
    appendToolDescriptors(descriptors, source.tools, source.priority, nativeToolSearch);

  if (!clientToolSearchWins(descriptors)) return descriptors;

  // With a client tool search, declared defer_loading tools stay hidden until a tool_search_output loads them.
  descriptors = descriptors
    .filter(
      (descriptor) =>
        descriptor.sourcePriority === DISCOVERED_TOOL_PRIORITY ||
        !asBool(get(descriptor.tool, "defer_loading")),
    )
    .map((descriptor, order) => ({ ...descriptor, order }));

  return descriptors;
};

const precedes = (left: ToolDescriptor, right: ToolDescriptor): boolean => {
  if (left.sourcePriority !== right.sourcePriority)
    return left.sourcePriority < right.sourcePriority;

  if (left.direct !== right.direct) return left.direct;

  return left.order < right.order;
};

export const responsesToolWinners = (
  root: Json | undefined,
  nativeToolSearch = false,
): Map<string, ToolDescriptor> => {
  const winners = new Map<string, ToolDescriptor>();

  for (const descriptor of responsesToolDescriptors(root, nativeToolSearch)) {
    const current = winners.get(descriptor.name);

    if (current === undefined || precedes(descriptor, current))
      winners.set(descriptor.name, descriptor);
  }

  return winners;
};

export const responsesToolNameMap = (
  root: Json | undefined,
  accepted: ReadonlySet<string>,
  nativeToolSearch = false,
): Map<string, string> => {
  const toolNameMap = new Map<string, string>();
  const descriptors = responsesToolDescriptors(root, nativeToolSearch);
  const winners = responsesToolWinners(root, nativeToolSearch);

  for (const descriptor of descriptors) {
    const winner = winners.get(descriptor.name);

    if (winner === undefined || winner.order !== descriptor.order || !descriptor.direct) continue;

    if (!accepted.has(descriptor.name)) continue;
    toolNameMap.set(descriptor.name, descriptor.name);
  }

  for (const descriptor of descriptors) {
    const winner = winners.get(descriptor.name);

    if (
      winner === undefined ||
      winner.order !== descriptor.order ||
      descriptor.direct ||
      descriptor.childName === ""
    )
      continue;

    if (!accepted.has(descriptor.name)) continue;

    if (toolNameMap.has(descriptor.childName)) continue;
    toolNameMap.set(descriptor.childName, descriptor.name);
  }

  return toolNameMap;
};

const CLAUDE_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;

/** Maps qualified Responses tool identities to unique Claude tool names for one request, and back. */
export class ClaudeToolNames {
  readonly #toClaude = new Map<string, string>();
  readonly #fromClaude = new Map<string, string>();

  static build(
    root: Json | undefined,
    nativeToolSearch = false,
    winners: Map<string, ToolDescriptor> = responsesToolWinners(root, nativeToolSearch),
  ): ClaudeToolNames {
    const names = new ClaudeToolNames();
    const taken = new Set<string>();
    const declared: string[] = [];

    for (const descriptor of responsesToolDescriptors(root, nativeToolSearch)) {
      const winner = winners.get(descriptor.name);

      if (winner === undefined || winner.order !== descriptor.order) continue;

      if (descriptor.toolType === "function" || descriptor.toolType === "custom")
        declared.push(descriptor.name);
      else names.#assign(descriptor.name, descriptor.name, taken);
    }

    names.#allocate(declared, taken);
    names.#allocate(historyToolIdentities(root), taken);

    return names;
  }

  /** Claude name for a qualified Responses identity. */
  claudeName(identity: string): string {
    return this.#toClaude.get(identity) ?? sanitizeClaudeFunctionName(identity);
  }

  /** Qualified Responses identity for a Claude name; unknown names are returned unchanged. */
  identity(claudeName: string): string {
    return this.#fromClaude.get(claudeName) ?? claudeName;
  }

  #assign(identity: string, name: string, taken: Set<string>): void {
    this.#toClaude.set(identity, name);
    this.#fromClaude.set(name, identity);
    taken.add(name);
  }

  #allocate(identities: readonly string[], taken: Set<string>): void {
    const changed: string[] = [];
    const seen = new Set<string>();

    for (const id of identities) {
      if (this.#toClaude.has(id) || id === "" || seen.has(id)) continue;
      seen.add(id);

      if (CLAUDE_TOOL_NAME_PATTERN.test(id) && !taken.has(id)) {
        this.#assign(id, id, taken);
        continue;
      }

      changed.push(id);
    }

    const count = new Map<string, number>();

    for (const id of changed) {
      const base = sanitizeClaudeFunctionName(id);
      count.set(base, (count.get(base) ?? 0) + 1);
    }

    const hashed: string[] = [];

    for (const id of changed) {
      const base = sanitizeClaudeFunctionName(id);

      if (count.get(base) === 1 && !taken.has(base)) this.#assign(id, base, taken);
      else hashed.push(id);
    }

    hashed.sort();

    for (const id of hashed) {
      let base = sanitizeClaudeFunctionName(id);

      if (base.length > 53) base = base.slice(0, 53);

      for (let n = 0; ; n++) {
        const seed = n > 0 ? `${id}\u0000${n}` : id;
        const name = `${base}_${createHash("sha256").update(seed).digest("hex").slice(0, 10)}`;

        if (!taken.has(name)) {
          this.#assign(id, name, taken);
          break;
        }
      }
    }
  }
}

/** Qualified names of `function_call` and `custom_tool_call` items in input, in order. */
const historyToolIdentities = (root: Json | undefined): string[] => {
  const ids: string[] = [];
  const input = get(root, "input");

  if (!isArr(input)) return ids;

  for (const item of input) {
    const type = str(get(item, "type"));

    if (type !== "function_call" && type !== "custom_tool_call") continue;
    let name = str(get(item, "name"));
    const ns = str(get(item, "namespace")).trim();

    if (ns !== "") name = qualifyResponsesNamespaceToolName(ns, name);

    if (name !== "") ids.push(name);
  }

  return ids;
};

/** Names (Responses identity and Claude name) of declared custom tools. */
export const responsesCustomToolNames = (
  request: Json | undefined,
  nativeToolSearch = false,
): Set<string> => {
  const names = new Set<string>();
  const winners = responsesToolWinners(request, nativeToolSearch);
  const toolNames = ClaudeToolNames.build(request, nativeToolSearch, winners);

  for (const [name, descriptor] of winners) {
    if (descriptor.toolType !== "custom") continue;
    names.add(name);
    const claudeName = toolNames.claudeName(name);

    if (claudeName !== "") names.add(claudeName);
  }

  return names;
};

export type SplitResponsesQualifiedFunctionCallResult = { name: string; namespace: string };

/** `splitResponsesQualifiedFunctionCallFromRequest`. */
export const splitResponsesQualifiedFunctionCall = (
  request: Json | undefined,
  qualifiedName: string,
  nativeToolSearch = false,
): SplitResponsesQualifiedFunctionCallResult => {
  qualifiedName = qualifiedName.trim();

  if (qualifiedName === "") return { name: "", namespace: "" };
  const winners = responsesToolWinners(request, nativeToolSearch);

  const identity = ClaudeToolNames.build(request, nativeToolSearch, winners).identity(
    qualifiedName,
  );

  const descriptor = winners.get(identity);

  if (descriptor === undefined) return { name: identity, namespace: "" };

  if (!descriptor.direct) return { name: descriptor.childName, namespace: descriptor.namespace };

  return { name: identity, namespace: "" };
};

/**
 * `unwrapCustomToolInput`: the freeform input out of a Claude tool_use arguments object, tolerating truncated or
 * invalid JSON by scanning for the `"input"` string value.
 */
export const unwrapCustomToolInput = (args: string): string => {
  const trimmed = args.trim();

  try {
    // SAFETY: JSON.parse can only produce JSON values, which is exactly what Json models.
    const parsed = JSON.parse(trimmed) as Json;
    const value = get(parsed, "input");

    if (exists(value)) return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    // fall through to the lenient scanner
  }

  const idx = trimmed.indexOf('"input"');

  if (idx < 0) return args;
  let rest = trimmed.slice(idx + 7).trim();

  if (!rest.startsWith(":")) return args;
  rest = rest.slice(1).trim();

  if (!rest.startsWith('"')) return args;
  const content = rest.slice(1);
  let out = "";
  let inEscape = false;

  for (let i = 0; i < content.length; i++) {
    // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    const c = content[i] as string;

    if (inEscape) {
      switch (c) {
        case '"':
        case "\\":
        case "/":
          out += c;
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = content.slice(i + 1, i + 5);

          if (i + 4 < content.length && /^[0-9a-fA-F]{4}$/u.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 4;
            inEscape = false;
            continue;
          }

          out += "\\u";
          break;
        }

        default:
          out += `\\${c}`;
      }

      inEscape = false;
    } else if (c === "\\") {
      inEscape = true;
    } else if (c === '"') {
      break;
    } else {
      out += c;
    }
  }

  if (inEscape) out += "\\";

  return out;
};

/** Prefix of a Responses reasoning `encrypted_content` that carries an Anthropic redacted_thinking payload. */
export const CLAUDE_RESPONSES_REDACTED_THINKING_PREFIX = "claude-redacted-thinking:";
