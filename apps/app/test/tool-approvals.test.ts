// Approval rules and pending approvals of tool calls (#201, ADR 0038) through the app Worker's router, the Access gate
// and the real ControlPlane, against a fake remote MCP server: org admins set rules on org toolkits and members on their
// own private toolkits (`PATCH /toolkits/:id`, `approval_rules`); `/approvals` shows a pending approval to its eligible
// approvers with its arguments, to its caller without them, and to nobody else, and only an eligible approver decides
// it, never its caller under a team or list rule. The calls themselves are made on the ControlPlane, as the MCP
// endpoint makes them (it is the API Worker's).
import { assert, describe as effectDescribe, it as effectIt } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { afterAll, describe, expect, it } from "vitest";
import { ManagementApi } from "@commissary/contract/api";
import { ManagementError } from "@commissary/contract/errors";
import { OrgId } from "@commissary/core";
import { fakeMcpServer, serveFakeMcpServers } from "@commissary/tools/testing";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";

serveFakeMcpServers();

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

type Payload = Parameters<typeof jsonInit>[1];

interface Person {
  readonly id: string;
  readonly auth: string;
}

interface Org {
  readonly id: OrgId;
  readonly slug: string;
  readonly admin: Person;
  readonly alice: Person;
  readonly bob: Person;
  readonly carol: Person;
}

const send = async (
  org: Pick<Org, "slug">,
  path: string,
  who: Person,
  method = "GET",
  body?: Payload,
  revision?: number,
): Promise<{ status: number; body: unknown }> => {
  const init = body === undefined ? { method } : jsonInit(method, body);

  return await harness.json(`/v9/management/orgs/${org.slug}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...(revision === undefined ? {} : { "if-match": String(revision) }),
    },
    auth: who.auth,
  });
};

/** An org with an org admin and three plain members, private toolkits allowed. */
const newOrg = async (): Promise<Org> => {
  const slug = `approvals-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  const created = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", { slug, name: slug, private_toolkits: true }),
  );

  expect(created.status).toBe(201);

  const person = async (name: string, role: string): Promise<Person> => {
    const email = `${name}-${slug}@example.com`;

    const added = await harness.json(`/v9/management/orgs/${slug}/members`, {
      ...jsonInit("POST", { email, role }),
      auth: platform,
    });

    expect(added.status).toBe(201);

    return { id: (added.body as { id: string }).id, auth: await token(email) };
  };

  return {
    id: OrgId.make((created.body as { id: string }).id),
    slug,
    admin: await person("admin", "admin"),
    alice: await person("alice", "member"),
    bob: await person("bob", "member"),
    carol: await person("carol", "member"),
  };
};

const server = () =>
  fakeMcpServer(`https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`, {
    tools: [{ name: "create_issue" }, { name: "list_issues", annotations: { readOnlyHint: true } }],
  });

interface ToolkitBody {
  readonly id: string;
  readonly revision: number;
  readonly approval_rules?: unknown;
}

/** An org toolkit `github` whose shared credential everyone may use. */
const orgToolkit = async (org: Org): Promise<ToolkitBody> => {
  const added = await send(org, "/toolkits", org.admin, "POST", {
    source: server().url,
    name: "github",
    credential: { kind: "none", subject: { kind: "everyone" } },
  });

  expect(added.status).toBe(201);

  return added.body as ToolkitBody;
};

/** A pending approval of alice's call of `github_create_issue` with `args`, made as the MCP endpoint makes it. */
const pendingCall = async (org: Org, args: Record<string, string>): Promise<string> => {
  const outcome = await env.CONTROL_PLANE.getByName(org.id).tools().callTool(
    { member: org.alice.id, admin: false },
    {
      name: "github_create_issue",
      arguments: args,
      principalId: "user:alice",
      approvalOutcomes: true,
    },
    { ownHosts: [], localDevelopment: false },
  );

  if (outcome.outcome !== "pending") throw new Error(`the call came to ${outcome.outcome}`);

  return outcome.approval.id;
};

/** An org whose `github` write tools wait for the team `ops`, which alice and bob are in. */
const teamOrg = async () => {
  const org = await newOrg();
  const toolkit = await orgToolkit(org);
  const team = await send(org, "/teams", org.admin, "POST", { name: "ops" });

  expect(team.status).toBe(201);
  const teamId = (team.body as { id: string }).id;

  for (const member of [org.alice, org.bob])
    expect(
      (await send(org, `/teams/${teamId}/members`, org.admin, "POST", { member_id: member.id }))
        .status,
    ).toBe(200);

  const ruled = await send(
    org,
    `/toolkits/${toolkit.id}`,
    org.admin,
    "PATCH",
    { approval_rules: { writes: { approver: { kind: "team", id: teamId } } } },
    toolkit.revision,
  );

  expect(ruled.status).toBe(200);

  return { org, toolkit: ruled.body as ToolkitBody, team: teamId };
};

