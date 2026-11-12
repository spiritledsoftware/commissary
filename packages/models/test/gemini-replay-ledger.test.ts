// The reasoning-replay ledger of the Gemini API and Vertex executors (Go cc95661c, f36b195e): the thought signature and
// native function call a Gemini 3 model issued with a tool call are stored under the session when the turn ends and put
// back into the next request, for the Claude, OpenAI chat and Responses clients that do not carry them. Each target has its
// own SessionState store; native Gemini and Interactions clients make no ledger calls; token counting only peeks.
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  GEMINI_REPLAY_STORE,
  makeSessionStateReplayLedger,
  type ReplayLedger,
  VERTEX_REPLAY_STORE,
} from "../src/executor/helps/reasoning-replay-ledger.ts";
import { makeGoogleExecutor } from "../src/executor/gemini/google.ts";
import { geminiVariant, vertexVariant } from "../src/executor/gemini/targets.ts";
import type { ExecutorOptions, ProviderExecutor } from "../src/executor/types.ts";
import { fixedBackend } from "@commissary/state";
import { asString, get, isJsonArray, type Json, tryParseJson } from "@commissary/json";
import { geminiClaudeToolUseID } from "@commissary/translation";
import { countingBackend, failingBackend } from "./support/counting-backend.ts";
import { nativeGeminiSignature, vertexBareTink } from "./support/gemini-signatures.ts";
import {
  collectStream,
  credential,
  execute,
  harness,
  json,
  options,
  runFail,
} from "./support/executor-run.ts";

const MODEL = "gemini-3-pro-preview";

// A native Gemini envelope: the non-Vertex sanitiser that runs after the replay would turn anything else into the sentinel.
const SIG = nativeGeminiSignature();

const SENTINEL = "skip_thought_signature_validator";

const geminiKey = credential("gemini", {
  kind: "apikey",
  attributes: { api_key: "AIza-test", base_url: "https://gl.test" },
});

const vertexKey = credential("vertex", {
  kind: "apikey",
  attributes: { api_key: "vk-1", base_url: "https://vx.test" },
});

interface Rig {
  readonly backend: ReturnType<typeof countingBackend>;
  readonly gemini: ProviderExecutor;
  readonly vertex: ProviderExecutor;
  readonly ledger: (store: string) => ReplayLedger;
}

const rig = (backend = countingBackend()): Rig => {
  const ledger = (store: string) => makeSessionStateReplayLedger(fixedBackend(backend), store);

  return {
    backend,
    ledger,
    gemini: makeGoogleExecutor({
      ...geminiVariant("gemini"),
      replayLedger: ledger(GEMINI_REPLAY_STORE),
    }),
    vertex: makeGoogleExecutor({ ...vertexVariant, replayLedger: ledger(VERTEX_REPLAY_STORE) }),
  };
};

const toolCallResponse = (finishReason = "STOP", extraParts: Json[] = []) => ({
  candidates: [
    {
      content: {
        role: "model",
        parts: [
          ...extraParts,
          { functionCall: { name: "get_weather", args: { city: "Paris" } }, thoughtSignature: SIG },
        ],
      },
      finishReason,
    },
  ],
  usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
});

const textResponse = {
  candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
};

const jsonOk = (body: Json) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const sse = (chunks: ReadonlyArray<Json>) =>
  new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const optionsFor = (
  sourceFormat: string,
  headers: Record<string, string>,
  overrides: Partial<ExecutorOptions> = {},
) =>
  options({
    sourceFormat,
    headers: new Headers(headers),
    metadata: { ...options().metadata, requestedModel: MODEL },
    ...overrides,
  });

const claudeOptions = (stream = false) =>
  optionsFor("claude", { "x-claude-code-session-id": "sess-1" }, { stream });

const chatOptions = () => optionsFor("openai", { "Session-Id": "chat-1" });

const responsesOptions = () => optionsFor("openai-response", { "Session-Id": "resp-1" });

const claudeTurn1 = {
  model: MODEL,
  max_tokens: 50,
  messages: [{ role: "user", content: "weather?" }],
};

const claudeTurn2 = (id: string) => ({
  model: MODEL,
  max_tokens: 50,
  messages: [
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "get_weather", input: { city: "Paris" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "sunny" }] },
  ],
});

const upstreamParts = (call: { text: string } | undefined): Array<Record<string, unknown>> => {
  const contents = get(tryParseJson(call?.text ?? "{}"), "contents");

  return isJsonArray(contents)
    ? contents.flatMap((content) => {
        const parts = get(content, "parts");

        return isJsonArray(parts) ? (parts as Array<Record<string, unknown>>) : [];
      })
    : [];
};

