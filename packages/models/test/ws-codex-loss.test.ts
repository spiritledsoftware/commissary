// The Responses WebSocket outlives its upstream socket (CLIProxyAPI f73e66ac), exposes terminal 429s (b5e6027c), fails
// over on a bootstrap usage limit (86a1aabf) and rejects late interrupts (9717e325, d318bcc3): a client socket through
// the Worker handler to a mocked upstream socket (Codex) or a mocked HTTP upstream.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import { asString, type Json, type JsonObject } from "@commissary/json";
import { codexSessionStore } from "../src/executor/websocket/session.ts";
import { codexModels, oauthCredential } from "./support/codex.ts";
import {
  loadConfig,
  makePipeline,
  sseResponse,
  type UpstreamResponder,
} from "./support/pipeline.ts";
import {
  connectClient,
  mockUpstream,
  type MockUpstreamOptions,
  type UpstreamConnection,
} from "./support/websocket.ts";
import { xaiPicker, type XaiPickerLog } from "./support/xai.ts";

const created = (id: string) => ({
  type: "response.created",
  response: { id, model: "gpt-5.4", status: "in_progress" },
});

const done = (id: string, type = "response.completed") => ({
  type,
  response: {
    id,
    status: "completed",
    model: "gpt-5.4",
    output: [],
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  },
});

const MESSAGE_ITEM = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Hi" }],
};

const item = (extra: Record<string, unknown> = {}) => ({
  type: "response.output_item.done",
  output_index: 0,
  item: { ...MESSAGE_ITEM, ...extra },
});

const create = (eventId: string, extra: Record<string, unknown> = {}) => ({
  type: "response.create",
  event_id: eventId,
  model: "gpt-5.4",
  input: [{ type: "message", role: "user", content: "hi" }],
  ...extra,
});

const quotaError = (extra: JsonObject = {}) => ({
  type: "error",
  status: 429,
  error: { type: "usage_limit_reached", message: "limit", resets_in_seconds: 60 },
  headers: { "retry-after": "60" },
  ...extra,
});

let config: Config;

let buffering: Config;

beforeAll(async () => {
  config = await loadConfig("requests: {}");
  buffering = await loadConfig("upstream:\n  codex:\n    stream-bootstrap-buffering: true\n");
});

const wsCredential = (id = "codex-oauth-1", token = "access-token-1") =>
  oauthCredential({
    id,
    attributes: { plan_type: "plus", websockets: "true" },
    metadata: { access_token: token, account_id: "acct_123" },
  });

const second = wsCredential("codex-oauth-2", "access-token-2");

