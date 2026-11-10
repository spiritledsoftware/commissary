// Pure tests of the Responses WebSocket request normalisation, per-socket planning and tool-call repair.
import { describe, expect, it } from "vitest";
import {
  mergeInput,
  normalizeCreateRequest,
  normalizePassthroughRequest,
  normalizeRequest,
  normalizeSubsequentRequest,
  stripReplayOutputOnlyFields,
  syntheticPrewarmPayloads,
} from "../../src/handlers/responses/websocket/normalize.ts";
import {
  closeForUpstreamError,
  OutputCollector,
  payloadsFromChunk,
  truncateCloseReason,
} from "../../src/handlers/responses/websocket/frames.ts";
import {
  commitPrewarm,
  commitTurn,
  newSocketState,
  Plan,
  planTurn,
} from "../../src/handlers/responses/websocket/plan.ts";
import type { JsonObject } from "@commissary/json";
import { ExecutionError } from "../../src/executor/errors.ts";
import {
  downstreamSessionKey,
  prepareFallbackTurn,
  recordToolCallsFromPayload,
  ToolCacheTurn,
  ToolCaches,
} from "../../src/handlers/responses/websocket/tool-cache.ts";

const user = (text: string) => ({ type: "message", role: "user", content: text });

const assistant = (text: string) => ({ type: "message", role: "assistant", content: text });

const call = (id: string) => ({ type: "function_call", call_id: id, name: "run", arguments: "{}" });

const output = (id: string) => ({ type: "function_call_output", call_id: id, output: "ok" });

const state = (overrides: Partial<Parameters<typeof normalizeSubsequentRequest>[1]> = {}) => ({
  lastRequest: { model: "m", instructions: "sys", input: [user("one")], stream: true },
  lastResponseOutput: [assistant("hi")],
  lastResponseId: "resp_1",
  pendingToolCallIds: [],
  ...overrides,
});

describe("normalizeCreateRequest", () => {
  it("strips type, forces stream, defaults input and requires an array input and a model", () => {
    const ok = normalizeCreateRequest({ type: "response.create", model: " m ", extra: 1 });
    expect(ok).toMatchObject({
      ok: true,
      request: { model: " m ", extra: 1, stream: true, input: [] },
    });
    expect(ok.ok && "type" in ok.request).toBe(false);
    expect(normalizeCreateRequest({ model: "m", input: "text" })).toMatchObject({
      ok: false,
      error: { status: 400, message: "websocket request requires array field: input" },
    });
    expect(normalizeCreateRequest({ input: [] })).toMatchObject({
      ok: false,
      error: { message: "missing model in response.create request" },
    });
  });
});

