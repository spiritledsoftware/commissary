// End-to-end tests (workerd) of the Codex provider: /v1/responses (+compact, Codex aliases), chat completions routed
// to Codex, error classification, payload rules as the last mutation, images and alpha search against a mocked upstream.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.ts";
import {
  providerKeyCredential,
  codexModels,
  fixedPicker,
  oauthCredential,
  type PickerLog,
} from "./support/codex.ts";
import {
  jsonResponse,
  loadConfig,
  makePipeline,
  postJson,
  sseResponse,
  type UpstreamResponder,
} from "./support/pipeline.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import type { Json } from "@commissary/json";

const YAML = `
requests:
  payload:
    override:
      - models: [{ name: "gpt-5.4", protocol: codex }]
        params:
          "store": true
          "parallel_tool_calls": false
          "metadata.via": "payload-rule"
          "input.0.id": "msg_${"x".repeat(100)}"
    filter:
      - models: [{ name: "gpt-5.4", protocol: codex }]
        params: ["service_tier"]
`;

const created = (model = "gpt-5.4") => ({
  type: "response.created",
  response: {
    id: "resp_1",
    object: "response",
    created_at: 1767225600,
    model,
    status: "in_progress",
  },
});

const completed = (
  output: Json[] = [],
  usage: Json = { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
) => ({
  type: "response.completed",
  response: {
    id: "resp_1",
    status: "completed",
    created_at: 1767225600,
    model: "gpt-5.4",
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
  frame(created()),
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
  const log: PickerLog = { picks: [], reports: [] };

  const p = makePipeline({
    config: options.config ?? plainConfig,
    respond,
    credentialPicker: fixedPicker(options.credentials ?? [oauthCredential()], log),
    modelProviders: codexModels,
  });

  afterAll(p.dispose);

  return { ...p, log };
};

const RESPONSES_REQUEST = {
  model: "gpt-5.4(high)",
  instructions: "Be brief",
  input: "Say hi",
  stream: false,
  temperature: 0.7,
  max_output_tokens: 99,
  service_tier: "fast",
};

describe("POST /v1/responses (non-stream)", () => {
  it("shapes the upstream request, authenticates as the OAuth account and unwraps the completed response", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM.concat([])));

    const response = await p.call(
      "/v1/responses",
      postJson(RESPONSES_REQUEST, {
        "User-Agent": "my-client/1.0",
        Originator: "my-app",
        "Session-Id": "sess-7",
      }),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      id: string;
      output: unknown[];
      usage: Record<string, unknown>;
    };

    expect(body.id).toBe("resp_1");
    // The output was empty in response.completed and is rebuilt from output_item.done.
    expect(body.output).toEqual([MESSAGE_ITEM]);
    expect(body.usage).toEqual({
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
      output_tokens_details: { reasoning_tokens: 0 },
      input_tokens_details: { cached_tokens: 0 },
    });

    const call = p.calls[0]!;
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(call.headers["authorization"]).toBe("Bearer access-token-1");
    expect(call.headers["chatgpt-account-id"]).toBe("acct_123");
    // Cloaking forces the official client identity; the client's own Session-Id wins over the derived cache id.
    expect(call.headers["user-agent"]).toContain("codex-tui/");
    expect(call.headers["originator"]).toBe("codex-tui");
    expect(call.headers["session-id"]).toBe("sess-7");
    expect(call.headers["accept"]).toBe("text/event-stream");
    expect(call.headers["x-codex-routing-hint"]).toBe("model=gpt-5.4;tier=priority");
    expect(JSON.parse(call.body)).toEqual({
      model: "gpt-5.4",
      instructions: "Be brief",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say hi" }] }],
      stream: true,
      store: false,
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high" },
      service_tier: "priority",
      prompt_cache_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      tools: [{ type: "image_generation", output_format: "png" }],
    });
    expect(p.log.reports.map((report) => report.result.success)).toEqual([true]);
    expect(p.records[0]?.detail.inputTokens).toBe(10);
  });

  it("translates Chat Completions requests to Codex and back", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    const response = await p.call(
      "/v1/chat/completions",
      postJson({
        model: "gpt-5.4",
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

    const upstream = JSON.parse(p.calls[0]!.body) as {
      input: Array<{ role: string }>;
      reasoning: { effort: string };
    };

    expect(upstream.input.map((item) => item.role)).toEqual(["developer", "user"]);
    expect(upstream.reasoning.effort).toBe("medium");
  });

  it("serves the /backend-api/codex alias and accepts a provider-key credential with a custom base URL", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM), { credentials: [providerKeyCredential()] });

    const response = await p.call(
      "/backend-api/codex/responses",
      postJson({ model: "gpt-5.4", input: "hi" }),
    );

    expect(response.status).toBe(200);
    const call = p.calls[0]!;
    expect(call.url).toBe("https://codex.example.test/v1/responses");
    expect(call.headers["authorization"]).toBe("Bearer sk-codex-1");
    expect(call.headers["chatgpt-account-id"]).toBeUndefined();
    expect(call.headers["x-codex-routing-hint"]).toBeUndefined();
  });
});

