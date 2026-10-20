// Agent runs (#227, ADR 0040) end to end: the management routes of the app Worker start, steer, wait on and cancel runs;
// each run is the API Worker's `AgentRun` object (test/worker.ts exports it with the run gateway, as the API Worker
// does), whose pi-durable harness reaches models through the client API and tools through the MCP endpoint, as the
// run's principal, over the gateway. Only the upstreams are fakes: an OpenAI-compatible model upstream and an MCP
// server, both behind the routing `fetch` of `serveFakeMcpServers`.
//
// This file stays with the app Worker though it runs the API Worker's code too (AGENTS.md, docs/DEVELOPMENT.md
// "Tests"): a run crosses both Workers, started by the app Worker's routes and served by the API Worker's gateway, so
// the app's test Worker exports the API Worker's `AgentRun` and `AgentRunGateway` (test/worker.ts).
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RunGateway } from "@commissary/agents/api";
import { agentBody } from "@commissary/agents/testing";
import type { CreateAgent } from "@commissary/contract/agents";
import type { OrgId } from "@commissary/core";
import type { Json } from "@commissary/json";
import { resetUsageDb } from "@commissary/models/testing";
import { fakeMcpServer, serveFakeMcpServers, serveOrigin } from "@commissary/tools/testing";
import { ADMIN, jsonInit, makeHarness, token } from "./support/management.ts";

serveFakeMcpServers();

/**
 * A Platform registry of this file's own, reached afresh on every call: a test kills every object
 * (`abortAllDurableObjects`), after which a stub held from before would fail.
 */
const PLATFORM_NAME = `platform-${crypto.randomUUID()}`;

const registry = () => env.PLATFORM.getByName(PLATFORM_NAME);

// SAFETY: only `getByName` is read from the binding (`platformOf`), and it answers with a real Platform stub.
const PLATFORM = { getByName: () => registry() } as unknown as Env["PLATFORM"];

const harness = makeHarness(undefined, { PLATFORM });

beforeAll(async () => {
  await resetUsageDb();
});

afterAll(harness.dispose);

/** A turn runs a harness in workerd, model and tool calls included. */
const RUN_TIMEOUT = 90_000;

interface Person {
  readonly id: string;
  readonly auth: string;
}

interface Org {
  readonly slug: string;
  readonly id: OrgId;
  readonly admin: Person;
  readonly alice: Person;
  readonly bob: Person;
}

