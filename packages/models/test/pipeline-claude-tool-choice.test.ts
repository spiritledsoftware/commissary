// End-to-end tests (workerd) of the Claude 5.5 forced tool_choice rewrite on the Claude request pipeline: Opus 5.5 and
// Sonnet 5.5 reject forced tool use, so `any`/`tool` becomes `auto` before thinking preparation (CLIProxyAPI 1d45a5f3,
// internal/runtime/executor/claude_issue7000_test.go and claude_issue7000_regression_test.go).
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { prepareLocalCountBody } from "../src/executor/claude/pipeline.ts";
import { makeSessionStateContinuityStore } from "../src/executor/claude/continuity.ts";
import { makeSessionStateDeviceProfileStore } from "../src/executor/claude/device-profile.ts";
import { makeMemoryReplayStore } from "../src/executor/claude/thinking-replay.ts";
import { makeSessionStateToolAliasStore } from "../src/executor/claude/thread.ts";
import { makeClaudeExecutor } from "../src/executor/claude/executor.ts";
import { Thinking } from "../src/executor/thinking.ts";
import type { JsonObject } from "@commissary/json";
import { builtinTranslators, str } from "@commissary/translation";
import { claudeSignature } from "./support/signatures.ts";
import { credential, execute, harness, json, options } from "./support/executor-run.ts";
import {
  jsonResponse,
  loadConfig,
  makePipeline,
  postJson,
  sseResponse,
  type UpstreamCall,
} from "./support/pipeline.ts";

const BINDING_BETA = "thinking-binding-controls-2026-08-01";

const DROP = { prefix_mismatch_behavior: "drop_block" };

const tools = [
  {
    name: "lookup_weather",
    description: "Look up the weather for a city.",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
];

const FORCED_TOOL = { type: "tool", name: "lookup_weather", disable_parallel_tool_use: true };

const FORCED_ANY = { type: "any", disable_parallel_tool_use: true };

const AUTO = { type: "auto", disable_parallel_tool_use: true };

const keyYaml = (models: string[], rules = ""): string => `
api-keys:
  claude:
    - keys:
        - api-key: sk-ant-api03-test
      models:
${models.map((name) => `        - name: ${name}`).join("\n")}
${rules}`;

const message = (model: string): JsonObject => ({
  id: "msg_01",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 3 },
});

const messages = [{ role: "user", content: "What is the weather in Paris?" }];

const request = (model: string, extra: JsonObject = {}): JsonObject => ({
  model,
  max_tokens: 4096,
  messages,
  tools,
  ...extra,
});

interface Sent {
  readonly body: JsonObject;
  readonly call: UpstreamCall;
}

const betasOf = (call: UpstreamCall): string[] =>
  (call.headers["anthropic-beta"] ?? "").split(",").filter((beta) => beta !== "");

/** One request through a caller-owned provider key to the first-party host; `models` are the configured names. */
const send = async (
  body: JsonObject,
  { rules = "", path = "/v1/messages", models = [str(body.model)] } = {},
): Promise<Sent> => {
  const config = await loadConfig(keyYaml(models, rules));

  const p = makePipeline({
    config,
    respond: () =>
      jsonResponse(
        path.endsWith("count_tokens") ? { input_tokens: 5 } : message("claude-opus-5-5"),
      ),
  });

  try {
    expect((await p.call(path, postJson(body))).status).toBe(200);
    const call = p.calls[0]!;

    return { body: JSON.parse(call.body) as JsonObject, call };
  } finally {
    await p.dispose();
  }
};

