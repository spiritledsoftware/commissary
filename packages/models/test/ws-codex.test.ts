// End-to-end tests (workerd) of the Responses WebSocket: a client socket driven through the Worker handler to a mocked
// upstream WebSocket (Codex) and, for credentials without `websockets`, to a mocked HTTP upstream.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import { codexModels, oauthCredential } from "./support/codex.ts";
import {
  loadConfig,
  makePipeline,
  sseResponse,
  type UpstreamResponder,
} from "./support/pipeline.ts";
import { connectClient, mockUpstream, type MockUpstreamOptions } from "./support/websocket.ts";
import { xaiPicker, type XaiPickerLog } from "./support/xai.ts";
import { Effect } from "effect";
import { codexSessionStore } from "../src/executor/websocket/session.ts";

const created = {
  type: "response.created",
  response: { id: "resp_1", model: "gpt-5.4", status: "in_progress" },
};

const done = (id = "resp_1", output: unknown[] = []) => ({
  type: "response.done",
  response: {
    id,
    status: "completed",
    model: "gpt-5.4",
    output,
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  },
});

const MESSAGE_ITEM = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Hi" }],
};

let config: Config;

beforeAll(async () => {
  config = await loadConfig("requests: {}");
});

const wsCredential = (overrides: Partial<CredentialSnapshot> = {}) =>
  oauthCredential({ attributes: { plan_type: "plus", websockets: "true" }, ...overrides });

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

  const connect = async (headers: Record<string, string> = {}, path = "/v1/responses") =>
    connectClient(await p.call(path, { headers: { upgrade: "websocket", ...headers } }));

  return { ...p, log, mock, connect };
};

