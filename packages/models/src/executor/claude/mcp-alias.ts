/**
 * "OAuth tool names": client tool names are rewritten to Claude Code looking MCP aliases
 * (`mcp__<word>_<word>__<word>_<semantic>`) and restored in responses.
 *
 * Go source: internal/runtime/executor/helps/claude_mcp_alias.go, helps/claude_builtin_tools.go,
 * claude_executor_request.go (remapOAuthToolNamesWithOptionsLegacy, claudeMCPAliasResolver, reverseRemapOAuthToolNames,
 * reverseRemapOAuthToolNamesFromStreamLine). The alias is a pure function of (secret, tool name), so the reverse map
 * is rebuilt from the request's own tools and no state is kept. Not ported: Thread continuation alias state
 * (`thread.type=continue`).
 */
import { createHmac } from "node:crypto";
import { get, type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { isArr, isObj, str } from "@commissary/translation";
import { BIP39_WORDS } from "./bip39-words.ts";

export const DEFAULT_ALIAS_SECRET = "cpa-claude-mcp-default-caller";

const SERVER_TOOL_PREFIXES = [
  "advisor_",
  "agent_toolset_",
  "bash_",
  "code_execution_",
  "computer_",
  "memory_",
  "text_editor_",
  "tool_search_tool_",
  "web_fetch_",
  "web_search_",
];

const DEFAULT_BUILTIN_TOOL_NAMES = ["web_search", "code_execution", "text_editor", "computer"];

export const isServerToolType = (toolType: string): boolean => {
  const lower = toolType.trim().toLowerCase();

  return SERVER_TOOL_PREFIXES.some((prefix) => lower.startsWith(prefix));
};

/** `IsClaudeMCPToolName`: `mcp__<server>__<tool>`, at most 64 characters of `[A-Za-z0-9_-]`. */
export const isMCPToolName = (name: string): boolean => {
  if (name.length === 0 || name.length > 64 || !name.startsWith("mcp__")) return false;
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");

  if (separator <= 0 || separator + 2 >= rest.length) return false;

  return /^[A-Za-z0-9_-]+$/.test(name);
};

const digest = (secret: string, purpose: string, original: string): Buffer =>
  createHmac("sha256", secret)
    .update(`cpa-claude-mcp-alias-v2\u0000${purpose}\u0000${original}`)
    .digest();

const word = (bytes: Buffer, offset: number, attempt: number): string =>
  BIP39_WORDS[(bytes.readUInt16BE(offset) + attempt) % BIP39_WORDS.length] ?? "";

const serverComponent = (secret: string): string => {
  const bytes = digest(secret, "server", "");

  return `${word(bytes, 0, 0)}_${word(bytes, 2, 0)}`;
};

const semanticSuffix = (original: string, maxLength: number): string => {
  let semantic = "";
  let pendingSeparator = false;

  for (const char of original) {
    if (!/^[A-Za-z0-9_-]$/.test(char)) {
      pendingSeparator = semantic.length > 0;
      continue;
    }

    if (pendingSeparator && semantic.length + 1 < maxLength) semantic += "_";
    pendingSeparator = false;

    if (semantic.length >= maxLength) break;
    semantic += char;
  }

  const trimmedSemantic = semantic.replace(/^[_-]+|[_-]+$/g, "");

  return trimmedSemantic === "" ? "tool" : trimmedSemantic;
};

const aliasFor = (server: string, toolId: string, original: string): string => {
  const prefix = `mcp__${server}__${toolId}_`;
  const maxSemantic = Math.max(64 - prefix.length, 1);

  return prefix + semanticSuffix(original, maxSemantic);
};

/** `AllocateClaudeMCPToolAlias`: first alias (linear probing over the wordlist) that is not reserved. */
export const allocateToolAlias = (
  secret: string,
  original: string,
  reserved: ReadonlySet<string>,
): string | undefined => {
  const server = serverComponent(secret);
  const base = digest(secret, "tool", original).readUInt16BE(0) % BIP39_WORDS.length;

  for (let attempt = 0; attempt < BIP39_WORDS.length; attempt++) {
    const alias = aliasFor(
      server,
      BIP39_WORDS[(base + attempt) % BIP39_WORDS.length] ?? "",
      original,
    );

    if (!reserved.has(alias)) return alias;
  }

  return undefined;
};

export class AliasRestoreError extends Error {
  override readonly name = "AliasRestoreError";
}

/** alias -> original (passthrough MCP tools map to themselves). */
export type ReverseMap = ReadonlyMap<string, string>;

const toolChangeNamePath = (part: Json): string => {
  switch (str(get(part, "tool.type"))) {
    case "tool_reference":
      return "tool.name";
    case "tool_definition":
      if (
        str(get(part, "type")) !== "tool_addition" ||
        isServerToolType(str(get(part, "tool.definition.type")))
      )
        return "";

      return "tool.definition.name";
  }

  return "";
};

/** `remapOAuthToolNamesWithOptionsLegacy`: mutates `body`, returns the reverse map. */
export const remapToolNames = (body: JsonObject, secret: string): Map<string, string> => {
  const reverse = new Map<string, string>();

  const recordRename = (original: string, renamed: string): void => {
    if (!reverse.has(renamed)) reverse.set(renamed, original);
  };

  const tools = body.tools;
  const forward = new Map<string, string>();
  const protectedNames = new Set<string>();
  const reserved = new Set<string>(DEFAULT_BUILTIN_TOOL_NAMES);

  if (isArr(tools)) {
    for (const tool of tools) {
      if (isServerToolType(str(get(tool, "type"))) && str(get(tool, "name")) !== "")
        reserved.add(str(get(tool, "name")));
    }

    for (const tool of tools) {
      const name = str(get(tool, "name"));

      if (name !== "") reserved.add(name);

      if (isServerToolType(str(get(tool, "type")))) protectedNames.add(name);
    }

    const passthrough: string[] = [];

    for (const tool of tools) {
      if (isServerToolType(str(get(tool, "type")))) continue;
      const name = str(get(tool, "name"));

      if (name === "") continue;

      if (isMCPToolName(name)) {
        passthrough.push(name);
        continue;
      }

      if (forward.has(name)) continue;
      const alias = allocateToolAlias(secret, name, reserved);

      if (alias === undefined) continue;
      forward.set(name, alias);
      reserved.add(alias);
    }

    if (forward.size > 0) for (const name of passthrough) recordRename(name, name);
  }

  const rewriteName = (name: string): string | undefined => {
    if (name === "" || protectedNames.has(name) || isMCPToolName(name)) return undefined;
    const renamed = forward.get(name);

    return renamed !== undefined && renamed !== name ? renamed : undefined;
  };

  if (isArr(tools)) {
    const needsRewrite = tools.some((tool) => {
      if (isServerToolType(str(get(tool, "type")))) return false;

      if (str(get(tool, "type")).trim() !== "") return true;

      return rewriteName(str(get(tool, "name"))) !== undefined;
    });

    if (needsRewrite) {
      for (const tool of tools) {
        if (!isObj(tool) || isServerToolType(str(tool.type))) continue;

        if (str(tool.type).trim() !== "") delete tool.type;
        const name = str(tool.name);
        const renamed = rewriteName(name);

        if (renamed !== undefined) {
          tool.name = renamed;
          recordRename(name, renamed);
        }
      }
    }
  }

  if (str(get(body, "tool_choice.type")) === "tool") {
    const name = str(get(body, "tool_choice.name"));
    const renamed = rewriteName(name);

    const toolChoice = body.tool_choice;

    if (renamed !== undefined && isObj(toolChoice)) {
      toolChoice.name = renamed;
      recordRename(name, renamed);
    }
  }

  const rename = (target: Json | undefined, key: string): void => {
    if (!isObj(target)) return;
    const original = str(target[key]);
    const renamed = rewriteName(original);

    if (renamed !== undefined) {
      target[key] = renamed;
      recordRename(original, renamed);
    }
  };

  if (isArr(body.messages)) {
    for (const message of body.messages) {
      const content = get(message, "content");

      if (!isArr(content)) continue;

      for (const part of content) {
        switch (str(get(part, "type"))) {
          case "tool_use":
            rename(part, "name");
            break;
          case "tool_reference":
            rename(part, "tool_name");
            break;
          case "tool_result": {
            const nested = get(part, "content");

            if (isArr(nested))
              for (const item of nested)
                if (str(get(item, "type")) === "tool_reference") rename(item, "tool_name");
            break;
          }

          case "tool_search_tool_result": {
            const refs = get(part, "content.tool_references");

            if (isArr(refs))
              for (const ref of refs)
                if (str(get(ref, "type")) === "tool_reference") rename(ref, "tool_name");
            break;
          }

          case "tool_addition":
          case "tool_removal": {
            const path = toolChangeNamePath(part);

            if (path !== "") {
              const parent = get(part, path.slice(0, path.lastIndexOf(".")));
              rename(parent, path.slice(path.lastIndexOf(".") + 1));
            }
          }
        }
      }
    }
  }

  return reverse;
};

interface AliasParts {
  readonly server: string;
  readonly toolId: string;
  readonly semantic: string;
}

const parseAlias = (name: string): AliasParts | undefined => {
  if (!isMCPToolName(name)) return undefined;
  const rest = name.slice("mcp__".length);
  const split = rest.indexOf("__");

  if (split <= 0) return undefined;
  const server = rest.slice(0, split);
  const tool = rest.slice(split + 2);
  const underscore = tool.indexOf("_");

  if (underscore <= 0 || underscore + 1 >= tool.length) return undefined;

  return { server, toolId: tool.slice(0, underscore), semantic: tool.slice(underscore + 1) };
};

const aliasServer = (name: string): string => {
  if (!name.startsWith("mcp__")) return "";
  const rest = name.slice("mcp__".length);
  const split = rest.indexOf("__");

  return split < 0 ? "" : rest.slice(0, split);
};

interface AliasEntry {
  readonly alias: string;
  readonly original: string;
  readonly parts: AliasParts;
}

/** `claudeMCPAliasResolver.resolve`: restores (possibly drifted) alias names to the client's names. */
export class AliasResolver {
  readonly #exact: ReverseMap;
  readonly #aliases: AliasEntry[] = [];
  readonly #servers = new Set<string>();
  readonly #passthroughs: string[] = [];

  constructor(reverse: ReverseMap) {
    this.#exact = reverse;

    for (const [alias, original] of reverse) {
      if (alias === original) {
        this.#passthroughs.push(original);
        continue;
      }

      const parts = parseAlias(alias);

      if (parts === undefined) continue;
      this.#aliases.push({ alias, original, parts });
      this.#servers.add(parts.server);
    }
  }

  /** The original name when `name` is one of this request's aliases; `undefined` when it must be left alone. */
  resolve(name: string): string | undefined {
    const exact = this.#exact.get(name);

    if (exact !== undefined) return exact === name ? undefined : exact;
    const server = aliasServer(name);

    if (!this.#servers.has(server)) return undefined;
    const canonicalPrefix = `mcp__${server}__`;
    let normalized = name;
    let suffix = name.startsWith(canonicalPrefix) ? name.slice(canonicalPrefix.length) : name;

    while (suffix.startsWith(`${server}__`)) {
      suffix = suffix.slice(server.length + 2);
      normalized = canonicalPrefix + suffix;
      const original = this.#exact.get(normalized);

      if (original !== undefined) return original;
    }

    let matches = this.#aliases.filter(
      (entry) => entry.parts.server === server && name.endsWith(entry.alias),
    );

    const single = matches[0];

    if (matches.length === 1 && single !== undefined) return single.original;

    if (matches.length > 1)
      throw new AliasRestoreError(
        `cannot restore Claude OAuth MCP tool alias "${name}": matched multiple declared aliases`,
      );
    const parts = parseAlias(normalized);

    if (parts !== undefined) {
      matches = this.#aliases.filter(
        (entry) => entry.parts.server === parts.server && entry.parts.semantic === parts.semantic,
      );
    }

    if (matches.length === 0) {
      const suffixMatches = this.#aliases.filter(
        (entry) => entry.parts.server === server && normalized.endsWith(`_${entry.parts.semantic}`),
      );

      const firstSuffix = suffixMatches[0];

      if (suffixMatches.length === 1) matches = suffixMatches;
      else if (suffixMatches.length > 1 && firstSuffix !== undefined) {
        let longest = firstSuffix;
        let tie = false;

        for (const candidate of suffixMatches.slice(1)) {
          if (candidate.parts.semantic.length > longest.parts.semantic.length) {
            longest = candidate;
            tie = false;
          } else if (candidate.parts.semantic.length === longest.parts.semantic.length) {
            tie = true;
          }
        }

        matches = tie ? suffixMatches : [longest];
      }
    }

    const resolved = matches[0];

    if (matches.length === 1 && resolved !== undefined) return resolved.original;

    if (matches.length > 1) {
      throw new AliasRestoreError(
        `cannot restore Claude OAuth MCP tool alias "${name}": semantic suffix matches multiple declared tools`,
      );
    }

    if (this.#passthroughs.length > 0) {
      // Recovery 0 (Go 02fc76b1): the model kept the caller's full tool name, `mcp__` prefix included, under the
      // virtual server (`mcp__<virtual>__mcp__<server>__<tool>`).
      if (this.#passthroughs.includes(suffix)) return suffix;

      const reprefixed = `mcp__${suffix}`;

      if (this.#exact.get(reprefixed) === reprefixed) return reprefixed;

      const passthroughMatches = this.#passthroughs.filter((passthrough) => {
        let toolPart = passthrough;

        if (passthrough.startsWith("mcp__")) {
          const rest = passthrough.slice("mcp__".length);
          const split = rest.indexOf("__");

          if (split >= 0) toolPart = rest.slice(split + 2);
        }

        return toolPart === suffix;
      });

      if (passthroughMatches.length === 1) return passthroughMatches[0];

      if (passthroughMatches.length > 1) {
        throw new AliasRestoreError(
          `cannot restore Claude OAuth MCP tool alias "${name}": passthrough tool suffix matches multiple declared tools`,
        );
      }
    }

    return undefined;
  }
}

