// Antigravity reasoning replay (ledger, accumulator, request restore, repairs) and Interactions continuation sessions
// over in-memory SessionState backends with injected clocks.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  interactionsCallKey,
  makeInMemoryContinuationStore,
  prepareAntigravityInteractions,
} from "../src/executor/gemini/antigravity-interactions.ts";
import {
  ReplayAccumulator,
  type ReplayScope,
} from "../src/executor/antigravity/replay/accumulator.ts";
import {
  makeInMemoryReplayLedger,
  normalizeReplayItems,
  REPLAY_MAX_ITEMS_PER_ENTRY,
  UNLOADED_SNAPSHOT,
} from "../src/executor/antigravity/replay/ledger.ts";
import {
  clearReplayOnInvalidSignature,
  prepareReplayPayload,
} from "../src/executor/antigravity/replay/prepare.ts";
import {
  degradeToolProvenanceIds,
  repairUnsignedFirstFunctionCalls,
  syntheticToolCallId,
  validateFunctionCallPairing,
} from "../src/executor/antigravity/replay/provenance.ts";
import { replaySessionKey } from "../src/executor/antigravity/replay/scope.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import type { ExecutorRequest } from "../src/executor/types.ts";
import type { Json, JsonObject } from "@commissary/json";
import { geminiClaudeToolUseID } from "@commissary/translation";
import { options } from "./support/executor-run.ts";

const MODEL = "gemini-3-flash";

const SIG = "CiQBsignature0000000001";

const SIG2 = "CiQBsignature0000000002";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const clone = <T>(value: T): T => structuredClone(value);

const user = (text: string) => ({ role: "user", parts: [{ text }] });

const modelCall = (name: string, args: Json, extra: JsonObject = {}, signature?: string) => ({
  role: "model",
  parts: [
    {
      functionCall: { name, args, ...extra },
      ...(signature === undefined ? {} : { thoughtSignature: signature }),
    },
  ],
});

const toolResult = (name: string, id?: string) => ({
  role: "user",
  parts: [
    { functionResponse: { name, response: { ok: true }, ...(id === undefined ? {} : { id }) } },
  ],
});

const antigravityRequest = (contents: unknown[]): Json =>
  ({
    model: MODEL,
    request: { contents, systemInstruction: { parts: [{ text: "sys" }] } },
  }) as unknown as Json;

const upstream = (parts: Json[], finishReason = "STOP"): Json => ({
  response: { candidates: [{ content: { role: "model", parts }, finishReason }] },
});

const scopeOf = (sessionKey: string, snapshot = UNLOADED_SNAPSHOT): ReplayScope => ({
  modelName: MODEL,
  sessionKey,
  snapshot,
});

const contentsOf = (payload: Json) =>
  (
    payload as unknown as {
      request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
    }
  ).request.contents;

const execRequest = (payload: Json): ExecutorRequest => ({ model: MODEL, payload });

const execOptions = (headers: Record<string, string> = {}) =>
  options({ headers: new Headers(headers), sourceFormat: "openai" });

