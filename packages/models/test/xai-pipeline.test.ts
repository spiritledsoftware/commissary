// End-to-end tests (workerd) of the xAI provider executor: /v1/responses (+compact), chat completions routed to xAI,
// base-URL routing, CLI identity headers, error rules, reasoning replay and payload rules as the last mutation.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { resetXaiClientVersionCache, XAI_VERSION_KV_KEY } from "../src/executor/xai/version.ts";
import type { Config } from "../src/config/schema.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import {
  jsonResponse,
  loadConfig,
  makePipeline,
  postJson,
  sseResponse,
  type UpstreamResponder,
} from "./support/pipeline.ts";
import {
  grokCiphertext,
  xaiKey,
  xaiModels,
  xaiOauth,
  xaiPicker,
  type XaiPickerLog,
} from "./support/xai.ts";
import type { Json } from "@commissary/json";
import { routerSuffixed } from "./support/signatures.ts";

const YAML = `
upstream:
  xai:
    inject-x-search: true
requests:
  payload:
    override:
      - models: [{ name: "grok-4.3", protocol: codex }]
        params:
          "metadata.via": "payload-rule"
          "tools.0.name": "rule_name"
      - models: [{ name: "grok-4.3", protocol: openai-response }]
        params:
          "metadata.compact": true
    filter:
      - models: [{ name: "grok-4.3", protocol: codex }]
        params: ["temperature"]
      - models: [{ name: "grok-4.3", protocol: openai-response }]
        params: ["previous_response_id"]
`;

const created = {
  type: "response.created",
  response: {
    id: "resp_1",
    object: "response",
    created_at: 1767225600,
    model: "grok-4.3",
    status: "in_progress",
  },
};

const completed = (
  output: Json[] = [],
  usage: Json = { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
) => ({
  type: "response.completed",
  response: {
    id: "resp_1",
    status: "completed",
    created_at: 1767225600,
    model: "grok-4.3",
    output,
    usage,
  },
});

const frame = (event: Json): string => {
  const type = (event as { type: string }).type;

  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
};

const MESSAGE_ITEM = {
  id: "msg_1",
  type: "message",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text: "Hello!", annotations: [] }],
};

