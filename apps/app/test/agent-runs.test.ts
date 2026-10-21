// Agent runs (#227, ADR 0040) end to end: the management routes of the app Worker start, steer, wait on and cancel runs;
// each run is the API Worker's `AgentRun` object (test/worker.ts exports it with the run gateway, as the API Worker
// does), whose pi-durable harness reaches models through the client API and tools through the MCP endpoint, as the
// run's principal, over the gateway. Only the upstreams are fakes: an OpenAI-compatible model upstream and an MCP
// server, both behind the routing `fetch` of `serveFakeMcpServers`.
//
// The agents toolkit (#229) is the runs' client API: an MCP client with an API key calls it on the API Worker's MCP
// endpoint (this file calls the API Worker's handler, `api.fetch`, directly, with the test Worker's bindings), and a
// run calls it as any of its tools, starting child runs whose results come back to it.
//
// This file stays with the app Worker though it runs the API Worker's code too (AGENTS.md, docs/DEVELOPMENT.md
// "Tests"): a run crosses both Workers, started by the app Worker's routes and served by the API Worker's gateway, so
// the app's test Worker exports the API Worker's `AgentRun` and `AgentRunGateway` (test/worker.ts); and the agents
// toolkit's calls need the agents, grants and API keys the app Worker's routes create, the API Worker's MCP endpoint and
// the runs' objects together.
import {
  abortAllDurableObjects,
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RunGateway } from "@commissary/agents/api";
import { api } from "@commissary/api";
import { agentBody } from "@commissary/agents/testing";
import { FULL_ACCESS } from "@commissary/auth";
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

/** A chat message's content: a string, or text parts (pi sends both). */
type MessageContent = string | null | ReadonlyArray<{ readonly text?: string }>;

interface ChatRequest {
  readonly model?: string;
  readonly stream?: boolean;
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly content?: MessageContent }>;
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
  const holdsIf: Array<{ test: (request: ChatRequest) => boolean; until: Promise<void> }> = [];

  serveOrigin(origin, async (request) => {
    // SAFETY: the client API sends the upstream an OpenAI chat completion request.
    const body = (await request.json()) as ChatRequest;
    const index = requests.length;

    requests.push(body);
    await holds.get(index);

    for (const hold of holdsIf) if (hold.test(body)) await hold.until;

    return answer(body, script(body, index));
  });

  return {
    origin,
    requests,
    /** Holds the request at `index` (the first is 0) until `until` settles. */
    holdAt: (index: number, until: Promise<void>) => void holds.set(index, until),
    /** Holds every request `test` picks until `until` settles. */
    holdIf: (test: (request: ChatRequest) => boolean, until: Promise<void>) =>
      void holdsIf.push({ test, until }),
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

/** The Spend so far of each limit, by kind (one limit per kind here). */
const spentByKind = async (org: Org) =>
  Object.fromEntries(
    ok<{ limits: ReadonlyArray<{ kind: string; spent_micros: number }> }>(
      await send(org, "/spend", org.admin),
    ).limits.map((limit) => [limit.kind, limit.spent_micros]),
  );

describe("a run's spend and usage (#228)", () => {
  it(
    "of a shared agent counts toward the agent's own limit, which refuses its next priced call, never toward its starter's",
    async () => {
      const upstream = fakeUpstream(toolThenAnswer("looked up"));
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

      const agent = await createAgent(
        org,
        org.admin,
        agentBody("metered", MODEL, {
          tool_scope: allTools(tools.id),
          subject: { kind: "member", id: org.alice.id },
        }),
      );

      for (const body of [
        { kind: "agent", subject: agent.id, period: "day", amount_micros: 1_000 },
        { kind: "member", subject: org.alice.id, period: "day", amount_micros: 1_000_000 },
      ])
        ok(await send(org, "/spend/limits", org.admin, "POST", body), 201);

      // The priced tool call fits under the agent's limit, and fills it: the model's next call is refused, which ends
      // the turn with the refusal as its answer.
      const started = await start(org, org.alice, agent.id, "look it up");

      expect((await waitFor(org, org.alice, started.run.id)).turn.answer).toMatch(
        /daily Spend limit of this agent is reached/,
      );
      expect(tools.calls()).toHaveLength(1);
      expect(await spentByKind(org)).toEqual({ agent: 1_000, member: 0 });

      // The next turn is refused at once: nothing reaches the model or the tool, and nothing is charged.
      const before = upstream.requests.length;

      const next = ok<{ turn: Turn }>(
        await send(org, `/agent-runs/${started.run.id}/messages`, org.alice, "POST", {
          message: "again",
        }),
      );

      expect((await waitFor(org, org.alice, started.run.id, next.turn.id)).turn.answer).toMatch(
        /daily Spend limit of this agent is reached/,
      );
      expect(upstream.requests).toHaveLength(before);
      expect(tools.calls()).toHaveLength(1);
      expect(await spentByKind(org)).toEqual({ agent: 1_000, member: 0 });

      // A model call of the run meets the agent's limit too, before any credential is chosen.
      const refused = await gateway().serve(org.id, started.run.id, chat(MODEL));

      expect(refused.status).toBe(429);
      expect(await refused.text()).toContain("spend_limit_reached");
    },
    RUN_TIMEOUT,
  );

  it(
    "of a private agent is charged to its member: its priced tool call lands on their counter",
    async () => {
      const upstream = fakeUpstream(toolThenAnswer("looked up"));
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
          kind: "member",
          subject: org.alice.id,
          period: "day",
          amount_micros: 1_000_000,
        }),
        201,
      );

      const agent = await createAgent(
        org,
        org.alice,
        agentBody("mine", MODEL, { tool_scope: allTools(tools.id) }),
      );

      const started = await start(org, org.alice, agent.id, "look it up");

      expect((await waitFor(org, org.alice, started.run.id)).turn.answer).toBe("looked up");
      expect(tools.calls()).toHaveLength(1);
      expect(await spentByKind(org)).toEqual({ member: 1_000 });
    },
    RUN_TIMEOUT,
  );

  it(
    "of a private agent counts toward its member's limit, and its records are theirs alone, read by agent and run",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "fine" }));
      const org = await newOrg(upstream);
      const agent = await createAgent(org, org.alice, agentBody("mine", MODEL));
      const started = await start(org, org.alice, agent.id, "hello");

      await waitFor(org, org.alice, started.run.id);
      await recordsOf(started.run.id, 1);

      // Her member limit with no room refuses her private agent's run.
      ok(
        await send(org, "/spend/limits", org.admin, "POST", {
          kind: "member",
          subject: org.alice.id,
          period: "day",
          amount_micros: 0,
        }),
        201,
      );
      expect((await gateway().serve(org.id, started.run.id, chat(MODEL))).status).toBe(429);

      // Her records of the run name it, filtered by agent or run; an org admin's reads leave them out.
      const read = async (who: Person, query: string) =>
        ok<{ records: ReadonlyArray<{ agent_id?: string; run_id?: string; starter?: string }> }>(
          await send(org, `/observability/usage/records?area=all&${query}`, who),
        ).records;

      expect(await read(org.alice, `agent=${agent.id}`)).toEqual([
        expect.objectContaining({
          agent_id: agent.id,
          run_id: started.run.id,
          starter: `member:${org.alice.id}`,
          private: true,
        }),
      ]);
      expect(await read(org.alice, `run=${started.run.id}`)).toHaveLength(1);
      expect(await read(org.alice, "agent=ag_other")).toEqual([]);
      expect(await read(org.admin, `agent=${agent.id}`)).toEqual([]);
    },
    RUN_TIMEOUT,
  );
});