describe("Responses WebSocket over an upstream WebSocket (Codex)", () => {
  it("frames response.create for the upstream and forwards events to the client", async () => {
    const s = setup([wsCredential()], {
      onConnection: (connection) => {
        void (async () => {
          await connection.next();
          connection.server.send(JSON.stringify(created));
          connection.server.send(
            JSON.stringify({
              type: "response.output_item.done",
              output_index: 0,
              item: MESSAGE_ITEM,
            }),
          );
          connection.server.send(JSON.stringify(done()));
        })();
      },
    });

    const client = await s.connect({ "x-codex-turn-state": "turn-1" });
    client.send({
      type: "response.create",
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: "hi" }],
    });
    expect((await client.nextJson())["type"]).toBe("response.created");
    expect((await client.nextJson())["type"]).toBe("response.output_item.done");
    const completed = await client.nextJson();
    // response.done is reported as response.completed and the empty output is rebuilt from the item events.
    expect(completed["type"]).toBe("response.completed");
    expect((completed["response"] as { output: unknown[] }).output).toEqual([MESSAGE_ITEM]);

    expect(s.mock.dials).toHaveLength(1);
    expect(s.mock.dials[0]?.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
    const headers = s.mock.dials[0]?.headers ?? {};
    expect(headers["authorization"]).toBe("Bearer access-token-1");
    expect(headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
    expect(headers["chatgpt-account-id"]).toBe("acct_123");
    const frame = JSON.parse(s.mock.connections[0]?.received[0] ?? "{}") as Record<string, unknown>;
    expect(frame).toMatchObject({ type: "response.create", model: "gpt-5.4", stream: true });
    client.close();
  });

  it.each([
    ["a standard client", {}, ["response.created", "response.completed"]],
    [
      "a Codex client (user agent)",
      { "user-agent": "codex_cli_rs/1.0" },
      ["response.created", "response.metadata", "response.completed"],
    ],
    [
      "a Codex client (originator)",
      { originator: "codex_cli_rs" },
      ["response.created", "response.metadata", "response.completed"],
    ],
  ])("forwards response.metadata to %s as expected", async (_name, headers, expected) => {
    // CLIProxyAPI ae65e26d: moderation metadata is private to Codex clients.
    const s = setup([wsCredential()], {
      onConnection: (connection) => {
        void (async () => {
          await connection.next();
          connection.server.send(JSON.stringify(created));
          connection.server.send(
            JSON.stringify({ type: "response.metadata", metadata: { moderation: {} } }),
          );
          connection.server.send(JSON.stringify(done()));
        })();
      },
    });

    const client = await s.connect(headers);
    client.send({
      type: "response.create",
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: "hi" }],
    });
    const types: unknown[] = [];

    for (let i = 0; i < expected.length; i++) types.push((await client.nextJson())["type"]);
    expect(types).toEqual(expected);
    client.close();
  });

  it("rejects a forced hosted image_generation judged by the built handshake headers", async () => {
    // The lite flag comes from a credential `header:` attribute, which only the handshake headers carry.
    const s = setup([
      wsCredential({
        attributes: {
          plan_type: "plus",
          websockets: "true",
          "header:X-OpenAI-Internal-Codex-Responses-Lite": "true",
        },
      }),
    ]);

    const client = await s.connect();
    client.send({
      type: "response.create",
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: "draw" }],
      tools: [{ type: "image_generation" }],
      tool_choice: { type: "image_generation" },
    });

    const message = JSON.stringify(await client.nextJson());

    expect(message).toContain("/v1/images/generations");
    expect(s.mock.dials).toHaveLength(0);
    client.close();
  });

  it("keeps the upstream socket for the session and passes continuations through", async () => {
    const s = setup([wsCredential()], {
      onConnection: (connection) => {
        void (async () => {
          for (const id of ["resp_1", "resp_2"]) {
            await connection.next();
            connection.server.send(JSON.stringify({ type: "response.created", response: { id } }));
            connection.server.send(JSON.stringify(done(id, [MESSAGE_ITEM])));
          }
        })();
      },
    });

    const client = await s.connect();
    client.send({
      type: "response.create",
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: "one" }],
    });
    await client.until("response.completed");
    client.send({
      type: "response.create",
      previous_response_id: "resp_1",
      input: [{ type: "message", role: "user", content: "two" }],
    });
    const second = await client.until("response.completed");
    expect((second["response"] as { id: string }).id).toBe("resp_2");

    expect(s.mock.dials).toHaveLength(1);

    const frames = (s.mock.connections[0]?.received ?? []).map(
      (text) => JSON.parse(text) as Record<string, unknown>,
    );

    expect(frames).toHaveLength(2);
    // The continuation keeps previous_response_id and inherits the model from the pinned turn.
    expect(frames[1]).toMatchObject({
      type: "response.create",
      previous_response_id: "resp_1",
      model: "gpt-5.4",
    });
    expect(frames[1]?.["input"]).toEqual([{ type: "message", role: "user", content: "two" }]);
    // Both turns ran on the same credential and were reported once each.
    expect(s.log.picks.map((pick) => pick.pinnedId)).toEqual([undefined, "codex-oauth-1"]);
    expect(s.log.reports.map((report) => report.result.success)).toEqual([true, true]);
    client.close();
  });

  it("answers generate:false warm-ups locally and merges the follow-up request", async () => {
    const s = setup([wsCredential()], {
      onConnection: (connection) => {
        void (async () => {
          await connection.next();
          connection.server.send(
            JSON.stringify({ type: "response.created", response: { id: "resp_real" } }),
          );
          connection.server.send(JSON.stringify(done("resp_real")));
        })();
      },
    });

    const client = await s.connect();
    client.send({
      type: "response.create",
      model: "gpt-5.4",
      generate: false,
      instructions: "Be brief",
      input: [{ type: "message", role: "user", content: "warm" }],
    });
    const warmCreated = await client.nextJson();
    const warmCompleted = await client.nextJson();
    expect(warmCreated).toMatchObject({ type: "response.created", sequence_number: 0 });
    expect(warmCompleted).toMatchObject({ type: "response.completed", sequence_number: 1 });
    const warmId = (warmCreated["response"] as { id: string }).id;
    expect(warmId).toMatch(/^resp_prewarm_/);
    expect(s.mock.dials).toHaveLength(0);

    client.send({
      type: "response.create",
      previous_response_id: warmId,
      input: [{ type: "message", role: "user", content: "go" }],
    });
    await client.until("response.completed");
    const frame = JSON.parse(s.mock.connections[0]?.received[0] ?? "{}") as Record<string, unknown>;
    expect(frame["previous_response_id"]).toBeUndefined();
    expect(frame["instructions"]).toBe("Be brief");
    expect((frame["input"] as Array<{ content: string }>).map((item) => item.content)).toEqual([
      "warm",
      "go",
    ]);
    client.close();
  });

  it("closes with 'upstream requires HTTP replay' when a continuation lost its upstream socket", async () => {
    const s = setup([wsCredential()], {
      onConnection: (connection) => {
        void (async () => {
          await connection.next();
          connection.server.send(JSON.stringify(done("resp_1")));
        })();
      },
    });

    const client = await s.connect();
    client.send({ type: "response.create", model: "gpt-5.4", input: [] });
    await client.until("response.completed");

    // The socket vanishes without the downstream noticing (no idle-drop notification).
    for (const id of codexSessionStore.ids()) {
      const session = codexSessionStore.peek(id);

      if (session?.socket !== undefined)
        await Effect.runPromise(codexSessionStore.invalidate(session));
    }

    client.send({ type: "response.create", previous_response_id: "resp_1", input: [] });
    const closed = await client.closed;
    expect(closed).toEqual({ code: 1012, reason: "upstream requires HTTP replay" });
    expect(s.mock.dials).toHaveLength(1);
  });

  it("rejects a continuation that references an unknown response", async () => {
    const s = setup([wsCredential()]);
    const client = await s.connect();
    client.send({
      type: "response.create",
      previous_response_id: "resp_x",
      model: "gpt-5.4",
      input: [],
    });
    const error = await client.nextJson();
    expect(error).toMatchObject({ type: "error", status: 409 });
    expect((error["error"] as { code: string }).code).toBe("previous_response_not_found");
    // The socket stays usable: a malformed frame gets a 400.
    client.send({ type: "response.bogus" });
    expect(await client.nextJson()).toMatchObject({ type: "error", status: 400 });
    client.close();
  });

  it("forwards response.interrupt to the running upstream turn", async () => {
    const s = setup([wsCredential()], {
      onConnection: (connection) => {
        void (async () => {
          await connection.next();
          connection.server.send(
            JSON.stringify({ type: "response.created", response: { id: "resp_1" } }),
          );
          const interrupt = JSON.parse(await connection.next()) as Record<string, unknown>;
          connection.server.send(
            JSON.stringify({
              type: "response.incomplete",
              response: {
                id: "resp_1",
                status: "incomplete",
                incomplete_details: { reason: "interrupted" },
                output: [MESSAGE_ITEM],
              },
              echo: interrupt["type"],
            }),
          );
        })();
      },
    });

    const client = await s.connect();
    client.send({ type: "response.create", model: "gpt-5.4", input: [] });
    await client.until("response.created");
    client.send({ type: "response.interrupt", response_id: "resp_1", mode: "abort" });
    const incomplete = await client.until("response.incomplete");
    expect(incomplete["echo"]).toBe("response.interrupt");
    // The control frame reaches the upstream verbatim (no payload rewriting).
    expect(JSON.parse(s.mock.connections[0]?.received[1] ?? "{}")).toEqual({
      type: "response.interrupt",
      response_id: "resp_1",
      mode: "abort",
    });
    client.close();
  });

  it("closes the upstream session when the client goes away mid-turn and reports a lifecycle failure", async () => {
    const s = setup([wsCredential()], {
      onConnection: (connection) => {
        void (async () => {
          await connection.next();
          connection.server.send(
            JSON.stringify({ type: "response.created", response: { id: "resp_1" } }),
          );
        })();
      },
    });

    const client = await s.connect();
    client.send({ type: "response.create", model: "gpt-5.4", input: [] });
    await client.until("response.created");
    client.close();
    await expect.poll(() => s.mock.connections[0]?.closed !== undefined).toBe(true);
    await expect.poll(() => s.log.reports.length).toBe(1);
    expect(s.log.reports[0]?.result.success).toBe(false);
    expect(s.records[0]?.failed).toBe(true);
  });

  it("exposes request-shape and quota upstream errors and closes the socket", async () => {
    const bad = setup([wsCredential()], {
      onConnection: (connection) => {
        void (async () => {
          await connection.next();
          connection.server.send(
            JSON.stringify({
              type: "error",
              status: 400,
              error: { type: "invalid_request_error", message: "bad input" },
            }),
          );
        })();
      },
    });

    const client = await bad.connect();
    client.send({ type: "response.create", model: "gpt-5.4", input: [] });
    const error = await client.nextJson();
    expect(error).toMatchObject({ type: "error", status: 400 });
    expect((error["error"] as { message: string }).message).toBe("bad input");
    await client.closed;

    const quota = setup([wsCredential()], {
      onConnection: (connection) => {
        void (async () => {
          await connection.next();
          connection.server.send(
            JSON.stringify({
              type: "error",
              status: 429,
              error: { type: "usage_limit_reached", message: "limit", resets_in_seconds: 60 },
            }),
          );
        })();
      },
    });

    const quotaClient = await quota.connect();
    quotaClient.send({ type: "response.create", model: "gpt-5.4", input: [] });
    // A terminal quota failure is exposed (CLIProxyAPI b5e6027c): the client sees why, not a reconnect loop.
    expect(await quotaClient.nextJson()).toMatchObject({
      type: "error",
      status: 429,
      error: { type: "usage_limit_reached" },
    });
    const closed = await quotaClient.closed;
    expect(closed.code).toBe(1011);
    expect(quota.log.reports[0]?.result.success).toBe(false);
  });

  it("maps a rejected upgrade through the Codex error classification", async () => {
    const s = setup([wsCredential()], {
      reject: () => ({
        status: 429,
        body: JSON.stringify({
          error: { type: "usage_limit_reached", message: "limit", resets_in_seconds: 30 },
        }),
      }),
    });

    const client = await s.connect();
    client.send({ type: "response.create", model: "gpt-5.4", input: [] });
    await client.closed;
    const report = s.log.reports[0]?.result;
    expect(report?.success).toBe(false);
    expect(report?.httpStatus).toBe(429);
    expect(report?.credentialScoped).toBe(true);
  });

  it("answers a plain GET without an upgrade with 400", async () => {
    const s = setup([wsCredential()]);
    const response = await s.call("/v1/responses");
    expect(response.status).toBe(400);
  });

  it("serves the Codex alias path", async () => {
    const s = setup([wsCredential()], {
      onConnection: (connection) => {
        void (async () => {
          await connection.next();
          connection.server.send(JSON.stringify(done()));
        })();
      },
    });

    const client = await s.connect({}, "/backend-api/codex/responses");
    client.send({ type: "response.create", model: "gpt-5.4", input: [] });
    expect((await client.nextJson())["type"]).toBe("response.completed");
    client.close();
  });
});