const TEXT_STREAM = [
  frame(created),
  frame({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Hel" }),
  frame({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "lo!" }),
  frame({ type: "response.output_item.done", output_index: 0, item: MESSAGE_ITEM }),
  frame(completed()),
];

let config: Config;

let plainConfig: Config;

beforeAll(async () => {
  config = await loadConfig(YAML);
  plainConfig = await loadConfig("requests: {}");
});

interface Options {
  readonly config?: Config;
  readonly credentials?: ReadonlyArray<CredentialSnapshot>;
}

const pipeline = (respond: UpstreamResponder, options: Options = {}) => {
  const log: XaiPickerLog = { picks: [], reports: [] };

  const p = makePipeline({
    config: options.config ?? plainConfig,
    respond,
    credentialPicker: xaiPicker(options.credentials ?? [xaiOauth()], log),
    modelProviders: xaiModels,
  });

  afterAll(p.dispose);

  return { ...p, log };
};

describe("POST /v1/responses (non-stream)", () => {
  it("routes OAuth credentials to the CLI chat proxy with the Grok CLI identity and unwraps the completed response", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3(high)",
        instructions: "Be brief",
        input: "Say hi",
        stream: false,
        temperature: 0.7,
        max_output_tokens: 99,
        stop: ["x"],
        previous_response_id: "resp_old",
        stream_options: { include_usage: true },
      }),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      id: string;
      output: unknown[];
      usage: Record<string, unknown>;
    };

    expect(body.id).toBe("resp_1");
    expect(body.output).toEqual([MESSAGE_ITEM]);
    expect(body.usage).toMatchObject({ input_tokens: 10, output_tokens: 4, total_tokens: 14 });

    const call = p.calls[0]!;
    expect(call.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(call.headers["authorization"]).toBe("Bearer xai-access-1");
    expect(call.headers["accept"]).toBe("text/event-stream");
    expect(call.headers["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(call.headers["x-grok-client-version"]).toBe("1.0.46");
    expect(call.headers["user-agent"]).toBe("xai-grok-workspace/1.0.46");
    expect(call.headers["x-grok-client-identifier"]).toBe("grok-shell");
    expect(call.headers["x-authenticateresponse"]).toBe("authenticate-response");
    const upstream = JSON.parse(call.body) as Record<string, unknown>;
    expect(upstream).toMatchObject({
      model: "grok-4.3",
      instructions: "Be brief",
      stream: true,
      temperature: 0.7,
      max_output_tokens: 99,
      reasoning: { effort: "high" },
    });
    expect("stop" in upstream).toBe(false);
    expect("previous_response_id" in upstream).toBe(false);
    expect("stream_options" in upstream).toBe(false);
    expect(p.log.reports.map((report) => report.result.success)).toEqual([true]);
    expect(p.records[0]?.detail.inputTokens).toBe(10);
  });

  it("sends provider-key credentials to the official API without the CLI identity", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM), {
      credentials: [xaiKey({ attributes: { api_key: "k", "header:X-Org": "acme" } })],
    });

    const response = await p.call("/v1/responses", postJson({ model: "grok-4.3", input: "hi" }));
    expect(response.status).toBe(200);
    const call = p.calls[0]!;
    expect(call.url).toBe("https://api.x.ai/v1/responses");
    expect(call.headers["authorization"]).toBe("Bearer k");
    expect(call.headers["x-xai-token-auth"]).toBeUndefined();
    expect(call.headers["user-agent"]).toBeUndefined();
    expect(call.headers["x-org"]).toBe("acme");
  });

  it("honours using_api=false for provider-key style base URLs and explicit custom base URLs", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM), {
      credentials: [
        xaiOauth({ attributes: { auth_kind: "oauth", base_url: "https://grok.example.test/v1/" } }),
      ],
    });

    await p.call("/v1/responses", postJson({ model: "grok-4.3", input: "hi" }));
    const call = p.calls[0]!;
    expect(call.url).toBe("https://grok.example.test/v1/responses");
    // Identity headers belong to the CLI chat proxy only.
    expect(call.headers["x-xai-token-auth"]).toBeUndefined();
  });

  it("translates Chat Completions requests to xAI and back", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    const response = await p.call(
      "/v1/chat/completions",
      postJson({
        model: "grok-4.3",
        max_tokens: 50,
        stop: ["END"],
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
      }),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };

    expect(body.choices[0]?.message.content).toBe("Hello!");
    expect(body.choices[0]?.finish_reason).toBe("stop");

    const upstream = JSON.parse(p.calls[0]!.body) as Record<string, unknown> & {
      input: Array<{ role: string }>;
    };

    expect(upstream.input.map((item) => item.role)).toEqual(["developer", "user"]);
    expect(upstream["max_output_tokens"]).toBe(50);
    expect("stop" in upstream).toBe(false);
  });

  it("answers 408 when the stream ends without a terminal event", async () => {
    const p = pipeline(() => sseResponse([frame(created)]));
    const response = await p.call("/v1/responses", postJson({ model: "grok-4.3", input: "hi" }));
    expect(response.status).toBe(408);
    expect(await response.text()).toContain("stream disconnected before response.completed");
    expect(p.log.reports[0]?.result.success).toBe(false);
  });
});

