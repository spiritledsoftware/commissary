/**
 * Go RE2 patterns and replacement templates over JavaScript `RegExp`, for the payload `replace` rules and the
 * `sensitive-patterns-replace` rules.
 *
 * Go source: Go's regexp and regexp/syntax packages, as internal/runtime/executor/helps/payload_replace.go
 * (replacePayloadTextDoc) and helps/cloak_obfuscate.go (collectPatternSpans) use them: `regexp.Compile`,
 * `Regexp.ReplaceAllString`, `Regexp.FindAllStringSubmatchIndex` and `Regexp.Expand`.
 *
 * JavaScript has no RE2, so {@link compileGoRegex} translates the pattern into a `u`-mode `RegExp` with RE2's meaning:
 * `.` and the `(?m)` anchors treat only `\n` as a line break; `\s`, `\w`, `\d`, `\b` and the POSIX classes are ASCII;
 * flags (`i`, `m`, `s`, `U`) are scoped like RE2's, `(?i)` through JavaScript modifier groups; negated classes under
 * `(?i)` exclude every case variant of what they negate, as RE2 does. Syntax RE2 rejects (look-around,
 * backreferences, unknown escapes, repeat counts over 1000) is rejected here too. Not translated: a negated property
 * (`\P{…}`, `\p{^…}`) inside a class under `(?i)` keeps JavaScript's case-insensitive meaning, and a group name used
 * twice, which RE2 accepts, fails to compile here.
 */

/** Flags in force at a point of the pattern. */
interface Flags {
  readonly i: boolean;
  readonly m: boolean;
  readonly s: boolean;
  readonly U: boolean;
}

type MutableFlags = { -readonly [K in keyof Flags]: Flags[K] };

/** An open group: its flags, and the `(?i:` / `(?-i:` groups a `(?flags)` inside it opened (closed with it). */
interface Frame {
  flags: Flags;
  readonly implicit: string[];
}

type Range = readonly [lo: number, hi: number];

const MAX_CODE_POINT = 0x10ffff;

/** RE2's largest repeat count. */
const MAX_REPEAT = 1000;

const DIGIT: readonly Range[] = [[0x30, 0x39]];

const SPACE: readonly Range[] = [
  [0x09, 0x0a],
  [0x0c, 0x0d],
  [0x20, 0x20],
];

const WORD: readonly Range[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];

/** RE2's ASCII POSIX classes (`[[:alpha:]]`). */
const POSIX_CLASSES = new Map<string, readonly Range[]>([
  [
    "alnum",
    [
      [0x30, 0x39],
      [0x41, 0x5a],
      [0x61, 0x7a],
    ],
  ],
  [
    "alpha",
    [
      [0x41, 0x5a],
      [0x61, 0x7a],
    ],
  ],
  ["ascii", [[0x00, 0x7f]]],
  [
    "blank",
    [
      [0x09, 0x09],
      [0x20, 0x20],
    ],
  ],
  [
    "cntrl",
    [
      [0x00, 0x1f],
      [0x7f, 0x7f],
    ],
  ],
  ["digit", DIGIT],
  ["graph", [[0x21, 0x7e]]],
  ["lower", [[0x61, 0x7a]]],
  ["print", [[0x20, 0x7e]]],
  [
    "punct",
    [
      [0x21, 0x2f],
      [0x3a, 0x40],
      [0x5b, 0x60],
      [0x7b, 0x7e],
    ],
  ],
  [
    "space",
    [
      [0x09, 0x0d],
      [0x20, 0x20],
    ],
  ],
  ["upper", [[0x41, 0x5a]]],
  ["word", WORD],
  [
    "xdigit",
    [
      [0x30, 0x39],
      [0x41, 0x46],
      [0x61, 0x66],
    ],
  ],
]);

/** Unicode general categories RE2 names in `\p{…}`; any other name is a script. */
const CATEGORIES = new Set(
  "C Cc Cf Co Cs L Ll Lm Lo Lt Lu M Mc Me Mn N Nd Nl No P Pc Pd Pe Pf Pi Po Ps S Sc Sk Sm So Z Zl Zp Zs".split(
    " ",
  ),
);

/** Characters JavaScript's `u` mode accepts escaped outside a class (`SyntaxCharacter` and `/`). */
const JS_ESCAPABLE = new Set("^$\\.*+?()[]{}|/");

const codePoint = (cp: number): string => `\\u{${cp.toString(16)}}`;

/** Adds the case variants RE2's folding adds to an ASCII set: the other case, `ſ` for s and `K` for k. */
const foldAscii = (ranges: readonly Range[]): Range[] => {
  const out: Range[] = [...ranges];

  const has = (cp: number) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

  for (let cp = 0x41; cp <= 0x5a; cp++) {
    if (has(cp) || has(cp + 0x20)) out.push([cp, cp], [cp + 0x20, cp + 0x20]);
  }

  if (has(0x53) || has(0x73)) out.push([0x17f, 0x17f]);

  if (has(0x4b) || has(0x6b)) out.push([0x212a, 0x212a]);

  return out;
};

