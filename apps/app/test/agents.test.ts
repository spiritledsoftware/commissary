// Hosted agents through the management API (#226, ADR 0040): the app Worker's router, the Access gate and the role
// table, the real ControlPlane with the Agents part, and the seam through which the routes check what a definition
// names (`management/agent-routes.ts`): the models the org serves (Models' registry over its provider keys) and the
// toolkits it has (the Tools part). The part's own rules (watchers, member departure, names) are `@commissary/agents`'
// tests; here the wiring is checked end to end, with the deployment's Dynamic Workers binding (`LOADER`) present and
// absent.
import { afterAll, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  AgentsList,
  type CreateAgent,
  CreatedAgentView,
  UsableAgents,
} from "@commissary/contract/agents";
import type { Json } from "@commissary/json";
import { agentBody } from "@commissary/agents/testing";
import { fakeMcpServer, serveFakeMcpServers } from "@commissary/tools/testing";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";

serveFakeMcpServers();

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

// The same deployment without Dynamic Workers: the Agents area is absent.
const withoutLoader = makeHarness(undefined, { ...registry.bindings, LOADER: undefined });

afterAll(async () => {
  await harness.dispose();
  await withoutLoader.dispose();
});

interface Person {
  readonly id: string;
  readonly auth: string;
}

interface Org {
  readonly slug: string;
  readonly admin: Person;
  readonly alice: Person;
  readonly bob: Person;
  readonly teamId: string;
}

const send = async (
  org: Pick<Org, "slug">,
  path: string,
  who: Person | string,
  method = "GET",
  body?: CreateAgent | Json,
  headers: Record<string, string> = {},
  on = harness,
): Promise<{ status: number; body: unknown }> => {
  const merged = new Headers(headers);

  if (body !== undefined) merged.set("content-type", "application/json");

  return await on.json(`/v9/management/orgs/${org.slug}${path}`, {
    method,
    headers: merged,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    auth: typeof who === "string" ? who : who.auth,
  });
};

const errorOf = (reply: { body: unknown }) => (reply.body as { error?: string }).error;

const created = (reply: { body: unknown }) =>
  Schema.decodeUnknownSync(CreatedAgentView)(reply.body);

/** The model the org's shared provider key serves, by the alias clients name it. */
const SHARED_MODEL = "team-sonnet";

/** The model only alice's private provider key serves. */
const PRIVATE_MODEL = "alice-opus";

const providerKeys = (model: string, alias: string, key: string) => ({
  family: "claude",
  revision: 0,
  group: {
    "base-url": "https://api.example.test/v1",
    keys: [{ "api-key": key }],
    models: [{ name: model, alias }],
  },
});

/**
 * An org with an org admin, two plain members and a team with alice in it; private agents and credentials on, a shared
 * provider key serving {@link SHARED_MODEL} and alice's private one serving {@link PRIVATE_MODEL}.
 */
