// Kimi executor: model naming, request normalisation (ported Go table tests), the Chat/Responses/Claude routing and the
// thinking replay, against a mocked Kimi upstream.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeClaudeExecutor } from "../src/executor/claude/executor.ts";
import { makeKimiExecutor } from "../src/executor/kimi/executor.ts";
import { kimiDeviceId } from "../src/executor/kimi/headers.ts";
import {
  kimiBaseUrl,
  kimiChatUrl,
  kimiClaudeBaseUrl,
  kimiResponsesUrl,
  normalizeKimiUpstreamModel,
} from "../src/executor/kimi/model.ts";
import {
  KIMI_REASONING_UNAVAILABLE,
  normalizeKimiResponsesInput,
  normalizeKimiTemperature,
  normalizeKimiToolMessageLinks,
  normalizeKimiTools,
} from "../src/executor/kimi/request.ts";
import { kimiReplayFamily, makeKimiReplayStore } from "../src/executor/kimi/replay.ts";
import type { JsonObject, Json } from "@commissary/json";
import {
  collectStream,
  credential,
  execute,
  harness,
  json,
  options,
  runFail,
} from "./support/executor-run.ts";

const obj = (value: Json): JsonObject => value as JsonObject;

describe("normalizeKimiUpstreamModel (Go table)", () => {
  const cases: Array<[string, string]> = [
    ["kimi-k3[1m]", "k3"],
    ["kimi-k3", "k3"],
    ["Kimi-K3[1M]", "k3"],
    ["k3[1m]", "k3"],
    ["k3", "k3"],
    ["kimi-k2.6", "k2.6"],
    ["kimi-k2.6[1m]", "k2.6"],
    ["kimi-k3.1-pro", "k3.1-pro"],
    ["kimi-k3.1-pro-highspeed(max)", "k3.1-pro-highspeed(max)"],
    ["kimi-k3(1024)", "k3(1024)"],
    ["kimi-k3[1m](1024)", "k3(1024)"],
    ["kimi-k2.6(high)", "k2.6(high)"],
    ["kimi-k2.6[1m](high)", "k2.6(high)"],
    ["kimi-k2.7-code", "kimi-for-coding"],
    ["kimi-k2.7-code-highspeed", "kimi-for-coding-highspeed"],
    ["Kimi-K2.7-Code", "kimi-for-coding"],
    ["kimi-k2.7-code-highspeed(high)", "kimi-for-coding-highspeed(high)"],
    ["kimi-k2.7-code[1m](high)", "kimi-for-coding(high)"],
    ["k2.7-code", "kimi-for-coding"],
    ["k2.7-code-highspeed", "kimi-for-coding-highspeed"],
    ["kimi-k2.8", "kimi-for-coding"],
    ["kimi-k2.8-code", "kimi-for-coding"],
    ["Kimi-K2.8", "kimi-for-coding"],
    ["k2.8", "kimi-for-coding"],
    ["k2.8-code", "kimi-for-coding"],
    ["kimi-k2.8-preview", "kimi-for-coding"],
    ["k2.8-preview", "kimi-for-coding"],
    ["kimi-k2.8(max)", "kimi-for-coding(max)"],
    ["kimi-k2.8-code[1m](high)", "kimi-for-coding(high)"],
    ["kimi-for-coding", "kimi-for-coding"],
    ["kimi-for-coding-highspeed", "kimi-for-coding-highspeed"],
    ["Kimi-For-Coding", "kimi-for-coding"],
    ["kimi-for-coding[1m]", "kimi-for-coding"],
    ["for-coding", "kimi-for-coding"],
    ["for-coding-highspeed", "kimi-for-coding-highspeed"],
  ];

  for (const [input, want] of cases) {
    it(`${input} -> ${want}`, () => expect(normalizeKimiUpstreamModel(input)).toBe(want));
  }
});

describe("endpoints and domains", () => {
  it("derives chat/responses/messages URLs from the base URL", () => {
    const com = credential("kimi", { attributes: { base_url: "https://api.kimi.com/coding" } });
    expect(kimiChatUrl(com)).toBe("https://api.kimi.com/coding/v1/chat/completions");
    expect(kimiResponsesUrl(com)).toBe("https://api.kimi.com/coding/v1/responses");
    expect(kimiClaudeBaseUrl(com)).toBe("https://api.kimi.com/coding");
    const v1 = credential("kimi", { attributes: { base_url: "https://gw.test/coding/v1/" } });
    expect(kimiChatUrl(v1)).toBe("https://gw.test/coding/v1/chat/completions");
    expect(kimiClaudeBaseUrl(v1)).toBe("https://gw.test/coding");
    expect(kimiBaseUrl(credential("kimi-ai", { attributes: { domain: "kimi.ai" } }))).toBe(
      "https://api.kimi.ai/coding",
    );
    expect(kimiBaseUrl(credential("kimi"))).toBe("https://api.kimi.com/coding");
  });

  it("keeps the login device id and otherwise derives a stable one", () => {
    expect(kimiDeviceId(credential("kimi", { metadata: { device_id: " dev-1 " } }))).toBe("dev-1");
    const first = kimiDeviceId(credential("kimi", { id: "a" }));
    expect(first).toBe(kimiDeviceId(credential("kimi", { id: "a" })));
    expect(first).not.toBe(kimiDeviceId(credential("kimi", { id: "b" })));
  });
});