const sentCallSignature = (call: { text: string } | undefined): string | undefined => {
  const signature = upstreamParts(call).find((part) => part["functionCall"] !== undefined)?.[
    "thoughtSignature"
  ];

  return typeof signature === "string" ? signature : undefined;
};

const toolUseId = (payload: string): string => {
  const blocks = get(tryParseJson(payload), "content");

  const block = isJsonArray(blocks)
    ? blocks.find((candidate) => get(candidate, "type") === "tool_use")
    : undefined;

  return asString(get(block, "id"));
};

/** The model answers a request that carries a tool result with text, and any other with a tool call. */
const toolCallThenText = (call: { text: string }) =>
  jsonOk(call.text.includes("functionResponse") ? textResponse : toolCallResponse());

/** What the ledger of `store` holds for `session` now (a peek: no TTL slide, nothing counted by the caller's marks). */
const ledgerEntry = (backend: Rig["backend"], store: string, session: string) =>
  Effect.runPromise(
    makeSessionStateReplayLedger(fixedBackend(backend), store).peek(MODEL, session),
  );

describe("two turns with a tool call on the Gemini API", () => {
  it("puts the thought signature of a Claude client's tool call back into the next turn", async () => {
    const { gemini, backend } = rig();
    const h = await harness(geminiKey, toolCallThenText);

    const first = await execute(
      gemini,
      h,
      { model: MODEL, payload: json(claudeTurn1) },
      claudeOptions(),
    );

    // The turn read the ledger (a miss) and committed what the model issued.
    expect(backend.count(GEMINI_REPLAY_STORE)).toBe(2);
    expect(backend.ops("get", GEMINI_REPLAY_STORE)).toBe(1);
    expect(backend.ops("put", GEMINI_REPLAY_STORE)).toBe(1);

    await execute(
      gemini,
      h,
      { model: MODEL, payload: json(claudeTurn2(toolUseId(first.payload))) },
      claudeOptions(),
    );

    expect(sentCallSignature(h.calls[1])).toBe(SIG);
    expect(backend.count(VERTEX_REPLAY_STORE)).toBe(0);
  });

  it("starts a session that moves to Vertex with the sentinel: each target keeps its own ledger", async () => {
    const { gemini, vertex, backend } = rig();
    const onGemini = await harness(geminiKey, toolCallThenText);
    const onVertex = await harness(vertexKey, toolCallThenText);

    const first = await execute(
      gemini,
      onGemini,
      { model: MODEL, payload: json(claudeTurn1) },
      claudeOptions(),
    );

    await execute(
      vertex,
      onVertex,
      { model: MODEL, payload: json(claudeTurn2(toolUseId(first.payload))) },
      claudeOptions(),
    );

    expect(sentCallSignature(onVertex.calls[0])).toBe(SENTINEL);
    expect(backend.ops("get", VERTEX_REPLAY_STORE)).toBe(1);
    // The Gemini API entry is untouched by the Vertex turn.
    expect(backend.ops("put", GEMINI_REPLAY_STORE)).toBe(1);
  });

  it("serves an OpenAI chat client the same way", async () => {
    const { gemini } = rig();
    const h = await harness(geminiKey, toolCallThenText);

    const first = await execute(
      gemini,
      h,
      {
        model: MODEL,
        payload: json({ model: MODEL, messages: [{ role: "user", content: "weather?" }] }),
      },
      chatOptions(),
    );

    const call = get(tryParseJson(first.payload), "choices.0.message.tool_calls.0");
    const id = asString(get(call, "id"));

    await execute(
      gemini,
      h,
      {
        model: MODEL,
        payload: json({
          model: MODEL,
          messages: [
            { role: "user", content: "weather?" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id,
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                },
              ],
            },
            { role: "tool", tool_call_id: id, content: "sunny" },
          ],
        }),
      },
      chatOptions(),
    );

    expect(sentCallSignature(h.calls[1])).toBe(SIG);
  });

  it("serves a Responses client the same way", async () => {
    const { gemini } = rig();
    const h = await harness(geminiKey, toolCallThenText);

    const first = await execute(
      gemini,
      h,
      { model: MODEL, payload: json({ model: MODEL, input: "weather?" }) },
      responsesOptions(),
    );

    const output = get(tryParseJson(first.payload), "output");

    const item = isJsonArray(output)
      ? output.find((candidate) => get(candidate, "type") === "function_call")
      : undefined;

    const callId = asString(get(item, "call_id"));

    await execute(
      gemini,
      h,
      {
        model: MODEL,
        payload: json({
          model: MODEL,
          input: [
            { type: "message", role: "user", content: "weather?" },
            {
              type: "function_call",
              call_id: callId,
              name: "get_weather",
              arguments: '{"city":"Paris"}',
            },
            { type: "function_call_output", call_id: callId, output: "sunny" },
          ],
        }),
      },
      responsesOptions(),
    );

    expect(sentCallSignature(h.calls[1])).toBe(SIG);
  });
});

