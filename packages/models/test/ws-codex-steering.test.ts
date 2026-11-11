// Codex response steering / full duplex (`upstream.codex.response-steering`, codex_websockets_duplex.go) end to end: a client
// socket through the Worker handler to a mocked upstream socket that the executor owns until the client goes away.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import type { Config } from "../src/config/schema.ts";
import { makeCodexExecutor } from "../src/executor/codex/executor.ts";
import { codexSessionStore } from "../src/executor/websocket/session.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import { sealCompaction } from "../src/executor/helps/compaction.ts";
import { codexModels, oauthCredential, providerKeyCredential } from "./support/codex.ts";
import { harness, json, options } from "./support/executor-run.ts";
import { loadConfig, makePipeline, sseResponse } from "./support/pipeline.ts";
import {
  connectClient,
  errorOf,
  eventually,
  mockUpstream,
  type MockUpstreamOptions,
  scripted,
  settled,
  type TestClient,
  type UpstreamConnection,
} from "./support/websocket.ts";
import { xaiPicker, type XaiPickerLog } from "./support/xai.ts";

const created = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "response.created",
  response: { id, model: "gpt-5.4", status: "in_progress", ...extra },
});

const done = (id: string, tokens = 5) => ({
  type: "response.completed",
  response: {
    id,
    status: "completed",
    model: "gpt-5.4",
    output: [
      {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hi" }],
      },
    ],
    usage: { input_tokens: tokens, output_tokens: 1, total_tokens: tokens + 1 },
  },
});

const create = (text = "hi", extra: Record<string, unknown> = {}) => ({
  type: "response.create",
  model: "gpt-5.4",
  input: [{ type: "message", role: "user", content: text }],
  ...extra,
});

const STEERING = "upstream:\n  codex:\n    response-steering: true\n";

let steering: Config;

let plain: Config;

beforeAll(async () => {
  steering = await loadConfig(STEERING);
  plain = await loadConfig("requests: {}");
});

const wsCredential = (overrides: Partial<CredentialSnapshot> = {}) =>
  oauthCredential({ attributes: { plan_type: "plus", websockets: "true" }, ...overrides });

const setup = (
  credentials: ReadonlyArray<CredentialSnapshot>,
  upstream: MockUpstreamOptions,
  configOverride: Config = steering,
  respond: () => Response = () => sseResponse([]),
) => {
  const log: XaiPickerLog = { picks: [], reports: [] };
  const mock = mockUpstream(upstream);

  const p = makePipeline({
    config: configOverride,
    respond,
    credentialPicker: xaiPicker(credentials, log),
    modelProviders: codexModels,
    websocketConnector: mock.layer,
  });

  afterAll(p.dispose);

  const connect = async () =>
    connectClient(await p.call("/v1/responses", { headers: { upgrade: "websocket" } }));

  return { ...p, log, mock, connect };
};

const frames = (connection: UpstreamConnection | undefined) =>
  (connection?.received ?? []).map((text) => JSON.parse(text) as Record<string, unknown>);

