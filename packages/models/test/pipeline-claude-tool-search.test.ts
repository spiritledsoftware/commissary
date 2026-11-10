// Native tool search through the Claude executor (workerd): a Codex client's `tool_search` on POST /v1/responses and
// POST /v1/messages/count_tokens, per credential (Go: internal/runtime/executor/claude_executor_tool_search_test.go,
// claude_executor_tool_search_disabled_test.go; upstream 52992659, 29bd0415, 8eed08ef, 97ba1e89).
import { Effect, Layer, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { asString, type JsonObject } from "@commissary/json";
import { makeClaudeExecutor } from "../src/executor/claude/executor.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import { ModelProviders } from "../src/handlers/model-providers.ts";
import { oauthPipeline } from "./support/claude-oauth.ts";
import { fixedPicker } from "./support/codex.ts";
import { credential, harness, options } from "./support/executor-run.ts";
import {
  jsonResponse,
  loadConfig,
  makePipeline,
  postJson,
  sseResponse,
} from "./support/pipeline.ts";

const ANCHOR = "tool_search_deferred_anchor";

const GATE = "upstream:\n  claude:\n    tool-search: true\n";

const anthropicKeys = (model = "claude-sonnet-4-5", extra = ""): string => `
api-keys:
  claude:
    - keys:
        - api-key: sk-ant-api03-test
      models: [{ name: ${model}, alias: sonnet }]
${extra}`;

const gatewayKeys = (flag: boolean): string => `
api-keys:
  claude:
    - base-url: https://gateway.test
      keys:
        - api-key: gw-key${flag ? "\n          native-tool-search: true" : ""}
      models: [{ name: claude-sonnet-4-5, alias: sonnet }]
`;

const userTurn = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "create a calendar event" }],
};

const request = (model: string, history = false): JsonObject => ({
  model,
  instructions: "You are Codex.",
  stream: true,
  tool_choice: "auto",
  input: [
    userTurn,
    ...(history
      ? [
          {
            type: "tool_search_call",
            call_id: "call_search_1",
            status: "completed",
            execution: "client",
            arguments: { query: "calendar", limit: 8 },
          },
          {
            type: "tool_search_output",
            call_id: "call_search_1",
            status: "completed",
            execution: "client",
            tools: [
              {
                type: "namespace",
                name: "mcp__codex_apps__",
                description: "Calendar.",
                tools: [
                  {
                    type: "function",
                    name: "calendar_create_event",
                    description: "Create a calendar event.",
                    defer_loading: true,
                    cache_control: { type: "ephemeral" },
                    parameters: {
                      type: "object",
                      properties: { title: { type: "string" } },
                      required: ["title"],
                    },
                  },
                ],
              },
            ],
          },
        ]
      : []),
  ],
  tools: [
    {
      type: "function",
      name: "exec_command",
      description: "Run a command.",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    },
    {
      type: "tool_search",
      execution: "client",
      description: "Search deferred tools.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "lookup_order",
      defer_loading: true,
      parameters: { type: "object", properties: { id: { type: "string" } } },
    },
  ],
});

