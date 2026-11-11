// The web search result cache through the Claude executor (Go: internal/runtime/executor/
// claude_executor_web_search_results_test.go, helps/claude_web_search_results_test.go; upstream 9d453bc0, cddc9bb8,
// 9acf81d3): a Responses client replays its history without the `web_search_tool_result` content, and the executor
// restores what the session's earlier response delivered, per upstream credential.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { asString, get, type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { makeClaudeExecutor } from "../src/executor/claude/executor.ts";
import {
  makeMemoryWebSearchResultStore,
  type WebSearchResultStore,
} from "../src/executor/claude/web-search-results.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import { collectStream, credential, execute, harness, options } from "./support/executor-run.ts";

const RESULTS: Json = [
  {
    type: "web_search_result",
    url: "https://example.com/a",
    title: "A",
    encrypted_content: "ENC_A",
    page_age: null,
  },
];

const sse = (events: JsonObject[]): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

/** A turn whose search the server ran: `server_tool_use`, its result and a cited answer. */
const searchTurn = (): Response =>
  sse([
    {
      type: "message_start",
      message: {
        id: "msg_ws",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"query":"q"}' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: RESULTS,
      },
    },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Cited." } },
    { type: "content_block_stop", index: 2 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);

const userText = (text: string): JsonObject => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

const firstTurn: JsonObject = {
  model: "claude-opus-5-5",
  stream: true,
  tools: [{ type: "web_search" }],
  input: [userText("search")],
};

/** The next request a client builds: the search and the cited answer, without the results. */
const replay: JsonObject = {
  model: "claude-opus-5-5",
  stream: true,
  tools: [{ type: "web_search" }],
  input: [
    userText("search"),
    {
      type: "web_search_call",
      id: "ws_srvtoolu_1",
      status: "completed",
      action: { type: "search", query: "q" },
    },
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Cited.",
          annotations: [
            {
              type: "web_search_result_location",
              url: "https://example.com/a",
              title: "A",
              cited_text: "Cited.",
              encrypted_index: "IDX_A",
            },
          ],
        },
      ],
    },
    userText("follow up"),
  ],
};

const cred = (id: string): CredentialSnapshot =>
  credential("claude", { id, kind: "apikey", attributes: { api_key: `sk-ant-api03-${id}` } });

const responsesOptions = (session: string | undefined, stream: boolean) =>
  options({
    stream,
    sourceFormat: "openai-response",
    metadata: {
      requestPath: "/v1/responses",
      requestedModel: "claude-opus-5-5",
      serviceTier: "auto",
      generate: true,
      callerScope: "scope",
      ...(session === undefined ? {} : { sessionId: session }),
    },
  });

/** The cache is opt-in (ADR 0027). */
const ENABLED = "client:\n  codex:\n    web-search-result-cache:\n      enabled: true\n";

/** A memory store that counts its calls and remembers whether each read slid the expiry. */
const spyStore = () => {
  const memory = makeMemoryWebSearchResultStore();
  const spy = { calls: 0, slides: [] as Array<boolean | undefined> };

  const store: WebSearchResultStore = {
    load: (scope, ids, slide) => {
      spy.calls++;
      spy.slides.push(slide);

      return memory.load(scope, ids, slide);
    },
    save: (scope, results) => {
      spy.calls++;

      return memory.save(scope, results);
    },
  };

  return { store, spy };
};

/** The search result and citations of the assistant turn in an upstream request body. */
const sentOf = (text: string): Sent => {
  const messages = get(tryParseJson(text), "messages");

  const blocks = (Array.isArray(messages) ? messages : []).flatMap((message) => {
    const content = get(message, "content");

    return get(message, "role") === "assistant" && Array.isArray(content) ? content : [];
  });

  return {
    content: get(
      blocks.find((block) => get(block, "type") === "web_search_tool_result"),
      "content",
    ),
    citations: get(
      blocks.find((block) => get(block, "type") === "text"),
      "citations",
    ),
  };
};

interface Sent {
  readonly content: Json | undefined;
  readonly citations: Json | undefined;
}