describe("replay ledger over SessionState", () => {
  it("normalises items like Go and rejects oversized chains", () => {
    expect(
      normalizeReplayItems([
        {
          type: "thought_signature",
          thoughtSignature: SIG,
          contentIndex: 1,
          partIndex: 0,
          targetKind: "weird",
          extra: 1,
        },
        { type: "thought_signature", thoughtSignature: "short" },
        { type: "thought_signature", thoughtSignature: "skip_thought_signature_validator" },
        {
          type: "function_call_part",
          functionCall: { id: "c1", name: "read", args: { a: 1 } },
          thoughtSignature: "skip_thought_signature_validator",
        },
        { type: "function_call_part", name: "no-args" },
        { type: "unknown" },
      ]),
    ).toEqual([
      { type: "thought_signature", thoughtSignature: SIG, contentIndex: 1, partIndex: 0 },
      { type: "function_call_part", call_id: "c1", name: "read", args: { a: 1 } },
    ]);
    expect(normalizeReplayItems([])).toBeUndefined();

    const many = Array.from({ length: REPLAY_MAX_ITEMS_PER_ENTRY + 1 }, () => ({
      type: "thought_signature",
      thoughtSignature: SIG,
    }));

    expect(normalizeReplayItems(many)).toBeUndefined();
  });

  it("publishes only when nobody changed the state since the read (compare-and-swap)", async () => {
    let now = 1_000_000;
    const ledger = makeInMemoryReplayLedger(() => now);
    const item = { type: "thought_signature", thoughtSignature: SIG };
    const a = await run(ledger.get(MODEL, "s"));
    const b = await run(ledger.get(MODEL, "s"));
    expect(a.items).toBeUndefined();
    expect(a.snapshot.loaded).toBe(true);
    expect(await run(ledger.replaceIfUnchanged(MODEL, "s", a.snapshot, [item]))).toBe(true);
    // `b` read the empty ledger too and loses.
    expect(
      await run(
        ledger.replaceIfUnchanged(MODEL, "s", b.snapshot, [{ ...item, thoughtSignature: SIG2 }]),
      ),
    ).toBe(false);
    const c = await run(ledger.get(MODEL, "s"));
    expect(c.items).toEqual([item]);
    // A delete leaves a tombstone, so a writer that read the older state cannot publish over it.
    expect(await run(ledger.deleteIfUnchanged(MODEL, "s", c.snapshot))).toBe(true);
    expect(await run(ledger.replaceIfUnchanged(MODEL, "s", c.snapshot, [item]))).toBe(false);
    const afterDelete = await run(ledger.get(MODEL, "s"));
    expect(afterDelete.items).toBeUndefined();
    expect(afterDelete.snapshot.generation).toBeGreaterThan(0);
    expect(await run(ledger.replaceIfUnchanged(MODEL, "s", a.snapshot, [item]))).toBe(false);
    // An unread snapshot writes unconditionally; invalid items never do.
    expect(await run(ledger.replaceIfUnchanged(MODEL, "s", UNLOADED_SNAPSHOT, [item]))).toBe(true);
    expect(
      await run(ledger.replaceIfUnchanged(MODEL, "s", UNLOADED_SNAPSHOT, [{ type: "x" }])),
    ).toBe(false);
    // Entries expire an hour after the last access (a read slides the TTL).
    now += 59 * 60_000;
    expect((await run(ledger.get(MODEL, "s"))).items).toEqual([item]);
    now += 59 * 60_000;
    expect((await run(ledger.get(MODEL, "s"))).items).toEqual([item]);
    now += 61 * 60_000;
    expect((await run(ledger.get(MODEL, "s"))).items).toBeUndefined();
  });
});

