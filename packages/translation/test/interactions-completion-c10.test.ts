// Interactions completion (Go: internal/translator/antigravity/interactions/interactions_antigravity_test.go,
// internal/translator/gemini/interactions/interactions_gemini_{common,stream_lines}_test.go; upstream ede07caf,
// be929f07, 37bd18b0).
import { describe, expect, it } from "vitest";
import { get, type Json, tryParseJson } from "@commissary/json";
import { convertInteractionsRequestToAntigravity } from "../src/translator/antigravity/interactions/request.ts";
import { convertAntigravityResponseToInteractions } from "../src/translator/antigravity/interactions/response.ts";
import { convertGeminiResponseToInteractions } from "../src/translator/gemini/interactions/responses.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const context = (): ResponseContext => ({
  model: "m",
  originalRequest: parse(`{"input":"hi"}`),
  translatedRequest: undefined,
  state: makeTranslationState(),
});

const eventTypes = (chunks: ReadonlyArray<string>): string[] =>
  chunks.flatMap((chunk) =>
    chunk
      .split("\n")
      .filter((line) => line.startsWith("event:"))
      .map((line) => line.slice(6).trim()),
  );

const payloadOf = (chunks: ReadonlyArray<string>, event: string): Json => {
  for (const chunk of chunks) {
    if (!chunk.startsWith(`event: ${event}\n`)) continue;

    return parse(chunk.split("\n")[1]?.slice(6) ?? "");
  }

  throw new Error(`no ${event} event`);
};