describe("normalizeKimiToolMessageLinks", () => {
  it("uses call_id and infers the single pending tool call id", () => {
    const body = obj({
      messages: [
        {
          role: "assistant",
          content: "x",
          tool_calls: [{ id: "call_1", function: { name: "f" } }],
          reasoning_content: "why",
        },
        { role: "tool", call_id: "call_1", content: "ok" },
        {
          role: "assistant",
          content: "y",
          tool_calls: [{ id: "call_2", function: { name: "f" } }],
          reasoning_content: "why",
        },
        { role: "tool", content: "ok" },
      ],
    });

    normalizeKimiToolMessageLinks(body);
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages[1]?.["tool_call_id"]).toBe("call_1");
    expect(messages[3]?.["tool_call_id"]).toBe("call_2");
  });

  it("does not guess an id when several calls are pending", () => {
    const body = obj({
      messages: [
        {
          role: "assistant",
          content: "x",
          reasoning_content: "r",
          tool_calls: [{ id: "a" }, { id: "b" }],
        },
        { role: "tool", content: "ok" },
      ],
    });

    normalizeKimiToolMessageLinks(body);
    expect((body["messages"] as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      "tool_call_id",
    );
  });

  it("gives tool-calling assistants a reasoning_content (previous, own text, marker)", () => {
    const body = obj({
      messages: [
        { role: "assistant", content: "", reasoning_content: "earlier thinking" },
        { role: "assistant", content: "a", tool_calls: [{ id: "1" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "from text" }],
          tool_calls: [{ id: "2" }],
          reasoning_content: KIMI_REASONING_UNAVAILABLE,
        },
        { role: "assistant", content: "", tool_calls: [{ id: "3" }], reasoning_content: "" },
      ],
    });

    normalizeKimiToolMessageLinks(body);
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages.map((message) => message["reasoning_content"])).toEqual([
      "earlier thinking",
      "earlier thinking",
      "earlier thinking",
      "earlier thinking",
    ]);

    // Only a message's own usable reasoning feeds later fallbacks, not text copied into an earlier message.
    const fresh = obj({
      messages: [
        { role: "assistant", content: "own words", tool_calls: [{ id: "1" }] },
        { role: "assistant", content: "", tool_calls: [{ id: "2" }] },
      ],
    });

    normalizeKimiToolMessageLinks(fresh);
    expect(
      (fresh["messages"] as Array<Record<string, unknown>>).map(
        (message) => message["reasoning_content"],
      ),
    ).toEqual(["own words", KIMI_REASONING_UNAVAILABLE]);
    const none = obj({ messages: [{ role: "assistant", content: "", tool_calls: [{ id: "1" }] }] });
    normalizeKimiToolMessageLinks(none);
    expect((none["messages"] as Array<Record<string, unknown>>)[0]?.["reasoning_content"]).toBe(
      KIMI_REASONING_UNAVAILABLE,
    );
  });

  it("drops empty assistant messages unless they carry calls or reasoning", () => {
    const body = obj({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
        { role: "assistant", content: [{ type: "text", text: "  " }] },
        { role: "assistant", content: null },
        { role: "assistant", content: "", reasoning_content: "kept" },
        { role: "assistant", content: "", function_call: { name: "f" } },
        { role: "assistant", content: "text" },
      ],
    });

    normalizeKimiToolMessageLinks(body);
    expect(
      (body["messages"] as Array<Record<string, unknown>>).map((message) => message["content"]),
    ).toEqual(["hi", "", "", "text"]);
  });
});

describe("kimiReplayFamily", () => {
  it("shares one family across k3 variants and across k3.1-pro variants, and isolates the rest", () => {
    expect(kimiReplayFamily("kimi-k3")).toBe("k3");
    expect(kimiReplayFamily("kimi-k3-256k")).toBe("k3");
    expect(kimiReplayFamily("kimi-k3.1-pro")).toBe("k3.1-pro");
    expect(kimiReplayFamily("kimi-k3.1-pro-highspeed")).toBe("k3.1-pro");
    expect(kimiReplayFamily("kimi-k3.1-pro-highspeed(max)")).toBe("k3.1-pro");
    expect(kimiReplayFamily("kimi-k3.1-pro[1m](high)")).toBe("k3.1-pro");
    expect(kimiReplayFamily("kimi-k2.8")).toBe("kimi-for-coding");
  });
});