describe("a replayed Vertex bare-Tink signature (Go 1398f273, cc95661c)", () => {
  const bareTink = vertexBareTink();

  const issuedBareTink = (call: { text: string }) =>
    jsonOk(
      call.text.includes("functionResponse")
        ? textResponse
        : {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      functionCall: { name: "get_weather", args: { city: "Paris" } },
                      thoughtSignature: bareTink,
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          },
    );

  it.each([
    ["gemini", geminiKey, SENTINEL],
    ["vertex", vertexKey, bareTink],
  ] as const)(
    "on %s: the sanitiser that follows the replay decides",
    async (name, cred, expected) => {
      const rigged = rig();
      const executor = rigged[name];
      const h = await harness(cred, issuedBareTink);

      const first = await execute(
        executor,
        h,
        { model: MODEL, payload: json(claudeTurn1) },
        claudeOptions(),
      );

      await execute(
        executor,
        h,
        { model: MODEL, payload: json(claudeTurn2(toolUseId(first.payload))) },
        claudeOptions(),
      );

      expect(sentCallSignature(h.calls[1])).toBe(expected);
    },
  );
});

describe("clients that keep their own signatures", () => {
  const nativeHistory = (id: string): Json => ({
    contents: [
      { role: "user", parts: [{ text: "weather?" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "get_weather", args: { city: "Paris" }, id },
            thoughtSignature: SIG,
          },
        ],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "get_weather", id, response: { result: "sunny" } } }],
      },
    ],
  });

  it("makes no ledger call for a Gemini client", async () => {
    const { gemini, backend } = rig();
    const h = await harness(geminiKey, () => jsonOk(textResponse));

    await execute(
      gemini,
      h,
      { model: MODEL, payload: json(nativeHistory("call_1")) },
      optionsFor("gemini", { "Session-Id": "native-1" }),
    );

    expect(backend.calls).toHaveLength(0);
    expect(sentCallSignature(h.calls[0])).toBe(SIG);
  });

  it("makes no ledger call for an Interactions client", async () => {
    const { gemini, backend } = rig();
    const h = await harness(geminiKey, () => jsonOk(textResponse));

    await execute(
      gemini,
      h,
      { model: MODEL, payload: json({ model: MODEL, input: "weather?" }) },
      optionsFor("interactions", { "Session-Id": "ix-1" }),
    );

    expect(backend.calls).toHaveLength(0);
  });

  it("uses the ledger for a Gemini client whose history holds a Claude tool-provenance id", async () => {
    const { gemini, backend } = rig();
    const h = await harness(geminiKey, () => jsonOk(textResponse));
    const id = geminiClaudeToolUseID("call_1", "get_weather", '{"city":"Paris"}');

    await execute(
      gemini,
      h,
      { model: MODEL, payload: json(nativeHistory(id)) },
      optionsFor("gemini", { "Session-Id": "native-2" }),
    );

    expect(backend.count(GEMINI_REPLAY_STORE)).toBeGreaterThan(0);
  });
});

describe("token counting", () => {
  it("peeks the ledger once and writes nothing", async () => {
    const { gemini, backend } = rig();

    const h = await harness(geminiKey, (call) =>
      call.url.endsWith(":countTokens") ? jsonOk({ totalTokens: 7 }) : toolCallThenText(call),
    );

    const first = await execute(
      gemini,
      h,
      { model: MODEL, payload: json(claudeTurn1) },
      claudeOptions(),
    );

    const session = backend.calls[0]?.session ?? "";
    const before = await ledgerEntry(backend, GEMINI_REPLAY_STORE, session);
    const mark = backend.calls.length;

    await Effect.runPromise(
      gemini
        .countTokens(
          h.context,
          { model: MODEL, payload: json(claudeTurn2(toolUseId(first.payload))) },
          claudeOptions(),
        )
        .pipe(Effect.provide(h.layers)),
    );

    const counted = backend.calls.slice(mark, mark + 1);

    expect(backend.calls.length).toBe(mark + 1);
    expect(counted[0]?.ops).toEqual(["get"]);
    expect(counted[0]?.writes).toBe(0);
    expect(await ledgerEntry(backend, GEMINI_REPLAY_STORE, session)).toEqual(before);
  });
});

