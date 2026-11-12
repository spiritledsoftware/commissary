// End-to-end (workerd) tests of Claude Messages clients served by Interactions providers: POST /v1/messages on a
// `gemini-interactions` credential through Access, model resolution, the credential picker and the Gemini executor,
// and the Devin executor driven with a Claude source format.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Config } from "../src/config/schema.ts";
import { makeDevinExecutor } from "../src/executor/devin/executor.ts";
import { devinPayloadView } from "../src/executor/devin/payload.ts";
import { resetSessionTurnIndex } from "../src/executor/devin/credentials.ts";
import devinFixtures from "./fixtures/devin.json";
import {
  collectStream,
  credential as executorCredential,
  execute,
  harness as executorHarness,
  json,
  options,
} from "./support/executor-run.ts";
import { credential, makeGeminiHarness } from "./support/gemini.ts";
import {
  jsonResponse,
  loadConfig,
  postJson,
  sseResponse,
  type UpstreamResponder,
} from "./support/pipeline.ts";
import type { Json } from "@commissary/json";

let config: Config;

beforeAll(async () => {
  config = await loadConfig("");
});

const native = credential("gemini-interactions", "gemini-interactions:1", {
  attributes: { api_key: "AIza-native", base_url: "https://gl.test" },
});

const harness = (respond: UpstreamResponder) =>
  makeGeminiHarness({
    config,
    respond,
    credential: native,
    models: { "gemini-3.1-flash-lite": ["gemini-interactions"] },
  });

const sseFrame = (event: string, data: Json): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Parses Claude SSE output into `[event, payload]` pairs. */
const claudeEvents = (text: string): Array<[string, Record<string, unknown>]> =>
  text
    .split(/\n\n+/)
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";

      return [event, JSON.parse(data) as Record<string, unknown>];
    });

const REQUEST = {
  model: "gemini-3.1-flash-lite",
  max_tokens: 512,
  system: "Be brief.",
  tools: [
    {
      name: "lookup",
      description: "Find",
      input_schema: { type: "object", properties: { q: { type: "string" } } },
    },
  ],
  messages: [
    { role: "user", content: "find x" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "found" }] },
  ],
};