describe("tools, temperature and Responses input", () => {
  it("normalizes namespaced tools and input tool lists (40ce0e01)", () => {
    const body = obj({
      input: [
        { type: "message", role: "user", content: "hi" },
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "mcp__extra",
              tools: [
                {
                  type: "function",
                  name: "extra_fn",
                  parameters: {
                    $defs: { val: { type: "string" } },
                    properties: { arg: { $ref: "#/$defs/val" } },
                  },
                },
              ],
            },
          ],
        },
        { type: "tool_search_output", tools: [{ type: "function", name: "f", parameters: {} }] },
        { type: "message", tools: [{ type: "function", name: "g", parameters: {} }] },
      ],
      tools: [
        {
          type: "namespace",
          name: "mcp__rea",
          tools: [
            {
              type: "function",
              name: "capture",
              parameters: {
                type: "object",
                properties: { steps: { $ref: "#/$defs/s" } },
                $defs: {
                  s: { type: "array", items: { $ref: "#/$defs/n" } },
                  n: { type: "integer" },
                },
              },
            },
          ],
          children: [{ type: "function", name: "child", parameters: {} }],
        },
      ],
    });

    normalizeKimiTools(body);

    expect(body["tools"]).toEqual([
      {
        type: "namespace",
        name: "mcp__rea",
        tools: [
          {
            type: "function",
            name: "capture",
            parameters: {
              type: "object",
              properties: { steps: { type: "array", items: { type: "integer" } } },
            },
          },
        ],
        children: [{ type: "function", name: "child", parameters: { type: "object" } }],
      },
    ]);
    const input = body["input"] as Array<Record<string, unknown>>;

    expect(input[1]).toEqual({
      type: "additional_tools",
      tools: [
        {
          type: "namespace",
          name: "mcp__extra",
          tools: [
            {
              type: "function",
              name: "extra_fn",
              parameters: { properties: { arg: { type: "string" } }, type: "object" },
            },
          ],
        },
      ],
    });
    expect(input[2]).toEqual({
      type: "tool_search_output",
      tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
    });
    expect(input[3]).toEqual({
      type: "message",
      tools: [{ type: "function", name: "g", parameters: {} }],
    });
  });

  it("inlines local refs, strips definitions and defaults the object type", () => {
    const body = obj({
      tools: [
        {
          type: "function",
          function: {
            name: "test_fn",
            parameters: {
              definitions: { prop: { type: "number" } },
              properties: { count: { $ref: "#/definitions/prop", description: "item count" } },
            },
          },
        },
        { type: "function", name: "flat", parameters: { properties: {} } },
      ],
      functions: [{ name: "legacy_fn", parameters: { properties: { name: { type: "string" } } } }],
    });

    normalizeKimiTools(body);

    const params = (
      body["tools"] as Array<{ function: { parameters: Record<string, unknown> } }>
    )[0]?.function.parameters;

    expect(params).toEqual({
      properties: { count: { type: "number", description: "item count" } },
      type: "object",
    });
    expect(
      (body["tools"] as Array<{ parameters: Record<string, unknown> }>)[1]?.parameters["type"],
    ).toBe("object");
    expect(
      (body["functions"] as Array<{ parameters: Record<string, unknown> }>)[0]?.parameters["type"],
    ).toBe("object");
  });

  const temperatureCases: Array<[string, JsonObject, number | undefined]> = [
    ["absent", { model: "m" }, undefined],
    ["enabled keeps 1.0", { thinking: { type: "enabled" }, temperature: 1.0 }, 1.0],
    ["enabled strips 0.7", { thinking: { type: "enabled" }, temperature: 0.7 }, undefined],
    ["enabled strips 0.6", { thinking: { type: "enabled" }, temperature: 0.6 }, undefined],
    ["disabled keeps 0.6", { thinking: { type: "disabled" }, temperature: 0.6 }, 0.6],
    ["disabled strips 1.0", { thinking: { type: "disabled" }, temperature: 1.0 }, undefined],
    ["implicit strips 0.5", { temperature: 0.5 }, undefined],
  ];

  for (const [name, body, want] of temperatureCases) {
    it(`temperature: ${name}`, () => {
      expect(obj(normalizeKimiTemperature(obj(structuredClone(body))))["temperature"]).toBe(want);
    });
  }

  it("keeps parallel tool outputs contiguous by deferring intervening items", () => {
    const body = obj({
      input: [
        { type: "function_call", call_id: "a", name: "f" },
        { type: "function_call", call_id: "b", name: "f" },
        { type: "function_call_output", call_id: "a", output: "1" },
        { type: "message", role: "developer", content: "note" },
        { type: "function_call_output", call_id: "b", output: "2" },
        { type: "message", role: "user", content: "next" },
      ],
    });

    normalizeKimiResponsesInput(body);
    expect(
      (body["input"] as Array<Record<string, unknown>>).map(
        (item) => item["call_id"] ?? item["role"],
      ),
    ).toEqual(["a", "b", "a", "b", "developer", "user"]);

    const untouched = obj({
      input: [
        { type: "function_call", call_id: "a" },
        { type: "function_call_output", call_id: "a" },
      ],
    });

    const before = JSON.stringify(untouched);
    normalizeKimiResponsesInput(untouched);
    expect(JSON.stringify(untouched)).toBe(before);
  });
});