describe("POST /v1/responses (stream)", () => {
  it("normalises reasoning text events and passes the stream through", async () => {
    const reasoningItem = {
      id: "rs_1",
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: "thinking" }],
    };

    const p = pipeline(() =>
      sseResponse([
        frame(created),
        frame({
          type: "response.content_part.added",
          item_id: "rs_1",
          output_index: 0,
          content_index: 0,
          part: { type: "reasoning_text", text: "" },
        }),
        frame({
          type: "response.reasoning_text.delta",
          item_id: "rs_1",
          output_index: 0,
          content_index: 0,
          delta: "think",
        }),
        frame({
          type: "response.reasoning_text.done",
          item_id: "rs_1",
          output_index: 0,
          content_index: 0,
          text: "thinking",
        }),
        frame({ type: "response.output_item.done", output_index: 0, item: reasoningItem }),
        frame(completed()),
      ]),
    );

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "grok-4.3", input: "hi", stream: true }),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: response.reasoning_summary_part.added");
    expect(text).toContain("event: response.reasoning_summary_text.delta");
    expect(text).toContain("event: response.reasoning_summary_text.done");
    expect(text).toContain("event: response.reasoning_summary_part.done");
    expect(text).not.toContain("reasoning_text");
    expect(text).toContain('"summary_index":0');

    // The empty completed output is rebuilt from the done items, with summary_text parts.
    const completedLine = text
      .split("\n")
      .find((line) => line.startsWith("data:") && line.includes('"response.completed"'))!;

    const output = (
      JSON.parse(completedLine.slice(5)) as { response: { output: Array<{ summary: unknown[] }> } }
    ).response.output;

    expect(output[0]?.summary).toEqual([{ type: "summary_text", text: "thinking" }]);
    expect(p.records[0]?.detail.outputTokens).toBe(4);
  });

  it("hides server-side X Search traces when x_search is injected", async () => {
    const trace = {
      id: "fc_x",
      type: "custom_tool_call",
      call_id: "xs_call_1",
      name: "x_keyword_search",
      input: "{}",
    };

    const p = pipeline(
      () =>
        sseResponse([
          frame(created),
          frame({ type: "response.output_item.added", output_index: 0, item: trace }),
          frame({ type: "response.output_item.done", output_index: 0, item: trace }),
          frame({
            type: "response.output_text.delta",
            item_id: "msg_1",
            output_index: 1,
            delta: "ok",
          }),
          frame({ type: "response.output_item.done", output_index: 1, item: MESSAGE_ITEM }),
          frame(completed([trace, MESSAGE_ITEM])),
        ]),
      { config },
    );

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "grok-4.3", input: "hi", stream: true }),
    );

    const text = await response.text();
    expect(text).not.toContain("x_keyword_search");
    expect(text).not.toContain("xs_call_1");
    // The later output index is compacted.
    expect(text).toContain('"output_index":0');
    expect(text).not.toContain('"output_index":1');
    const upstream = JSON.parse(p.calls[0]!.body) as { tools: Array<{ type: string }> };
    expect(upstream.tools.map((tool) => tool.type)).toContain("x_search");
  });
});