describe("Antigravity -> Interactions stream completion (ede07caf)", () => {
  const run = (ctx: ResponseContext, ...lines: string[]): string[] =>
    lines.flatMap((line) => [...convertAntigravityResponseToInteractions(ctx, line)]);

  it("emits interaction.completed and done after a terminal usage frame", () => {
    const out = run(
      context(),
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}}`,
    );

    const types = eventTypes(out);

    expect(types.filter((type) => type === "interaction.completed")).toHaveLength(1);
    expect(types.filter((type) => type === "done")).toHaveLength(1);
    expect(out.join("")).toContain("data: [DONE]");
    expect(get(payloadOf(out, "interaction.completed"), "interaction.usage.total_tokens")).toBe(5);
  });

  it("waits for usage after a split finish frame, then completes once", () => {
    const ctx = context();

    const finish = run(
      ctx,
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}`,
    );

    expect(eventTypes(finish)).not.toContain("interaction.completed");
    expect(eventTypes(finish)).not.toContain("done");

    const usage = run(
      ctx,
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":""}]}}],"cpaUsageMetadata":{"promptTokenCount":11,"candidatesTokenCount":22,"totalTokenCount":33}}}`,
    );

    expect(eventTypes(usage).filter((type) => type === "interaction.completed")).toHaveLength(1);
    expect(eventTypes(usage).filter((type) => type === "done")).toHaveLength(1);
    expect(get(payloadOf(usage, "interaction.completed"), "interaction.usage.total_tokens")).toBe(
      33,
    );
    expect(run(ctx, "[DONE]")).toEqual([]);
  });

  it("does not complete on earlier usage; uses the final usage frame", () => {
    const ctx = context();

    const out = run(
      ctx,
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]}}],"usageMetadata":{"promptTokenCount":1,"totalTokenCount":1}}}`,
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}]}}`,
    );

    expect(out.join("")).not.toContain("interaction.completed");
    expect(out.join("")).not.toContain("[DONE]");

    const usage = run(
      ctx,
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":""}]}}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":22,"totalTokenCount":33}}}`,
    );

    expect(get(payloadOf(usage, "interaction.completed"), "interaction.usage.total_tokens")).toBe(
      33,
    );
  });

  it.each(["", " "])("ignores an empty finishReason %j", (finishReason) => {
    const out = run(
      context(),
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"${finishReason}"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}}`,
    );

    expect(eventTypes(out)).not.toContain("interaction.completed");
    expect(eventTypes(out)).not.toContain("done");
  });

  it("does not complete on non-terminal usage", () => {
    const out = run(
      context(),
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"thinking"}]}}],"usageMetadata":{"promptTokenCount":1,"totalTokenCount":1}}}`,
    );

    expect(eventTypes(out)).not.toContain("interaction.completed");
    expect(eventTypes(out)).not.toContain("done");
  });

  it("treats the bare [DONE] line as the terminator, with the cached usage", () => {
    const ctx = context();
    run(
      ctx,
      `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"x"}]}}],"usageMetadata":{"promptTokenCount":1,"totalTokenCount":7}}}`,
    );
    const out = run(ctx, "[DONE]");

    expect(eventTypes(out)).toEqual(["step.stop", "interaction.completed", "done"]);
    expect(get(payloadOf(out, "interaction.completed"), "interaction.usage.total_tokens")).toBe(7);
  });
});

describe("Gemini -> Interactions stream lines (ede07caf, be929f07)", () => {
  const body = `{"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":4,"totalTokenCount":15}}`;

  const wanted = [
    "interaction.created",
    "interaction.status_update",
    "step.start",
    "step.delta",
    "step.stop",
    "interaction.completed",
    "done",
  ];

  it.each([
    ["bare", body],
    ["data with space", `data: ${body}`],
    ["data without space", `data:${body}`],
    ["surrounding whitespace", `  data: ${body}  `],
  ])("%s", (_name, line) => {
    const ctx = context();

    const out = [
      ...convertGeminiResponseToInteractions(ctx, line),
      ...convertGeminiResponseToInteractions(ctx, "data: [DONE]"),
    ];

    expect(eventTypes(out)).toEqual(wanted);
    expect(get(payloadOf(out, "step.delta"), "delta.text")).toBe("OK");
    expect(get(payloadOf(out, "interaction.completed"), "interaction.usage.total_tokens")).toBe(15);
  });

  it.each(["", "  ", "data:", "data:  ", ": keepalive", "event: message", "id: 1", "retry: 1000"])(
    "ignores the control line %j without starting a stream",
    (line) => {
      const ctx = context();

      expect(convertGeminiResponseToInteractions(ctx, line)).toEqual([]);
      expect(ctx.state.value).toBeUndefined();
    },
  );

  it("completes once on a prefixed [DONE]", () => {
    const ctx = context();

    const out = [
      ...convertGeminiResponseToInteractions(ctx, `{"candidates":[{"finishReason":"STOP"}]}`),
      ...convertGeminiResponseToInteractions(ctx, "data: [DONE]"),
    ];

    expect(eventTypes(out)).toEqual([
      "interaction.created",
      "interaction.status_update",
      "interaction.completed",
      "done",
    ]);
    expect(convertGeminiResponseToInteractions(ctx, "[DONE]")).toEqual([]);
  });

  it("reads filter-renamed cpaUsageMetadata as the final usage", () => {
    const ctx = context();

    const out = [
      ...convertGeminiResponseToInteractions(
        ctx,
        `{"candidates":[{"content":{"role":"model","parts":[{"text":"a"}]},"finishReason":"STOP"}]}`,
      ),
      ...convertGeminiResponseToInteractions(
        ctx,
        `{"candidates":[{"content":{"parts":[{"text":""}]}}],"cpaUsageMetadata":{"promptTokenCount":2,"totalTokenCount":9}}`,
      ),
    ];

    expect(eventTypes(out).slice(-2)).toEqual(["interaction.completed", "done"]);
    expect(get(payloadOf(out, "interaction.completed"), "interaction.usage.total_tokens")).toBe(9);
  });
});

describe("Antigravity interactions request: bare content-block lists (37bd18b0)", () => {
  const convert = (input: string): Json =>
    convertInteractionsRequestToAntigravity(
      "antigravity-test",
      parse(`{"model":"antigravity-test","input":${input}}`),
      false,
    );

  it("matches the step form and keeps the image", () => {
    const bare = convert(
      `[{"type":"image","mime_type":"image/png","data":"aGVsbG8="},{"type":"text","text":"describe"}]`,
    );

    const step = convert(
      `[{"type":"user_input","content":[{"type":"image","mime_type":"image/png","data":"aGVsbG8="},{"type":"text","text":"describe"}]}]`,
    );

    expect(get(bare, "request.contents")).toEqual(get(step, "request.contents"));
    expect(JSON.stringify(get(bare, "request.contents"))).toContain("aGVsbG8=");
    expect(JSON.stringify(get(bare, "request.contents"))).toContain("describe");
  });

  it.each(["system", "developer"])("keeps the emptied-turn refusal around bare %s text", (role) => {
    const unsupported = `{"type":"user_input","content":[{"type":"document","uri":"gs://b/a.pdf"}]}`;
    const instruction = `{"type":"text","role":"${role}","text":"note"}`;

    expect(() => convert(`[${unsupported},${instruction}]`)).toThrow();
    expect(() => convert(`[${instruction},${unsupported}]`)).toThrow();
  });
});
