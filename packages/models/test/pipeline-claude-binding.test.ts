// End-to-end tests (workerd) of the preserved-thinking block binding on the Claude request pipeline: signed thinking
// history on the models that check it against the creation-time prefix gets
// `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` and the `thinking-binding-controls` beta
// (CLIProxyAPI 911f49cb, e13bc9a1). Anthropic: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
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
import { builtinTranslators, setModelInfoLookup } from "@commissary/translation";
import { claudeSignature } from "./support/signatures.ts";
import { oauthPipeline } from "./support/claude-oauth.ts";
import { credential, execute, harness, options } from "./support/executor-run.ts";
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

/** The seven preserved-thinking models; Mythos 5.1 and 5.2 deliberately differ from Go. */
const PRESERVED = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
  "claude-mythos-5-1",
  "claude-fable-5-2",
  "claude-mythos-5-2",
];

const OTHERS = ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];

const keyYaml = (rules = ""): string => `
api-keys:
  claude:
    - keys:
        - api-key: sk-ant-api03-test
      models:
${[...PRESERVED, ...OTHERS].map((name) => `        - name: ${name}`).join("\n")}
${rules}`;

const message = (): JsonObject => ({
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 3 },
});

const signedBlock = (): JsonObject => ({
  type: "thinking",
  thinking: "plan",
  signature: claudeSignature(),
});

/** A turn that replays an assistant message with the given blocks, then asks again. */
const history = (
  model: string,
  extra: JsonObject = {},
  blocks: JsonObject[] = [signedBlock()],
): JsonObject => ({
  model,
  max_tokens: 64,
  messages: [
    { role: "user", content: "first question" },
    { role: "assistant", content: [...blocks, { type: "text", text: "answer" }] },
    { role: "user", content: "second question" },
  ],
  ...extra,
});

interface Sent {
  readonly body: JsonObject;
  readonly betas: string[];
  readonly call: UpstreamCall;
}

const betasOf = (call: UpstreamCall): string[] =>
  (call.headers["anthropic-beta"] ?? "").split(",").filter((beta) => beta !== "");

/** One request through a caller-owned provider key (no cloaking) to the first-party host. */
const send = async (
  body: JsonObject,
  { rules = "", path = "/v1/messages", headers = {} } = {},
): Promise<Sent> => {
  const config = await loadConfig(keyYaml(rules));

  const p = makePipeline({
    config,
    respond: () => jsonResponse(path.endsWith("count_tokens") ? { input_tokens: 5 } : message()),
  });

  try {
    expect((await p.call(path, postJson(body, headers))).status).toBe(200);
    const call = p.calls[0]!;

    return { body: JSON.parse(call.body) as JsonObject, betas: betasOf(call), call };
  } finally {
    await p.dispose();
  }
};

describe("preserved-thinking models", () => {
  it.each(PRESERVED)(
    "%s binds signed adaptive thinking with drop_block and the beta",
    async (model) => {
      const sent = await send(history(model, { thinking: { type: "adaptive" } }));
      expect(sent.body.thinking).toEqual({ type: "adaptive", block_binding: DROP });
      expect(sent.betas).toContain(BINDING_BETA);
    },
  );

  it.each(OTHERS)("%s gets no binding and no beta", async (model) => {
    const sent = await send(history(model, { thinking: { type: "adaptive" } }));
    expect(JSON.stringify(sent.body.thinking)).not.toContain("block_binding");
    expect(sent.betas).not.toContain(BINDING_BETA);
  });

  it("matches the upstream model after aliasing", async () => {
    const config = await loadConfig(`
api-keys:
  claude:
    - keys: [{ api-key: sk-ant-api03-test }]
      models:
        - name: claude-opus-5-5
          alias: team-opus
`);

    const p = makePipeline({ config, respond: () => jsonResponse(message()) });

    try {
      const body = history("team-opus", { thinking: { type: "adaptive" } });
      expect((await p.call("/v1/messages", postJson(body))).status).toBe(200);
      const sent = JSON.parse(p.calls[0]!.body) as JsonObject;
      expect(sent.model).toBe("claude-opus-5-5");
      expect(sent.thinking).toEqual({ type: "adaptive", block_binding: DROP });
    } finally {
      await p.dispose();
    }
  });
});

