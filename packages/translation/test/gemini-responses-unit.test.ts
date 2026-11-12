// Unit tests for the Gemini Responses translator pieces that golden fixtures cannot cover (process-wide replay cache,
// carrier encoding, injected clocks).
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Json } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";
import { sig } from "./support/gemini-signatures.ts";
import {
  CARRIER_PREVIOUS,
  CARRIER_TEXT,
  decodeCarrier,
  encodeCarrier,
} from "../src/translator/gemini/openai/responses/carrier.ts";
import {
  makeMemoryReplayCache,
  REPLAY_CACHE_MAX_ENTRIES,
  REPLAY_CACHE_TTL_MS,
  replayCache,
  setReplayCache,
} from "../src/translator/gemini/openai/responses/replay-cache.ts";

const MODEL = "gemini-2.5-pro";

const SIGNATURE = sig();

describe("replay cache", () => {
  it("expires entries after the ttl and evicts the oldest beyond the limit", () => {
    let now = 1000;
    const cache = makeMemoryReplayCache(() => now);
    expect(cache.set("m", "k", [{ a: 1 }])).toBe(true);
    expect(cache.get("m", "k")).toEqual([{ a: 1 }]);
    now += REPLAY_CACHE_TTL_MS + 1;
    expect(cache.get("m", "k")).toBeUndefined();
    expect(cache.set("", "k", [{ a: 1 }])).toBe(false);
    expect(cache.set("m", "k", [])).toBe(false);

    for (let i = 0; i <= REPLAY_CACHE_MAX_ENTRIES; i++) cache.set("m", `key-${i}`, [{ i }]);
    expect(cache.size()).toBe(REPLAY_CACHE_MAX_ENTRIES);
    expect(cache.get("m", "key-0")).toBeUndefined();
    expect(cache.get("m", `key-${REPLAY_CACHE_MAX_ENTRIES}`)).toEqual([
      { i: REPLAY_CACHE_MAX_ENTRIES },
    ]);
  });

  it("returns private copies", () => {
    const cache = makeMemoryReplayCache();
    const items: Json[] = [{ a: { b: 1 } }];
    cache.set("m", "k", items);
    (items[0] as { a: { b: number } }).a.b = 2;

    const first = cache.get("m", "k") as Json[];

    (first[0] as { a: { b: number } }).a.b = 3;
    expect(cache.get("m", "k")).toEqual([{ a: { b: 1 } }]);
  });
});

describe("signature carriers", () => {
  it("round-trips and rejects malformed markers", () => {
    const encoded = encodeCarrier(SIGNATURE, CARRIER_PREVIOUS, CARRIER_TEXT);
    expect(decodeCarrier(encoded)).toMatchObject({
      signature: SIGNATURE,
      direction: CARRIER_PREVIOUS,
      targetKind: CARRIER_TEXT,
      marked: true,
      ok: true,
    });
    expect(decodeCarrier(SIGNATURE)).toMatchObject({
      marked: false,
      ok: true,
      signature: SIGNATURE,
    });
    expect(decodeCarrier("cpa-gemini-responses-carrier-v1:sideways:text:QUJD")).toMatchObject({
      marked: true,
      ok: false,
    });
    expect(decodeCarrier("cpa-gemini-responses-carrier-v1:next:text:QUJD=")).toMatchObject({
      marked: true,
      ok: false,
    });
    expect(encodeCarrier("  ", "next", "text")).toBe("");
  });
});

const chunk = (parts: Json[], finish?: string): string =>
  JSON.stringify({
    candidates: [
      {
        content: { role: "model", parts },
        index: 0,
        ...(finish === undefined ? {} : { finishReason: finish }),
      },
    ],
    responseId: "r1",
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  });

describe("trailing text signatures", () => {
  let previous = replayCache();
  beforeEach(() => {
    previous = replayCache();
    setReplayCache(makeMemoryReplayCache());
  });
  afterEach(() => setReplayCache(previous));

  it("keeps a trailing signature off the timeline and restores it on the next request", () => {
    const request = { model: "gpt-5", input: "hi" };

    const envelope = builtinTranslators.translateRequest("openai-response", "gemini", {
      format: "openai-response",
      model: MODEL,
      stream: true,
      body: request,
    });

    const context = {
      model: MODEL,
      originalRequest: request,
      translatedRequest: envelope.body,
      state: makeTranslationState(),
    };

    const chunks = [
      chunk([{ text: "answer" }]),
      chunk([{ text: "", thoughtSignature: SIGNATURE }], "STOP"),
      "[DONE]",
    ]
      .flatMap((line) =>
        builtinTranslators.translateStream("openai-response", "gemini", context, line),
      )
      .join("");

    expect(chunks).not.toContain("cpa-gemini-responses-carrier");
    expect(replayCache().get(MODEL, "gemini-responses-text:msg_resp_r1_0")).toHaveLength(1);

    const next = builtinTranslators.translateRequest("openai-response", "gemini", {
      format: "openai-response",
      model: MODEL,
      stream: false,
      body: {
        model: "gpt-5",
        input: [
          { role: "user", content: "hi" },
          {
            type: "message",
            id: "msg_resp_r1_0",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
          { role: "user", content: "more" },
        ],
      },
    });

    const parts = (
      next.body as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }
    ).contents.flatMap((content) => content.parts);

    expect(parts).toContainEqual({ text: "answer", thoughtSignature: SIGNATURE });
  });
});
