/**
 * The harness of the golden translator fixtures (`go run ./tools/fixturegen/translator`): translation's own cases
 * (`test/fixtures/translator/`) and the Worker's executor-rewrite cases run through it. Outputs compare structurally
 * (Go's key order and HTML escaping are not part of the contract); SSE framing and non-JSON text stay exact.
 */
import { expect, it } from "vitest";
import type { Json } from "@commissary/json";
import { builtinTranslators } from "../../src/translator/builtin.ts";
import { makeTranslationState, type RequestEnvelope } from "../../src/translator/registry.ts";
import { expandEmbeddedJson } from "./structural.ts";

export interface TranslatorFixtureCase {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly model: string;
  readonly stream: boolean;
  readonly needs?: ReadonlyArray<string>;
  readonly alt?: string;
  /** Executor-level context (compat request variants, Codex multi-agent v2 / orphan delegation rewriting). */
  readonly executor?: {
    readonly headers?: Record<string, string>;
    readonly compat?: boolean;
    readonly optimizeMultiAgentV2?: boolean;
    readonly orphanDelegation?: boolean;
  };
  readonly request: Json;
  readonly responseLines?: ReadonlyArray<string>;
  readonly responseBodyText?: string;
  readonly tokenCount?: number;
  readonly tokenCountUsage?: Json;
  readonly translatedRequest: string;
  readonly requestError?: string;
  readonly streamOutputs?: ReadonlyArray<ReadonlyArray<string>>;
  readonly nonStreamOutput?: string;
  readonly tokenCountOutput?: string;
}

/**
 * Capabilities implemented on the TypeScript side. Cases that need anything else are skipped (e.g. the thinking
 * slice adds "thinking-summary" once the summary hooks are wired into the registry).
 */
const SUPPORTED_NEEDS = new Set<string>(["thinking-summary"]);

/** The `needs` of `c` that are not implemented: the case is skipped while any is left. */
const missingNeeds = (c: TranslatorFixtureCase): ReadonlyArray<string> =>
  (c.needs ?? []).filter((need) => !SUPPORTED_NEEDS.has(need));

/** Wall-clock fields the Go translators stamp with `time.Now()`; their values cannot match across runs. */
const normalizeClock = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(normalizeClock);

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        (key === "created" || key === "created_at" || key === "completed_at") &&
        typeof item === "number" &&
        item > 1e9
          ? 0
          : (key === "createTime" || key === "created" || key === "updated") &&
              typeof item === "string" &&
              /^\d{4}-\d\d-\d\dT/.test(item)
            ? "<time>"
            : typeof item === "string" && /^(interaction|msg)_\d{15,}$/.test(item)
              ? item.replace(/\d+$/, "<n>")
              : normalizeClock(item),
      ]),
    );
  }

  return value;
};

const parseJson = (text: string): Json | undefined => {
  try {
    return expandEmbeddedJson(normalizeClock(JSON.parse(text)));
  } catch {
    return undefined;
  }
};

/**
 * Parses the JSON payload so the comparison is structural (Go's key order and HTML escaping are not part of the
 * contract), while SSE framing (`event:` / `data:` lines, blank-line separators) and non-JSON text stay exact.
 */
const normalizeChunk = (text: string): Json => {
  const whole = parseJson(text);

  if (whole !== undefined) return { json: whole };

  return text.split("\n").map((line) => {
    if (!line.startsWith("data:")) return line;
    const json = parseJson(line.slice(5).trim());

    return json === undefined ? line : { data: json };
  });
};

const ITEM_ID_PREFIX = /item_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(\d+)/g;

/**
 * The fallback item ids of the Interactions provider carry a random per-response prefix (`item_<uuid>_<index>`): masked
 * on both sides, so the ids compare by their index.
 */
const maskItemIdPrefix = (chunk: string): string =>
  chunk.replace(ITEM_ID_PREFIX, "item_<prefix>_$2");

/** The distinct per-response prefixes of the fallback item ids in the chunks. */
const itemIdPrefixes = (chunks: ReadonlyArray<string>): Set<string> =>
  new Set(
    chunks.flatMap((chunk) => [...chunk.matchAll(ITEM_ID_PREFIX)].map((match) => match[1] ?? "")),
  );

/**
 * Runs one case: `translateRequest` translates the request (the registry, or the Worker's executor-level rewrites),
 * the built-in translators the responses and token counts.
 */
const checkTranslatorFixture = (
  c: TranslatorFixtureCase,
  translateRequest: (c: TranslatorFixtureCase, envelope: RequestEnvelope) => RequestEnvelope,
): void => {
  const requestEnvelope = {
    format: c.from,
    model: c.model,
    stream: c.stream,
    body: structuredClone(c.request),
  };

  const envelope = translateRequest(c, requestEnvelope);

  expect(envelope.error?.message).toBe(c.requestError);
  expect(expandEmbeddedJson(envelope.body)).toEqual(parseJson(c.translatedRequest));

  if (c.responseLines !== undefined) {
    const context = {
      model: c.model,
      originalRequest: c.request,
      translatedRequest: envelope.body,
      // The Go corpus runs the raw translators; the Claude input token estimate has its own fixtures.
      state: { ...makeTranslationState(), claudeInputTokensHandled: true },
      ...(c.alt !== undefined ? { alt: c.alt } : {}),
    };

    const raw = c.responseLines.map((line) =>
      builtinTranslators.translateStream(c.from, c.to, context, line),
    );

    // One stream, one prefix: every fallback id of a response shares it, as in the golden.
    if (c.to === "interactions") {
      const golden = itemIdPrefixes((c.streamOutputs ?? []).flat());

      expect(golden.size).toBeLessThanOrEqual(1);
      expect(itemIdPrefixes(raw.flat()).size).toBe(golden.size);
    }

    const outputs = raw.map((chunks) =>
      chunks.map((chunk) => normalizeChunk(maskItemIdPrefix(chunk))),
    );

    const expectedOutputs = (c.streamOutputs ?? []).map((chunks) =>
      chunks.map((chunk) => normalizeChunk(maskItemIdPrefix(chunk))),
    );

    expect(outputs).toEqual(expectedOutputs);
  }

  if (c.responseBodyText !== undefined) {
    const context = {
      model: c.model,
      originalRequest: c.request,
      translatedRequest: envelope.body,
      state: makeTranslationState(),
      ...(c.alt !== undefined ? { alt: c.alt } : {}),
    };

    const out = builtinTranslators.translateNonStream(c.from, c.to, context, c.responseBodyText);

    expect(out === undefined ? undefined : normalizeChunk(out)).toEqual(
      c.nonStreamOutput === undefined ? undefined : normalizeChunk(c.nonStreamOutput),
    );
  }

  if (c.tokenCount !== undefined) {
    const out = builtinTranslators.translateTokenCount(
      c.from,
      c.to,
      c.tokenCount,
      JSON.stringify(c.tokenCountUsage ?? null),
    );

    expect(normalizeChunk(out)).toEqual(normalizeChunk(c.tokenCountOutput ?? ""));
  }
};

/** Declares the test of one case, skipped (with the missing `needs` in its name) until its capabilities land. */
export const itTranslatorFixture = (
  c: TranslatorFixtureCase,
  translateRequest: (c: TranslatorFixtureCase, envelope: RequestEnvelope) => RequestEnvelope,
): void => {
  const missing = missingNeeds(c);

  if (missing.length > 0) {
    it.skip(`${c.name} (needs ${missing.join(", ")})`, () =>
      checkTranslatorFixture(c, translateRequest));

    return;
  }

  it(c.name, () => checkTranslatorFixture(c, translateRequest));
};