describe("response steering (full duplex)", () => {
  it("keeps the socket open across responses and writes follow-up creates straight upstream", async () => {
    const s = setup([wsCredential()], {
      onConnection: scripted((frame, index, send) => {
        const id = `resp_${index + 1}`;
        send(created(id));
        send(done(id, 10 * (index + 1)));
        expect(frame["type"]).toBe("response.create");
      }),
    });

    const client = await s.connect();
    client.send(create("one"));
    expect((await client.nextJson())["type"]).toBe("response.created");
    expect((await client.until("response.completed"))["response"]).toMatchObject({ id: "resp_1" });
    // The executor, not the handler, consumes the next frame: no transcript rebuild, the raw create is prepared and framed.
    client.send(create("two", { previous_response_id: "resp_1" }));
    const second = await client.until("response.completed");
    expect((second["response"] as { id: string }).id).toBe("resp_2");
    const upstream = frames(s.mock.connections[0]);
    expect(upstream).toHaveLength(2);
    expect(upstream[1]).toMatchObject({
      type: "response.create",
      previous_response_id: "resp_1",
      model: "gpt-5.4",
    });
    expect(s.mock.dials).toHaveLength(1);
    // Still one attempt: no success report until the socket ends.
    expect(s.log.reports).toHaveLength(0);
    client.close();
    await eventually(() => s.log.reports.length === 1);
    // The record carries both responses' tokens.
    expect(s.records[0]?.detail.inputTokens).toBe(30);
  });

  it("forwards response.steer and its acknowledgements verbatim and holds creates until they are settled", async () => {
    const s = setup([wsCredential()], {
      onConnection: scripted((frame, _index, send) => {
        if (frame["type"] === "response.create") {
          send(created("resp_1"));
        } else if (frame["type"] === "response.steer") {
          send(
            '{"type":"response.steer.accepted","steer":{"id":"steer_1","previous_response_id":"resp_1"},"sequence_number":7}',
          );
          send(
            '{"type":"response.steer.pending","steer":{"id":"steer_1","previous_response_id":"resp_1"},"sequence_number":8}',
          );
        }
      }),
    });

    const client = await s.connect();
    client.send(create("work"));
    expect((await client.nextJson())["type"]).toBe("response.created");
    client.send({
      type: "response.steer",
      previous_response_id: "resp_1",
      input: [{ type: "message", role: "user", content: "change course" }],
      unknown_field: { keep: true },
    });
    // Opaque events keep their exact text (key order, spacing).
    expect(await client.next()).toBe(
      '{"type":"response.steer.accepted","steer":{"id":"steer_1","previous_response_id":"resp_1"},"sequence_number":7}',
    );
    expect((await client.nextJson())["type"]).toBe("response.steer.pending");
    const sent = frames(s.mock.connections[0]);
    expect(sent[1]).toMatchObject({
      type: "response.steer",
      previous_response_id: "resp_1",
      unknown_field: { keep: true },
    });
    // A create that does not continue the waiting response is rejected locally and never reaches the upstream.
    client.send(create("elsewhere", { previous_response_id: "resp_other" }));
    const rejected = await client.nextJson();
    expect(rejected).toMatchObject({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message: "response.create must continue the response waiting for required input",
      },
    });
    expect(frames(s.mock.connections[0])).toHaveLength(2);
    // The one waiting for the pending response goes through.
    client.send(create("results", { previous_response_id: "resp_1" }));
    await eventually(() => frames(s.mock.connections[0]).length === 3);
    expect(frames(s.mock.connections[0])[2]).toMatchObject({
      type: "response.create",
      previous_response_id: "resp_1",
    });
    client.close();
  });

  it("lets an automatic successor inherit the parent's settings and reports failed steers", async () => {
    const s = setup([wsCredential()], {
      onConnection: scripted((frame, _index, send) => {
        if (frame["type"] === "response.create") {
          send(created("resp_1"));
          send(done("resp_1"));
        } else if (frame["type"] === "response.steer") {
          send(
            '{"type":"response.steer.accepted","steer":{"id":"s1","previous_response_id":"resp_1"}}',
          );
          // Upstream starts the successor by itself.
          send(created("resp_2", { previous_response_id: "resp_1" }));
          send(done("resp_2"));
          send(
            '{"type":"response.steer.failed","steer":{"id":"s2","previous_response_id":"resp_2"}}',
          );
        }
      }),
    });

    const client = await s.connect();
    client.send(create("go"));
    await client.until("response.completed");
    client.send({ type: "response.steer", previous_response_id: "resp_1", input: [] });
    expect((await client.nextJson())["type"]).toBe("response.steer.accepted");
    expect((await client.nextJson())["response"]).toMatchObject({
      id: "resp_2",
      previous_response_id: "resp_1",
    });
    expect((await client.until("response.completed"))["response"]).toMatchObject({ id: "resp_2" });
    expect((await client.nextJson())["type"]).toBe("response.steer.failed");
    // The socket stays usable: a new create is written after the steering settled.
    client.send(create("next", { previous_response_id: "resp_2" }));
    await eventually(() => frames(s.mock.connections[0]).length === 3);
    expect(frames(s.mock.connections[0]).at(-1)).toMatchObject({
      type: "response.create",
      previous_response_id: "resp_2",
    });
    client.close();
  });

  it("answers malformed and unsupported frames locally and keeps the socket", async () => {
    const s = setup([wsCredential()], {
      onConnection: scripted((_frame, _index, send) => send(created("resp_1"))),
    });

    const client = await s.connect();
    client.send(create("go"));
    await client.nextJson();
    client.send("{not json");
    expect(await client.nextJson()).toMatchObject({
      type: "error",
      status: 400,
      error: { message: "invalid websocket request JSON" },
    });
    client.send({ type: "response.cancel" });
    expect(await client.nextJson()).toMatchObject({
      type: "error",
      error: { message: "unsupported websocket request type: response.cancel" },
    });
    expect(frames(s.mock.connections[0])).toHaveLength(1);
    client.close();
  });

  it("delivers a failure that precedes the first response as a failover, and closes on credential failures later", async () => {
    let connections = 0;

    const second = wsCredential({
      id: "codex-oauth-2",
      metadata: { access_token: "access-token-2", account_id: "acct_2" },
    });

    const s = setup([wsCredential(), second], {
      onConnection: scripted((frame, index, send) => {
        connections += 1;

        if (connections === 1) {
          send({
            type: "error",
            status: 429,
            error: { type: "usage_limit_reached", message: "limit" },
          });
        } else if (index === 0) {
          send(created("resp_1"));
          send(done("resp_1"));
        } else {
          send(created("resp_2"));
          send({
            type: "error",
            status: 401,
            error: { type: "invalid_request_error", message: "expired" },
          });
        }

        expect(frame["type"]).toBe("response.create");
      }),
    });

    const client = await s.connect();
    client.send(create("go"));
    // The first credential's rejection never reached the client; the second one served.
    expect((await client.nextJson())["type"]).toBe("response.created");
    await client.until("response.completed");
    expect(s.mock.dials.map((dial) => dial.headers["authorization"])).toEqual([
      "Bearer access-token-1",
      "Bearer access-token-2",
    ]);
    client.send(create("again", { previous_response_id: "resp_1" }));
    // The credential error after the first response is delivered as an event, then the socket closes.
    expect((await client.until("error"))["status"]).toBe(401);
    await client.closed;
    await eventually(() => s.log.reports.length === 2);
    const results = s.log.reports.map((report) => report.result);
    expect(results[0]?.success).toBe(false);
    expect(results[1]?.success).toBe(false);
  });

  it("is off by default: the handler plans every turn itself", async () => {
    const s = setup(
      [wsCredential()],
      {
        onConnection: scripted(
          (_frame, index, send) => (
            send(created(`resp_${index + 1}`)),
            send(done(`resp_${index + 1}`))
          ),
        ),
      },
      plain,
    );

    const client = await s.connect();
    client.send(create("one"));
    await client.until("response.completed");
    // A completed turn reports its attempt right away (no duplex ownership).
    expect(s.log.reports).toHaveLength(1);
    client.close();
  });
});

