// GitHub Copilot through the client API: a signed-in Copilot credential on the production API Worker
// (`exports.default.fetch`) with the real ControlPlane picker and model registry; only Copilot's API is mocked, through
// the global `fetch`. Each of Copilot's endpoints (Chat Completions, Messages, Responses) answers in the stream it would
// send, and every client protocol reads it back translated (Go: copilot_executor*_test.go, 9792ac28, 20211183,
// b824c052, f911b453, 9abeef8c, 5dff8b67).
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { FULL_ACCESS, withModelsPart } from "@commissary/models/testing";

type Upstream = (request: Request) => Response | Promise<Response>;

interface Captured {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

const API = "https://api.individual.githubcopilot.com";

let upstream: Upstream = () => new Response("no upstream", { status: 599 });

const upstreamCalls: Captured[] = [];

const realFetch = globalThis.fetch;

// Copilot's models publish as `copilot/<id>` (f89d408e). The alias is the OAuth model alias of the Copilot channel
// (5dff8b67), named after that source: clients name `sonnet`, Copilot gets the native id. A payload rule that names the
// source applies to its alias too.
const YAML = `
oauth-model-alias:
  copilot:
    - name: copilot/claude-sonnet-5.5
      alias: sonnet
      fork: true
payload:
  override:
    - models:
        - name: copilot/claude-sonnet-5.5
      params:
        top_k: 7
`;

const CREDENTIAL = {
  type: "copilot",
  account_id: "42",
  username: "octocat",
  access_token: "copilot-token",
  refresh_token: "github-grant",
  base_url: API,
  expired: "2999-01-01T00:00:00Z",
};

const sse = (frames: ReadonlyArray<unknown>, done = false): Response =>
  new Response(
    `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}${done ? "data: [DONE]\n\n" : ""}`,
    { headers: { "content-type": "text/event-stream" } },
  );

/** One frame of a typed SSE stream (Claude, Responses): its `type` names the event. */
interface TypedFrame {
  readonly type: string;
  readonly [field: string]: unknown;
}

const typedSse = (frames: ReadonlyArray<TypedFrame>): Response =>
  new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const chatChunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1_800_000_000,
  model: "gemini-4-argon",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/** Copilot Chat Completions: two text deltas, then the usage chunk and `[DONE]`. */
const chatStream = () =>
  sse(
    [
      chatChunk({ role: "assistant", content: "Hel" }),
      chatChunk({ content: "lo" }, "stop"),
      {
        ...chatChunk({}),
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      },
    ],
    true,
  );

/** Copilot Messages: one text block. */
const messagesStream = () =>
  typedSse([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5.5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 7, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]);

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5.5",
  content: [{ type: "text", text: "Hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 7, output_tokens: 2 },
};

const OUTPUT_MESSAGE = {
  id: "msg_r1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Hello", annotations: [] }],
};

/** Copilot Responses: one message item. */
const responsesStream = () =>
  typedSse([
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_1", object: "response", status: "in_progress", model: "gpt-6-sol" },
    },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { ...OUTPUT_MESSAGE, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      sequence_number: 2,
      item_id: "msg_r1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: "msg_r1",
      output_index: 0,
      content_index: 0,
      delta: "Hello",
    },
    {
      type: "response.output_text.done",
      sequence_number: 4,
      item_id: "msg_r1",
      output_index: 0,
      content_index: 0,
      text: "Hello",
    },
    {
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 0,
      item: OUTPUT_MESSAGE,
    },
    {
      type: "response.completed",
      sequence_number: 6,
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        model: "gpt-6-sol",
        output: [OUTPUT_MESSAGE],
        usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
      },
    },
  ]);

/** Copilot's API: each endpoint answers in its own protocol, streamed when asked. */
const copilotApi: Upstream = (request) => {
  const path = new URL(request.url).pathname;

  if (path === "/chat/completions") return chatStream();

  if (path === "/v1/messages") return messagesStream();

  if (path === "/responses") return responsesStream();

  return new Response("not found", { status: 404 });
};

/** A client request body: any JSON object of the protocol the path speaks. */
type ClientBody = Readonly<Record<string, unknown>>;

const post = (path: string, body: ClientBody) =>
  exports.default.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const lastCall = (): Captured => {
  const call = upstreamCalls.at(-1);

  if (call === undefined) throw new Error("Copilot was not called");

  return call;
};