const newOrg = async (): Promise<Org> => {
  const slug = `agents-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  const made = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", {
      slug,
      name: slug,
      private_credentials: true,
      private_toolkits: true,
      private_agents: true,
    }),
  );

  expect(made.status).toBe(201);

  const org = { slug };

  const person = async (name: string, role: string): Promise<Person> => {
    const email = `${name}-${slug}@example.com`;
    const added = await send(org, "/members", platform, "POST", { email, role });

    expect(added.status).toBe(201);

    return { id: (added.body as { id: string }).id, auth: await token(email) };
  };

  const admin = await person("admin", "admin");
  const alice = await person("alice", "member");
  const bob = await person("bob", "member");
  const team = await send(org, "/teams", admin, "POST", { name: "Research" });

  expect(team.status).toBe(201);
  const teamId = (team.body as { id: string }).id;

  expect(
    (await send(org, `/teams/${teamId}/members`, admin, "POST", { member_id: alice.id })).status,
  ).toBe(200);

  const shared = providerKeys("claude-sonnet-4-5", SHARED_MODEL, "sk-shared-0001");
  const own = providerKeys("claude-opus-4-1", PRIVATE_MODEL, "sk-alice-0001");

  expect((await send(org, "/provider-keys/groups", admin, "PUT", shared)).status).toBe(200);
  expect((await send(org, "/provider-keys/groups", alice, "PUT", own)).status).toBe(200);

  return { slug, admin, alice, bob, teamId };
};

describe("the Agents area", () => {
  it("exists only on a deployment with Dynamic Workers: without LOADER its routes answer 404", async () => {
    const org = await newOrg();

    const me = await send(org, "/me", org.admin);

    expect((me.body as { deployment: { agents: boolean } }).deployment.agents).toBe(true);

    const absent = await send(org, "/me", org.admin, "GET", undefined, {}, withoutLoader);

    expect((absent.body as { deployment: { agents: boolean } }).deployment.agents).toBe(false);

    // Absent for everyone: a plain member's request is not refused by the role table first.
    for (const who of [org.admin, org.alice])
      for (const [path, method, body] of [
        ["/agents", "GET", undefined],
        ["/agents/mine", "GET", undefined],
        ["/agents", "POST", agentBody("helper", SHARED_MODEL, { private: true })],
        ["/agents/some-id", "GET", undefined],
        ["/grants/agents", "GET", undefined],
        ["/grants/agents", "POST", { subject: { kind: "everyone" }, agent: "some-id" }],
      ] as const) {
        const reply = await send(org, path, who, method, body, {}, withoutLoader);

        expect([path, method, reply.status]).toEqual([path, method, 404]);
      }

    expect((await send(org, "/agents", org.admin)).status).toBe(200);
    // With the area present, the grants are an org admin's.
    expect((await send(org, "/grants/agents", org.alice)).status).toBe(403);
  });
});

describe("private agents", () => {
  it("are created by a plain member on a model they reach, and only they see them in full", async () => {
    const org = await newOrg();

    // Alice reaches the shared key's model and her own; bob does not reach hers.
    const own = await send(org, "/agents", org.alice, "POST", agentBody("drafts", PRIVATE_MODEL));

    expect(own.status).toBe(201);
    expect(created(own)).toMatchObject({ name: "drafts", private: true, enabled: true });

    const bobs = await send(org, "/agents", org.bob, "POST", agentBody("bobs", PRIVATE_MODEL));

    expect([bobs.status, errorOf(bobs), (bobs.body as { path?: string }).path]).toEqual([
      422,
      "unknown_model",
      "model",
    ]);
    expect(
      (await send(org, "/agents", org.bob, "POST", agentBody("bobs", SHARED_MODEL))).status,
    ).toBe(201);

    const admins = Schema.decodeUnknownSync(AgentsList)(
      (await send(org, "/agents", org.admin)).body,
    );

    expect(admins.agents).toEqual([]);
    expect(admins.others?.map((agent) => agent.name).toSorted()).toEqual(["bobs", "drafts"]);
    expect(JSON.stringify(admins)).not.toContain("Answer briefly.");

    const mine = Schema.decodeUnknownSync(UsableAgents)(
      (await send(org, "/agents/mine", org.alice)).body,
    );

    expect(mine.agents.map((agent) => agent.name)).toEqual(["drafts"]);
  });

  it("may be disabled or removed by an org admin, who sees only that they exist", async () => {
    const org = await newOrg();

    const own = created(
      await send(org, "/agents", org.alice, "POST", agentBody("drafts", PRIVATE_MODEL)),
    );

    const seen = await send(org, `/agents/${own.id}`, org.admin);

    expect(seen.body).toMatchObject({ id: own.id, limited: true, enabled: true });
    expect(JSON.stringify(seen.body)).not.toContain(PRIVATE_MODEL);

    // An admin edits nothing but whether it is enabled.
    const edit = await send(
      org,
      `/agents/${own.id}`,
      org.admin,
      "PATCH",
      { instructions: "Answer at length." },
      { "if-match": String(own.revision) },
    );

    expect([edit.status, errorOf(edit)]).toEqual([403, "forbidden"]);

    const disabled = await send(
      org,
      `/agents/${own.id}`,
      org.admin,
      "PATCH",
      { enabled: false },
      { "if-match": String(own.revision) },
    );

    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ limited: true, enabled: false });
    expect(
      Schema.decodeUnknownSync(UsableAgents)((await send(org, "/agents/mine", org.alice)).body)
        .agents,
    ).toEqual([]);

    const revision = (disabled.body as { revision: number }).revision;

    const removed = await send(org, `/agents/${own.id}`, org.admin, "DELETE", undefined, {
      "if-match": String(revision),
    });

    expect(removed.body).toEqual({ id: own.id, removed: true });
    expect((await send(org, `/agents/${own.id}`, org.alice)).status).toBe(404);
  });

  it("follow the org's setting, which org admins change", async () => {
    const org = await newOrg();

    expect((await send(org, "/membership", org.admin)).body).toMatchObject({
      private_agents: true,
    });
    expect(
      (await send(org, "/membership", org.alice, "PATCH", { private_agents: false })).status,
    ).toBe(403);
    expect(
      (await send(org, "/membership", org.admin, "PATCH", { private_agents: false })).body,
    ).toMatchObject({ private_agents: false });

    const refused = await send(org, "/agents", org.alice, "POST", agentBody("late", SHARED_MODEL));

    expect([refused.status, errorOf(refused)]).toEqual([403, "private_agents_unavailable"]);
  });
});

describe("shared agents", () => {
  it("are for org admins, name a model and toolkits the org has, and reach the granted team", async () => {
    const server = fakeMcpServer(`https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`, {
      tools: [{ name: "search" }],
    });

    const org = await newOrg();

    const toolkit = await send(org, "/toolkits", org.admin, "POST", {
      source: server.url,
      name: "search",
    });

    expect(toolkit.status).toBe(201);
    const toolkitId = (toolkit.body as { id: string }).id;
    const team = { kind: "team" as const, id: org.teamId };

    // A plain member's agent is private whatever they ask, so it names nobody to share it with.
    const plain = await send(
      org,
      "/agents",
      org.alice,
      "POST",
      agentBody("alices", SHARED_MODEL, { private: false, subject: team }),
    );

    expect([plain.status, errorOf(plain)]).toEqual([422, "invalid"]);

    const asked = await send(
      org,
      "/agents",
      org.alice,
      "POST",
      agentBody("alices", SHARED_MODEL, { private: false }),
    );

    expect(created(asked).private).toBe(true);

    // Alice's private model is not the org's.
    const notShared = await send(
      org,
      "/agents",
      org.admin,
      "POST",
      agentBody("support", PRIVATE_MODEL, { subject: team }),
    );

    expect([notShared.status, errorOf(notShared)]).toEqual([422, "unknown_model"]);

    const unknownToolkit = await send(
      org,
      "/agents",
      org.admin,
      "POST",
      agentBody("support", SHARED_MODEL, {
        subject: team,
        tool_scope: [{ toolkit: "no-such-toolkit", tools: { kind: "all" as const } }],
      }),
    );

    expect([
      unknownToolkit.status,
      errorOf(unknownToolkit),
      (unknownToolkit.body as { path?: string }).path,
    ]).toEqual([422, "unknown_toolkit", "tool_scope"]);

    const support = await send(
      org,
      "/agents",
      org.admin,
      "POST",
      agentBody("support", SHARED_MODEL, {
        subject: team,
        tool_scope: [{ toolkit: toolkitId, tools: { kind: "all" as const } }],
      }),
    );

    expect(support.status).toBe(201);
    const agent = created(support);

    expect(agent).toMatchObject({ private: false, grant: { id: expect.any(String) } });

    const usable = async (who: Person) =>
      Schema.decodeUnknownSync(UsableAgents)(
        (await send(org, "/agents/mine", who)).body,
      ).agents.map((entry) => entry.name);

    expect(await usable(org.alice)).toEqual(["alices", "support"]);
    expect(await usable(org.bob)).toEqual([]);

    // The grants on shared agents are for org admins; one more grant reaches bob.
    expect((await send(org, "/grants/agents", org.alice)).status).toBe(403);

    const grant = await send(org, "/grants/agents", org.admin, "POST", {
      subject: { kind: "member", id: org.bob.id },
      agent: agent.id,
    });

    expect(grant.status).toBe(200);
    expect(await usable(org.bob)).toEqual(["support"]);

    // An edit names its revision; disabling it takes it from everyone's reach.
    const stale = await send(
      org,
      `/agents/${agent.id}`,
      org.admin,
      "PATCH",
      { enabled: false },
      {
        "if-match": String(agent.revision + 1),
      },
    );

    expect([stale.status, errorOf(stale)]).toEqual([409, "conflict"]);

    const disabled = await send(
      org,
      `/agents/${agent.id}`,
      org.admin,
      "PATCH",
      { enabled: false },
      {
        "if-match": String(agent.revision),
      },
    );

    expect(disabled.status).toBe(200);
    expect(await usable(org.alice)).toEqual(["alices"]);
  });

  it("reach a team's members while they are in it, and lose the team's grant when it is deleted", async () => {
    const org = await newOrg();

    const made = await send(
      org,
      "/agents",
      org.admin,
      "POST",
      agentBody("research", SHARED_MODEL, { subject: { kind: "team" as const, id: org.teamId } }),
    );

    expect(made.status).toBe(201);

    const usable = async (who: Person) =>
      Schema.decodeUnknownSync(UsableAgents)(
        (await send(org, "/agents/mine", who)).body,
      ).agents.map((entry) => entry.name);

    expect(await usable(org.alice)).toEqual(["research"]);

    // Alice leaves the team: the agent leaves her reach.
    expect(
      (await send(org, `/teams/${org.teamId}/members/${org.alice.id}`, org.admin, "DELETE")).status,
    ).toBe(200);
    expect(await usable(org.alice)).toEqual([]);

    const grants = async () =>
      ((await send(org, "/grants/agents", org.admin)).body as { grants: ReadonlyArray<unknown> })
        .grants;

    expect(await grants()).toHaveLength(1);
    expect((await send(org, `/teams/${org.teamId}`, org.admin, "DELETE")).status).toBe(200);
    expect(await grants()).toEqual([]);
  });

  it("take agent Spend limits, which go with them", async () => {
    const org = await newOrg();

    const made = await send(
      org,
      "/agents",
      org.admin,
      "POST",
      agentBody("reviewer", SHARED_MODEL, { subject: { kind: "everyone" as const } }),
    );

    expect(made.status).toBe(201);
    const agent = created(made);

    const limit = await send(org, "/spend/limits", org.admin, "POST", {
      kind: "agent",
      subject: agent.id,
      period: "day",
      amount_micros: 5_000_000,
    });

    expect(limit.status).toBe(201);
    expect(limit.body).toMatchObject({ kind: "agent", subject: agent.id, label: "reviewer" });

    const removed = await send(org, `/agents/${agent.id}`, org.admin, "DELETE", undefined, {
      "if-match": String(agent.revision),
    });

    expect(removed.body).toEqual({ id: agent.id, removed: true });

    const overview = (await send(org, "/spend", org.admin)).body as {
      limits: ReadonlyArray<{ kind: string }>;
    };

    expect(overview.limits.filter((entry) => entry.kind === "agent")).toEqual([]);
  });

  it("are in the org's export, with their grants", async () => {
    const org = await newOrg();

    await send(
      org,
      "/agents",
      org.admin,
      "POST",
      agentBody("exported", SHARED_MODEL, { subject: { kind: "team" as const, id: org.teamId } }),
    );

    const exported = (await send(org, "/export", org.admin)).body as {
      agents: ReadonlyArray<Record<string, unknown>>;
    };

    expect(exported.agents).toEqual([
      expect.objectContaining({ name: "exported", private: false, grants: [{ team: "Research" }] }),
    ]);
  });
});