describe("non-stream execution over the upstream WebSocket", () => {
  it("aggregates the Responses events into the translated completed answer and keeps the session socket", async () => {
    const mock = mockUpstream({
      onConnection: scripted((_frame, _index, send) => {
        send(created("resp_1"));
        send({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hi" }],
          },
        });
        send({
          type: "response.done",
          response: {
            id: "resp_1",
            status: "completed",
            model: "gpt-5.4",
            output: [],
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          },
        });
      }),
    });

    const h = await harness(wsCredential(), () => new Response(""), undefined, false);
    const layers = Layer.merge(h.layers, mock.layer);
    const executor = makeCodexExecutor();

    const response = await Effect.runPromise(
      executor
        .execute(
          h.context,
          { model: "gpt-5.4", payload: json({ model: "gpt-5.4", input: "hi" }) },
          options({
            sourceFormat: "openai-response",
            metadata: {
              ...options().metadata,
              requestPath: "/v1/responses",
              websocket: { sessionId: "ns-session", requireUpstream: false },
            },
          }),
        )
        .pipe(Effect.provide(layers)),
    );

    const body = JSON.parse(response.payload) as {
      id: string;
      status: string;
      output: Array<{ id: string }>;
      usage: { input_tokens: number };
    };

    expect(body).toMatchObject({ id: "resp_1", status: "completed", usage: { input_tokens: 3 } });
    expect(body.output.map((item) => item.id)).toEqual(["msg_1"]);
    expect(frames(mock.connections[0])[0]).toMatchObject({ type: "response.create", stream: true });
    // The socket stays with the session for the next turn.
    expect(codexSessionStore.peek("ns-session")?.socket).toBeDefined();
    await Effect.runPromise(codexSessionStore.close("ns-session"));
    expect(h.calls).toHaveLength(0);
  });

  it("surfaces upstream error frames classified like the stream path and needs the live socket when required", async () => {
    const mock = mockUpstream({
      onConnection: scripted((_frame, _index, send) =>
        send({
          type: "error",
          status: 429,
          error: { type: "usage_limit_reached", message: "limit" },
        }),
      ),
    });

    const h = await harness(wsCredential(), () => new Response(""), undefined, false);
    const layers = Layer.merge(h.layers, mock.layer);
    const executor = makeCodexExecutor();

    const run = (websocket: { sessionId: string; requireUpstream: boolean }) =>
      Effect.runPromise(
        Effect.flip(
          executor.execute(
            h.context,
            { model: "gpt-5.4", payload: json({ model: "gpt-5.4", input: "hi" }) },
            options({
              sourceFormat: "openai-response",
              metadata: { ...options().metadata, websocket },
            }),
          ),
        ).pipe(Effect.provide(layers)),
      );

    expect((await run({ sessionId: "ns-error", requireUpstream: false })).status).toBe(429);
    // Without a retained socket a continuation cannot be served: the client must replay.
    const replay = await run({ sessionId: "ns-missing", requireUpstream: true });
    expect(replay.code).toBe("upstream_websocket_replay_required");
    await Effect.runPromise(codexSessionStore.close("ns-error"));
  });
});