/** The `data:` payloads of an SSE answer (`[DONE]` dropped). */
const dataFrames = (text: string): unknown[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
    // SAFETY: `JSON.parse` returns `any`; each frame is narrowed by the reader that uses it.
    .map((line) => JSON.parse(line.slice(5).trim()) as unknown);

/** The text an OpenAI Chat Completions stream carries. */
const chatText = (text: string): string =>
  dataFrames(text)
    .map((frame) => {
      // SAFETY: Chat Completions chunks (`choices[].delta.content`).
      const { choices } = frame as { choices?: Array<{ delta?: { content?: string } }> };

      return choices?.[0]?.delta?.content ?? "";
    })
    .join("");

/** The text a Claude Messages stream carries. */
const claudeText = (text: string): string =>
  dataFrames(text)
    .map((frame) => {
      // SAFETY: Claude stream events (`content_block_delta` text deltas).
      const event = frame as { type?: string; delta?: { text?: string } };

      return event.type === "content_block_delta" ? (event.delta?.text ?? "") : "";
    })
    .join("");

/** The text a Responses stream carries. */
const responsesText = (text: string): string =>
  dataFrames(text)
    .map((frame) => {
      // SAFETY: Responses stream events (`response.output_text.delta`).
      const event = frame as { type?: string; delta?: string };

      return event.type === "response.output_text.delta" ? (event.delta ?? "") : "";
    })
    .join("");

/** The text a Gemini stream carries. */
const geminiText = (text: string): string =>
  dataFrames(text)
    .map((frame) => {
      // SAFETY: Gemini stream chunks (`candidates[].content.parts[].text`).
      const chunk = frame as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };

      return (chunk.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
    })
    .join("");

const USER = [{ role: "user", content: "Say hello" }];

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.clone().text();

    upstreamCalls.push({
      url: request.url,
      // SAFETY: the executor only ever posts JSON objects to Copilot.
      headers: request.headers,
      body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
    });

    return await upstream(request);
  };

  const controlPlane = env.CONTROL_PLANE.getByName("global");
  const stored = await withModelsPart(controlPlane, (part) => part.importConfig(YAML, "test"));
  expect(stored.ok).toBe(true);

  const imported = await withModelsPart(controlPlane, (part) =>
    part.importAuthFile("copilot-42.json", JSON.stringify(CREDENTIAL), {}, FULL_ACCESS),
  );

  expect(imported.ok).toBe(true);

  // A credential whose origin is not one of Copilot's: its token must never leave.
  const untrusted = await withModelsPart(controlPlane, (part) =>
    part.importAuthFile(
      "copilot-43.json",
      JSON.stringify({
        ...CREDENTIAL,
        account_id: "43",
        prefix: "untrusted",
        base_url: "https://copilot.evil.example",
      }),
      {},
      FULL_ACCESS,
    ),
  );

  expect(untrusted.ok).toBe(true);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  upstreamCalls.length = 0;
  upstream = copilotApi;
});

describe("Copilot models", () => {
  it("lists the presets of a signed-in Copilot account, with its OAuth aliases", async () => {
    const response = await exports.default.fetch(new Request("http://localhost/v1/models"));
    expect(response.status).toBe(200);
    // SAFETY: the OpenAI model listing (`data[].id`).
    const listed = (await response.json()) as { data: Array<{ id: string; owned_by?: string }> };
    const ids = listed.data.map((model) => model.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "copilot/claude-sonnet-5.5",
        "sonnet",
        "copilot/gpt-6-sol",
        "copilot/gemini-4-argon",
      ]),
    );
    // Only the published routes: the native ids are not Copilot's to serve.
    expect(ids).not.toContain("gpt-6-sol");
    expect(ids.filter((id) => id.startsWith("copilot/copilot/"))).toEqual([]);
    expect(upstreamCalls).toEqual([]);
  });

  it("serves no native id, and resolves the published route's thinking suffix", async () => {
    const bare = await post("/v1/chat/completions", { model: "gpt-6-sol", messages: USER });

    expect(bare.status).not.toBe(200);
    await bare.text();
    expect(upstreamCalls).toEqual([]);

    const suffixed = await post("/v1/responses", {
      model: "copilot/gpt-6-sol(high)",
      stream: true,
      input: "Say hello",
    });

    expect(suffixed.status).toBe(200);
    await suffixed.text();
    expect(lastCall().body).toMatchObject({ model: "gpt-6-sol", reasoning: { effort: "high" } });
  });
});

