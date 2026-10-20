// The built-in agents toolkit (#229, ADR 0040) in the Tools part over RPC: it exists where the Agents area is (here a
// fake directory of the agents each member may run, test/worker.ts), takes no grant, reaches a caller who may run an
// agent (as a member, or as a shared agent's run) within their tool scope, lists the agents they may run in
// `agents_start`'s description, and hands each call it reached back to the endpoint's Worker (`delegated`), only to an
// endpoint that says it makes them.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ToolScope } from "@commissary/contract/api-keys";

const POLICY = { ownHosts: [], localDevelopment: false };

const ADMIN = { member: "m-admin", admin: true };

const ALICE = { member: "m-alice", admin: false };

const AGENTS = { agentsToolkit: true } as const;

const withAgents = () => env.AGENTS_CONTROL_PLANE.getByName(crypto.randomUUID());

type Stub = ReturnType<typeof withAgents>;

const ALL_TOOLS = [
  "agents_cancel",
  "agents_message",
  "agents_start",
  "agents_status",
  "agents_wait",
];

/** A private agent's run of alice's, narrowed by `toolScope`. */
const aliceRun = (toolScope: ToolScope) => ({
  toolScope,
  asAgent: false,
  starterMember: ALICE.member,
  agentId: undefined as string | undefined,
});

const listed = async (
  stub: Stub,
  viewer: { readonly member?: string; readonly admin: boolean },
  run?: ReturnType<typeof aliceRun>,
) => await stub.tools().clientTools(viewer, undefined, run, AGENTS);

