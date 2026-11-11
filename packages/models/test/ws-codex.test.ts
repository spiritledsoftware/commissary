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
import {
  connectClient,
  mockUpstream,
  type MockUpstreamOptions,
  type UpstreamConnection,
  errorOf,
  eventually,
  scripted,
  settled,
} from "./support/websocket.ts";
import { xaiPicker, type XaiPickerLog } from "./support/xai.ts";
import { Effect, Layer } from "effect";
import { codexSessionStore } from "../src/executor/websocket/session.ts";
import { unsealCompaction } from "../src/executor/helps/compaction.ts";
import { ModelProviders } from "../src/handlers/model-providers.ts";
import { jsonResponse } from "./support/pipeline.ts";
import { providerKeyCredential } from "./support/codex.ts";
import { get, type Json } from "@commissary/json";

const created = {
  type: "response.created",
  response: { id: "resp_1", model: "gpt-5.4", status: "in_progress" },
};

const done = (id = "resp_1", output: Json[] = []) => ({
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
  modelProviders: typeof codexModels = codexModels,
) => {
  const log: XaiPickerLog = { picks: [], reports: [] };
  const mock = mockUpstream(upstream);

  const p = makePipeline({
    config: configOverride,
    respond,
    credentialPicker: xaiPicker(credentials, log),
    modelProviders,
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

describe("local compaction over the Responses WebSocket (Kimi, a credential without websockets)", () => {
  const kimi: CredentialSnapshot = {
    id: "kimi-1",
    provider: "kimi",
    kind: "oauth",
    label: "kimi",
    attributes: { base_url: "https://api.kimi.com/coding", domain: "kimi.com" },
    metadata: { access_token: "kimi-token", device_id: "dev-1" },
  };

  const kimiModels = Layer.succeed(
    ModelProviders,
    ModelProviders.of({
      providersFor: () => Effect.succeed(["kimi"]),
      firstAvailableModel: Effect.succeed("kimi-k2.8"),
    }),
  );

  const reply = (id: string) => ({
    id,
    object: "response",
    status: "completed",
    model: "kimi-for-coding",
    output: [{ ...MESSAGE_ITEM, id: `msg_${id}`, status: "completed" }],
    usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
  });

  /** A normal turn streams; the summary of a compaction is one non-stream request. */
  const respond: UpstreamResponder = (call) => {
    const body = JSON.parse(call.body) as { stream?: boolean };

    if (body.stream !== true)
      return jsonResponse({
        ...reply("resp_summary"),
        output: [
          {
            id: "msg_s",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "the summary" }],
          },
        ],
      });
    const id = `resp_${call.body.length}`;

    return sseResponse([
      `data: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: reply(id) })}\n\n`,
    ]);
  };

  const userMessage = (text: string) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });

  const assistantMessage = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "OK" }],
  };

  const trigger = {
    type: "response.create",
    model: "kimi-k2.8",
    input: [userMessage("secret history"), assistantMessage, { type: "compaction_trigger" }],
  };

  const compact = async (s: ReturnType<typeof setup>) => {
    const client = await s.connect();
    client.send({ type: "response.create", model: "kimi-k2.8", input: [userMessage("hello")] });
    await client.until("response.completed");
    client.send(trigger);
    const completed = await client.until("response.completed");

    return { client, completed };
  };

  it("answers a compaction_trigger locally and continues from the expanded summary", async () => {
    const s = setup([kimi], {}, respond, config, kimiModels);
    const { client, completed } = await compact(s);

    const output = (completed["response"] as { id: string; output: Array<Record<string, string>> })
      .output;

    expect(output[0]?.["type"]).toBe("compaction");
    expect(await unsealCompaction(output[0]?.["encrypted_content"] ?? "")).toBe("the summary");
    // One turn, then the summary request: no upstream socket, no compaction_trigger upstream.
    expect(s.mock.dials).toHaveLength(0);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]?.body).not.toContain("compaction_trigger");

    const id = (completed["response"] as { id: string }).id;
    expect(id).toMatch(/^resp_ag_compact_/);
    client.send({
      type: "response.create",
      model: "kimi-k2.8",
      previous_response_id: id,
      input: [userMessage("next")],
    });
    await client.until("response.completed");
    expect(s.calls).toHaveLength(3);

    const input = (
      JSON.parse(s.calls[2]?.body ?? "{}") as { input: Array<Record<string, unknown>> }
    ).input;

    expect(input).toHaveLength(2);
    expect(JSON.stringify(input[0])).toContain(
      "Context summary from previous turns:\\nthe summary",
    );
    expect(input[1]).toMatchObject({ role: "user" });
    expect(s.calls[2]?.body).not.toContain("secret history");
    expect(s.calls[2]?.body).not.toContain("previous_response_id");
    client.close();
  });

  it("answers a synthetic previous_response_id that is not the last response with the 409 frame and keeps the socket", async () => {
    const s = setup([kimi], {}, respond, config, kimiModels);
    const { client } = await compact(s);

    const calls = s.calls.length;

    client.send({
      type: "response.create",
      model: "kimi-k2.8",
      previous_response_id: "resp_ag_compact_000",
      input: [userMessage("next")],
    });

    const frame = await client.until("error");
    expect(frame["status"]).toBe(409);
    expect(errorOf(frame).code).toBe("previous_response_not_found");
    expect(s.calls).toHaveLength(calls);

    // The socket is still open: the right id continues.
    client.send({ type: "response.create", model: "kimi-k2.8", input: [userMessage("again")] });
    await client.until("response.completed");
    client.close();
  });
});