describe("request shaping", () => {
  it("flattens namespace tools, converts custom tools and prunes orphaned tool choices", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));
    await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        input: [
          { type: "message", role: "user", content: "go" },
          { type: "custom_tool_call", call_id: "call_1", name: "shell", input: "ls" },
          { type: "custom_tool_call_output", call_id: "call_1", output: "files" },
          {
            type: "function_call",
            call_id: "call_2",
            name: "run",
            namespace: "mcp_ns",
            arguments: "{}",
          },
        ],
        tools: [
          { type: "tool_search" },
          { type: "image_generation" },
          { type: "custom", name: "shell", description: "d" },
          {
            type: "namespace",
            name: "mcp_ns",
            tools: [{ type: "function", name: "run", parameters: { type: "object" } }],
          },
          { type: "web_search", external_web_access: true },
        ],
        tool_choice: { type: "function", name: "gone" },
      }),
    );

    const upstream = JSON.parse(p.calls[0]!.body) as {
      tools: Array<Record<string, unknown>>;
      input: Array<Record<string, unknown>>;
      tool_choice?: unknown;
    };

    expect(upstream.tools).toEqual([
      {
        type: "function",
        name: "shell",
        description: "d",
        parameters: { type: "object", properties: {} },
      },
      { type: "function", name: "mcp_ns__run", parameters: { type: "object" } },
      { type: "web_search" },
    ]);
    expect(upstream.tool_choice).toBeUndefined();
    expect(upstream.input[1]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "shell",
      arguments: '{"input":"ls"}',
    });
    expect(upstream.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "files",
    });
    expect(upstream.input[3]).toMatchObject({ name: "mcp_ns__run" });
    expect("namespace" in (upstream.input[3] as object)).toBe(false);
  });

  it("folds namespaces into dispatcher tools above 200 tools and restores the calls in the response", async () => {
    const children = Array.from({ length: 205 }, (_, index) => ({
      type: "function",
      name: `t${index}`,
      description: `tool ${index}`,
      parameters: { type: "object", properties: { a: { type: "string" } } },
    }));

    const call = {
      id: "fc_1",
      type: "function_call",
      call_id: "call_9",
      name: "big",
      arguments: '{"name":"t7","arguments":{"a":"x"}}',
    };

    const p = pipeline(() =>
      sseResponse([
        frame(created),
        frame({
          type: "response.output_item.added",
          output_index: 0,
          item: { ...call, arguments: "" },
        }),
        frame({
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          output_index: 0,
          arguments: call.arguments,
        }),
        frame({ type: "response.output_item.done", output_index: 0, item: call }),
        frame(completed([call])),
      ]),
    );

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        input: "go",
        stream: true,
        tools: [{ type: "namespace", name: "big", description: "many", tools: children }],
      }),
    );

    const upstream = JSON.parse(p.calls[0]!.body) as {
      tools: Array<{
        name: string;
        description: string;
        parameters: { properties: { name: { enum: string[] } } };
      }>;
    };

    expect(upstream.tools).toHaveLength(1);
    expect(upstream.tools[0]?.name).toBe("big");
    expect(upstream.tools[0]?.description).toContain("- t7: tool 7");
    expect(upstream.tools[0]?.parameters.properties.name.enum).toHaveLength(205);
    const text = await response.text();
    const done = text.split("\n").find((line) => line.includes('"response.output_item.done"'))!;
    expect(JSON.parse(done.slice(5))).toMatchObject({
      item: { name: "t7", namespace: "big", arguments: '{"a":"x"}' },
    });
  });

  it("aliases a client function named web_search and restores it in the response", async () => {
    const call = {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "clientfn_web_search",
      arguments: "{}",
    };

    const p = pipeline(() =>
      sseResponse([
        frame(created),
        frame({ type: "response.output_item.done", output_index: 0, item: call }),
        frame(completed([call])),
      ]),
    );

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        input: "go",
        stream: true,
        tools: [{ type: "function", name: "web_search", parameters: { type: "object" } }],
      }),
    );

    expect(
      (JSON.parse(p.calls[0]!.body) as { tools: Array<{ name: string }> }).tools[0]?.name,
    ).toBe("clientfn_web_search");
    const text = await response.text();
    expect(text).toContain('"name":"web_search"');
    expect(text).not.toContain("clientfn_web_search");
  });

  it("drops invalid encrypted reasoning content and keeps replay-safe ciphertext", async () => {
    const good = grokCiphertext(11);
    const p = pipeline(() => sseResponse(TEXT_STREAM));
    await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        input: [
          { type: "reasoning", summary: [], content: null, encrypted_content: "not-a-grok-blob==" },
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "kept" }],
            encrypted_content: good,
          },
          { type: "compaction", encrypted_content: "gAAAAforeign" },
          { type: "message", role: "user", content: "hi" },
        ],
      }),
    );
    const upstream = JSON.parse(p.calls[0]!.body) as { input: Array<Record<string, unknown>> };
    expect(upstream.input).toHaveLength(3);
    expect("encrypted_content" in upstream.input[0]!).toBe(false);
    expect(upstream.input[1]?.["encrypted_content"]).toBe(good);
  });

  // Go a68c7d8e: OpenRouter's private router suffix (`.slug`) survives on openrouter.ai only; every other upstream gets the
  // native ciphertext.
  describe.each([
    ["the official API", xaiKey(), false],
    [
      "a third-party host",
      xaiKey({ attributes: { api_key: "k", base_url: "https://grok.example.test/v1" } }),
      false,
    ],
    [
      "openrouter.ai",
      xaiKey({ attributes: { api_key: "k", base_url: "https://openrouter.ai/api/v1" } }),
      true,
    ],
  ])("router-suffixed reasoning on %s", (_name, credential, keepsSuffix) => {
    it(
      keepsSuffix ? "keeps the suffix" : "strips the suffix to the native ciphertext",
      async () => {
        const native = grokCiphertext(11);
        const routed = routerSuffixed(native, 62);
        const p = pipeline(() => sseResponse(TEXT_STREAM), { credentials: [credential] });

        await p.call(
          "/v1/responses",
          postJson({
            model: "grok-4.3",
            input: [
              { type: "reasoning", summary: [], content: null, encrypted_content: routed },
              { type: "message", role: "user", content: "hi" },
            ],
          }),
        );

        const upstream = JSON.parse(p.calls[0]!.body) as { input: Array<Record<string, unknown>> };

        expect(upstream.input[0]?.["encrypted_content"]).toBe(keepsSuffix ? routed : native);
      },
    );
  });

  it("applies payload rules after every built-in change", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM), { config });
    await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        input: "hi",
        temperature: 0.2,
        tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
      }),
    );

    const body = JSON.parse(p.calls[0]!.body) as Record<string, unknown> & {
      tools: Array<{ name: string }>;
    };

    expect(body["metadata"]).toEqual({ via: "payload-rule" });
    // The rule renames the first tool after x_search injection and normalisation; the filter removes the temperature
    // that the translator preserved.
    expect(body.tools[0]?.name).toBe("rule_name");
    expect("temperature" in body).toBe(false);
    expect(body.tools.at(-1)).toEqual({ type: "x_search" });
  });
});