/** Runs the turns in order, each with its own credential and session; returns what the last one sent upstream. */
const runTurns = async (
  stream: boolean,
  turns: ReadonlyArray<{ cred: CredentialSnapshot; session?: string; payload: JsonObject }>,
  { enabled = true, store = makeMemoryWebSearchResultStore() } = {},
): Promise<Sent> => {
  const executor = makeClaudeExecutor({ webSearchResults: store });
  const yaml = enabled ? ENABLED : undefined;
  let sent: Sent = { content: undefined, citations: undefined };

  for (const turn of turns) {
    const h = await harness(turn.cred, searchTurn, yaml, true);
    const request = { model: "claude-opus-5-5", payload: turn.payload };
    const opts = responsesOptions(turn.session, stream);

    if (stream) await collectStream(executor, h, request, opts);
    else await execute(executor, h, request, opts);

    sent = sentOf(h.calls[0]?.text ?? "");
  }

  return sent;
};

describe.each([
  ["execute", false],
  ["executeStream", true],
])("web search results through %s", (_name, stream) => {
  it("restores the results of an earlier turn of the session and keeps the citations", async () => {
    const sent = await runTurns(stream, [
      { cred: cred("a"), session: "s1", payload: firstTurn },
      { cred: cred("a"), session: "s1", payload: replay },
    ]);

    expect(sent.content).toEqual(RESULTS);
    expect(asString(get(sent.citations, "0.encrypted_index"))).toBe("IDX_A");
  });

  it("sends an empty result and drops the citations for another credential of the session", async () => {
    const sent = await runTurns(stream, [
      { cred: cred("a"), session: "s1", payload: firstTurn },
      { cred: cred("b"), session: "s1", payload: replay },
    ]);

    expect(sent.content).toEqual([]);
    expect(sent.citations).toBeUndefined();
  });

  it("does not restore across sessions", async () => {
    const sent = await runTurns(stream, [
      { cred: cred("a"), session: "s1", payload: firstTurn },
      { cred: cred("a"), session: "s2", payload: replay },
    ]);

    expect(sent.content).toEqual([]);
    expect(sent.citations).toBeUndefined();
  });

  it("caches nothing for a request without a caller session", async () => {
    const sent = await runTurns(stream, [
      { cred: cred("a"), payload: firstTurn },
      { cred: cred("a"), payload: replay },
    ]);

    expect(sent.content).toEqual([]);
    expect(sent.citations).toBeUndefined();
  });
});

describe("the cache is off by default (ADR 0027)", () => {
  const turns = [
    { cred: cred("a"), session: "s1", payload: firstTurn },
    { cred: cred("a"), session: "s1", payload: replay },
  ];

  it("never touches the store and restores nothing", async () => {
    const { store, spy } = spyStore();
    const sent = await runTurns(true, turns, { enabled: false, store });

    expect(spy.calls).toBe(0);
    expect(sent.content).toEqual([]);
    expect(sent.citations).toBeUndefined();
  });

  it("uses the store once enabled", async () => {
    const { store, spy } = spyStore();
    const sent = await runTurns(true, turns, { store });

    expect(spy.calls).toBeGreaterThan(0);
    expect(sent.content).toEqual(RESULTS);
  });
});

describe("count_tokens (9d453bc0)", () => {
  /** Turn 1 through the executor records; the count_tokens call replays the history. */
  const count = async (countCred: CredentialSnapshot) => {
    const { store, spy } = spyStore();
    const executor = makeClaudeExecutor({ webSearchResults: store });
    const first = await harness(cred("a"), searchTurn, ENABLED, true);

    await execute(
      executor,
      first,
      { model: "claude-opus-5-5", payload: firstTurn },
      responsesOptions("s1", false),
    );

    const h = await harness(countCred, () => Response.json({ input_tokens: 7 }), ENABLED);

    await Effect.runPromise(
      executor
        .countTokens(
          h.context,
          { model: "claude-opus-5-5", payload: replay },
          responsesOptions("s1", false),
        )
        .pipe(Effect.provide(h.layers)),
    );

    return { sent: sentOf(h.calls[0]?.text ?? ""), spy };
  };

  it("restores the results of the session and keeps the citations", async () => {
    const { sent } = await count(cred("a"));

    expect(sent.content).toEqual(RESULTS);
    expect(asString(get(sent.citations, "0.encrypted_index"))).toBe("IDX_A");
  });

  it("restores nothing for another credential", async () => {
    const { sent } = await count(cred("b"));

    expect(sent.content).toEqual([]);
    expect(sent.citations).toBeUndefined();
  });

  it("reads without sliding the expiry", async () => {
    const { spy } = await count(cred("a"));

    expect(spy.slides.at(-1)).toBe(false);
  });
});
