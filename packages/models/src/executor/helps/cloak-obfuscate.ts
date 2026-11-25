/**
 * Sensitive words, literal replacements and RE2 pattern replacements for the requests of Claude (cloaked), Antigravity
 * (system instruction) and Devin (system prompt): one matcher the three executors share.
 *
 * Go source: internal/runtime/executor/helps/cloak_obfuscate.go (BuildSensitiveWordMatcherWithPatterns,
 * BuildAntigravitySensitiveWordMatcherWithPatterns, obfuscateWord, obfuscateAntigravityPhrase, collectPatternSpans,
 * obfuscateText, Matches, SanitizeDevinText, ObfuscateSensitiveWordsDoc, ObfuscateSensitiveWordsInSystemInstructionDoc,
 * SensitiveWordConfigCacheKeyWithPatterns).
 *
 * One pass, never cascading: the pattern rules apply in order to the original text (a later rule's match that
 * overlaps an earlier rule's is skipped), and the literal words and replacements, longest first, apply to the text
 * between the pattern matches. A replacement's output is never scanned again. A word without a replacement is
 * obfuscated: a zero-width space (U+200B) after its first character, or for Antigravity a combining grapheme joiner
 * (U+034F) after the first character of each of its letter-and-digit runs, the one mark Antigravity accepts.
 */
import { type Json, type JsonObject, get, isJsonArray, isJsonObject, set } from "@commissary/json";
import { isArr, isObj, str } from "@commissary/translation";
import type { SensitivePatternRule } from "@commissary/contract/provider-keys";
import { compileGoRegex, expandGoTemplate, findAllGo } from "../../config/payload/re2.ts";
import { normalizeSensitiveWordsReplace } from "../../config/normalize.ts";

export type { SensitivePatternRule };

/** What a matcher is built from: the provider's (or the credential's) three settings. */
export interface SensitiveWordSettings {
  readonly words: ReadonlyArray<string>;
  readonly replacements?: Readonly<Record<string, string>>;
  readonly patterns?: ReadonlyArray<SensitivePatternRule>;
}

const ZERO_WIDTH_SPACE = "\u200B";

const COMBINING_GRAPHEME_JOINER = "\u034F";

interface WordRule {
  readonly target: string;
  readonly lowerTarget: string;
  readonly replacement: string;
  readonly isReplacement: boolean;
}

