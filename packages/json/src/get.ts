/**
 * gjson-compatible read access over parsed JSON values.
 *
 * Port of the subset of github.com/tidwall/gjson v1.18 used by the Go code (see `internal/translator`,
 * `internal/runtime/executor/helps/payload_helpers.go`):
 *  - dot paths with `\` escapes, array indexes, wildcard keys (`*`, `?`);
 *  - `#` (count), `#.key` (projection), `#(query)` (first match) and `#(query)#` (all matches) with the
 *    operators `== != < <= > >= % !%`, bare existence queries and the `~` boolean conversions;
 *  - `|` pipes and the modifiers `@this @reverse @keys @values @flatten @ugly @pretty @valid`.
 * Not supported (the path simply does not match): multipaths (`{a,b}`, `[a,b]`), `!` literals, JSON lines (`..`),
 * the other modifiers, and `&&`/`||` inside queries (gjson does not support them either; the payload rules
 * engine layers them on top).
 *
 * `undefined` means "does not exist"; a JSON `null` exists.
 */
import {
  isJsonArray,
  isJsonContainer,
  isJsonObject,
  type Json,
  type JsonArray,
  type JsonObject,
} from "./value.ts";
import { wildcardMatch } from "./wildcard.ts";

interface Hit {
  readonly value: Json | undefined;
}

const MODIFIERS = new Set([
  "this",
  "reverse",
  "keys",
  "values",
  "flatten",
  "ugly",
  "pretty",
  "valid",
]);

/** gjson `parseUint`: decimal digits only. */
export const parseUint = (text: string): number | undefined => {
  if (text.length === 0 || text.length > 15) return undefined;
  let n = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    if (code < 48 || code > 57) return undefined;
    n = n * 10 + (code - 48);
  }

  return n;
};

/** gjson `trim`: strips bytes <= 0x20 from both ends. */
const trimSpace = (text: string): string => {
  let start = 0;
  let end = text.length;

  while (start < end && text.charCodeAt(start) <= 32) start++;

  while (end > start && text.charCodeAt(end - 1) <= 32) end--;

  return text.slice(start, end);
};