describe("local compaction on an is-compat Codex credential with websockets", () => {
  const compatConfigYaml = `
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

  const message = (text: string) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });

  const assistant = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "OK" }],
  };

  const summarySse = () =>
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
        response: {
          id: "resp_s",
          status: "completed",
          model: "gpt-5.4",
          output: [],
          usage: { input_tokens: 21, output_tokens: 6, total_tokens: 27 },
        },
      })}\n\n`,
    ]);

  /** Each frame of an upstream socket is answered with the next response id. */
  const upstreamReplies = (ids: ReadonlyArray<string>) =>
    scripted((_frame, index, send) => {
      const id = ids[index] ?? `resp_extra_${index}`;
      send({ type: "response.created", response: { id, status: "in_progress" } });
      send(done(id, [MESSAGE_ITEM]));
    });

  const setupCompat = async (
    onConnection: (connection: UpstreamConnection) => void,
    respond: UpstreamResponder = () => summarySse(),
    credential: CredentialSnapshot = compatCredential(),
  ) => setup([credential], { onConnection }, respond, await loadConfig(compatConfigYaml));

  const create = (input: Json[], extra: Record<string, Json> = {}): Json => ({
    type: "response.create",
    model: "gpt-5.4",
    input,
    ...extra,
  });

  const upstreamFrames = (s: ReturnType<typeof setup>, connection: number) =>
    (s.mock.connections[connection]?.received ?? []).map(
      (text) => JSON.parse(text) as Record<string, Json>,
    );

  it("compacts over HTTP, invalidates the upstream socket and continues from the summary on a new one", async () => {
    const s = await setupCompat(upstreamReplies(["resp_1", "resp_3", "resp_4"]));
    const client = await s.connect();
    // (1) a normal request runs on the upstream socket.
    client.send(create([message("secret history")]));
    await client.until("response.completed");
    expect(s.mock.dials).toHaveLength(1);

    // (2) the trigger is compacted over HTTP and the upstream socket is invalidated.
    client.send(create([message("secret history"), assistant, { type: "compaction_trigger" }]));
    const compacted = await client.until("response.completed");
    const response = compacted["response"] as { id: string; output: Array<Record<string, string>> };
    expect(response.id).toMatch(/^resp_ag_compact_/);
    expect(await unsealCompaction(response.output[0]?.["encrypted_content"] ?? "")).toBe(
      "the summary",
    );
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe("https://codex.example.test/v1/responses");
    expect(upstreamFrames(s, 0)).toHaveLength(1);
    await eventually(() => s.mock.connections[0]?.closed !== undefined);

    // (3) the create with the synthetic id dials a new socket: the summary, no earlier text, no previous_response_id.
    client.send(create([message("next")], { previous_response_id: response.id }));
    await client.until("response.completed");
    expect(s.mock.dials).toHaveLength(2);
    const [second] = upstreamFrames(s, 1);
    expect(second).not.toHaveProperty("previous_response_id");
    expect(get(second, "input.0.content.0.text")).toBe(
      "Context summary from previous turns:\nthe summary",
    );
    expect(JSON.stringify(second)).not.toContain("secret history");
    expect(JSON.stringify(second)).not.toContain("cpa-ag-compact-v1:");

    // (4) a continuation passes through on the new socket.
    client.send(create([message("more")], { previous_response_id: "resp_3" }));
    await client.until("response.completed");
    expect(s.mock.dials).toHaveLength(2);
    expect(upstreamFrames(s, 1)[1]).toMatchObject({ previous_response_id: "resp_3" });
    client.close();
  });

  it("answers a compaction source with previous_response_id with the non-closing 409 frame", async () => {
    const s = await setupCompat(upstreamReplies(["resp_1"]));
    const client = await s.connect();
    client.send(create([message("hi")]));
    await client.until("response.completed");

    client.send(
      create([message("hi"), { type: "compaction_trigger" }], {
        previous_response_id: "resp_1",
        event_id: "evt_7",
      }),
    );

    const frame = await client.until("error");
    expect(frame["status"]).toBe(409);
    expect(errorOf(frame)).toMatchObject({
      code: "previous_response_not_found",
      event_id: "evt_7",
    });
    expect(s.calls).toHaveLength(0);

    // The socket is still open and still pinned to its upstream socket.
    client.send(create([message("again")], { previous_response_id: "resp_1" }));
    await client.until("response.completed");
    client.close();
  });

  it("answers a wrong synthetic previous_response_id with the planner's 409 and keeps the socket", async () => {
    const s = await setupCompat(upstreamReplies(["resp_1", "resp_3"]));
    const client = await s.connect();
    client.send(create([message("hi")]));
    await client.until("response.completed");
    client.send(create([message("hi"), assistant, { type: "compaction_trigger" }]));
    await client.until("response.completed");

    client.send(create([message("next")], { previous_response_id: "resp_ag_compact_000" }));
    const frame = await client.until("error");
    expect(frame["status"]).toBe(409);
    expect(errorOf(frame).code).toBe("previous_response_not_found");

    client.send(create([message("again")]));
    await client.until("response.completed");
    client.close();
  });

  it("resolves a response.interrupt during a local compaction locally, never upstream", async () => {
    let release: () => void = () => undefined;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const s = await setupCompat(upstreamReplies(["resp_1"]), async () => {
      await held;

      return summarySse();
    });

    const client = await s.connect();
    client.send(create([message("hi")]));
    await client.until("response.completed");

    client.send(create([message("hi"), assistant, { type: "compaction_trigger" }]));
    await eventually(() => s.calls.length === 1);
    // Forwarded upstream this would be answered "no active upstream websocket" (nothing runs on the socket).
    client.send({ type: "response.interrupt", response_id: "resp_pending" });
    // The reader has handled the interrupt once this returns; the frames it wrote itself are in between.
    expect(await settled(client)).toEqual([]);
    release();
    const types: unknown[] = [];

    while (!types.includes("response.completed") && !types.includes("response.incomplete"))
      types.push((await client.nextJson())["type"]);

    expect(types).not.toContain("error");
    expect(upstreamFrames(s, 0)).toHaveLength(1);
    client.close();
  });

  it("passes a compaction_trigger of a native Codex credential straight through", async () => {
    const s = setup([wsCredential()], { onConnection: upstreamReplies(["resp_1", "resp_2"]) });
    const client = await s.connect();
    client.send(create([message("hi")]));
    await client.until("response.completed");
    client.send(create([message("hi"), assistant, { type: "compaction_trigger" }]));
    await client.until("response.completed");
    expect(s.calls).toHaveLength(0);
    expect(JSON.stringify(upstreamFrames(s, 0)[1])).toContain("compaction_trigger");
    client.close();
  });
});