describe("error rules", () => {
  it("remaps a bad-credentials 403 to 401", async () => {
    const body = JSON.stringify({
      code: "bad-credentials",
      error: "The access token could not be validated",
    });

    const p = pipeline(
      () => new Response(body, { status: 403, headers: { "content-type": "application/json" } }),
    );

    const response = await p.call("/v1/responses", postJson({ model: "grok-4.3", input: "hi" }));
    expect(response.status).toBe(401);
    expect(p.log.reports[0]?.result).toMatchObject({ success: false, httpStatus: 401 });
  });

  it("keeps other 403s and gives free usage exhaustion a 24 hour cooldown hint", async () => {
    const forbidden = pipeline(() => new Response('{"error":"forbidden"}', { status: 403 }));
    expect(
      (await forbidden.call("/v1/responses", postJson({ model: "grok-4.3", input: "hi" }))).status,
    ).toBe(403);

    const exhausted = pipeline(
      () =>
        new Response(
          '{"code":"subscription:free-usage-exhausted","error":"You have used your included free usage"}',
          {
            status: 429,
          },
        ),
    );

    const response = await exhausted.call(
      "/v1/responses",
      postJson({ model: "grok-4.3", input: "hi" }),
    );

    expect(response.status).toBe(429);
    expect(exhausted.log.reports[0]?.result).toMatchObject({
      success: false,
      httpStatus: 429,
      retryAfterMs: 24 * 3600 * 1000,
    });

    const plain = pipeline(() => new Response('{"error":"slow down"}', { status: 429 }));
    await plain.call("/v1/responses", postJson({ model: "grok-4.3", input: "hi" }));
    expect(plain.log.reports[0]?.result.retryAfterMs).toBeUndefined();
  });
});

describe("/v1/responses/compact and compaction triggers", () => {
  const COMPACT_RESPONSE = {
    id: "cmp_abc",
    object: "response.compaction",
    created_at: 1767225600,
    model: "grok-4.3",
    output: [{ type: "compaction", encrypted_content: "opaque" }],
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  };

  it("posts compaction to the official API even for OAuth credentials", async () => {
    const p = pipeline(() => jsonResponse(COMPACT_RESPONSE));

    const response = await p.call(
      "/v1/responses/compact",
      postJson({
        model: "grok-4.3",
        input: "hi",
        tools: [{ type: "function", name: "f" }],
        temperature: 1,
        previous_response_id: "resp_0",
      }),
    );

    expect(response.status).toBe(200);
    const call = p.calls[0]!;
    expect(call.url).toBe("https://api.x.ai/v1/responses/compact");
    expect(call.headers["authorization"]).toBe("Bearer xai-access-1");
    expect(call.headers["x-xai-token-auth"]).toBeUndefined();
    const upstream = JSON.parse(call.body) as Record<string, unknown>;

    for (const field of ["stream", "tools", "temperature", "max_output_tokens"])
      expect(field in upstream).toBe(false);
    expect(upstream["previous_response_id"]).toBe("resp_0");
    expect(((await response.json()) as { id: string }).id).toBe("cmp_abc");
    expect(p.records[0]?.detail.inputTokens).toBe(5);
  });

  it("applies payload rules after the compact-specific shaping re-added previous_response_id", async () => {
    const p = pipeline(() => jsonResponse(COMPACT_RESPONSE), { config });

    const response = await p.call(
      "/v1/responses/compact",
      postJson({ model: "grok-4.3", input: "hi", previous_response_id: "resp_0" }),
    );

    expect(response.status).toBe(200);
    const upstream = JSON.parse(p.calls[0]!.body) as Record<string, unknown>;
    expect(upstream["metadata"]).toEqual({ compact: true });
    expect("previous_response_id" in upstream).toBe(false);
  });

  it("re-emits a compaction_trigger stream request as a synthetic Responses stream", async () => {
    const p = pipeline(() => jsonResponse(COMPACT_RESPONSE));

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        stream: true,
        input: [{ type: "message", role: "user", content: "hi" }, { type: "compaction_trigger" }],
      }),
    );

    expect(response.status).toBe(200);
    expect(p.calls[0]!.url).toBe("https://api.x.ai/v1/responses/compact");
    expect((JSON.parse(p.calls[0]!.body) as { input: unknown[] }).input).toHaveLength(1);
    const text = await response.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
    expect(events).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "keepalive",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(text).toContain('"id":"resp_abc"');
    expect(text).toContain('"id":"cmp_abc"');
  });
});