const send = async (
  org: Pick<Org, "slug">,
  path: string,
  who: Person | string,
  method = "GET",
  body?: CreateAgent | Json,
  revision?: number,
): Promise<{ status: number; body: unknown }> =>
  await harness.json(`/v9/management/orgs/${org.slug}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(revision === undefined ? {} : { "if-match": String(revision) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    auth: typeof who === "string" ? who : who.auth,
  });

const ok = <T>(reply: { status: number; body: unknown }, status = 200): T => {
  expect(reply.status, JSON.stringify(reply.body)).toBe(status);

  // SAFETY: a test's own reading of an answer whose shape the contract tests check.
  return reply.body as T;
};

interface Turn {
  readonly id: string;
  readonly status: string;
  readonly answer?: string;
  readonly error?: string;
}

interface Run {
  readonly id: string;
  readonly state: string;
  readonly starter?: { readonly kind: string; readonly id: string };
}

/** A deferred answer the fake upstream holds a request on. */
const deferred = () => {
  let release: () => void = () => undefined;

  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
};

/** The model the fake upstream serves, as the org's clients name it. */
const MODEL = "agent-model";

/** Another model the org serves, outside every agent's definition. */
const OTHER_MODEL = "other-model";

interface ChatRequest {
  readonly model?: string;
  readonly stream?: boolean;
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>;
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string } }>;
}

type Reply = { readonly text: string } | { readonly tool: string; readonly args: Json };

const CREATED = 1_700_000_000;

const sse = (chunks: ReadonlyArray<Json>): Response =>
  new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

const USAGE = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };

/** An OpenAI-compatible answer: text or one tool call, streamed or not as asked. */
const answer = (request: ChatRequest, reply: Reply): Response => {
  const message =
    "text" in reply
      ? { role: "assistant", content: reply.text }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: `call_${crypto.randomUUID().slice(0, 8)}`,
              type: "function",
              function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
            },
          ],
        };

  const finish = "text" in reply ? "stop" : "tool_calls";
  const base = { id: "chatcmpl-1", created: CREATED, model: request.model ?? "" };

  if (request.stream !== true)
    return Response.json({
      ...base,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: USAGE,
    });

  return sse([
    {
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: message, finish_reason: null }],
    },
    {
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: USAGE,
    },
  ]);
};

/**
 * A fake OpenAI-compatible upstream at an origin of its own: `script` decides each answer from the request (the
 * model's turn so far). A test holds a request by its index (`holdAt`) and learns when requests arrived (`arrived`),
 * so it acts while a turn waits on its model. The requests come in the API Worker's invocations, whose promises the
 * test cannot resolve its own from (workerd keeps them per request), so `arrived` checks with `vi.waitFor`.
 */
const fakeUpstream = (script: (request: ChatRequest, index: number) => Reply) => {
  const origin = `https://llm-${crypto.randomUUID().slice(0, 8)}.example.com`;
  const requests: ChatRequest[] = [];
  const holds = new Map<number, Promise<void>>();

  serveOrigin(origin, async (request) => {
    // SAFETY: the client API sends the upstream an OpenAI chat completion request.
    const body = (await request.json()) as ChatRequest;
    const index = requests.length;

    requests.push(body);
    await holds.get(index);

    return answer(body, script(body, index));
  });

  return {
    origin,
    requests,
    /** Holds the request at `index` (the first is 0) until `until` settles. */
    holdAt: (index: number, until: Promise<void>) => void holds.set(index, until),
    /** Settles once `count` requests arrived. */
    arrived: async (count: number) =>
      await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(count), {
        timeout: 30_000,
      }),
  };
};

/** The first tool the model was offered, if any. */
const firstTool = (request: ChatRequest): string | undefined => request.tools?.[0]?.function.name;

/** Whether the request already carries a tool's result: the model's second step. */
const hasToolResult = (request: ChatRequest): boolean =>
  request.messages?.some((message) => message.role === "tool") === true;

/** Calls the first tool once, then answers with `final`. */
const toolThenAnswer = (final: string) => (request: ChatRequest) => {
  const tool = firstTool(request);

  return tool === undefined || hasToolResult(request)
    ? { text: final }
    : { tool, args: { query: "weather" } };
};

/**
 * An org with an org admin and two plain members, private agents on, and the fake upstream's models on a shared
 * provider key: {@link MODEL} and {@link OTHER_MODEL}.
 */
