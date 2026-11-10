// End-to-end tests (workerd) of the Claude 5.5 forced tool_choice rewrite on the Claude request pipeline: Opus 5.5 and
// Sonnet 5.5 reject forced tool use, so `any`/`tool` becomes `auto` before thinking preparation (CLIProxyAPI 1d45a5f3,
// internal/runtime/executor/claude_issue7000_test.go and claude_issue7000_regression_test.go).
import { Effect } from "effect";
import type { Config } from "../src/config/schema.ts";
import { describe, expect, it } from "vitest";
import { prepareLocalCountBody } from "../src/executor/claude/pipeline.ts";
import { makeSessionStateContinuityStore } from "../src/executor/claude/continuity.ts";
import { makeSessionStateDeviceProfileStore } from "../src/executor/claude/device-profile.ts";
import { makeMemoryReplayStore } from "../src/executor/claude/thinking-replay.ts";
import { makeSessionStateToolAliasStore } from "../src/executor/claude/thread.ts";
import { makeClaudeExecutor } from "../src/executor/claude/executor.ts";
import { Thinking } from "../src/executor/thinking.ts";
import type { JsonObject } from "@commissary/json";
import {
  builtinTranslators,
  getModelInfoLookup,
  setModelInfoLookup,
  str,
} from "@commissary/translation";
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

/** `prepareLocalCountBody` for a gateway credential without count_tokens (the local estimate). */
const prepareLocal = (config: Config, model: string, payload: JsonObject) =>
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
      credential: credential("claude", { kind: "apikey", attributes: { api_key: "k" } }),
      request: { model, payload },
      options: options({
        sourceFormat: "claude",
        metadata: { ...options().metadata, requestPath: "/v1/messages/count_tokens" },
      }),
      upstreamStream: false,
    }).pipe(Effect.provide(Thinking.live)),
  );

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

  it("rewrites the full form: variant, date, context suffix and thinking suffix", async () => {
    const sent = await send(
      request("claude-opus-5-5-high-20260901[1m](high)", { tool_choice: FORCED_TOOL }),
      { models: ["claude-opus-5-5-high-20260901[1m]"] },
    );

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
});

describe("OpenAI sources", () => {
  const SCHEMA = {
    type: "object",
    properties: { issue7000_title: { type: "string" } },
    required: ["issue7000_title"],
    additionalProperties: false,
  };

  const weatherTool = {
    name: "lookup_weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  };

  /** Chat and Responses bodies for Sonnet 5.5 with high reasoning effort, a forced choice and optional schema. */
  const chatBody = (toolChoice: JsonObject | string, withSchema: boolean): JsonObject => {
    const body: JsonObject = {
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "Weather in Paris?" }],
      reasoning_effort: "high",
      tools: [{ type: "function", function: weatherTool }],
      tool_choice: toolChoice,
      parallel_tool_calls: false,
    };

    if (withSchema)
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "weather", strict: true, schema: SCHEMA },
      };

    return body;
  };

  const responsesBody = (toolChoice: JsonObject | string, withSchema: boolean): JsonObject => {
    const body: JsonObject = {
      model: "claude-sonnet-5-5",
      input: [{ role: "user", content: [{ type: "input_text", text: "Weather in Paris?" }] }],
      reasoning: { effort: "high" },
      tools: [{ type: "function", ...weatherTool }],
      tool_choice: toolChoice,
      parallel_tool_calls: false,
    };

    if (withSchema)
      body.text = {
        format: { type: "json_schema", name: "weather", strict: true, schema: SCHEMA },
      };

    return body;
  };

  it.each([
    ["chat", "/v1/chat/completions", chatBody, "required"],
    [
      "chat",
      "/v1/chat/completions",
      chatBody,
      { type: "function", function: { name: "lookup_weather" } },
    ],
    ["responses", "/v1/responses", responsesBody, "required"],
    ["responses", "/v1/responses", responsesBody, { type: "function", name: "lookup_weather" }],
  ] as const)(
    "rewrites the forced choice of a %s request (%j), with and without a schema",
    async (source, path, build, toolChoice) => {
      const previous = getModelInfoLookup();

      setModelInfoLookup((id) =>
        id === "claude-sonnet-5-5"
          ? { id, thinking: { levels: ["low", "medium", "high"] } }
          : undefined,
      );

      try {
        for (const withSchema of [false, true]) {
          // A non-stream client is served from a streamed upstream response.
          const events = [
            { type: "message_start", message: { ...message("claude-sonnet-5-5"), content: [] } },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 2 },
            },
            { type: "message_stop" },
          ];

          const p = makePipeline({
            config: await loadConfig(keyYaml(["claude-sonnet-5-5"])),
            respond: () =>
              sseResponse(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)),
          });

          try {
            expect((await p.call(path, postJson(build(toolChoice, withSchema)))).status).toBe(200);
            const sent = JSON.parse(p.calls[0]!.body) as JsonObject;
            // The Responses translator does not map `parallel_tool_calls: false` to `disable_parallel_tool_use`
            // (Go does, claude_openai-responses_request.go): a translator gap outside this rewrite, so it is not pinned.
            expect(sent.tool_choice).toEqual(source === "chat" ? AUTO : { type: "auto" });
            expect((sent.tools as JsonObject[])[0]?.name).toBe("lookup_weather");
            expect(sent.thinking).toEqual({ type: "adaptive" });
            expect(sent.output_config).toEqual({ effort: "high" });

            // The schema stays a prompt, not a native output format.
            const system = JSON.stringify(sent.system ?? null);
            expect(system.includes("issue7000_title")).toBe(withSchema);
            expect((sent.output_config as JsonObject).format).toBeUndefined();
          } finally {
            await p.dispose();
          }
        }
      } finally {
        setModelInfoLookup(previous);
      }
    },
  );
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
    const forced = request("spoofed-body-model", { tool_choice: FORCED_TOOL });

    expect((await prepareLocal(config, "claude-opus-5-5", forced)).tool_choice).toEqual(AUTO);
    expect((await prepareLocal(config, "claude-opus-5", forced)).tool_choice).toEqual(FORCED_TOOL);
  });
});

