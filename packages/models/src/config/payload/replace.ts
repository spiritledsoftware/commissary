/**
 * `replace` payload rules: ordered literal and regex replacements in existing strings of the final upstream body.
 *
 * Go source: internal/config/payload_replace.go (PayloadReplaceRule.Validate, PayloadReplacement.Resolve),
 * internal/runtime/executor/helps/payload_replace.go (replacePayloadTextDoc) and payload_replace_paths.go
 * (visitPayloadReplacePath). A rule targets either one role's messages by one-based position (the protocol decides
 * where text lives) or explicit gjson paths to existing strings.
 *
 * Go compiles the patterns as RE2; JavaScript has no RE2, so {@link compileGoRegex} translates the RE2 syntax that
 * differs (leading flag groups, `(?P<name>`, `\A`, `\z`, `\pL`, POSIX classes, escaped punctuation) and rejects what it
 * cannot express. Replacement templates expand like Go's `Regexp.Expand` (`$1`, `${1}`, `$name`, `$$`), and empty
 * matches next to a previous match are skipped like Go's `ReplaceAllString`.
 */
import {
  asBool,
  asString,
  escapePathKey,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonArray,
  type JsonObject,
  wildcardMatch,
} from "@commissary/json";
import type { PayloadReplaceRule, PayloadReplacement } from "./schema.ts";
import {
  buildPayloadPath,
  parsePayloadQueryPathPart,
  payloadQueryMatches,
  splitPayloadRulePath,
} from "./paths.ts";

const ROLES = new Set(["system", "developer", "user"]);

interface ResolvedReplacement {
  readonly source: string;
  readonly replacement: string;
  readonly isRegex: boolean;
}

/** `PayloadReplacement.Resolve`: a literal `{from: to}` or a `{pattern, replacement}` regex step. */
export const resolvePayloadReplacement = (
  entry: PayloadReplacement,
): ResolvedReplacement | string => {
  const keys = Object.keys(entry);

  if (keys.length === 1) {
    // SAFETY: keys has exactly one element.
    const from = keys[0] as string;

    if (from === "") return "replacement source must not be empty";

    // SAFETY: from is an own key of entry.
    return { source: from, replacement: entry[from] as string, isRegex: false };
  }

  const pattern = entry["pattern"];
  const replacement = entry["replacement"];

  if (keys.length === 2 && pattern !== undefined && replacement !== undefined)
    return { source: pattern, replacement, isRegex: true };

  return "each replacement must contain either one string mapping or pattern and replacement";
};

/** `PayloadReplaceRule.Validate`: the reason the rule is unusable, or `undefined`. Regexes are checked per entry. */
export const payloadReplaceRuleError = (rule: PayloadReplaceRule): string | undefined => {
  const target = rule.target ?? {};
  const positions = target.positions ?? [];

  if (target.paths !== undefined) {
    if (target.paths.length === 0) return "target.paths must not be empty";

    if ((target.role ?? "") !== "" || target.all === true || positions.length > 0)
      return "target.paths and role selectors are mutually exclusive";

    if (target.paths.some((path) => path.trim() === ""))
      return "target.paths must contain non-empty paths";
  } else {
    if (!ROLES.has(target.role ?? "")) return "target.role must be system, developer, or user";

    if (target.all === true) {
      if (positions.length > 0) return "target.all and target.positions are mutually exclusive";
    } else if (positions.length === 0) {
      return "target.positions must not be empty unless target.all is true";
    }

    if (positions.some((position) => position < 1))
      return "target.positions must contain positive one-based positions";
  }

  const replacements = rule.replacements ?? [];

  if (replacements.length === 0) return "replacements must not be empty";

  for (const entry of replacements) {
    const resolved = resolvePayloadReplacement(entry);

    if (typeof resolved === "string") return resolved;
  }

  return undefined;
};

// --- Go RE2 -> JavaScript ---------------------------------------------------------------------------------------