describe("normalizeRequest (HTTP mode transcript)", () => {
  it("merges previous input, previous output and the new input; inherits model and instructions", () => {
    const result = normalizeRequest(
      { type: "response.append", input: [user("two")] },
      state(),
      false,
      false,
    );

    expect(result).toMatchObject({
      ok: true,
      request: {
        model: "m",
        instructions: "sys",
        stream: true,
        input: [user("one"), assistant("hi"), user("two")],
      },
    });
  });

  it("treats input with assistant output or tool calls as a replacement transcript", () => {
    const result = normalizeRequest(
      {
        type: "response.create",
        input: [user("a"), assistant("b"), user("c")],
        previous_response_id: "",
      },
      state(),
      false,
      false,
    );

    expect(result).toMatchObject({
      ok: true,
      request: { input: [user("a"), assistant("b"), user("c")] },
    });
    expect(result.ok && "previous_response_id" in result.request).toBe(false);
  });

  it("keeps previous_response_id for incremental upstreams and fills it from the last response", () => {
    const result = normalizeSubsequentRequest(
      { type: "response.create", input: [user("two")] },
      state(),
      true,
      false,
    );

    expect(result).toMatchObject({
      ok: true,
      request: { previous_response_id: "resp_1", model: "m", instructions: "sys" },
    });

    // Pending tool calls the new input does not answer force a replacement instead.
    const pending = normalizeSubsequentRequest(
      { type: "response.create", input: [user("two")] },
      state({ pendingToolCallIds: ["call_1"] }),
      true,
      false,
    );

    expect(pending.ok && "previous_response_id" in pending.request).toBe(false);
  });

  it("replaces the transcript when pending tool calls are unanswered, also without incremental upstream input", () => {
    // CLIProxyAPI f4d3f061: the stale turn must not be merged with its unanswered function_call.
    const unanswered = normalizeSubsequentRequest(
      { type: "response.create", input: [user("summary")] },
      state({ lastResponseOutput: [call("call_1")], pendingToolCallIds: ["call_1"] }),
      false,
      false,
    );

    expect(unanswered).toMatchObject({
      ok: true,
      request: { model: "m", instructions: "sys", input: [user("summary")] },
    });
    expect(unanswered.ok && "previous_response_id" in unanswered.request).toBe(false);

    // An answered call keeps the merged transcript.
    const answered = normalizeSubsequentRequest(
      { type: "response.create", input: [output("call_1")] },
      state({ lastResponseOutput: [call("call_1")], pendingToolCallIds: ["call_1"] }),
      false,
      false,
    );

    expect(answered).toMatchObject({
      ok: true,
      request: { input: [user("one"), call("call_1"), output("call_1")] },
    });
  });

  it("skips the stale merge for compaction transcripts when the target supports replay", () => {
    const compacted = { type: "compaction", encrypted_content: "x" };

    const bypass = normalizeSubsequentRequest(
      { type: "response.create", input: [compacted, user("n")] },
      state(),
      false,
      true,
    );

    expect(bypass).toMatchObject({ ok: true, request: { input: [compacted, user("n")] } });

    const merged = normalizeSubsequentRequest(
      { type: "response.create", input: [compacted, user("n")] },
      state(),
      false,
      false,
    );

    expect(merged).toMatchObject({
      ok: true,
      request: { input: [user("one"), assistant("hi"), user("n")] },
    });
  });

  it("rejects frames before a create, non-array inputs and unknown types", () => {
    expect(
      normalizeRequest(
        { type: "response.append", input: [] },
        state({ lastRequest: undefined }),
        false,
        false,
      ),
    ).toMatchObject({
      ok: false,
      error: { message: "websocket request received before response.create" },
    });
    expect(
      normalizeRequest({ type: "response.append", input: "x" }, state(), false, false),
    ).toMatchObject({
      ok: false,
      error: { message: "websocket request requires array field: input" },
    });
    expect(normalizeRequest({ type: "nope" }, state(), false, false)).toMatchObject({
      ok: false,
      error: { message: "unsupported websocket request type: nope" },
    });
  });
});

describe("mergeInput", () => {
  it("drops repeated function calls and keeps the paired item when ids repeat", () => {
    const merged = mergeInput(
      {
        input: [
          { id: "a", ...call("c1") },
          { id: "x", type: "message", role: "user", content: "old" },
        ],
      },
      [call("c1"), output("c1")],
      [{ id: "x", type: "message", role: "user", content: "new" }],
    );

    expect(merged).toEqual({
      ok: true,
      input: [
        { id: "a", ...call("c1") },
        output("c1"),
        { id: "x", type: "message", role: "user", content: "new" },
      ],
    });
  });

  it("reports a malformed previous input", () => {
    expect(mergeInput({ input: "oops" }, [], [])).toEqual({
      ok: false,
      message: "invalid previous request input",
    });
  });
});

describe("normalizePassthroughRequest", () => {
  it("keeps the frame, fills the model and forces stream", () => {
    expect(
      normalizePassthroughRequest(
        { type: "response.append", previous_response_id: "r", input: [] },
        "m",
      ),
    ).toEqual({
      ok: true,
      request: {
        type: "response.append",
        previous_response_id: "r",
        input: [],
        model: "m",
        stream: true,
      },
    });
    expect(normalizePassthroughRequest({ type: "response.create" }, "")).toMatchObject({
      ok: false,
    });
  });
});