describe("forced tool_choice on Claude 5.5", () => {
  it.each([
    ["claude-opus-5-5", FORCED_ANY],
    ["claude-opus-5-5", FORCED_TOOL],
    ["claude-sonnet-5-5", FORCED_ANY],
    ["claude-sonnet-5-5", FORCED_TOOL],
  ])("rewrites %s %j to auto and keeps the rest of the request", async (model, toolChoice) => {
    const sent = await send(
      request(model, {
        tool_choice: toolChoice,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
      }),
    );

    expect(sent.body.tool_choice).toEqual(AUTO);
    expect(sent.body.thinking).toEqual({ type: "adaptive" });
    expect(sent.body.output_config).toEqual({ effort: "high" });
    expect((sent.body.tools as JsonObject[])[0]).toMatchObject(tools[0]!);
    expect(JSON.stringify(sent.body.messages)).toContain("What is the weather in Paris?");
  });

  it.each([
    "claude-opus-5-5-20260901",
    "claude-sonnet-5-5[1m]",
    "claude-opus-5-5-high-20260901[1m]",
    "claude-sonnet-5-5-reasoning",
  ])("rewrites the model variant %s", async (model) => {
    const sent = await send(request(model, { tool_choice: FORCED_TOOL }));
    expect(sent.body.tool_choice).toEqual(AUTO);
  });

  it.each([
    "claude-opus-5",
    "claude-sonnet-4-6",
    "claude-haiku-5-5",
    "claude-opus-5-50",
    "claude-sonnet-5-50",
    "claude-opus-5-5-custom",
  ])("leaves %s forced", async (model) => {
    const sent = await send(request(model, { tool_choice: FORCED_TOOL }));
    expect(sent.body.tool_choice).toEqual(FORCED_TOOL);
  });

  it.each([[{ type: "auto", disable_parallel_tool_use: false }], [{ type: "none" }], [undefined]])(
    "leaves tool_choice %j alone",
    async (toolChoice) => {
      const sent = await send(
        request("claude-opus-5-5", toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      );

      expect(sent.body.tool_choice).toEqual(toolChoice);
    },
  );

  it("judges the routed upstream model, not the client's alias", async () => {
    const config = await loadConfig(`
api-keys:
  claude:
    - keys: [{ api-key: sk-ant-api03-test }]
      models:
        - name: claude-sonnet-5-5
          alias: team-model
        - name: claude-opus-5
          alias: old-model
`);

    const p = makePipeline({ config, respond: () => jsonResponse(message("claude-sonnet-5-5")) });

    try {
      for (const alias of ["team-model", "old-model"]) {
        expect(
          (await p.call("/v1/messages", postJson(request(alias, { tool_choice: FORCED_TOOL }))))
            .status,
        ).toBe(200);
      }

      const sent = p.calls.map((call) => JSON.parse(call.body) as JsonObject);
      expect(sent[0]?.model).toBe("claude-sonnet-5-5");
      expect(sent[0]?.tool_choice).toEqual(AUTO);
      expect(sent[1]?.model).toBe("claude-opus-5");
      expect(sent[1]?.tool_choice).toEqual(FORCED_TOOL);
    } finally {
      await p.dispose();
    }
  });

  it("rewrites the forced choice of an OpenAI chat request", async () => {
    const config = await loadConfig(keyYaml(["claude-sonnet-5-5"]));

    // A non-stream client is served from a streamed upstream response.
    const events = [
      { type: "message_start", message: { ...message("claude-sonnet-5-5"), content: [] } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ];

    const p = makePipeline({
      config,
      respond: () =>
        sseResponse(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)),
    });

    try {
      const response = await p.call(
        "/v1/chat/completions",
        postJson({
          model: "claude-sonnet-5-5",
          messages: [{ role: "user", content: "Weather in Paris?" }],
          tools: [
            {
              type: "function",
              function: { name: "lookup_weather", parameters: tools[0]!.input_schema },
            },
          ],
          tool_choice: { type: "function", function: { name: "lookup_weather" } },
          parallel_tool_calls: false,
        }),
      );

      expect(response.status).toBe(200);
      const sent = JSON.parse(p.calls[0]!.body) as JsonObject;
      expect(sent.tool_choice).toEqual(AUTO);
    } finally {
      await p.dispose();
    }
  });
});

describe("preserved-thinking binding after the rewrite", () => {
  const signed = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan", signature: claudeSignature() },
      { type: "text", text: "answer" },
    ],
  };

  const history = (model: string, extra: JsonObject = {}): JsonObject =>
    request(model, {
      messages: [
        { role: "user", content: "first question" },
        signed,
        { role: "user", content: "second question" },
      ],
      ...extra,
    });

  it.each([
    ["claude-opus-5-5", { thinking: { type: "adaptive" } }],
    ["claude-opus-5-5", {}],
    ["claude-sonnet-5-5", { thinking: { type: "adaptive" } }],
  ])("%s with a forced tool and signed history gets the binding (%j)", async (model, thinking) => {
    const sent = await send(history(model, { tool_choice: FORCED_TOOL, ...thinking }));
    expect(sent.body.tool_choice).toEqual(AUTO);
    expect(sent.body.thinking).toEqual({ type: "adaptive", block_binding: DROP });
    expect(betasOf(sent.call)).toContain(BINDING_BETA);
    expect(JSON.stringify(sent.body.messages)).toContain(claudeSignature());
  });

  it("keeps the known gap: Haiku 5.5 stays forced and unbound", async () => {
    const sent = await send(
      history("claude-haiku-5-5", { tool_choice: FORCED_TOOL, thinking: { type: "adaptive" } }),
    );

    expect(sent.body.tool_choice).toEqual(FORCED_TOOL);
    expect(sent.body.thinking).toBeUndefined();
    expect(betasOf(sent.call)).not.toContain(BINDING_BETA);
  });
});