describe("payload rules are the final mutation", () => {
  it("applies rules after every built-in change and after input id sanitising", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM), { config });

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "gpt-5.4",
        input: [{ type: "message", role: "user", id: "msg_user", content: "hi" }],
        tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
        service_tier: "fast",
      }),
    );

    expect(response.status).toBe(200);

    const body = JSON.parse(p.calls[0]!.body) as Record<string, unknown> & {
      input: Array<{ id: string }>;
    };

    // Built-ins force store=false/parallel_tool_calls=true, the override rule has the last word.
    expect(body["store"]).toBe(true);
    expect(body["parallel_tool_calls"]).toBe(false);
    expect(body["metadata"]).toEqual({ via: "payload-rule" });
    // The id sanitiser would shorten this; the rule value is kept verbatim.
    expect(body.input[0]?.id).toBe(`msg_${"x".repeat(100)}`);
    // A filter rule removes a field the translator set; the routing hint reads the final body.
    expect("service_tier" in body).toBe(false);
    expect(p.calls[0]!.headers["x-codex-routing-hint"]).toBe("model=gpt-5.4");
  });
});

describe("a Claude client's output_config.effort without a thinking object", () => {
  const request = (effort: string) =>
    postJson({
      model: "gpt-5.4",
      max_tokens: 20,
      output_config: { effort },
      messages: [{ role: "user", content: "hi" }],
    });

  const reasoningEffort = (body: string): string =>
    (JSON.parse(body) as { reasoning: { effort: string } }).reasoning.effort;

  it("reaches Codex as the reasoning effort instead of the medium default", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    expect((await p.call("/v1/messages", request(" High "))).status).toBe(200);
    expect(reasoningEffort(p.calls[0]!.body)).toBe("high");
  });

  it("is still overridden by a payload rule, which has the last word (ADR 0011)", async () => {
    const ruled = await loadConfig(`
requests:
  payload:
    override:
      - models: [{ name: "gpt-5.4", protocol: codex }]
        params: { "reasoning.effort": "low" }
`);

    const p = pipeline(() => sseResponse(TEXT_STREAM), { config: ruled });

    expect((await p.call("/v1/messages", request("high"))).status).toBe(200);
    expect(reasoningEffort(p.calls[0]!.body)).toBe("low");
  });
});