describe("Copilot Chat Completions route", () => {
  it("streams an OpenAI client's request with the CLI's identity to the trusted origin", async () => {
    const response = await post("/v1/chat/completions", {
      model: "copilot/gemini-4-argon",
      stream: true,
      messages: [
        ...USER,
        // 9abeef8c: plain text assistant history goes up as a string, even for a native Chat client.
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hi" },
            { type: "text", text: " there" },
          ],
        },
        { role: "user", content: "Again" },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    });

    expect(response.status).toBe(200);
    expect(chatText(await response.text())).toBe("Hello");

    const call = lastCall();
    expect(call.url).toBe(`${API}/chat/completions`);
    expect(call.headers.get("authorization")).toBe("Bearer copilot-token");
    expect(call.headers.get("copilot-integration-id")).toBe("copilot-developer-cli");
    expect(call.headers.get("editor-version")).toBe("copilot/1.0.114");
    expect(call.headers.get("x-initiator")).toBe("user");
    expect(call.headers.get("openai-intent")).toBe("conversation-agent");
    expect(call.body).toMatchObject({
      model: "gemini-4-argon",
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "medium",
      snippy: { enabled: false },
      tool_choice: "validated",
      temperature: 1,
    });
    // SAFETY: the Chat Completions body the executor sent.
    const messages = call.body["messages"] as Array<{ role: string; content: unknown }>;
    expect(messages[1]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("streams back to a Claude client in Claude events", async () => {
    const response = await post("/v1/messages", {
      model: "copilot/gemini-4-argon",
      max_tokens: 256,
      stream: true,
      messages: USER,
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(claudeText(text)).toBe("Hello");
    expect(text).toContain("event: message_stop");
  });

  it("answers a Gemini client's stream and counts its tokens in Gemini's format", async () => {
    const streamed = await post(
      "/v1beta/models/copilot/gemini-4-argon:streamGenerateContent?alt=sse",
      {
        contents: [{ role: "user", parts: [{ text: "Say hello" }] }],
      },
    );

    expect(streamed.status).toBe(200);
    expect(geminiText(await streamed.text())).toBe("Hello");
    expect(lastCall().url).toBe(`${API}/chat/completions`);

    upstreamCalls.length = 0;

    const counted = await post("/v1beta/models/copilot/gemini-4-argon:countTokens", {
      contents: [{ role: "user", parts: [{ text: "Say hello" }] }],
    });

    expect(counted.status).toBe(200);
    // b824c052: a Gemini client gets `totalTokens`, counted locally.
    expect(await counted.json()).toMatchObject({ totalTokens: expect.any(Number) });
    expect(upstreamCalls).toEqual([]);
  });
});

describe("Copilot Messages route", () => {
  it("streams a Claude client's request through its alias with the CLI's defaults", async () => {
    const response = await post("/v1/messages", {
      model: "sonnet",
      max_tokens: 1024,
      stream: true,
      messages: USER,
    });

    expect(response.status).toBe(200);
    expect(claudeText(await response.text())).toBe("Hello");

    const call = lastCall();
    expect(call.url).toBe(`${API}/v1/messages`);
    expect(call.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(call.headers.get("anthropic-beta")).toBe(
      "thinking-binding-controls-2026-08-01,fallback-credit-2026-07-01",
    );
    expect(call.body).toMatchObject({
      model: "claude-sonnet-5.5",
      stream: true,
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      output_config: { effort: "medium" },
      // f89d408e: the payload rule names the alias's source, `copilot/claude-sonnet-5.5`.
      top_k: 7,
    });
  });

  it("answers a non-streaming Claude client from Copilot's JSON, capped to the non-streaming limit", async () => {
    upstream = () => Response.json(MESSAGE);

    const response = await post("/v1/messages", {
      model: "copilot/claude-sonnet-5.5",
      messages: USER,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "Hello" }] });
    expect(lastCall().body).toMatchObject({ stream: false, max_tokens: 16_000 });
  });

  it("streams back to an OpenAI client and a Responses client", async () => {
    const chat = await post("/v1/chat/completions", {
      model: "copilot/claude-sonnet-5.5",
      stream: true,
      messages: USER,
    });

    expect(chat.status).toBe(200);
    expect(chatText(await chat.text())).toBe("Hello");
    // The shared Claude translators' synthesized user id stays home: Copilot identifies the session by header.
    expect(lastCall().body["metadata"]).toBeUndefined();

    const responses = await post("/v1/responses", {
      model: "copilot/claude-sonnet-5.5",
      stream: true,
      input: "Say hello",
    });

    expect(responses.status).toBe(200);
    expect(responsesText(await responses.text())).toBe("Hello");
  });
});

describe("Copilot Responses route", () => {
  it("streams a Responses client's request with the CLI's defaults", async () => {
    const response = await post("/v1/responses", {
      model: "copilot/gpt-6-sol",
      stream: true,
      instructions: "Be brief.",
      input: "Say hello",
    });

    expect(response.status).toBe(200);
    expect(responsesText(await response.text())).toBe("Hello");

    const call = lastCall();
    expect(call.url).toBe(`${API}/responses`);
    expect(call.body).toMatchObject({
      model: "gpt-6-sol",
      stream: true,
      store: false,
      text: { verbosity: "low" },
      reasoning: { effort: "medium" },
    });
  });

  it("converts OpenAI and Claude clients to standard Responses, with the CLI's default effort", async () => {
    const chat = await post("/v1/chat/completions", {
      model: "copilot/grok-4.7",
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
      max_completion_tokens: 2048,
      messages: USER,
    });

    expect(chat.status).toBe(200);
    expect(chatText(await chat.text())).toBe("Hello");
    // 7ae771fc: no Codex wire defaults, so the CLI profile's effort applies and sampling passes through.
    expect(lastCall().body).toMatchObject({
      model: "grok-4.7",
      temperature: 0.2,
      top_p: 0.9,
      // 01b24f1f: the client's output limit goes up on standard Responses.
      max_output_tokens: 2048,
      // The CLI turns summaries on for a model with a default effort (Go `ApplyCopilotThinking`).
      reasoning: { effort: "high", summary: "auto" },
    });

    const claude = await post("/v1/messages", {
      model: "copilot/grok-4.7",
      max_tokens: 256,
      stream: true,
      temperature: 0.5,
      top_p: 0.8,
      messages: USER,
    });

    expect(claude.status).toBe(200);
    expect(claudeText(await claude.text())).toBe("Hello");
    expect(lastCall().body).toMatchObject({
      temperature: 0.5,
      top_p: 0.8,
      max_output_tokens: 256,
      reasoning: { effort: "high", summary: "auto" },
    });
  });

  it("streams back to OpenAI and Claude clients and collects a non-streaming answer", async () => {
    const chat = await post("/v1/chat/completions", {
      model: "copilot/gpt-6-sol",
      stream: true,
      messages: [{ role: "system", content: "Be brief." }, ...USER],
    });

    expect(chat.status).toBe(200);
    expect(chatText(await chat.text())).toBe("Hello");
    // The CLI sends a leading system prompt of this model as `system` input.
    // SAFETY: the Responses body the executor sent.
    const input = lastCall().body["input"] as Array<{ role?: string }>;
    expect(input[0]?.role).toBe("system");

    const claude = await post("/v1/messages", {
      model: "copilot/gpt-6-sol",
      max_tokens: 256,
      stream: true,
      messages: USER,
    });

    expect(claude.status).toBe(200);
    expect(claudeText(await claude.text())).toBe("Hello");

    const collected = await post("/v1/chat/completions", {
      model: "copilot/gpt-6-sol",
      messages: USER,
    });

    expect(collected.status).toBe(200);
    expect(await collected.json()).toMatchObject({
      choices: [{ message: { role: "assistant", content: "Hello" } }],
    });
    // Copilot's Responses answers always stream; the executor collects them.
    expect(lastCall().body["stream"]).toBe(true);
  });
});

describe("Copilot credentials", () => {
  it("never sends a token to an origin that is not Copilot's", async () => {
    const response = await post("/v1/chat/completions", {
      model: "untrusted/copilot/gemini-4-argon",
      messages: USER,
    });

    expect(response.status).not.toBe(200);
    await response.text();
    // Only the token refresh after the refusal may go out, to GitHub, with the GitHub token.
    expect(upstreamCalls.filter((call) => !call.url.startsWith("https://api.github.com/"))).toEqual(
      [],
    );
  });
});
