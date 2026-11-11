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
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import { Effect } from "effect";
import { makeCodexExecutor } from "../src/executor/codex/executor.ts";
import { sealCompaction, unsealCompaction } from "../src/executor/helps/compaction.ts";
import {
  credential as executorCredential,
  harness,
  options as executorOptions,
} from "./support/executor-run.ts";

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

  it.each([
    "gpt-image-2.6",
    "gpt-image-2.6-flare",
    "gpt-image-2.6-sunburst",
    "codex/gpt-image-2.6",
  ])("accepts the gpt-image-2.6 model %s", async (model) => {
    const p = pipeline(() => jsonResponse(IMAGE));

    const response = await p.call("/v1/images/generations", postJson({ model, prompt: "a cat" }));

    expect(response.status).toBe(200);
    expect(p.calls[0]!.url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
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

const hostedTools = (body: string): Json | undefined => get(tryParseJson(body), "tools");

// d1e5cc60 (+ 714f0526, 8fb60326): hosted image_generation on Codex Responses-Lite routes.
describe("hosted image_generation on Responses-Lite routes", () => {
  const FORCED = {
    tools: [{ type: "image_generation" }],
    tool_choice: { type: "image_generation" },
  };

  it.each(["gpt-6-sol", "gpt-5.6-sol", "codex/gpt-6-astra"])(
    "rejects a forced hosted image_generation on the lite model %s with a request-scoped 400",
    async (model) => {
      const p = pipeline(() => sseResponse(TEXT_STREAM));

      const response = await p.call("/v1/responses", postJson({ model, input: "draw", ...FORCED }));

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("/v1/images/generations");
      expect(text).toContain("/v1/images/edits");
      expect(p.calls).toHaveLength(0);
      expect(p.log.reports[0]?.result).toMatchObject({ success: false, httpStatus: 400 });
      expect(p.log.reports[0]?.result.credentialScoped).not.toBe(true);
    },
  );

  it.each([
    [
      "required with only image_generation declared",
      { tools: [{ type: "image_generation" }], tool_choice: "required" },
    ],
    [
      "allowed_tools required",
      {
        tools: [{ type: "function", name: "lookup" }, { type: "image_generation" }],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [{ type: "image_generation" }],
        },
      },
    ],
  ])("rejects %s", async (_name, fields) => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-6-sol", input: "draw", ...fields }),
    );

    expect(response.status).toBe(400);
    expect(p.calls).toHaveLength(0);
  });

  it.each([
    ["tool_choice omitted", { tools: [{ type: "image_generation" }] }],
    ["tool_choice auto", { tools: [{ type: "image_generation" }], tool_choice: "auto" }],
    [
      "required with another tool declared",
      {
        tools: [{ type: "image_generation" }, { type: "function", name: "lookup" }],
        tool_choice: "required",
      },
    ],
  ])("lets %s through on a lite model", async (_name, fields) => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-6-sol", input: "draw", ...fields }),
    );

    expect(response.status).toBe(200);
    expect(p.calls).toHaveLength(1);
  });

  it("rejects when the lite route is selected by the header, but not on a legacy model", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    const lite = await p.call(
      "/v1/responses",
      postJson(
        { model: "gpt-5.4", input: "draw", ...FORCED },
        { "X-OpenAI-Internal-Codex-Responses-Lite": "true" },
      ),
    );

    expect(lite.status).toBe(400);

    const legacy = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", input: "draw", ...FORCED }),
    );

    expect(legacy.status).toBe(200);
  });

  it("forwards the request on a provider-key credential", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM), { credentials: [providerKeyCredential()] });

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-6-sol", input: "draw", ...FORCED }),
    );

    expect(response.status).toBe(200);
    expect(p.calls).toHaveLength(1);
  });

  it("forwards the request under disable-image-generation: passthrough", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM), {
      config: await loadConfig("multimedia:\n  disable-image-generation: passthrough\n"),
    });

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-6-sol", input: "draw", ...FORCED }),
    );

    expect(response.status).toBe(200);
    expect(hostedTools(p.calls[0]!.body)).toEqual([{ type: "image_generation" }]);
  });

  it("injects the hosted tool on a lite model without reasoning, not with reasoning effort", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    await p.call("/v1/responses", postJson({ model: "gpt-6-sol", input: "hi" }));
    await p.call(
      "/v1/responses",
      postJson({ model: "gpt-6-sol", input: "hi", reasoning: { effort: "high" } }),
    );
    await p.call(
      "/v1/responses",
      postJson(
        { model: "gpt-6-sol", input: "hi" },
        { "X-OpenAI-Internal-Codex-Responses-Lite": "true" },
      ),
    );

    expect(hostedTools(p.calls[0]!.body)).toEqual([
      { type: "image_generation", output_format: "png" },
    ]);
    expect(hostedTools(p.calls[1]!.body)).toBeUndefined();
    expect(hostedTools(p.calls[2]!.body)).toBeUndefined();
  });

  it("strips the unsupported complexity parameter from declared hosted tools", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    await p.call(
      "/v1/responses",
      postJson({
        model: "gpt-5.4",
        input: "draw",
        tools: [{ type: "image_generation", complexity: "high", size: "1024x1024" }],
      }),
    );

    expect(hostedTools(p.calls[0]!.body)).toEqual([
      { type: "image_generation", size: "1024x1024" },
    ]);
  });

  it("maps an image_generation_user_error terminal failure to 400 with remediation guidance", async () => {
    const p = pipeline(() =>
      sseResponse([
        frame(created()),
        frame({
          type: "response.failed",
          response: {
            status: "failed",
            error: {
              type: "image_generation_user_error",
              code: "invalid_value",
              message: "Complexity 'medium' is not supported for this image model.",
              param: "complexity",
            },
          },
        }),
      ]),
    );

    const response = await p.call("/v1/responses", postJson({ model: "gpt-5.4", input: "hi" }));

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("/v1/images/generations");
    expect(text).toContain("gpt-5.4-mini");
  });
});