describe("count_tokens", () => {
  it("sends the upstream count request with auto", async () => {
    const sent = await send(request("claude-sonnet-5-5", { tool_choice: FORCED_ANY }), {
      path: "/v1/messages/count_tokens",
    });

    expect(sent.body.tool_choice).toEqual(AUTO);
  });

  it("binds signed history of a forced count request", async () => {
    const sent = await send(
      request("claude-opus-5-5", {
        tool_choice: FORCED_TOOL,
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "t", signature: claudeSignature() }],
          },
          { role: "user", content: "q2" },
        ],
      }),
      { path: "/v1/messages/count_tokens" },
    );

    expect(sent.body.tool_choice).toEqual(AUTO);
    expect(sent.body.thinking).toEqual({ type: "adaptive", block_binding: DROP });
  });

  // The local estimate (a gateway without count_tokens) discards the body, so the pipeline step is read directly.
  it("rewrites the body estimated locally", async () => {
    const config = await loadConfig(keyYaml(["claude-opus-5-5"]));
    const gateway = credential("claude", { kind: "apikey", attributes: { api_key: "k" } });

    const prepare = (model: string) =>
      Effect.runPromise(
        prepareLocalCountBody({
          services: {
            registry: builtinTranslators,
            continuity: makeSessionStateContinuityStore(),
            replay: makeMemoryReplayStore(),
            deviceProfiles: makeSessionStateDeviceProfileStore(),
            toolAliases: makeSessionStateToolAliasStore(),
            now: () => new Date(0),
          },
          config,
          credential: gateway,
          request: { model, payload: request("spoofed-body-model", { tool_choice: FORCED_TOOL }) },
          options: options({
            sourceFormat: "claude",
            metadata: { ...options().metadata, requestPath: "/v1/messages/count_tokens" },
          }),
          upstreamStream: false,
        }).pipe(Effect.provide(Thinking.live)),
      );

    expect((await prepare("claude-opus-5-5")).tool_choice).toEqual(AUTO);
    expect((await prepare("claude-opus-5")).tool_choice).toEqual(FORCED_TOOL);
  });
});

const rules = (params: string, kind: "override" | "filter" = "override"): string => `
requests:
  payload:
    ${kind}:
      - models: [{ name: "claude-opus-5-5", protocol: claude }]
        params:${params}
`;

describe("payload rules stay the last word", () => {
  it("lets an override rule force the tool again", async () => {
    const sent = await send(request("claude-opus-5-5", { tool_choice: FORCED_TOOL }), {
      rules: rules(`
          tool_choice.type: tool
          tool_choice.name: user_override`),
    });

    expect(sent.body.tool_choice).toMatchObject({ type: "tool", name: "user_override" });
  });

  it("lets a filter rule remove tool_choice, which the rewrite does not restore", async () => {
    const sent = await send(request("claude-opus-5-5", { tool_choice: FORCED_TOOL }), {
      rules: rules(' ["tool_choice"]', "filter"),
    });

    expect(sent.body.tool_choice).toBeUndefined();
  });
});

describe("delegated providers", () => {
  it("does not rewrite a forced choice for a profile that maps to Claude 5.5 (Kimi)", async () => {
    const executor = makeClaudeExecutor({
      profile: { normalizeModel: () => "claude-opus-5-5" },
    });

    const h = await harness(
      credential("kimi", {
        kind: "apikey",
        attributes: { api_key: "k", base_url: "https://gw.example" },
      }),
      () => new Response(JSON.stringify(message("claude-opus-5-5"))),
    );

    await execute(
      executor,
      h,
      {
        model: "claude-opus-5-5",
        payload: json(request("claude-opus-5-5", { tool_choice: FORCED_TOOL })),
      },
      options({ sourceFormat: "claude" }),
    );

    expect(JSON.parse(h.calls[0]?.text ?? "{}").tool_choice).toEqual(FORCED_TOOL);
  });
});