describe("Responses WebSocket over HTTP (credential without websockets)", () => {
  const sse = (events: unknown[]) =>
    sseResponse(
      events.map(
        (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
      ),
    );

  it("runs each turn over HTTP and rebuilds the transcript locally", async () => {
    const bodies: Array<Record<string, unknown>> = [];

    const s = setup([oauthCredential()], {}, (call) => {
      bodies.push(JSON.parse(call.body) as Record<string, unknown>);
      const id = `resp_${bodies.length}`;

      return sse([
        { type: "response.created", response: { id, model: "gpt-5.4", status: "in_progress" } },
        { type: "response.output_item.done", output_index: 0, item: MESSAGE_ITEM },
        {
          type: "response.completed",
          response: {
            id,
            status: "completed",
            model: "gpt-5.4",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]);
    });

    const client = await s.connect();
    client.send({
      type: "response.create",
      model: "gpt-5.4",
      instructions: "sys",
      input: [{ type: "message", role: "user", content: "one" }],
    });
    const first = await client.until("response.completed");
    expect((first["response"] as { output: unknown[] }).output).toEqual([MESSAGE_ITEM]);
    client.send({
      type: "response.append",
      input: [{ type: "message", role: "user", content: "two" }],
    });
    await client.until("response.completed");

    expect(s.mock.dials).toHaveLength(0);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");

    const second = bodies[1] as {
      input: Array<Record<string, unknown>>;
      instructions?: string;
      previous_response_id?: string;
    };

    expect(second.previous_response_id).toBeUndefined();
    expect(second.instructions).toBe("sys");
    expect(second.input.map((item) => item["type"])).toEqual(["message", "message", "message"]);
    expect(second.input.map((item) => JSON.stringify(item["content"]))).toEqual([
      '"one"',
      JSON.stringify(MESSAGE_ITEM.content),
      '"two"',
    ]);
    client.close();
  });

  it("answers a failure before the first event with an exposed error and closes", async () => {
    const s = setup(
      [oauthCredential()],
      {},
      () =>
        new Response(JSON.stringify({ error: { message: "bad", type: "invalid_request_error" } }), {
          status: 400,
        }),
    );

    const client = await s.connect();
    client.send({ type: "response.create", model: "gpt-5.4", input: [] });
    expect(await client.nextJson()).toMatchObject({ type: "error", status: 400 });
    await client.closed;
  });
});

describe("payload rules on the WebSocket path", () => {
  it("applies user payload rules to the final business payload; framing only adds the type", async () => {
    const ruled = await loadConfig(`
requests:
  payload:
    override:
      - models: [{ name: "gpt-5.4", protocol: codex }]
        params:
          "metadata.via": "payload-rule"
          "type": "response.append"
    filter:
      - models: [{ name: "gpt-5.4", protocol: codex }]
        params: ["previous_response_id"]
`);

    const mock = mockUpstream({
      onConnection: (connection) => {
        void (async () => {
          for (const id of ["resp_1", "resp_2"]) {
            await connection.next();
            connection.server.send(JSON.stringify(done(id)));
          }
        })();
      },
    });

    const p = makePipeline({
      config: ruled,
      respond: () => sseResponse([]),
      credentialPicker: xaiPicker([wsCredential()]),
      modelProviders: codexModels,
      websocketConnector: mock.layer,
    });

    afterAll(p.dispose);

    const client = connectClient(
      await p.call("/v1/responses", { headers: { upgrade: "websocket" } }),
    );

    client.send({ type: "response.create", model: "gpt-5.4", input: [] });
    await client.until("response.completed");
    client.send({ type: "response.create", previous_response_id: "resp_1", input: [] });
    await client.until("response.completed");

    const frames =
      mock.connections[0]?.received.map((text) => JSON.parse(text) as Record<string, unknown>) ??
      [];

    expect(frames).toHaveLength(2);

    for (const frame of frames) {
      expect(frame["metadata"]).toEqual({ via: "payload-rule" });
      // The rule tried to set `type`; the transport framing is the only thing allowed to run after the rules.
      expect(frame["type"]).toBe("response.create");
      // The filtered field stays filtered: nothing restores it after the rules ran.
      expect("previous_response_id" in frame).toBe(false);
    }

    client.close();
  });
});

describe("stream bootstrap buffering on the upstream WebSocket", () => {
  let buffering: Config;
  beforeAll(async () => {
    buffering = await loadConfig("upstream:\n  codex:\n    stream-bootstrap-buffering: true\n");
  });

  const second = wsCredential({
    id: "codex-oauth-2",
    metadata: { access_token: "access-token-2", account_id: "acct_2" },
  });

  const reply = (
    connection: Parameters<NonNullable<MockUpstreamOptions["onConnection"]>>[0],
    frames: unknown[],
  ) => {
    void (async () => {
      await connection.next();

      for (const frame of frames) connection.server.send(JSON.stringify(frame));
    })();
  };

  const delta = {
    type: "response.output_text.delta",
    item_id: "m",
    output_index: 0,
    content_index: 0,
    delta: "Hi",
  };

  it("fails an overload rejection over to the next credential before the client sees any frame", async () => {
    let connections = 0;

    const s = setup(
      [wsCredential(), second],
      {
        onConnection: (connection) => {
          connections += 1;

          if (connections === 1) {
            reply(connection, [
              created,
              {
                type: "response.failed",
                response: {
                  id: "resp_1",
                  error: { code: "server_is_overloaded", message: "overloaded" },
                },
              },
            ]);
          } else reply(connection, [created, delta, done()]);
        },
      },
      () => sseResponse([]),
      buffering,
    );

    const client = await s.connect();
    client.send({
      type: "response.create",
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: "hi" }],
    });
    const first = await client.nextJson();
    expect(first["type"]).toBe("response.created");
    expect((await client.nextJson())["type"]).toBe("response.output_text.delta");
    expect((await client.nextJson())["type"]).toBe("response.completed");
    expect(s.mock.dials.map((dial) => dial.headers["authorization"])).toEqual([
      "Bearer access-token-1",
      "Bearer access-token-2",
    ]);
    expect(s.log.reports.map((report) => report.result.success)).toEqual([false, true]);
    client.close();
  });

  it("fails an overload after a response.metadata frame over without releasing the stream", async () => {
    let connections = 0;

    // Captured from upstream on 2026-10-21 (CLIProxyAPI 9e79552f): prompt-moderation metadata, then overload.
    const metadata = {
      type: "response.metadata",
      response_id: "resp_1",
      sequence_number: 2,
      metadata: { openai_chatgpt_moderation_metadata: { prompt: { omnimod: {} } } },
    };

    const s = setup(
      [wsCredential(), second],
      {
        onConnection: (connection) => {
          connections += 1;

          if (connections === 1) {
            reply(connection, [
              created,
              metadata,
              {
                type: "response.failed",
                response: {
                  id: "resp_1",
                  error: { code: "server_is_overloaded", message: "overloaded" },
                },
              },
            ]);
          } else reply(connection, [created, delta, done()]);
        },
      },
      () => sseResponse([]),
      buffering,
    );

    const client = await s.connect();
    client.send({
      type: "response.create",
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: "hi" }],
    });
    expect((await client.nextJson())["type"]).toBe("response.created");
    expect((await client.nextJson())["type"]).toBe("response.output_text.delta");
    expect((await client.nextJson())["type"]).toBe("response.completed");
    expect(s.log.reports.map((report) => report.result.success)).toEqual([false, true]);
    client.close();
  });

  it("also fails an upstream error frame over, but only while buffering", async () => {
    let connections = 0;

    const s = setup(
      [wsCredential(), second],
      {
        onConnection: (connection) => {
          connections += 1;

          if (connections === 1) {
            reply(connection, [
              created,
              { type: "error", status: 503, error: { type: "server_error", message: "busy" } },
            ]);
          } else reply(connection, [created, done()]);
        },
      },
      () => sseResponse([]),
      buffering,
    );

    const client = await s.connect();
    client.send({
      type: "response.create",
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: "hi" }],
    });
    expect((await client.until("response.completed"))["type"]).toBe("response.completed");
    expect(s.mock.dials).toHaveLength(2);
    client.close();
  });

  it("passes handshake frames straight through when buffering is off", async () => {
    const s = setup([wsCredential()], {
      onConnection: (connection) => reply(connection, [created, done()]),
    });

    const client = await s.connect();
    client.send({
      type: "response.create",
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: "hi" }],
    });
    expect((await client.nextJson())["type"]).toBe("response.created");
    await client.until("response.completed");
    client.close();
  });
});
