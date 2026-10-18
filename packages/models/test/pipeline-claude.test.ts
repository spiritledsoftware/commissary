// End-to-end tests (workerd) of the Claude provider: POST /v1/messages and /v1/messages/count_tokens through Access,
// model resolution, the credential picker, the Claude executor (request shaping, cloaking, CCH signing, aliases,
// error classification) and a mocked upstream.
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.ts";
import { normalizeCchInput } from "../src/executor/claude/signing.ts";
import { xxh64 } from "../src/executor/claude/xxhash64.ts";
import { canonicalModelKey } from "../src/credentials/selection/model-name.ts";
import { ExecutionError } from "../src/executor/errors.ts";
import { ModelProviders } from "../src/handlers/model-providers.ts";
import {
  CredentialPicker,
  type AttemptResult,
  type CredentialSnapshot,
} from "../src/executor/picker.ts";
import { asString, type JsonObject } from "@commissary/json";
import { setModelInfoLookup } from "@commissary/translation";
import {
  jsonResponse,
  loadConfig,
  makePipeline,
  postJson,
  sseResponse,
  type UpstreamResponder,
} from "./support/pipeline.ts";

const API_KEY_YAML = `
api-keys:
  claude:
    - keys:
        - api-key: sk-ant-api03-test
      models:
        - name: claude-sonnet-4-5
          alias: sonnet
`;

const OAUTH_YAML = `
requests:
  payload:
    override:
      - models: [{ name: "claude-sonnet-4-5", protocol: claude }]
        params:
          temperature: 0.3
          metadata.marker: from-payload-rule
          system.0.text: "x-anthropic-billing-header: cc_version=2.1.280.rul; cc_entrypoint=cli; cch=00000;"
`;

const message = (extra: JsonObject = {}): JsonObject => ({
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 11,
    output_tokens: 3,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
  },
  ...extra,
});

