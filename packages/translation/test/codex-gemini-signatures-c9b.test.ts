// C9 PR B (Go 88ac14f3, a4660260, 674dbe8f, a68c7d8e): reasoning signatures through the Gemini protocol. A Codex
// (Responses) reasoning `encrypted_content` travels to a Gemini client as a `thoughtSignature` in the
// `cpa-codex-gemini-carrier-v1:` carrier (standard padded base64, byte-identical with Go) and is restored on the way back
// only when its family matches the target. Expected values come from codex_gemini_request_test.go and
// codex_gemini_response_test.go.
import { asString, get, isJsonArray, type Json, tryParseJson } from "@commissary/json";
import { describe, expect, it } from "vitest";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";
import { convertGeminiRequestToCodex } from "../src/translator/codex/gemini/request.ts";
import {
  convertCodexResponseToGemini,
  convertCodexResponseToGeminiNonStream,
} from "../src/translator/codex/gemini/response.ts";

/** Go `testGeminiMetaThoughtSignature`: a shape-valid synthetic Meta envelope (45 + 1024 bytes). */
const META = `Q-PaDgE${"A".repeat(1419)}`;

/** Go `testGeminiGPTThoughtSignature`: version 0x80, 89 bytes. */
const GPT = (() => {
  const bytes = Array.from({ length: 89 }, (_, i) => (i >= 9 ? i : 0));

  bytes[0] = 0x80;

  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
})();

const carrier = (raw: string): string => btoa(`cpa-codex-gemini-carrier-v1:${raw}`);

const context = (model: string, originalRequest?: Json): ResponseContext => ({
  model,
  originalRequest,
  translatedRequest: undefined,
  state: makeTranslationState(),
});

const parse = (text: string): Json | undefined => tryParseJson(text);

const partsOf = (chunk: string): Json[] => {
  const parts = get(parse(chunk), "candidates.0.content.parts");

  return isJsonArray(parts) ? parts : [];
};

const stream = (ctx: ResponseContext, events: ReadonlyArray<Json>): string[] =>
  events.flatMap((event) => [
    ...convertCodexResponseToGemini(ctx, `data: ${JSON.stringify(event)}`),
  ]);

const reasoningDone = (signature: string, summary: ReadonlyArray<string> = [], id = ""): Json => ({
  type: "response.output_item.done",
  item: {
    ...(id === "" ? {} : { id }),
    type: "reasoning",
    encrypted_content: signature,
    summary: summary.map((text) => ({ type: "summary_text", text })),
  },
});

const modelTurn = (thoughtSignature: string): Json => ({
  contents: [
    {
      role: "model",
      parts: [
        { thought: true, text: "internal reasoning", thoughtSignature },
        { text: "visible answer" },
      ],
    },
    { role: "user", parts: [{ text: "continue" }] },
  ],
});

const reasoningItems = (out: Json): Json[] => {
  const input = get(out, "input");

  return isJsonArray(input) ? input.filter((item) => get(item, "type") === "reasoning") : [];
};

describe("Gemini request -> Codex: restoring a thoughtSignature (Go 88ac14f3, a4660260)", () => {
  it("drops hidden thought parts whose signature no family claims", () => {
    const thoughtOnly = convertGeminiRequestToCodex(
      "codex-test",
      {
        contents: [
          {
            role: "model",
            parts: [
              {
                thought: true,
                text: "internal reasoning",
                thoughtSignature: "opaque-provider-state",
              },
            ],
          },
          { role: "user", parts: [{ text: "continue" }] },
        ],
      },
      false,
    );

    expect(get(thoughtOnly, "input")).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ]);

    const mixed = convertGeminiRequestToCodex(
      "codex-test",
      {
        contents: [
          {
            role: "model",
            parts: [
              {
                thought: true,
                text: "internal reasoning",
                thoughtSignature: "opaque-provider-state",
              },
              { text: "visible answer" },
            ],
          },
        ],
      },
      false,
    );

    expect(get(mixed, "input")).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible answer" }],
      },
    ]);
  });

  it("restores a Meta signature as a reasoning item with its thought as the summary for a Muse target", () => {
    const out = convertGeminiRequestToCodex("muse-spark-1.3", modelTurn(META), false);
    const input = get(out, "input");

    expect(isJsonArray(input) ? input.length : 0).toBe(3);
    expect(get(out, "input.0")).toEqual({
      type: "reasoning",
      encrypted_content: META,
      summary: [{ type: "summary_text", text: "internal reasoning" }],
    });
    expect(get(out, "input.1.content.0.text")).toBe("visible answer");
  });

  it.each(["gpt-5.1-codex", "claude-sonnet-4-6", "grok-4.5"])(
    "does not leak a Meta signature to a %s target",
    (model) => {
      expect(reasoningItems(convertGeminiRequestToCodex(model, modelTurn(META), false))).toEqual(
        [],
      );
    },
  );

  const ROUTED_META = `${META}.${"Ab3".repeat(23).slice(0, 67)}`;

  it.each([
    ["gpt cache prefixed", "gpt-5.1-codex", `gpt#${GPT}`, GPT],
    ["carrier wrapped gpt prefixed", "gpt-5.1-codex", carrier(`gpt#${GPT}`), GPT],
    ["carrier wrapped meta", "muse-spark-1.3", carrier(META), META],
    ["carrier wrapped meta to gpt target", "gpt-5.1-codex", carrier(META), undefined],
    ["carrier wrapped routed meta", "meta/muse-wonder", carrier(ROUTED_META), ROUTED_META],
    ["carrier wrapped routed meta to gpt target", "gpt-5.1-codex", carrier(ROUTED_META), undefined],
    ["legacy raw signature echo", "gpt-5.1-codex", GPT, GPT],
  ])("normalises %s", (_name, model, echoed, expected) => {
    const items = reasoningItems(convertGeminiRequestToCodex(model, modelTurn(echoed), false));

    expect(items.length === 0 ? undefined : asString(get(items[0], "encrypted_content"))).toBe(
      expected,
    );
  });

  it("takes the family of an unmapped deployment alias from the requested model", () => {
    const out = convertGeminiRequestToCodex(
      "deployment-alias",
      { model: "muse-spark-1.3", ...(modelTurn(META) as object) },
      false,
    );

    expect(reasoningItems(out)).toHaveLength(1);
  });

  it("restores a signature once", () => {
    const out = convertGeminiRequestToCodex(
      "muse-spark-1.3",
      {
        contents: [
          {
            role: "model",
            parts: [
              { thought: true, text: "a", thoughtSignature: META },
              { text: "b", thoughtSignature: META },
            ],
          },
        ],
      },
      false,
    );

    expect(reasoningItems(out)).toHaveLength(1);
  });
});