describe("auto-injected hosted tool after payload rules (714f0526)", () => {
  const rule = (params: string) => `
requests:
  payload:
    override:
      - models: [{ name: "gpt-6-sol", protocol: codex }]
        params:
${params}
`;

  const call = async (yaml: string, body: Json) => {
    const p = pipeline(() => sseResponse(TEXT_STREAM), { config: await loadConfig(yaml) });

    const response = await p.call("/v1/responses", postJson(body));

    expect(response.status).toBe(200);

    return get(tryParseJson(p.calls[0]!.body), "tools");
  };

  it("retracts the injected tool when a rule sets reasoning effort on a lite model", async () => {
    const tools = await call(rule('          "reasoning.effort": "high"'), {
      model: "gpt-6-sol",
      input: "hi",
    });

    expect(tools).toBeUndefined();
  });

  it("retracts nothing when no payload rules are configured", async () => {
    const tools = await call("requests: {}", { model: "gpt-6-sol", input: "hi" });

    expect(tools).toEqual([{ type: "image_generation", output_format: "png" }]);
  });

  it("keeps the injected tool when the rule does not make the payload incompatible", async () => {
    const tools = await call(rule('          "metadata.via": "rule"'), {
      model: "gpt-6-sol",
      input: "hi",
    });

    expect(tools).toEqual([{ type: "image_generation", output_format: "png" }]);
  });

  it("keeps the client's own tools and removes only the injected one", async () => {
    const tools = await call(rule('          "reasoning.effort": "high"'), {
      model: "gpt-6-sol",
      input: "hi",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    });

    expect(tools).toEqual([{ type: "function", name: "lookup", parameters: { type: "object" } }]);
  });

  it("keeps the tool when a rule selects it through tool_choice", async () => {
    const tools = await call(
      rule(
        '          "reasoning.effort": "high"\n          "tool_choice": { type: allowed_tools, mode: auto, tools: [{ type: image_generation }] }',
      ),
      { model: "gpt-6-sol", input: "hi" },
    );

    expect(tools).toEqual([{ type: "image_generation", output_format: "png" }]);
  });
});

describe("lite routing from credential and model headers", () => {
  const LITE = "header:X-OpenAI-Internal-Codex-Responses-Lite";

  it("a credential header attribute stops the injection and makes the forced request fail", async () => {
    const credentials = [oauthCredential({ attributes: { [LITE]: "true" } })];
    const p = pipeline(() => sseResponse(TEXT_STREAM), { credentials });

    const plain = await p.call("/v1/responses", postJson({ model: "gpt-5.4", input: "hi" }));

    expect(plain.status).toBe(200);
    expect(hostedTools(p.calls[0]!.body)).toBeUndefined();

    const forced = await p.call(
      "/v1/responses",
      postJson({
        model: "gpt-5.4",
        input: "draw",
        tools: [{ type: "image_generation" }],
        tool_choice: { type: "image_generation" },
      }),
    );

    expect(forced.status).toBe(400);
  });
});