const sse = (events: ReadonlyArray<JsonObject>): string[] =>
  events.map((event) => `event: ${asString(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);

const answer = (): string[] =>
  sse([
    {
      type: "message_start",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);

const bodyOf = (call: { readonly body: string }): JsonObject => JSON.parse(call.body) as JsonObject;

const toolsOf = (body: JsonObject): JsonObject[] => (body.tools ?? []) as JsonObject[];

const names = (body: JsonObject): string[] => toolsOf(body).map((tool) => asString(tool.name));

const sent = async (yaml: string, model = "sonnet", history = true): Promise<JsonObject> => {
  const p = makePipeline({ config: await loadConfig(yaml), respond: () => sseResponse(answer()) });

  try {
    const response = await p.call("/v1/responses", postJson(request(model, history)));
    expect(response.status).toBe(200);
    await response.text();

    return bodyOf(p.calls[0]!);
  } finally {
    await p.dispose();
  }
};

/** The body carries the client's search as a function: native tool search. */
const declaresToolSearch = (body: JsonObject): boolean => names(body).includes("tool_search");

const mentionsToolSearch = (body: JsonObject): boolean =>
  JSON.stringify(body).includes("tool_search") ||
  JSON.stringify(body).includes("defer_loading") ||
  JSON.stringify(body).includes("tool_reference");

describe("native tool search per credential", () => {
  it("stays off with the gate off, even on api.anthropic.com", async () => {
    const body = await sent(anthropicKeys());
    expect(mentionsToolSearch(body)).toBe(false);
    // The deferred tool stays declared, as before tool_search support; nothing is discovered without the history.
    expect(names(body)).toEqual(["exec_command", "lookup_order"]);
  });

  it("is native on an api.anthropic.com key with the gate on", async () => {
    const body = await sent(GATE + anthropicKeys());

    expect(declaresToolSearch(body)).toBe(true);
    expect(names(body)).toEqual([
      "exec_command",
      "tool_search",
      ANCHOR,
      "mcp__codex_apps__calendar_create_event",
    ]);

    const discovered = toolsOf(body).find(
      (tool) => tool.name === "mcp__codex_apps__calendar_create_event",
    );

    expect(discovered?.defer_loading).toBe(true);
    expect(discovered?.cache_control).toBeUndefined();
  });

  it("is stripped on a custom base URL without native-tool-search", async () => {
    expect(mentionsToolSearch(await sent(GATE + gatewayKeys(false)))).toBe(false);
  });

  it("is native on a custom base URL with native-tool-search", async () => {
    expect(declaresToolSearch(await sent(GATE + gatewayKeys(true)))).toBe(true);
  });

  it("is stripped on a model that predates tool search", async () => {
    const body = await sent(GATE + anthropicKeys("claude-opus-4-1"));
    expect(mentionsToolSearch(body)).toBe(false);
  });

  const countRequest = async (
    key: CredentialSnapshot,
    yaml: string,
  ): Promise<{ readonly sent: JsonObject | undefined; readonly tokens: number }> => {
    const h = await harness(key, () => new Response(JSON.stringify({ input_tokens: 42 })), yaml);

    const response = await Effect.runPromise(
      makeClaudeExecutor()
        .countTokens(
          h.context,
          { model: "claude-sonnet-4-5", payload: request("claude-sonnet-4-5", true) },
          options({
            sourceFormat: "openai-response",
            metadata: {
              requestPath: "/v1/responses/input_tokens",
              requestedModel: "claude-sonnet-4-5",
              serviceTier: "auto",
              generate: false,
              callerScope: "scope",
            },
          }),
        )
        .pipe(Effect.provide(h.layers)),
    );

    return {
      sent: h.calls[0] === undefined ? undefined : (JSON.parse(h.calls[0].text) as JsonObject),
      tokens: (JSON.parse(response.payload) as { input_tokens: number }).input_tokens,
    };
  };

  const countKey = (attributes: Record<string, string> = {}): CredentialSnapshot =>
    credential("claude", {
      kind: "apikey",
      attributes: { api_key: "sk-ant-api03-test", auth_kind: "apikey", ...attributes },
    });

  it("counts tokens upstream with the same decision", async () => {
    const native = await countRequest(countKey(), GATE);
    expect(declaresToolSearch(native.sent!)).toBe(true);
    expect(mentionsToolSearch((await countRequest(countKey(), "requests: {}")).sent!)).toBe(false);
  });

  it("estimates locally with the same decision on a gateway without a count endpoint", async () => {
    const gateway = countKey({ base_url: "https://gateway.test", native_tool_search: "true" });
    const native = await countRequest(gateway, GATE);
    const off = await countRequest(gateway, "requests: {}");

    // Nothing goes upstream; the native body carries the search, the anchor and the discovered tool, so it is larger.
    expect(native.sent).toBeUndefined();
    expect(off.sent).toBeUndefined();
    expect(native.tokens).toBeGreaterThan(off.tokens);
  });
});

describe("a delegating profile (Kimi)", () => {
  it("never takes native tool search, even on a flagged key with the gate on", async () => {
    const h = await harness(
      credential("claude", {
        kind: "apikey",
        attributes: {
          api_key: "sk-ant-api03-test",
          auth_kind: "apikey",
          base_url: "https://api.anthropic.com",
          native_tool_search: "true",
        },
      }),
      () => sseResponse(answer()),
      GATE,
      true,
    );

    const delegating = makeClaudeExecutor({ profile: { normalizeModel: (model) => model } });

    const result = await Effect.runPromise(
      delegating
        .executeStream(
          h.context,
          { model: "claude-sonnet-4-5", payload: request("claude-sonnet-4-5", true) },
          options({
            stream: true,
            sourceFormat: "openai-response",
            metadata: {
              requestPath: "/v1/responses",
              requestedModel: "claude-sonnet-4-5",
              serviceTier: "auto",
              generate: true,
              callerScope: "scope",
            },
          }),
        )
        .pipe(Effect.provide(h.layers)),
    );

    await Effect.runPromise(Stream.runDrain(result.chunks).pipe(Effect.provide(h.layers)));
    expect(mentionsToolSearch(JSON.parse(h.calls[0]!.text) as JsonObject)).toBe(false);
  });
});

describe("cloaked OAuth", () => {
  const streamTool = (name: string): string[] =>
    sse([
      {
        type: "message_start",
        message: {
          id: "msg_02",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_cal", name, input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"title":"Standup"}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]);

  it("references only declared tools after MCP aliasing and restores the discovered call", async () => {
    const config = await loadConfig(GATE);
    let upstreamTools: JsonObject[] = [];

    const h = oauthPipeline((call) => {
      upstreamTools = toolsOf(bodyOf(call));
      // The anchor comes first among the deferred tools, then the discovered ones.
      const discovered = upstreamTools.filter((tool) => tool.defer_loading === true)[1];

      return sseResponse(streamTool(asString(discovered?.name)));
    }, config);

    afterAll(h.pipeline.dispose);

    const response = await h.pipeline.call(
      "/v1/responses",
      postJson(request("claude-sonnet-4-5", true)),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    const body = bodyOf(h.pipeline.calls[0]!);
    const declared = new Set(names(body));

    const references = (body.messages as JsonObject[]).flatMap((message) =>
      Array.isArray(message.content)
        ? (message.content as JsonObject[]).flatMap((block) =>
            Array.isArray(block.content)
              ? (block.content as JsonObject[]).filter((part) => part.type === "tool_reference")
              : [],
          )
        : [],
    );

    expect(references.length).toBeGreaterThan(0);

    for (const reference of references)
      expect(declared.has(asString(reference.tool_name))).toBe(true);

    // MCP aliasing renames every tool that is not `mcp__` named, the anchor included, so ANCHOR is not sent as is.
    expect(declared.has(ANCHOR)).toBe(false);
    expect(toolsOf(body).filter((tool) => tool.defer_loading === true)).toHaveLength(2);

    // No deferred tool carries cache_control (a 400 upstream).
    for (const tool of toolsOf(body).filter((candidate) => candidate.defer_loading === true))
      expect(tool.cache_control).toBeUndefined();

    // The aliased discovered tool comes back as the Codex namespaced function call.
    const done = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()) as JsonObject)
      .find(
        (event) =>
          event.type === "response.output_item.done" &&
          (event.item as JsonObject).type === "function_call",
      );

    expect((done!.item as JsonObject).name).toBe("calendar_create_event");
    expect((done!.item as JsonObject).namespace).toBe("mcp__codex_apps__");

    // Claude Code's own beta set: tool search with deferred tools adds advanced-tool-use when cloaked.
    expect(h.pipeline.calls[0]!.headers["anthropic-beta"]).toContain("advanced-tool-use");
  });

  it("sends no advanced-tool-use beta on an uncloaked API key", async () => {
    const p = makePipeline({
      config: await loadConfig(GATE + anthropicKeys()),
      respond: () => sseResponse(answer()),
    });

    afterAll(p.dispose);
    const response = await p.call("/v1/responses", postJson(request("sonnet", true)));
    expect(response.status).toBe(200);
    await response.text();
    expect(p.calls[0]!.headers["anthropic-beta"] ?? "").not.toContain("advanced-tool-use");
  });
});

describe("failover between credentials", () => {
  const apiKey = (id: string, baseUrl?: string): CredentialSnapshot => ({
    id,
    provider: "claude",
    kind: "apikey",
    label: id,
    attributes: {
      api_key: `sk-ant-api03-${id}`,
      auth_kind: "apikey",
      ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
    },
    metadata: {},
  });

  it("sends a stripped body when a native attempt fails over to a credential without native tool search", async () => {
    const claudeOnly = Layer.succeed(
      ModelProviders,
      ModelProviders.of({
        providersFor: () => Effect.succeed(["claude"]),
        firstAvailableModel: Effect.succeed("claude-sonnet-4-5"),
      }),
    );

    const p = makePipeline({
      config: await loadConfig(GATE),
      credentialPicker: fixedPicker([apiKey("a"), apiKey("b", "https://gateway.test")]),
      modelProviders: claudeOnly,
      respond: (call) =>
        call.url.startsWith("https://api.anthropic.com")
          ? jsonResponse(
              { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
              { status: 429, headers: { "retry-after": "1" } },
            )
          : sseResponse(answer()),
    });

    afterAll(p.dispose);
    const response = await p.call("/v1/responses", postJson(request("claude-sonnet-4-5", true)));
    expect(response.status).toBe(200);
    await response.text();

    expect(p.calls.map((call) => new URL(call.url).host)).toEqual([
      "api.anthropic.com",
      "gateway.test",
    ]);

    expect(declaresToolSearch(bodyOf(p.calls[0]!))).toBe(true);
    expect(mentionsToolSearch(bodyOf(p.calls[1]!))).toBe(false);
  });
});