describe("deleting runs (#228)", () => {
  it(
    "removing a member deletes the runs they started of a shared agent, objects and all; removing the agent deletes the rest",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "noted" }));
      const org = await newOrg(upstream);

      const agent = await createAgent(
        org,
        org.admin,
        agentBody("shared", MODEL, { subject: { kind: "everyone" } }),
      );

      const alices = await start(org, org.alice, agent.id, "mine");
      const bobs = await start(org, org.bob, agent.id, "his");

      await waitFor(org, org.alice, alices.run.id);
      await waitFor(org, org.bob, bobs.run.id);

      const object = (run: string) => env.AGENT_RUN.getByName(`${org.id}:${run}`);

      ok(await send(org, `/members/${org.alice.id}`, org.admin, "DELETE"));
      expect(await object(alices.run.id).show()).toMatchObject({ ok: false, error: "not_found" });
      expect((await gateway().serve(org.id, alices.run.id, chat(MODEL))).status).toBe(401);
      expect(await object(bobs.run.id).show()).toMatchObject({ ok: true });

      ok(
        await send(
          org,
          `/agents/${agent.id}`,
          org.admin,
          "DELETE",
          undefined,
          await revisionOf(org, org.admin, agent.id),
        ),
      );
      expect(await object(bobs.run.id).show()).toMatchObject({ ok: false, error: "not_found" });
      expect((await send(org, `/agent-runs/${bobs.run.id}`, org.bob)).status).toBe(404);
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

// --- the agents toolkit (#229) ----------------------------------------------------------------------------------------

/** An API key of `who`'s, with `toolScope` if given. */
const apiKey = async (org: Org, who: Person, toolScope?: Json) =>
  ok<{ key: string }>(
    await send(org, "/api-keys", who, "POST", {
      name: `key-${crypto.randomUUID().slice(0, 8)}`,
      ...(toolScope === undefined ? {} : { tool_scope: toolScope }),
    }),
    201,
  ).key;

/**
 * One JSON-RPC request to the API Worker's MCP endpoint with the API key `key`, and its answer: through the API Worker's
 * handler with this file's Platform registry, which knows the key's org.
 */
