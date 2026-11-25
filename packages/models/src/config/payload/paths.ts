/**
 * Expansion of `#(query)` / `#(query)#` path segments into concrete index paths.
 *
 * Go source: internal/runtime/executor/helps/payload_helpers.go (resolvePayloadRulePaths, splitPayloadRulePath,
 * parsePayloadQueryPathPart, payloadQueryMatches). Queries support `&&` and `||` on top of gjson comparison terms.
 */
import { get, isJsonArray, type Json } from "@commissary/json";

/** Splits on `.` outside parentheses and quotes. */
export const splitPayloadRulePath = (path: string): string[] => {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < path.length; i++) {
    const ch = path.charAt(i);

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === "(") {
      depth++;
      continue;
    }

    if (ch === ")") {
      if (depth > 0) depth--;
      continue;
    }

    if (ch === "." && depth === 0) {
      parts.push(path.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(path.slice(start));

  return parts;
};

const findPayloadQueryClose = (part: string): number => {
  let quote = "";
  let escaped = false;
  let depth = 1;

  for (let i = 2; i < part.length; i++) {
    const ch = part.charAt(i);

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === "(") {
      depth++;
      continue;
    }

    if (ch === ")") {
      depth--;

      if (depth === 0) return i;
    }
  }

  return -1;
};

interface QueryPart {
  readonly query: string;
  readonly allMatches: boolean;
}

export const parsePayloadQueryPathPart = (part: string): QueryPart | undefined => {
  if (!part.startsWith("#(")) return undefined;
  const closeIndex = findPayloadQueryClose(part);

  if (closeIndex < 0) return undefined;
  const suffix = part.slice(closeIndex + 1);

  if (suffix !== "" && suffix !== "#") return undefined;

  return { query: part.slice(2, closeIndex).trim(), allMatches: suffix === "#" };
};

const appendPayloadPathPart = (path: string, part: string): string => {
  if (path === "") return part;

  if (part === "") return path;

  return `${path}.${part}`;
};

const splitPayloadLogical = (query: string, operator: string): string[] => {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < query.length; i++) {
    const ch = query.charAt(i);

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (query.startsWith(operator, i)) {
      parts.push(query.slice(start, i).trim());
      i += operator.length - 1;
      start = i + 1;
    }
  }

  parts.push(query.slice(start).trim());

  return parts;
};

/** Evaluates one gjson term (`type=="x"`, `age>3`, `name`) against `item` by wrapping it in an array. */
const payloadQueryTermMatches = (item: Json, term: string): boolean => {
  const trimmed = term.trim();

  if (trimmed === "") return false;

  return get([item], `#(${trimmed})`) !== undefined;
};

export const payloadQueryMatches = (item: Json, query: string): boolean =>
  splitPayloadLogical(query, "||").some((orPart) => {
    const parts = splitPayloadLogical(orPart, "&&");

    return parts.length > 0 && parts.every((part) => payloadQueryTermMatches(item, part));
  });

const payloadValueAtPath = (payload: Json, path: string): Json | undefined =>
  path === "" ? payload : get(payload, path);

/**
 * Expands query segments against the current payload. Paths without `#(` are returned unchanged; a query that
 * matches nothing yields no paths.
 */
export const resolvePayloadRulePaths = (payload: Json, rawPath: string): string[] => {
  const path = rawPath.trim();

  if (path === "") return [];

  if (!path.includes("#(")) return [path];
  const parts = splitPayloadRulePath(path);
  let paths = [""];

  for (const part of parts) {
    const query = parsePayloadQueryPathPart(part);

    if (query === undefined) {
      paths = paths.map((existing) => appendPayloadPathPart(existing, part));
      continue;
    }

    const next: string[] = [];

    for (const basePath of paths) {
      const array = payloadValueAtPath(payload, basePath);

      if (!isJsonArray(array)) continue;

      for (const [index, item] of array.entries()) {
        if (!payloadQueryMatches(item, query.query)) continue;
        next.push(appendPayloadPathPart(basePath, String(index)));

        if (!query.allMatches) break;
      }
    }

    paths = next;

    if (paths.length === 0) return [];
  }

  return paths;
};

/** True when `path` is `trackedPath` or an ancestor/descendant of it. */
export const payloadRuleTargetsPath = (path: string, trackedPath: string): boolean => {
  if (trackedPath === "" || path === "") return false;

  return (
    path === trackedPath || path.startsWith(`${trackedPath}.`) || trackedPath.startsWith(`${path}.`)
  );
};

/** Combines an optional root with a rule path (`root.path`); a leading `.` on the path is dropped. */
export const buildPayloadPath = (root: string | undefined, path: string): string => {
  const r = (root ?? "").trim();
  let p = path.trim();

  if (r === "") return p;

  if (p === "") return r;

  if (p.startsWith(".")) p = p.slice(1);

  return `${r}.${p}`;
};