describe("POST /v1/responses (stream)", () => {
  it("frames upstream SSE lines, rebuilds an empty output and ends without [DONE]", async () => {
    // Lines arrive split at arbitrary byte boundaries.
    const joined = TEXT_STREAM.join("");
    const pieces = [joined.slice(0, 37), joined.slice(37, 400), joined.slice(400)];
    const p = pipeline(() => sseResponse(pieces));

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", input: "hi", stream: true }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toBe(
      [
        frame({ ...created(), response: { ...created().response } }),
        frame({
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          delta: "Hel",
        }),
        frame({
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          delta: "lo!",
        }),
        frame({ type: "response.output_item.done", output_index: 0, item: MESSAGE_ITEM }),
        frame(
          completed([MESSAGE_ITEM], {
            input_tokens: 10,
            output_tokens: 4,
            total_tokens: 14,
            output_tokens_details: { reasoning_tokens: 0 },
            input_tokens_details: { cached_tokens: 0 },
          }),
        ),
      ].join("") + "\n",
    );
    expect(JSON.parse(p.calls[0]!.body)).toMatchObject({ stream: true });
    expect(p.records).toHaveLength(1);
    expect(p.records[0]?.failed).toBe(false);
  });

  it("filters private codex.* events for ordinary clients but keeps response.metadata for Codex clients", async () => {
    const events = [
      frame({ type: "codex.rate_limits", rate_limits: { allowed: true } }),
      frame({ type: "codex.response.metadata", metadata: {} }),
      frame({ type: "response.metadata", metadata: { moderation: {} } }),
      ...TEXT_STREAM,
    ];

    const ordinary = pipeline(() => sseResponse(events));

    const plain = await (
      await ordinary.call(
        "/v1/responses",
        postJson({ model: "gpt-5.4", input: "hi", stream: true }),
      )
    ).text();

    expect(plain).not.toContain("codex.");
    expect(plain).not.toContain("response.metadata");
    const official = pipeline(() => sseResponse(events));

    const codex = await (
      await official.call(
        "/v1/responses",
        postJson(
          { model: "gpt-5.4", input: "hi", stream: true },
          { "User-Agent": "codex-tui/0.154.0" },
        ),
      )
    ).text();

    expect(codex).toContain("codex.response.metadata");
    expect(codex).toContain('"type":"response.metadata"');
    expect(codex).not.toContain("codex.rate_limits");
  });

  it("turns an upstream failure before the first payload into an HTTP error", async () => {
    const p = pipeline(() => sseResponse([]));

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", input: "hi", stream: true }),
    );

    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).toContain(
      "upstream stream closed before first payload",
    );
  });

  it("delivers in-stream failures as terminal error events (response.failed for Codex clients)", async () => {
    const events = [
      frame(created()),
      frame({
        type: "response.failed",
        sequence_number: 3,
        response: { error: { code: "server_error", message: "boom" } },
      }),
    ];

    const p = pipeline(() => sseResponse(events));

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", input: "hi", stream: true }, { Originator: "codex_cli_rs" }),
    );

    const text = await response.text();
    expect(text).toContain("event: response.failed");
    expect(text).toContain("boom");
    expect(text.trim().endsWith("}")).toBe(true);
    expect(p.records[0]?.failed).toBe(true);
  });

  it("reports a stream that stops before the terminal event as a request-scoped 408", async () => {
    const p = pipeline(() =>
      sseResponse([frame(created()), frame({ type: "response.output_text.delta", delta: "x" })]),
    );

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", input: "hi", stream: true }),
    );

    const text = await response.text();
    expect(text).toContain("event: error");
    expect(text).toContain("stream disconnected before completion");
    expect(p.log.reports[0]?.result).toMatchObject({
      success: false,
      httpStatus: 408,
      error: { code: "request_scoped" },
    });
  });

  it("treats response.incomplete without any output as a 502", async () => {
    const incomplete = {
      type: "response.incomplete",
      response: { status: "incomplete", output: [], usage: { output_tokens: 0 } },
    };

    const p = pipeline(() => sseResponse([frame(created()), frame(incomplete)]));

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", input: "hi", stream: true }),
    );

    expect(await response.text()).toContain("incomplete empty response (0 tokens)");
  });
});