describe("approval rules on a toolkit", () => {
  it("are set by an org admin on an org toolkit and shown to members; a plain member may not", async () => {
    const { org, toolkit, team } = await teamOrg();

    expect(toolkit.approval_rules).toEqual({
      writes: { approver: { kind: "team", id: team } },
    });

    const listed = await send(org, "/toolkits", org.alice);

    expect(
      (listed.body as { toolkits: ReadonlyArray<ToolkitBody> }).toolkits.find(
        (each) => each.id === toolkit.id,
      ),
    ).toMatchObject({
      approval_rules: { writes: { approver: { kind: "team", id: team } } },
    });

    const refused = await send(
      org,
      `/toolkits/${toolkit.id}`,
      org.alice,
      "PATCH",
      { approval_rules: null },
      toolkit.revision,
    );

    expect(refused).toMatchObject({ status: 403, body: { error: "forbidden" } });
  });

  it("are set by a member on their own private toolkit", async () => {
    const org = await newOrg();

    const added = await send(org, "/toolkits", org.alice, "POST", {
      source: server().url,
      name: "mine",
    });

    expect(added.status).toBe(201);
    const own = added.body as ToolkitBody;

    const ruled = await send(
      org,
      `/toolkits/${own.id}`,
      org.alice,
      "PATCH",
      { approval_rules: { tools: [{ id: `${own.id}:list_issues` }] } },
      own.revision,
    );

    expect(ruled).toMatchObject({
      status: 200,
      body: {
        approval_rules: { tools: [{ id: `${own.id}:list_issues`, approver: { kind: "caller" } }] },
      },
    });

    expect(
      (
        await send(
          org,
          `/toolkits/${own.id}`,
          org.admin,
          "PATCH",
          { approval_rules: null },
          (ruled.body as ToolkitBody).revision,
        )
      ).status,
    ).toBe(404);
  });
});

describe("the pending approvals", () => {
  it("show an approval with its arguments to its eligible approvers, without them to its caller, and to nobody else", async () => {
    const { org } = await teamOrg();
    const id = await pendingCall(org, { title: "rollback" });

    const bobs = await send(org, "/approvals", org.bob);

    expect(bobs).toMatchObject({
      status: 200,
      body: {
        approvals: [
          {
            id,
            status: "pending",
            toolkit: { name: "github" },
            tool: { name: "github_create_issue" },
            caller: { member_id: org.alice.id, email: expect.stringContaining("alice") },
            approver: { kind: "team", name: "ops" },
            arguments: { title: "rollback" },
            can_decide: true,
          },
        ],
      },
    });

    const alices = await send(org, `/approvals/${id}`, org.alice);

    expect(alices).toMatchObject({ status: 200, body: { id, can_decide: false } });
    expect(alices.body).not.toHaveProperty("arguments");

    expect(await send(org, "/approvals", org.carol)).toMatchObject({
      status: 200,
      body: { approvals: [] },
    });
    expect((await send(org, `/approvals/${id}`, org.carol)).status).toBe(404);
    expect((await send(org, `/approvals/${id}`, org.admin)).status).toBe(404);
  });

  it("are decided by an eligible approver only, once, and lose their arguments then", async () => {
    const { org } = await teamOrg();
    const id = await pendingCall(org, { title: "x" });

    expect(
      await send(org, `/approvals/${id}/decision`, org.alice, "POST", { decision: "approve" }),
    ).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(
      (await send(org, `/approvals/${id}/decision`, org.carol, "POST", { decision: "approve" }))
        .status,
    ).toBe(404);

    const approved = await send(org, `/approvals/${id}/decision`, org.bob, "POST", {
      decision: "approve",
    });

    expect(approved).toMatchObject({
      status: 200,
      body: { id, status: "approved", decided_by: expect.any(String), can_decide: false },
    });
    expect(approved.body).not.toHaveProperty("arguments");

    expect(
      await send(org, `/approvals/${id}/decision`, org.bob, "POST", { decision: "deny" }),
    ).toMatchObject({ status: 409, body: { error: "conflict" } });
    expect(
      (await send(org, `/approvals/${id}/decision`, org.bob, "POST", { decision: "maybe" })).status,
    ).toBe(400);
    // Decided: off the pending list.
    expect(await send(org, "/approvals", org.bob)).toMatchObject({ body: { approvals: [] } });
  });
});

/** The generated client of the management contract decodes the same routes, as an eligible approver. */
const fetchAs =
  (org: Org, who: Person): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace("/v9/management", `/v9/management/orgs/${org.slug}`);

    return await harness.call(`${path}${url.search}`, {
      method: request.method,
      headers: request.headers,
      auth: who.auth,
      ...(request.body === null ? {} : { body: await request.text() }),
    });
  };

effectDescribe("approvals contract", () => {
  effectIt.effect("decodes the list, an approval, a decision and its errors", () =>
    Effect.flatMap(
      Effect.promise(async () => {
        const { org } = await teamOrg();

        return { org, id: await pendingCall(org, { title: "contract" }) };
      }),
      ({ org, id }) =>
        Effect.gen(function* () {
          const api = yield* HttpApiClient.make(ManagementApi, {
            baseUrl: "https://commissary.test",
          });

          const list = yield* api.approvals.list();

          assert.deepStrictEqual(list.approvals[0]?.arguments, { title: "contract" });

          const one = yield* api.approvals.get({ params: { id } });

          assert.strictEqual(one.status, "pending");

          const decided = yield* api.approvals.decide({
            params: { id },
            payload: { decision: "deny" },
          });

          assert.strictEqual(decided.status, "denied");

          const again = yield* Effect.flip(
            api.approvals.decide({ params: { id }, payload: { decision: "approve" } }),
          );

          assert.instanceOf(again, ManagementError);
          assert.strictEqual(again.error, "conflict");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              FetchHttpClient.layer,
              Layer.succeed(FetchHttpClient.Fetch, fetchAs(org, org.bob)),
            ),
          ),
        ),
    ),
  );
});