/** Round trips with unknown ids until the request in flight has ended (then no response can be targeted any more). */
const requestEnded = async (client: TestClient): Promise<void> => {
  for (let turn = 0; turn < 500; turn++) {
    client.send({ type: "response.interrupt", response_id: "resp_none" });
    const answer = await client.until("error");

    if (errorOf(answer).message?.includes("no active upstream websocket") === true) return;
  }

  throw new Error("the request did not end");
};

describe("upstream socket loss on a steering socket (CLIProxyAPI f73e66ac)", () => {
  it("fences a frame queued behind the lost request: answered not sent, never written upstream", async () => {
    const s = setup([wsCredential()], {
      // The first connection never answers; the second one does.
      onConnection: (connection) => {
        if (s.mock.connections.length > 1)
          scripted((_frame, _index, send) => send(created("resp_2")))(connection);
        else scripted(() => undefined)(connection);
      },
    });

    const client = await s.connect();
    client.send({ ...create("one"), event_id: "evt-1" });
    // The duplex consumes no follow-up before the first response is established: this one waits in the queue.
    client.send({ ...create("two"), event_id: "evt-2" });
    await settled(client);
    // The first create is upstream (the socket is dialled) and unanswered: the loss comes before any output.
    await eventually(() => frames(s.mock.connections[0]).length === 1);
    s.mock.connections[0]?.drop();

    const lost = await client.nextJson();
    expect(lost).toMatchObject({ type: "error", status: 502 });
    expect(errorOf(lost)).toMatchObject({ code: "upstream_websocket_lost", event_id: "evt-1" });
    const fenced = await client.nextJson();
    expect(fenced).toMatchObject({ type: "error", status: 502 });
    expect(errorOf(fenced)).toMatchObject({
      code: "upstream_websocket_not_sent",
      event_id: "evt-2",
    });
    expect(frames(s.mock.connections[0])).toHaveLength(1);

    // The client socket is still there: a new create redials.
    client.send(create("three"));
    expect((await client.nextJson())["type"]).toBe("response.created");
    expect(s.mock.dials).toHaveLength(2);
    client.close();
  });

  it("reports the creates the executor had already taken next to the loss", async () => {
    const s = setup([wsCredential()], {
      onConnection: scripted((_frame, index, send) => {
        if (index === 0) send(created("resp_1"));
      }),
    });

    const client = await s.connect();
    client.send(create("one"));
    await client.until("response.created");
    client.send({ ...create("two", { previous_response_id: "resp_1" }), event_id: "evt-2" });
    // The executor took the follow-up and wrote it upstream; its response never starts.
    await eventually(() => frames(s.mock.connections[0]).length === 2);
    s.mock.connections[0]?.drop();

    const lost = await client.nextJson();
    expect(errorOf(lost)).toMatchObject({ code: "upstream_websocket_lost" });
    const abandoned = await client.nextJson();
    expect(errorOf(abandoned)).toMatchObject({
      code: "upstream_websocket_lost",
      event_id: "evt-2",
    });
    client.close();
  });

  it("writes nothing for a loss between two responses and answers a response.interrupt that targets none", async () => {
    const s = setup([wsCredential()], {
      onConnection: scripted((_frame, index, send) => {
        send(created(`resp_${index + 1}`));
        send(done(`resp_${index + 1}`));
      }),
    });

    const client = await s.connect();
    client.send(create("one"));
    await client.until("response.completed");

    // Between responses of the steering socket, an id that is not a finished response targets nothing.
    client.send({ type: "response.interrupt", response_id: "resp_other" });
    const rejected = await client.nextJson();
    expect(rejected).toMatchObject({ type: "error", status: 400 });
    expect(errorOf(rejected).message).toContain("does not target the active upstream response");

    // The finished response's own interrupt is dropped silently.
    client.send({ type: "response.interrupt", response_id: "resp_1" });
    expect(await settled(client)).toEqual([]);

    s.mock.connections[0]?.drop();
    await requestEnded(client);
    // The loss between two responses was not reported to the client.
    expect(client.messages.filter((text) => text.includes("upstream_websocket_lost"))).toEqual([]);

    client.send(create("two"));
    expect(await client.until("response.created")).toMatchObject({ response: { id: "resp_1" } });
    expect(s.mock.dials).toHaveLength(2);
    client.close();
  });
});