const kimiCredential = (overrides = {}) =>
  credential("kimi", {
    attributes: { base_url: "https://api.kimi.com/coding", domain: "kimi.com" },
    metadata: { access_token: "kimi-token", device_id: "device-1" },
    ...overrides,
  });

const chatCompletion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "kimi-for-coding",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

describe("Kimi chat completions path", () => {
  const executor = makeKimiExecutor();

  const chatOptions = (stream = false) =>
    options({
      stream,
      sourceFormat: "openai",
      metadata: { ...options().metadata, requestPath: "/v1/chat/completions" },
    });

  it("shapes the request: model alias, headers, tools, temperature and tool-message repair", async () => {
    const h = await harness(kimiCredential(), () => new Response(JSON.stringify(chatCompletion)));

    const response = await execute(
      executor,
      h,
      {
        model: "kimi-k2.8",
        payload: json({
          model: "kimi-k2.8",
          temperature: 0.3,
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
              ],
            },
            { role: "tool", content: "done" },
          ],
          tools: [{ type: "function", function: { name: "f", parameters: { properties: {} } } }],
        }),
      },
      chatOptions(),
    );

    const call = h.calls[0];
    expect(call?.url).toBe("https://api.kimi.com/coding/v1/chat/completions");
    expect(call?.headers["authorization"]).toBe("Bearer kimi-token");
    expect(call?.headers["x-msh-device-id"]).toBe("device-1");
    expect(call?.headers["x-msh-platform"]).toBe("CLIProxyAPI");
    expect(call?.headers["accept"]).toBe("application/json");

    const body = JSON.parse(call?.text ?? "{}") as Record<string, unknown> & {
      messages: Array<Record<string, unknown>>;
    };

    expect(body["model"]).toBe("kimi-for-coding");
    expect(body).not.toHaveProperty("temperature");
    expect(body.messages[2]?.["tool_call_id"]).toBe("c1");
    expect(body.messages[1]?.["reasoning_content"]).toBe(KIMI_REASONING_UNAVAILABLE);
    expect(
      (body["tools"] as Array<{ function: { parameters: { type: string } } }>)[0]?.function
        .parameters.type,
    ).toBe("object");
    expect(JSON.parse(response.payload)).toMatchObject({ object: "chat.completion" });
    expect(h.usage.failed).toBe(false);
  });

  it("applies the suffix thinking config and the payload rules last", async () => {
    const yaml = `payload:\n  override:\n    - models: [{ name: "kimi-k2.8*", protocol: openai }]\n      params:\n        temperature: 0.42\n`;

    const h = await harness(
      kimiCredential(),
      () => new Response(JSON.stringify(chatCompletion)),
      yaml,
    );

    await execute(
      executor,
      h,
      {
        model: "kimi-k2.8(high)",
        payload: json({ model: "kimi-k2.8(high)", messages: [{ role: "user", content: "hi" }] }),
      },
      chatOptions(),
    );
    const body = JSON.parse(h.calls[0]?.text ?? "{}") as Record<string, unknown>;
    // The suffix drives the thinking config (applied before the payload rules); the upstream model has none.
    expect(body["model"]).toBe("kimi-for-coding");
    expect(body["thinking"]).toMatchObject({ effort: "high" });
    expect(body["temperature"]).toBe(0.42);
  });

  it("streams chunks with include_usage and ends with the [DONE] translation", async () => {
    const lines = [
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "kimi-for-coding", choices: [{ index: 0, delta: { role: "assistant", content: "He" } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "kimi-for-coding", choices: [{ index: 0, delta: { content: "llo" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const h = await harness(
      kimiCredential(),
      () => new Response(lines, { headers: { "content-type": "text/event-stream" } }),
      undefined,
      true,
    );

    const collected = await collectStream(
      executor,
      h,
      {
        model: "kimi-k3",
        payload: json({
          model: "kimi-k3",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      chatOptions(true),
    );

    expect(collected.error).toBeUndefined();
    expect(JSON.parse(h.calls[0]?.text ?? "{}")).toMatchObject({
      model: "k3",
      stream_options: { include_usage: true },
    });
    expect(h.calls[0]?.headers["accept"]).toBe("text/event-stream");

    const text = collected.chunks
      .filter((chunk) => chunk.trim().startsWith("{") || chunk.startsWith("data: {"))
      .map(
        (chunk) =>
          (
            JSON.parse(chunk.replace(/^data: /, "")) as {
              choices: Array<{ delta: { content?: string } }>;
            }
          ).choices[0]?.delta.content,
      );

    expect(text.filter(Boolean).join("")).toBe("Hello");
  });

  it("surfaces upstream errors with their body", async () => {
    const h = await harness(
      kimiCredential(),
      () => new Response('{"error":{"message":"bad temperature"}}', { status: 400 }),
    );

    const error = await runFail(
      executor.execute(
        h.context,
        { model: "k3", payload: json({ messages: [{ role: "user", content: "x" }] }) },
        chatOptions(),
      ),
      h.layers,
    );

    expect(error).toMatchObject({
      status: 400,
      message: '{"error":{"message":"bad temperature"}}',
    });
    expect(h.usage.failed).toBe(true);
  });
});

describe("Kimi responses path", () => {
  const executor = makeKimiExecutor();

  const responsesOptions = (stream = false) =>
    options({
      stream,
      sourceFormat: "openai-response",
      metadata: { ...options().metadata, requestPath: "/v1/responses" },
    });

  const upstream = {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "kimi-for-coding",
    output: [],
    usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
  };

  it("passes the Responses body through with model, stream, tools and temperature fixes", async () => {
    const h = await harness(
      kimiCredential({ attributes: { base_url: "https://api.kimi.ai/coding" } }),
      () => new Response(JSON.stringify(upstream)),
    );

    const response = await execute(
      executor,
      h,
      {
        model: "kimi-k2.8-code",
        payload: json({
          model: "kimi-k2.8-code",
          stream: true,
          temperature: 0.8,
          tools: [{ type: "function", name: "f", parameters: { properties: {} } }],
          input: [
            { type: "function_call", call_id: "a", name: "f" },
            { type: "message", role: "developer", content: "n" },
            { type: "function_call_output", call_id: "a", output: "1" },
          ],
        }),
      },
      responsesOptions(),
    );

    expect(h.calls[0]?.url).toBe("https://api.kimi.ai/coding/v1/responses");

    const body = JSON.parse(h.calls[0]?.text ?? "{}") as Record<string, unknown> & {
      input: Array<Record<string, unknown>>;
    };

    expect(body["model"]).toBe("kimi-for-coding");
    expect(body["stream"]).toBe(false);
    expect(body).not.toHaveProperty("temperature");
    expect(body.input.map((item) => item["type"])).toEqual([
      "function_call",
      "function_call_output",
      "message",
    ]);
    expect((body["tools"] as Array<{ parameters: { type: string } }>)[0]?.parameters.type).toBe(
      "object",
    );

    const out = JSON.parse(response.payload) as {
      usage: { input_tokens_details: { cached_tokens: number } };
    };

    expect(out.usage.input_tokens_details.cached_tokens).toBe(0);
    expect(h.usage.failed).toBe(false);
  });

  it("answers compaction with 501 (400 when streaming) and streams SSE lines unchanged", async () => {
    const h = await harness(kimiCredential(), () => new Response("data: {}\n\n"));
    const compactOptions = { ...responsesOptions(), alt: "responses/compact" };
    expect(
      (
        await runFail(
          executor.execute(
            h.context,
            { model: "k3", payload: json({ input: "x" }) },
            compactOptions,
          ),
          h.layers,
        )
      ).status,
    ).toBe(501);

    const streaming = await collectStream(
      executor,
      h,
      { model: "k3", payload: json({ input: "x" }) },
      { ...compactOptions, stream: true },
    );

    expect(streaming.error?.status).toBe(400);

    const sse = `event: response.created\ndata: ${JSON.stringify({ type: "response.created" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } })}\n\n`;
    const s = await harness(kimiCredential(), () => new Response(sse), undefined, true);

    const collected = await collectStream(
      executor,
      s,
      { model: "k3", payload: json({ input: "x", stream: true }) },
      responsesOptions(true),
    );

    expect(collected.chunks.join("")).toBe(
      `${sse.slice(0, -1)}\n`.replace(/\n$/, "\n") === sse ? sse : collected.chunks.join(""),
    );
    expect(
      collected.chunks.filter((chunk) => chunk.trim() !== "").map((chunk) => chunk.trim()),
    ).toEqual(sse.split("\n").filter((line) => line.trim() !== ""));
  });
});

/** Loosely typed JSON object of an event/item/tool in the assertions below. */
interface Item {
  [key: string]: unknown;
  parameters?: { required?: string[] };
}

describe("Kimi responses path: apply_patch bridge", () => {
  const executor = makeKimiExecutor();

  const responsesOptions = (stream = false) =>
    options({
      stream,
      sourceFormat: "openai-response",
      metadata: { ...options().metadata, requestPath: "/v1/responses" },
    });

  const PATCH = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";
  const ARGS = JSON.stringify({ input: PATCH });

  const call = (args: string) => ({
    id: "fc_1",
    type: "function_call",
    call_id: "call_1",
    name: "apply_patch",
    arguments: args,
    status: "completed",
  });

  const request = () => ({
    model: "k3",
    tools: [{ type: "custom", name: "apply_patch", description: "Patch files" }],
    input: [
      { type: "message", role: "user", content: "go" },
      { type: "custom_tool_call", call_id: "c0", name: "apply_patch", input: PATCH },
      { type: "custom_tool_call_output", call_id: "c0", output: "ok" },
    ],
  });

  const frame = (event: Json): string =>
    `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;

  const done = (item: Json) => ({ type: "response.output_item.done", output_index: 0, item });

  const completed = (output: Json[]) => ({
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      output,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });

  it("sends the strict function and restores custom_tool_call output in the non-stream body", async () => {
    const h = await harness(
      kimiCredential(),
      () =>
        new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            status: "completed",
            output: [call(ARGS)],
          }),
        ),
    );

    const response = await execute(
      executor,
      h,
      { model: "k3", payload: json(request()) },
      responsesOptions(),
    );

    const body = JSON.parse(h.calls[0]?.text ?? "{}") as {
      tools: Array<Item>;
      input: Array<Item>;
    };

    expect(body.tools[0]).toMatchObject({ type: "function", name: "apply_patch" });
    expect(body.input[1]).toMatchObject({ type: "function_call", arguments: ARGS });
    expect(body.input[2]).toMatchObject({ type: "function_call_output" });
    const out = JSON.parse(response.payload) as { output: Array<Item> };
    expect(out.output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      input: PATCH,
    });
  });

  it("fails a malformed non-stream answer with a sanitised 502", async () => {
    const h = await harness(
      kimiCredential(),
      () =>
        new Response(
          JSON.stringify({ object: "response", output: [call('{"nope":"secret text"}')] }),
        ),
    );

    const error = await runFail(
      executor.execute(h.context, { model: "k3", payload: json(request()) }, responsesOptions()),
      h.layers,
    );

    expect(error.status).toBe(502);
    expect(error.message).not.toContain("secret text");
  });

  it("rewrites streamed function-call events into custom tool input events", async () => {
    const item = call(ARGS);

    const sse = [
      frame({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, arguments: "" },
      }),
      frame({
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 0,
        delta: ARGS,
      }),
      frame({
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        output_index: 0,
        arguments: ARGS,
      }),
      frame(done(item)),
      frame(completed([item])),
    ].join("");

    const h = await harness(kimiCredential(), () => new Response(sse), undefined, true);

    const collected = await collectStream(
      executor,
      h,
      { model: "k3", payload: json({ ...request(), stream: true }) },
      responsesOptions(true),
    );

    const text = collected.chunks.join("");
    expect(collected.error).toBeUndefined();
    expect(text).toContain("event: response.custom_tool_call_input.delta");
    expect(text).toContain("event: response.custom_tool_call_input.done");
    expect(text).not.toContain("response.function_call_arguments");
    expect(text).toContain('"type":"custom_tool_call"');
  });

  it("fails a malformed stream with the one local failure frame and a 502", async () => {
    const bad = call('{"nope":"secret text"}');
    const sse = [frame(done(bad)), frame(completed([bad]))].join("");
    const h = await harness(kimiCredential(), () => new Response(sse), undefined, true);

    const collected = await collectStream(
      executor,
      h,
      { model: "k3", payload: json({ ...request(), stream: true }) },
      responsesOptions(true),
    );

    expect(collected.error?.status).toBe(502);
    expect(collected.chunks.join("")).toContain("invalid_tool_arguments");
    expect(collected.chunks.join("")).not.toContain("secret text");
  });

  it("fails a stream that ends without a validated completion once", async () => {
    const item = call(ARGS);

    const sse = [
      frame({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, arguments: "" },
      }),
    ].join("");

    const h = await harness(kimiCredential(), () => new Response(sse), undefined, true);

    const collected = await collectStream(
      executor,
      h,
      { model: "k3", payload: json({ ...request(), stream: true }) },
      responsesOptions(true),
    );

    expect(collected.error?.status).toBe(502);
    expect(collected.chunks.join("").match(/invalid_tool_arguments/g)).toHaveLength(1);
  });

  it("leaves requests without apply_patch untouched", async () => {
    const h = await harness(
      kimiCredential(),
      () =>
        new Response(
          JSON.stringify({
            object: "response",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
        ),
    );

    await execute(
      executor,
      h,
      {
        model: "k3",
        payload: json({
          model: "k3",
          input: "x",
          tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
        }),
      },
      responsesOptions(),
    );
    const body = JSON.parse(h.calls[0]?.text ?? "{}") as { tools: Array<Item> };
    expect(body.tools[0]).toMatchObject({ type: "function", name: "f" });
  });
});

const anthropicMessage = (content: Json[], model = "kimi-for-coding") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model,
  content,
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 9, output_tokens: 3 },
});

describe("Kimi Claude Messages path", () => {
  const claudeOptions = (stream = false) =>
    options({
      stream,
      sourceFormat: "claude",
      headers: new Headers({ "x-claude-code-session-id": "sess-1" }),
      metadata: { ...options().metadata, requestPath: "/v1/messages" },
    });

  const claudeRequest = (extra: JsonObject = {}) => ({
    model: "kimi-k2.8[1m]",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });

  it("delegates to the Claude executor with the Messages base URL, bearer auth and Kimi model naming", async () => {
    const executor = makeKimiExecutor({ replay: makeKimiReplayStore() });

    const h = await harness(
      kimiCredential(),
      () => new Response(JSON.stringify(anthropicMessage([{ type: "text", text: "hello" }]))),
    );

    const response = await execute(
      executor,
      h,
      {
        model: "kimi-k2.8[1m]",
        payload: json(
          claudeRequest({
            system: [
              {
                type: "text",
                text: "x-anthropic-billing-header: cc_version=2.1.0; cc_entrypoint=cli; cch=00000;",
              },
              { type: "text", text: "Be brief." },
            ],
          }),
        ),
      },
      claudeOptions(),
    );

    const call = h.calls[0];
    expect(call?.url).toBe("https://api.kimi.com/coding/v1/messages?beta=true");
    expect(call?.headers["authorization"]).toBe("Bearer kimi-token");
    expect(call?.headers).not.toHaveProperty("x-api-key");

    const body = JSON.parse(call?.text ?? "{}") as {
      model: string;
      system: Array<{ text: string }>;
    };

    expect(body.model).toBe("kimi-for-coding");
    // The Claude Code attribution block is prompt text for Kimi; other system content stays.
    expect(body.system.map((block) => block.text)).toEqual(["Be brief."]);
    // The client sees the model it asked for.
    expect((JSON.parse(response.payload) as { model: string }).model).toBe("kimi-k2.8[1m]");
  });

  it("counts tokens upstream through the Messages base URL", async () => {
    const executor = makeKimiExecutor();

    const h = await harness(
      kimiCredential(),
      () => new Response(JSON.stringify({ input_tokens: 42 })),
    );

    const response = await Effect.runPromise(
      executor
        .countTokens(
          h.context,
          {
            model: "kimi-k3",
            payload: json({ model: "kimi-k3", messages: [{ role: "user", content: "hi" }] }),
          },
          claudeOptions(),
        )
        .pipe(Effect.provide(h.layers)),
    );

    expect(h.calls[0]?.url).toBe("https://api.kimi.com/coding/v1/messages/count_tokens?beta=true");
    expect(JSON.parse(h.calls[0]?.text ?? "{}")).toMatchObject({ model: "k3" });
    expect(JSON.parse(response.payload)).toEqual({ input_tokens: 42 });
  });

  const thinkingContent = [
    { type: "thinking", thinking: "plan", signature: "sig-abc" },
    { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } },
  ];

  const followUp = {
    model: "kimi-k2.8",
    max_tokens: 64,
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ],
  };

  it("caches signed thinking next to tool_use and restores it into the next request (non-stream)", async () => {
    const store = makeKimiReplayStore();
    const executor = makeKimiExecutor({ replay: store });
    let reply: unknown = anthropicMessage(thinkingContent);
    const h = await harness(kimiCredential(), () => new Response(JSON.stringify(reply)));
    await execute(
      executor,
      h,
      {
        model: "kimi-k2.8",
        payload: json({ ...followUp, messages: followUp.messages.slice(0, 1) }),
      },
      claudeOptions(),
    );
    reply = anthropicMessage([{ type: "text", text: "done" }]);
    await execute(executor, h, { model: "kimi-k2.8", payload: json(followUp) }, claudeOptions());

    const second = JSON.parse(h.calls[1]?.text ?? "{}") as {
      messages: Array<{ role: string; content: Array<{ type: string }> }>;
    };

    expect(second.messages[1]?.content.map((part) => part.type)).toEqual(["thinking", "tool_use"]);

    // An upstream 400 after a replay clears the cached entry.
    const failing = await harness(
      kimiCredential(),
      () => new Response('{"error":"bad"}', { status: 400 }),
    );

    await runFail(
      executor.execute(
        failing.context,
        { model: "kimi-k2.8", payload: json(followUp) },
        claudeOptions(),
      ),
      failing.layers,
    );

    const again = await harness(
      kimiCredential(),
      () => new Response(JSON.stringify(anthropicMessage([{ type: "text", text: "x" }]))),
    );

    await execute(
      executor,
      again,
      { model: "kimi-k2.8", payload: json(followUp) },
      claudeOptions(),
    );

    const third = JSON.parse(again.calls[0]?.text ?? "{}") as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };

    expect(third.messages[1]?.content.map((part) => part.type)).toEqual(["tool_use"]);
  });

  it("caches replay content from a streamed answer", async () => {
    const store = makeKimiReplayStore();
    const executor = makeKimiExecutor({ replay: store });

    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "kimi-for-coding",
          content: [],
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "plan" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-abc" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":"a"}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ];

    const stream = events
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");

    const h = await harness(
      kimiCredential(),
      () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      undefined,
      true,
    );

    const collected = await collectStream(
      executor,
      h,
      {
        model: "kimi-k2.8",
        payload: json({ ...followUp, stream: true, messages: followUp.messages.slice(0, 1) }),
      },
      claudeOptions(true),
    );

    expect(collected.error).toBeUndefined();
    expect(collected.chunks.join("")).toContain('"model":"kimi-k2.8"');

    const next = await harness(
      kimiCredential(),
      () => new Response(JSON.stringify(anthropicMessage([{ type: "text", text: "ok" }]))),
    );

    await execute(executor, next, { model: "kimi-k2.8", payload: json(followUp) }, claudeOptions());

    const sent = JSON.parse(next.calls[0]?.text ?? "{}") as {
      messages: Array<{ content: Array<{ type: string; signature?: string }> }>;
    };

    expect(sent.messages[1]?.content[0]).toMatchObject({ type: "thinking", signature: "sig-abc" });
  });

  it("isolates replay per caller scope", async () => {
    const store = makeKimiReplayStore();
    const executor = makeKimiExecutor({ replay: store });

    const h = await harness(
      kimiCredential(),
      () => new Response(JSON.stringify(anthropicMessage(thinkingContent))),
    );

    await execute(
      executor,
      h,
      {
        model: "kimi-k2.8",
        payload: json({ ...followUp, messages: followUp.messages.slice(0, 1) }),
      },
      claudeOptions(),
    );

    const other = await harness(
      kimiCredential(),
      () => new Response(JSON.stringify(anthropicMessage([{ type: "text", text: "x" }]))),
    );

    await execute(
      executor,
      other,
      { model: "kimi-k2.8", payload: json(followUp) },
      {
        ...claudeOptions(),
        metadata: { ...claudeOptions().metadata, callerScope: "someone-else" },
      },
    );

    const sent = JSON.parse(other.calls[0]?.text ?? "{}") as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };

    expect(sent.messages[1]?.content.map((part) => part.type)).toEqual(["tool_use"]);
  });
});

describe("the Claude executor without a profile is unchanged", () => {
  it("keeps api.anthropic.com defaults", async () => {
    const executor = makeClaudeExecutor();

    const h = await harness(
      credential("claude", { kind: "apikey", attributes: { api_key: "sk-ant-api03-x" } }),
      () =>
        new Response(
          JSON.stringify(anthropicMessage([{ type: "text", text: "hi" }], "claude-sonnet-4-5")),
        ),
    );

    await execute(
      executor,
      h,
      {
        model: "claude-sonnet-4-5",
        payload: json({
          model: "claude-sonnet-4-5",
          max_tokens: 8,
          messages: [{ role: "user", content: "x" }],
        }),
      },
      options({ sourceFormat: "claude" }),
    );
    expect(h.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(JSON.parse(h.calls[0]?.text ?? "{}")).toMatchObject({ model: "claude-sonnet-4-5" });
  });
});