interface PatternRule {
  readonly regex: RegExp;
  readonly replacement: string;
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/** The first character (code point) of `text`. */
const firstCodePoint = (text: string): string => String.fromCodePoint(text.codePointAt(0) ?? 0);

const runeCount = (text: string): number => Array.from(text).length;

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** `obfuscateWord`: a zero-width space after the first character; a single character stays as it is. */
const obfuscateWord = (word: string): string => {
  if (word === "" || word.includes(ZERO_WIDTH_SPACE)) return word;
  const first = firstCodePoint(word);

  return first.length >= word.length ? word : first + ZERO_WIDTH_SPACE + word.slice(first.length);
};

/** `isAntigravitySubwordRune`: a letter, a decimal digit, or one of the two marks. */
const SUBWORD_RUNE = /^[\p{L}\p{Nd}\u{34F}\u{200B}]$/u;

/** `obfuscateSingleSubwordCGJ`: the joiner after the first character; whether the subword holds one now. */
const obfuscateSubword = (subword: string): readonly [string, boolean] => {
  if (subword.includes(COMBINING_GRAPHEME_JOINER)) return [subword, true];
  const first = firstCodePoint(subword);

  if (first.length >= subword.length) return [subword, false];

  return [first + COMBINING_GRAPHEME_JOINER + subword.slice(first.length), true];
};

/**
 * `obfuscateAntigravityPhrase`: U+034F after the first character of every letter-and-digit run of two characters or
 * more, punctuation and spaces kept; a phrase without such a run gets it after its first character.
 */
const obfuscateAntigravityPhrase = (phrase: string): string => {
  if (phrase === "" || phrase.includes(COMBINING_GRAPHEME_JOINER)) return phrase;
  let out = "";
  let subword = "";
  let inserted = false;

  const flush = () => {
    if (subword === "") return;
    const [obfuscated, did] = obfuscateSubword(subword);

    out += obfuscated;
    inserted ||= did;
    subword = "";
  };

  for (const ch of phrase) {
    if (SUBWORD_RUNE.test(ch)) {
      subword += ch;
      continue;
    }

    flush();
    out += ch;
  }

  flush();

  if (inserted) return out;
  const first = firstCodePoint(phrase);

  return first.length >= phrase.length
    ? phrase
    : first + COMBINING_GRAPHEME_JOINER + phrase.slice(first.length);
};

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `sortRulesLongestFirst`: more characters, then more bytes, then replacements, then by lower-cased target. */
const longestFirst = (a: WordRule, b: WordRule): number =>
  runeCount(b.target) - runeCount(a.target) ||
  utf8Length(b.target) - utf8Length(a.target) ||
  Number(b.isReplacement) - Number(a.isReplacement) ||
  (a.lowerTarget < b.lowerTarget ? -1 : a.lowerTarget > b.lowerTarget ? 1 : 0);

/** Whether two spans overlap; an empty span overlaps a span it touches. */
const spansOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => {
  if (aStart === aEnd) return bStart <= aStart && aStart <= bEnd;

  if (bStart === bEnd) return aStart <= bStart && bStart <= aEnd;

  return aStart < bEnd && bStart < aEnd;
};

export class SensitiveWordMatcher {
  constructor(
    /** The words and replacement targets, longest first, case-insensitive (`undefined`: none). */
    private readonly literal: RegExp | undefined,
    /** The replacement of a matched target (`undefined`: a sensitive word without one). */
    private readonly lookupReplacement: (matched: string) => string | undefined,
    private readonly obfuscateWordFn: (word: string) => string,
    private readonly patternRules: ReadonlyArray<PatternRule>,
  ) {}

  /** `ObfuscateText`: the pattern replacements, then the literal replacements and obfuscated words between them. */
  obfuscate(text: string): string {
    if (text === "") return text;
    const spans = this.patternSpans(text);

    if (spans.length === 0) return this.obfuscateLiterals(text);
    let out = "";
    let last = 0;

    for (const span of spans) {
      if (span.start > last) out += this.obfuscateLiterals(text.slice(last, span.start));
      out += span.replacement;
      last = span.end;
    }

    return last < text.length ? out + this.obfuscateLiterals(text.slice(last)) : out;
  }