describe("POST /v1/messages on a gemini-interactions credential", () => {
  it("translates the Claude request to Interactions and the answer back to a Claude message", async () => {
    const h = harness(() =>
      jsonResponse({
        id: "int_1",
        model: "gemini-3.1-flash-lite",
        status: "completed",
        steps: [
          { type: "thought", signature: "SIG", content: [{ type: "text", text: "hmm" }] },
          { type: "model_output", content: [{ type: "text", text: "It is found." }] },
          { type: "function_call", call_id: "toolu_2", name: "lookup", arguments: { q: "y" } },
        ],
        usage: {
          total_input_tokens: 30,
          total_output_tokens: 7,
          total_cached_tokens: 10,
          total_tokens: 37,
        },
      }),
    );

    afterAll(h.dispose);
    const response = await h.call("/v1/messages", postJson(REQUEST));
    expect(response.status).toBe(200);
    expect(h.calls[0]?.url).toBe("https://gl.test/v1beta/interactions");
    expect(h.calls[0]?.headers["x-goog-api-key"]).toBe("AIza-native");
    expect(JSON.parse(h.calls[0]?.body ?? "{}")).toMatchObject({
      model: "gemini-3.1-flash-lite",
      system_instruction: "Be brief.",
      generation_config: { max_output_tokens: 512 },
      input: [
        { type: "user_input", content: [{ type: "text", text: "find x" }] },
        { type: "function_call", name: "lookup", id: "toolu_1", arguments: { q: "x" } },
        { type: "function_result", call_id: "toolu_1", name: "lookup", result: "found" },
      ],
      tools: [{ type: "function", name: "lookup", description: "Find" }],
    });
    expect(await response.json()).toEqual({
      id: "int_1",
      type: "message",
      role: "assistant",
      model: "gemini-3.1-flash-lite",
      content: [
        { type: "thinking", thinking: "hmm", signature: "SIG" },
        { type: "text", text: "It is found." },
        { type: "tool_use", id: "toolu_2", name: "lookup", input: { q: "y" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 10 },
    });
    expect(h.records[0]).toMatchObject({ provider: "gemini-interactions", failed: false });
    expect(h.records[0]?.detail.totalTokens).toBe(37);
  });

  it("streams Interactions events as Claude Messages events", async () => {
    const h = harness(() =>
      sseResponse([
        sseFrame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "int_2", model: "gemini-3.1-flash-lite" },
        }),
        sseFrame("step.start", {
          event_type: "step.start",
          index: 0,
          step: { type: "model_output" },
        }),
        sseFrame("step.delta", {
          event_type: "step.delta",
          index: 0,
          delta: { type: "text", text: "北京" },
        }),
        sseFrame("step.delta", {
          event_type: "step.delta",
          index: 0,
          delta: { type: "text", text: "晴" },
        }),
        sseFrame("step.stop", { event_type: "step.stop", index: 0 }),
        sseFrame("step.start", {
          event_type: "step.start",
          index: 1,
          step: { type: "function_call", id: "toolu_9", name: "lookup", arguments: {} },
        }),
        sseFrame("step.delta", {
          event_type: "step.delta",
          index: 1,
          delta: { type: "arguments_delta", arguments: '{"q":"x"}' },
        }),
        sseFrame("step.stop", { event_type: "step.stop", index: 1 }),
        sseFrame("interaction.completed", {
          event_type: "interaction.completed",
          interaction: {
            id: "int_2",
            usage: { total_input_tokens: 5, total_output_tokens: 6, total_tokens: 11 },
          },
        }),
        "data: [DONE]\n\n",
      ]),
    );

    afterAll(h.dispose);
    const response = await h.call("/v1/messages", postJson({ ...REQUEST, stream: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(JSON.parse(h.calls[0]?.body ?? "{}")).toMatchObject({ stream: true });
    expect(h.calls[0]?.url).toBe("https://gl.test/v1beta/interactions");
    const events = claudeEvents(await response.text());
    expect(events.map(([name]) => name)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0]?.[1]).toMatchObject({
      message: { id: "int_2", model: "gemini-3.1-flash-lite", role: "assistant" },
    });
    expect(events[2]?.[1]).toMatchObject({ index: 0, delta: { type: "text_delta", text: "北京" } });
    expect(events[5]?.[1]).toMatchObject({
      index: 1,
      content_block: { type: "tool_use", id: "toolu_9", name: "lookup" },
    });
    expect(events[6]?.[1]).toMatchObject({
      delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
    });
    expect(events[8]?.[1]).toMatchObject({
      delta: { stop_reason: "tool_use" },
      usage: { input_tokens: 5, output_tokens: 6 },
    });
    expect(h.records[0]?.detail.totalTokens).toBe(11);
  });

  it("refuses a request whose user turn only holds unsendable attachments before calling upstream", async () => {
    const h = harness(() => jsonResponse({}));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1/messages",
      postJson({
        model: "gemini-3.1-flash-lite",
        max_tokens: 8,
        messages: [{ role: "user", content: [{ type: "container_upload", file_id: "file-1" }] }],
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unsupported content part: container_upload");
    expect(h.calls).toHaveLength(0);
  });
});

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

const scenario = devinFixtures.scenarios.find((entry) => entry.name === "text-basic")!;

/** The `text-basic` Connect frames of the Go-generated Devin fixtures ("Hel" + "lo", 24/7 tokens, 4 cached). */
const devinFrames = (): Response => {
  const chunks = scenario.frames.map((frame) => {
    const payload = fromHex(frame.hex);
    const out = new Uint8Array(5 + payload.length);
    out[0] = frame.flag;
    new DataView(out.buffer).setUint32(1, payload.length, false);
    out.set(payload, 5);

    return out;
  });

  return new Response(new Uint8Array(chunks.flatMap((chunk) => [...chunk])), {
    status: 200,
    headers: { "content-type": "application/connect+proto" },
  });
};

const claudeOptions = (stream: boolean) =>
  options({
    stream,
    sourceFormat: "claude",
    metadata: { ...options().metadata, requestPath: "/v1/messages" },
  });

const devin = () =>
  executorCredential("devin", {
    attributes: {
      api_key: "devin-session-token$test",
      base_url: "https://devin.test",
      device_seed: "seed-1",
    },
  });

const claudeRequest = {
  model: "swe-2",
  max_tokens: 256,
  temperature: 0.5,
  messages: [{ role: "user", content: "hi" }],
};

describe("Claude clients on the Devin executor", () => {
  const executor = makeDevinExecutor();

  it("answers a non-stream Claude request with a Claude message", async () => {
    resetSessionTurnIndex("claude-devin-1");
    const h = await executorHarness(devin(), devinFrames);

    const response = await execute(
      executor,
      h,
      { model: "swe-2", payload: json({ ...claudeRequest, stream: false }) },
      claudeOptions(false),
    );

    const view = devinPayloadView((h.calls[0] as { bytes: Uint8Array }).bytes.subarray(5)) as {
      model: string;
      completion_config: { max_tokens: number; temperature: number };
    };

    expect(view.model).toBe("swe-2-high");
    expect(view.completion_config).toMatchObject({ max_tokens: 256, temperature: 0.5 });
    expect(JSON.parse(response.payload)).toMatchObject({
      type: "message",
      role: "assistant",
      model: "swe-2",
      content: [{ type: "text", text: "Hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 4 },
    });
  });

  it("streams a Claude request as Claude Messages events", async () => {
    const h = await executorHarness(devin(), devinFrames, undefined, true);

    const collected = await collectStream(
      executor,
      h,
      { model: "swe-2", payload: json({ ...claudeRequest, stream: true }) },
      claudeOptions(true),
    );

    expect(collected.error).toBeUndefined();
    const events = claudeEvents(collected.chunks.join(""));
    expect(events.map(([name]) => name)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(
      events
        .filter(([name]) => name === "content_block_delta")
        .map(([, data]) => (data.delta as { text: string }).text),
    ).toEqual(["Hel", "lo"]);
    expect(events[5]?.[1]).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 20, output_tokens: 7 },
    });
  });
});