const mcp = async (key: string, method: string, params: Json = {}, bindings: Partial<Env> = {}) => {
  const response = await api.fetch(
    new Request("https://commissary.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    { ...env, PLATFORM, ...bindings },
    createExecutionContext(),
  );

  expect(response.status).toBe(200);

  // SAFETY: the endpoint answers a JSON-RPC response.
  return (await response.json()) as {
    readonly result?: {
      readonly tools?: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
      readonly content?: ReadonlyArray<{ readonly text?: string }>;
      readonly isError?: boolean;
    };
    readonly error?: { readonly message: string };
  };
};

/** The tools the key's client is listed. */
const listedTools = async (key: string) => (await mcp(key, "tools/list")).result?.tools ?? [];

/** A call of a tool of the agents toolkit with the key: its result's JSON, or its error's text (`error`). */
const callAgents = async (key: string, name: string, args: Json) => {
  const answer = await mcp(key, "tools/call", { name, arguments: args });

  if (answer.error !== undefined) return { error: answer.error.message };
  const text = answer.result?.content?.[0]?.text ?? "";

  // SAFETY: a test's own reading of the toolkit's JSON answers, which the assertions check.
  return answer.result?.isError === true
    ? { error: text }
    : (JSON.parse(text) as Record<string, Json>);
};

/** The marker of an agent's instructions, by which the fake upstream tells the agents apart. */
const marked = (name: string) => `You are [agent:${name}]. Answer briefly.`;

/** The text of a message's content: a string, or its text parts joined. */
const contentText = (content: MessageContent | undefined): string =>
  typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");

/** The run id a start answered. */
const runOf = (answer: Readonly<Record<string, Json>>): string => {
  const { run } = answer;

  if (typeof run !== "string") throw new Error(`no run in ${JSON.stringify(answer)}`);

  return run;
};

/** The agent a model request is for: its instructions' marker. */
const agentOf = (request: ChatRequest): string | undefined =>
  /\[agent:([a-z0-9_]+)\]/u.exec(JSON.stringify(request.messages?.[0] ?? null))?.[1];

/**
 * A model for runs that start each other: an agent of `next` calls `agents_start` with the agent it names, then answers
 * what the tool said; one that `next` does not name answers at once; a child's delivered result is relayed.
 */
const chainScript =
  (next: Readonly<Record<string, string>>) =>
  (request: ChatRequest): Reply => {
    const agent = agentOf(request) ?? "";
    const last = request.messages?.at(-1);
    const text = contentText(last?.content);

    if (last?.role === "tool") return { text: `${agent} saw: ${text}` };

    if (text.startsWith("[agents]")) return { text: `${agent} relays: ${text}` };
    const callee = next[agent];

    return callee === undefined
      ? { text: `${agent} answers` }
      : { tool: "agents_start", args: { agent: callee, input: "go" } };
  };

/** The agents toolkit's whole entry of a tool scope. */
const AGENTS_SCOPE = [{ toolkit: "agents", tools: { kind: "all" as const } }];

const showRun = async (org: Org, who: Person, run: string) =>
  ok<{
    turns: ReadonlyArray<Turn & { input: string }>;
    transcript: ReadonlyArray<{ text: string }>;
  }>(await send(org, `/agent-runs/${run}`, who));

describe("the agents toolkit", () => {
  it(
    "starts a run for an MCP client at once, and its wait answers the status past a timeout, then the answer",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "Here is the draft." }));
      const org = await newOrg(upstream);

      await createAgent(org, org.alice, agentBody("writer", MODEL));
      const key = await apiKey(org, org.alice);
      const tools = await listedTools(key);

      expect(tools.map((tool) => tool.name)).toEqual([
        "agents_cancel",
        "agents_message",
        "agents_start",
        "agents_status",
        "agents_wait",
      ]);
      expect(tools.find((tool) => tool.name === "agents_start")?.description).toContain(
        "- writer: The writer agent",
      );

      const held = deferred();

      upstream.holdAt(0, held.promise);
      const started = await callAgents(key, "agents_start", { agent: "writer", input: "a draft" });

      expect(started).toMatchObject({ run: expect.any(String), turn: "turn_1", status: "running" });
      const run = runOf(started);

      await upstream.arrived(1);

      const early = await callAgents(key, "agents_wait", { run, timeout: 0.2 });

      expect(early).toMatchObject({
        run,
        status: "running",
        finished: false,
        turn: { id: "turn_1", status: "running" },
      });
      expect(early).toHaveProperty("latest_activity");

      held.release();

      expect(await callAgents(key, "agents_wait", { run, timeout: 60 })).toMatchObject({
        run,
        status: "idle",
        finished: true,
        turn: { id: "turn_1", status: "done", answer: "Here is the draft." },
      });

      // Claimed: nothing is left to claim, and the named turn still answers.
      expect(await callAgents(key, "agents_wait", { run, timeout: 1 })).toMatchObject({
        status: "idle",
        result: expect.stringMatching(/^none/u),
      });
      expect(await callAgents(key, "agents_wait", { run, turn: "turn_1" })).toMatchObject({
        turn: { status: "done" },
      });

      // The panel shows the run as the key's member started it, through the toolkit.
      expect(
        ok<Run & { trigger: string }>(await send(org, `/agent-runs/${run}`, org.alice)),
      ).toMatchObject({
        trigger: "mcp",
        starter: { kind: "member", id: org.alice.id },
      });
    },
    RUN_TIMEOUT,
  );

  it(
    "steers a running turn with agents_message, and starts a new turn on an idle run",
    async () => {
      const upstream = fakeUpstream((request) => ({
        text: `seen ${request.messages?.filter((message) => message.role === "user").length ?? 0}`,
      }));

      const org = await newOrg(upstream);

      await createAgent(org, org.alice, agentBody("chatty", MODEL));
      const key = await apiKey(org, org.alice);
      const held = deferred();

      upstream.holdAt(0, held.promise);

      const run = runOf(await callAgents(key, "agents_start", { agent: "chatty", input: "first" }));

      await upstream.arrived(1);

      expect(await callAgents(key, "agents_message", { run, message: "also this" })).toEqual({
        run,
        turn: "turn_1",
        disposition: "steering",
      });

      held.release();
      expect(await callAgents(key, "agents_wait", { run, timeout: 60 })).toMatchObject({
        turn: { id: "turn_1", answer: "seen 2" },
      });

      const next = await callAgents(key, "agents_message", { run, message: "and now?" });

      expect(next).toMatchObject({ run, disposition: "turn" });
      expect(next["turn"]).not.toBe("turn_1");
      expect(await callAgents(key, "agents_wait", { run, timeout: 60 })).toMatchObject({
        turn: { id: next["turn"], answer: "seen 3" },
      });

      // Cancelling a turn keeps the run.
      expect(await callAgents(key, "agents_cancel", { run })).toEqual({ run, cancelled: false });
    },
    RUN_TIMEOUT,
  );

  it(
    "shows a run to the API key that started it only: another key of the same member gets an unknown run",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "mine" }));
      const org = await newOrg(upstream);

      await createAgent(org, org.alice, agentBody("private_one", MODEL));
      const first = await apiKey(org, org.alice);
      const second = await apiKey(org, org.alice);

      const run = runOf(
        await callAgents(first, "agents_start", { agent: "private_one", input: "hi" }),
      );

      expect(await callAgents(first, "agents_status", {})).toMatchObject({
        runs: [{ run, agent: "private_one" }],
      });
      expect(await callAgents(first, "agents_status", { run })).toMatchObject({
        run,
        agent: "private_one",
        turns: [{ id: "turn_1" }],
      });

      for (const tool of ["agents_status", "agents_wait", "agents_message", "agents_cancel"])
        expect(await callAgents(second, tool, { run, message: "hijack" }), tool).toEqual({
          error: `Unknown run ${run}. agents_status lists the runs you started.`,
        });

      expect(await callAgents(second, "agents_status", {})).toEqual({ runs: [] });
      await callAgents(first, "agents_wait", { run, timeout: 60 });
    },
    RUN_TIMEOUT,
  );

  it(
    "exists only where the Agents area is (LOADER): on the MCP endpoint and in the ControlPlane",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "hi" }));
      const org = await newOrg(upstream);

      await createAgent(org, org.alice, agentBody("present", MODEL));
      const key = await apiKey(org, org.alice);
      const without = { LOADER: undefined };

      expect((await listedTools(key)).map((tool) => tool.name)).toContain("agents_start");
      expect(
        (await mcp(key, "tools/list", {}, without)).result?.tools?.map((tool) => tool.name),
      ).toEqual([]);
      expect(
        (await mcp(key, "tools/call", { name: "agents_status", arguments: {} }, without)).error
          ?.message,
      ).toBe("Unknown tool: agents_status");

      // The state Worker's ControlPlane has the toolkit with its binding only.
      const kinds = async (namespace: typeof env.CONTROL_PLANE) =>
        (
          await namespace
            .getByName(crypto.randomUUID())
            .tools()
            .listToolkits(FULL_ACCESS, { agentsToolkit: true })
        ).toolkits.map((toolkit) => toolkit.kind);

      expect(await kinds(env.CONTROL_PLANE)).toContain("agents");
      expect(await kinds(env.CONTROL_PLANE_WITHOUT_AGENTS)).not.toContain("agents");
    },
    RUN_TIMEOUT,
  );

  it(
    "lets a read-only tool scope watch runs, but not start or steer them",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "read" }));
      const org = await newOrg(upstream);

      await createAgent(org, org.alice, agentBody("watched", MODEL));
      const reader = await apiKey(org, org.alice, [{ toolkit: "agents", tools: { kind: "read" } }]);

      expect((await listedTools(reader)).map((tool) => tool.name)).toEqual([
        "agents_status",
        "agents_wait",
      ]);
      expect(await callAgents(reader, "agents_status", {})).toEqual({ runs: [] });
      // Its wait goes through: a key sees only the runs it started, so another's run is unknown to it.
      expect(await callAgents(reader, "agents_wait", { run: "ar_x", timeout: 0 })).toEqual({
        error: "Unknown run ar_x. agents_status lists the runs you started.",
      });
      expect(await callAgents(reader, "agents_start", { agent: "watched", input: "hi" })).toEqual({
        error: "Unknown tool: agents_start",
      });
      expect(await callAgents(reader, "agents_message", { run: "ar_x", message: "hi" })).toEqual({
        error: "Unknown tool: agents_message",
      });
    },
    RUN_TIMEOUT,
  );

  it(
    "delivers a child run's result to the run that started it, which takes it as a new turn when idle",
    async () => {
      const upstream = fakeUpstream(chainScript({ lead: "helper" }));
      const org = await newOrg(upstream);

      const lead = await createAgent(
        org,
        org.alice,
        agentBody("lead", MODEL, { instructions: marked("lead"), tool_scope: AGENTS_SCOPE }),
      );

      await createAgent(
        org,
        org.alice,
        agentBody("helper", MODEL, { instructions: marked("helper") }),
      );

      // The child answers once its parent's turn is over: its result then starts a turn of the idle parent.
      const parentDone = deferred();

      upstream.holdIf((request) => agentOf(request) === "helper", parentDone.promise);
      const started = await start(org, org.alice, lead.id, "delegate this");
      const first = await waitFor(org, org.alice, started.run.id, started.turn.id);

      expect(first.turn.status).toBe("done");
      expect(first.turn.answer).toMatch(/^lead saw: .*"status": "running"/su);
      parentDone.release();

      await vi.waitFor(
        async () =>
          expect((await showRun(org, org.alice, started.run.id)).turns).toMatchObject([
            { status: "done" },
            { status: "done", answer: expect.stringMatching(/^lead relays: \[agents\] Run ar_/u) },
          ]),
        { timeout: 60_000 },
      );

      const { turns } = await showRun(org, org.alice, started.run.id);

      expect(turns[1]?.input).toMatch(
        /\(agent helper\), which you started, finished its turn turn_1\. Its answer:\n\nhelper answers$/u,
      );

      // The child acts as its own agent, and its records name the run that started it.
      const child = /Run (ar_[0-9a-f]+)/u.exec(turns[1]?.input ?? "")?.[1] ?? "";
      const records = await recordsOf(child, 1);

      expect(records[0]).toMatchObject({
        principal_id: `run:${child}`,
        member_id: org.alice.id,
        starter: `run:${started.run.id}`,
      });
    },
    RUN_TIMEOUT,
  );

  it(
    "refuses a fourth level of runs, and an agent already in the chain",
    async () => {
      const upstream = fakeUpstream(chainScript({ a: "b", b: "c", c: "d", loop: "loop" }));
      const org = await newOrg(upstream);
      const ids = new Map<string, string>();

      for (const name of ["a", "b", "c", "d", "loop"])
        ids.set(
          name,
          (
            await createAgent(
              org,
              org.alice,
              agentBody(name, MODEL, { instructions: marked(name), tool_scope: AGENTS_SCOPE }),
            )
          ).id,
        );

      const looping = await start(org, org.alice, ids.get("loop") ?? "", "go");

      expect((await waitFor(org, org.alice, looping.run.id)).turn.answer).toContain(
        "the agent loop already runs in this chain of runs",
      );

      const top = await start(org, org.alice, ids.get("a") ?? "", "go");

      // c's refusal comes back up the chain: c's result to b, b's to a.
      await vi.waitFor(
        async () =>
          expect(
            (await showRun(org, org.alice, top.run.id)).transcript
              .map((entry) => entry.text)
              .join("\n"),
          ).toContain("a chain of runs is at most 3 deep"),
        { timeout: 60_000 },
      );
      expect(upstream.requests.some((request) => agentOf(request) === "d")).toBe(false);
    },
    RUN_TIMEOUT,
  );
});