const unescapeJsonString = (text: string): string => {
  try {
    const parsed: string = JSON.parse(`"${text}"`);

    return parsed;
  } catch {
    return text;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Path parsing (gjson.go parseObjectPath / parseArrayPath / parseQuery)
// ---------------------------------------------------------------------------------------------------------------

/** Mirrors gjson `isDotPiperChar`: a `.` followed by a modifier or multipath behaves like a pipe. */
const isDotPiperChar = (rest: string): boolean => {
  const c = rest[0];

  if (c === "@") {
    let i = 1;

    for (; i < rest.length; i++) {
      const d = rest[i];

      if (d === "." || d === "|" || d === ":") break;
    }

    return MODIFIERS.has(rest.slice(1, i));
  }

  return c === "[" || c === "{";
};

interface ObjectPath {
  part: string;
  path: string;
  pipe: string;
  piped: boolean;
  wild: boolean;
  more: boolean;
}

const parseObjectPath = (path: string): ObjectPath => {
  const r: ObjectPath = { part: "", path: "", pipe: "", piped: false, wild: false, more: false };

  const dot = (i: number, part: string): ObjectPath => {
    r.part = part;

    if (i < path.length - 1 && isDotPiperChar(path.slice(i + 1))) {
      r.pipe = path.slice(i + 1);
      r.piped = true;
    } else {
      r.path = path.slice(i + 1);
      r.more = true;
    }

    return r;
  };

  for (let i = 0; i < path.length; i++) {
    const c = path[i];

    if (c === "|") {
      r.part = path.slice(0, i);
      r.pipe = path.slice(i + 1);
      r.piped = true;

      return r;
    }

    if (c === ".") return dot(i, path.slice(0, i));

    if (c === "*" || c === "?") {
      r.wild = true;
      continue;
    }

    if (c === "\\") {
      let epart = path.slice(0, i);
      i++;

      if (i < path.length) {
        epart += path[i];
        i++;

        for (; i < path.length; i++) {
          // SAFETY: i is bounded by the enclosing loop condition i < path.length.
          const d = path[i] as string;

          if (d === "\\") {
            i++;

            if (i < path.length) epart += path[i];
            continue;
          } else if (d === ".") {
            return dot(i, epart);
          } else if (d === "|") {
            r.part = epart;
            r.pipe = path.slice(i + 1);
            r.piped = true;

            return r;
          } else if (d === "*" || d === "?") {
            r.wild = true;
          }

          epart += d;
        }
      }

      r.part = epart;

      return r;
    }
  }

  r.part = path;

  return r;
};

interface ParsedQuery {
  path: string;
  op: string;
  value: string;
  /** Index just after the closing bracket. */
  end: number;
  vesc: boolean;
}

const parseQuery = (query: string): ParsedQuery | undefined => {
  if (query.length < 2 || query[0] !== "#" || (query[1] !== "(" && query[1] !== "["))
    return undefined;
  let i = 2;
  let j = 0;
  let depth = 1;
  let vesc = false;

  for (; i < query.length; i++) {
    // SAFETY: i is bounded by the enclosing loop condition i < query.length.
    const c = query[i] as string;

    if (depth === 1 && j === 0 && (c === "!" || c === "=" || c === "<" || c === ">" || c === "%")) {
      j = i;
      continue;
    }

    if (c === "\\") {
      i++;
    } else if (c === "[" || c === "(") {
      depth++;
    } else if (c === "]" || c === ")") {
      depth--;

      if (depth === 0) break;
    } else if (c === '"') {
      i++;

      for (; i < query.length; i++) {
        if (query[i] === "\\") {
          vesc = true;
          i++;
        } else if (query[i] === '"') {
          break;
        }
      }
    }
  }

  if (depth > 0) return undefined;
  let path: string;
  let op = "";
  let value = "";

  if (j > 0) {
    path = trimSpace(query.slice(2, j));
    value = trimSpace(query.slice(j, i));
    let opsz = 0;
    const v0 = value[0];
    const v1 = value[1];

    if (value.length === 1) opsz = 1;
    else if (v0 === "!" && v1 === "=") opsz = 2;
    else if (v0 === "!" && v1 === "%") opsz = 2;
    else if (v0 === "<" && v1 === "=") opsz = 2;
    else if (v0 === ">" && v1 === "=") opsz = 2;
    else if (v0 === "=" && v1 === "=") {
      value = value.slice(1);
      opsz = 1;
    } else if (v0 === "<" || v0 === ">" || v0 === "=" || v0 === "%") opsz = 1;
    op = value.slice(0, opsz);
    value = trimSpace(value.slice(opsz));
  } else {
    path = trimSpace(query.slice(2, i));
  }

  return { path, op, value, end: i + 1, vesc };
};

interface ArrayPath {
  part: string;
  path: string;
  pipe: string;
  piped: boolean;
  more: boolean;
  arrch: boolean;
  alogok: boolean;
  alogkey: string;
  query: { on: boolean; all: boolean; path: string; op: string; value: string };
}

const parseArrayPath = (path: string): ArrayPath => {
  const r: ArrayPath = {
    part: "",
    path: "",
    pipe: "",
    piped: false,
    more: false,
    arrch: false,
    alogok: false,
    alogkey: "",
    query: { on: false, all: false, path: "", op: "", value: "" },
  };

  for (let i = 0; i < path.length; i++) {
    const c = path[i];

    if (c === "|") {
      r.part = path.slice(0, i);
      r.pipe = path.slice(i + 1);
      r.piped = true;

      return r;
    }

    if (c === ".") {
      r.part = path.slice(0, i);

      if (!r.arrch && i < path.length - 1 && isDotPiperChar(path.slice(i + 1))) {
        r.pipe = path.slice(i + 1);
        r.piped = true;
      } else {
        r.path = path.slice(i + 1);
        r.more = true;
      }

      return r;
    }

    if (c === "#") {
      r.arrch = true;

      if (i === 0 && path.length > 1) {
        if (path[1] === ".") {
          r.alogok = true;
          r.alogkey = path.slice(2);
          r.path = path.slice(0, 1);
        } else if (path[1] === "[" || path[1] === "(") {
          r.query.on = true;
          const q = parseQuery(path.slice(i));

          if (q === undefined) break;
          let value = q.value;

          if (value.length >= 2 && value[0] === '"' && value.at(-1) === '"') {
            value = value.slice(1, -1);

            if (q.vesc) value = unescapeJsonString(value);
          }

          r.query.path = q.path;
          r.query.op = q.op;
          r.query.value = value;
          i = q.end - 1;

          if (i + 1 < path.length && path[i + 1] === "#") r.query.all = true;
        }
      }
    }
  }

  r.part = path;
  r.path = "";

  return r;
};

/** gjson `splitPossiblePipe`: splits `left|right` at the first pipe that is not inside a `#(...)` selector. */
const splitPossiblePipe = (path: string): { left: string; right: string } | undefined => {
  if (!path.includes("|")) return undefined;

  for (let i = 0; i < path.length; i++) {
    const c = path[i];

    if (c === "\\") {
      i++;
    } else if (c === ".") {
      if (i === path.length - 1) return undefined;

      if (path[i + 1] === "#") {
        i += 2;

        if (i === path.length) return undefined;
        const open = path[i];

        if (open === "[" || open === "(") {
          const close = open === "[" ? "]" : ")";
          i++;
          let depth = 1;

          for (; i < path.length; i++) {
            const d = path[i];

            if (d === "\\") {
              i++;
            } else if (d === open) {
              depth++;
            } else if (d === close) {
              depth--;

              if (depth === 0) break;
            } else if (d === '"') {
              i++;

              for (; i < path.length; i++) {
                if (path[i] === "\\") i++;
                else if (path[i] === '"') break;
              }
            }
          }
        }
      }
    } else if (c === "|") {
      return { left: path.slice(0, i), right: path.slice(i + 1) };
    }
  }

  return undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// Query evaluation (gjson.go queryMatches)
// ---------------------------------------------------------------------------------------------------------------

const parseBool = (text: string): boolean | undefined => {
  switch (text) {
    case "1":
    case "t":
    case "T":
    case "true":
    case "TRUE":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "false":
    case "FALSE":
    case "False":
      return false;
    default:
      return undefined;
  }
};

const falseish = (value: Json | undefined): boolean => {
  if (value === null) return true;

  if (value === false) return true;

  if (typeof value === "string") {
    const b = parseBool(value.toLowerCase());

    return b === undefined ? false : !b;
  }

  if (typeof value === "number") return value === 0;

  return false;
};

const trueish = (value: Json | undefined): boolean => {
  if (value === true) return true;

  if (typeof value === "string") return parseBool(value.toLowerCase()) === true;

  if (typeof value === "number") return value !== 0;

  return false;
};

const parseFloatOrZero = (text: string): number => {
  const n = Number(text);

  return Number.isNaN(n) ? 0 : n;
};

const queryMatches = (query: ArrayPath["query"], input: Json | undefined): boolean => {
  let rpv = query.value;
  let value = input;

  if (rpv.length > 0 && rpv[0] === "~") {
    rpv = rpv.slice(1);
    let ish: boolean | undefined;

    switch (rpv) {
      case "*":
        ish = value !== undefined;
        break;
      case "null":
        ish = value === null;
        break;
      case "true":
        ish = trueish(value);
        break;
      case "false":
        ish = falseish(value);
        break;
      default:
        ish = undefined;
    }

    if (ish === undefined) {
      rpv = "";
      value = undefined;
    } else {
      rpv = "true";
      value = ish;
    }
  }

  if (value === undefined) return false;

  if (query.op === "") return true;

  if (typeof value === "string") {
    switch (query.op) {
      case "=":
        return value === rpv;
      case "!=":
        return value !== rpv;
      case "<":
        return value < rpv;
      case "<=":
        return value <= rpv;
      case ">":
        return value > rpv;
      case ">=":
        return value >= rpv;
      case "%":
        return wildcardMatch(value, rpv);
      case "!%":
        return !wildcardMatch(value, rpv);
    }

    return false;
  }

  if (typeof value === "number") {
    const n = parseFloatOrZero(rpv);

    switch (query.op) {
      case "=":
        return value === n;
      case "!=":
        return value !== n;
      case "<":
        return value < n;
      case "<=":
        return value <= n;
      case ">":
        return value > n;
      case ">=":
        return value >= n;
    }

    return false;
  }

  if (value === true) {
    switch (query.op) {
      case "=":
        return rpv === "true";
      case "!=":
        return rpv !== "true";
      case ">":
        return rpv === "false";
      case ">=":
        return true;
    }

    return false;
  }

  if (value === false) {
    switch (query.op) {
      case "=":
        return rpv === "false";
      case "!=":
        return rpv !== "false";
      case "<":
        return rpv === "true";
      case "<=":
        return true;
    }

    return false;
  }

  return false;
};

// ---------------------------------------------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------------------------------------------

/** Returns the JSON text of the balanced `{...}`, `[...]` or `"..."` at the start of `text`. */
const squash = (text: string): string => {
  const open = text[0];

  if (open === '"') {
    for (let i = 1; i < text.length; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === '"') return text.slice(0, i + 1);
    }

    return text;
  }

  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '"') {
      i = squash(text.slice(i)).length + i - 1;
    } else if (c === "{" || c === "[" || c === "(") {
      depth++;
    } else if (c === "}" || c === "]" || c === ")") {
      depth--;

      if (depth === 0) return text.slice(0, i + 1);
    }
  }

  return text;
};