/** RE2's ASCII POSIX classes (`[[:alpha:]]`), as JavaScript class contents. */
const POSIX_CLASSES = new Map([
  ["alnum", "0-9A-Za-z"],
  ["alpha", "A-Za-z"],
  ["ascii", "\\x00-\\x7F"],
  ["blank", "\\t "],
  ["cntrl", "\\x00-\\x1F\\x7F"],
  ["digit", "0-9"],
  ["graph", "!-~"],
  ["lower", "a-z"],
  ["print", " -~"],
  ["punct", "!-\\/:-@\\[-`{-~"],
  ["space", "\\t\\n\\v\\f\\r "],
  ["upper", "A-Z"],
  ["word", "0-9A-Za-z_"],
  ["xdigit", "0-9A-Fa-f"],
]);

/** Characters JavaScript's `u` mode accepts escaped outside a class (`SyntaxCharacter` and `/`). */
const JS_ESCAPABLE = new Set("^$\\.*+?()[]{}|/");

const hexEscape = (ch: string): string =>
  `\\x${(ch.codePointAt(0) ?? 0).toString(16).padStart(2, "0")}`;

/**
 * Translates a Go RE2 pattern to a JavaScript `RegExp` (global, Unicode). `undefined` when the pattern is empty,
 * invalid, or uses RE2 syntax with no JavaScript translation (mid-pattern flag groups, `U`, `\Q…\E`, `\C`, negated POSIX
 * classes). JavaScript accepts some syntax RE2 rejects (look-around, backreferences); such patterns run here.
 */
