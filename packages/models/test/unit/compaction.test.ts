// The shared Responses compaction helpers (`executor/helps/compaction.ts`): the summary request built from a client
// payload, capsule expansion, the summary status check and the synthetic response and stream.
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Formats } from "@commissary/translation/formats";
import { asString, get, type Json, type JsonObject } from "@commissary/json";
import {
  buildCompactionResponse,
  buildCompactionStreamChunks,
  compactionSummaryStatusError,
  dropForeignCompactionItems,
  expandRecognizedResponsesCompactionCapsules,
  expandResponsesCompactionCapsules,
  extractSummaryText,
  prepareCompactionSummaryPayload,
  recognizedCompactionResponseId,
  sealCompaction,
  sealCompactionSummary,
} from "../../src/executor/helps/compaction.ts";
import type { ExecutorOptions, ExecutorRequest } from "../../src/executor/types.ts";

const input = (payload: Json): ReadonlyArray<Json> => {
  const items = get(payload, "input");

  return Array.isArray(items) ? items : [];
};

describe("prepareCompactionSummaryPayload", () => {
  const userMessage: JsonObject = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "fix the bug" }],
  };

  it("removes control items, also with whitespace around the type, and appends the summary prompt last", () => {
    const out = prepareCompactionSummaryPayload({
      model: "m",
      input: [
        { type: "additional_tools", tools: [] },
        { type: " configuration_update ", settings: {} },
        userMessage,
        { type: "compaction_trigger" },
        { type: "\tcompaction_trigger\n" },
      ],
    });

    const items = input(out);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(userMessage);
    expect(get(items[1], "role")).toBe("user");
    expect(get(items[1], "content.0.text")).toContain("concise and comprehensive summary");
  });

  it("removes the fields that do not apply to a one-shot summary and forces stream false", () => {
    const out = prepareCompactionSummaryPayload({
      model: "m",
      type: "response.create",
      event_id: "evt_1",
      text: { format: { type: "json_schema", name: "x", schema: {} } },
      stream: true,
      tools: [{ type: "function", name: "f" }],
      tool_choice: "auto",
      previous_response_id: "resp_1",
      parallel_tool_calls: true,
      additional_tools: [],
      truncation: "auto",
      metadata: { a: "b" },
      instructions: "keep",
      input: [userMessage],
    });

    expect(out).toEqual({
      model: "m",
      instructions: "keep",
      stream: false,
      input: [userMessage, expect.anything()],
    });
  });
});

const requestOf = (payload: Json): ExecutorRequest => ({ model: "m", payload });

const optionsOf = (originalRequest: Json | undefined): ExecutorOptions => ({
  stream: false,
  alt: "",
  headers: new Headers(),
  query: new URLSearchParams(),
  originalRequest,
  sourceFormat: Formats.OpenAIResponse,
  metadata: {
    requestPath: "/v1/responses",
    requestedModel: "m",
    serviceTier: "auto",
    generate: true,
    callerScope: "",
  },
});

const messageText = (item: Json | undefined): string => asString(get(item, "content.0.text"));

describe("capsule expansion", () => {
  const sealed = async (summary: string, id = "cmp_ag_compact_1") => ({
    type: "compaction",
    id,
    encrypted_content: await sealCompaction(summary, "m"),
  });

  const reasoning: JsonObject = {
    type: "reasoning",
    id: "rs_1",
    summary: [],
    encrypted_content: "sealed.v1.AAAA",
  };

  const foreign: JsonObject = { type: "compaction", id: "cmp_openai", encrypted_content: "gAAAA" };

  it("opens a capsule into a developer message, drops a foreign item and leaves a reasoning item alone", async () => {
    const payload: Json = { input: [foreign, await sealed("earlier work"), reasoning] };
    const original = JSON.stringify(reasoning);
    const out = await expandResponsesCompactionCapsules(requestOf(payload), optionsOf(undefined));
    const items = input(out.request.payload);
    expect(items).toHaveLength(2);
    expect(get(items[0], "role")).toBe("developer");
    expect(messageText(items[0])).toBe("Context summary from previous turns:\nearlier work");
    expect(JSON.stringify(items[1])).toBe(original);
  });

  it("keeps native compaction items when only recognised capsules are expanded", async () => {
    const payload: Json = { input: [foreign, await sealed("earlier work")] };

    const out = await expandRecognizedResponsesCompactionCapsules(
      requestOf(payload),
      optionsOf(undefined),
    );

    const items = input(out.request.payload);
    expect(items[0]).toEqual(foreign);
    expect(messageText(items[1])).toContain("earlier work");
  });

  it("opens a capsule with whitespace around it", async () => {
    const item = await sealed("spaced");
    const padded = { ...item, encrypted_content: `  ${item.encrypted_content}\n` };

    const out = await expandResponsesCompactionCapsules(
      requestOf({ input: [padded] }),
      optionsOf(undefined),
    );

    expect(messageText(input(out.request.payload)[0])).toContain("spaced");
  });

  it("rejects a recognised item whose ciphertext is bad", async () => {
    const bad = { type: "compaction", id: "cmp_ag_compact_9", encrypted_content: "not a capsule" };

    await expect(
      expandRecognizedResponsesCompactionCapsules(
        requestOf({ input: [bad] }),
        optionsOf(undefined),
      ),
    ).rejects.toThrow(/^invalid compaction capsule: /);
  });

  it("keeps payload and originalRequest one object when they were one", async () => {
    const payload: Json = { input: [await sealed("one")] };

    const out = await expandResponsesCompactionCapsules(requestOf(payload), optionsOf(payload));
    expect(out.options.originalRequest).toBe(out.request.payload);
    expect(messageText(input(out.request.payload)[0])).toContain("one");
  });

  it("expands payload and originalRequest on their own when they differ", async () => {
    const payload: Json = { input: [await sealed("payload side")] };
    const original: Json = { input: [await sealed("original side"), foreign] };

    const out = await expandResponsesCompactionCapsules(requestOf(payload), optionsOf(original));
    expect(messageText(input(out.request.payload)[0])).toContain("payload side");
    const originalItems = input(out.options.originalRequest ?? null);
    expect(originalItems).toHaveLength(1);
    expect(messageText(originalItems[0])).toContain("original side");
  });

  it("returns the request untouched when there is nothing to expand", async () => {
    const request = requestOf({ input: [{ type: "message", role: "user", content: "hi" }] });
    const options = optionsOf(undefined);
    const out = await expandResponsesCompactionCapsules(request, options);
    expect(out.request).toBe(request);
    expect(out.options).toBe(options);
    expect(dropForeignCompactionItems(request.payload)).toBe(request.payload);
  });
});