describe("planTurn / commitTurn", () => {
  it("plans a first create, then passes continuations through while the pinned credential owns the socket", () => {
    const socket = newSocketState();

    const first = planTurn(socket, {
      type: "response.create",
      model: "gpt-5.4",
      input: [user("one")],
    });

    expect(first._tag).toBe("execute");
    expect(first).toMatchObject({
      nativePassthrough: false,
      pinnedId: "",
      modelName: "gpt-5.4",
    });

    if (!Plan.$is("execute")(first)) throw new Error("unreachable");
    commitTurn(socket, {
      modelName: "gpt-5.4",
      executedRequest: first.request,
      selected: { authId: "a1", provider: "codex", websockets: true },
      completedOutput: [assistant("hi")],
      completedResponseId: "resp_1",
      pendingToolCallIds: [],
    });
    expect(socket.upstreamMode).toBe("websocket");
    expect(socket.lastRequest).toBeUndefined();

    const next = planTurn(socket, {
      type: "response.create",
      previous_response_id: "resp_1",
      input: [user("two")],
    });

    expect(next._tag).toBe("execute");
    expect(next).toMatchObject({
      nativePassthrough: true,
      requiresCurrentUpstream: true,
      pinnedId: "a1",
      modelName: "gpt-5.4",
    });
  });

  it("drops the pin when the model changes and asks for a replay when the continuation needs the lost socket", () => {
    const socket = newSocketState();
    const first = planTurn(socket, { type: "response.create", model: "gpt-5.4", input: [] });

    if (!Plan.$is("execute")(first)) throw new Error("unreachable");
    commitTurn(socket, {
      modelName: "gpt-5.4",
      executedRequest: first.request,
      selected: { authId: "a1", provider: "codex", websockets: true },
      completedOutput: [],
      completedResponseId: "resp_1",
      pendingToolCallIds: [],
    });
    expect(
      planTurn(socket, {
        type: "response.create",
        previous_response_id: "resp_1",
        model: "other",
        input: [],
      }),
    ).toEqual(Plan.replay());
    // A full create is a self-contained reset and may use a new route.
    const reset = planTurn(socket, { type: "response.create", model: "other", input: [user("x")] });
    expect(reset._tag).toBe("execute");
    expect(reset).toMatchObject({ nativePassthrough: false });
  });

  it("answers generate:false locally and merges the follow-up that references the warm-up id", () => {
    const socket = newSocketState();

    const warm = planTurn(socket, {
      type: "response.create",
      model: "m",
      generate: false,
      input: [user("w")],
    });

    expect(warm._tag).toBe("prewarm");
    expect(warm).toMatchObject({ request: { model: "m", input: [user("w")] } });

    if (!Plan.$is("prewarm")(warm)) throw new Error("unreachable");
    expect("generate" in warm.request).toBe(false);
    commitPrewarm(socket, warm, "resp_prewarm_1");

    const mismatch = planTurn(socket, {
      type: "response.create",
      previous_response_id: "other",
      input: [],
    });

    expect(mismatch._tag).toBe("error");
    expect(mismatch).toMatchObject({ error: { status: 409 } });

    const follow = planTurn(socket, {
      type: "response.create",
      previous_response_id: "resp_prewarm_1",
      input: [user("go")],
    });

    expect(follow._tag).toBe("execute");
    expect(follow).toMatchObject({ request: { input: [user("w"), user("go")] } });
  });

  it("keeps a transcript for HTTP-mode credentials and merges the next append", () => {
    const socket = newSocketState();

    const first = planTurn(socket, {
      type: "response.create",
      model: "m",
      instructions: "sys",
      input: [user("one")],
    });

    if (!Plan.$is("execute")(first)) throw new Error("unreachable");
    commitTurn(socket, {
      modelName: "m",
      executedRequest: first.request,
      selected: { authId: "a1", provider: "codex", websockets: false },
      completedOutput: [assistant("hi")],
      completedResponseId: "resp_1",
      pendingToolCallIds: [],
    });
    expect(socket.upstreamMode).toBe("http");
    expect(socket.pinned).toBeUndefined();
    const next = planTurn(socket, { type: "response.append", input: [user("two")] });
    expect(next._tag).toBe("execute");
    expect(next).toMatchObject({
      request: { input: [user("one"), assistant("hi"), user("two")], instructions: "sys" },
    });
  });
});