describe("CPA compaction capsules on a steering socket", () => {
  const capsule = async () => ({
    type: "compaction",
    id: "cmp_ag_compact_1",
    encrypted_content: await sealCompaction("earlier work", "claude-sonnet-4-5"),
  });

  const developerSummary = {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "Context summary from previous turns:\nearlier work" }],
  };

  it("starts duplex for a native model and expands the capsules of a create and of a steer", async () => {
    const s = setup([wsCredential()], {
      onConnection: scripted((frame, _index, send) => {
        if (frame["type"] === "response.create") send(created("resp_1"));
        else
          send(
            '{"type":"response.steer.accepted","steer":{"id":"s1","previous_response_id":"resp_1"}}',
          );
      }),
    });

    const client = await s.connect();
    client.send(
      create("work", {
        input: [await capsule(), { type: "message", role: "user", content: "go" }],
      }),
    );
    await client.nextJson();
    client.send({
      type: "response.steer",
      previous_response_id: "resp_1",
      input: [await capsule()],
    });
    expect((await client.nextJson())["type"]).toBe("response.steer.accepted");
    const sent = frames(s.mock.connections[0]);
    expect(sent[0]?.["input"]).toEqual([
      developerSummary,
      { type: "message", role: "user", content: "go" },
    ]);

    expect(sent[1]).toMatchObject({ type: "response.steer", input: [developerSummary] });
    expect(JSON.stringify(sent)).not.toContain("cpa-ag-compact-v1:");
    client.close();
  });

  it("ends the socket when a steered capsule is corrupt", async () => {
    const s = setup([wsCredential()], {
      onConnection: scripted((_frame, _index, send) => send(created("resp_1"))),
    });

    const client = await s.connect();
    client.send(create("work"));
    await client.nextJson();

    client.send({
      type: "response.steer",
      previous_response_id: "resp_1",
      input: [
        { type: "compaction", id: "cmp_ag_compact_9", encrypted_content: "cpa-ag-compact-v1:AAAA" },
      ],
    });

    await client.closed;
    expect(frames(s.mock.connections[0])).toHaveLength(1);
  });
});