describe("omitted thinking", () => {
  it("states the adaptive default along with the binding when history is signed", async () => {
    const sent = await send(history("claude-opus-5-5"));
    expect(sent.body.thinking).toEqual({ type: "adaptive", block_binding: DROP });
    expect(sent.betas).toContain(BINDING_BETA);
  });

  it("leaves the body alone without signed blocks", async () => {
    const plain = await send(history("claude-opus-5-5", {}, []));
    expect(plain.body.thinking).toBeUndefined();
    expect(plain.betas).not.toContain(BINDING_BETA);
  });

  it("is not triggered by a thinking block with an empty signature", async () => {
    const unsigned = await send(
      history("claude-opus-5-5", {}, [{ type: "thinking", thinking: "plan", signature: "" }]),
    );

    expect(unsigned.body.thinking).toBeUndefined();
    expect(unsigned.betas).not.toContain(BINDING_BETA);
  });

  it("is triggered by a redacted_thinking block with data", async () => {
    const redacted = await send(
      history("claude-opus-5-5", {}, [{ type: "redacted_thinking", data: claudeSignature() }]),
    );

    expect(redacted.body.thinking).toEqual({ type: "adaptive", block_binding: DROP });
  });
});

describe("thinking types that cannot carry a binding", () => {
  it.each([
    { type: "enabled", budget_tokens: 2048 },
    { type: "disabled" },
    { type: "between_tools" },
    { display: "summarized" },
  ])("leaves thinking %j untouched", async (thinking) => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      const sent = await send(history(model, { thinking }));
      expect(JSON.stringify(sent.body.thinking ?? null)).not.toContain("block_binding");
      expect(sent.betas).not.toContain(BINDING_BETA);
    }
  });

  it("keeps a caller-supplied prefix_mismatch_behavior and still sends the beta", async () => {
    const thinking = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } };
    const sent = await send(history("claude-opus-5-5", { thinking }));
    expect(sent.body.thinking).toEqual(thinking);
    expect(sent.betas).toContain(BINDING_BETA);
  });
});

describe("forced tool choice", () => {
  const tools = [{ name: "get_weather", description: "weather", input_schema: { type: "object" } }];

  it.each([{ type: "any" }, { type: "tool", name: "get_weather" }])(
    "injects nothing for tool_choice %j, with or without thinking",
    async (toolChoice) => {
      for (const thinking of [{}, { thinking: { type: "adaptive" } }]) {
        const sent = await send(
          history("claude-opus-5-5", { tools, tool_choice: toolChoice, ...thinking }),
        );

        expect(sent.body.thinking).toBeUndefined();
        expect(sent.betas).not.toContain(BINDING_BETA);
      }
    },
  );

  it.each([{ type: "auto" }, { type: "none" }])(
    "still injects for tool_choice %j",
    async (toolChoice) => {
      const sent = await send(
        history("claude-opus-5-5", {
          tools,
          tool_choice: toolChoice,
          thinking: { type: "adaptive" },
        }),
      );

      expect(sent.body.thinking).toEqual({ type: "adaptive", block_binding: DROP });
    },
  );
});

describe("thinking chosen by the thinking pipeline", () => {
  it("only adds block_binding to what a model suffix produced", async () => {
    setModelInfoLookup((id) =>
      id === "claude-opus-5-5"
        ? { id, thinking: { levels: ["low", "medium", "high"] } }
        : undefined,
    );

    try {
      const unsigned = await send(history("claude-opus-5-5(high)", {}, []));
      const signed = await send(history("claude-opus-5-5(high)"));
      const chosen = unsigned.body.thinking as JsonObject;
      // The suffix did produce a thinking configuration to preserve.
      expect(chosen).toBeDefined();
      expect(signed.body.thinking).toEqual({ ...chosen, block_binding: DROP });
      expect(signed.body.output_config).toEqual(unsigned.body.output_config);
    } finally {
      setModelInfoLookup(() => undefined);
    }
  });
});

describe("payload rules stay the last word", () => {
  it("lets a filter rule delete the binding, and the beta follows the final body", async () => {
    const sent = await send(history("claude-opus-5-5", { thinking: { type: "adaptive" } }), {
      rules: `
requests:
  payload:
    filter:
      - models: [{ name: "claude-opus-5-5", protocol: claude }]
        params: ["thinking.block_binding"]
`,
    });

    expect(sent.body.thinking).toEqual({ type: "adaptive" });
    expect(sent.betas).not.toContain(BINDING_BETA);
  });

  it("lets an override rule choose another behaviour, which keeps the beta", async () => {
    const sent = await send(history("claude-opus-5-5", { thinking: { type: "adaptive" } }), {
      rules: `
requests:
  payload:
    override:
      - models: [{ name: "claude-opus-5-5", protocol: claude }]
        params:
          thinking.block_binding.prefix_mismatch_behavior: error
`,
    });

    expect(sent.body.thinking).toEqual({
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "error" },
    });

    expect(sent.betas).toContain(BINDING_BETA);
  });
});