export const compileGoRegex = (pattern: string): RegExp | undefined => {
  if (pattern === "") return undefined;
  let flags = "";
  let i = 0;

  // Leading `(?flags)` groups set the flags of the whole pattern.
  for (;;) {
    const leading = /^\(\?([a-zA-Z]*)\)/.exec(pattern.slice(i));

    if (leading === null) break;
    // SAFETY: the regex has one capture group.
    const groupFlags = leading[1] as string;

    for (const flag of groupFlags) {
      if (flag !== "i" && flag !== "m" && flag !== "s") return undefined;

      if (!flags.includes(flag)) flags += flag;
    }

    i += leading[0].length;
  }

  let out = "";
  let inClass = false;

  while (i < pattern.length) {
    const ch = pattern.charAt(i);

    if (ch === "\\") {
      const next = pattern.charAt(i + 1);

      if (next === "") return undefined;

      if (next === "z") {
        out += "(?![\\s\\S])";
        i += 2;
        continue;
      }

      if (next === "A") {
        out += "(?<![\\s\\S])";
        i += 2;
        continue;
      }

      if (next === "Q" || next === "C") return undefined;

      // RE2 `\x{10FFFF}` is JavaScript `\u{10FFFF}`.
      if (next === "x" && pattern.charAt(i + 2) === "{") {
        out += "\\u";
        i += 2;
        continue;
      }

      if ((next === "p" || next === "P") && /[A-Za-z]/.test(pattern.charAt(i + 2))) {
        out += `\\${next}{${pattern.charAt(i + 2)}}`;
        i += 3;
        continue;
      }

      if (/[!-/:-@[-`{-~]/.test(next) && !(JS_ESCAPABLE.has(next) || (inClass && next === "-"))) {
        out += hexEscape(next);
        i += 2;
        continue;
      }

      out += ch + next;
      i += 2;
      continue;
    }

    if (inClass) {
      if (ch === "[" && pattern.charAt(i + 1) === ":") {
        const close = pattern.indexOf(":]", i + 2);

        if (close < 0) return undefined;
        const name = pattern.slice(i + 2, close);
        const expansion = POSIX_CLASSES.get(name);

        if (expansion === undefined) return undefined;
        out += expansion;
        i = close + 2;
        continue;
      }

      if (ch === "]") inClass = false;
      out += ch;
      i++;
      continue;
    }

    if (ch === "[") {
      inClass = true;
      out += ch;
      i++;

      // A leading `^` and a leading `]` belong to the class.
      if (pattern.charAt(i) === "^") {
        out += "^";
        i++;
      }

      if (pattern.charAt(i) === "]") {
        out += "\\]";
        i++;
      }

      continue;
    }

    if (ch === "(" && pattern.charAt(i + 1) === "?") {
      if (pattern.startsWith("(?P<", i)) {
        out += "(?<";
        i += 4;
        continue;
      }

      // A flag group after the start applies to the rest of its group in RE2; JavaScript has no such form.
      if (/^\(\?[a-zA-Z-]*\)/.test(pattern.slice(i))) return undefined;
    }

    out += ch;
    i++;
  }

  try {
    return new RegExp(out, `gu${flags}`);
  } catch {
    return undefined;
  }
};

/** `Regexp.Expand` over a JavaScript match: `$name`/`${name}` (number or group name), `$$`; malformed `$` is literal. */
const expandGoTemplate = (template: string, match: RegExpExecArray): string => {
  let out = "";
  let i = 0;

  while (i < template.length) {
    const dollar = template.indexOf("$", i);

    if (dollar < 0) {
      out += template.slice(i);
      break;
    }

    out += template.slice(i, dollar);
    const rest = template.slice(dollar + 1);

    if (rest.startsWith("$")) {
      out += "$";
      i = dollar + 2;
      continue;
    }

    const braced = /^\{([A-Za-z0-9_]+)\}/.exec(rest);
    const bare = braced === null ? /^[A-Za-z0-9_]+/.exec(rest) : null;
    const name = braced !== null ? braced[1] : bare?.[0];

    if (name === undefined) {
      out += "$";
      i = dollar + 1;
      continue;
    }

    if (/^\d+$/.test(name)) {
      const index = Number(name);

      out += index < match.length ? (match[index] ?? "") : "";
    } else {
      out += match.groups?.[name] ?? "";
    }

    i = dollar + 1 + (braced !== null ? braced[0].length : name.length);
  }

  return out;
};

/** `Regexp.ReplaceAllString`: Go's search positions, so an empty match right after a match is not replaced. */
const replaceAllGo = (re: RegExp, text: string, template: string): string => {
  let out = "";
  let lastMatchEnd = 0;
  let searchPos = 0;

  while (searchPos <= text.length) {
    re.lastIndex = searchPos;
    const match = re.exec(text);

    if (match === null) break;
    const start = match.index;
    const end = start + match[0].length;
    out += text.slice(lastMatchEnd, start);

    if (end > lastMatchEnd || start === 0) out += expandGoTemplate(template, match);
    lastMatchEnd = end;

    const width =
      searchPos < text.length ? ((text.codePointAt(searchPos) ?? 0) > 0xffff ? 2 : 1) : 0;

    if (searchPos + width > end) searchPos += width;
    else if (searchPos + 1 > end) searchPos++;
    else searchPos = end;
  }

  return out + text.slice(lastMatchEnd);
};

interface Step {
  readonly from: string;
  readonly to: string;
  readonly re: RegExp | undefined;
}

/** The rule's steps; invalid regex entries are skipped (Go logs them by index only). */
const compileSteps = (rule: PayloadReplaceRule): Step[] =>
  (rule.replacements ?? []).flatMap((entry): Step[] => {
    const resolved = resolvePayloadReplacement(entry);

    if (typeof resolved === "string") return [];

    if (!resolved.isRegex)
      return [{ from: resolved.source, to: resolved.replacement, re: undefined }];
    const re = compileGoRegex(resolved.source);

    return re === undefined ? [] : [{ from: resolved.source, to: resolved.replacement, re }];
  });

/** Whether a `pattern` compiles; the config sanitiser drops the entries that do not. */
export const isValidPayloadRegex = (pattern: string): boolean =>
  compileGoRegex(pattern) !== undefined;

// --- Targets --------------------------------------------------------------------------------------------------------

/** A string found in the payload: where it lives and its dotted write path (for tracked paths). */
interface Slot {
  readonly parent: JsonObject | JsonArray;
  readonly key: string | number;
  readonly path: string;
  readonly text: string;
}

const join = (base: string, part: string): string => (base === "" ? part : `${base}.${part}`);

/** A key as a write path component; `:` is escaped too because a leading colon forces an object key in writes. */
const keyPath = (key: string): string => escapePathKey(key).replaceAll(":", "\\:");

const slotOf = (parent: JsonObject | JsonArray, key: string | number, path: string): Slot[] => {
  // SAFETY: key indexes parent (an own key of an object or an index of an array), as every caller checks.
  const value = (parent as Record<string | number, Json>)[key];

  return typeof value === "string" ? [{ parent, key, path, text: value }] : [];
};

/** Where a value lives: its container and its key or index there. */
interface Holder {
  readonly parent: JsonObject | JsonArray;
  readonly key: string | number;
}

/** The strings a path selected, and whether a key glob before it may stop at this key. */
interface WalkResult {
  readonly slots: Slot[];
  readonly committed: boolean;
}

const MISS: WalkResult = { slots: [], committed: false };

/** `payloadReplaceWildcardKey`: an object-key glob, not a query, modifier, literal, multipath or pipe. */
const isWildcardKey = (part: string): boolean => {
  if (part === "" || "@![{".includes(part.charAt(0)) || part.startsWith("#(")) return false;
  let wildcard = false;

  for (let i = 0; i < part.length; i++) {
    const ch = part.charAt(i);

    if (ch === "\\") i++;
    else if (ch === "|") return false;
    else if (ch === "*" || ch === "?") wildcard = true;
  }

  return wildcard;
};

const unescapeKey = (part: string): string => part.replace(/\\(.)/gu, "$1");

/**
 * `visitPayloadReplacePath`: the existing strings a path selects. Queries (`#(…)`, `#(…)#`), `#` projections, `*`/`?`
 * key globs and `@this` are followed; modifiers, pipes, multipaths and literals compute values that are not payload
 * fields, so they select nothing. A key glob picks the first key whose subtree reaches the next array selector (or
 * the end), as gjson does; `committed` reports that.
 */
const walkPath = (
  node: Json,
  holder: Holder | undefined,
  path: string,
  parts: readonly string[],
  at: number,
): WalkResult => {
  if (at === parts.length) {
    return {
      slots: holder === undefined ? [] : slotOf(holder.parent, holder.key, path),
      committed: true,
    };
  }

  // SAFETY: at < parts.length.
  const part = parts[at] as string;

  if (part === "@this") return walkPath(node, holder, path, parts, at + 1);
  const query = parsePayloadQueryPathPart(part);
  const projection = part === "#" && at < parts.length - 1;

  if (query !== undefined || projection) {
    if (!isJsonArray(node)) return MISS;
    const slots: Slot[] = [];
    let committed = query === undefined || query.allMatches;

    for (const [index, item] of node.entries()) {
      if (query !== undefined && !payloadQueryMatches(item, query.query)) continue;
      committed = true;
      slots.push(
        ...walkPath(item, { parent: node, key: index }, join(path, String(index)), parts, at + 1)
          .slots,
      );

      // A first-match query stops at its match even when the rest of the path misses there.
      if (query !== undefined && !query.allMatches) break;
    }

    return { slots, committed };
  }

  if (isWildcardKey(part)) {
    if (!isJsonObject(node)) return MISS;

    for (const [key, child] of Object.entries(node)) {
      if (!wildcardMatch(key, part)) continue;

      const result = walkPath(
        child,
        { parent: node, key },
        join(path, keyPath(key)),
        parts,
        at + 1,
      );

      if (result.committed) return result;
    }

    return MISS;
  }

  if (
    part === "" ||
    part === "#" ||
    "@!{[".includes(part.charAt(0)) ||
    /(?<!\\)\|/u.test(part) ||
    part.includes("#(")
  )
    return MISS;

  if (isJsonArray(node)) {
    if (!/^\d+$/.test(part)) return MISS;
    const index = Number(part);

    if (index >= node.length) return MISS;

    // SAFETY: index < node.length.
    return walkPath(
      node[index] as Json,
      { parent: node, key: index },
      join(path, part),
      parts,
      at + 1,
    );
  }

  if (!isJsonObject(node)) return MISS;
  const key = unescapeKey(part);

  if (!Object.hasOwn(node, key)) return MISS;

  // SAFETY: key is an own key of node.
  return walkPath(
    node[key] as Json,
    { parent: node, key },
    join(path, keyPath(key)),
    parts,
    at + 1,
  );
};

const pathSlots = (payload: Json, root: string, paths: readonly string[]): Slot[] => {
  const seen = new Set<string>();
  const slots: Slot[] = [];

  for (const rulePath of paths) {
    const fullPath = buildPayloadPath(root, rulePath);

    if (fullPath === "") continue;

    for (const slot of walkPath(payload, undefined, "", splitPayloadRulePath(fullPath), 0).slots) {
      // Two paths (or a projection and a query) may select the same field: it is replaced once.
      if (seen.has(slot.path)) continue;
      seen.add(slot.path);
      slots.push(slot);
    }
  }

  return slots;
};

/** Where a protocol keeps its messages and its top-level system text. */
interface Layout {
  readonly arrayPath: string;
  readonly systemPath: string;
  readonly gemini: boolean;
  readonly responses: boolean;
}

const layoutOf = (payload: Json, protocol: string, root: string): Layout | undefined => {
  switch (protocol.trim().toLowerCase()) {
    case "openai":
      return {
        arrayPath: buildPayloadPath(root, "messages"),
        systemPath: "",
        gemini: false,
        responses: false,
      };
    case "claude":
      return {
        arrayPath: buildPayloadPath(root, "messages"),
        systemPath: buildPayloadPath(root, "system"),
        gemini: false,
        responses: false,
      };
    case "codex":
    case "responses":
    case "response":
    case "openai-response":
    case "openai-responses":
    case "meta":
      return {
        arrayPath: buildPayloadPath(root, "input"),
        systemPath: buildPayloadPath(root, "instructions"),
        gemini: false,
        responses: true,
      };
    case "gemini":
    case "antigravity": {
      const camel = buildPayloadPath(root, "systemInstruction");

      return {
        arrayPath: buildPayloadPath(root, "contents"),
        systemPath:
          locate(payload, camel) !== undefined
            ? camel
            : buildPayloadPath(root, "system_instruction"),
        gemini: true,
        responses: false,
      };
    }

    default:
      return undefined;
  }
};

interface Located extends Holder {
  readonly value: Json;
}

/** The value at a plain dotted path built by {@link buildPayloadPath}, with its holder. */
const locate = (payload: Json, path: string): Located | undefined => {
  let parent: JsonObject | JsonArray | undefined;
  let key: string | number | undefined;
  let value: Json = payload;

  for (const part of splitPayloadRulePath(path)) {
    if (isJsonArray(value) && /^\d+$/.test(part) && Number(part) < value.length) {
      parent = value;
      key = Number(part);
    } else if (isJsonObject(value) && Object.hasOwn(value, unescapeKey(part))) {
      parent = value;
      key = unescapeKey(part);
    } else {
      return undefined;
    }

    // SAFETY: key indexes parent, checked above.
    value = (parent as Record<string | number, Json>)[key] as Json;
  }

  return parent === undefined || key === undefined ? undefined : { value, parent, key };
};

/** The editable text of a role-targeted message: Go's `collectContent` / `collectParts`. */
const contentSlots = (
  holder: JsonObject | JsonArray,
  key: string | number,
  content: Json | undefined,
  path: string,
  layout: Layout,
): Slot[] => {
  if (typeof content === "string" && !layout.gemini) return slotOf(holder, key, path);

  if (!isJsonArray(content)) return [];

  return content.flatMap((block, index): Slot[] => {
    if (!isJsonObject(block) || typeof block["text"] !== "string" || asBool(block["thought"]))
      return [];
    const blockPath = join(path, `${index}.text`);

    if (layout.gemini) {
      if (block["functionCall"] !== undefined || block["functionResponse"] !== undefined) return [];

      return slotOf(block, "text", blockPath);
    }

    const type = asString(block["type"]);

    return type === "text" || (layout.responses && type === "input_text")
      ? slotOf(block, "text", blockPath)
      : [];
  });
};

const messageSlots = (message: JsonObject, path: string, layout: Layout): Slot[] =>
  layout.gemini
    ? contentSlots(message, "parts", message["parts"], join(path, "parts"), layout)
    : contentSlots(message, "content", message["content"], join(path, "content"), layout);

const roleSlots = (
  payload: Json,
  protocol: string,
  root: string,
  rule: PayloadReplaceRule,
): Slot[] => {
  const role = rule.target?.role ?? "";
  const all = rule.target?.all === true;
  const positions = new Set(all ? [] : (rule.target?.positions ?? []));
  const lastPosition = Math.max(0, ...positions);
  const selected = (position: number): boolean => all || positions.has(position);
  const layout = layoutOf(payload, protocol, root);

  if (layout === undefined || !ROLES.has(role)) return [];
  const slots: Slot[] = [];
  let position = 0;

  // A top-level system field counts as one message, before any system messages.
  if (role === "system" && layout.systemPath !== "") {
    const system = locate(payload, layout.systemPath);

    if (system !== undefined) {
      position++;

      if (selected(position)) {
        if (layout.gemini) {
          if (isJsonObject(system.value))
            slots.push(
              ...contentSlots(
                system.value,
                "parts",
                system.value["parts"],
                join(layout.systemPath, "parts"),
                layout,
              ),
            );
        } else {
          slots.push(
            ...contentSlots(system.parent, system.key, system.value, layout.systemPath, layout),
          );
        }
      }
    }
  }

  const array = locate(payload, layout.arrayPath);

  if (array === undefined) return slots;

  if (layout.responses && typeof array.value === "string") {
    if (role === "user" && selected(1))
      slots.push(...slotOf(array.parent, array.key, layout.arrayPath));

    return slots;
  }

  if (!isJsonArray(array.value) || !(all || position < lastPosition)) return slots;

  for (const [index, message] of array.value.entries()) {
    if (!isJsonObject(message) || asString(message["role"]) !== role) continue;

    if (layout.responses) {
      const type = message["type"];

      if (type !== undefined && type !== "message") continue;
    }

    position++;

    if (selected(position))
      slots.push(...messageSlots(message, join(layout.arrayPath, String(index)), layout));

    if (!all && position >= lastPosition) break;
  }

  return slots;
};

/**
 * Applies one valid, matching replace rule to `payload` in place. Every selected string is rewritten by the rule's
 * steps in order; `noteWrite` receives the path of each string that changed.
 */
export const applyPayloadReplaceRule = (
  payload: Json,
  protocol: string,
  root: string,
  rule: PayloadReplaceRule,
  noteWrite: (path: string) => void,
): void => {
  const paths = rule.target?.paths;

  const slots =
    paths !== undefined && paths.length > 0
      ? pathSlots(payload, root, paths)
      : roleSlots(payload, protocol, root, rule);

  if (slots.length === 0) return;
  const steps = compileSteps(rule);

  // Every selection is made before the first write, so a replacement cannot change what a later path selects.
  const changes = slots.flatMap((slot) => {
    let text = slot.text;

    for (const step of steps)
      text =
        step.re === undefined
          ? text.split(step.from).join(step.to)
          : replaceAllGo(step.re, text, step.to);

    return text === slot.text ? [] : [{ slot, text }];
  });

  for (const { slot, text } of changes) {
    // SAFETY: slot.key indexes slot.parent (it was read from there).
    (slot.parent as Record<string | number, Json>)[slot.key] = text;
    noteWrite(slot.path);
  }
};