describe("an is-compat model never starts steering", () => {
  const compatSteering = `
upstream:
  codex:
    response-steering: true
api-keys:
  codex:
    - base-url: https://codex.example.test/v1
      keys:
        - api-key: sk-codex-1
          models:
            - name: gpt-5.4
              is-compat: true
`;

  const compatCredential = () =>
    providerKeyCredential({
      attributes: {
        api_key: "sk-codex-1",
        base_url: "https://codex.example.test/v1",
        websockets: "true",
      },
    });

  const summary = () =>
    sseResponse([
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_s", status: "in_progress" } })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_s",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "the summary" }],
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_s", status: "completed", model: "gpt-5.4", output: [] },
      })}\n\n`,
    ]);

  it("compacts a trigger locally after a normal request and keeps the socket open", async () => {
    const s = setup(
      [compatCredential()],
      {
        onConnection: scripted((_frame, index, send) => {
          send(created(`resp_${index + 1}`));
          send(done(`resp_${index + 1}`));
        }),
      },
      await loadConfig(compatSteering),
      summary,
    );

    const client = await s.connect();
    client.send(create("one"));
    await client.until("response.completed");

    client.send({
      type: "response.create",
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: "one" }, { type: "compaction_trigger" }],
    });

    const compacted = await client.until("response.completed");
    expect((compacted["response"] as { id: string }).id).toMatch(/^resp_ag_compact_/);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.body).not.toContain("compaction_trigger");
    expect(JSON.stringify(frames(s.mock.connections[0]))).not.toContain("compaction_trigger");

    // The socket survived: a create after the compaction is answered.
    client.send(create("two"));
    await client.until("response.completed");
    client.close();
  });

  it("answers a response.steer with the planner's 400 frame and keeps the socket open", async () => {
    const s = setup(
      [compatCredential()],
      {
        onConnection: scripted((_frame, index, send) => {
          send(created(`resp_${index + 1}`));
          send(done(`resp_${index + 1}`));
        }),
      },
      await loadConfig(compatSteering),
      summary,
    );

    const client = await s.connect();
    client.send(create("one"));
    await client.until("response.completed");

    client.send({
      type: "response.steer",
      previous_response_id: "resp_1",
      input: [{ type: "message", role: "user", content: "change course" }],
    });

    expect(await client.until("error")).toMatchObject({
      status: 400,
      error: { message: "unsupported websocket request type: response.steer" },
    });

    client.send(create("two", { previous_response_id: "resp_1" }));
    await client.until("response.completed");
    expect(JSON.stringify(frames(s.mock.connections[0]))).not.toContain("response.steer");
    client.close();
  });
});