describe("the beta follows the final body in every fingerprint mode", () => {
  const body = (extra: JsonObject = {}): JsonObject =>
    history("claude-opus-5-5", { thinking: { type: "adaptive" }, ...extra });

  it("is sent to a caller-owned API key with its own betas", async () => {
    const sent = await send(body(), { headers: { "anthropic-beta": "my-custom-beta" } });
    expect(sent.betas).toEqual(["my-custom-beta", BINDING_BETA]);
  });

  it("is not duplicated when the caller already sends it", async () => {
    const sent = await send(body(), { headers: { "anthropic-beta": BINDING_BETA } });
    expect(sent.betas).toEqual([BINDING_BETA]);
  });

  it("is sent with the cloaked OAuth betas", async () => {
    const h = oauthPipeline(() => jsonResponse(message()), await loadConfig(""));

    try {
      expect((await h.pipeline.call("/v1/messages", postJson(body()))).status).toBe(200);
      const call = h.pipeline.calls[0]!;
      expect((JSON.parse(call.body) as JsonObject).thinking).toMatchObject({ block_binding: DROP });
      expect(betasOf(call).filter((beta) => beta === BINDING_BETA)).toHaveLength(1);
      expect(betasOf(call)).toContain("claude-code-20250219");
    } finally {
      await h.pipeline.dispose();
    }
  });

  it("is sent at the minimal cloak level", async () => {
    const h = oauthPipeline(
      () => jsonResponse(message()),
      await loadConfig("upstream: { claude: { cloak-level: minimal } }"),
    );

    try {
      expect((await h.pipeline.call("/v1/messages", postJson(body()))).status).toBe(200);
      const call = h.pipeline.calls[0]!;
      expect(betasOf(call)).toContain(BINDING_BETA);
      expect(betasOf(call)).not.toContain("claude-code-20250219");
    } finally {
      await h.pipeline.dispose();
    }
  });

  const CLAUDE_CODE_HEADERS = {
    "user-agent": "claude-cli/2.1.321 (external, cli)",
    "x-app": "cli",
    "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
  };

  const userId = JSON.stringify({
    device_id: "a".repeat(64),
    account_uuid: "",
    session_id: "11111111-2222-4333-8444-555555555555",
  });

  it.each([
    ["/v1/messages", { metadata: { user_id: userId } }],
    ["/v1/messages/count_tokens", {}],
  ])("is added to a confirmed Claude Code passthrough on %s", async (path, extra) => {
    const h = oauthPipeline(
      () => jsonResponse(path.endsWith("count_tokens") ? { input_tokens: 5 } : message()),
      await loadConfig(""),
    );

    try {
      const response = await h.pipeline.call(path, postJson(body(extra), CLAUDE_CODE_HEADERS));
      expect(response.status).toBe(200);
      const call = h.pipeline.calls[0]!;
      // Confirmed passthrough: the caller's own betas travel, with the binding beta appended.
      expect(betasOf(call)).toContain("interleaved-thinking-2025-05-14");
      expect(betasOf(call)).toContain(BINDING_BETA);
      expect(call.headers["user-agent"]).toBe("claude-cli/2.1.321 (external, cli)");
    } finally {
      await h.pipeline.dispose();
    }
  });
});

describe("count_tokens", () => {
  it("injects the binding and sends the beta upstream", async () => {
    const sent = await send(history("claude-opus-5-5"), { path: "/v1/messages/count_tokens" });
    expect(sent.body.thinking).toEqual({ type: "adaptive", block_binding: DROP });
    expect(sent.betas).toContain(BINDING_BETA);
    expect(sent.betas).toContain("token-counting-2024-11-01");
  });

  it("injects the binding into the OAuth count request", async () => {
    const h = oauthPipeline(() => jsonResponse({ input_tokens: 5 }), await loadConfig(""));

    try {
      const response = await h.pipeline.call(
        "/v1/messages/count_tokens",
        postJson(history("claude-sonnet-5-5")),
      );

      expect(response.status).toBe(200);
      const call = h.pipeline.calls[0]!;
      expect((JSON.parse(call.body) as JsonObject).thinking).toEqual({
        type: "adaptive",
        block_binding: DROP,
      });

      expect(betasOf(call)).toContain(BINDING_BETA);
    } finally {
      await h.pipeline.dispose();
    }
  });

  it("leaves an unsigned count request alone", async () => {
    const sent = await send(history("claude-opus-5-5", {}, []), {
      path: "/v1/messages/count_tokens",
    });

    expect(sent.body.thinking).toBeUndefined();
    expect(sent.betas).not.toContain(BINDING_BETA);
  });

  // The local estimate (a gateway without count_tokens) discards the body, so the pipeline step is read directly.
  it("injects the binding into the body estimated locally", async () => {
    const config = await loadConfig(keyYaml());
    const gateway = credential("claude", { kind: "apikey", attributes: { api_key: "k" } });

    const input = (model: string) => ({
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
      request: { model, payload: history(model) },
      options: options({
        sourceFormat: "claude",
        metadata: { ...options().metadata, requestPath: "/v1/messages/count_tokens" },
      }),
      upstreamStream: false,
    });

    const run = (model: string) =>
      Effect.runPromise(prepareLocalCountBody(input(model)).pipe(Effect.provide(Thinking.live)));

    expect((await run("claude-opus-5-5")).thinking).toEqual({
      type: "adaptive",
      block_binding: DROP,
    });

    expect((await run("claude-opus-5")).thinking).toBeUndefined();
  });
});