const newOrg = async (upstream: { readonly origin: string }): Promise<Org> => {
  const slug = `runs-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  expect(
    (
      await harness.json(
        "/v9/management/orgs",
        jsonInit("POST", { slug, name: slug, private_agents: true }),
      )
    ).status,
  ).toBe(201);

  const org = { slug };

  const person = async (name: string, role: string): Promise<Person> => {
    const email = `${name}-${slug}@example.com`;

    const added = ok<{ id: string }>(
      await send(org, "/members", platform, "POST", { email, role }),
      201,
    );

    return { id: added.id, auth: await token(email) };
  };

  const admin = await person("admin", "admin");

  ok(
    await send(org, "/provider-keys/groups", admin, "PUT", {
      family: "openai-compatibility",
      revision: 0,
      group: {
        name: "fake",
        "base-url": `${upstream.origin}/v1`,
        keys: [{ "api-key": "sk-fake-0001" }],
        models: [
          { name: "upstream-model", alias: MODEL },
          { name: "upstream-other", alias: OTHER_MODEL },
        ],
      },
    }),
  );

  const found = await registry().getOrgBySlug(slug);

  if (found === undefined) throw new Error("the org is not registered");

  return {
    slug,
    id: found.id,
    admin,
    alice: await person("alice", "member"),
    bob: await person("bob", "member"),
  };
};

/** A fake MCP server with one tool, added as an org toolkit whose shared credential `granted` may use. */
const toolkit = async (org: Org, granted: Json) => {
  const server = fakeMcpServer(`https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`, {
    tools: [
      {
        name: "lookup",
        description: "Looks something up",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
  });

  const added = ok<{ id: string; revision: number }>(
    await send(org, "/toolkits", org.admin, "POST", {
      source: server.url,
      name: "lookup",
      private: false,
      accepts: "shared",
      credential: { kind: "none", subject: granted },
    }),
    201,
  );

  return {
    server,
    id: added.id,
    revision: added.revision,
    calls: () => server.requests.filter((r) => r.rpc === "tools/call"),
  };
};

const allTools = (toolkitId: string) => [{ toolkit: toolkitId, tools: { kind: "all" as const } }];

const createAgent = async (org: Org, who: Person, body: CreateAgent) =>
  ok<{ id: string }>(await send(org, "/agents", who, "POST", body), 201);

const start = async (org: Org, who: Person, agent: string, input: string, key?: string) =>
  ok<{ run: Run; turn: Turn }>(
    await send(org, `/agents/${agent}/runs`, who, "POST", {
      input,
      ...(key === undefined ? {} : { idempotency_key: key }),
    }),
    201,
  );

const waitFor = async (org: Org, who: Person, run: string, turn?: string) =>
  ok<{ finished: boolean; state: string; turn: Turn }>(
    await send(org, `/agent-runs/${run}/wait`, who, "POST", {
      timeout_ms: 60_000,
      ...(turn === undefined ? {} : { turn }),
    }),
  );

interface RecordRow {
  readonly area: string;
  readonly principal_id: string;
  readonly member_id: string | null;
  readonly agent_id: string | null;
  readonly run_id: string | null;
  readonly starter: string | null;
}

/**
 * The usage records of `run`, once `count` of them are written: off the response path, in the API Worker's
 * invocations, which the test has no handle to wait on (`vi.waitFor`, as other tests of off-path writes do).
 */
const recordsOf = async (run: string, count: number): Promise<ReadonlyArray<RecordRow>> => {
  const read = async () =>
    (
      await env.USAGE.prepare(
        `SELECT area, principal_id, member_id, agent_id, run_id, starter FROM usage_records
         WHERE run_id = ? ORDER BY area, requested_at`,
      )
        .bind(run)
        .all<RecordRow>()
    ).results;

  await vi.waitFor(async () => expect((await read()).length).toBeGreaterThanOrEqual(count), {
    timeout: 15_000,
  });

  return await read();
};

/** The API Worker's run gateway, as the run's object reaches it (this test Worker exports it, test/worker.ts). */
const gateway = (): RunGateway =>
  // SAFETY: test/worker.ts exports `AgentRunGateway`, so `exports` holds its loopback binding; `exports` is typed after
  // the app Worker's own module, which does not.
  (exports as unknown as { AgentRunGateway: RunGateway }).AgentRunGateway;

const chat = (model: string) =>
  new Request("https://client-api.agent-run.invalid/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });

describe("a private agent's run", () => {
  it(
    "calls a model through the client API and a tool through the MCP endpoint, as its member, and answers through wait",
    async () => {
      const upstream = fakeUpstream(toolThenAnswer("It is sunny."));
      const org = await newOrg(upstream);
      const tools = await toolkit(org, { kind: "everyone" });

      const agent = await createAgent(
        org,
        org.alice,
        agentBody("weather", MODEL, { tool_scope: allTools(tools.id) }),
      );

      const started = await start(org, org.alice, agent.id, "What is the weather?");

      expect(started.run).toMatchObject({
        agent: { id: agent.id },
        trigger: "chat",
        starter: { kind: "member", id: org.alice.id },
      });
      expect(started.turn).toMatchObject({ status: "running", input: "What is the weather?" });

      const waited = await waitFor(org, org.alice, started.run.id);

      expect(waited).toMatchObject({
        finished: true,
        state: "idle",
        turn: { id: started.turn.id, status: "done", answer: "It is sunny." },
      });
      expect(tools.calls()).toHaveLength(1);
      expect(upstream.requests.map((request) => request.model)).toEqual([
        "upstream-model",
        "upstream-model",
      ]);

      // The run's records: its principal, acting as alice, naming the agent, the run and its starter.
      const records = await recordsOf(started.run.id, 3);

      expect(records).toEqual([
        ...["models", "models"].map((area) => ({
          area,
          principal_id: `run:${started.run.id}`,
          member_id: org.alice.id,
          agent_id: agent.id,
          run_id: started.run.id,
          starter: `member:${org.alice.id}`,
        })),
        {
          area: "tools",
          principal_id: `run:${started.run.id}`,
          member_id: org.alice.id,
          agent_id: agent.id,
          run_id: started.run.id,
          starter: `member:${org.alice.id}`,
        },
      ]);

      // Its starter sees it, with its transcript; anyone else gets a 404, as for an unknown run.
      const shown = ok<{
        state: string;
        turns: ReadonlyArray<Turn>;
        transcript: ReadonlyArray<{ role: string }>;
      }>(await send(org, `/agent-runs/${started.run.id}`, org.alice));

      expect(shown.state).toBe("idle");
      expect(shown.turns.map((turn) => turn.status)).toEqual(["done"]);
      expect(shown.transcript.map((entry) => entry.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ]);

      expect((await send(org, `/agent-runs/${started.run.id}`, org.bob)).status).toBe(404);
      expect((await send(org, `/agent-runs/${started.run.id}`, org.admin)).status).toBe(404);
      expect(
        ok<{ runs: ReadonlyArray<Run> }>(await send(org, "/agent-runs", org.alice)).runs.map(
          (run) => run.id,
        ),
      ).toEqual([started.run.id]);
      expect(
        ok<{ runs: ReadonlyArray<Run> }>(await send(org, "/agent-runs", org.bob)).runs,
      ).toEqual([]);
    },
    RUN_TIMEOUT,
  );

  it(
    "takes a message during a turn as steering, and a message to an idle run as a new turn",
    async () => {
      const upstream = fakeUpstream((request) => ({
        text: `seen ${request.messages?.filter((message) => message.role === "user").length ?? 0}`,
      }));

      const org = await newOrg(upstream);
      const agent = await createAgent(org, org.alice, agentBody("chatty", MODEL));
      const held = deferred();

      upstream.holdAt(0, held.promise);
      const started = await start(org, org.alice, agent.id, "first");

      await upstream.arrived(1);

      const steering = ok<{ turn: Turn; delivery: string }>(
        await send(org, `/agent-runs/${started.run.id}/messages`, org.alice, "POST", {
          message: "also this",
        }),
      );

      expect(steering).toMatchObject({ delivery: "steering", turn: { id: started.turn.id } });

      held.release();

      const first = await waitFor(org, org.alice, started.run.id, started.turn.id);

      expect(first.turn).toMatchObject({ status: "done", answer: "seen 2" });

      const next = ok<{ turn: Turn; delivery: string }>(
        await send(org, `/agent-runs/${started.run.id}/messages`, org.alice, "POST", {
          message: "and now?",
        }),
      );

      expect(next.delivery).toBe("turn");
      expect(next.turn.id).not.toBe(started.turn.id);
      expect((await waitFor(org, org.alice, started.run.id, next.turn.id)).turn).toMatchObject({
        status: "done",
        answer: "seen 3",
      });
    },
    RUN_TIMEOUT,
  );

  it(
    "is cancelled turn by turn: the run takes a new message afterwards",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "answered" }));
      const org = await newOrg(upstream);
      const agent = await createAgent(org, org.alice, agentBody("slow", MODEL));
      const held = deferred();

      upstream.holdAt(0, held.promise);
      const started = await start(org, org.alice, agent.id, "take your time");

      await upstream.arrived(1);

      const cancelled = ok<{ run: Run; cancelled: boolean }>(
        await send(org, `/agent-runs/${started.run.id}/cancel`, org.alice, "POST"),
      );

      expect(cancelled).toMatchObject({ cancelled: true, run: { state: "idle" } });
      held.release();

      const after = await waitFor(org, org.alice, started.run.id, started.turn.id);

      expect(after.turn.status).toBe("cancelled");

      const next = ok<{ turn: Turn; delivery: string }>(
        await send(org, `/agent-runs/${started.run.id}/messages`, org.alice, "POST", {
          message: "now answer",
        }),
      );

      expect(next.delivery).toBe("turn");
      expect((await waitFor(org, org.alice, started.run.id, next.turn.id)).turn).toMatchObject({
        status: "done",
        answer: "answered",
      });
    },
    RUN_TIMEOUT,
  );

  it(
    "resumes after its object is killed mid-turn, without making a finished tool call again",
    async () => {
      const upstream = fakeUpstream(toolThenAnswer("done after resume"));
      const org = await newOrg(upstream);
      const tools = await toolkit(org, { kind: "everyone" });

      const agent = await createAgent(
        org,
        org.alice,
        agentBody("durable", MODEL, { tool_scope: allTools(tools.id) }),
      );

      const held = deferred();

      // The model's second step (after the tool's result) waits: the object is killed there.
      upstream.holdAt(1, held.promise);
      const started = await start(org, org.alice, agent.id, "look it up");

      await upstream.arrived(2);
      expect(tools.calls()).toHaveLength(1);

      await abortAllDurableObjects();
      held.release();

      // The heartbeat wakes the object, which reopens its harness and resumes the turn.
      await runDurableObjectAlarm(env.AGENT_RUN.getByName(`${org.id}:${started.run.id}`));

      const waited = await waitFor(org, org.alice, started.run.id, started.turn.id);

      expect(waited.turn).toMatchObject({ status: "done", answer: "done after resume" });
      expect(tools.calls()).toHaveLength(1);
    },
    RUN_TIMEOUT,
  );

  it(
    "is started once for the same idempotency key",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "once" }));
      const org = await newOrg(upstream);
      const agent = await createAgent(org, org.alice, agentBody("once", MODEL));

      const first = await start(org, org.alice, agent.id, "hello", "delivery-1");
      const again = await start(org, org.alice, agent.id, "hello", "delivery-1");

      expect(again.run.id).toBe(first.run.id);
      expect(again.turn.id).toBe(first.turn.id);
      expect(
        ok<{ runs: ReadonlyArray<Run> }>(await send(org, "/agent-runs", org.alice)).runs,
      ).toHaveLength(1);

      await waitFor(org, org.alice, first.run.id);
      expect(upstream.requests).toHaveLength(1);
    },
    RUN_TIMEOUT,
  );
});

describe("a shared agent's run", () => {
  it(
    "acts as the agent: its definition's reach, not its starter's, and no other model",
    async () => {
      const upstream = fakeUpstream(toolThenAnswer("shared answer"));
      const org = await newOrg(upstream);

      // Only the org admin reaches the shared models and the toolkit's shared credential: alice reaches neither.
      const grants = ok<{ grants: ReadonlyArray<{ id: string; revision: number }> }>(
        await send(org, "/grants", org.admin),
      );

      for (const grant of grants.grants)
        expect(
          (
            await harness.json(`/v9/management/orgs/${org.slug}/grants/${grant.id}`, {
              method: "DELETE",
              headers: { "if-match": String(grant.revision) },
              auth: org.admin.auth,
            })
          ).status,
        ).toBe(200);

      ok(
        await send(org, "/grants", org.admin, "POST", {
          subject: { kind: "member", id: org.admin.id },
          scope: { kind: "all" },
          models: ["*"],
        }),
      );

      const tools = await toolkit(org, { kind: "member", id: org.admin.id });

      const agent = await createAgent(
        org,
        org.admin,
        agentBody("support", MODEL, {
          tool_scope: allTools(tools.id),
          subject: { kind: "member", id: org.alice.id },
        }),
      );

      const started = await start(org, org.alice, agent.id, "help me");
      const waited = await waitFor(org, org.alice, started.run.id);

      expect(waited.turn).toMatchObject({ status: "done", answer: "shared answer" });
      expect(tools.calls()).toHaveLength(1);

      // Its records are the run's, with no member behind them, and name alice as the starter.
      const records = await recordsOf(started.run.id, 3);

      expect(records.map((record) => [record.area, record.member_id, record.starter])).toEqual([
        ["models", null, `member:${org.alice.id}`],
        ["models", null, `member:${org.alice.id}`],
        ["tools", null, `member:${org.alice.id}`],
      ]);

      // A model outside the definition answers like an unknown one, though the org serves it.
      const before = upstream.requests.length;
      const other = await gateway().serve(org.id, started.run.id, chat(OTHER_MODEL));

      expect(other.status).toBe(400);
      expect(await other.text()).toContain("model_not_found");
      expect(upstream.requests).toHaveLength(before);
    },
    RUN_TIMEOUT,
  );
});

/** The agent's current revision, for an edit's `If-Match`. */
const revisionOf = async (org: Org, who: Person, agent: string) =>
  ok<{ revision: number }>(await send(org, `/agents/${agent}`, who)).revision;

const editAgent = async (org: Org, who: Person, agent: string, edit: Json) =>
  ok(await send(org, `/agents/${agent}`, who, "PATCH", edit, await revisionOf(org, who, agent)));

describe("a turn", () => {
  it(
    "keeps the definition it started with: a model changed mid-turn applies from the next turn",
    async () => {
      const upstream = fakeUpstream(toolThenAnswer("first answer"));
      const org = await newOrg(upstream);
      const tools = await toolkit(org, { kind: "everyone" });

      const agent = await createAgent(
        org,
        org.alice,
        agentBody("switching", MODEL, { tool_scope: allTools(tools.id) }),
      );

      const held = deferred();

      upstream.holdAt(0, held.promise);
      const started = await start(org, org.alice, agent.id, "look it up");

      await upstream.arrived(1);
      await editAgent(org, org.alice, agent.id, { model: OTHER_MODEL });
      held.release();

      expect((await waitFor(org, org.alice, started.run.id)).turn).toMatchObject({
        status: "done",
        answer: "first answer",
      });
      expect(upstream.requests.map((request) => request.model)).toEqual([
        "upstream-model",
        "upstream-model",
      ]);

      const next = ok<{ turn: Turn }>(
        await send(org, `/agent-runs/${started.run.id}/messages`, org.alice, "POST", {
          message: "again",
        }),
      );

      await waitFor(org, org.alice, started.run.id, next.turn.id);
      expect(upstream.requests.slice(2).map((request) => request.model)).toContain(
        "upstream-other",
      );
    },
    RUN_TIMEOUT,
  );

  it(
    "ends with a spend limit's refusal of a model call as its answer, and the run stays open",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "never" }));
      const org = await newOrg(upstream);
      const agent = await createAgent(org, org.alice, agentBody("thrifty", MODEL));

      ok(
        await send(org, "/spend/limits", org.admin, "POST", {
          kind: "member",
          subject: org.alice.id,
          period: "day",
          amount_micros: 0,
        }),
        201,
      );

      const started = await start(org, org.alice, agent.id, "hello");
      const waited = await waitFor(org, org.alice, started.run.id);

      expect(waited).toMatchObject({ finished: true, state: "idle", turn: { status: "done" } });
      expect(waited.turn.answer).toMatch(/Spend limit/);
      expect(upstream.requests).toHaveLength(0);

      // Open: the next message is a new turn.
      expect(
        ok<{ delivery: string }>(
          await send(org, `/agent-runs/${started.run.id}/messages`, org.alice, "POST", {
            message: "still?",
          }),
        ).delivery,
      ).toBe("turn");
    },
    RUN_TIMEOUT,
  );

  it(
    "ends with a spend limit's refusal of a tool call as its answer",
    async () => {
      const upstream = fakeUpstream(toolThenAnswer("not this"));
      const org = await newOrg(upstream);
      const tools = await toolkit(org, { kind: "everyone" });

      ok(
        await send(
          org,
          `/toolkits/${tools.id}`,
          org.admin,
          "PATCH",
          { price_micros: 1_000 },
          tools.revision,
        ),
      );
      ok(
        await send(org, "/spend/limits", org.admin, "POST", {
          kind: "toolkit_credential",
          subject: tools.id,
          period: "day",
          amount_micros: 0,
        }),
        201,
      );

      const agent = await createAgent(
        org,
        org.alice,
        agentBody("priced", MODEL, { tool_scope: allTools(tools.id) }),
      );

      const started = await start(org, org.alice, agent.id, "look it up");
      const waited = await waitFor(org, org.alice, started.run.id);

      expect(waited).toMatchObject({ finished: true, state: "idle", turn: { status: "done" } });
      expect(waited.turn.answer).toMatch(/Spend limit .* was not called\.$/);
      expect(tools.calls()).toHaveLength(0);
    },
    RUN_TIMEOUT,
  );
});

describe("the run principal", () => {
  it(
    "is presented by the run gateway alone, for a run of the org it names that can go on",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "fine" }));
      const org = await newOrg(upstream);
      const elsewhere = await newOrg(upstream);
      const agent = await createAgent(org, org.alice, agentBody("gated", MODEL));
      const started = await start(org, org.alice, agent.id, "hi");

      await waitFor(org, org.alice, started.run.id);

      // The gateway serves the run of the org it is handed, and nothing else: an unknown run, or the run's id in
      // another org, is refused like a revoked key.
      expect((await gateway().serve(org.id, started.run.id, chat(MODEL))).status).toBe(200);
      expect((await gateway().serve(org.id, "ar_unknown", chat(MODEL))).status).toBe(401);
      expect((await gateway().serve(elsewhere.id, started.run.id, chat(MODEL))).status).toBe(401);

      // Its model list is its definition's model alone, though the org serves another.
      const listed = await gateway().serve(
        org.id,
        started.run.id,
        new Request("https://client-api.agent-run.invalid/v1/models"),
      );

      expect(
        ok<{ data: ReadonlyArray<{ id: string }> }>({
          status: listed.status,
          body: await listed.json(),
        }).data.map((model) => model.id),
      ).toEqual([MODEL]);

      // No request to the API Worker's public handler is a run's, whatever it carries: it is a client's like any.
      const outside = await exports.default.fetch(
        new Request("https://commissary.test/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-api-worker": "1",
            authorization: "Bearer cms_not-a-key",
            "x-commissary-run": started.run.id,
          },
          body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
        }),
      );

      expect(outside.status).toBe(401);
      await outside.body?.cancel();
    },
    RUN_TIMEOUT,
  );

  it(
    "keeps its turn going when its agent is disabled mid-turn; the run ends at its next turn",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "finished anyway" }));
      const org = await newOrg(upstream);
      const agent = await createAgent(org, org.alice, agentBody("fading", MODEL));
      const held = deferred();

      upstream.holdAt(0, held.promise);
      const started = await start(org, org.alice, agent.id, "hi");

      await upstream.arrived(1);
      await editAgent(org, org.alice, agent.id, { enabled: false });
      held.release();

      expect((await waitFor(org, org.alice, started.run.id)).turn).toMatchObject({
        status: "done",
        answer: "finished anyway",
      });

      const ended = await send(org, `/agent-runs/${started.run.id}/messages`, org.alice, "POST", {
        message: "still there?",
      });

      expect(ended).toMatchObject({ status: 409, body: { error: "run_ended" } });
      expect(
        ok<{ state: string }>(await send(org, `/agent-runs/${started.run.id}`, org.alice)).state,
      ).toBe("ended");
      expect((await gateway().serve(org.id, started.run.id, chat(MODEL))).status).toBe(401);
    },
    RUN_TIMEOUT,
  );
});

describe("deleting the org", () => {
  it(
    "deletes its runs' objects, transcripts and all",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "bye" }));
      const org = await newOrg(upstream);
      const agent = await createAgent(org, org.alice, agentBody("ephemeral", MODEL));
      const started = await start(org, org.alice, agent.id, "remember this");

      await waitFor(org, org.alice, started.run.id);

      const object = () => env.AGENT_RUN.getByName(`${org.id}:${started.run.id}`);

      expect(await object().show()).toMatchObject({ ok: true });

      expect(
        (await send(org, "/org", await token(ADMIN), "DELETE", { name: org.slug })).status,
      ).toBe(200);
      expect(await object().show()).toMatchObject({ ok: false, error: "not_found" });
    },
    RUN_TIMEOUT,
  );
});
