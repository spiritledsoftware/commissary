// End-to-end (workerd) through Access, model resolution, the credential picker, the executor registry and the
// conductor for OpenCode Zen and OpenCode Go against mocked gateways: protocol choice per model, request shapes,
// gateway headers (auth, session, client identity), error classification and usage records.
import { Effect, Layer, Logger } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import { OPENCODE_USER_AGENT } from "../src/executor/opencode/headers.ts";
import { ModelProviders } from "../src/handlers/model-providers.ts";
import type { Json } from "@commissary/json";
import { fixedPicker, type PickerLog } from "./support/codex.ts";
import {
  jsonResponse,
  loadConfig,
  makePipeline,
  postJson,
  sseResponse,
  type UpstreamCall,
  type UpstreamResponder,
} from "./support/pipeline.ts";

type Gateway = "opencode-zen" | "opencode-go";

const providers = (provider: string): Layer.Layer<ModelProviders> =>
  Layer.succeed(
    ModelProviders,
    ModelProviders.of({
      providersFor: () => Effect.succeed([provider]),
      firstAvailableModel: Effect.succeed("m"),
    }),
  );

const BASE: Record<Gateway, string> = {
  "opencode-zen": "https://zen.test/v1",
  "opencode-go": "https://go.test/v1",
};

const KEY: Record<Gateway, string> = { "opencode-zen": "zen-key", "opencode-go": "go-key" };

const credential = (
  gateway: Gateway,
  id = `${gateway}-1`,
  key = KEY[gateway],
): CredentialSnapshot => ({
  id,
  provider: gateway,
  kind: "apikey",
  label: gateway,
  attributes: { api_key: key, base_url: BASE[gateway], config_index: "0" },
  metadata: {},
});

const configFor = (gateway: Gateway, models = ""): Promise<Config> =>
  loadConfig(`api-keys:
  ${gateway}:
    - keys:
        - api-key: ${KEY[gateway]}
${models}`);

/** Catalog models per protocol (src/registry/catalog/opencode_models.json, AI SDK package). */
const MODELS: Record<Gateway, { chat: string; responses: string; messages: string }> = {
  "opencode-zen": {
    chat: "deepseek-v4-flash",
    responses: "gpt-5",
    messages: "claude-haiku-4-5",
  },
  "opencode-go": { chat: "deepseek-v4-flash", responses: "gpt-6-luna", messages: "minimax-m3" },
};

// --- canned gateway answers ---------------------------------------------------------------------------------------

const chatCompletion = (model: string): Json => ({
  id: "c1",
  object: "chat.completion",
  created: 1,
  model,
  choices: [
    { index: 0, message: { role: "assistant", content: "hi from chat" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

const chatStream = (model: string): string[] => [
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "hi " } }] })}\n\n`,
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "from chat" }, finish_reason: "stop" }] })}\n\n`,
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
  "data: [DONE]\n\n",
];

const responsesStream = (model: string): string[] => {
  const item = {
    id: "m1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "hi from responses", annotations: [] }],
  };

  const response = {
    id: "r1",
    object: "response",
    created_at: 1,
    status: "completed",
    model,
    output: [item],
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
  };

  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: "hi from responses" })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
  ];
};

const claudeMessage = (model: string): Json => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text: "hi from messages" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 6, output_tokens: 4 },
});

const claudeStream = (model: string): string[] => {
  const event = (name: string, data: Json) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

  return [
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 6, output_tokens: 0 },
      },
    }),
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi from messages" },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    }),
    event("message_stop", { type: "message_stop" }),
  ];
};

/** A gateway that answers every protocol by URL (non-stream bodies get JSON, stream bodies SSE). */
const gateway: UpstreamResponder = (call) => {
  // SAFETY: every gateway request body is a JSON object.
  const body = JSON.parse(call.body) as { model?: string; stream?: boolean };
  const model = body.model ?? "m";

  if (call.url.endsWith("/chat/completions"))
    return body.stream === true
      ? sseResponse(chatStream(model))
      : jsonResponse(chatCompletion(model));

  if (call.url.endsWith("/responses")) return sseResponse(responsesStream(model));

  if (call.url.endsWith("/messages"))
    return body.stream === true
      ? sseResponse(claudeStream(model))
      : jsonResponse(claudeMessage(model));

  return new Response("not found", { status: 404 });
};

const harness = async (
  gatewayName: Gateway,
  options: {
    readonly config?: Config;
    readonly respond?: UpstreamResponder;
    readonly credentials?: ReadonlyArray<CredentialSnapshot>;
    readonly log?: PickerLog;
    readonly logs?: Array<string>;
  } = {},
) => {
  const p = makePipeline({
    config: options.config ?? (await configFor(gatewayName)),
    credentialPicker: fixedPicker(options.credentials ?? [credential(gatewayName)], options.log),
    modelProviders: providers(gatewayName),
    respond: options.respond ?? gateway,
    ...(options.logs !== undefined
      ? {
          extraLayers: Logger.layer([
            Logger.make(({ logLevel, message }) => {
              options.logs?.push(`${logLevel}: ${[message].flat().map(String).join(" ")}`);
            }),
          ]),
        }
      : {}),
  });

  afterAll(p.dispose);

  return p;
};