describe("compaction is not validated", () => {
  it("forwards a forced hosted tool on a lite model to /responses/compact", async () => {
    const p = pipeline(() =>
      jsonResponse({ id: "resp_c", object: "response.compaction", output: [] }),
    );

    const response = await p.call(
      "/v1/responses/compact",
      postJson({
        model: "gpt-6-sol",
        input: "hi",
        tools: [{ type: "image_generation" }],
        tool_choice: { type: "image_generation" },
      }),
    );

    expect(response.status).toBe(200);
    expect(p.calls).toHaveLength(1);
  });
});

describe("streamed image_generation_user_error", () => {
  it("is delivered as a 400 failure with remediation guidance", async () => {
    const p = pipeline(() =>
      sseResponse([
        frame(created()),
        frame({
          type: "error",
          error: {
            type: "image_generation_user_error",
            code: "invalid_value",
            message: "Complexity 'medium' is not supported for this image model.",
            param: "complexity",
          },
        }),
      ]),
    );

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", input: "hi", stream: true }),
    );

    const text = await response.text();

    expect(text).toContain("event: error");
    expect(text).toContain("/v1/images/generations");
    expect(text).toContain("gpt-5.4-mini");
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

describe("CPA compaction capsules on a native Codex model", () => {
  const capsule = async () => ({
    type: "compaction",
    id: "cmp_ag_compact_1",
    encrypted_content: await sealCompaction("earlier work", "claude-sonnet-4-5"),
  });

  const nativeItem = { type: "compaction", id: "cmp_native", encrypted_content: "gAAAA-native" };

  const userMessage = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "continue" }],
  };

  const upstreamInput = (call: { readonly body: string }): Json[] => {
    const input = get(tryParseJson(call.body), "input");

    return Array.isArray(input) ? input : [];
  };

  const expectExpanded = (call: { readonly body: string }) => {
    expect(call.body).not.toContain("cpa-ag-compact-v1:");
    const input = upstreamInput(call);
    expect(input[0]).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Context summary from previous turns:\nearlier work" }],
    });
    expect(input[1]).toEqual(nativeItem);
  };

  it("expands a capsule on a non-stream request and keeps a native item verbatim", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "gpt-5.4",
        stream: false,
        input: [await capsule(), nativeItem, userMessage],
      }),
    );

    expect(response.status).toBe(200);
    expectExpanded(p.calls[0]!);
  });

  it("expands a capsule on a stream request", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "gpt-5.4",
        stream: true,
        input: [await capsule(), nativeItem, userMessage],
      }),
    );

    await response.text();
    expectExpanded(p.calls[0]!);
  });

  it("expands a capsule on /v1/responses/compact", async () => {
    const p = pipeline(() =>
      jsonResponse({ id: "resp_c", object: "response.compaction", output: [], usage: {} }),
    );

    const response = await p.call(
      "/v1/responses/compact",
      postJson({ model: "gpt-5.4", input: [await capsule(), nativeItem, userMessage] }),
    );

    expect(response.status).toBe(200);
    expect(p.calls[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
    expectExpanded(p.calls[0]!);
  });

  it("answers a corrupt capsule with a request-scoped 400 and no upstream call", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "gpt-5.4",
        stream: false,
        input: [
          {
            type: "compaction",
            id: "cmp_ag_compact_9",
            encrypted_content: "cpa-ag-compact-v1:AAAA",
          },
          userMessage,
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("invalid compaction capsule");
    expect(p.calls).toHaveLength(0);
    expect(p.log.reports.at(-1)?.result.error?.code).toBe("request_scoped");
  });

  it("forwards a native compaction_trigger unchanged", async () => {
    const p = pipeline(() => sseResponse(TEXT_STREAM));

    await p.call(
      "/v1/responses",
      postJson({
        model: "gpt-5.4",
        stream: false,
        input: [userMessage, { type: "compaction_trigger" }],
      }),
    );

    expect(p.calls).toHaveLength(1);
    expect(upstreamInput(p.calls[0]!).at(-1)).toEqual({ type: "compaction_trigger" });
  });

  it("counts the expanded payload", async () => {
    const h = await harness(
      executorCredential("codex", { metadata: { access_token: "t" } }),
      () => new Response("no", { status: 500 }),
    );

    const executor = makeCodexExecutor();

    const count = (input: Json[]) =>
      Effect.runPromise(
        executor
          .countTokens(
            h.context,
            { model: "gpt-5.4", payload: { model: "gpt-5.4", input } },
            executorOptions({ sourceFormat: "openai-response" }),
          )
          .pipe(Effect.provide(h.layers)),
      ).then((response) => get(tryParseJson(response.payload), "input_tokens"));

    const sealed = await count([await capsule(), userMessage]);

    const written = await count([
      {
        type: "message",
        role: "developer",
        content: [
          { type: "input_text", text: "Context summary from previous turns:\nearlier work" },
        ],
      },
      userMessage,
    ]);

    expect(sealed).toBe(written);
    expect(h.calls).toHaveLength(0);
  });
});

