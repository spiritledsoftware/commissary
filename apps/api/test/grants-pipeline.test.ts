// Grants through the production API Worker (`exports.default.fetch`): the real model resolution, registry views and
// ControlPlane picker. A request with no member behind it (no Access in the test env) is served by the grants for
// everyone only, so restricting those is what the requests here see. Only the Claude upstream is mocked.
import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { claudeFile, FULL_ACCESS, unknownModelBody } from "@commissary/models/testing";
import { makeWebHandler } from "../src/http/app.ts";
import { requestContext } from "../src/worker-env.ts";

/** A Sonnet and an Opus model of the catalog, found in the list before anything is restricted. */
let SONNET = "";

let OPUS = "";

const realFetch = globalThis.fetch;

const upstreamModels: string[] = [];

const stub = () => env.CONTROL_PLANE.getByName("global");

/** The Claude executor always asks upstream for a stream. */
const stream = (model: string): Response => {
  const events: ReadonlyArray<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model,
        content: [],
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];

  return new Response(
    events
      .map((event) => `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
};

/** Where requests go: the Worker's default export, or the handler of a fresh isolate once {@link restrictTo} ran. */
let send = async (request: Request): Promise<Response> => await exports.default.fetch(request);

/** Disposes of the handler {@link freshIsolate} made. */
let disposeFresh = async (): Promise<void> => {};

/** A Web handler of the API Worker of its own, as a new isolate builds it: with no registry snapshot cached yet. */
const freshIsolate = () => {
  const { handler, dispose } = makeWebHandler();

  disposeFresh = dispose;
  send = async (request) => await handler(request, requestContext(env, createExecutionContext()));
};

const chat = async (model: string) =>
  await send(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    }),
  );

const listed = async (): Promise<ReadonlyArray<string>> => {
  const response = await send(new Request("http://localhost/v1/models"));
  expect(response.status).toBe(200);
  // SAFETY: the OpenAI model list shape.
  const body = (await response.json()) as { data: ReadonlyArray<{ id: string }> };

  return body.data.map((model) => model.id);
};

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);

    if (!request.url.includes("anthropic.com")) return await realFetch(input, init);
    // SAFETY: the Claude executor posts a JSON object.
    const body = (await request.json()) as { model?: string };
    upstreamModels.push(body.model ?? "");

    return stream(body.model ?? "");
  };

  await stub().models().importAuthFile("sub-a.json", claudeFile(), {}, FULL_ACCESS);

  const ids = await listed();
  SONNET = ids.find((id) => id.startsWith("claude-sonnet-")) ?? "";
  OPUS = ids.find((id) => id.startsWith("claude-opus-")) ?? "";
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await disposeFresh();
});

/** Replaces the default grant with `everyone, all shared credentials, models`. */
const restrictTo = async (models: ReadonlyArray<string>) => {
  for (const grant of (await stub().models().grantEntries()).grants) {
    await stub()
      .models()
      .writeGrant({ id: grant.id, revision: grant.revision, value: null }, "test");
  }

  const written = await stub()
    .models()
    .writeGrant(
      {
        revision: 0,
        value: { subject: { kind: "everyone" }, scope: { kind: "all" }, models: [...models] },
      },
      "test",
    );

  expect(written.ok).toBe(true);
  // An isolate's registry snapshot of the org is cached for 5 s (Models' `SNAPSHOT_TTL_MS`), and the management routes
  // that rebuild it at once are the app Worker's: the requests go to a fresh isolate's handler, which reads the grants
  // just written, as every isolate does within those 5 s.
  freshIsolate();
};

describe("grants through the production request path", () => {
  it("serves every model of a credential under the default grant", async () => {
    const response = await chat(OPUS);
    expect(response.status).toBe(200);
    await response.text();
    expect(upstreamModels).toContain(OPUS);
  });

  it("serves the granted model and answers an ungranted one like an unknown model", async () => {
    expect([SONNET, OPUS]).not.toContain("");
    await restrictTo([SONNET]);
    upstreamModels.length = 0;

    const granted = await chat(SONNET);

    expect(granted.status).toBe(200);
    await granted.text();
    expect(upstreamModels).toEqual([SONNET]);

    const refused = await chat(OPUS);
    const unknown = await chat("claude-no-such-model");

    expect(refused.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(await refused.text()).toBe(unknownModelBody(OPUS));
    expect(await unknown.text()).toBe(unknownModelBody("claude-no-such-model"));
    expect(upstreamModels).toEqual([SONNET]);
  });

  it("answers an ungranted model with a thinking suffix by the name the client sent", async () => {
    const refused = await chat(`${OPUS}(high)`);

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(unknownModelBody(`${OPUS}(high)`));
  });

  it("lists only the models the caller's grants reach", async () => {
    const ids = await listed();

    expect(ids).toContain(SONNET);
    expect(ids).not.toContain(OPUS);
  });
});