const reverseObject = (object: JsonObject): JsonObject => {
  const out: JsonObject = {};

  for (const [key, entry] of Object.entries(object).toReversed()) out[key] = entry;

  return out;
};

const flatten = (value: JsonArray, deep: boolean): JsonArray => {
  const out: JsonArray = [];

  for (const item of value) {
    if (Array.isArray(item)) out.push(...(deep ? flatten(item, true) : item));
    else out.push(item);
  }

  return out;
};

const applyModifier = (name: string, value: Json, arg: string): Json => {
  switch (name) {
    case "reverse":
      if (Array.isArray(value)) return value.toReversed();

      if (isJsonObject(value)) return reverseObject(value);

      return value;
    case "keys":
      if (isJsonObject(value)) return Object.keys(value);

      if (Array.isArray(value)) return value.map(() => null);

      return [null];
    case "values":
      if (Array.isArray(value)) return value;

      if (isJsonObject(value)) return Object.values(value);

      return [value];
    case "flatten": {
      if (!Array.isArray(value)) return value;
      let deep = false;

      if (arg !== "") {
        try {
          const parsed: unknown = JSON.parse(arg);
          deep = isJsonObject(parsed) && parsed.deep === true;
        } catch {
          deep = false;
        }
      }

      return flatten(value, deep);
    }

    default:
      return value;
  }
};