describe("accumulator -> ledger -> request restore", () => {
  it("restores the signature of a function call the client echoed without it", async () => {
    const ledger = makeInMemoryReplayLedger(() => 5_000_000);
    const first = antigravityRequest([user("read a")]);
    const read = await run(ledger.get(MODEL, "sess"));
    const accumulator = new ReplayAccumulator(scopeOf("sess", read.snapshot), first);
    accumulator.observePayload(
      upstream([{ functionCall: { name: "read", args: { p: "a" } }, thoughtSignature: SIG }]),
    );
    expect(accumulator.terminal).toBe(true);
    await run(accumulator.commit(ledger));

    // The client replays the call under its own id and without the signature.
    const second = antigravityRequest([
      user("read a"),
      modelCall("read", { p: "a" }, { id: "read-1" }),
      toolResult("read", "read-1"),
    ]);

    const prepared = await run(
      prepareReplayPayload(
        ledger,
        MODEL,
        execRequest(second),
        execOptions({ "Session-Id": "sess" }),
        second,
      ),
    );

    // The explicit client session decides the key, so use the same key for the lookup.
    expect(contentsOf(prepared.payload)[1]?.parts[0]?.["thoughtSignature"]).toBeDefined();
  });

  it("matches by the session key of the request and records the ledger under it", async () => {
    const ledger = makeInMemoryReplayLedger(() => 5_000_000);
    const headers = { "Session-Id": "client-1" };

    const key = replaySessionKey(
      {
        modelName: MODEL,
        originalRequest: undefined,
        requestPayload: {},
        headers: new Headers(headers),
        derivedSessionId: "",
        callerScope: "scope",
      },
      {},
    );

    expect(key).toMatch(/^caller:[0-9a-f]{16}:responses:client-1$/);

    const first = antigravityRequest([user("read a")]);

    const prepared1 = await run(
      prepareReplayPayload(ledger, MODEL, execRequest(first), execOptions(headers), first),
    );

    expect(prepared1.scope.sessionKey).toBe(key);
    const accumulator = new ReplayAccumulator(prepared1.scope, first);
    accumulator.observePayload(
      upstream([{ functionCall: { name: "read", args: { p: "a" } }, thoughtSignature: SIG }]),
    );
    await run(accumulator.commit(ledger));

    const second = antigravityRequest([
      user("read a"),
      modelCall("read", { p: "a" }, { id: "read-1" }),
      toolResult("read", "read-1"),
    ]);

    const prepared2 = await run(
      prepareReplayPayload(ledger, MODEL, execRequest(second), execOptions(headers), second),
    );

    expect(contentsOf(prepared2.payload)[1]?.parts[0]).toMatchObject({ thoughtSignature: SIG });
    // The input is never mutated.
    expect(contentsOf(second)[1]?.parts[0]?.["thoughtSignature"]).toBeUndefined();

    // Another caller does not see the ledger.
    const otherCaller = await run(
      prepareReplayPayload(
        ledger,
        MODEL,
        execRequest(second),
        options({
          headers: new Headers(headers),
          metadata: { ...options().metadata, callerScope: "other" },
        }),
        second,
      ),
    );

    expect(contentsOf(otherCaller.payload)[1]?.parts[0]?.["thoughtSignature"]).toBe(
      "skip_thought_signature_validator",
    );
  });

  it("restores text signatures onto the matching text part", async () => {
    const ledger = makeInMemoryReplayLedger(() => 5_000_000);
    const headers = { "Session-Id": "text-1" };
    const first = antigravityRequest([user("hi")]);

    const prepared1 = await run(
      prepareReplayPayload(ledger, MODEL, execRequest(first), execOptions(headers), first),
    );

    const accumulator = new ReplayAccumulator(prepared1.scope, first);
    accumulator.observePayload(upstream([{ text: "Hello " }]));
    accumulator.observePayload(upstream([{ text: "there", thoughtSignature: SIG }]));
    await run(accumulator.commit(ledger));
    const stored = await run(ledger.get(MODEL, prepared1.scope.sessionKey));
    expect(stored.items).toMatchObject([
      { type: "thought_signature", thoughtSignature: SIG, targetKind: "text" },
    ]);

    const second = antigravityRequest([
      user("hi"),
      { role: "model", parts: [{ text: "Hello there" }] },
      user("next"),
    ]);

    const prepared2 = await run(
      prepareReplayPayload(ledger, MODEL, execRequest(second), execOptions(headers), second),
    );

    expect(contentsOf(prepared2.payload)[1]?.parts[0]).toEqual({
      text: "Hello there",
      thoughtSignature: SIG,
    });
  });

  it("does not publish a stream without a finish reason and clears oversized or empty chains", async () => {
    const ledger = makeInMemoryReplayLedger(() => 5_000_000);
    const seed = [{ type: "thought_signature", thoughtSignature: SIG2 }];
    const request = antigravityRequest([user("go")]);
    const read = async () => (await run(ledger.get(MODEL, "s"))).snapshot;
    await run(ledger.replaceIfUnchanged(MODEL, "s", UNLOADED_SNAPSHOT, seed));

    const truncated = new ReplayAccumulator(scopeOf("s", await read()), request);
    truncated.observePayload({
      response: {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: "f", args: {} }, thoughtSignature: SIG }] },
          },
        ],
      },
    });
    await run(truncated.commit(ledger));
    expect((await run(ledger.get(MODEL, "s"))).items).toEqual(seed);

    // A completed turn without anything replayable clears the previous chain.
    const empty = new ReplayAccumulator(scopeOf("s", await read()), request);
    empty.observePayload(upstream([{ text: "plain" }]));
    await run(empty.commit(ledger));
    expect((await run(ledger.get(MODEL, "s"))).items).toBeUndefined();
  });

  it("attaches a detached signature part to the preceding function call and dedupes repeated calls", async () => {
    const ledger = makeInMemoryReplayLedger(() => 5_000_000);
    const request = antigravityRequest([user("go")]);
    const accumulator = new ReplayAccumulator(scopeOf("s"), request);
    accumulator.observeLine(
      `data: ${JSON.stringify(upstream([{ functionCall: { name: "f", args: { a: 1 } } }], ""))}`,
    );
    accumulator.observeLine(`data: ${JSON.stringify(upstream([{ thoughtSignature: SIG }], ""))}`);
    accumulator.observeLine(
      `data: ${JSON.stringify(upstream([{ functionCall: { name: "f", args: { a: 1 } } }]))}`,
    );
    expect(accumulator.terminal).toBe(true);
    await run(accumulator.commit(ledger));
    const stored = await run(ledger.get(MODEL, "s"));
    expect(stored.items).toMatchObject([
      {
        type: "function_call_part",
        name: "f",
        args: { a: 1 },
        thoughtSignature: SIG,
        contentIndex: 1,
      },
      { type: "function_call_part", name: "f", args: { a: 1 }, targetOccurrence: 1 },
    ]);
  });

  it("restores the native call id for an opaque Claude-facing id and keeps responses paired", async () => {
    const ledger = makeInMemoryReplayLedger(() => 5_000_000);
    const headers = { "Session-Id": "claude-1" };
    const first = antigravityRequest([user("read")]);

    const prepared1 = await run(
      prepareReplayPayload(ledger, MODEL, execRequest(first), execOptions(headers), first),
    );

    const accumulator = new ReplayAccumulator(prepared1.scope, first);
    accumulator.observePayload(
      upstream([
        { functionCall: { id: "native-1", name: "read", args: { p: "a" } }, thoughtSignature: SIG },
      ]),
    );
    await run(accumulator.commit(ledger));

    const opaque = geminiClaudeToolUseID("native-1", "read", JSON.stringify({ p: "a" }));

    const second = antigravityRequest([
      user("read"),
      modelCall("read", { p: "a" }, { id: opaque }),
      toolResult("read", opaque),
    ]);

    const prepared2 = await run(
      prepareReplayPayload(ledger, MODEL, execRequest(second), execOptions(headers), second),
    );

    const contents = contentsOf(prepared2.payload);
    expect(contents[1]?.parts[0]).toMatchObject({
      functionCall: { id: "native-1", name: "read" },
      thoughtSignature: SIG,
    });
    expect(contents[2]?.parts[0]?.["functionResponse"]).toMatchObject({
      id: "native-1",
      name: "read",
    });
  });

  it("inserts a missing model call before its response and degrades unresolved opaque ids", async () => {
    const ledger = makeInMemoryReplayLedger(() => 5_000_000);
    const headers = { "Session-Id": "claude-2" };
    const first = antigravityRequest([user("read")]);

    const prepared1 = await run(
      prepareReplayPayload(ledger, MODEL, execRequest(first), execOptions(headers), first),
    );

    const accumulator = new ReplayAccumulator(prepared1.scope, first);
    accumulator.observePayload(
      upstream([
        { functionCall: { id: "native-2", name: "read", args: { p: "b" } }, thoughtSignature: SIG },
      ]),
    );
    await run(accumulator.commit(ledger));

    // The client dropped the model turn entirely and only sends the (opaque id) response.
    const opaque = geminiClaudeToolUseID("native-2", "read", JSON.stringify({ p: "b" }));
    const dropped = antigravityRequest([user("read"), toolResult("read", "native-2")]);

    const inserted = await run(
      prepareReplayPayload(ledger, MODEL, execRequest(dropped), execOptions(headers), dropped),
    );

    expect(contentsOf(inserted.payload).map((content) => content.role)).toEqual([
      "user",
      "model",
      "model",
    ]);
    expect(contentsOf(inserted.payload)[1]?.parts[0]).toMatchObject({
      functionCall: { id: "native-2", name: "read" },
      thoughtSignature: SIG,
    });

    // Without a ledger entry the reserved ids are rewritten to synthetic ones and the call is signed with the bypass.
    const lost = antigravityRequest([
      user("read"),
      modelCall("read", { p: "z" }, { id: opaque }, "CiQBstale0000000000000"),
      toolResult("read", opaque),
    ]);

    const degraded = await run(
      prepareReplayPayload(
        ledger,
        MODEL,
        execRequest(lost),
        execOptions({ "Session-Id": "unknown" }),
        lost,
      ),
    );

    const parts = contentsOf(degraded.payload);
    const synthetic = syntheticToolCallId(opaque);
    expect(parts[1]?.parts[0]).toMatchObject({
      functionCall: { id: synthetic },
      thoughtSignature: "skip_thought_signature_validator",
    });
    expect(parts[2]?.parts[0]?.["functionResponse"]).toMatchObject({ id: synthetic });
    expect(synthetic).toMatch(/^call_[0-9a-f]{12}$/);
  });

  it("rejects a Gemini history whose calls and responses do not pair, and drops a replay that broke the pairing", async () => {
    const ledger = makeInMemoryReplayLedger(() => 5_000_000);
    const broken = antigravityRequest([user("go"), toolResult("read", "x")]);
    await expect(
      run(
        prepareReplayPayload(
          ledger,
          MODEL,
          execRequest(broken),
          execOptions({ "Session-Id": "p" }),
          broken,
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(
      validateFunctionCallPairing(
        antigravityRequest([user("a"), modelCall("f", {}, { id: "1" }), toolResult("f", "1")]),
      ),
    ).toBeUndefined();
    expect(
      validateFunctionCallPairing(
        antigravityRequest([modelCall("f", {}, { id: "1" }), toolResult("f", "2")]),
      ),
    ).toMatch(/does not match functionCall\.id/);
    expect(
      validateFunctionCallPairing(antigravityRequest([modelCall("f", {}), modelCall("g", {})])),
    ).toMatch(/pending functionResponse/);
  });

  it("only touches Gemini-family models and clears the entry after an upstream signature error", async () => {
    const ledger = makeInMemoryReplayLedger(() => 5_000_000);
    const claude = antigravityRequest([user("x")]);

    const result = await run(
      prepareReplayPayload(ledger, "claude-sonnet-4-5", execRequest(claude), execOptions(), claude),
    );

    expect(result.payload).toBe(claude);
    expect(result.scope.sessionKey).toBe("");

    const scope = scopeOf("s", (await run(ledger.get(MODEL, "s"))).snapshot);
    await run(
      ledger.replaceIfUnchanged(MODEL, "s", UNLOADED_SNAPSHOT, [
        { type: "thought_signature", thoughtSignature: SIG },
      ]),
    );
    await run(clearReplayOnInvalidSignature(ledger, scope, 500, "bad thoughtSignature"));
    expect((await run(ledger.get(MODEL, "s"))).items).toBeDefined();
    await run(
      clearReplayOnInvalidSignature(
        ledger,
        { ...scope, snapshot: (await run(ledger.get(MODEL, "s"))).snapshot },
        400,
        "Invalid Thought Signature",
      ),
    );
    expect((await run(ledger.get(MODEL, "s"))).items).toBeUndefined();
  });
});

describe("OpenAI chat replay continuity (Go da21f1e5, 80aa2b1d)", () => {
  const call = { name: "get_time", args: { tz: "UTC" } };

  const secondTurn = (extra: JsonObject = {}): Json =>
    ({
      model: MODEL,
      request: {
        contents: [
          user("time?"),
          modelCall("get_time", { tz: "UTC" }, { id: "call_1" }),
          toolResult("get_time", "call_1"),
        ],
        systemInstruction: { parts: [{ text: "sys" }] },
        ...extra,
      },
    }) as unknown as Json;

  it("keys the ledger by an explicit session alias header before the derived id", () => {
    const key = (headers: Record<string, string>) =>
      replaySessionKey(
        {
          modelName: MODEL,
          originalRequest: undefined,
          requestPayload: {},
          headers: new Headers(headers),
          derivedSessionId: "derived-1",
          callerScope: "",
        },
        {},
      );

    expect(key({ "X-Session-Affinity": "alias-1" })).toBe("client:affinity:alias-1");
    expect(key({})).toBe("derived:derived-1");
  });

  it("treats a non-stream candidate payload without finishReason or `response` wrapper as complete", async () => {
    const ledger = makeInMemoryReplayLedger(() => 5_000_000);
    const accumulator = new ReplayAccumulator(scopeOf("s"), antigravityRequest([user("time?")]));
    accumulator.observeCompleted({
      candidates: [
        { content: { role: "model", parts: [{ functionCall: call, thoughtSignature: SIG }] } },
      ],
    });

    expect(accumulator.terminal).toBe(true);
    await run(accumulator.commit(ledger));
    expect((await run(ledger.get(MODEL, "s"))).items).toMatchObject([
      { type: "function_call_part", name: "get_time", thoughtSignature: SIG },
    ]);
  });

  it("binds the thought signature of the turn to an unsigned function call", async () => {
    const ledger = makeInMemoryReplayLedger(() => 5_000_000);
    const accumulator = new ReplayAccumulator(scopeOf("s"), antigravityRequest([user("time?")]));
    accumulator.observePayload(
      upstream([
        { thought: true, text: "Check the time.", thoughtSignature: SIG },
        { functionCall: call },
      ]),
    );
    await run(accumulator.commit(ledger));

    const stored = await run(ledger.get(MODEL, "s"));
    expect(stored.items).toContainEqual(
      expect.objectContaining({
        type: "function_call_part",
        name: "get_time",
        thoughtSignature: SIG,
      }),
    );
  });

  it("keeps a signature when the next turn's tool declarations and tool choice change", async () => {
    const ledger = makeInMemoryReplayLedger(() => 5_000_000);
    const headers = { "Session-Id": "chat-1" };
    const tools = [{ functionDeclarations: [{ name: "get_time" }] }];
    const first = antigravityRequest([user("time?")]);
    (first as { request: JsonObject }).request["tools"] = tools;
    (first as { request: JsonObject }).request["toolConfig"] = {
      functionCallingConfig: { mode: "AUTO" },
    };

    const prepared1 = await run(
      prepareReplayPayload(ledger, MODEL, execRequest(first), execOptions(headers), first),
    );

    const accumulator = new ReplayAccumulator(prepared1.scope, first);
    accumulator.observePayload(upstream([{ functionCall: call, thoughtSignature: SIG }]));
    await run(accumulator.commit(ledger));

    // The follow-up turn answers with tool_choice none: the policy differs from the one the call was recorded under.
    const second = secondTurn({
      tools,
      toolConfig: { functionCallingConfig: { mode: "NONE" } },
    });

    const prepared2 = await run(
      prepareReplayPayload(ledger, MODEL, execRequest(second), execOptions(headers), second),
    );

    expect(contentsOf(prepared2.payload)[1]?.parts[0]).toMatchObject({ thoughtSignature: SIG });
  });
});

describe("provenance repairs", () => {
  it("degrades reserved ids: the first call keeps a bypass sentinel, siblings lose the stale signature", () => {
    const reserved = geminiClaudeToolUseID("a", "f", "{}");
    const reserved2 = geminiClaudeToolUseID("b", "g", "{}");

    const payload = antigravityRequest([
      {
        role: "model",
        parts: [
          { functionCall: { id: reserved, name: "f", args: {} }, thoughtSignature: "stale-1" },
          { functionCall: { id: reserved2, name: "g", args: {} }, thoughtSignature: "stale-2" },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: reserved, name: "f", response: {} } },
          { functionResponse: { id: reserved2, name: "g", response: {} } },
        ],
      },
    ]);

    expect(degradeToolProvenanceIds(payload)).toBe(4);
    const [model, response] = contentsOf(payload);
    expect(model?.parts[0]).toMatchObject({
      functionCall: { id: syntheticToolCallId(reserved) },
      thoughtSignature: "skip_thought_signature_validator",
    });
    expect(model?.parts[1]?.["thoughtSignature"]).toBeUndefined();
    expect(response?.parts[1]?.["functionResponse"]).toMatchObject({
      id: syntheticToolCallId(reserved2),
    });
  });

  it("signs only the first unsigned function call of a model turn", () => {
    const payload = antigravityRequest([
      {
        role: "model",
        parts: [
          { functionCall: { name: "f", args: {} } },
          { functionCall: { name: "g", args: {} } },
        ],
      },
    ]);

    repairUnsignedFirstFunctionCalls(payload);
    const parts = contentsOf(payload)[0]?.parts;
    expect(parts?.[0]?.["thoughtSignature"]).toBe("skip_thought_signature_validator");
    expect(parts?.[1]?.["thoughtSignature"]).toBeUndefined();
  });
});