describe("upstream error classification", () => {
  it("maps usage_limit_reached to a credential-scoped 429 with the reset time", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;

    const p = pipeline(() =>
      jsonResponse(
        { error: { type: "usage_limit_reached", message: "limit", resets_at: reset } },
        { status: 400 },
      ),
    );

    const response = await p.call("/v1/responses", postJson({ model: "gpt-5.4", input: "hi" }));
    expect(response.status).toBe(429);
    const result = p.log.reports[0]!.result;
    expect(result).toMatchObject({ success: false, httpStatus: 429, credentialScoped: true });
    expect(result.retryAfterMs).toBeGreaterThan(590_000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(600_000);
  });

  it("rewrites 401 and context-length bodies and keeps the status", async () => {
    const unauthorized = pipeline(() => new Response("nope", { status: 401 }));

    const r401 = await unauthorized.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", input: "hi" }),
    );

    expect(r401.status).toBe(401);
    expect(await r401.text()).toContain("auth_unavailable");
    expect(unauthorized.log.reports[0]?.result).toMatchObject({ success: false, httpStatus: 401 });

    const tooLong = pipeline(() =>
      jsonResponse(
        { error: { code: "context_length_exceeded", message: "too long" } },
        { status: 400 },
      ),
    );

    const r400 = await tooLong.call("/v1/responses", postJson({ model: "gpt-5.4", input: "hi" }));
    expect(await r400.text()).toContain("context_too_large");
  });

  it("fails over to the next credential after a credential-scoped usage limit", async () => {
    const p = pipeline(
      (call) =>
        call.headers["authorization"] === "Bearer access-token-1"
          ? jsonResponse(
              { error: { type: "usage_limit_reached", resets_in_seconds: 3600 } },
              { status: 429 },
            )
          : sseResponse(TEXT_STREAM),
      {
        credentials: [
          oauthCredential(),
          oauthCredential({
            id: "codex-oauth-2",
            metadata: { access_token: "access-token-2", account_id: "acct_2" },
          }),
        ],
      },
    );

    const response = await p.call("/v1/responses", postJson({ model: "gpt-5.4", input: "hi" }));
    expect(response.status).toBe(200);
    expect(p.calls.map((call) => call.headers["chatgpt-account-id"])).toEqual([
      "acct_123",
      "acct_2",
    ]);
    expect(p.log.reports.map((report) => report.result.success)).toEqual([false, true]);
  });

  it("surfaces a terminal failure inside a non-stream aggregation", async () => {
    const p = pipeline(() =>
      sseResponse([
        frame(created()),
        frame({ type: "error", error: { type: "rate_limit_error", message: "slow" } }),
      ]),
    );

    const response = await p.call("/v1/responses", postJson({ model: "gpt-5.4", input: "hi" }));
    expect(response.status).toBe(429);
  });

  it("answers 408 when the upstream body ends without a terminal event", async () => {
    const p = pipeline(() => sseResponse([frame(created())]));
    const response = await p.call("/v1/responses", postJson({ model: "gpt-5.4", input: "hi" }));
    expect(response.status).toBe(408);
  });
});