const chatRequest = (model: string, stream = false, extra: Record<string, Json> = {}): Json => ({
  model,
  stream,
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

const claudeRequest = (model: string, stream = false, extra: Record<string, Json> = {}): Json => ({
  model,
  stream,
  max_tokens: 64,
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

const bodyOf = (call: UpstreamCall | undefined): Record<string, unknown> =>
  // SAFETY: every gateway request body is a JSON object.
  JSON.parse(call?.body ?? "{}") as Record<string, unknown>;

type ChatAnswer = { choices: Array<{ message: { content: string } }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

for (const gw of ["opencode-zen", "opencode-go"] as const) {
  const models = MODELS[gw];
  const base = BASE[gw];
  const key = KEY[gw];

  describe(`${gw}: protocol per model`, () => {
    it("chat model from an OpenAI chat client (non-stream): /chat/completions with bearer auth", async () => {
      const p = await harness(gw);
      const response = await p.call("/v1/chat/completions", postJson(chatRequest(models.chat)));

      expect(response.status).toBe(200);
      // SAFETY: the shape of a successful client answer in this protocol.
      const body = (await response.json()) as ChatAnswer;
      expect(body.choices[0]?.message.content).toBe("hi from chat");
      const call = p.calls[0];
      expect(call?.url).toBe(`${base}/chat/completions`);
      expect(call?.headers["authorization"]).toBe(`Bearer ${key}`);
      expect(call?.headers["x-api-key"]).toBeUndefined();
      expect(call?.headers["user-agent"]).toBe(OPENCODE_USER_AGENT);
      expect(call?.headers["x-opencode-client"]).toBe("commissary");
      expect(call?.headers["x-opencode-session"]).toMatch(UUID);
      expect(bodyOf(call)).toMatchObject({ model: models.chat, messages: [{ role: "user" }] });
      expect(p.records[0]).toMatchObject({
        provider: gw,
        model: models.chat,
        failed: false,
        detail: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      });
    });

    it("chat model from a Claude client (stream): Chat Completions body with include_usage, Claude events back", async () => {
      const p = await harness(gw);

      const response = await p.call("/v1/messages", postJson(claudeRequest(models.chat, true)));

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("event: message_start");
      expect(text).toContain("from chat");
      const call = p.calls[0];
      expect(call?.url).toBe(`${base}/chat/completions`);
      expect(call?.headers["accept"]).toBe("text/event-stream");
      expect(bodyOf(call)).toMatchObject({
        model: models.chat,
        stream: true,
        stream_options: { include_usage: true },
      });
      expect(p.records[0]?.detail).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    });

    it("responses model from an OpenAI chat client (non-stream): /responses streamed upstream, chat answer back", async () => {
      const p = await harness(gw);

      const response = await p.call(
        "/v1/chat/completions",
        postJson(chatRequest(models.responses)),
      );

      expect(response.status).toBe(200);
      // SAFETY: the shape of a successful client answer in this protocol.
      const body = (await response.json()) as ChatAnswer;
      expect(body.choices[0]?.message.content).toBe("hi from responses");
      const call = p.calls[0];
      expect(call?.url).toBe(`${base}/responses`);
      expect(call?.headers["authorization"]).toBe(`Bearer ${key}`);
      expect(call?.headers["accept"]).toBe("text/event-stream");
      expect(bodyOf(call)).toMatchObject({ model: models.responses, stream: true });
      expect(bodyOf(call)["input"]).toBeInstanceOf(Array);
      expect(bodyOf(call)).not.toHaveProperty("messages");
      expect(p.records[0]?.detail).toMatchObject({ inputTokens: 4, outputTokens: 3 });
    });

    it("responses model from a Claude client (stream): Claude events back", async () => {
      const p = await harness(gw);

      const response = await p.call(
        "/v1/messages",
        postJson(claudeRequest(models.responses, true)),
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("event: message_start");
      expect(text).toContain("hi from responses");
      expect(p.calls[0]?.url).toBe(`${base}/responses`);
      expect(bodyOf(p.calls[0])).toMatchObject({ model: models.responses, stream: true });
    });

    it("messages model from a Claude client (non-stream): /messages with x-api-key, upstream JSON back", async () => {
      const p = await harness(gw);

      const response = await p.call("/v1/messages", postJson(claudeRequest(models.messages)));

      expect(response.status).toBe(200);
      // SAFETY: the shape of a successful client answer in this protocol.
      const body = (await response.json()) as { content: Array<{ text: string }> };
      expect(body.content[0]?.text).toBe("hi from messages");
      const call = p.calls[0];
      expect(call?.url).toBe(`${base}/messages`);
      expect(call?.headers["x-api-key"]).toBe(key);
      expect(call?.headers["anthropic-version"]).toBe("2023-06-01");
      expect(call?.headers["authorization"]).toBeUndefined();
      expect(call?.headers["x-opencode-session"]).toMatch(UUID);
      expect(bodyOf(call)).toMatchObject({ model: models.messages, stream: false, max_tokens: 64 });
      expect(p.records[0]?.detail).toMatchObject({ inputTokens: 6, outputTokens: 4 });
    });

    it("messages model from an OpenAI chat client (non-stream): streamed upstream, chat answer back", async () => {
      const p = await harness(gw);

      const response = await p.call("/v1/chat/completions", postJson(chatRequest(models.messages)));

      expect(response.status).toBe(200);
      // SAFETY: the shape of a successful client answer in this protocol.
      const body = (await response.json()) as ChatAnswer;
      expect(body.choices[0]?.message.content).toBe("hi from messages");
      const call = p.calls[0];
      expect(call?.url).toBe(`${base}/messages`);
      expect(bodyOf(call)).toMatchObject({ model: models.messages, stream: true });
      expect(bodyOf(call)["messages"]).toEqual([
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ]);
      expect(p.records[0]?.detail).toMatchObject({ inputTokens: 6, outputTokens: 4 });
    });

    it("messages model from an OpenAI chat client (stream): chat chunks back", async () => {
      const p = await harness(gw);

      const response = await p.call(
        "/v1/chat/completions",
        postJson(chatRequest(models.messages, true)),
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("chat.completion.chunk");
      expect(text).toContain("hi from messages");
      expect(p.calls[0]?.url).toBe(`${base}/messages`);
    });

    it("responses model from an OpenAI Responses client (non-stream): /responses upstream, a response object back", async () => {
      const p = await harness(gw);

      const response = await p.call(
        "/v1/responses",
        postJson({ model: models.responses, input: "hello" }),
      );

      expect(response.status).toBe(200);
      // SAFETY: the shape of a successful client answer in this protocol.
      const body = (await response.json()) as { object?: string; output?: unknown };
      expect(body.object).toBe("response");
      expect(JSON.stringify(body.output)).toContain("hi from responses");
      expect(p.calls[0]?.url).toBe(`${base}/responses`);
      expect(bodyOf(p.calls[0])).toMatchObject({ model: models.responses, stream: true });
    });

    it("messages model from an OpenAI Responses client (stream): /messages upstream, Responses events back", async () => {
      const p = await harness(gw);

      const response = await p.call(
        "/v1/responses",
        postJson({ model: models.messages, input: "hello", stream: true }),
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("response.output_text.delta");
      expect(text).toContain("response.completed");
      expect(text).toContain("from messages");
      expect(p.calls[0]?.url).toBe(`${base}/messages`);
      expect(p.calls[0]?.headers["x-api-key"]).toBe(key);
      expect(bodyOf(p.calls[0])).toMatchObject({ model: models.messages, stream: true });
    });

    it("a config protocol override wins over the catalog", async () => {
      const config = await configFor(
        gw,
        `      models:
        - name: ${models.messages}
          protocol: chat
`,
      );

      const p = await harness(gw, { config });
      const response = await p.call("/v1/chat/completions", postJson(chatRequest(models.messages)));

      expect(response.status).toBe(200);
      expect(p.calls[0]?.url).toBe(`${base}/chat/completions`);
      expect(p.calls[0]?.headers["authorization"]).toBe(`Bearer ${key}`);
    });

    it("an unknown model falls back to chat with a logged warning", async () => {
      const logs: string[] = [];
      const p = await harness(gw, { logs });

      const response = await p.call(
        "/v1/messages",
        postJson(claudeRequest("not-in-the-catalog-1")),
      );

      expect(response.status).toBe(200);
      expect(p.calls[0]?.url).toBe(`${base}/chat/completions`);
      expect(bodyOf(p.calls[0])).toMatchObject({ model: "not-in-the-catalog-1" });
      expect(logs).toContainEqual(
        expect.stringMatching(
          /^Warn: model not-in-the-catalog-1 is not in the .* catalog; using \/chat\/completions$/,
        ),
      );
    });
  });
}

describe("opencode-zen: gemini protocol", () => {
  it("posts generateContent with x-goog-api-key and the gateway headers", async () => {
    const p = await harness("opencode-zen", {
      respond: () =>
        jsonResponse({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "hi from gemini" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
          modelVersion: "gemini-3-flash",
        }),
    });

    const response = await p.call("/v1/chat/completions", postJson(chatRequest("gemini-3-flash")));

    expect(response.status).toBe(200);
    // SAFETY: the shape of a successful client answer in this protocol.
    const body = (await response.json()) as ChatAnswer;
    expect(body.choices[0]?.message.content).toBe("hi from gemini");
    const call = p.calls[0];
    expect(call?.url).toBe("https://zen.test/v1/models/gemini-3-flash:generateContent");
    expect(call?.headers["x-goog-api-key"]).toBe("zen-key");
    expect(call?.headers["authorization"]).toBeUndefined();
    expect(call?.headers["x-opencode-session"]).toMatch(UUID);
    expect(call?.headers["user-agent"]).toBe(OPENCODE_USER_AGENT);
    expect(bodyOf(call)["contents"]).toBeInstanceOf(Array);
  });

  it("a gemini override on OpenCode Go falls back to chat", async () => {
    const config = await configFor(
      "opencode-go",
      `      models:
        - name: deepseek-v4-flash
          protocol: gemini
`,
    );

    const p = await harness("opencode-go", { config });

    const response = await p.call(
      "/v1/chat/completions",
      postJson(chatRequest("deepseek-v4-flash")),
    );

    expect(response.status).toBe(200);
    expect(p.calls[0]?.url).toBe("https://go.test/v1/chat/completions");
  });
});

describe("x-opencode-session", () => {
  const sessionOf = (call: UpstreamCall | undefined) => call?.headers["x-opencode-session"];

  it("forwards the client's own x-opencode-session unchanged", async () => {
    const p = await harness("opencode-go");

    await p.call(
      "/v1/chat/completions",
      postJson(chatRequest("deepseek-v4-flash"), { "x-opencode-session": "ses_client123" }),
    );

    expect(sessionOf(p.calls[0])).toBe("ses_client123");
  });

  it("maps a Claude Code session to a stable UUID that is not the raw id", async () => {
    const p = await harness("opencode-go");
    const raw = "0b6c6f9e-5a3d-4c1e-9f2a-7d8e9c0b1a2f";
    const userId = `user_abc_account__session_${raw}`;

    for (const text of ["hello", "next turn"]) {
      await p.call(
        "/v1/messages",
        postJson(
          claudeRequest("minimax-m3", false, {
            metadata: { user_id: userId },
            messages: [{ role: "user", content: text }],
          }),
        ),
      );
    }

    const [first, second] = p.calls.map(sessionOf);
    expect(first).toMatch(UUID);
    expect(first).not.toBe(raw);
    expect(second).toBe(first);

    // The Messages body's metadata.user_id is hashed too: stable, and not the client's identity.
    const [firstUser, secondUser] = p.calls.map((call) => {
      const metadata = bodyOf(call)["metadata"];

      return typeof metadata === "object" && metadata !== null && "user_id" in metadata
        ? metadata.user_id
        : undefined;
    });

    expect(firstUser).toMatch(UUID);
    expect(firstUser).not.toBe(userId);
    expect(firstUser).not.toBe(first);
    expect(secondUser).toBe(firstUser);
  });

  it("keeps a derived identity stable across turns and distinct across conversations", async () => {
    const p = await harness("opencode-go");

    const conversation = (first: string, turns: number): Json => ({
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: first },
        ...Array.from({ length: turns }, (_, i) => [
          { role: "assistant", content: `answer ${i}` },
          { role: "user", content: `follow-up ${i}` },
        ]).flat(),
      ],
    });

    await p.call("/v1/chat/completions", postJson(conversation("plan a trip", 0)));
    await p.call("/v1/chat/completions", postJson(conversation("plan a trip", 1)));
    await p.call("/v1/chat/completions", postJson(conversation("write a poem", 0)));

    const [a1, a2, b1] = p.calls.map(sessionOf);
    expect(a1).toMatch(UUID);
    expect(a2).toBe(a1);
    expect(b1).toMatch(UUID);
    expect(b1).not.toBe(a1);
  });

  it("a configured custom header overrides the session", async () => {
    const config = await configFor(
      "opencode-zen",
      `      headers:
        x-opencode-session: fixed-session
`,
    );

    const cred = credential("opencode-zen");

    const p = await harness("opencode-zen", {
      config,
      credentials: [
        {
          ...cred,
          attributes: { ...cred.attributes, "header:x-opencode-session": "fixed-session" },
        },
      ],
    });

    await p.call("/v1/chat/completions", postJson(chatRequest("deepseek-v4-flash")));

    expect(sessionOf(p.calls[0])).toBe("fixed-session");
  });
});

describe("OpenCode anthropic-beta", () => {
  const CLIENT_BETAS =
    "claude-code-20250219,oauth-2025-04-20,mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01,inline-tools-2026-09-15";

  const FORWARDED_BETAS =
    "mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01,inline-tools-2026-09-15";

  const EFFORT_MESSAGE: Json = { role: "system", content: [], output_config: { effort: "low" } };

  const perTurnEffort = (): Json =>
    claudeRequest("minimax-m3", false, {
      messages: [{ role: "user", content: "hello" }, EFFORT_MESSAGE],
    });

  const betaOf = (call: UpstreamCall | undefined) => call?.headers["anthropic-beta"];

  it("forwards the client's schema betas without the identity betas; the effort message reaches the gateway unchanged", async () => {
    const p = await harness("opencode-go");

    const response = await p.call(
      "/v1/messages",
      postJson(perTurnEffort(), { "anthropic-beta": CLIENT_BETAS }),
    );

    expect(response.status).toBe(200);
    expect(p.calls[0]?.url).toBe("https://go.test/v1/messages");
    expect(betaOf(p.calls[0])).toBe(FORWARDED_BETAS);
    expect(bodyOf(p.calls[0])["messages"]).toEqual([
      { role: "user", content: "hello" },
      EFFORT_MESSAGE,
    ]);
  });

  it("adds the mid-conversation output_config beta the body needs when the client sent no beta", async () => {
    const p = await harness("opencode-go");

    await p.call("/v1/messages", postJson(perTurnEffort()));

    expect(betaOf(p.calls[0])).toBe("mid-conversation-output-config-2026-07-01");
  });

  it("sends no beta for a body without a mid-conversation output_config", async () => {
    const p = await harness("opencode-go");

    await p.call("/v1/messages", postJson(claudeRequest("minimax-m3")));

    expect(p.calls[0]?.headers).not.toHaveProperty("anthropic-beta");
  });

  it("sends no beta when the client sent only identity betas", async () => {
    const p = await harness("opencode-go");

    await p.call(
      "/v1/messages",
      postJson(claudeRequest("minimax-m3"), {
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      }),
    );

    expect(p.calls[0]?.headers).not.toHaveProperty("anthropic-beta");
  });

  it("forwards the betas on a streamed request too", async () => {
    const p = await harness("opencode-go");

    const response = await p.call(
      "/v1/messages",
      postJson(
        claudeRequest("minimax-m3", true, {
          messages: [{ role: "user", content: "hello" }, EFFORT_MESSAGE],
        }),
        { "anthropic-beta": CLIENT_BETAS },
      ),
    );

    await response.text();
    expect(betaOf(p.calls[0])).toBe(FORWARDED_BETAS);
  });

  it("a custom header:anthropic-beta attribute overrides the derived value", async () => {
    const cred = credential("opencode-go");

    const p = await harness("opencode-go", {
      credentials: [
        { ...cred, attributes: { ...cred.attributes, "header:anthropic-beta": "custom-beta-1" } },
      ],
    });

    await p.call("/v1/messages", postJson(perTurnEffort(), { "anthropic-beta": CLIENT_BETAS }));

    expect(betaOf(p.calls[0])).toBe("custom-beta-1");
  });

  it("the other protocols send no beta, even when the client sends one", async () => {
    const p = await harness("opencode-go");

    await p.call(
      "/v1/messages",
      postJson(claudeRequest("deepseek-v4-flash"), { "anthropic-beta": CLIENT_BETAS }),
    );
    await p.call(
      "/v1/responses",
      postJson({ model: "gpt-6-luna", input: "hello" }, { "anthropic-beta": CLIENT_BETAS }),
    );

    expect(p.calls.map((call) => call.url)).toEqual([
      "https://go.test/v1/chat/completions",
      "https://go.test/v1/responses",
    ]);

    for (const call of p.calls) expect(call.headers).not.toHaveProperty("anthropic-beta");
  });

  it("a Gemini request sends no beta, even when the client sends one", async () => {
    const p = await harness("opencode-zen", {
      respond: () =>
        jsonResponse({
          candidates: [
            { content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
    });

    await p.call(
      "/v1/chat/completions",
      postJson(chatRequest("gemini-3-flash"), { "anthropic-beta": CLIENT_BETAS }),
    );

    expect(p.calls[0]?.url).toBe("https://zen.test/v1/models/gemini-3-flash:generateContent");
    expect(p.calls[0]?.headers).not.toHaveProperty("anthropic-beta");
  });
});

describe("gateway errors", () => {
  const modelFault = (status: number, type: string, message: string) => () =>
    jsonResponse(
      { type: "error", error: { type, message } },
      { status, headers: { "content-type": "application/json" } },
    );

  it("ModelProtocolUnsupported is a model-level failure with a short cooldown", async () => {
    const log: PickerLog = { picks: [], reports: [] };

    const p = await harness("opencode-go", {
      log,
      respond: modelFault(400, "ModelProtocolUnsupported", "Model does not support this protocol."),
    });

    const response = await p.call(
      "/v1/chat/completions",
      postJson(chatRequest("deepseek-v4-flash")),
    );

    expect(response.status).toBe(400);
    const result = log.reports[0]?.result;
    expect(result).toMatchObject({ success: false, httpStatus: 400, retryAfterMs: 5 * 60_000 });
    expect(result?.error?.code).toBe("model_not_found");
    expect(result?.credentialScoped).not.toBe(true);
    expect(p.records[0]).toMatchObject({ failed: true });
  });

  it("a Zen model disabled for the workspace cools only that model and rotates to the next key", async () => {
    const log: PickerLog = { picks: [], reports: [] };
    const second = credential("opencode-zen", "opencode-zen-2", "zen-key-2");

    const p = await harness("opencode-zen", {
      log,
      credentials: [credential("opencode-zen"), second],
      respond: (call) =>
        call.headers["authorization"] === "Bearer zen-key"
          ? modelFault(403, "AuthError", "Model access is disabled")()
          : gateway(call),
    });

    const response = await p.call(
      "/v1/chat/completions",
      postJson(chatRequest("deepseek-v4-flash")),
    );

    expect(response.status).toBe(200);
    expect(p.calls.map((call) => call.headers["authorization"])).toEqual([
      "Bearer zen-key",
      "Bearer zen-key-2",
    ]);
    expect(log.reports[0]?.result).toMatchObject({
      success: false,
      httpStatus: 403,
      retryAfterMs: 30 * 60_000,
      error: { code: "model_not_found" },
    });
  });

  it("FreeTierError is model-scoped", async () => {
    const log: PickerLog = { picks: [], reports: [] };

    const p = await harness("opencode-zen", {
      log,
      respond: modelFault(
        403,
        "FreeTierError",
        "OpenCode's free tier can only be used from within OpenCode",
      ),
    });

    await p.call("/v1/chat/completions", postJson(chatRequest("big-pickle")));

    expect(log.reports[0]?.result.error?.code).toBe("model_not_found");
  });

  it("an invalid key is credential-scoped", async () => {
    const log: PickerLog = { picks: [], reports: [] };

    const p = await harness("opencode-zen", {
      log,
      respond: () =>
        jsonResponse(
          {
            error: { type: "server_error", message: "Upstream request failed: Invalid credential" },
          },
          { status: 401 },
        ),
    });

    const response = await p.call(
      "/v1/chat/completions",
      postJson(chatRequest("deepseek-v4-flash")),
    );

    expect(response.status).toBe(401);
    expect(log.reports[0]?.result).toMatchObject({
      success: false,
      httpStatus: 401,
      credentialScoped: true,
    });
  });

  it("a Go 429 is credential-scoped and keeps Retry-After; a Zen 429 is not credential-scoped", async () => {
    const tooMany = () =>
      jsonResponse(
        { error: { message: "rate limited" } },
        { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } },
      );

    for (const [gw, scoped] of [
      ["opencode-go", true],
      ["opencode-zen", undefined],
    ] as const) {
      const log: PickerLog = { picks: [], reports: [] };
      const p = await harness(gw, { log, respond: tooMany });
      await p.call("/v1/chat/completions", postJson(chatRequest("deepseek-v4-flash")));
      expect(log.reports[0]?.result).toMatchObject({ httpStatus: 429, retryAfterMs: 7000 });
      expect(log.reports[0]?.result.credentialScoped).toBe(scoped);
    }
  });

  it("a Responses stream error event fails the request", async () => {
    const p = await harness("opencode-go", {
      respond: () =>
        sseResponse([
          `event: error\ndata: ${JSON.stringify({ type: "error", error: { code: 500, message: "boom" } })}\n\n`,
        ]),
    });

    const response = await p.call("/v1/chat/completions", postJson(chatRequest("gpt-6-luna")));

    expect(response.status).toBe(500);
    expect(p.records[0]).toMatchObject({ failed: true });
  });
});

describe("token counting", () => {
  it("counts a messages-protocol model locally (no upstream call)", async () => {
    const p = await harness("opencode-go");

    const response = await p.call(
      "/v1/messages/count_tokens",
      postJson({ model: "minimax-m3", messages: [{ role: "user", content: "hello there" }] }),
    );

    expect(response.status).toBe(200);
    // SAFETY: the shape of a successful client answer in this protocol.
    const body = (await response.json()) as { input_tokens: number };
    expect(body.input_tokens).toBeGreaterThan(0);
    expect(p.calls).toHaveLength(0);
  });
});

describe("Zen free-tier cloak (ADR 0033)", () => {
  const FREE = "big-pickle";
  const CLOAKED_UA = /^commissary opencode\/latest\/\d+\.\d+\.\d+\/commissary$/;
  const SES = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
  const sessionOf = (call: UpstreamCall | undefined) => call?.headers["x-opencode-session"];

  const toolNames = (call: UpstreamCall | undefined) =>
    // SAFETY: Chat Completions tools are `{type: "function", function: {name}}` objects.
    ((bodyOf(call)["tools"] ?? []) as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    );

  const weatherTool: Json = {
    type: "function",
    function: {
      name: "get_weather",
      description: "Weather of a city",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  };

  const readTool: Json = {
    type: "function",
    function: {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  };

  const chunk = (delta: Json, finish: string | null = null): string =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: FREE, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  const callDelta = (index: number, id: string, name: string, args: string): Json => ({
    tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }],
  });

  /** The model calls the stub `read` (index 0) and, when `weather`, the client's tool (index 1). */
  const stubCallStream = (weather: boolean): string[] => [
    chunk({ role: "assistant", content: "" }),
    chunk(callDelta(0, "call_read", "read", "")),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"/etc/hosts"}' } }] }),
    ...(weather ? [chunk(callDelta(1, "call_weather", "get_weather", '{"city":"Paris"}'))] : []),
    chunk({}, "tool_calls"),
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: FREE, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
    "data: [DONE]\n\n",
  ];

  it("cloaks a free model: OpenCode markers upstream, a plain non-stream answer back", async () => {
    const p = await harness("opencode-zen");
    const response = await p.call("/v1/chat/completions", postJson(chatRequest(FREE)));

    expect(response.status).toBe(200);
    // SAFETY: the shape of a successful client answer in this protocol.
    const body = (await response.json()) as ChatAnswer & { object: string };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe("hi from chat");
    const call = p.calls[0];
    expect(call?.url).toBe("https://zen.test/v1/chat/completions");
    expect(call?.headers["user-agent"]).toMatch(CLOAKED_UA);
    expect(call?.headers["x-opencode-client"]).toBe("commissary");
    expect(call?.headers["authorization"]).toBe("Bearer zen-key");
    expect(sessionOf(call)).toMatch(SES);
    expect(bodyOf(call)).toMatchObject({
      model: FREE,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "none",
    });
    expect(toolNames(call)).toEqual(["read"]);
    expect(p.records[0]).toMatchObject({
      failed: false,
      detail: { inputTokens: 3, outputTokens: 2 },
    });
  });

  it("keeps the OpenCode-format session stable per conversation; a client ses_ id is kept, a UUID replaced", async () => {
    const p = await harness("opencode-zen");

    const conversation = (first: string, turns: number): Json => ({
      model: FREE,
      messages: [
        { role: "user", content: first },
        ...Array.from({ length: turns }, (_, i) => [
          { role: "assistant", content: `answer ${i}` },
          { role: "user", content: `follow-up ${i}` },
        ]).flat(),
      ],
    });

    await p.call("/v1/chat/completions", postJson(conversation("plan a trip", 0)));
    await p.call("/v1/chat/completions", postJson(conversation("plan a trip", 1)));
    await p.call("/v1/chat/completions", postJson(conversation("write a poem", 0)));

    const own = "ses_eb1612f3bffeJ2oubftJlUX4Oy";
    const uuid = "3f0c1e4e-8a51-4c5e-9d0e-6f1f4b7c2a10";
    await p.call(
      "/v1/chat/completions",
      postJson(chatRequest(FREE), { "x-opencode-session": own }),
    );
    await p.call(
      "/v1/chat/completions",
      postJson(chatRequest(FREE), { "x-opencode-session": uuid }),
    );

    const [a1, a2, b1, kept, replaced] = p.calls.map(sessionOf);
    expect(a1).toMatch(SES);
    expect(a2).toBe(a1);
    expect(b1).toMatch(SES);
    expect(b1).not.toBe(a1);
    expect(kept).toBe(own);
    expect(replaced).toMatch(SES);
  });

  it("adds the stub read only when the client has no read, leaving a client tool_choice alone", async () => {
    const p = await harness("opencode-zen");

    await p.call(
      "/v1/chat/completions",
      postJson(chatRequest(FREE, false, { tools: [weatherTool], tool_choice: "auto" })),
    );
    await p.call(
      "/v1/chat/completions",
      postJson(chatRequest(FREE, false, { tools: [readTool, weatherTool] })),
    );

    const [withStub, withOwnRead] = p.calls;
    expect(toolNames(withStub)).toEqual(["get_weather", "read"]);
    expect(bodyOf(withStub)["tool_choice"]).toBe("auto");
    expect(bodyOf(withOwnRead)["tools"]).toEqual([readTool, weatherTool]);
    expect(bodyOf(withOwnRead)).not.toHaveProperty("tool_choice");
  });

  it("removes calls to the stub from a streamed answer, renumbering the client's calls", async () => {
    const p = await harness("opencode-zen", { respond: () => sseResponse(stubCallStream(true)) });

    const response = await p.call(
      "/v1/chat/completions",
      postJson(chatRequest(FREE, true, { tools: [weatherTool] })),
    );

    const text = await response.text();
    expect(text).not.toContain('"read"');
    expect(text).not.toContain("/etc/hosts");
    expect(text).toContain('"get_weather"');
    expect(text).toContain('"index":0,"id":"call_weather"');
    expect(text).toContain('"finish_reason":"tool_calls"');
  });

  it("removes calls to the stub from a non-stream answer; with nothing left the answer just stops", async () => {
    const both = await harness("opencode-zen", {
      respond: () => sseResponse(stubCallStream(true)),
    });

    const answer = await both.call(
      "/v1/chat/completions",
      postJson(chatRequest(FREE, false, { tools: [weatherTool] })),
    );

    // SAFETY: the shape of a successful client answer with tool calls.
    const body = (await answer.json()) as {
      choices: Array<{
        finish_reason: string;
        message: { tool_calls?: Array<{ id: string; function: { name: string } }> };
      }>;
    };

    expect(body.choices[0]?.message.tool_calls?.map((call) => call.function.name)).toEqual([
      "get_weather",
    ]);
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");

    const only = await harness("opencode-zen", {
      respond: () => sseResponse(stubCallStream(false)),
    });

    const stopped = await only.call(
      "/v1/chat/completions",
      postJson(chatRequest(FREE, false, { tools: [weatherTool] })),
    );

    // SAFETY: as above.
    const plain = (await stopped.json()) as typeof body;
    expect(plain.choices[0]?.message.tool_calls ?? []).toEqual([]);
    expect(plain.choices[0]?.finish_reason).toBe("stop");
  });

  it("removes stub calls even when a payload rule rewrote the stub, or upstream answered plain JSON", async () => {
    const config = await loadConfig(`api-keys:
  opencode-zen:
    - keys:
        - api-key: zen-key
requests:
  payload:
    override:
      - models: [{ name: "${FREE}", protocol: openai }]
        params: { "tools.0.function.description": "rewritten by a rule" }
`);

    const rewritten = await harness("opencode-zen", {
      config,
      respond: () => sseResponse(stubCallStream(false)),
    });

    const streamed = await rewritten.call(
      "/v1/chat/completions",
      postJson(chatRequest(FREE, true)),
    );

    expect(await streamed.text()).not.toContain("/etc/hosts");

    const plain = await harness("opencode-zen", {
      respond: () =>
        jsonResponse({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: FREE,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_read",
                    type: "function",
                    function: { name: "read", arguments: '{"path":"/etc/hosts"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
    });

    const answer = await plain.call("/v1/chat/completions", postJson(chatRequest(FREE)));
    const text = await answer.text();
    expect(text).not.toContain("/etc/hosts");
    expect(text).toContain('"finish_reason":"stop"');
  });

  it("passes a call to the client's own read through", async () => {
    const p = await harness("opencode-zen", { respond: () => sseResponse(stubCallStream(false)) });

    const response = await p.call(
      "/v1/chat/completions",
      postJson(chatRequest(FREE, true, { tools: [readTool] })),
    );

    const text = await response.text();
    expect(text).toContain('"read"');
    expect(text).toContain("/etc/hosts");
  });

  it("leaves paid models alone in auto mode", async () => {
    const p = await harness("opencode-zen");
    await p.call("/v1/chat/completions", postJson(chatRequest("deepseek-v4-flash")));

    const call = p.calls[0];
    expect(call?.headers["user-agent"]).toBe(OPENCODE_USER_AGENT);
    expect(sessionOf(call)).toMatch(UUID);
    expect(bodyOf(call)["stream"]).toBe(false);
    expect(bodyOf(call)).not.toHaveProperty("tools");
  });

  it("cloak.mode never, or upstream.opencode.disable-cloaking, turns cloaking off; always cloaks paid models", async () => {
    const keyConfig = (mode: string) =>
      loadConfig(`api-keys:
  opencode-zen:
    - keys:
        - api-key: zen-key
          cloak:
            mode: ${mode}
`);

    const never = await harness("opencode-zen", { config: await keyConfig("never") });
    await never.call("/v1/chat/completions", postJson(chatRequest(FREE)));
    expect(never.calls[0]?.headers["user-agent"]).toBe(OPENCODE_USER_AGENT);
    expect(toolNames(never.calls[0])).toEqual([]);

    const disabled = await harness("opencode-zen", {
      config: await loadConfig(`upstream:
  opencode:
    disable-cloaking: true
api-keys:
  opencode-zen:
    - keys:
        - api-key: zen-key
          cloak:
            mode: always
`),
    });

    await disabled.call("/v1/chat/completions", postJson(chatRequest(FREE)));
    expect(disabled.calls[0]?.headers["user-agent"]).toBe(OPENCODE_USER_AGENT);

    const always = await harness("opencode-zen", { config: await keyConfig("always") });
    await always.call("/v1/chat/completions", postJson(chatRequest("deepseek-v4-flash")));
    expect(always.calls[0]?.headers["user-agent"]).toMatch(CLOAKED_UA);
    expect(toolNames(always.calls[0])).toEqual(["read"]);
  });

  it("runs before payload rules", async () => {
    const config = await loadConfig(`api-keys:
  opencode-zen:
    - keys:
        - api-key: zen-key
requests:
  payload:
    override:
      - models: [{ name: "${FREE}", protocol: openai }]
        params: { "tool_choice": "auto" }
`);

    const p = await harness("opencode-zen", { config });
    await p.call("/v1/chat/completions", postJson(chatRequest(FREE)));

    expect(bodyOf(p.calls[0])["tool_choice"]).toBe("auto");
    expect(toolNames(p.calls[0])).toEqual(["read"]);
  });

  it("a workspace that does not allow free endpoints cools only that model", async () => {
    const log: PickerLog = { picks: [], reports: [] };
    const logs: string[] = [];

    const p = await harness("opencode-zen", {
      log,
      logs,
      respond: () =>
        jsonResponse(
          {
            error: {
              type: "server_error",
              message:
                "Upstream request failed: Free models may train on request data. Allow free endpoints in your workspace's Privacy settings to use them.",
            },
          },
          { status: 400 },
        ),
    });

    await p.call("/v1/chat/completions", postJson(chatRequest(FREE)));

    expect(log.reports[0]?.result).toMatchObject({
      success: false,
      httpStatus: 400,
      retryAfterMs: 30 * 60_000,
      error: { code: "model_not_found" },
    });
    expect(log.reports[0]?.result.credentialScoped).not.toBe(true);
    expect(logs.some((line) => line.includes("Privacy settings"))).toBe(true);
  });
});