// --- a run's sandbox (#230) ---------------------------------------------------------------------------------------------

/** The sandbox the agents of these tests name: the built-in sandbox toolkit, without network or computer. */
const SANDBOX = { toolkit: "sandbox" };

/** pi's coding tools, as a run whose definition names a sandbox offers them to its model. */
const CODING_TOOLS = ["bash", "read", "write", "edit"];

/** An org whose members may all use the built-in sandbox toolkit. */
const sandboxOrg = async (upstream: { readonly origin: string }): Promise<Org> => {
  const org = await newOrg(upstream);

  ok(
    await send(org, "/grants/tools", org.admin, "POST", {
      subject: { kind: "everyone" },
      toolkit: "sandbox",
      tools: { kind: "all" },
    }),
  );

  return org;
};

/** The names of the tools a model request offers. */
const offered = (request: ChatRequest): ReadonlyArray<string> =>
  (request.tools ?? []).map((tool) => tool.function.name);

/**
 * A model that works in the sandbox: to `write` it writes a file with the `write` tool, to `edit` it changes it with
 * the `edit` tool, to `read` it reads it back with `bash`; once the tool answered, it answers with the tool's result.
 */
const sandboxScript = (request: ChatRequest): Reply => {
  const messages = request.messages ?? [];
  const asked = messages.findLastIndex((message) => message.role === "user");
  const input = contentText(messages[asked]?.content);
  const result = messages.slice(asked + 1).find((message) => message.role === "tool");

  if (result !== undefined) return { text: `tool said: ${contentText(result.content)}` };

  switch (input) {
    case "write":
      return { tool: "write", args: { path: "notes.txt", content: "hello from the sandbox" } };
    case "edit":
      return {
        tool: "edit",
        args: { path: "notes.txt", edits: [{ oldText: "hello", newText: "greetings" }] },
      };
    default:
      return { tool: "bash", args: { command: "cat notes.txt" } };
  }
};

