/**
 * Tool-name maps between clients and Gemini function declarations.
 *
 * Go source: internal/util/translator.go (FixJSON, CanonicalToolName, ToolNameMapFromClaudeRequest, MapToolName,
 * SanitizedFunctionNameMap, MapSanitizedFunctionName, DisambiguatedToolNameMap, SanitizedToolNameMap,
 * RestoreSanitizedToolName), internal/util/claude_tool_id.go (SanitizeClaudeToolID). `ToolNameMapFromClaudeRequest` also
 * lists the definitions of mid-conversation `tool_addition` blocks (12d97cfe).
 */
import { createHash } from "node:crypto";
import { asString, get, isJsonArray, type Json } from "@commissary/json";
import { sanitizeFunctionName } from "../gemini/util/claude.ts";
import { inlineToolAdditionDefinitions } from "./claude-tool-addition.ts";

/**
 * `FixJSON`: converts single-quoted strings to double-quoted ones (best effort) so partially malformed tool
 * arguments can still be parsed. Everything else is forwarded unchanged.
 */
export const fixJson = (input: string): string => {
  let out = "";
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  const runes = Array.from(input);

  for (let i = 0; i < runes.length; i++) {
    // SAFETY: the loop condition keeps i < runes.length.
    const r = runes[i] as string;

    if (inDouble) {
      out += r;

      if (escaped) {
        escaped = false;
        continue;
      }

      if (r === "\\") {
        escaped = true;
        continue;
      }

      if (r === '"') inDouble = false;
      continue;
    }

    if (inSingle) {
      if (escaped) {
        escaped = false;

        switch (r) {
          case "n":
          case "r":
          case "t":
          case "b":
          case "f":
          case "/":
          case '"':
            out += `\\${r}`;
            break;
          case "\\":
            out += "\\\\";
            break;
          case "'":
            out += "'";
            break;
          case "u": {
            out += "\\u";

            for (let k = 0; k < 4 && i + 1 < runes.length; k++) {
              // SAFETY: the loop condition keeps i + 1 < runes.length.
              const peek = runes[i + 1] as string;

              if (/^[0-9a-fA-F]$/.test(peek)) {
                out += peek;
                i++;
              } else break;
            }

            break;
          }

          default:
            out += `\\${r}`;
        }

        continue;
      }

      if (r === "\\") {
        escaped = true;
        continue;
      }

      if (r === "'") {
        out += '"';
        inSingle = false;
        continue;
      }

      out += r === '"' ? '\\"' : r;
      continue;
    }

    if (r === '"') {
      inDouble = true;
      out += r;
      continue;
    }

    if (r === "'") {
      inSingle = true;
      out += '"';
      continue;
    }

    out += r;
  }

  if (inSingle) out += '"';

  return out;
};

/** Name -> name lookup (Go `map[string]string`; `undefined` = nil map). */
export type NameMap = ReadonlyMap<string, string> | undefined;

/** `CanonicalToolName`: trimmed, leading underscores dropped, lower-cased. */
export const canonicalToolName = (name: string): string =>
  name.trim().replace(/^_+/, "").toLowerCase();

/** `ToolNameMapFromClaudeRequest`: canonical name -> original client name. */
export const toolNameMapFromClaudeRequest = (request: Json | undefined): NameMap => {
  const topLevel = get(request, "tools");
  const inline = inlineToolAdditionDefinitions(request);

  if (!isJsonArray(topLevel) && inline.length === 0) return undefined;
  const out = new Map<string, string>();

  // Tools a `tool_addition` block introduces mid-conversation are declared tools too (upstream 12d97cfe).
  for (const tool of [...(isJsonArray(topLevel) ? topLevel : []), ...inline]) {
    let name = asString(get(tool, "name")).trim();

    if (name === "") name = asString(get(tool, "function.name")).trim();

    if (name === "") continue;
    const key = canonicalToolName(name);

    if (key === "") continue;

    if (!out.has(key)) out.set(key, name);
  }

  return out.size === 0 ? undefined : out;
};

/** `MapToolName`. */
export const mapToolName = (toolNameMap: NameMap, name: string): string => {
  if (name === "" || toolNameMap === undefined) return name;
  const mapped = toolNameMap.get(canonicalToolName(name));

  return mapped !== undefined && mapped !== "" ? mapped : name;
};

/** `SanitizedToolNameMap`: sanitized name -> original name for top-level Claude-style tools. */
export const sanitizedToolNameMap = (request: Json | undefined): NameMap => {
  const tools = get(request, "tools");

  if (!isJsonArray(tools)) return undefined;
  const out = new Map<string, string>();

  for (const tool of tools) {
    const name = asString(get(tool, "name")).trim();

    if (name === "") continue;
    const sanitized = sanitizeFunctionName(name);

    if (sanitized === name) continue;

    if (!out.has(sanitized)) out.set(sanitized, name);
  }

  return out.size === 0 ? undefined : out;
};