/** gjson `execModifier`: `path` starts with `@`. */
const execModifier = (root: Json, path: string): { value: Json; rest: string } | undefined => {
  let name = path.slice(1);
  let rest = "";
  let hasArgs = false;

  for (let i = 1; i < path.length; i++) {
    const c = path[i];

    if (c === ":") {
      rest = path.slice(i + 1);
      name = path.slice(1, i);
      hasArgs = rest.length > 0;
      break;
    }

    if (c === "|" || c === ".") {
      rest = path.slice(i);
      name = path.slice(1, i);
      break;
    }
  }

  if (!MODIFIERS.has(name)) return undefined;
  let arg = "";

  if (hasArgs) {
    const first = rest[0];

    if (first === "{" || first === "[" || first === '"') {
      arg = squash(rest);
      rest = rest.slice(arg.length);
    } else {
      let i = 0;

      for (; i < rest.length; i++) {
        const c = rest[i];

        if (c === "|") break;

        if (c === "{" || c === "[" || c === '"' || c === "(") i += squash(rest.slice(i)).length - 1;
      }

      arg = rest.slice(0, i);
      rest = rest.slice(i);
    }
  }

  return { value: applyModifier(name, root, arg), rest };
};

// ---------------------------------------------------------------------------------------------------------------
// Evaluation (gjson.go parseObject / parseArray)
// ---------------------------------------------------------------------------------------------------------------