describe("POST /v1/responses/compact", () => {
  it("posts to /responses/compact without streaming and returns the JSON body", async () => {
    const compaction = {
      id: "resp_c",
      object: "response.compaction",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    const p = pipeline(() => jsonResponse(compaction));

    const response = await p.call(
      "/v1/responses/compact",
      postJson({ model: "gpt-5.4", input: "hi", stream: false }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(compaction);
    const call = p.calls[0]!;
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
    expect(call.headers["accept"]).toBe("application/json");
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect("stream" in body).toBe(false);
    expect(body["model"]).toBe("gpt-5.4");
  });

  it("rejects streaming requests", async () => {
    const p = pipeline(() => jsonResponse({}));

    const response = await p.call(
      "/backend-api/codex/responses/compact",
      postJson({ model: "gpt-5.4", input: "x", stream: true }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: "Streaming not supported for compact responses",
        type: "invalid_request_error",
      },
    });
    expect(p.calls).toHaveLength(0);
  });
});

describe("orphan tool outputs without a call_id (05e668cf)", () => {
  const ORPHAN_INPUT = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    {
      type: "function_call_output",
      id: "fco_1",
      name: "codex_apps_open_page",
      namespace: "agent",
      output: '{"page_id":null}',
    },
    {
      type: "custom_tool_call_output",
      id: "fco_2",
      name: "custom_ctx",
      output: [
        { type: "input_text", text: "part one" },
        { type: "input_text", text: "part two" },
        { type: "input_image", image_url: "https://example.com/page.png" },
      ],
    },
    { type: "function_call", call_id: "call_ok", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "call_ok", output: "ok" },
    { type: "function_call_output", call_id: " ", output: "blank id" },
    { type: "function_call", call_id: "call_pair", name: "shell", arguments: "{}" },
    { type: "function_call_output", output: "paired without call_id" },
  ];

  const check = (input: Array<Record<string, unknown>>) => {
    expect(input).toHaveLength(ORPHAN_INPUT.length);
    expect(input[1]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: 'Tool output from codex_apps_open_page:\n{"page_id":null}' },
      ],
    });
    expect(input[2]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Tool output from custom_ctx:\npart one\npart two" },
        { type: "input_image", image_url: "https://example.com/page.png" },
      ],
    });
    expect(input[4]).toMatchObject({ type: "function_call_output", call_id: "call_ok" });
    expect(input[5]).toMatchObject({
      type: "message",
      content: [{ type: "input_text", text: "Tool output from tool:\nblank id" }],
    });
    expect(input[7]).toMatchObject({ type: "function_call_output", call_id: "call_pair" });
  };

  it("rewrites them to user messages on /v1/responses", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM.concat([])));

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", stream: false, input: ORPHAN_INPUT }),
    );

    expect(response.status).toBe(200);
    check(JSON.parse(p.calls[0]!.body).input);
  });

  it("rewrites them on /v1/responses/compact, which skips the Codex translator", async () => {
    const p = pipeline(() =>
      jsonResponse({ id: "resp_c", object: "response.compaction", output: [] }),
    );

    const response = await p.call(
      "/v1/responses/compact",
      postJson({ model: "gpt-5.4", stream: false, input: ORPHAN_INPUT }),
    );

    expect(response.status).toBe(200);
    check(JSON.parse(p.calls[0]!.body).input);
  });
});