/** `RestoreSanitizedToolName`. */
export const restoreSanitizedToolName = (toolNameMap: NameMap, sanitizedName: string): string => {
  if (sanitizedName === "" || toolNameMap === undefined) return sanitizedName;

  return toolNameMap.get(sanitizedName) ?? sanitizedName;
};

const functionNamesFromRequest = (request: Json | undefined): string[] => {
  const tools = get(request, "tools");

  if (!isJsonArray(tools)) return [];
  const names: string[] = [];

  const collectDeclarations = (declarations: Json | undefined): void => {
    if (!isJsonArray(declarations)) return;

    for (const declaration of declarations) {
      const name = asString(get(declaration, "name"));

      if (name !== "") names.push(name);
    }
  };

  const collectTool = (tool: Json): void => {
    const nested = get(tool, "tools");

    if (isJsonArray(nested)) {
      for (const nestedTool of nested) collectTool(nestedTool);

      return;
    }

    let hasDeclarations = false;

    for (const key of ["functionDeclarations", "function_declarations"]) {
      const declarations = get(tool, key);

      if (isJsonArray(declarations)) {
        collectDeclarations(declarations);
        hasDeclarations = true;
      }
    }

    if (hasDeclarations) return;
    const functionName = asString(get(tool, "function.name"));

    if (functionName !== "") {
      names.push(functionName);

      return;
    }

    const name = asString(get(tool, "name"));

    if (name !== "") names.push(name);
  };

  for (const tool of tools) collectTool(tool);

  return names;
};

const disambiguate = (
  base: string,
  original: string,
  used: ReadonlyMap<string, string>,
): string => {
  for (let attempt = 0; ; attempt++) {
    const digest = createHash("sha256").update(`${original}\u0000${attempt}`).digest("hex");
    const suffix = `_${digest.slice(0, 12)}`;
    const maxPrefix = 64 - suffix.length;
    const prefix = base.length > maxPrefix ? base.slice(0, maxPrefix) : base;
    const candidate = prefix + suffix;

    if (!used.has(candidate)) return candidate;
  }
};

/** `SanitizedFunctionNameMap`: original -> collision-free sanitized name (hash suffixes for collisions). */
export const sanitizedFunctionNameMap = (
  request: Json | undefined,
): ReadonlyMap<string, string> | undefined => {
  const names = functionNamesFromRequest(request);

  if (names.length === 0) return undefined;
  const unique = new Set<string>();
  const baseCounts = new Map<string, number>();

  for (const name of names) {
    if (name === "" || unique.has(name)) continue;
    unique.add(name);
    const base = sanitizeFunctionName(name);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  // Go sorts names bytewise (UTF-8); code unit order differs only for astral characters.
  const sorted = [...unique].sort();
  const out = new Map<string, string>();
  const used = new Map<string, string>();

  for (const name of sorted) {
    const base = sanitizeFunctionName(name);
    let mapped = base;

    if ((baseCounts.get(base) ?? 0) > 1 || used.has(base)) mapped = disambiguate(base, name, used);
    out.set(name, mapped);
    used.set(mapped, name);
  }

  return out.size === 0 ? undefined : out;
};

/** `MapSanitizedFunctionName`. */
export const mapSanitizedFunctionName = (nameMap: NameMap, name: string): string => {
  const mapped = nameMap?.get(name);

  return mapped !== undefined && mapped !== "" ? mapped : sanitizeFunctionName(name);
};

/** `DisambiguatedToolNameMap`: sanitized -> original, only for renamed tools. */
export const disambiguatedToolNameMap = (request: Json | undefined): NameMap => {
  const forward = sanitizedFunctionNameMap(request);

  if (forward === undefined || forward.size === 0) return undefined;
  const out = new Map<string, string>();

  for (const [original, sanitized] of forward)
    if (sanitized !== original) out.set(sanitized, original);

  return out.size === 0 ? undefined : out;
};

let claudeToolUseIdCounter = 0;

/** `SanitizeClaudeToolID`: `^[a-zA-Z0-9_-]+$`, non-conforming characters become `_`, empty gets a generated id. */
export const sanitizeClaudeToolId = (id: string): string => {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");

  if (sanitized !== "") return sanitized;
  claudeToolUseIdCounter += 1;

  return `toolu_${Date.now()}000000_${claudeToolUseIdCounter}`;
};