const setup = (
  credentials: ReadonlyArray<CredentialSnapshot>,
  upstream: MockUpstreamOptions = {},
  respond: UpstreamResponder = () => sseResponse([]),
  configOverride: Config = config,
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

/** Scripted upstream: `script(frame, index, send, connection)` answers each frame Commissary writes to a connection. */
const scripted =
  (
    script: (
      frame: Record<string, unknown>,
      index: number,
      send: (event: Json) => void,
      connection: UpstreamConnection,
    ) => void,
  ) =>
  (connection: UpstreamConnection): void => {
    void (async () => {
      for (let index = 0; ; index++) {
        const text = await connection.next();
        script(
          JSON.parse(text) as Record<string, unknown>,
          index,
          (event) => connection.server.send(JSON.stringify(event)),
          connection,
        );
      }
    })();
  };

/** Lets queued socket events and fibers run: the client frames sent so far are read and queued by the handler. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

const eventually = async (condition: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 2000 && !condition(); turn++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  expect(condition()).toBe(true);
};

const errorOf = (frame: Record<string, unknown>) =>
  frame["error"] as { code?: string; event_id?: string; message?: string; type?: string };

const authTokens = (mock: ReturnType<typeof mockUpstream>) =>
  mock.dials.map((dial) => dial.headers["authorization"]);

describe("upstream socket loss", () => {
  it("keeps the client socket open after a loss mid-response: 502 frame, redial on the same credential, 409 for a continuation", async () => {
    const s = setup([wsCredential()], {
      onConnection: scripted((frame, _index, send, connection) => {
        if (frame["event_id"] === "evt-1") {
          send(created("resp_1"));
          send(item());
          // The frames above are delivered before the socket goes away.
          void settle().then(() => connection.drop());
        } else {
          send(created("resp_2"));
          send(done("resp_2"));
        }
      }),
    });

    const client = await s.connect();
    client.send(create("evt-1"));
    expect((await client.nextJson())["type"]).toBe("response.created");
    expect((await client.nextJson())["type"]).toBe("response.output_item.done");

    const lost = await client.nextJson();
    expect(lost).toMatchObject({ type: "error", status: 502 });
    expect(errorOf(lost)).toMatchObject({ code: "upstream_websocket_lost", event_id: "evt-1" });

    // A continuation needs the socket that is gone: refused, nothing is sent upstream.
    client.send(create("evt-2", { previous_response_id: "resp_1" }));
    const refused = await client.nextJson();
    expect(refused).toMatchObject({ type: "error", status: 409 });
    expect(errorOf(refused)).toMatchObject({
      code: "previous_response_not_found",
      event_id: "evt-2",
    });
    expect(s.mock.dials).toHaveLength(1);

    // A full create redials, on the credential that is still pinned.
    client.send(create("evt-3"));
    expect((await client.nextJson())["type"]).toBe("response.created");
    expect((await client.nextJson())["type"]).toBe("response.completed");
    expect(authTokens(s.mock)).toEqual(["Bearer access-token-1", "Bearer access-token-1"]);
    expect(s.log.picks.map((pick) => pick.pinnedId)).toEqual([
      undefined,
      "codex-oauth-1",
      "codex-oauth-1",
    ]);
    client.close();
  });

  it("does not fail over or cool a credential when the upstream closes before any output", async () => {
    const s = setup([wsCredential(), second], {
      onConnection: scripted((_frame, _index, _send, connection) => connection.drop()),
    });

    const client = await s.connect();
    client.send(create("evt-1"));
    const lost = await client.nextJson();
    expect(lost).toMatchObject({ type: "error", status: 502 });
    expect(errorOf(lost)).toMatchObject({ code: "upstream_websocket_lost", event_id: "evt-1" });

    // The create may already be running upstream: never replayed, on this credential or another one.
    expect(s.mock.dials).toHaveLength(1);
    expect(s.log.reports).toHaveLength(1);
    // Reported as the request's: no cooldown.
    expect(s.log.reports[0]?.result).toMatchObject({
      success: false,
      error: { code: "request_scoped" },
    });
    client.close();
  });

  it("writes nothing when the upstream drops between requests; the next full create redials", async () => {
    const s = setup([wsCredential()], {
      onConnection: scripted((_frame, index, send) => {
        send(created(`resp_${index + 1}`));
        send(done(`resp_${index + 1}`));
      }),
    });

    const client = await s.connect();
    client.send(create("evt-1"));
    await client.until("response.completed");

    s.mock.connections[0]?.server.close(1001, "going away");
    await eventually(() => codexSessionStore.ids().some((id) => codexSessionStore.peek(id)?.lost));

    client.send(create("evt-2"));
    // Nothing was written for the idle loss: the first frame is the next response's.
    expect((await client.nextJson())["type"]).toBe("response.created");
    expect((await client.nextJson())["type"]).toBe("response.completed");
    expect(s.mock.dials).toHaveLength(2);
    expect(client.messages.map((text) => JSON.parse(text).type)).not.toContain("error");
    client.close();
  });

  it.each([
    ["a create", { previous_response_id: undefined }, 502, "upstream_websocket_not_sent"],
    ["a continuation", { previous_response_id: "resp_1" }, 409, "previous_response_not_found"],
  ])(
    "answers %s queued behind a request that loses its socket and never sends it upstream",
    async (_name, extra, status, code) => {
      const s = setup([wsCredential()], {
        onConnection: scripted((_frame, _index, send, connection) => {
          send(created("resp_1"));
          // The client frame queued behind the running request is read before the socket drops.
          void settle().then(() => connection.drop());
        }),
      });

      const client = await s.connect();
      client.send(create("evt-1"));
      expect((await client.nextJson())["type"]).toBe("response.created");
      client.send(create("evt-2", extra));

      const lost = await client.nextJson();
      expect(errorOf(lost)).toMatchObject({ code: "upstream_websocket_lost", event_id: "evt-1" });
      const fenced = await client.nextJson();
      expect(fenced).toMatchObject({ type: "error", status });
      expect(errorOf(fenced)).toMatchObject({ code, event_id: "evt-2" });
      expect(s.mock.connections[0]?.received).toHaveLength(1);
      expect(s.mock.dials).toHaveLength(1);
      client.close();
    },
  );

  it("leaves other upstream closes as they were: no error frame, the client socket closes", async () => {
    const s = setup([wsCredential()], {
      onConnection: scripted((_frame, _index, send, connection) => {
        send(created("resp_1"));
        void settle().then(() => connection.server.close(1001, "going away"));
      }),
    });

    const client = await s.connect();
    client.send(create("evt-1"));
    expect((await client.nextJson())["type"]).toBe("response.created");
    expect((await client.closed).code).toBe(1011);
    expect(client.messages.map((text) => JSON.parse(text).type)).toEqual(["response.created"]);
  });
});

/** A socket whose first request completed on a pinned credential and whose continuation the upstream fails with `failure`. */
const pinnedContinuation = async (
  credentials: ReadonlyArray<CredentialSnapshot>,
  failure: JsonObject,
) => {
  const s = setup(credentials, {
    onConnection: scripted((_frame, index, send) => {
      if (index === 0) {
        send(created("resp_1"));
        send(done("resp_1"));
      } else send(failure);
    }),
  });

  const client = await s.connect();
  client.send(create("evt-1"));
  await client.until("response.completed");
  client.send(create("evt-2", { previous_response_id: "resp_1", input: [] }));

  return { s, client };
};

describe("terminal 429 on a pinned continuation", () => {
  it("exposes the 429 with the trusted Retry-After and closes 1011 when no other credential could serve a replay", async () => {
    const { client } = await pinnedContinuation([wsCredential()], quotaError());
    const frame = await client.nextJson();
    expect(frame).toMatchObject({
      type: "error",
      status: 429,
      headers: { "Retry-After": "60" },
      error: { type: "usage_limit_reached" },
    });

    expect((await client.closed).code).toBe(1011);
  });

  it("asks the client to replay (1012) when another credential could serve it", async () => {
    const { client } = await pinnedContinuation([wsCredential(), second], quotaError());
    expect(await client.closed).toEqual({ code: 1012, reason: "upstream requires HTTP replay" });
    expect(client.messages.map((text) => JSON.parse(text).type)).not.toContain("error");
  });

  it("asks the client to replay (1012) after a 401, whatever the other credentials", async () => {
    const { client } = await pinnedContinuation([wsCredential()], {
      type: "error",
      status: 401,
      error: { type: "authentication_error", message: "expired" },
    });

    expect(await client.closed).toEqual({ code: 1012, reason: "upstream requires HTTP replay" });
  });
});

describe("terminal 429 without a pin", () => {
  it("exposes the quota error with Retry-After instead of a silent 1011", async () => {
    const s = setup([wsCredential()], {
      onConnection: scripted((_frame, _index, send) => send(quotaError())),
    });

    const client = await s.connect();
    client.send(create("evt-1"));
    expect(await client.nextJson()).toMatchObject({
      type: "error",
      status: 429,
      headers: { "Retry-After": "60" },
      error: { type: "usage_limit_reached" },
    });

    expect((await client.closed).code).toBe(1011);
    expect(s.log.reports[0]?.result).toMatchObject({ success: false, httpStatus: 429 });
  });
});

describe("bootstrap usage limit (stream-bootstrap-buffering)", () => {
  it("fails a response.failed usage limit over to the next credential, cooling the first, with no frame leaked", async () => {
    let connections = 0;

    const metadata = {
      type: "response.metadata",
      response_id: "resp_1",
      sequence_number: 2,
      metadata: { openai_chatgpt_moderation_metadata: { prompt: { omnimod: {} } } },
    };

    const s = setup(
      [wsCredential(), second],
      {
        onConnection: scripted((_frame, _index, send) => {
          connections += 1;

          if (connections === 1) {
            send(created("resp_1"));
            send(metadata);
            send({
              type: "response.failed",
              response: {
                id: "resp_1",
                error: { type: "usage_limit_reached", message: "limit", resets_in_seconds: 60 },
              },
            });
          } else {
            send(created("resp_2"));
            send(done("resp_2"));
          }
        }),
      },
      () => sseResponse([]),
      buffering,
    );

    const client = await s.connect();
    client.send(create("evt-1"));
    expect(await client.nextJson()).toMatchObject({
      type: "response.created",
      response: { id: "resp_2" },
    });
    expect((await client.nextJson())["type"]).toBe("response.completed");
    expect(authTokens(s.mock)).toEqual(["Bearer access-token-1", "Bearer access-token-2"]);
    expect(s.log.reports.map((report) => report.result.success)).toEqual([false, true]);
    expect(s.log.reports[0]?.result).toMatchObject({
      httpStatus: 429,
      credentialScoped: true,
      retryAfterMs: 60_000,
    });
    client.close();
  });
});

const sse = (events: JsonObject[]) =>
  sseResponse(
    events.map((event) => `event: ${asString(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`),
  );

describe("an error event from an HTTP provider's stream", () => {
  it("reaches the attempt as the upstream error, so its classification and cooldown are recorded", async () => {
    // A second credential is available: nothing may fail over once the first payload reached the client.
    const s = setup([oauthCredential(), oauthCredential({ id: "codex-oauth-2" })], {}, () =>
      sse([created("resp_1"), item(), quotaError({ status: 429 })]),
    );

    const client = await s.connect();
    client.send(create("evt-1"));
    expect((await client.nextJson())["type"]).toBe("response.created");
    expect((await client.nextJson())["type"]).toBe("response.output_item.done");
    expect(await client.nextJson()).toMatchObject({ type: "error", status: 429 });
    expect((await client.closed).code).toBe(1011);

    await eventually(() => s.log.reports.length === 1);
    // Exactly one upstream attempt, reported with the upstream status, not as a status-less error.
    expect(s.calls).toHaveLength(1);
    expect(s.log.reports[0]?.result).toMatchObject({ success: false, httpStatus: 429 });
  });
});

describe("replayed upstream output (CLIProxyAPI 9037d543)", () => {
  it("drops the output-only content_token_count from the replayed output of the previous HTTP request", async () => {
    const bodies: Array<{ input: Array<Record<string, unknown>> }> = [];
    const PASSTHROUGH = "internal_chat_message_metadata_passthrough";

    const s = setup([oauthCredential()], {}, (call) => {
      bodies.push(JSON.parse(call.body) as { input: Array<Record<string, unknown>> });
      const id = `resp_${bodies.length}`;

      return sse([
        created(id),
        item({ [PASSTHROUGH]: { turn_id: "t1", content_token_count: 64 } }),
        done(id),
      ]);
    });

    const client = await s.connect();
    client.send(create("evt-1"));
    await client.until("response.completed");
    client.send({
      type: "response.append",
      input: [
        {
          type: "message",
          role: "user",
          content: "two",
          [PASSTHROUGH]: { content_token_count: 9 },
        },
      ],
    });
    await client.until("response.completed");

    const input = bodies[1]?.input ?? [];
    expect(input.map((entry) => entry["role"])).toEqual(["user", "assistant", "user"]);
    // The replayed assistant message keeps its other passthrough keys but not the output-only count.
    expect(input[1]?.[PASSTHROUGH]).toEqual({ turn_id: "t1" });
    // The client's own item is replayed as it sent it.
    expect(input[2]?.[PASSTHROUGH]).toEqual({ content_token_count: 9 });
    client.close();
  });
});

/** An SSE response the test feeds event by event. */
const gatedSse = () => {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    push: (event: JsonObject) =>
      controller?.enqueue(
        encoder.encode(`event: ${asString(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`),
      ),
    end: () => {
      try {
        controller?.close();
      } catch {
        // The executor cancelled the stream after the terminal event.
      }
    },
  };
};

