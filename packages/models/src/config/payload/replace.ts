/**
 * `replace` payload rules: ordered literal and regex replacements in existing strings of the final upstream body.
 *
 * Go source: internal/config/payload_replace.go (PayloadReplaceRule.Validate, PayloadReplacement.Resolve),
 * internal/runtime/executor/helps/payload_replace.go (replacePayloadTextDoc) and payload_replace_paths.go
 * (visitPayloadReplacePath). A rule targets either one role's messages by one-based position (the protocol decides
 * where text lives) or explicit gjson paths to existing strings.
 *
 * Regex entries run through `re2.ts` (Go RE2 patterns and templates over JavaScript `RegExp`).
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
import { compileGoRegex, replaceAllGo } from "./re2.ts";
import {
  type PayloadReplaceRule,
  type PayloadReplacement,
  payloadReplacementKind,
  INVALID_REPLACEMENT_ERROR,
} from "./schema.ts";
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
  const kind = payloadReplacementKind(entry);

  if (kind === undefined) return INVALID_REPLACEMENT_ERROR;

  if (kind === "regex")
    // SAFETY: a regex entry has exactly the keys `pattern` and `replacement`.
    return {
      source: entry["pattern"] as string,
      replacement: entry["replacement"] as string,
      isRegex: true,
    };

  // SAFETY: a literal entry has exactly one key.
  const [from, to] = Object.entries(entry)[0] as [string, string];

  return from === ""
    ? "replacement source must not be empty"
    : { source: from, replacement: to, isRegex: false };
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