describe("an upstream 400 about a signature", () => {
  it("clears the ledger entry and answers the client with the 400", async () => {
    const { gemini, backend } = rig();
    let reject = false;

    const h = await harness(geminiKey, (call) =>
      reject
        ? new Response(
            JSON.stringify({ error: { code: 400, message: "Corrupted thought signature." } }),
            {
              status: 400,
            },
          )
        : toolCallThenText(call),
    );

    const first = await execute(
      gemini,
      h,
      { model: MODEL, payload: json(claudeTurn1) },
      claudeOptions(),
    );

    const session = backend.calls[0]?.session ?? "";

    expect((await ledgerEntry(backend, GEMINI_REPLAY_STORE, session)).items).toBeDefined();
    reject = true;

    const error = await runFail(
      gemini.execute(
        h.context,
        { model: MODEL, payload: json(claudeTurn2(toolUseId(first.payload))) },
        claudeOptions(),
      ),
      h.layers,
    );

    expect(error.status).toBe(400);
    expect((await ledgerEntry(backend, GEMINI_REPLAY_STORE, session)).items).toBeUndefined();
  });
});

describe("streams", () => {
  const callChunk = (finishReason?: string) => ({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: { name: "get_weather", args: { city: "Paris" } },
              thoughtSignature: SIG,
            },
          ],
        },
        ...(finishReason === undefined ? {} : { finishReason }),
      },
    ],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
  });

  it("commits the ledger before the terminal event reaches the client", async () => {
    const { gemini, backend } = rig();
    const h = await harness(geminiKey, () => sse([callChunk("STOP")]), undefined, true);

    const started = await Effect.runPromise(
      gemini
        .executeStream(
          h.context,
          { model: MODEL, payload: json({ ...claudeTurn1, stream: true }) },
          claudeOptions(true),
        )
        .pipe(Effect.provide(h.layers)),
    );

    await Effect.runPromise(
      Stream.runForEach(started.chunks, (chunk) =>
        Effect.sync(() => {
          if (chunk.includes("message_stop")) backend.events.push("client:message_stop");
        }),
      ),
    );

    const commit = backend.events.indexOf(`state:${GEMINI_REPLAY_STORE}:put`);

    expect(commit).toBeGreaterThan(-1);
    expect(commit).toBeLessThan(backend.events.indexOf("client:message_stop"));
  });

  it("commits nothing for a stream that ends without a finish reason", async () => {
    const { gemini, backend } = rig();
    const h = await harness(geminiKey, () => sse([callChunk()]), undefined, true);

    const collected = await collectStream(
      gemini,
      h,
      { model: MODEL, payload: json({ ...claudeTurn1, stream: true }) },
      claudeOptions(true),
    );

    expect(collected.error).toBeDefined();
    expect(backend.ops("get", GEMINI_REPLAY_STORE)).toBe(1);
    expect(backend.ops("put", GEMINI_REPLAY_STORE)).toBe(0);
  });
});

describe("requests the ledger does not serve", () => {
  it("makes no ledger call for a Claude model on Vertex", async () => {
    const { vertex, backend } = rig();
    const h = await harness(vertexKey, () => jsonOk(textResponse));

    await execute(
      vertex,
      h,
      { model: "claude-sonnet-4-5", payload: json({ ...claudeTurn1, model: "claude-sonnet-4-5" }) },
      claudeOptions(),
    );

    expect(backend.calls).toHaveLength(0);
  });

  it("makes no ledger call for Imagen", async () => {
    const { vertex, backend } = rig();

    const h = await harness(vertexKey, () =>
      jsonOk({ predictions: [{ bytesBase64Encoded: "QUJD", mimeType: "image/jpeg" }] }),
    );

    await execute(
      vertex,
      h,
      {
        model: "imagen-4.0-generate-001",
        payload: json({ contents: [{ role: "user", parts: [{ text: "a red cat" }] }] }),
      },
      optionsFor("gemini", { "Session-Id": "img-1" }),
    );

    expect(backend.calls).toHaveLength(0);
  });
});

describe("an unreachable ledger", () => {
  it("serves every turn as if there were no replay state", async () => {
    const down = rig(countingBackend(failingBackend()));
    const h = await harness(geminiKey, toolCallThenText);

    const first = await execute(
      down.gemini,
      h,
      { model: MODEL, payload: json(claudeTurn1) },
      claudeOptions(),
    );

    await execute(
      down.gemini,
      h,
      { model: MODEL, payload: json(claudeTurn2(toolUseId(first.payload))) },
      claudeOptions(),
    );

    expect(sentCallSignature(h.calls[1])).toBe(SENTINEL);
  });
});