  /**
   * `SanitizeDevinText`: the pattern and literal replacements in one pass, and every original line holding a
   * sensitive word without a replacement dropped (with any replacement on it); the result trimmed.
   */
  sanitizeDevinText(text: string): string {
    if (text === "") return text;

    type Op =
      | { readonly kind: "text"; readonly start: number; readonly end: number }
      | {
          readonly kind: "replacement";
          readonly start: number;
          readonly end: number;
          readonly replacement: string;
        }
      | { readonly kind: "word"; readonly start: number; readonly end: number };

    const ops: Op[] = [];

    const gap = (start: number, end: number) => {
      if (start >= end) return;

      if (this.literal === undefined) {
        ops.push({ kind: "text", start, end });

        return;
      }

      let last = start;

      for (const match of text.slice(start, end).matchAll(this.literal)) {
        const from = start + match.index;
        const to = from + match[0].length;

        if (from > last) ops.push({ kind: "text", start: last, end: from });
        const replacement = this.lookupReplacement(match[0]);

        ops.push(
          replacement === undefined
            ? { kind: "word", start: from, end: to }
            : { kind: "replacement", start: from, end: to, replacement },
        );
        last = to;
      }

      if (last < end) ops.push({ kind: "text", start: last, end });
    };

    let last = 0;

    for (const span of this.patternSpans(text)) {
      gap(last, span.start);
      ops.push({ kind: "replacement", ...span });
      last = span.end;
    }

    gap(last, text.length);

    // Line boundaries of the original text: a replacement never adds a line, and drops follow the original lines.
    const lineStarts = [0];

    for (let i = 0; i < text.length; i++) if (text.charAt(i) === "\n") lineStarts.push(i + 1);

    const lineOf = (pos: number): number => {
      let lo = 0;
      let hi = lineStarts.length;

      // The last line whose start is at or before `pos`.
      while (lo < hi) {
        const mid = (lo + hi) >> 1;

        if ((lineStarts[mid] ?? 0) > pos) hi = mid;
        else lo = mid + 1;
      }

      return Math.max(0, lo - 1);
    };

    const dropped = Array.from(lineStarts, () => false);

    for (const op of ops) {
      if (op.kind !== "word" || op.end <= op.start) continue;

      for (let line = lineOf(op.start); line <= lineOf(op.end - 1); line++) dropped[line] = true;
    }

    let out = "";

    for (const op of ops) {
      if (op.kind === "word") continue;

      if (op.kind === "replacement") {
        if (op.replacement === "") continue;
        const first = lineOf(op.start);
        const lastLine = op.end > op.start ? lineOf(op.end - 1) : first;
        let keep = true;

        for (let line = first; line <= lastLine; line++) if (dropped[line] === true) keep = false;

        if (keep) out += op.replacement;
        continue;
      }

      let segment = text.slice(op.start, op.end);
      let line = lineOf(op.start);

      while (segment !== "") {
        const newline = segment.indexOf("\n");

        if (newline < 0) {
          if (dropped[line] !== true) out += segment;
          break;
        }

        if (dropped[line] !== true) out += segment.slice(0, newline + 1);
        segment = segment.slice(newline + 1);
        line++;
      }
    }

    return out.trim();
  }

  private obfuscateLiterals(text: string): string {
    if (this.literal === undefined || text === "") return text;

    return text.replace(
      this.literal,
      (matched) => this.lookupReplacement(matched) ?? this.obfuscateWordFn(matched),
    );
  }