describe("Interactions continuation sessions", () => {
  const MODEL_NAME = "antigravity-preview-05-2026";

  const credential = (overrides: Partial<CredentialSnapshot> = {}): CredentialSnapshot => ({
    id: "credential",
    provider: "gemini-interactions",
    kind: "apikey",
    attributes: { api_key: "secret" },
    metadata: {},
    ...overrides,
  });

  const initial = () => ({
    input: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }],
  });

  const continued = () => ({
    input: [
      { content: [{ text: "hi", type: "text" }], type: "user_input" },
      { type: "function_call", id: "call_1" },
      { type: "function_result", call_id: "call_1", result: "ok" },
    ],
  });

  const prepare = (
    store: ReturnType<typeof makeInMemoryContinuationStore>,
    body: Record<string, unknown>,
    overrides: { credential?: CredentialSnapshot; caller?: string; model?: string } = {},
  ) =>
    run(
      prepareAntigravityInteractions(
        store,
        overrides.credential ?? credential(),
        { model: MODEL_NAME, payload: {} },
        options({ metadata: { ...options().metadata, callerScope: overrides.caller ?? "caller" } }),
        overrides.model ?? MODEL_NAME,
        clone(body) as unknown as Json,
      ),
    );

  const response = (extra: JsonObject = {}) =>
    ({
      id: "interaction_1",
      environment_id: "env_1",
      status: "requires_action",
      steps: [{ type: "function_call", id: "call_1" }],
      ...extra,
    }) as unknown as Json;

  // Port of the Go TestIssue5190ContinuationIsolation table.
  const cases: Array<{
    name: string;
    want: string;
    response?: Json;
    body?: () => Record<string, unknown>;
    credential?: CredentialSnapshot;
    caller?: string;
    model?: string;
  }> = [
    { name: "match", want: "interaction_1" },
    { name: "caller", want: "", caller: "other" },
    { name: "credential", want: "", credential: credential({ id: "other" }) },
    { name: "key", want: "", credential: credential({ attributes: { api_key: "rotated" } }) },
    { name: "model", want: "", model: "antigravity-other" },
    {
      name: "call",
      want: "",
      body: () => ({
        input: [
          { type: "user_input", content: [{ type: "text", text: "hi" }] },
          { type: "function_result", call_id: "other", result: "ok" },
        ],
      }),
    },
    {
      name: "prefix",
      want: "",
      body: () => ({
        input: [
          { type: "user_input", content: [{ type: "text", text: "different" }] },
          { type: "function_result", call_id: "call_1", result: "ok" },
        ],
      }),
    },
    {
      name: "explicit",
      want: "explicit",
      body: () => ({ previous_interaction_id: "explicit", ...continued() }),
    },
    {
      name: "environment",
      want: "interaction_1",
      body: () => ({ environment_id: "explicit-env", ...continued() }),
    },
    { name: "missing", want: "", body: initial },
    {
      name: "partial",
      want: "",
      response: response({
        steps: [
          { type: "function_call", id: "call_1" },
          { type: "function_call", id: "call_2" },
        ],
      }),
    },
    { name: "failed", want: "", response: response({ status: "failed" }) },
  ];

  it.each(cases)("$name", async (testCase) => {
    const store = makeInMemoryContinuationStore(() => 1_000);
    const first = await prepare(store, initial());
    await run(first.state.observe(testCase.response ?? response()));
    const body = (testCase.body ?? continued)();

    const prepared = await prepare(store, body, {
      ...(testCase.credential === undefined ? {} : { credential: testCase.credential }),
      ...(testCase.caller === undefined ? {} : { caller: testCase.caller }),
      ...(testCase.model === undefined ? {} : { model: testCase.model }),
    });

    const rewritten = prepared.body as unknown as Record<string, unknown>;
    expect(rewritten["previous_interaction_id"] ?? "").toBe(testCase.want);

    if (testCase.name === "match") {
      expect(rewritten["input"]).toEqual([
        { type: "function_result", call_id: "call_1", result: "ok" },
      ]);
      expect(rewritten["environment_id"]).toBe("env_1");
    } else if (testCase.want === "" || testCase.name === "explicit") {
      expect(rewritten).toEqual(body);
    }

    if (testCase.name === "environment") expect(rewritten["environment_id"]).toBe("explicit-env");
  });

  it("expires continuations after 30 minutes and ignores non-antigravity models", async () => {
    let now = 1_000;
    const store = makeInMemoryContinuationStore(() => now);
    const first = await prepare(store, initial());
    await run(first.state.observe(response()));
    now += 29 * 60_000;
    expect(
      ((await prepare(store, continued())).body as unknown as Record<string, unknown>)[
        "previous_interaction_id"
      ],
    ).toBe("interaction_1");
    now += 2 * 60_000;
    expect(
      ((await prepare(store, continued())).body as unknown as Record<string, unknown>)[
        "previous_interaction_id"
      ],
    ).toBeUndefined();

    const plain = await prepare(store, continued(), { model: "gemini-2.5-pro" });
    expect(
      (plain.body as unknown as Record<string, unknown>)["previous_interaction_id"],
    ).toBeUndefined();
  });

  it("tracks streamed steps and keeps one entry per conversation call set", async () => {
    const store = makeInMemoryContinuationStore(() => 1_000);
    const first = await prepare(store, initial());
    await run(
      first.state.observe({
        event_type: "interaction.created",
        interaction: { id: "int_s", environment_id: "env_s" },
      }),
    );
    await run(
      first.state.observe({
        event_type: "step.start",
        step: { type: "function_call", id: "call_1" },
      }),
    );
    await run(
      first.state.observe({
        event_type: "interaction.completed",
        interaction: { status: "requires_action" },
      }),
    );
    const prepared = await prepare(store, continued());
    expect((prepared.body as unknown as Record<string, unknown>)["previous_interaction_id"]).toBe(
      "int_s",
    );
  });

  it("rejects ambiguous call sets", () => {
    expect(interactionsCallKey(["b", "a"])).toBe(interactionsCallKey(["a", "b"]));

    for (const calls of [[], [""], ["a", "a"], ["a\u0000b"]])
      expect(interactionsCallKey(calls)).toBe("");
  });
});