const complement = (ranges: readonly Range[]): Range[] => {
  const sorted = [...ranges].toSorted((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  let next = 0;

  for (const [lo, hi] of sorted) {
    if (lo > next) out.push([next, lo - 1]);
    next = Math.max(next, hi + 1);
  }

  if (next <= MAX_CODE_POINT) out.push([next, MAX_CODE_POINT]);

  return out;
};

const classBody = (ranges: readonly Range[]): string =>
  ranges
    .map(([lo, hi]) => (lo === hi ? codePoint(lo) : `${codePoint(lo)}-${codePoint(hi)}`))
    .join("");

/** An ASCII class (or its negation, which under `(?i)` excludes every folded variant) as class contents. */
const classOf = (ranges: readonly Range[], negated: boolean, flags: Flags): string =>
  classBody(negated ? complement(flags.i ? foldAscii(ranges) : ranges) : ranges);

/**
 * `\p{Greek}` / `\pL` / `\p{^Greek}`: a general category stays, a script becomes `Script=`. A negated property under
 * `(?i)` outside a class excludes every case variant of its members, as RE2 does.
 */
const property = (
  name: string,
  negatedEscape: boolean,
  flags: Flags,
  inClass: boolean,
): string | undefined => {
  const caret = name.startsWith("^");
  const bare = caret ? name.slice(1) : name;

  if (!/^[A-Za-z_]+$/.test(bare)) return undefined;
  const value = CATEGORIES.has(bare) || bare === "Any" ? bare : `Script=${bare}`;
  const negated = negatedEscape !== caret;

  if (negated && flags.i && !inClass) return `(?:(?!\\p{${value}})[\\s\\S])`;

  return `\\${negated ? "P" : "p"}{${value}}`;
};

interface Escape {
  /** JavaScript for the escape: class contents inside a class, an atom outside. */
  readonly text: string;
  readonly length: number;
}

/**
 * The escape at `pattern[at]` (a backslash), or `undefined` when RE2 rejects it or it has no translation. `inClass`
 * selects class contents (`0-9`) over atoms (`[0-9]`).
 */
const translateEscape = (
  pattern: string,
  at: number,
  flags: Flags,
  inClass: boolean,
): Escape | undefined => {
  const next = pattern.charAt(at + 1);
  const atom = (contents: string): string => (inClass ? contents : `[${contents}]`);

  if (next === "") return undefined;

  // Octal: `\0`, or one to three octal digits after a non-zero first digit (a lone `\1`–`\9` is a backreference).
  if (/[0-7]/.test(next)) {
    const digits = /^[0-7]{1,3}/.exec(pattern.slice(at + 1))?.[0] ?? next;

    if (next !== "0" && digits.length === 1) return undefined;

    return { text: codePoint(Number.parseInt(digits, 8)), length: 1 + digits.length };
  }

  switch (next) {
    case "8":
    case "9":
    case "k":
    case "C":
    case "Z":
      return undefined;
    case "A":
      return inClass ? undefined : { text: "(?:(?<![\\s\\S]))", length: 2 };
    case "z":
      return inClass ? undefined : { text: "(?:(?![\\s\\S]))", length: 2 };
    case "b":
    case "B":
      // JavaScript's `\b` under `i` also counts `ſ` and `K` as word characters; RE2's is ASCII.
      if (inClass) return undefined;

      return { text: flags.i ? `(?-i:\\${next})` : `(?:\\${next})`, length: 2 };
    case "d":
    case "D":
      return { text: atom(classOf(DIGIT, next === "D", flags)), length: 2 };
    case "s":
    case "S":
      return { text: atom(classOf(SPACE, next === "S", flags)), length: 2 };
    case "w":
    case "W":
      return { text: atom(classOf(WORD, next === "W", flags)), length: 2 };
    case "a":
      return { text: "\\x07", length: 2 };
    case "f":
    case "n":
    case "r":
    case "t":
    case "v":
      return { text: `\\${next}`, length: 2 };
    case "p":
    case "P": {
      const braced = pattern.charAt(at + 2) === "{";
      const close = braced ? pattern.indexOf("}", at + 3) : at + 2;

      if (close < 0 || close >= pattern.length) return undefined;
      const name = braced ? pattern.slice(at + 3, close) : pattern.charAt(at + 2);
      const text = property(name, next === "P", flags, inClass);

      return text === undefined ? undefined : { text, length: close - at + 1 };
    }

    case "x": {
      const braced = /^\{([0-9A-Fa-f]{1,6})\}/.exec(pattern.slice(at + 2));

      if (braced !== null) {
        // SAFETY: the regex has one capture group.
        const cp = Number.parseInt(braced[1] as string, 16);

        return cp > MAX_CODE_POINT
          ? undefined
          : { text: codePoint(cp), length: 2 + braced[0].length };
      }

      return /^[0-9A-Fa-f]{2}/.test(pattern.slice(at + 2))
        ? { text: pattern.slice(at, at + 4), length: 4 }
        : undefined;
    }

    case "Q": {
      // `\Q…\E` (or to the end): every character literally.
      const end = pattern.indexOf("\\E", at + 2);
      const literal = pattern.slice(at + 2, end < 0 ? pattern.length : end);
      const text = Array.from(literal, (ch) => codePoint(ch.codePointAt(0) ?? 0)).join("");

      // Not grouped: a quantifier after `\E` repeats the last character, as in RE2.
      return { text, length: (end < 0 ? pattern.length : end + 2) - at };
    }

    default:
      // RE2 escapes ASCII punctuation only.
      if (!/[!-/:-@[-`{-~]/.test(next)) return undefined;

      return {
        text:
          JS_ESCAPABLE.has(next) || (inClass && next === "-")
            ? `\\${next}`
            : codePoint(next.charCodeAt(0)),
        length: 2,
      };
  }
};

/** A character class starting at `pattern[at]` (`[`), as JavaScript, with its length. */
const translateClass = (
  pattern: string,
  at: number,
  flags: Flags,
): { readonly text: string; readonly length: number } | undefined => {
  let i = at + 1;
  let out = "[";

  if (pattern.charAt(i) === "^") {
    out += "^";
    i++;
  }

  // A leading `]` is a member.
  if (pattern.charAt(i) === "]") {
    out += "\\]";
    i++;
  }

  while (i < pattern.length) {
    const ch = pattern.charAt(i);

    if (ch === "]") return { text: `${out}]`, length: i + 1 - at };

    if (ch === "[" && pattern.charAt(i + 1) === ":") {
      const close = pattern.indexOf(":]", i + 2);

      if (close < 0) return undefined;
      const spec = pattern.slice(i + 2, close);
      const negated = spec.startsWith("^");
      const ranges = POSIX_CLASSES.get(negated ? spec.slice(1) : spec);

      if (ranges === undefined) return undefined;
      out += classOf(ranges, negated, flags);
      i = close + 2;
      continue;
    }

    if (ch === "\\") {
      const escape = translateEscape(pattern, i, flags, true);

      if (escape === undefined) return undefined;
      out += escape.text;
      i += escape.length;
      continue;
    }

    out += ch;
    i++;
  }

  return undefined;
};

const parseFlags = (spec: string, base: Flags): Flags | undefined => {
  const [on = "", off, ...rest] = spec.split("-");

  if (rest.length > 0 || (on === "" && (off ?? "") === "") || off === "") return undefined;
  const flags: MutableFlags = { ...base };

  for (const [letters, value] of [
    [on, true],
    [off ?? "", false],
  ] as const) {
    for (const letter of letters) {
      if (letter !== "i" && letter !== "m" && letter !== "s" && letter !== "U") return undefined;
      flags[letter] = value;
    }
  }

  return flags;
};

const caseGroup = (from: Flags, to: Flags): string =>
  from.i === to.i ? "" : to.i ? "(?i:" : "(?-i:";

/**
 * Translates a Go RE2 pattern to a global Unicode JavaScript `RegExp`; `undefined` when the pattern is empty or RE2
 * would reject it (Go skips such entries with a warning).
 */
export const compileGoRegex = (pattern: string): RegExp | undefined => {
  if (pattern === "") return undefined;
  const top: Frame = { flags: { i: false, m: false, s: false, U: false }, implicit: [] };
  const stack: Frame[] = [top];
  let frame = top;
  let out = "";
  let i = 0;
  // Whether a quantifier may follow (it needs an atom before it).
  let quantifiable = false;

  const closeImplicit = (): string => ")".repeat(frame.implicit.length);

  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    const flags = frame.flags;

    if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
      const repeat = ch === "{" ? /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i)) : null;

      if (ch === "{" && repeat === null) {
        // Not a repeat: RE2 reads a literal `{`.
        out += "\\{";
        i++;
        quantifiable = true;
        continue;
      }

      if (!quantifiable) return undefined;

      if (repeat !== null && Math.max(Number(repeat[1]), Number(repeat[3] ?? 0)) > MAX_REPEAT)
        return undefined;
      const length = repeat === null ? 1 : repeat[0].length;
      const lazy = pattern.charAt(i + length) === "?";
      // `(?U)` swaps greedy and lazy.
      out += pattern.slice(i, i + length) + (lazy !== flags.U ? "?" : "");
      i += length + (lazy ? 1 : 0);
      quantifiable = false;
      continue;
    }

    if (ch === "(") {
      const rest = pattern.slice(i);

      if (/^\(\?(?:[=!]|<[=!])/.test(rest)) return undefined;
      const named = /^\(\?P?<([A-Za-z0-9_]+)>/.exec(rest);
      const flagGroup = /^\(\?([A-Za-z-]*)([:)])/.exec(rest);
      let opened: string;
      let flagsInside = flags;

      if (named !== null) {
        opened = `(?<${named[1]}>`;
        i += named[0].length;
      } else if (rest.startsWith("(?:")) {
        opened = "(?:";
        i += 3;
      } else if (flagGroup !== null) {
        // SAFETY: the regex has two capture groups.
        const next = parseFlags(flagGroup[1] as string, flags);

        if (next === undefined) return undefined;
        i += flagGroup[0].length;

        if (flagGroup[2] === ")") {
          // `(?flags)`: the rest of the enclosing group.
          const group = caseGroup(flags, next);

          if (group !== "") frame.implicit.push(group);
          out += group;
          frame.flags = next;
          quantifiable = false;
          continue;
        }

        opened = caseGroup(flags, next) || "(?:";
        flagsInside = next;
      } else if (rest.startsWith("(?")) {
        return undefined;
      } else {
        opened = "(";
        i++;
      }

      frame = { flags: flagsInside, implicit: [] };
      stack.push(frame);
      out += opened;
      quantifiable = false;
      continue;
    }

    if (ch === ")") {
      if (stack.length === 1) return undefined;
      out += `${closeImplicit()})`;
      stack.pop();
      // SAFETY: the top frame is never popped.
      frame = stack.at(-1) as Frame;
      i++;
      quantifiable = true;
      continue;
    }

    if (ch === "|") {
      // Flags set by `(?flags)` still hold after `|`: close their groups around the bar and reopen them.
      out += `${closeImplicit()}|${frame.implicit.join("")}`;
      i++;
      quantifiable = false;
      continue;
    }

    if (ch === "[") {
      const translated = translateClass(pattern, i, flags);

      if (translated === undefined) return undefined;
      out += translated.text;
      i += translated.length;
      quantifiable = true;
      continue;
    }

    if (ch === "\\") {
      const escape = translateEscape(pattern, i, flags, false);

      if (escape === undefined) return undefined;
      out += escape.text;
      i += escape.length;
      quantifiable = true;
      continue;
    }

    // Assertions are grouped: RE2 accepts a quantifier after them (`^*`), JavaScript only after a group.
    if (ch === ".") out += flags.s ? "[\\s\\S]" : "[^\\n]";
    else if (ch === "^") out += flags.m ? "(?:(?<![^\\n]))" : "(?:^)";
    else if (ch === "$") out += flags.m ? "(?:(?![^\\n]))" : "(?:$)";
    else if (ch === "}") out += "\\}";
    else if (ch === "]") out += "\\]";
    else out += ch;

    quantifiable = true;
    i++;
  }

  if (stack.length !== 1) return undefined;
  out += closeImplicit();

  try {
    return new RegExp(out, "gu");
  } catch {
    return undefined;
  }
};

/** `Regexp.Expand` over a JavaScript match: `$name`/`${name}` (number or group name), `$$`; malformed `$` is literal. */
export const expandGoTemplate = (template: string, match: RegExpExecArray): string => {
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

/**
 * `Regexp.FindAllStringSubmatchIndex(text, -1)`: every match of a {@link compileGoRegex} pattern at Go's search
 * positions, so an empty match right after a match is skipped and an empty match advances one character.
 */
export const findAllGo = (re: RegExp, text: string): RegExpExecArray[] => {
  const out: RegExpExecArray[] = [];
  let pos = 0;
  let prevMatchEnd = -1;

  while (pos <= text.length) {
    re.lastIndex = pos;
    const match = re.exec(text);

    if (match === null) break;
    const end = match.index + match[0].length;
    let accept = true;

    if (end === pos) {
      // An empty match: not right after the previous match, and the search moves on one character.
      if (match.index === prevMatchEnd) accept = false;
      pos += pos < text.length ? ((text.codePointAt(pos) ?? 0) > 0xffff ? 2 : 1) : 1;
    } else {
      pos = end;
    }

    prevMatchEnd = end;

    if (accept) out.push(match);
  }

  return out;
};

/**
 * `Regexp.ReplaceAllString`: every match of {@link findAllGo} replaced by the expanded template (an empty match right
 * after a match is not replaced, as in Go).
 */
export const replaceAllGo = (re: RegExp, text: string, template: string): string => {
  let out = "";
  let last = 0;

  for (const match of findAllGo(re, text)) {
    out += text.slice(last, match.index) + expandGoTemplate(template, match);
    last = match.index + match[0].length;
  }

  return out + text.slice(last);
};