/** The run's sandbox session, as its object keeps it. */
const runSession = async (org: Org, run: string) =>
  await runInDurableObject(
    env.AGENT_RUN.getByName(`${org.id}:${run}`),
    // SAFETY: the run's object keeps its session as `{ toolkit, session }` (`run-object.ts`, `SANDBOX_SESSION`).
    (_, state) => state.storage.kv.get("sandbox-session") as { session: string } | undefined,
  );

/** The run's tool calls' usage records: each tool and how its call ended, oldest first. */
const toolRecordsOf = async (run: string) =>
  (
    await env.USAGE.prepare(
      `SELECT tool_id, tool_outcome FROM usage_records WHERE run_id = ? AND area = 'tools'
       ORDER BY requested_at`,
    )
      .bind(run)
      .all<{ tool_id: string; tool_outcome: string }>()
  ).results.map((row) => [row.tool_id, row.tool_outcome]);

/** The tickets of gated sandbox calls the org's ControlPlane still holds. */
const ticketsOf = async (org: Org) =>
  await runInDurableObject(env.CONTROL_PLANE.getByName(org.id), (_, state) =>
    state.storage.sql.exec("SELECT id FROM sandbox_run_calls WHERE settled_at IS NULL").toArray(),
  );

/** The sandbox sessions the org's ControlPlane tracks for the run `run`. */
const trackedSessions = async (org: Org, run: string) =>
  await runInDurableObject(env.CONTROL_PLANE.getByName(org.id), (_, state) =>
    state.storage.sql
      .exec<{ id: string }>("SELECT id FROM sandbox_sessions WHERE principal = ?", `run:${run}`)
      .toArray()
      .map((row) => row.id),
  );