const sse = (events: ReadonlyArray<JsonObject>): string[] =>
  events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`);

const streamEvents = (toolName?: string): JsonObject[] => [
  {
    type: "message_start",
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [],
      usage: { input_tokens: 11, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
  { type: "content_block_stop", index: 0 },
  ...(toolName === undefined
    ? []
    : [
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: toolName, input: {} },
        } as JsonObject,
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
        } as JsonObject,
        { type: "content_block_stop", index: 1 } as JsonObject,
      ]),
  {
    type: "message_delta",
    delta: { stop_reason: toolName === undefined ? "end_turn" : "tool_use", stop_sequence: null },
    usage: { output_tokens: 7 },
  },
  { type: "message_stop" },
];

const oauthCredential = (overrides: Partial<CredentialSnapshot> = {}): CredentialSnapshot => ({
  id: "claude-oauth-1",
  provider: "claude",
  kind: "oauth",
  label: "dev@example.com",
  attributes: {},
  metadata: {
    access_token: "sk-ant-oat01-secret",
    account_uuid: "11111111-2222-4333-8444-555555555555",
  },
  ...overrides,
});

interface Harness {
  readonly pipeline: ReturnType<typeof makePipeline>;
  readonly reports: Array<AttemptResult>;
}

const oauthPipeline = (
  respond: UpstreamResponder,
  config: Config,
  credential: CredentialSnapshot = oauthCredential(),
): Harness => {
  const reports: Array<AttemptResult> = [];

  const picker = Layer.succeed(
    CredentialPicker,
    CredentialPicker.of({
      pick: (request) => {
        if ((request.excludedIds ?? []).includes(credential.id)) {
          return Effect.fail(
            new ExecutionError({
              status: 503,
              code: "auth_not_found",
              message: "no auth available",
            }),
          );
        }

        const lease = {
          id: "lease-1",
          credentialId: credential.id,
          credentialVersion: 1,
          provider: credential.provider,
          model: canonicalModelKey(request.model),
          issuedAt: 0,
        };

        return Effect.succeed({
          credential,
          leaseId: lease.id,
          lease,
          route: {
            requestedModel: request.model,
            routeModel: request.model,
            upstreamModels: [request.model],
            originalAlias: request.model,
            forceMapping: false,
            stateModel: canonicalModelKey(request.model),
            pooled: false,
          },
        });
      },
      report: (_lease, result) => Effect.sync(() => void reports.push(result)),
      planRetry: () => Effect.succeed({ retry: false }),
    }),
  );

  const providers = Layer.succeed(
    ModelProviders,
    ModelProviders.of({
      providersFor: (model) => Effect.succeed(model.startsWith("claude-") ? ["claude"] : []),
      firstAvailableModel: Effect.succeed("claude-sonnet-4-5"),
    }),
  );

  const pipeline = makePipeline({
    config,
    respond,
    credentialPicker: picker,
    modelProviders: providers,
  });

  return { pipeline, reports };
};

let providerKeyConfig: Config;

let oauthConfig: Config;

beforeAll(async () => {
  providerKeyConfig = await loadConfig(API_KEY_YAML);
  oauthConfig = await loadConfig(OAUTH_YAML);
  // Adaptive/level capabilities for the translators come from the model registry in production.
  setModelInfoLookup((id) =>
    id === "claude-opus-4-6"
      ? { id, thinking: { levels: ["low", "medium", "high", "max"] } }
      : undefined,
  );
});

const lastBody = (harness: Harness, index = 0): JsonObject =>
  JSON.parse(harness.pipeline.calls[index]!.body) as JsonObject;

describe("Provider key credential (caller-owned mode)", () => {
  it("forwards a native Messages request with x-api-key and default cache breakpoints", async () => {
    const p = makePipeline({ config: providerKeyConfig, respond: () => jsonResponse(message()) });
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/messages",
      postJson(
        {
          model: "sonnet",
          max_tokens: 64,
          temperature: 0.2,
          system: "be brief",
          messages: [{ role: "user", content: "hi" }],
          betas: ["files-api-2025-04-14"],
        },
        { "anthropic-beta": "my-custom-beta", "x-stainless-lang": "python" },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(message());
    const call = p.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(call.headers["x-api-key"]).toBe("sk-ant-api03-test");
    expect(call.headers["authorization"]).toBeUndefined();
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers["x-stainless-lang"]).toBe("python");
    expect(call.headers["accept"]).toBe("application/json");
    expect(call.headers["traceparent"]).toBeUndefined();
    // Caller-owned mode: caller betas verbatim, body `betas` appended.
    expect(call.headers["anthropic-beta"]).toBe("my-custom-beta,files-api-2025-04-14");
    const body = JSON.parse(call.body) as JsonObject;
    expect(body).toEqual({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      system: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
      ],
      stream: false,
    });
    expect(p.records[0]).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-4-5",
      failed: false,
      authType: "apikey",
    });
    expect(p.records[0]?.detail).toMatchObject({
      inputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    });
    expect(JSON.stringify(p.records[0])).not.toContain("sk-ant-api03-test");
  });

  it("keeps explicit prompt-cache mode untouched and strips prompt_cache_options", async () => {
    const p = makePipeline({ config: providerKeyConfig, respond: () => jsonResponse(message()) });
    afterAll(p.dispose);
    await p.call(
      "/v1/messages",
      postJson({
        model: "sonnet",
        max_tokens: 8,
        prompt_cache_options: { mode: "explicit" },
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(JSON.parse(p.calls[0]!.body)).toEqual({
      model: "claude-sonnet-4-5",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
  });

  it("streams Claude events through unchanged and records usage", async () => {
    const p = makePipeline({
      config: providerKeyConfig,
      respond: () => sseResponse(sse(streamEvents())),
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/messages",
      postJson({
        model: "sonnet",
        max_tokens: 8,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(sse(streamEvents()).join(""));
    expect(JSON.parse(p.calls[0]!.body)).toMatchObject({ stream: true });
    expect(p.calls[0]!.headers["accept"]).toBe("application/json");
    expect(p.records[0]).toMatchObject({ stream: true, failed: false });
    expect(p.records[0]?.detail).toMatchObject({ inputTokens: 11, outputTokens: 7 });
  });

  it("translates OpenAI chat requests to Claude (upstream always streams) and back", async () => {
    const p = makePipeline({
      config: providerKeyConfig,
      respond: () => sseResponse(sse(streamEvents("get_weather"))),
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({
        model: "sonnet",
        max_tokens: 50,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "weather?" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    const out = (await response.json()) as JsonObject;
    expect(out).toMatchObject({
      object: "chat.completion",
      model: "claude-sonnet-4-5",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello",
            tool_calls: [
              {
                id: "toolu_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const body = JSON.parse(p.calls[0]!.body) as JsonObject;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.tools).toEqual([
      {
        name: "get_weather",
        description: "",
        input_schema: { properties: { city: { type: "string" } }, type: "object" },
      },
    ]);
  });

  it("streams OpenAI chunks for chat requests", async () => {
    const p = makePipeline({
      config: providerKeyConfig,
      respond: () => sseResponse(sse(streamEvents())),
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "sonnet", stream: true, messages: [{ role: "user", content: "hi" }] }),
    );

    const text = await response.text();

    const chunks = text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: ") && !frame.includes("[DONE]"))
      .map((frame) => JSON.parse(frame.slice(6)) as JsonObject);

    expect(
      chunks.map((chunk) => (chunk.choices as JsonObject[])[0]?.delta).filter(Boolean),
    ).toContainEqual({
      content: "Hel",
    });
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  describe("Codex apply_patch bridge (Responses clients)", () => {
    const PATCH = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";

    const patchTool = {
      type: "custom",
      name: "apply_patch",
      description: "Apply a patch. This is a FREEFORM tool, so do not wrap the patch in JSON.",
      format: { type: "grammar", syntax: "lark", definition: "start: patch" },
    };

    const patchEvents = (partialJson: string[]): JsonObject[] => [
      {
        type: "message_start",
        message: {
          id: "msg_p",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [],
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_p", name: "apply_patch", input: {} },
      },
      ...partialJson.map((partial_json) => ({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json },
      })),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ];

    const request = (stream: boolean) => ({
      model: "sonnet",
      stream,
      input: "patch it",
      tools: [patchTool],
    });

    it("declares the patch tool as a strict input function and streams the patch as custom tool input", async () => {
      const json = JSON.stringify({ input: PATCH });

      const p = makePipeline({
        config: providerKeyConfig,
        respond: () => sseResponse(sse(patchEvents([json.slice(0, 20), json.slice(20)]))),
      });

      afterAll(p.dispose);
      const response = await p.call("/v1/responses", postJson(request(true)));
      expect(response.status).toBe(200);
      const upstreamTool = (JSON.parse(p.calls[0]!.body) as { tools: JsonObject[] }).tools[0];
      expect(upstreamTool).toMatchObject({
        name: "apply_patch",
        input_schema: { type: "object", required: ["input"], additionalProperties: false },
      });
      expect(asString(upstreamTool?.description)).toContain("*** Begin Patch");
      const text = await response.text();

      const deltas = [
        ...text.matchAll(/event: response\.custom_tool_call_input\.delta\ndata: (.*)/g),
      ].map((match) => (JSON.parse(match[1] as string) as { delta: string }).delta);

      expect(deltas.join("")).toBe(PATCH);
      expect(text).toContain('"type":"custom_tool_call"');
      expect(text).not.toContain("response.function_call_arguments");
    });

    it("aggregates the patch for non-stream clients and fails malformed arguments with 502", async () => {
      const ok = makePipeline({
        config: providerKeyConfig,
        respond: () => sseResponse(sse(patchEvents([JSON.stringify({ input: PATCH })]))),
      });

      afterAll(ok.dispose);
      const response = await ok.call("/v1/responses", postJson(request(false)));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { output: JsonObject[] };
      expect(body.output[0]).toMatchObject({
        type: "custom_tool_call",
        name: "apply_patch",
        input: PATCH,
      });

      const bad = makePipeline({
        config: providerKeyConfig,
        respond: () => sseResponse(sse(patchEvents(['{"input":"x","extra":1}']))),
      });

      afterAll(bad.dispose);
      const failed = await bad.call("/v1/responses", postJson(request(false)));
      expect(failed.status).toBe(502);
      expect(await failed.text()).not.toContain("extra");
    });

    it("terminates a stream that fails mid-way with the sanitised error and never leaks upstream arguments", async () => {
      const p = makePipeline({
        config: providerKeyConfig,
        respond: () => sseResponse(sse(patchEvents(['{"input":"x","secret":"s3cret"}']))),
      });

      afterAll(p.dispose);
      const response = await p.call("/v1/responses", postJson(request(true)));
      const text = await response.text();
      expect(text).toContain("invalid_tool_arguments");
      expect(text).not.toContain("s3cret");
    });
  });

  it("answers upstream failures in Claude error format with the upstream status", async () => {
    const p = makePipeline({
      config: providerKeyConfig,
      respond: () =>
        jsonResponse(
          { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
          { status: 529 },
        ),
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/messages",
      postJson({ model: "sonnet", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    );

    expect(response.status).toBe(529);
    expect(await response.json()).toMatchObject({ type: "error" });
    expect(p.records[0]).toMatchObject({ failed: true });
  });
});

describe("OAuth credential (Claude Code cloaking)", () => {
  const request = (model = "claude-sonnet-4-5") =>
    postJson({
      model,
      max_tokens: 32,
      temperature: 0.9,
      system: [{ type: "text", text: "Caller system prompt" }],
      messages: [{ role: "user", content: "Hello there, Claude" }],
      tools: [
        {
          name: "get_weather",
          description: "weather",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });

  it("cloaks the request: billing block, identity, relocated system, date reminder, identity metadata and headers", async () => {
    const h = oauthPipeline(() => jsonResponse(message()), await loadConfig(""));
    afterAll(h.pipeline.dispose);
    const response = await h.pipeline.call("/v1/messages", request("claude-opus-4-8"));
    expect(response.status).toBe(200);
    const call = h.pipeline.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(call.headers["authorization"]).toBe("Bearer sk-ant-oat01-secret");
    expect(call.headers["x-api-key"]).toBeUndefined();
    expect(call.headers["x-app"]).toBe("cli");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(call.headers["user-agent"]).toBe("claude-cli/2.1.280 (external, cli)");
    expect(call.headers["x-stainless-package-version"]).toBe("0.112.1");
    expect(call.headers["x-claude-code-session-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.headers["x-client-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const betas = call.headers["anthropic-beta"]!.split(",");
    expect(betas.slice(0, 3)).toEqual([
      "claude-code-20250219",
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
    ]);
    expect(betas).toContain("extended-cache-ttl-2025-04-11");
    expect(betas).toContain("mid-conversation-system-2026-04-07");

    const body = lastBody(h);
    const system = body.system as JsonObject[];
    expect(system[0]?.text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5}; cc_prompt_id=[0-9a-f-]{36}; cc_turn_origin=human;$/,
    );
    expect(system[1]).toEqual({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
    expect(system).toHaveLength(2);
    expect(body.temperature).toBeUndefined();
    // First user turn keeps its text and gets the date reminder; the caller system prompt moved behind it.
    const messages = body.messages as JsonObject[];
    expect(messages.map((m) => m.role)).toEqual(["user", "system"]);
    const firstContent = (messages[0] as JsonObject).content as JsonObject[];
    expect((firstContent[0] as JsonObject).text as string).toMatch(
      /^<system-reminder>\nAs you answer/,
    );
    expect((firstContent[1] as JsonObject).text).toBe("Hello there, Claude");
    expect(messages[1]?.content).toEqual([
      {
        type: "text",
        text: "Caller system prompt",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
    const userId = JSON.parse((body.metadata as JsonObject).user_id as string) as JsonObject;
    expect(userId).toMatchObject({ account_uuid: "11111111-2222-4333-8444-555555555555" });
    expect(userId.device_id).toMatch(/^[0-9a-f]{64}$/);
    expect(userId.session_id).toBe(call.headers["x-claude-code-session-id"]);
    // Tool names are aliased to Claude Code MCP style names.
    expect((body.tools as JsonObject[])[0]?.name as string).toMatch(
      /^mcp__[a-z]+_[a-z]+__[a-z]+_get_weather$/,
    );
    expect(body.context_management).toBeUndefined();
    expect(JSON.stringify(h.pipeline.records[0])).not.toContain("sk-ant-oat01-secret");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ success: true });
  });

  it("wraps the caller system prompt as a system reminder for models without mid-conversation system turns", async () => {
    const h = oauthPipeline(() => jsonResponse(message()), await loadConfig(""));
    afterAll(h.pipeline.dispose);
    await h.pipeline.call("/v1/messages", request("claude-sonnet-4-5"));
    const messages = lastBody(h).messages as JsonObject[];
    expect(messages.map((m) => m.role)).toEqual(["user"]);
    const content = messages[0]?.content as JsonObject[];
    expect(content.map((block) => block.text)).toEqual([
      expect.stringContaining("# currentDate"),
      "<system-reminder>\nCaller system prompt\n</system-reminder>",
      "Hello there, Claude",
    ]);
    expect(h.pipeline.calls[0]!.headers["anthropic-beta"]).not.toContain(
      "mid-conversation-system-2026-04-07",
    );
  });

  it("signs the final body: cch equals xxh64 of the normalised bytes", async () => {
    const h = oauthPipeline(() => jsonResponse(message()), await loadConfig(""));
    afterAll(h.pipeline.dispose);
    await h.pipeline.call("/v1/messages", request());
    const text = h.pipeline.calls[0]!.body;
    const cch = /cch=([0-9a-f]{5});/.exec(text)![1]!;
    const unsigned = text.replace(/cch=[0-9a-f]{5};/, "cch=00000;");

    const expected = (
      xxh64(new TextEncoder().encode(normalizeCchInput(unsigned)), 0x4d659218e32a3268n) & 0xfffffn
    )
      .toString(16)
      .padStart(5, "0");

    expect(cch).toBe(expected);
  });

  it("applies payload rules last: after shaping and identity, and the signature covers their result", async () => {
    const h = oauthPipeline(() => jsonResponse(message()), oauthConfig);
    afterAll(h.pipeline.dispose);
    await h.pipeline.call("/v1/messages", request());
    const call = h.pipeline.calls[0]!;
    const body = JSON.parse(call.body) as JsonObject;
    // `temperature` is stripped by the sampling normalisation and only the later rule can bring it back.
    expect(body.temperature).toBe(0.3);
    expect((body.metadata as JsonObject).marker).toBe("from-payload-rule");
    // The rule replaced the billing block text (written after the CCH placeholder step): the signature is recomputed.
    const system = body.system as JsonObject[];
    expect(system[0]?.text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.280\.rul; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    );
    const cch = /cch=([0-9a-f]{5});/.exec(call.body)![1]!;
    expect(cch).not.toBe("00000");
    const unsigned = call.body.replace(/cch=[0-9a-f]{5};/, "cch=00000;");

    const expected = (
      xxh64(new TextEncoder().encode(normalizeCchInput(unsigned)), 0x4d659218e32a3268n) & 0xfffffn
    )
      .toString(16)
      .padStart(5, "0");

    expect(cch).toBe(expected);
  });

  it("restores aliased tool names in non-stream and stream responses", async () => {
    const aliasOf = async (): Promise<string> => {
      const probe = oauthPipeline(() => jsonResponse(message()), await loadConfig(""));
      afterAll(probe.pipeline.dispose);
      await probe.pipeline.call("/v1/messages", request());

      return (lastBody(probe).tools as JsonObject[])[0]?.name as string;
    };

    const alias = await aliasOf();

    const nonStream = oauthPipeline(
      () =>
        jsonResponse(
          message({
            content: [{ type: "tool_use", id: "toolu_9", name: alias, input: { city: "Rome" } }],
            stop_reason: "tool_use",
          }),
        ),
      await loadConfig(""),
    );

    afterAll(nonStream.pipeline.dispose);

    const json = (await (
      await nonStream.pipeline.call("/v1/messages", request())
    ).json()) as JsonObject;

    expect((json.content as JsonObject[])[0]?.name).toBe("get_weather");

    const streamed = oauthPipeline(
      () => sseResponse(sse(streamEvents(alias))),
      await loadConfig(""),
    );

    afterAll(streamed.pipeline.dispose);
    const body = JSON.parse(request().body as string) as JsonObject;

    const response = await streamed.pipeline.call(
      "/v1/messages",
      postJson({ ...body, stream: true }),
    );

    const text = await response.text();
    expect(text).toContain('"name":"get_weather"');
    expect(text).not.toContain(alias);
  });

  it("classifies upstream failures for the credential picker", async () => {
    const unauthorized = oauthPipeline(
      () => jsonResponse({ error: { message: "bad token" } }, { status: 401 }),
      await loadConfig(""),
    );

    afterAll(unauthorized.pipeline.dispose);
    expect((await unauthorized.pipeline.call("/v1/messages", request())).status).toBe(401);
    expect(unauthorized.reports[0]).toMatchObject({ success: false, httpStatus: 401 });

    const limited = oauthPipeline(
      () =>
        jsonResponse(
          { type: "error", error: { type: "rate_limit_error", message: "limit" } },
          {
            status: 429,
            headers: {
              "anthropic-ratelimit-unified-5h-status": "rejected",
              "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3600),
            },
          },
        ),
      await loadConfig(""),
    );

    afterAll(limited.pipeline.dispose);
    expect((await limited.pipeline.call("/v1/messages", request())).status).toBe(429);
    const report = limited.reports[0];
    expect(report).toMatchObject({ success: false, httpStatus: 429, credentialScoped: true });
    expect((report as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(3_599_000);
  });

  it("passes Fast mode upstream errors through unchanged and request-scoped", async () => {
    const h = oauthPipeline(
      () =>
        new Response('{"error":"fast unavailable"}', {
          status: 400,
          headers: { "content-type": "application/json", "x-upstream": "1" },
        }),
      await loadConfig(""),
    );

    afterAll(h.pipeline.dispose);
    const body = JSON.parse(request().body as string) as JsonObject;
    const response = await h.pipeline.call("/v1/messages", postJson({ ...body, speed: "fast" }));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":"fast unavailable"}');
    expect(h.reports[0]).toMatchObject({
      success: false,
      httpStatus: 400,
      error: { code: "request_scoped" },
    });
    expect(h.pipeline.calls[0]!.headers["anthropic-beta"]).toContain("fast-mode-2026-02-01");
  });
});

describe("OAuth credential, minimal cloak level", () => {
  const MINIMAL = "upstream: { claude: { cloak-level: minimal } }";

  const request = (model = "claude-opus-4-8", extra: JsonObject = {}) =>
    postJson(
      {
        model,
        max_tokens: 32,
        system: [{ type: "text", text: "Caller system prompt" }],
        messages: [{ role: "user", content: "Hello there, Claude" }],
        tools: [
          {
            name: "get_weather",
            description: "weather",
            input_schema: { type: "object", properties: {} },
          },
        ],
        ...extra,
      },
      { "user-agent": "pi-coding-agent/1.3.0" },
    );

  it("sends only the identity line, the relocated system prompt and the OAuth beta", async () => {
    const h = oauthPipeline(() => jsonResponse(message()), await loadConfig(MINIMAL));
    afterAll(h.pipeline.dispose);
    expect((await h.pipeline.call("/v1/messages", request())).status).toBe(200);
    const call = h.pipeline.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(call.headers["authorization"]).toBe("Bearer sk-ant-oat01-secret");

    const body = lastBody(h);
    expect(body.system).toEqual([
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
    const messages = body.messages as JsonObject[];
    expect(messages.map((m) => m.role)).toEqual(["user", "system"]);
    expect(JSON.stringify(messages[0])).not.toContain("currentDate");
    expect(messages[1]?.content).toEqual([
      {
        type: "text",
        text: "Caller system prompt",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
    expect(call.body).not.toContain("x-anthropic-billing-header");
    expect(call.body).not.toContain("cch=");
    expect((body.tools as JsonObject[])[0]?.name).toBe("get_weather");
    expect(body.metadata).toBeUndefined();
    expect(body.diagnostics).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();

    const betas = call.headers["anthropic-beta"]!.split(",");
    expect(betas).toContain("oauth-2025-04-20");
    expect(betas).toContain("mid-conversation-system-2026-04-07");
    expect(betas).not.toContain("claude-code-20250219");
    expect(call.headers["user-agent"]).toBe("pi-coding-agent/1.3.0");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");

    for (const name of Object.keys(call.headers)) {
      expect(name).not.toMatch(/^x-stainless-|^x-claude-code-/);
      expect(name).not.toBe("x-app");
      expect(name).not.toBe("x-client-request-id");
      expect(name).not.toBe("anthropic-dangerous-direct-browser-access");
    }
  });

  it("sends no CLI user agent when the caller has none", async () => {
    const h = oauthPipeline(() => jsonResponse(message()), await loadConfig(MINIMAL));
    afterAll(h.pipeline.dispose);
    const body = JSON.parse(request().body as string) as JsonObject;
    await h.pipeline.call("/v1/messages", postJson(body));
    expect(h.pipeline.calls[0]!.headers["user-agent"] ?? "").not.toMatch(/^claude-cli\//);
  });

  it("injects no fallbacks or thinking display on Opus 5.5", async () => {
    const h = oauthPipeline(() => jsonResponse(message()), await loadConfig(MINIMAL));
    afterAll(h.pipeline.dispose);

    await h.pipeline.call(
      "/v1/messages",
      request("claude-opus-5-5", { thinking: { type: "adaptive" } }),
    );

    const body = lastBody(h);
    expect(body.fallbacks).toBeUndefined();
    expect((body.thinking as JsonObject | undefined)?.display).toBeUndefined();
  });

  it("returns tool calls under the client's names without alias mapping", async () => {
    const respond = () =>
      jsonResponse(
        message({
          content: [{ type: "tool_use", id: "toolu_9", name: "get_weather", input: {} }],
          stop_reason: "tool_use",
        }),
      );

    const h = oauthPipeline(respond, await loadConfig(MINIMAL));
    afterAll(h.pipeline.dispose);
    const json = (await (await h.pipeline.call("/v1/messages", request())).json()) as JsonObject;
    expect((json.content as JsonObject[])[0]?.name).toBe("get_weather");

    const streamed = oauthPipeline(
      () => sseResponse(sse(streamEvents("get_weather"))),
      await loadConfig(MINIMAL),
    );

    afterAll(streamed.pipeline.dispose);
    const body = JSON.parse(request().body as string) as JsonObject;

    const text = await (
      await streamed.pipeline.call("/v1/messages", postJson({ ...body, stream: true }))
    ).text();

    expect(text).toContain('"name":"get_weather"');
  });

  it("ignores strict mode and sensitive words, which refine parts minimal does not send", async () => {
    const h = oauthPipeline(
      () => jsonResponse(message()),
      await loadConfig(MINIMAL),
      oauthCredential({
        attributes: { cloak_strict_mode: "true", cloak_sensitive_words: "Claude" },
      }),
    );

    afterAll(h.pipeline.dispose);
    await h.pipeline.call("/v1/messages", request());
    const body = lastBody(h);
    expect(h.pipeline.calls[0]!.body).not.toContain("\u200b");
    expect(JSON.stringify(body.messages)).toContain("Caller system prompt");
    expect(JSON.stringify(body.messages)).toContain("Hello there, Claude");
  });

  it("cloaks an API key at the minimal level only when its mode says so", async () => {
    const keyConfig = (cloak: string) =>
      loadConfig(`