  /** `collectPatternSpans`: the accepted matches of the pattern rules in text order, earlier rules first. */
  private patternSpans(text: string): Span[] {
    if (this.patternRules.length === 0 || text === "") return [];
    let spans: Span[] = [];

    for (const rule of this.patternRules) {
      const found = findAllGo(rule.regex, text).flatMap((match): Span[] => {
        const start = match.index;
        const end = start + match[0].length;
        const replacement = expandGoTemplate(rule.replacement, match);

        // An empty match that inserts nothing changes nothing.
        return start === end && replacement === "" ? [] : [{ start, end, replacement }];
      });

      if (found.length === 0) continue;

      if (spans.length === 0) {
        spans = found;
        continue;
      }

      const accepted: Span[] = [];
      const subsumed = Array.from(spans, () => false);
      let cursor = 0;

      for (const { start, end, replacement } of found) {
        // Skip the earlier spans that end before this match.
        while (cursor < spans.length) {
          const earlier = spans[cursor];

          if (
            earlier !== undefined &&
            (earlier.end < start ||
              (earlier.end === start && earlier.start < earlier.end && start < end))
          ) {
            cursor++;
            continue;
          }

          break;
        }

        let conflict = false;
        const covered: number[] = [];

        for (let j = cursor; j < spans.length; j++) {
          const earlier = spans[j];

          if (earlier === undefined || subsumed[j] === true) continue;

          if (
            earlier.start > end ||
            (earlier.start === end && earlier.start < earlier.end && start < end)
          )
            break;

          if (!spansOverlap(start, end, earlier.start, earlier.end)) continue;

          // A deletion that covers earlier deletions takes their place.
          if (
            replacement === "" &&
            earlier.replacement === "" &&
            start <= earlier.start &&
            earlier.end <= end
          ) {
            covered.push(j);
            continue;
          }

          conflict = true;
          break;
        }

        if (conflict) continue;

        for (const j of covered) subsumed[j] = true;
        accepted.push({ start, end, replacement });
      }

      if (accepted.length === 0) continue;
      const kept = spans.filter((_, index) => subsumed[index] !== true);
      const merged: Span[] = [];
      let si = 0;
      let ai = 0;

      while (si < kept.length && ai < accepted.length) {
        // SAFETY: `si` is below `kept.length` (loop condition).
        const a = kept[si] as Span;
        // SAFETY: `ai` is below `accepted.length` (loop condition).
        const b = accepted[ai] as Span;

        if (a.start < b.start || (a.start === b.start && a.end <= b.end)) {
          merged.push(a);
          si++;
        } else {
          merged.push(b);
          ai++;
        }
      }

      spans = [...merged, ...kept.slice(si), ...accepted.slice(ai)];
    }

    return spans;
  }
}

const build = (
  settings: SensitiveWordSettings,
  obfuscateFn: (word: string) => string,
  marker: string,
): SensitiveWordMatcher | undefined => {
  // Targets trimmed, blank ones dropped, a target written without surrounding space winning (as the config stores them).
  const replacements = normalizeSensitiveWordsReplace(settings.replacements ?? {});

  const patternRules = (settings.patterns ?? []).flatMap((rule): PatternRule[] => {
    // An invalid pattern is skipped (the config normaliser already drops it).
    const regex = rule.pattern.trim() === "" ? undefined : compileGoRegex(rule.pattern);

    return regex === undefined ? [] : [{ regex, replacement: rule.replacement ?? "" }];
  });

  const rules: WordRule[] = [];
  const replacementRules: WordRule[] = [];
  const exact = new Map<string, string>();
  const lower = new Map<string, string>();
  const seen = new Set<string>();

  for (const [target, replacement] of Object.entries(replacements)) {
    exact.set(target, replacement);
    const lowerTarget = target.toLowerCase();

    if (!lower.has(lowerTarget)) lower.set(lowerTarget, replacement);

    if (seen.has(lowerTarget)) continue;
    seen.add(lowerTarget);
    const rule = { target, lowerTarget, replacement, isReplacement: true };

    rules.push(rule);
    replacementRules.push(rule);
  }

  for (const rawWord of settings.words) {
    const word = rawWord.trim();

    if (runeCount(word) < 2 || word.includes(marker) || obfuscateFn(word) === word) continue;
    const lowerTarget = word.toLowerCase();

    if (seen.has(lowerTarget)) continue;
    seen.add(lowerTarget);
    rules.push({ target: word, lowerTarget, replacement: "", isReplacement: false });
  }

  if (rules.length === 0 && patternRules.length === 0) return undefined;
  rules.sort(longestFirst);
  replacementRules.sort(longestFirst);

  const literal =
    rules.length === 0
      ? undefined
      : new RegExp(rules.map((rule) => escapeRegex(rule.target)).join("|"), "giu");

  const lookupReplacement = (matched: string): string | undefined => {
    if (exact.size === 0) return undefined;
    const found = exact.get(matched) ?? lower.get(matched.toLowerCase());

    if (found !== undefined) return found;
    // `strings.EqualFold` over the targets, for a match whose lower case differs from its target's.
    const upper = matched.toUpperCase();

    return replacementRules.find((rule) => rule.target.toUpperCase() === upper)?.replacement;
  };

  return new SensitiveWordMatcher(literal, lookupReplacement, obfuscateFn, patternRules);
};

/** `SensitiveWordConfigCacheKeyWithPatterns`: an unambiguous key of the settings. */
const cacheKey = (kind: string, settings: SensitiveWordSettings): string =>
  JSON.stringify([
    kind,
    settings.words,
    Object.entries(settings.replacements ?? {}).toSorted(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
    (settings.patterns ?? []).map((rule) => [rule.pattern, rule.replacement ?? ""]),
  ]);

const CACHE_CAPACITY = 1024;

const cache = new Map<string, SensitiveWordMatcher | undefined>();

const cached = (
  kind: "default" | "antigravity",
  settings: SensitiveWordSettings,
): SensitiveWordMatcher | undefined => {
  if (
    settings.words.length === 0 &&
    Object.keys(settings.replacements ?? {}).length === 0 &&
    (settings.patterns ?? []).length === 0
  )
    return undefined;
  const key = cacheKey(kind, settings);

  if (cache.has(key)) {
    const hit = cache.get(key);

    // Least recently used first out: a hit moves to the back.
    cache.delete(key);
    cache.set(key, hit);

    return hit;
  }

  if (cache.size >= CACHE_CAPACITY) {
    const oldest = cache.keys().next();

    if (oldest.done !== true) cache.delete(oldest.value);
  }

  const built =
    kind === "antigravity"
      ? build(settings, obfuscateAntigravityPhrase, COMBINING_GRAPHEME_JOINER)
      : build(settings, obfuscateWord, ZERO_WIDTH_SPACE);

  cache.set(key, built);

  return built;
};

/**
 * `BuildSensitiveWordMatcherWithPatterns` (Claude, Devin): words obfuscated with U+200B; `undefined` when nothing
 * usable is configured. Matchers are cached by their settings.
 */
export const buildSensitiveWordMatcher = (
  settings: SensitiveWordSettings,
): SensitiveWordMatcher | undefined => cached("default", settings);

/** `BuildAntigravitySensitiveWordMatcherWithPatterns`: words obfuscated with U+034F in every letter-and-digit run. */
export const buildAntigravitySensitiveWordMatcher = (
  settings: SensitiveWordSettings,
): SensitiveWordMatcher | undefined => cached("antigravity", settings);

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

/** A text block's `text`, rewritten by the matcher. */
const obfuscateTextBlock = (block: JsonObject, matcher: SensitiveWordMatcher): void => {
  const text = str(block.text);
  const obfuscated = matcher.obfuscate(text);

  if (obfuscated !== text) block.text = obfuscated;
};

/** `ObfuscateSensitiveWordsDoc`: the text system blocks (not the billing header) and message text of a Claude body. */
export const obfuscateSensitiveWords = (body: JsonObject, matcher: SensitiveWordMatcher): void => {
  const system = body.system;

  if (isArr(system)) {
    for (const block of system) {
      if (
        isObj(block) &&
        str(block.type) === "text" &&
        !str(block.text).startsWith(BILLING_HEADER_PREFIX)
      )
        obfuscateTextBlock(block, matcher);
    }
  } else if (typeof system === "string" && !system.startsWith(BILLING_HEADER_PREFIX)) {
    body.system = matcher.obfuscate(system);
  }

  if (!isArr(body.messages)) return;

  for (const message of body.messages) {
    if (!isObj(message)) continue;

    if (typeof message.content === "string") message.content = matcher.obfuscate(message.content);
    else if (isArr(message.content)) {
      for (const block of message.content)
        if (isObj(block) && str(block.type) === "text") obfuscateTextBlock(block, matcher);
    }
  }
};

/** `ObfuscateSensitiveWordsInSystemInstructionDoc`: the system instruction of an Antigravity request, text or parts. */
export const obfuscateSystemInstruction = (body: Json, matcher: SensitiveWordMatcher): Json => {
  for (const path of ["request.systemInstruction", "request.system_instruction"]) {
    const instruction = get(body, path);

    if (instruction === undefined) continue;

    if (typeof instruction === "string") {
      const text = matcher.obfuscate(instruction);

      if (text !== instruction) set(body, path, text);
      continue;
    }

    const parts = get(instruction, "parts");

    if (!isJsonArray(parts)) continue;

    for (const part of parts) {
      if (!isJsonObject(part) || typeof part["text"] !== "string") continue;
      const text = matcher.obfuscate(part["text"]);

      if (text !== part["text"]) part["text"] = text;
    }
  }

  return body;
};