const interrupt = (responseId?: string) => ({
  type: "response.interrupt",
  ...(responseId === undefined ? {} : { response_id: responseId }),
});

const typesOf = (messages: ReadonlyArray<string>) =>
  messages.map((text) => JSON.parse(text).type as string);

describe("response.interrupt", () => {
  describe("on a request over HTTP", () => {
    const start = async () => {
      const gate = gatedSse();
      const s = setup([oauthCredential()], {}, () => gate.response);
      const client = await s.connect();
      client.send(create("evt-1"));

      return { gate, client, s };
    };

    it("is resolved locally before response.created, with the id it names", async () => {
      const { gate, client } = await start();
      gate.push({ type: "response.in_progress", response: { id: "resp_x" } });
      await client.until("response.in_progress");
      client.send(interrupt("resp_x"));
      expect(await client.until("response.incomplete")).toMatchObject({
        response: { id: "resp_x", incomplete_details: { reason: "interrupted" } },
      });
    });

    it("is resolved locally for the running response", async () => {
      const { gate, client } = await start();
      gate.push(created("resp_1"));
      await client.until("response.created");
      client.send(interrupt("resp_1"));
      expect(await client.until("response.incomplete")).toMatchObject({
        response: { id: "resp_1" },
      });
    });

    it("is a 400 for another id than the running response", async () => {
      const { gate, client } = await start();
      gate.push(created("resp_1"));
      await client.until("response.created");
      client.send(interrupt("resp_other"));
      const rejected = await client.nextJson();
      expect(rejected).toMatchObject({ type: "error", status: 400 });
      expect(errorOf(rejected).message).toContain("does not target the active response");
      // The running response is untouched.
      gate.push(done("resp_1"));
      expect((await client.nextJson())["type"]).toBe("response.completed");
    });

    it("never fabricates a response.incomplete after the response's terminal event", async () => {
      const { gate, client } = await start();
      gate.push(created("resp_1"));
      gate.push(done("resp_1"));
      await client.until("response.completed");
      // The stream has not ended yet, but the local path is closed.
      client.send(interrupt("resp_other"));
      const rejected = await client.nextJson();
      expect(rejected).toMatchObject({ type: "error", status: 400 });
      gate.end();
      await settle();
      expect(typesOf(client.messages)).not.toContain("response.incomplete");
    });

    it("is dropped silently once its response finished", async () => {
      const gate = gatedSse();
      const s = setup([oauthCredential()], {}, () => gate.response);
      const client = await s.connect();
      client.send(create("evt-1"));
      gate.push(created("resp_1"));
      gate.push(done("resp_1"));
      gate.end();
      await client.until("response.completed");

      client.send(interrupt("resp_1"));
      await settle();
      expect(typesOf(client.messages)).toEqual(["response.created", "response.completed"]);
    });
  });

  describe("on a request over the upstream socket", () => {
    const start = async (script: Parameters<typeof scripted>[0]) => {
      const s = setup([wsCredential()], { onConnection: scripted(script) });
      const client = await s.connect();
      client.send(create("evt-1"));

      return { s, client };
    };

    it("is forwarded before response.created, and the upstream decides", async () => {
      const { s, client } = await start((frame, _index, send) => {
        if (frame["type"] === "response.interrupt") {
          send({
            type: "response.incomplete",
            response: { id: "resp_1", incomplete_details: { reason: "interrupted" }, output: [] },
          });
        }
      });

      await settle();
      client.send(interrupt("resp_1"));
      expect(await client.until("response.incomplete")).toMatchObject({
        response: { id: "resp_1" },
      });
      expect(s.mock.connections[0]?.received.map((text) => JSON.parse(text).type)).toEqual([
        "response.create",
        "response.interrupt",
      ]);
    });

    it("is a 400 for an id that is not the running response, and is not forwarded", async () => {
      const { s, client } = await start((_frame, _index, send) => send(created("resp_1")));
      await client.until("response.created");
      client.send(interrupt("resp_other"));
      const rejected = await client.nextJson();
      expect(rejected).toMatchObject({ type: "error", status: 400 });
      expect(errorOf(rejected).message).toContain("does not target the active upstream response");
      expect(s.mock.connections[0]?.received).toHaveLength(1);
    });

    it("is dropped silently after response.completed and never sent upstream", async () => {
      const { s, client } = await start((_frame, index, send) => {
        send(created(`resp_${index + 1}`));
        send(done(`resp_${index + 1}`));
      });

      await client.until("response.completed");
      client.send(interrupt("resp_1"));
      await settle();
      // The late interrupt left no trace: the next request starts clean on the same upstream socket.
      client.send(create("evt-2"));
      expect((await client.nextJson())["type"]).toBe("response.created");
      expect((await client.nextJson())["type"]).toBe("response.completed");
      expect(s.mock.connections[0]?.received.map((text) => JSON.parse(text).type)).toEqual([
        "response.create",
        "response.create",
      ]);
      expect(typesOf(client.messages)).not.toContain("error");
    });

    it("has no local fallback when the upstream socket is gone", async () => {
      const { s, client } = await start((_frame, _index, send) => send(created("resp_1")));
      await client.until("response.created");

      // The session lost its socket without the request having noticed yet.
      for (const id of codexSessionStore.ids()) {
        const session = codexSessionStore.peek(id);

        if (session !== undefined) session.socket = undefined;
      }

      client.send(interrupt("resp_1"));
      const rejected = await client.nextJson();
      expect(rejected).toMatchObject({ type: "error", status: 400 });
      expect(errorOf(rejected).message).toContain("no active upstream websocket");
      expect(typesOf(client.messages)).not.toContain("response.incomplete");
      expect(s.mock.connections[0]?.received).toHaveLength(1);
    });
  });

  describe("with no request in flight", () => {
    it("is a 400 without a response_id and for an id that was never running", async () => {
      const s = setup([wsCredential()]);
      const client = await s.connect();
      client.send(interrupt());
      const missing = await client.nextJson();
      expect(missing).toMatchObject({ type: "error", status: 400 });
      expect(errorOf(missing).message).toContain("requires response_id");

      client.send(interrupt("resp_zzz"));
      const unknown = await client.nextJson();
      expect(unknown).toMatchObject({ type: "error", status: 400 });
      expect(errorOf(unknown).message).toContain("no active upstream websocket");
      client.close();
    });
  });
});