describe("compactionSummaryStatusError", () => {
  const completed = (extra: JsonObject = {}): Json => ({
    status: "completed",
    output: [],
    ...extra,
  });

  it("passes a completed response", () => {
    expect(compactionSummaryStatusError(completed())).toBeUndefined();
    expect(compactionSummaryStatusError({ response: { status: "completed" } })).toBeUndefined();
  });

  it.each([
    ["incomplete", { status: "incomplete" }],
    ["failed", { status: "failed" }],
    ["a missing status", {}],
    ["incomplete_details", completed({ incomplete_details: { reason: "max_output_tokens" } })],
    ["an error", completed({ error: { message: "boom" } })],
    [
      "an output item that is not completed",
      completed({ output: [{ type: "message", status: "in_progress" }] }),
    ],
    ["a terminal failure event", completed({ type: "response.failed" })],
  ])("fails %s", (_name, body) => {
    expect(compactionSummaryStatusError(body as Json)).toEqual(expect.any(String));
  });

  it("accepts null incomplete_details and error", () => {
    expect(
      compactionSummaryStatusError(completed({ incomplete_details: null, error: null })),
    ).toBeUndefined();
  });
});

describe("sealing a summary", () => {
  const usage = {
    input_tokens: 11,
    output_tokens: 7,
    total_tokens: 18,
    input_tokens_details: { cached_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 3 },
  };

  it("extracts the text from output_text and text parts", () => {
    expect(
      extractSummaryText({
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      }),
    ).toBe("a\nb");
  });

  it("seals a completed summary with all five token counts", async () => {
    const body = JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "the summary" }] }],
      usage,
    });

    const sealed = await Effect.runPromise(sealCompactionSummary("m", body, 1_700_000_000_000));
    expect(get(sealed, "object")).toBe("response.compaction");
    expect(asString(get(sealed, "id"))).toMatch(/^resp_ag_compact_/);
    expect(get(sealed, "usage")).toEqual(usage);
  });

  it("fails an incomplete summary with a request-scoped 502", async () => {
    const body = JSON.stringify({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });

    const error = await Effect.runPromise(Effect.flip(sealCompactionSummary("m", body, 0)));
    expect(error.status).toBe(502);
    expect(error.requestScoped).toBe(true);
  });

  it("fails a summary without text with a request-scoped 502", async () => {
    const body = JSON.stringify({ status: "completed", output: [{ type: "reasoning" }] });
    const error = await Effect.runPromise(Effect.flip(sealCompactionSummary("m", body, 0)));
    expect(error.status).toBe(502);
    expect(error.requestScoped).toBe(true);
    expect(error.message).toContain("no summary text");
  });

  it("carries the counts on the body and on every SSE frame", () => {
    const body = buildCompactionResponse("m", "cpa-ag-compact-v1:X", 11, 7, 18, 1_700_000_000_000, {
      cached: 5,
      reasoning: 3,
    });

    expect(get(body, "usage")).toEqual(usage);

    const chunks = buildCompactionStreamChunks(
      "m",
      "cpa-ag-compact-v1:X",
      11,
      7,
      18,
      1_700_000_000_000,
      {
        cached: 5,
        reasoning: 3,
      },
    );

    const completed = chunks.at(-1) ?? "";
    expect(JSON.parse(completed.slice(completed.indexOf("data: ") + 6)).response.usage).toEqual(
      usage,
    );
  });

  it("recognises the ids of responses a local compaction minted, and no other", () => {
    expect(recognizedCompactionResponseId("resp_ag_compact_123")).toBe(true);
    expect(recognizedCompactionResponseId("  resp_ag_compact_123")).toBe(true);
    expect(recognizedCompactionResponseId("resp_123")).toBe(false);
    expect(recognizedCompactionResponseId("cmp_ag_compact_123")).toBe(false);
  });
});