/** Rules for Opus 5.5; `conditions` are more keys of the model entry (`exist`, `match`). */
const rules = (
  params: string,
  kind: "override" | "filter" = "override",
  conditions = "",
): string => `
requests:
  payload:
    ${kind}:
      - models: [{ name: "claude-opus-5-5", protocol: claude${conditions} }]
        params:${params}
`;

/** Conditions that only hold on the rewritten body: the rule must see `auto`, the routed model and surviving thinking. */
const SEES_REWRITTEN =
  ", exist: [thinking], match: [{ tool_choice.type: auto, model: claude-opus-5-5 }]";

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

  it("runs rule conditions on the rewritten body, and an override keeps thinking intact", async () => {
    const sent = await send(
      request("claude-opus-5-5", {
        tool_choice: FORCED_TOOL,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
      }),
      {
        rules: rules(
          `
          tool_choice: { type: tool, name: user_override }
          observed_builtin: true`,
          "override",
          SEES_REWRITTEN,
        ),
      },
    );

    expect(sent.body.tool_choice).toEqual({ type: "tool", name: "user_override" });
    expect(sent.body.observed_builtin).toBe(true);
    expect(sent.body.thinking).toEqual({ type: "adaptive" });
    expect(sent.body.output_config).toEqual({ effort: "high" });
  });

  it("lets a filter whose conditions need the rewrite remove thinking, effort, tools and the choice", async () => {
    const sent = await send(
      request("claude-opus-5-5", {
        tool_choice: FORCED_TOOL,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
      }),
      {
        rules: rules(
          ' ["tool_choice", "thinking", "output_config.effort", "tools"]',
          "filter",
          SEES_REWRITTEN,
        ),
      },
    );

    for (const key of ["tool_choice", "thinking", "tools"]) expect(sent.body[key]).toBeUndefined();
    expect((sent.body.output_config as JsonObject | undefined)?.effort).toBeUndefined();
  });

  // The local estimate (a gateway without count_tokens) discards the body, so the pipeline step is read directly.
  it.each([
    [
      "override",
      "\n          tool_choice: { type: tool, name: explicit_user_override }",
      { type: "tool", name: "explicit_user_override" },
    ],
    ["filter", ' ["tool_choice"]', undefined],
  ] as const)(
    "keeps a %s rule final on the body estimated locally",
    async (kind, params, expected) => {
      const config = await loadConfig(
        keyYaml(["claude-opus-5-5"], rules(params, kind, SEES_REWRITTEN)),
      );

      const body = await prepareLocal(
        config,
        "claude-opus-5-5",
        request("spoofed-body-model", { tool_choice: FORCED_TOOL, thinking: { type: "adaptive" } }),
      );

      expect(body.tool_choice).toEqual(expected);
    },
  );
});

describe("native output format", () => {
  it("keeps output_config.format beside the rewritten choice and the effort", async () => {
    const format = {
      type: "json_schema",
      schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    };

    const sent = await send(
      request("claude-opus-5-5", {
        tool_choice: { type: "any" },
        thinking: { type: "adaptive" },
        output_config: { effort: "high", format },
      }),
    );

    expect(sent.body.output_config).toEqual({ effort: "high", format });
    expect(sent.body.tool_choice).toEqual({ type: "auto" });
    expect(sent.body.thinking).toEqual({ type: "adaptive" });
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