describe("a run's sandbox (#230)", () => {
  it(
    "gives the model pi's coding tools on one session of the run's, which lasts across turns and goes with the run",
    async () => {
      const upstream = fakeUpstream(sandboxScript);
      const org = await sandboxOrg(upstream);

      const agent = await createAgent(
        org,
        org.alice,
        agentBody("builder", MODEL, { sandbox: SANDBOX }),
      );

      const started = await start(org, org.alice, agent.id, "write");

      expect(await waitFor(org, org.alice, started.run.id)).toMatchObject({
        finished: true,
        turn: { status: "done" },
      });

      // The sandbox toolkit's own tools are not offered: pi's coding tools stand for them, on the run's session.
      const tools = offered(upstream.requests[0] ?? {});

      expect(tools).toEqual(expect.arrayContaining(CODING_TOOLS));
      expect(tools.filter((name) => name.startsWith("sandbox_"))).toEqual([]);

      const session = (await runSession(org, started.run.id))?.session;

      expect(session).toEqual(expect.any(String));
      expect(await trackedSessions(org, started.run.id)).toEqual([session]);

      // A later turn works in the same session: the file the first wrote is there.
      const next = ok<{ turn: Turn }>(
        await send(org, `/agent-runs/${started.run.id}/messages`, org.alice, "POST", {
          message: "read",
        }),
      );

      const read = await waitFor(org, org.alice, started.run.id, next.turn.id);

      expect(read.turn.status).toBe("done");
      expect(read.turn.answer).toContain("hello from the sandbox");
      expect((await runSession(org, started.run.id))?.session).toBe(session);

      // pi's edit makes three operations on the session (what the file is, its text, the new text): one call.
      const edit = ok<{ turn: Turn }>(
        await send(org, `/agent-runs/${started.run.id}/messages`, org.alice, "POST", {
          message: "edit",
        }),
      );

      const edited = await waitFor(org, org.alice, started.run.id, edit.turn.id);

      expect(edited.turn.answer).toContain("Successfully replaced 1 block(s) in notes.txt.");

      // Each call was gated as the sandbox toolkit's tool, as the run's principal, and has one usage record; no ticket
      // is left unsettled.
      const records = await recordsOf(started.run.id, 10);

      expect(records.filter((record) => record.area === "tools")).toHaveLength(4);
      expect(await toolRecordsOf(started.run.id)).toEqual([
        ["sandbox:open", "success"],
        ["sandbox:write", "success"],
        ["sandbox:bash", "success"],
        ["sandbox:edit", "success"],
      ]);
      expect(await ticketsOf(org)).toEqual([]);

      // A ticket never issued writes no record.
      expect(
        await gateway().settleToolCall(org.id, started.run.id, "rtc_none", {
          outcome: "success",
          responseBytes: 0,
        }),
      ).toEqual({ recorded: false });

      // Deleting the agent deletes its runs, and their sandbox sessions with them.
      ok(
        await send(
          org,
          `/agents/${agent.id}`,
          org.alice,
          "DELETE",
          undefined,
          await revisionOf(org, org.alice, agent.id),
        ),
      );
      expect(await trackedSessions(org, started.run.id)).toEqual([]);
    },
    RUN_TIMEOUT,
  );

  it(
    "keeps a gated call's report when its settling fails, and settles it from the alarm, backing off, into one record",
    async () => {
      const upstream = fakeUpstream(sandboxScript);
      const org = await sandboxOrg(upstream);

      const agent = await createAgent(
        org,
        org.alice,
        agentBody("builder", MODEL, { sandbox: SANDBOX }),
      );

      // The usage database refuses the write's record until the trigger goes: its settling fails.
      await env.USAGE.prepare(
        `CREATE TRIGGER fail_write_record BEFORE INSERT ON usage_records WHEN NEW.tool_id = 'sandbox:write'
         BEGIN SELECT RAISE(ABORT, 'the record cannot be written'); END`,
      ).run();

      try {
        const before = Date.now();
        const started = await start(org, org.alice, agent.id, "write");

        expect(await waitFor(org, org.alice, started.run.id)).toMatchObject({
          turn: { status: "done" },
        });

        const after = Date.now();
        const object = env.AGENT_RUN.getByName(`${org.id}:${started.run.id}`);

        /** The run's settlings to try again, and its alarm. */
        const pending = async () =>
          await runInDurableObject(object, async (_, state) => ({
            // SAFETY: the run keeps each as `{ report, attempts, retryAt }` (`run-object.ts`, `PendingSettle`).
            settles: [...state.storage.kv.list({ prefix: "sandbox-call:" })] as Array<
              [string, { report: { outcome: string }; attempts: number; retryAt: number }]
            >,
            alarm: await state.storage.getAlarm(),
          }));

        /** Makes each settling to try again due now. */
        const due = async () =>
          await runInDurableObject(object, (_, state) => {
            for (const [key, value] of state.storage.kv.list({ prefix: "sandbox-call:" }))
              state.storage.kv.put(key, { ...(value as object), retryAt: 0 });
          });

        // The report is kept, to be tried again 30 s after the first try, which the alarm is set for.
        const first = await pending();
        const [[, kept] = []] = first.settles;

        expect(first.settles).toHaveLength(1);
        expect(kept).toMatchObject({ report: { outcome: "success" }, attempts: 1 });
        expect(kept?.retryAt).toBeGreaterThanOrEqual(before + 30_000);
        expect(kept?.retryAt).toBeLessThanOrEqual(after + 30_000);
        expect(first.alarm).toBe(kept?.retryAt);

        // An alarm before it is due tries nothing, and sets itself for it again.
        await runDurableObjectAlarm(object);
        expect(await pending()).toEqual(first);

        // Due, tried again and failing again: the next try waits twice as long.
        await due();
        const retriedAt = Date.now();

        await runDurableObjectAlarm(object);
        const second = await pending();
        const [[, again] = []] = second.settles;

        expect(again).toMatchObject({ report: { outcome: "success" }, attempts: 2 });
        expect(again?.retryAt).toBeGreaterThanOrEqual(retriedAt + 60_000);
        expect(again?.retryAt).toBeLessThanOrEqual(Date.now() + 60_000);
        expect(second.alarm).toBe(again?.retryAt);

        // Once the record can be written, the next try writes it, once, as the call ended: a success.
        await env.USAGE.prepare("DROP TRIGGER fail_write_record").run();
        await due();
        await runDurableObjectAlarm(object);
        expect((await pending()).settles).toEqual([]);
        expect(
          (await toolRecordsOf(started.run.id)).filter(([tool]) => tool === "sandbox:write"),
        ).toEqual([["sandbox:write", "success"]]);
      } finally {
        await env.USAGE.prepare("DROP TRIGGER IF EXISTS fail_write_record").run();
      }
    },
    RUN_TIMEOUT,
  );

  it(
    "records a gated call the run was stopped in as interrupted when it reopens, once",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "resumed" }));
      const org = await sandboxOrg(upstream);

      const agent = await createAgent(
        org,
        org.alice,
        agentBody("builder", MODEL, { sandbox: SANDBOX }),
      );

      const held = deferred();

      upstream.holdAt(0, held.promise);
      const started = await start(org, org.alice, agent.id, "work");

      await upstream.arrived(1);

      /** A `tools/call` of `name` with `args` and `meta` as the run, through its gateway. */
      const runCall = async (
        name: string,
        args: Record<string, string>,
        meta: Record<string, true>,
      ) =>
        await gateway().serve(
          org.id,
          started.run.id,
          new Request("https://client-api.agent-run.invalid/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args, _meta: meta },
            }),
          }),
        );

      // The run's own session, as its harness opens it; then a call gated for the run in it, as its coding tool's
      // gate makes it, whose run then stops before settling it.
      const opening = await runCall("sandbox_open", {}, { "commissary/run-session": true });

      // SAFETY: the endpoint answers a JSON-RPC response, `sandbox_open`'s with the session in its structured content.
      const opened = (await opening.json()) as {
        result: { structuredContent: { session: string } };
      };

      const gated = await runCall(
        "sandbox_bash",
        { session: opened.result.structuredContent.session, command: "true" },
        { "commissary/run-executes": true },
      );

      // SAFETY: the endpoint answers a JSON-RPC response, a gated call's with its ticket in `_meta`.
      const answer = (await gated.json()) as {
        result: { _meta: { "commissary/run-ticket": { id: string } } };
      };

      const ticket = answer.result._meta["commissary/run-ticket"].id;
      const object = env.AGENT_RUN.getByName(`${org.id}:${started.run.id}`);

      await runInDurableObject(object, (_, state) => {
        state.storage.kv.put(`sandbox-call:${ticket}`, true);
      });

      await abortAllDurableObjects();
      held.release();

      // The heartbeat reopens the harness, which settles the call as interrupted: its one record.
      await runDurableObjectAlarm(env.AGENT_RUN.getByName(`${org.id}:${started.run.id}`));
      await waitFor(org, org.alice, started.run.id, started.turn.id);

      await vi.waitFor(
        async () =>
          expect(
            (await toolRecordsOf(started.run.id)).toSorted(([a], [b]) =>
              String(a).localeCompare(String(b)),
            ),
          ).toEqual([
            ["sandbox:bash", "upstream_failure"],
            ["sandbox:open", "success"],
          ]),
        { timeout: 15_000 },
      );
      expect(await ticketsOf(org)).toEqual([]);
    },
    RUN_TIMEOUT,
  );

  it(
    "puts its calls under the sandbox toolkit's approval rules: a marked sandbox_bash holds bash",
    async () => {
      const upstream = fakeUpstream(sandboxScript);
      const org = await sandboxOrg(upstream);

      const toolkits = ok<{ toolkits: ReadonlyArray<{ id: string; revision: number }> }>(
        await send(org, "/toolkits", org.admin),
      );

      const sandbox = toolkits.toolkits.find((toolkit) => toolkit.id === "sandbox");

      ok(
        await send(
          org,
          "/toolkits/sandbox",
          org.admin,
          "PATCH",
          { approval_rules: { tools: [{ id: "sandbox:bash" }] } },
          sandbox?.revision,
        ),
      );

      const agent = await createAgent(
        org,
        org.alice,
        agentBody("builder", MODEL, { sandbox: SANDBOX }),
      );

      const started = await start(org, org.alice, agent.id, "read");
      const waited = await waitFor(org, org.alice, started.run.id);

      // The call waits for its approver, the run's starter; the model is told in the names it knows.
      expect(waited.turn.answer).toContain("bash was not called yet: the call waits for approval");
      expect(waited.turn.answer).not.toContain("sandbox_bash");

      expect(
        ok<{ approvals: ReadonlyArray<{ tool: { name: string }; status: string }> }>(
          await send(org, "/approvals", org.alice),
        ).approvals,
      ).toMatchObject([{ tool: { name: "sandbox_bash" }, status: "pending" }]);
    },
    RUN_TIMEOUT,
  );

  it(
    "leaves the run's session for a new one once its definition narrowed, and keeps it when the definition widened",
    async () => {
      const upstream = fakeUpstream(sandboxScript);
      const org = await sandboxOrg(upstream);
      const hosts = { kind: "hosts" as const, hosts: ["example.com"] };

      const toolkits = ok<{ toolkits: ReadonlyArray<{ id: string; revision: number }> }>(
        await send(org, "/toolkits", org.admin),
      );

      const sandbox = toolkits.toolkits.find((toolkit) => toolkit.id === "sandbox");

      ok(
        await send(
          org,
          "/toolkits/sandbox",
          org.admin,
          "PATCH",
          { network: hosts },
          sandbox?.revision,
        ),
      );

      const agent = await createAgent(
        org,
        org.alice,
        agentBody("builder", MODEL, { sandbox: { ...SANDBOX, network: hosts } }),
      );

      const started = await start(org, org.alice, agent.id, "write");

      await waitFor(org, org.alice, started.run.id);
      const first = await runSession(org, started.run.id);

      expect(first).toMatchObject({ toolkit: "sandbox", network: hosts });

      /** Runs a turn of the run that reads the file back; the run's session after it. */
      const readTurn = async () => {
        const next = ok<{ turn: Turn }>(
          await send(org, `/agent-runs/${started.run.id}/messages`, org.alice, "POST", {
            message: "read",
          }),
        );

        await waitFor(org, org.alice, started.run.id, next.turn.id);

        return await runSession(org, started.run.id);
      };

      // Its network narrowed (none now): the next turn opens a new, empty session; the old one goes with the run.
      await editAgent(org, org.alice, agent.id, { sandbox: SANDBOX });
      const second = await readTurn();

      expect(second?.session).toEqual(expect.any(String));
      expect(second?.session).not.toBe(first?.session);
      expect(second).not.toHaveProperty("network");
      expect(new Set(await trackedSessions(org, started.run.id))).toEqual(
        new Set([first?.session, second?.session]),
      );

      // The call that opened it told the model why, once.
      expect(
        await runInDurableObject(
          env.AGENT_RUN.getByName(`${org.id}:${started.run.id}`),
          (_, state) => state.storage.kv.get("sandbox-notice"),
        ),
      ).toBeUndefined();

      // Widened again: the session keeps what it has.
      await editAgent(org, org.alice, agent.id, { sandbox: { ...SANDBOX, network: hosts } });
      expect((await readTurn())?.session).toBe(second?.session);
    },
    RUN_TIMEOUT,
  );

  it(
    "gives a run whose definition names no sandbox no coding tools, the sandbox toolkit's own as its tool scope has them",
    async () => {
      const upstream = fakeUpstream(() => ({ text: "no sandbox" }));
      const org = await sandboxOrg(upstream);

      const agent = await createAgent(
        org,
        org.alice,
        agentBody("plain", MODEL, { tool_scope: allTools("sandbox") }),
      );

      const started = await start(org, org.alice, agent.id, "hello");

      await waitFor(org, org.alice, started.run.id);

      const tools = offered(upstream.requests[0] ?? {});

      expect(tools.filter((name) => CODING_TOOLS.includes(name))).toEqual([]);
      expect(tools).toEqual(expect.arrayContaining(["sandbox_open", "sandbox_bash"]));
    },
    RUN_TIMEOUT,
  );
});