api-keys:
  claude:
    - keys:
        - api-key: sk-ant-api03-test
          cloak: ${cloak}
      models:
        - name: claude-opus-4-8
`);

    const levelOnly = makePipeline({
      config: await keyConfig("{ level: minimal }"),
      respond: () => jsonResponse(message()),
    });

    afterAll(levelOnly.dispose);
    await levelOnly.call("/v1/messages", request());
    const plain = JSON.parse(levelOnly.calls[0]!.body) as JsonObject;
    expect(JSON.stringify(plain.system)).toContain("Caller system prompt");
    expect(JSON.stringify(plain.system)).not.toContain("You are Claude Code");

    const always = makePipeline({
      config: await keyConfig("{ mode: always, level: minimal }"),
      respond: () => jsonResponse(message()),
    });

    afterAll(always.dispose);
    await always.call("/v1/messages", request());
    const call = always.calls[0]!;
    const body = JSON.parse(call.body) as JsonObject;
    // Unlike `full`, a provider key's caller system prompt leaves the top level too.
    expect((body.system as JsonObject[]).map((block) => block.text)).toEqual([
      "You are Claude Code, Anthropic's official CLI for Claude.",
    ]);
    expect(JSON.stringify(body.messages)).toContain("Caller system prompt");
    expect(call.body).not.toContain("x-anthropic-billing-header");
    expect(body.metadata).toBeUndefined();
    expect(call.headers["x-api-key"]).toBe("sk-ant-api03-test");
    expect(call.headers["anthropic-beta"] ?? "").not.toContain("claude-code-20250219");
    expect(call.headers["x-app"]).toBeUndefined();
  });

  it("sends nothing cloaked with disable-claude-cloak-mode at the minimal level", async () => {
    const off = await loadConfig(
      "upstream: { claude: { disable-claude-cloak-mode: true, cloak-level: minimal } }",
    );

    const h = oauthPipeline(() => jsonResponse(message()), off);
    afterAll(h.pipeline.dispose);
    await h.pipeline.call("/v1/messages", request());
    const body = lastBody(h);
    expect(JSON.stringify(body.system)).toContain("Caller system prompt");
    expect(JSON.stringify(body.system)).not.toContain("You are Claude Code");
  });

  it("relocates the system prompt for count_tokens without the claude-code beta", async () => {
    const h = oauthPipeline(() => jsonResponse({ input_tokens: 7 }), await loadConfig(MINIMAL));
    afterAll(h.pipeline.dispose);
    expect((await h.pipeline.call("/v1/messages/count_tokens", request())).status).toBe(200);
    const call = h.pipeline.calls[0]!;
    const body = JSON.parse(call.body) as JsonObject;
    expect(body.system).toBeUndefined();
    expect(JSON.stringify(body.messages)).toContain("Caller system prompt");
    expect((body.tools as JsonObject[])[0]?.name).toBe("get_weather");
    const betas = call.headers["anthropic-beta"]!.split(",");
    expect(betas).toContain("oauth-2025-04-20");
    expect(betas).toContain("token-counting-2024-11-01");
    expect(betas).not.toContain("claude-code-20250219");
    expect(call.headers["x-app"]).toBeUndefined();
  });
});

describe("POST /v1/messages/count_tokens", () => {
  it("counts upstream for first-party hosts with the token-counting beta", async () => {
    const p = makePipeline({
      config: providerKeyConfig,
      respond: () => jsonResponse({ input_tokens: 42 }),
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/messages/count_tokens",
      postJson({
        model: "sonnet",
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "u" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 42 });
    const call = p.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
    expect(call.headers["anthropic-beta"]).toContain("token-counting-2024-11-01");
    expect(call.headers["x-stainless-timeout"]).toBeUndefined();
    const body = JSON.parse(call.body) as JsonObject;
    expect(body.metadata).toBeUndefined();
    expect(body.model).toBe("claude-sonnet-4-5");
  });

  it("estimates locally for third-party gateways and validates the request", async () => {
    const gateway = await loadConfig(`
api-keys:
  claude:
    - base-url: https://gateway.test
      keys: [{ api-key: gw-key }]
      models: [{ name: claude-sonnet-4-5 }]
`);

    const p = makePipeline({ config: gateway, respond: () => jsonResponse({}) });
    afterAll(p.dispose);

    const ok = await p.call(
      "/v1/messages/count_tokens",
      postJson({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hello world, how are you today?" }],
      }),
    );

    expect(ok.status).toBe(200);
    const count = ((await ok.json()) as { input_tokens: number }).input_tokens;
    expect(count).toBeGreaterThan(3);
    expect(p.calls).toHaveLength(0);

    const bad = await p.call(
      "/v1/messages/count_tokens",
      postJson({ model: "claude-sonnet-4-5", messages: [] }),
    );

    expect(bad.status).toBe(400);
  });
});