/** Reads the rest of `rp` from the value matched for its part. */
const getMatched = (value: Json, rp: ObjectPath): Hit | undefined => {
  if (!rp.more) return { value: rp.piped ? get(value, rp.pipe) : value };

  if (isJsonObject(value)) return getObject(value, rp.path);

  if (isJsonArray(value)) return getArray(value, rp.path);

  return undefined;
};

const getObject = (object: JsonObject, path: string): Hit | undefined => {
  const rp = parseObjectPath(path);

  // gjson scans the keys for the first match and keeps scanning when the rest of the path misses below it. A plain
  // part names at most one own key of a JS object, so a direct lookup gives the same result without making every
  // lookup cost as much as the object has keys. Wildcards still scan.
  if (!rp.wild) {
    const value = Object.hasOwn(object, rp.part) ? object[rp.part] : undefined;

    return value === undefined ? undefined : getMatched(value, rp);
  }

  for (const key of Object.keys(object)) {
    if (!wildcardMatch(key, rp.part)) continue;
    // SAFETY: key comes from Object.keys(object), so it is an own key of object.
    const hit = getMatched(object[key] as Json, rp);

    if (hit !== undefined) return hit;
  }

  return undefined;
};

const getArray = (array: JsonArray, path: string): Hit | undefined => {
  const rp = parseArrayPath(path);
  let pipe: string | undefined = !rp.more && rp.piped ? rp.pipe : undefined;

  const finish = (value: Json | undefined): Hit => ({
    value: pipe !== undefined ? get(value, pipe) : value,
  });

  if (rp.query.on) {
    const matches: Json[] = [];

    for (const element of array) {
      let res: Json | undefined;

      if (isJsonContainer(element)) {
        res = get(element, rp.query.path);
      } else {
        if (rp.query.path !== "") continue;
        res = element;
      }

      if (!queryMatches(rp.query, res)) continue;
      let out: Json | undefined = element;

      if (rp.more) {
        const split = splitPossiblePipe(rp.path);

        if (split !== undefined) {
          rp.path = split.left;
          pipe = split.right;
        }

        out = get(element, rp.path);
      }

      if (rp.query.all) {
        if (out !== undefined) matches.push(out);
      } else {
        return finish(out);
      }
    }

    return rp.query.all ? finish(matches) : undefined;
  }

  if (rp.arrch) {
    if (rp.part !== "#") return undefined;

    if (!rp.alogok) return finish(array.length);
    let key = rp.alogkey;
    const split = splitPossiblePipe(key);

    if (split !== undefined) {
      key = split.left;
      pipe = split.right;
    }

    const projected: Json[] = [];

    for (const element of array) {
      const res = get(element, key);

      if (res !== undefined) projected.push(res);
    }

    return finish(projected);
  }

  const index = parseUint(rp.part);

  if (index === undefined || index >= array.length) return undefined;
  // SAFETY: index is checked against array.length on the previous line.
  const element = array[index] as Json;

  if (!rp.more) return finish(element);

  if (isJsonObject(element)) return getObject(element, rp.path);

  if (isJsonArray(element)) return getArray(element, rp.path);

  return undefined;
};

/** gjson.Get: returns the value at `path`, or `undefined` when it does not exist. */
export const get = (root: Json | undefined, path: string): Json | undefined => {
  if (root === undefined) return undefined;

  if (path.length > 1 && path[0] === "@") {
    const modified = execModifier(root, path);

    if (modified !== undefined) {
      const first = modified.rest[0];

      if (modified.rest.length > 0 && (first === "|" || first === "."))
        return get(modified.value, modified.rest.slice(1));

      return modified.value;
    }
  }

  if (isJsonObject(root)) return getObject(root, path)?.value;

  if (isJsonArray(root)) return getArray(root, path)?.value;

  return undefined;
};

/** True when `path` exists (a JSON `null` counts as existing, like gjson `Result.Exists`). */
export const exists = (root: Json | undefined, path: string): boolean =>
  get(root, path) !== undefined;