const restoreRef = (resolver: AliasResolver, target: Json | undefined, key: string): void => {
  if (!isObj(target)) return;
  const original = resolver.resolve(str(target[key]));

  if (original !== undefined) target[key] = original;
};

/** `reverseRemapOAuthToolNames` for a complete Messages response body. */
export const restoreToolNamesInResponse = (body: JsonObject, reverse: ReverseMap): void => {
  if (reverse.size === 0 || !isArr(body.content)) return;
  const resolver = new AliasResolver(reverse);

  for (const part of body.content) {
    switch (str(get(part, "type"))) {
      case "tool_use":
        restoreRef(resolver, part, "name");
        break;
      case "tool_reference":
        restoreRef(resolver, part, "tool_name");
        break;
      case "tool_result": {
        const nested = get(part, "content");

        if (isArr(nested))
          for (const item of nested)
            if (str(get(item, "type")) === "tool_reference")
              restoreRef(resolver, item, "tool_name");
        break;
      }

      case "tool_search_tool_result": {
        const refs = get(part, "content.tool_references");

        if (isArr(refs))
          for (const ref of refs)
            if (str(get(ref, "type")) === "tool_reference") restoreRef(resolver, ref, "tool_name");
      }
    }
  }
};

/** `reverseRemapOAuthToolNamesFromStreamLine`: rewrites `content_block_start` names in one SSE line. */
export const restoreToolNamesInStreamLine = (line: string, reverse: ReverseMap): string => {
  if (reverse.size === 0) return line;
  const trimmed = line.trim();
  const payloadText = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;

  if (!payloadText.startsWith("{")) return line;
  const payload = tryParseJson(payloadText);
  const block = get(payload, "content_block");

  if (!isObj(block)) return line;
  const resolver = new AliasResolver(reverse);
  let changed = false;

  switch (str(block.type)) {
    case "tool_use": {
      const original = resolver.resolve(str(block.name));

      if (original !== undefined) {
        block.name = original;
        changed = true;
      }

      break;
    }

    case "tool_reference": {
      const original = resolver.resolve(str(block.tool_name));

      if (original !== undefined) {
        block.tool_name = original;
        changed = true;
      }

      break;
    }

    case "tool_search_tool_result": {
      const refs = get(block, "content.tool_references");

      if (isArr(refs)) {
        for (const ref of refs) {
          if (str(get(ref, "type")) !== "tool_reference" || !isObj(ref)) continue;
          const original = resolver.resolve(str(ref.tool_name));

          if (original !== undefined) {
            ref.tool_name = original;
            changed = true;
          }
        }
      }
    }
  }

  if (!changed) return line;
  const updated = JSON.stringify(payload);

  return trimmed.startsWith("data:") ? `data: ${updated}` : updated;
};