describe("synthetic warm-up", () => {
  it("builds created (seq 0) and completed (seq 1) events with a prewarm id", () => {
    const [created, completed] = syntheticPrewarmPayloads(
      { model: "m" },
      { id: "u", createdAt: 5 },
    );

    expect(created).toMatchObject({
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_prewarm_u", model: "m", created_at: 5 },
    });
    expect(completed).toMatchObject({
      type: "response.completed",
      sequence_number: 1,
      response: { status: "completed", usage: { total_tokens: 0 } },
    });
  });
});

describe("tool-call repair", () => {
  const key = "scope\u0000session";
  it("re-attaches cached outputs and calls, drops unpaired items and records through a transactional turn", () => {
    const caches = new ToolCaches();
    // Turn 1 records a call and its output.
    const first = prepareFallbackTurn(caches, key, { input: [call("c1"), output("c1")] });
    first.turn?.commit();

    // Turn 2 replays the call without its output, and an output without its call, plus orphans.
    const second = prepareFallbackTurn(caches, key, {
      input: [user("x"), call("c1"), output("c1"), output("c9"), call("c8")],
    });

    expect(second.request["input"]).toEqual([user("x"), call("c1"), output("c1")]);
    const third = prepareFallbackTurn(caches, key, { input: [call("c1")] });
    expect(third.request["input"]).toEqual([call("c1"), output("c1")]);
    const fourth = prepareFallbackTurn(caches, key, { input: [output("c1")] });
    expect(fourth.request["input"]).toEqual([call("c1"), output("c1")]);
  });

  it("keeps orphans when the request continues a response and is inert without a session key", () => {
    const caches = new ToolCaches();

    const continued = prepareFallbackTurn(caches, key, {
      previous_response_id: "r",
      input: [output("c1")],
    });

    expect(continued.request["input"]).toEqual([output("c1")]);
    const keyless = prepareFallbackTurn(caches, "", { input: [output("c1")] });
    expect(keyless.request["input"]).toEqual([output("c1")]);
    expect(keyless.turn).toBeUndefined();
  });

  it("releases the caches with the last socket of a session and isolates callers by scope", () => {
    const caches = new ToolCaches();
    caches.retain(key);
    caches.retain(key);
    prepareFallbackTurn(caches, key, { input: [call("c1"), output("c1")] }).turn?.commit();
    caches.release(key);
    expect(prepareFallbackTurn(caches, key, { input: [call("c1")] }).request["input"]).toEqual([
      call("c1"),
      output("c1"),
    ]);
    caches.release(key);
    expect(prepareFallbackTurn(caches, key, { input: [call("c1")] }).request["input"]).toEqual([]);
    const headers = new Headers({ "x-client-request-id": "abc" });
    expect(downstreamSessionKey(headers, "A")).not.toBe(downstreamSessionKey(headers, "B"));
    expect(downstreamSessionKey(new Headers(), "A")).toBe("");
    expect(
      downstreamSessionKey(
        new Headers({ "x-codex-turn-metadata": JSON.stringify({ session_id: "s1" }) }),
        "A",
      ),
    ).toBe("A\u0000s1");
  });
});