const completed = (output: Json[]): Json => ({
  type: "response.completed",
  response: {
    id: "resp_1",
    model: "muse-spark-1.3",
    created_at: 1,
    usage: { input_tokens: 1, output_tokens: 2 },
    output,
  },
});

describe("Codex response -> Gemini: carrying encrypted_content (Go 88ac14f3, a4660260)", () => {
  const message = { type: "message", content: [{ type: "output_text", text: "answer" }] };

  it("carries the signature byte-identically with Go, in standard padded base64", () => {
    const out = convertCodexResponseToGeminiNonStream(
      context("muse-spark-1.3"),
      JSON.stringify(
        completed([{ type: "reasoning", encrypted_content: "abc", summary: [] }, message]),
      ),
    );

    expect(get(parse(out), "candidates.0.content.parts.0")).toEqual({
      text: "",
      thought: true,
      thoughtSignature: "Y3BhLWNvZGV4LWdlbWluaS1jYXJyaWVyLXYxOmFiYw==",
    });
  });

  it("surfaces the summary as thought parts, the signature on the last, and keeps the message after them", () => {
    const out = parse(
      convertCodexResponseToGeminiNonStream(
        context("muse-spark-1.3"),
        JSON.stringify(
          completed([
            {
              type: "reasoning",
              encrypted_content: META,
              summary: [
                { type: "summary_text", text: "step A" },
                { type: "summary_text", text: "step B" },
              ],
            },
            message,
          ]),
        ),
      ),
    );

    expect(get(out, "candidates.0.content.parts.0")).toEqual({ text: "step A", thought: true });
    expect(get(out, "candidates.0.content.parts.1")).toEqual({
      text: "step B",
      thought: true,
      thoughtSignature: carrier(META),
    });
    expect(get(out, "candidates.0.content.parts.2.text")).toBe("answer");
  });

  it("round-trips a summary and its signature back into a reasoning item for an aliased target", () => {
    const geminiOut = parse(
      convertCodexResponseToGeminiNonStream(
        context("muse-spark-1.3"),
        JSON.stringify(
          completed([
            {
              type: "reasoning",
              encrypted_content: META,
              summary: [
                { type: "summary_text", text: "step A" },
                { type: "summary_text", text: "step B" },
              ],
            },
            { type: "message", content: [{ type: "output_text", text: "final answer" }] },
          ]),
        ),
      ),
    );

    const replay = convertGeminiRequestToCodex(
      "deployment-alias",
      {
        model: "muse-spark-1.3",
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          { role: "model", parts: get(geminiOut, "candidates.0.content.parts") ?? [] },
          { role: "user", parts: [{ text: "next" }] },
        ],
      },
      false,
    );

    expect(get(replay, "input.1")).toEqual({
      type: "reasoning",
      encrypted_content: META,
      summary: [
        { type: "summary_text", text: "step A" },
        { type: "summary_text", text: "step B" },
      ],
    });
  });

  it("holds a streamed signature for the next visible part", () => {
    const ctx = context("muse-spark-1.3");

    expect(stream(ctx, [reasoningDone(META)])).toEqual([]);
    const out = stream(ctx, [{ type: "response.output_text.delta", delta: "answer" }]);

    expect(out).toHaveLength(1);
    expect(partsOf(out[0] ?? "")[0]).toEqual({ text: "answer", thoughtSignature: carrier(META) });
  });

  it("never spends the only copy of a signature on an empty text delta", () => {
    const ctx = context("muse-spark-1.3");

    stream(ctx, [reasoningDone(META)]);
    const empty = stream(ctx, [{ type: "response.output_text.delta", delta: "" }]);
    const text = stream(ctx, [{ type: "response.output_text.delta", delta: "visible" }]);

    expect(partsOf(empty[0] ?? "")[0]).toEqual({ text: "" });
    expect(partsOf(text[0] ?? "")[0]).toEqual({ text: "visible", thoughtSignature: carrier(META) });
  });

  it("emits a done-only reasoning summary and attaches the signature to the next delta", () => {
    const ctx = context("muse-spark-1.3");

    const done = stream(ctx, [reasoningDone(META, ["done-only thought"], "rs_done_only")]);

    expect(done).toHaveLength(1);
    expect(partsOf(done[0] ?? "")).toEqual([{ thought: true, text: "done-only thought" }]);
    const text = stream(ctx, [{ type: "response.output_text.delta", delta: "visible" }]);

    expect(partsOf(text[0] ?? "")[0]).toEqual({ text: "visible", thoughtSignature: carrier(META) });
  });

  it("deduplicates a repeated reasoning done event", () => {
    const ctx = context("muse-spark-1.3");
    const event = reasoningDone(META, ["thought"], "rs_1");

    expect(stream(ctx, [event])).toHaveLength(1);
    expect(stream(ctx, [event])).toEqual([]);
  });

  it("queues consecutive function calls in order and gives the first the pending signature", () => {
    const ctx = context("muse-spark-1.3");

    const outputs = stream(ctx, [
      reasoningDone(META),
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_a", name: "alpha", arguments: "{}" },
      },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_b", name: "beta", arguments: "{}" },
      },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);

    const calls = outputs
      .flatMap(partsOf)
      .filter((part) => get(part, "functionCall") !== undefined);

    expect(calls.map((part) => get(part, "functionCall.name"))).toEqual(["alpha", "beta"]);
    expect(get(calls[0], "thoughtSignature")).toBe(carrier(META));
    expect(get(calls[1], "thoughtSignature")).toBeUndefined();
  });

  it("keeps consecutive reasoning items apart so each replays with its own summary", () => {
    const ctx = context("muse-spark-1.3");
    const second = `${META}.${"Zy9".repeat(21).slice(0, 62)}`;

    const parts = stream(ctx, [
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "first summary" },
      reasoningDone(META, ["first summary"], "rs_1"),
      { type: "response.reasoning_summary_text.delta", item_id: "rs_2", delta: "second summary" },
      reasoningDone(second, ["second summary"], "rs_2"),
      { type: "response.output_text.delta", delta: "answer" },
    ]).flatMap(partsOf);

    const replay = convertGeminiRequestToCodex(
      "muse-spark-1.3",
      {
        contents: [
          { role: "user", parts: [{ text: "q" }] },
          { role: "model", parts },
          { role: "user", parts: [{ text: "next" }] },
        ],
      },
      false,
    );

    expect(get(replay, "input.1.summary.0.text")).toBe("first summary");
    expect(get(replay, "input.2.summary.0.text")).toBe("second summary");
  });

  it("round-trips whitespace-only thought chunks without trimming", () => {
    const ctx = context("muse-spark-1.3");

    const parts = stream(ctx, [
      { type: "response.reasoning_summary_text.delta", item_id: "rs_ws", delta: "Hello" },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_ws", delta: " " },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_ws", delta: "world" },
      reasoningDone(META, [], "rs_ws"),
      { type: "response.output_text.delta", delta: "ok" },
    ]).flatMap(partsOf);

    const replay = convertGeminiRequestToCodex(
      "muse-spark-1.3",
      {
        contents: [
          { role: "user", parts: [{ text: "q" }] },
          { role: "model", parts },
          { role: "user", parts: [{ text: "next" }] },
        ],
      },
      false,
    );

    const summary = get(replay, "input.1.summary");

    expect(isJsonArray(summary) ? summary.map((entry) => get(entry, "text")) : []).toEqual([
      "Hello",
      " ",
      "world",
    ]);
  });

  it("flushes a signature that never met a visible part as an empty thought on completion", () => {
    const ctx = context("muse-spark-1.3");

    const out = stream(ctx, [
      reasoningDone(META),
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);

    expect(partsOf(out.at(-1) ?? "")).toEqual([
      { thought: true, text: "", thoughtSignature: carrier(META) },
    ]);
  });
});