describe("images", () => {
  const IMAGE = { created: 1767225600, data: [{ b64_json: "QUJD" }], usage: { total_tokens: 5 } };

  it("generations go to the direct Codex images endpoint with the model set", async () => {
    const p = pipeline(() => jsonResponse(IMAGE));

    const response = await p.call(
      "/v1/images/generations",
      postJson(
        { model: "openai/gpt-image-2", prompt: "a cat", size: "1024x1024" },
        { "User-Agent": "client/1" },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(IMAGE);
    const call = p.calls[0]!;
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(JSON.parse(call.body)).toEqual({
      model: "gpt-image-2",
      prompt: "a cat",
      size: "1024x1024",
    });
    expect(call.headers["accept"]).toBe("application/json");
  });

  it("multipart edits are converted to JSON and free-plan credentials are skipped", async () => {
    const form = new FormData();
    form.set("prompt", "make it blue");
    form.set("n", "2");
    form.append("image[]", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    form.set("mask", new File([new Uint8Array([9])], "m.png", { type: "image/png" }));

    const p = pipeline(() => jsonResponse(IMAGE), {
      credentials: [
        oauthCredential({ id: "free", attributes: { plan_type: "free" } }),
        oauthCredential({ id: "paid" }),
      ],
    });

    const response = await p.call("/v1/images/edits", { method: "POST", body: form });

    if (response.status !== 200) throw new Error(await response.text());
    expect(response.status).toBe(200);
    expect(p.log.picks.map((pick) => pick.disallowFree)).toEqual([true]);
    expect(p.calls).toHaveLength(1);
    const call = p.calls[0]!;
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(JSON.parse(call.body)).toEqual({
      model: "gpt-image-2",
      prompt: "make it blue",
      n: 2,
      mask: { image_url: "data:image/png;base64,CQ==" },
      images: [{ image_url: "data:image/png;base64,AQID" }],
    });
  });

  it("streams direct image events and validates the request", async () => {
    const sse =
      'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image"}\n\n';

    const p = pipeline(() => sseResponse([sse]));

    const response = await p.call(
      "/v1/images/generations",
      postJson({ prompt: "x", stream: true }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("image_generation.partial_image");
    expect(JSON.parse(p.calls[0]!.body)).toEqual({
      model: "gpt-image-2",
      prompt: "x",
      stream: true,
    });

    expect(
      (await p.call("/v1/images/generations", postJson({ model: "gpt-image-2" }))).status,
    ).toBe(400);
    expect(
      (await p.call("/v1/images/generations", postJson({ model: "dall-e-3", prompt: "x" }))).status,
    ).toBe(400);
  });
});

describe("POST /v1/alpha/search", () => {
  it("forwards the sanitised body with the OAuth account and returns the upstream answer unchanged", async () => {
    const p = pipeline(
      () =>
        new Response('{"results":[]}', {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    );

    const response = await p.call(
      "/v1/alpha/search",
      postJson({
        id: "s1",
        model: "gpt-5.4",
        query: "q",
        prompt_cache_key: "k",
        prompt_cache_retention: "24h",
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('{"results":[]}');
    const call = p.calls[0]!;
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
    expect(call.headers["chatgpt-account-id"]).toBe("acct_123");
    expect(call.headers["originator"]).toBe("codex_cli_rs");
    expect(JSON.parse(call.body)).toEqual({ id: "s1", model: "gpt-5.4", query: "q" });
  });

  it("only uses provider keys with alpha-search enabled and needs a base URL", async () => {
    const p = pipeline(() => jsonResponse({ ok: true }), {
      credentials: [
        providerKeyCredential({ id: "plain" }),
        providerKeyCredential({
          id: "alpha",
          attributes: { api_key: "k", base_url: "https://s.test/v1/", codex_alpha_search: "true" },
        }),
      ],
    });

    const response = await p.call(
      "/backend-api/codex/alpha/search",
      postJson({ model: "gpt-5.4", query: "q" }),
    );

    expect(response.status).toBe(200);
    expect(p.calls[0]!.url).toBe("https://s.test/v1/alpha/search");
    expect(p.calls[0]!.headers["authorization"]).toBe("Bearer k");
  });
});

describe("Codex multi-agent v2 and orphan delegation", () => {
  const COLLAB_YAML = `
client:
  codex:
    optimize-multi-agent-v2: true
upstream:
  codex:
    orphan-delegation-compatibility: true
`;

  const spawnTool = {
    type: "function",
    name: "spawn_agent",
    description: "Spawns an agent.",
    parameters: {
      type: "object",
      properties: { message: { type: "string", encrypted: true } },
    },
  };

  const collaboration = (name = "collaboration") => ({
    type: "namespace",
    name,
    tools: [spawnTool],
  });

  const callItem = {
    id: "fc_1",
    type: "function_call",
    status: "completed",
    namespace: "collaboration-optimize",
    name: "spawn_agent",
    call_id: "call_1",
    arguments: '{"message":"go"}',
  };

  const CODEX_UA = { "User-Agent": "codex-tui/0.150.0" };

  const toolStream = [
    frame(created()),
    frame({ type: "response.output_item.done", output_index: 0, item: callItem }),
    frame(completed([callItem])),
  ];

  it("renames the collaboration namespace upstream, restores it in the answer and converts agent messages", async () => {
    const multi = await loadConfig(COLLAB_YAML);
    const p = pipeline(() => sseResponse(toolStream), { config: multi });

    const response = await p.call(
      "/v1/responses",
      postJson(
        {
          model: "gpt-5.4",
          stream: false,
          tools: [collaboration()],
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
            {
              type: "agent_message",
              content: [{ type: "encrypted_content", encrypted_content: "plan" }],
            },
          ],
        },
        CODEX_UA,
      ),
    );

    expect(response.status).toBe(200);

    const upstream = JSON.parse(p.calls[0]!.body) as {
      tools: Array<{
        name: string;
        tools: Array<{ parameters: { properties: { message: Record<string, unknown> } } }>;
      }>;
      input: Array<Record<string, unknown>>;
    };

    expect(upstream.tools[0]?.name).toBe("collaboration-optimize");
    expect(upstream.tools[0]?.tools[0]?.parameters.properties.message).toEqual({ type: "string" });
    // The Codex executor keeps agent_message items (only compat models convert them); the encrypted part is plain text.
    expect(upstream.input[1]).toEqual({
      type: "agent_message",
      content: [{ type: "input_text", text: "plan" }],
    });
    const body = (await response.json()) as { output: Array<Record<string, unknown>> };
    expect(body.output[0]).toMatchObject({
      type: "function_call",
      namespace: "collaboration",
      name: "spawn_agent",
    });
  });

  it("restores the namespace in streamed events too", async () => {
    const multi = await loadConfig(COLLAB_YAML);
    const p = pipeline(() => sseResponse(toolStream), { config: multi });

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", stream: true, tools: [collaboration()], input: "go" }, CODEX_UA),
    );

    const text = await response.text();
    expect(text).toContain('"namespace":"collaboration"');
    expect(text).not.toContain("collaboration-optimize");
  });

  it("leaves other clients and an existing collaboration-optimize namespace alone", async () => {
    const multi = await loadConfig(COLLAB_YAML);
    const p = pipeline(() => sseResponse(TEXT_STREAM.concat([])), { config: multi });
    await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", stream: false, tools: [collaboration()], input: "go" }),
    );
    expect(
      (JSON.parse(p.calls[0]!.body) as { tools: Array<{ name: string }> }).tools[0]?.name,
    ).toBe("collaboration");
    await p.call(
      "/v1/responses",
      postJson(
        {
          model: "gpt-5.4",
          stream: false,
          tools: [collaboration(), collaboration("collaboration-optimize")],
          input: "go",
        },
        CODEX_UA,
      ),
    );

    const names = (JSON.parse(p.calls[1]!.body) as { tools: Array<{ name: string }> }).tools
      .map((tool) => tool.name)
      .filter((name) => name !== undefined);

    expect(names).toEqual(["collaboration", "collaboration-optimize"]);
  });

  it("downgrades orphan codex_app delegation outputs for collab_spawn subagents only", async () => {
    const multi = await loadConfig(COLLAB_YAML);
    const p = pipeline(() => sseResponse(TEXT_STREAM.concat([])), { config: multi });

    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        type: "function_call_output",
        call_id: "orphan",
        namespace: "codex_app",
        name: "create_thread",
        output: "T1",
      },
    ];

    await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", stream: false, input }, { "X-Openai-Subagent": "collab_spawn" }),
    );
    const rewritten = JSON.parse(p.calls[0]!.body) as { input: Array<Record<string, unknown>> };
    expect(rewritten.input[1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Tool output from codex_app__create_thread:\nT1" }],
    });
    await p.call("/v1/responses", postJson({ model: "gpt-5.4", stream: false, input }));
    expect(
      (JSON.parse(p.calls[1]!.body) as { input: Array<Record<string, unknown>> }).input[1]?.type,
    ).toBe("function_call_output");
  });
});