describe("thinking replay", () => {
  it("binds blocks restored from the replay cache", async () => {
    const yaml = `
api-keys:
  claude:
    - base-url: https://gateway.test
      keys: [{ api-key: gw-key }]
`;

    // `is-compat` reaches the executor on the resolved model, not through the config.
    const modelInfo = { id: "claude-opus-5-5", isCompat: true };

    const executor = makeClaudeExecutor({ replay: makeMemoryReplayStore() });

    const toolUse: JsonObject = { type: "tool_use", id: "toolu_01", name: "lookup", input: {} };

    let reply: JsonObject = {
      ...message(),
      content: [signedBlock(), toolUse],
      stop_reason: "tool_use",
    };

    const h = await harness(
      credential("claude", {
        kind: "apikey",
        attributes: { api_key: "gw-key", base_url: "https://gateway.test" },
      }),
      () => new Response(JSON.stringify(reply)),
      yaml,
    );

    const claude = (messages: JsonObject[]) => ({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages,
    });

    const opts = () =>
      options({
        sourceFormat: "claude",
        metadata: { ...options().metadata, requestPath: "/v1/messages", sessionId: "sess-1" },
      });

    const first = [{ role: "user", content: "q" }];
    await execute(
      executor,
      h,
      { model: "claude-opus-5-5", payload: claude(first), modelInfo },
      opts(),
    );
    reply = message();

    // The client resends the assistant turn without its thinking block; the cache restores it.
    await execute(
      executor,
      h,
      {
        model: "claude-opus-5-5",
        modelInfo,
        payload: claude([
          ...first,
          { role: "assistant", content: [toolUse] },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "ok" }],
          },
        ]),
      },
      opts(),
    );

    const second = JSON.parse(h.calls[1]!.text) as {
      messages: Array<{ content: JsonObject[] }>;
      thinking: JsonObject;
    };

    expect(second.messages[1]!.content.map((block) => block.type)).toEqual([
      "thinking",
      "tool_use",
    ]);
    expect(second.thinking).toEqual({ type: "adaptive", block_binding: DROP });
    expect(h.calls[1]!.headers["anthropic-beta"]).toContain(BINDING_BETA);
  });
});

describe("input_transformations", () => {
  const transformations = [{ type: "drop_block", reason: "prefix_mismatch", index: 1 }];

  it("reaches the client from a non-streamed response", async () => {
    const config = await loadConfig(keyYaml());

    const p = makePipeline({
      config,
      respond: () => jsonResponse({ ...message(), input_transformations: transformations }),
    });

    try {
      const response = await p.call("/v1/messages", postJson(history("claude-opus-5-5")));
      expect(((await response.json()) as JsonObject).input_transformations).toEqual(
        transformations,
      );
    } finally {
      await p.dispose();
    }
  });

  it("reaches the client in the streamed message_start", async () => {
    const config = await loadConfig(keyYaml());

    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_01",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          usage: { input_tokens: 11, output_tokens: 1 },
          input_transformations: transformations,
        },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ];

    const p = makePipeline({
      config,
      respond: () =>
        sseResponse(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        ),
    });

    try {
      const response = await p.call(
        "/v1/messages",
        postJson({ ...history("claude-opus-5-5"), stream: true }),
      );

      const data = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5).trim()) as JsonObject);

      const started = data.find((event) => event.type === "message_start")!;
      expect((started.message as JsonObject).input_transformations).toEqual(transformations);
    } finally {
      await p.dispose();
    }
  });
});