describe("reasoning replay", () => {
  it("re-inserts the encrypted reasoning of the previous turn for Responses clients", async () => {
    const encrypted = grokCiphertext(21);
    const reasoning = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: encrypted };

    const call = {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "f",
      arguments: "{}",
    };

    const p = pipeline(() =>
      sseResponse([
        frame(created),
        frame({ type: "response.output_item.done", output_index: 0, item: reasoning }),
        frame({ type: "response.output_item.done", output_index: 1, item: call }),
        frame(completed([reasoning, call])),
      ]),
    );

    const tools = [{ type: "function", name: "f", parameters: { type: "object" } }];

    const first = await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        prompt_cache_key: "conv-replay-1",
        input: "go",
        tools,
        stream: true,
      }),
    );

    await first.text();

    const second = await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        prompt_cache_key: "conv-replay-1",
        tools,
        stream: true,
        input: [
          { type: "message", role: "user", content: "go" },
          { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "done" },
        ],
      }),
    );

    await second.text();

    const upstream = JSON.parse(p.calls[1]!.body) as {
      input: Array<Record<string, unknown>>;
      prompt_cache_key: string;
    };

    expect(upstream.prompt_cache_key).toBe("conv-replay-1");
    const types = upstream.input.map((item) => item["type"] ?? "message");
    expect(types.filter((type) => type === "reasoning")).toHaveLength(1);
    const reasoningItem = upstream.input.find((item) => item["type"] === "reasoning")!;
    expect(reasoningItem["encrypted_content"]).toBe(encrypted);
    // The reasoning precedes the tool output it belongs to.
    expect(upstream.input.indexOf(reasoningItem)).toBeLessThan(
      upstream.input.findIndex((item) => item["type"] === "function_call_output"),
    );
  });
});

describe("session identity", () => {
  it("uses prompt_cache_key as conversation id and isolates composer models", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM), { credentials: [xaiKey()] });
    await p.call(
      "/v1/responses",
      postJson({ model: "grok-4.3", input: "hi", prompt_cache_key: "pck-1" }),
    );
    expect(p.calls[0]!.headers["x-grok-conv-id"]).toBe("pck-1");
    expect((JSON.parse(p.calls[0]!.body) as { prompt_cache_key: string }).prompt_cache_key).toBe(
      "pck-1",
    );

    await p.call("/v1/responses", postJson({ model: "grok-composer-2", input: "hi" }));
    expect(p.calls[1]!.headers["x-grok-conv-id"]).toMatch(/^[0-9a-f-]{36}$/);

    await p.call("/v1/responses", postJson({ model: "grok-4.3", input: "hi" }));
    expect(p.calls[2]!.headers["x-grok-conv-id"]).toBeUndefined();
  });
});

describe("client version", () => {
  it("reads the Grok CLI version the cron task stored in KV", async () => {
    await env.CACHE.put(XAI_VERSION_KV_KEY, "1.0.99");
    resetXaiClientVersionCache();

    try {
      const p = pipeline(() => sseResponse(TEXT_STREAM));
      await p.call("/v1/responses", postJson({ model: "grok-4.3", input: "hi" }));
      expect(p.calls[0]!.headers["x-grok-client-version"]).toBe("1.0.99");
      expect(p.calls[0]!.headers["user-agent"]).toBe("xai-grok-workspace/1.0.99");
    } finally {
      await env.CACHE.delete(XAI_VERSION_KV_KEY);
      resetXaiClientVersionCache();
    }
  });
});