describe("local compaction on an is-compat Codex model", () => {
  const compatYaml = (keys: ReadonlyArray<string> = ["sk-codex-1"]) => `
api-keys:
  codex:
    - base-url: https://codex.example.test/v1
      keys:
${keys
  .map(
    (key) => `        - api-key: ${key}
          models:
            - name: gpt-5.4
              is-compat: true`,
  )
  .join("\n")}
requests:
  payload:
    override:
      - models: [{ name: "gpt-5.4", protocol: codex }]
        params:
          "metadata.via": "payload-rule"
`;

  const userMessage = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "fix the bug" }],
  };

  const assistantMessage = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "OK" }],
  };

  const foreign = { type: "compaction", id: "cmp_native", encrypted_content: "gAAAA-native" };
  const trigger = { type: "compaction_trigger" };

  const summaryStream = (text = "the summary", status = "completed") => [
    frame(created()),
    frame({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_s",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    }),
    frame({
      type: status === "completed" ? "response.completed" : "response.incomplete",
      response: {
        id: "resp_1",
        status,
        created_at: 1767225600,
        model: "gpt-5.4",
        output: [],
        ...(status === "completed" ? {} : { incomplete_details: { reason: "max_output_tokens" } }),
        usage: { input_tokens: 21, output_tokens: 6, total_tokens: 27 },
      },
    }),
  ];

  const compat = async (respond: UpstreamResponder, extra: Partial<Options> = {}) => {
    const compatConfig = await loadConfig(compatYaml());

    return pipeline(respond, {
      config: compatConfig,
      credentials: [providerKeyCredential()],
      ...extra,
    });
  };

  const capsuleOf = (body: Json): string => asString(get(body, "output.0.encrypted_content"));

  it("answers a non-stream compaction_trigger with one HTTP summary request and a sealed response", async () => {
    const p = await compat(() => sseResponse(summaryStream()));

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "gpt-5.4",
        stream: false,
        input: [foreign, userMessage, assistantMessage, trigger],
      }),
    );

    expect(response.status).toBe(200);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.url).toBe("https://codex.example.test/v1/responses");
    const upstream = JSON.parse(p.calls[0]!.body) as Json;
    expect(JSON.stringify(upstream)).not.toContain("compaction_trigger");
    expect(JSON.stringify(upstream)).not.toContain("gAAAA-native");
    expect(JSON.stringify(upstream)).not.toContain("image_generation");
    expect(get(upstream, "previous_response_id")).toBeUndefined();
    expect(get(upstream, "metadata.via")).toBe("payload-rule");
    const input = get(upstream, "input") as Json[];
    expect(get(input.at(-1), "content.0.text")).toContain("concise and comprehensive summary");
    const body: Json = await response.json();
    expect(get(body, "object")).toBe("response.compaction");
    expect(await unsealCompaction(capsuleOf(body))).toBe("the summary");
    expect(get(body, "usage")).toMatchObject({
      input_tokens: 21,
      output_tokens: 6,
      total_tokens: 27,
    });
    expect(p.records).toHaveLength(1);
    expect(p.records[0]).toMatchObject({ model: "gpt-5.4", failed: false });
    expect(p.records[0]?.detail).toMatchObject({ inputTokens: 21, outputTokens: 6 });
  });

  it("answers a streaming compaction_trigger with the synthetic Responses stream", async () => {
    const p = await compat(() => sseResponse(summaryStream()));

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", stream: true, input: [userMessage, assistantMessage, trigger] }),
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: response.completed");
    const sealed = text.match(/cpa-ag-compact-v1:[A-Za-z0-9_-]+/)?.[0] ?? "";
    expect(await unsealCompaction(sealed)).toBe("the summary");
    expect(p.calls).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(p.calls[0]!.body))).not.toContain("compaction_trigger");
  });

  it("drops foreign compaction items from an ordinary request and expands capsules", async () => {
    const p = await compat(() => sseResponse(TEXT_STREAM));

    await p.call(
      "/v1/responses",
      postJson({
        model: "gpt-5.4",
        stream: false,
        input: [
          foreign,
          {
            type: "compaction",
            id: "cmp_ag_compact_1",
            encrypted_content: await sealCompaction("earlier work", "m"),
          },
          userMessage,
        ],
      }),
    );

    expect(p.calls[0]!.body).not.toContain("gAAAA-native");
    expect(p.calls[0]!.body).toContain("earlier work");
    // The control for the summary request's missing image tool: an ordinary request gets it.
    expect(p.calls[0]!.body).toContain("image_generation");
  });

  it("keeps /responses/compact upstream and forwards a native item", async () => {
    const p = await compat(() =>
      jsonResponse({ id: "resp_c", object: "response.compaction", output: [], usage: {} }),
    );

    await p.call(
      "/v1/responses/compact",
      postJson({ model: "gpt-5.4", input: [foreign, userMessage] }),
    );
    expect(p.calls[0]!.url).toBe("https://codex.example.test/v1/responses/compact");
    expect(p.calls[0]!.body).toContain("gAAAA-native");
  });

  it("answers an incomplete summary with a request-scoped 502 and picks the credential again next time", async () => {
    const p = await compat(() => sseResponse(summaryStream("half a summ", "incomplete")));

    const first = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", stream: false, input: [userMessage, trigger] }),
    );

    expect(first.status).toBe(502);
    expect(p.log.reports.at(-1)?.result.error?.code).toBe("request_scoped");
    expect(p.records).toHaveLength(1);
    expect(p.records[0]).toMatchObject({ failed: true });
    expect(p.records[0]?.detail).toMatchObject({ inputTokens: 21 });

    await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", stream: false, input: [userMessage, trigger] }),
    );
    expect(p.log.picks.map((pick) => pick.excluded)).toEqual([[], []]);
  });

  it.each([
    ["empty conversation input", { input: [trigger] }],
    [
      "a previous_response_id source",
      { previous_response_id: "resp_1", input: [userMessage, trigger] },
    ],
  ])("refuses %s with a 400 and no upstream call", async (_name, extra) => {
    const p = await compat(() => sseResponse(summaryStream()));

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", stream: false, ...extra }),
    );

    expect(response.status).toBe(400);
    expect(p.calls).toHaveLength(0);
  });

  it("refuses an ordinary request that continues a synthetic compaction response", async () => {
    const p = await compat(() => sseResponse(TEXT_STREAM));

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "gpt-5.4",
        stream: false,
        previous_response_id: "resp_ag_compact_123",
        input: [userMessage],
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("local compaction response");
    expect(p.calls).toHaveLength(0);
  });

  it("runs the whole compaction again on the next credential after a failed summary", async () => {
    const second = providerKeyCredential({
      id: "codex-key-2",
      attributes: { api_key: "sk-codex-2", base_url: "https://codex.example.test/v1" },
    });

    const config = await loadConfig(compatYaml(["sk-codex-1", "sk-codex-2"]));

    const p = pipeline(
      (call) =>
        call.headers["authorization"] === "Bearer sk-codex-1"
          ? jsonResponse({ error: { message: "boom" } }, { status: 500 })
          : sseResponse(summaryStream()),
      { config, credentials: [providerKeyCredential(), second] },
    );

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "gpt-5.4", stream: false, input: [userMessage, trigger] }),
    );

    expect(response.status).toBe(200);
    expect(p.calls.map((call) => call.headers["authorization"])).toEqual([
      "Bearer sk-codex-1",
      "Bearer sk-codex-2",
    ]);
    expect(await unsealCompaction(capsuleOf(await response.json()))).toBe("the summary");
  });
});