describe("the agents toolkit", () => {
  it("is an org toolkit of Commissary's own, with a shared credential of kind none", async () => {
    const stub = withAgents();
    const { toolkits } = await stub.tools().listToolkits(ALICE, AGENTS);

    expect(toolkits).toHaveLength(1);
    expect(toolkits[0]).toMatchObject({
      id: "agents",
      kind: "agents",
      name: "agents",
      source: "commissary",
      private: false,
      built_in: true,
      credentials: { shared: { kind: "none", active: true } },
    });

    const tools = await stub.tools().listTools(ALICE, "agents", AGENTS);

    expect(tools.ok && tools.value.tools.map((tool) => [tool.id, tool.class])).toEqual([
      ["agents:start", "write"],
      ["agents:message", "write"],
      ["agents:wait", "read"],
      ["agents:status", "read"],
      ["agents:cancel", "write"],
    ]);
    expect(
      (await stub.tools().exportToolkits(ADMIN, AGENTS)).map((toolkit) => toolkit.kind),
    ).toEqual(["agents"]);
  });

  it("is shown only to a caller that asks for it, so one deployed before it never meets its kind", async () => {
    const stub = withAgents();

    expect((await stub.tools().listToolkits(ALICE)).toolkits).toEqual([]);
    expect(await stub.tools().listTools(ALICE, "agents")).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await stub.tools().exportToolkits(ADMIN)).toEqual([]);
  });

  it("is missing where the Agents area is not: no toolkit, no name taken", async () => {
    const stub = env.CONTROL_PLANE.getByName(crypto.randomUUID());

    expect((await stub.tools().listToolkits(ALICE, AGENTS)).toolkits).toEqual([]);
    expect(await stub.tools().clientTools(ALICE, undefined, undefined, AGENTS)).toEqual([]);
    expect(
      await stub
        .tools()
        .callTool(ALICE, { name: "agents_status", arguments: {}, agentsToolkit: true }, POLICY),
    ).toEqual({ outcome: "unknown" });
    // A grant naming it names a toolkit the org lacks.
    expect(
      await stub.tools().writeGrant(
        {
          revision: 0,
          value: { subject: { kind: "everyone" }, toolkit: "agents", tools: { kind: "all" } },
        },
        "test",
      ),
    ).toMatchObject({
      ok: false,
      error: "invalid",
      message: expect.stringContaining("no toolkit"),
    });
  });

  it("reaches a member who may run an agent, without a grant, and lists their agents in agents_start", async () => {
    const stub = withAgents();
    const tools = await listed(stub, ALICE);

    expect(tools.map((tool) => tool.name)).toEqual(ALL_TOOLS);
    expect(tools.find((tool) => tool.name === "agents_wait")?.toolClass).toBe("read");

    const start = tools.find((tool) => tool.name === "agents_start")?.description ?? "";

    expect(start).toContain("- writer: Writes drafts\n- critic");
    expect(start).not.toContain("support");

    // A member who may run no agent, an org admin included, does not see the toolkit.
    expect(await listed(stub, ADMIN)).toEqual([]);
    expect(await listed(stub, { admin: false })).toEqual([]);
  });

  it("is served only to an endpoint that makes its calls", async () => {
    const stub = withAgents();

    expect(await stub.tools().clientTools(ALICE)).toEqual([]);
    expect(
      await stub.tools().callTool(ALICE, { name: "agents_status", arguments: {} }, POLICY),
    ).toEqual({ outcome: "unknown" });
  });

  it("hands a call back to the endpoint's Worker, with the agents its caller's scope names", async () => {
    const stub = withAgents();

    const outcome = await stub
      .tools()
      .callTool(
        ALICE,
        { name: "agents_start", arguments: { agent: "writer", input: "hi" }, agentsToolkit: true },
        POLICY,
      );

    expect(outcome).toMatchObject({
      outcome: "delegated",
      tool: "start",
      arguments: { agent: "writer", input: "hi" },
      usage: { toolkitId: "agents", toolId: "agents:start", credential: "shared", costMicros: 0 },
    });
    expect(outcome.outcome === "delegated" ? outcome.scopeAgents : "none").toBeUndefined();

    const scoped = await stub.tools().callTool(
      ALICE,
      {
        name: "agents_start",
        arguments: { agent: "critic", input: "hi" },
        run: aliceRun([{ toolkit: "agents", tools: { kind: "all" }, agents: ["ag_critic"] }]),
        agentsToolkit: true,
      },
      POLICY,
    );

    expect(scoped).toMatchObject({ outcome: "delegated", scopeAgents: ["ag_critic"] });
  });

  it("is narrowed by a tool scope: its agents, and its read tools for a read-only scope", async () => {
    const stub = withAgents();

    const named = await listed(
      stub,
      ALICE,
      aliceRun([{ toolkit: "agents", tools: { kind: "all" }, agents: ["ag_critic"] }]),
    );

    const start = named.find((tool) => tool.name === "agents_start")?.description ?? "";

    expect(start).toContain("- critic");
    expect(start).not.toContain("writer");

    // A scope whose agents the caller may not run, or without the toolkit, reaches none of it.
    expect(
      await listed(
        stub,
        ALICE,
        aliceRun([{ toolkit: "agents", tools: { kind: "all" }, agents: ["ag_support"] }]),
      ),
    ).toEqual([]);
    expect(await listed(stub, ALICE, aliceRun([]))).toEqual([]);

    // Read-only: it watches runs, but does not start or steer them.
    const reader = aliceRun([{ toolkit: "agents", tools: { kind: "read" } }]);

    expect((await listed(stub, ALICE, reader)).map((tool) => tool.name)).toEqual([
      "agents_status",
      "agents_wait",
    ]);

    const call = async (name: string) =>
      (
        await stub
          .tools()
          .callTool(ALICE, { name, arguments: {}, run: reader, agentsToolkit: true }, POLICY)
      ).outcome;

    expect(await call("agents_status")).toBe("delegated");
    expect(await call("agents_start")).toBe("unknown");
    expect(await call("agents_message")).toBe("unknown");
  });

  it("reaches a shared agent's run by the agents its definition reaches", async () => {
    const stub = withAgents();

    const tools = await stub.tools().clientTools(
      { admin: false },
      undefined,
      {
        toolScope: [{ toolkit: "agents", tools: { kind: "all" } }],
        asAgent: true,
        starterMember: ALICE.member,
      },
      AGENTS,
    );

    expect(tools.map((tool) => tool.name)).toEqual(ALL_TOOLS);
    expect(tools.find((tool) => tool.name === "agents_start")?.description).toContain(
      "- support: Answers customers",
    );
  });

  it("does not offer a run its own agent, which it could not start", async () => {
    const stub = withAgents();

    const tools = await listed(stub, ALICE, {
      ...aliceRun([{ toolkit: "agents", tools: { kind: "all" } }]),
      agentId: "ag_writer",
    });

    const start = tools.find((tool) => tool.name === "agents_start")?.description ?? "";

    expect(start).toContain("- critic");
    expect(start).not.toContain("writer");

    // A shared agent's run whose only agent is itself reaches no agents toolkit.
    expect(
      await stub
        .tools()
        .clientTools(
          { admin: false },
          undefined,
          { toolScope: [], asAgent: true, agentId: "ag_support" },
          AGENTS,
        ),
    ).toEqual([]);
  });

  it("takes no grant", async () => {
    const stub = withAgents();

    const written = await stub.tools().writeGrant(
      {
        revision: 0,
        value: { subject: { kind: "everyone" }, toolkit: "agents", tools: { kind: "all" } },
      },
      "test",
    );

    expect(written).toMatchObject({ ok: false, error: "invalid" });
  });
});