describe("replay strip (CLIProxyAPI 9037d543)", () => {
  const PASSTHROUGH = "internal_chat_message_metadata_passthrough";
  const key = "scope\u0000strip";

  const upstreamCall = (passthrough: JsonObject) => ({
    ...call("c1"),
    id: "fc-1",
    [PASSTHROUGH]: passthrough,
  });

  it("removes content_token_count, keeps other passthrough keys and drops an emptied object", () => {
    const message = {
      ...assistant("hi"),
      [PASSTHROUGH]: { turn_id: "t1", create_time: 1.5, content_token_count: 64 },
    };

    const stripped = stripReplayOutputOnlyFields(message);
    expect(stripped).toEqual({
      ...assistant("hi"),
      [PASSTHROUGH]: { turn_id: "t1", create_time: 1.5 },
    });
    // Pure: the input is not mutated and key order is kept.
    expect(message[PASSTHROUGH]).toHaveProperty("content_token_count", 64);
    expect(Object.keys(stripped)).toEqual(Object.keys(message));

    expect(
      stripReplayOutputOnlyFields({
        ...assistant("hi"),
        [PASSTHROUGH]: { content_token_count: 3 },
      }),
    ).toEqual(assistant("hi"));
  });

  it("leaves items without the field, a null passthrough and other items untouched", () => {
    const plain = { ...assistant("hi"), [PASSTHROUGH]: { turn_id: "t" } };
    expect(stripReplayOutputOnlyFields(plain)).toBe(plain);
    const none = { ...assistant("hi"), [PASSTHROUGH]: null };
    expect(stripReplayOutputOnlyFields(none)).toBe(none);
    const bare = assistant("hi");
    expect(stripReplayOutputOnlyFields(bare)).toBe(bare);
  });

  it("strips upstream tool calls at record time (transactional and plain) but not client items", () => {
    const caches = new ToolCaches();
    const turn = new ToolCacheTurn(key, caches);
    turn.recordResponse({
      type: "response.output_item.done",
      item: upstreamCall({ turn_id: "tx", content_token_count: 9 }),
    });
    turn.commit();

    const repaired = prepareFallbackTurn(caches, key, { input: [output("c1")] }).request["input"];
    expect(repaired).toEqual([upstreamCall({ turn_id: "tx" }), output("c1")]);

    const plain = new ToolCaches();
    recordToolCallsFromPayload(plain, key, {
      type: "response.completed",
      response: { output: [upstreamCall({ content_token_count: 2 })] },
    });

    expect(prepareFallbackTurn(plain, key, { input: [output("c1")] }).request["input"]).toEqual([
      { ...call("c1"), id: "fc-1" },
      output("c1"),
    ]);

    // A client's own call round-trips through the cache unchanged.
    const client = new ToolCaches();
    const clientCall = upstreamCall({ content_token_count: 42, turn_id: "client" });
    prepareFallbackTurn(client, key, { input: [clientCall, output("c1")] }).turn?.commit();

    expect(prepareFallbackTurn(client, key, { input: [output("c1")] }).request["input"]).toEqual([
      clientCall,
      output("c1"),
    ]);
  });
});

describe("frames", () => {
  it("extracts JSON payloads from SSE chunks and bare JSON", () => {
    expect(payloadsFromChunk('event: a\ndata: {"type":"a"}\n\ndata: [DONE]\n')).toEqual([
      { type: "a" },
    ]);
    expect(payloadsFromChunk('{"type":"b"}')).toEqual([{ type: "b" }]);
    expect(payloadsFromChunk("data: nope")).toEqual([]);
  });

  it("rebuilds an empty completed output from the collected items and pending tool calls", () => {
    const collector = new OutputCollector();
    collector.collect({ type: "response.output_item.done", output_index: 1, item: call("c2") });
    collector.collect({
      type: "response.output_item.done",
      output_index: 0,
      item: assistant("hi"),
    });
    collector.recordPending({ type: "response.output_item.done", item: call("c2") });
    const completed = { type: "response.completed", response: { id: "r", output: [] } };
    collector.restoreCompletionOutput(completed);
    expect(completed.response.output).toEqual([assistant("hi"), call("c2")]);
    expect(collector.pending()).toEqual(["c2"]);
  });

  it("mirrors upstream message-too-big and replay close codes and truncates reasons by bytes", () => {
    expect(
      closeForUpstreamError(
        new ExecutionError({
          status: 413,
          message:
            '{"error":{"message":"upstream websocket message too big","code":"message_too_big"}}',
        }),
      ),
    ).toEqual({ code: 1009, reason: "upstream websocket message too big" });
    expect(
      closeForUpstreamError(
        new ExecutionError({
          status: 426,
          code: "upstream_websocket_replay_required",
          message: "x",
        }),
      ),
    ).toEqual({ code: 1012, reason: "upstream requires HTTP replay" });
    expect(
      closeForUpstreamError(new ExecutionError({ status: 500, message: "x" })),
    ).toBeUndefined();
    expect(
      new TextEncoder().encode(truncateCloseReason("é".repeat(100))).length,
    ).toBeLessThanOrEqual(123);
  });
});
