// Toolkits through the management API (#196): the app Worker's router, the Access gate and the role table, the real
// ControlPlane with the Tools part, and fake remote MCP servers served in workerd. An org admin adds an org toolkit and
// connects its shared credential, members keep their private toolkits and credentials to themselves, a source the
// outbound guard refuses is refused on save, and private credentials follow the org's setting.
import { describe, expect, it, afterAll } from "vitest";
import { Schema } from "effect";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import { ToolkitsList, ToolkitView, ToolsList, ToolView } from "@commissary/contract/tools";
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
  readonly slug: string;
  readonly platform: string;
  readonly admin: Person;
  readonly alice: Person;
  readonly bob: Person;
}

const send = async (
  org: Pick<Org, "slug">,
  path: string,
  who: Person | string,
  method = "GET",
  body?: Payload,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> => {
  const init = body === undefined ? { method } : jsonInit(method, body);

  return await harness.json(`/v9/management/orgs/${org.slug}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...headers },
    auth: typeof who === "string" ? who : who.auth,
  });
};

/**
 * An org with an org admin and two plain members; `privateCredentials` is the setting chosen at creation, private
 * toolkits are on.
 */
const newOrg = async (privateCredentials = true): Promise<Org> => {
  const slug = `tools-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  const created = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", {
      slug,
      name: slug,
      private_credentials: privateCredentials,
      private_toolkits: true,
    }),
  );

  expect(created.status).toBe(201);

  const org = { slug };

  const person = async (name: string, role: string): Promise<Person> => {
    const email = `${name}-${slug}@example.com`;
    const added = await send(org, "/members", platform, "POST", { email, role });

    expect(added.status).toBe(201);

    return { id: (added.body as { id: string }).id, auth: await token(email) };
  };

  return {
    slug,
    platform,
    admin: await person("admin", "admin"),
    alice: await person("alice", "member"),
    bob: await person("bob", "member"),
  };
};

const origin = () => `https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com`;

const toolkitOf = (reply: { body: unknown }) => Schema.decodeUnknownSync(ToolkitView)(reply.body);

const errorOf = (reply: { body: unknown }) => (reply.body as { error?: string }).error;

const revised = (revision: number) => ({ "if-match": String(revision) });

/** Who a shared credential is connected for (there is no default tool grant, #198). */
const EVERYONE = { kind: "everyone" };

describe("an org toolkit", () => {
  it("is added for a remote MCP server, signed in with a shared bearer token, and lists named, classed tools", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, {
      authorized: (request) => request.headers.get("authorization") === "Bearer gh-token",
      tools: [
        { name: "create_issue", description: "Opens an issue" },
        { name: "search.issues", annotations: { readOnlyHint: true } },
      ],
    });

    const org = await newOrg();

    const added = await send(org, "/toolkits", org.admin, "POST", {
      source: server.url,
      name: "github",
    });

    expect(added.status).toBe(201);

    const toolkit = toolkitOf(added);

    expect(toolkit).toMatchObject({
      name: "github",
      private: false,
      accepts: "shared",
      tool_list: { tools: 0 },
    });

    const connected = await send(
      org,
      `/toolkits/${toolkit.id}/credentials/shared`,
      org.admin,
      "PUT",
      {
        kind: "bearer",
        token: "gh-token",
        subject: EVERYONE,
      },
    );

    expect(connected.status).toBe(200);
    expect(toolkitOf(connected)).toMatchObject({
      credentials: { shared: { kind: "bearer", active: true } },
      tool_list: { tools: 2 },
    });
    // The secret is never answered.
    expect(JSON.stringify(connected.body)).not.toContain("gh-token");

    const listed = await send(org, `/toolkits/${toolkit.id}/tools`, org.admin);

    expect(listed.status).toBe(200);

    const tools = Schema.decodeUnknownSync(ToolsList)(listed.body).tools;

    expect(tools.map((tool) => [tool.id, tool.name, tool.class])).toEqual([
      [`${toolkit.id}:create_issue`, "github_create_issue", "write"],
      [`${toolkit.id}:search.issues`, "github_search_issues", "read"],
    ]);
    expect(
      server.requests.some((request) => request.headers.get("authorization") === "Bearer gh-token"),
    ).toBe(true);

    // Plain members see the org's toolkits and their tools; managing them is for org admins.
    expect((await send(org, `/toolkits/${toolkit.id}/tools`, org.alice)).status).toBe(200);
    expect(
      Schema.decodeUnknownSync(ToolkitsList)(
        (await send(org, "/toolkits", org.alice)).body,
      ).toolkits.map((t) => t.id),
    ).toEqual([toolkit.id]);
    expect(
      (await send(org, `/toolkits/${toolkit.id}`, org.alice, "PATCH", { name: "gh" }, revised(1)))
        .status,
    ).toBe(403);
    expect(
      (
        await send(org, `/toolkits/${toolkit.id}/credentials/shared`, org.alice, "PUT", {
          kind: "none",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(
          org,
          `/toolkits/${toolkit.id}/overrides`,
          org.alice,
          "PUT",
          { tool: "create_issue", hidden: true },
          revised(0),
        )
      ).status,
    ).toBe(403);
    expect(
      (await send(org, `/toolkits/${toolkit.id}`, org.alice, "DELETE", undefined, revised(1)))
        .status,
    ).toBe(403);
  });

  it("shows a plain member its source with the query's values (and value-less names) masked, an org admin the whole URL", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "t" }] });
    const org = await newOrg();
    const source = `${server.url}?team=acme&key=s3cret&t0ken`;

    const added = toolkitOf(
      await send(org, "/toolkits", org.admin, "POST", {
        source,
        name: "kit",
        credential: { kind: "none", subject: EVERYONE },
      }),
    );

    expect(added.source).toBe(source);

    const sourceFor = async (who: Person) =>
      Schema.decodeUnknownSync(ToolkitsList)((await send(org, "/toolkits", who)).body).toolkits[0]
        ?.source;

    expect(await sourceFor(org.admin)).toBe(source);
    expect(await sourceFor(org.alice)).toBe(`${server.url}?team=***&key=***&***`);
    const seen = JSON.stringify((await send(org, "/toolkits", org.alice)).body);

    expect(seen).not.toContain("s3cret");
    expect(seen).not.toContain("t0ken");
  });

  it("takes the slug of its source's host as its default name, and an override renames a tool by stable id", async () => {
    const server = fakeMcpServer("https://mcp.linear.app/mcp", {
      tools: [{ name: "list_issues" }],
    });

    const org = await newOrg();

    const toolkit = toolkitOf(
      await send(org, "/toolkits", org.admin, "POST", {
        source: server.url,
        credential: { kind: "none", subject: EVERYONE },
      }),
    );

    expect(toolkit).toMatchObject({
      name: "linear",
      source: "https://mcp.linear.app/mcp",
      tool_list: { tools: 1 },
    });

    const renamed = await send(
      org,
      `/toolkits/${toolkit.id}/overrides`,
      org.admin,
      "PUT",
      { tool: "list_issues", name: "issues", class: "read" },
      revised(0),
    );

    expect(renamed.status).toBe(200);
    expect(Schema.decodeUnknownSync(ToolView)(renamed.body)).toMatchObject({
      id: `${toolkit.id}:list_issues`,
      name: "linear_issues",
      class: "read",
      flags: { renamed: true },
      override: { revision: 1 },
    });

    // A stale revision is refused.
    expect(
      errorOf(
        await send(
          org,
          `/toolkits/${toolkit.id}/overrides`,
          org.admin,
          "PUT",
          { tool: "list_issues" },
          revised(0),
        ),
      ),
    ).toBe("conflict");
  });

  it("is refused when the outbound guard refuses its source, and nothing is stored", async () => {
    const org = await newOrg();

    for (const source of [
      "http://mcp.example.com/mcp",
      "https://10.0.0.5/mcp",
      "https://[fd00::1]/mcp",
      "https://169.254.169.254/latest",
      "https://commissary.test/mcp",
    ]) {
      const refused = await send(org, "/toolkits", org.admin, "POST", { source, name: "nope" });

      expect(refused).toMatchObject({
        status: 422,
        body: { error: OUTBOUND_REFUSED_MESSAGE, path: "source" },
      });
    }

    expect(
      Schema.decodeUnknownSync(ToolkitsList)((await send(org, "/toolkits", org.admin)).body)
        .toolkits,
    ).toEqual([]);
  });
});

describe("a private toolkit", () => {
  it("is its member's alone: another member reaches nothing of it, an org admin only that it exists", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, {
      authorized: (request) => request.headers.get("authorization") === "Bearer alice-secret",
      tools: [{ name: "notes" }],
    });

    const org = await newOrg();

    const added = await send(org, "/toolkits", org.alice, "POST", {
      source: server.url,
      name: "mine",
      credential: { kind: "bearer", token: "alice-secret" },
    });

    expect(added.status).toBe(201);

    const toolkit = toolkitOf(added);

    expect(toolkit).toMatchObject({
      private: true,
      accepts: "private",
      credentials: { mine: { kind: "bearer" } },
      tool_list: { tools: 1 },
    });

    // Bob: nothing.
    expect(
      Schema.decodeUnknownSync(ToolkitsList)((await send(org, "/toolkits", org.bob)).body),
    ).toEqual({ toolkits: [] });

    for (const [method, path, body, headers] of [
      ["GET", `/toolkits/${toolkit.id}/tools`, undefined, {}],
      ["PATCH", `/toolkits/${toolkit.id}`, { name: "bobs" }, revised(1)],
      ["DELETE", `/toolkits/${toolkit.id}`, undefined, revised(1)],
      ["PUT", `/toolkits/${toolkit.id}/credentials/private`, { kind: "none" }, {}],
      ["DELETE", `/toolkits/${toolkit.id}/credentials/private`, undefined, {}],
      ["POST", `/toolkits/${toolkit.id}/refresh`, undefined, {}],
      ["PUT", `/toolkits/${toolkit.id}/overrides`, { tool: "notes", hidden: true }, revised(0)],
    ] as const)
      expect((await send(org, path, org.bob, method, body, headers)).status).toBe(404);

    // The org admin: existence only, and they may remove it.
    const seen = Schema.decodeUnknownSync(ToolkitsList)(
      (await send(org, "/toolkits", org.admin)).body,
    );

    expect(seen.toolkits).toEqual([]);
    expect(seen.others).toEqual([
      {
        id: toolkit.id,
        private: true,
        limited: true,
        owner: { member_id: org.alice.id, email: `alice-${org.slug}@example.com` },
        created_at: toolkit.created_at,
        revision: 1,
      },
    ]);
    expect(JSON.stringify(seen)).not.toContain(server.url);
    expect((await send(org, `/toolkits/${toolkit.id}/tools`, org.admin)).status).toBe(404);
    expect(
      (await send(org, `/toolkits/${toolkit.id}`, org.admin, "PATCH", { name: "x" }, revised(1)))
        .status,
    ).toBe(404);

    // Alice renames it; the admin removes it at the revision the list shows them.
    expect(
      (
        await send(
          org,
          `/toolkits/${toolkit.id}`,
          org.alice,
          "PATCH",
          { name: "notes" },
          revised(1),
        )
      ).status,
    ).toBe(200);

    const revision = Schema.decodeUnknownSync(ToolkitsList)(
      (await send(org, "/toolkits", org.admin)).body,
    ).others?.[0]?.revision;

    expect(revision).toBe(2);
    expect(
      errorOf(
        await send(org, `/toolkits/${toolkit.id}`, org.admin, "DELETE", undefined, revised(1)),
      ),
    ).toBe("conflict");
    expect(
      (await send(org, `/toolkits/${toolkit.id}`, org.admin, "DELETE", undefined, revised(2)))
        .status,
    ).toBe(200);
    expect((await send(org, "/toolkits", org.alice)).body).toEqual({ toolkits: [] });
  });

  it("may not take an org toolkit's name, nor the name of another of its member's", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`);
    const org = await newOrg();

    expect(
      (await send(org, "/toolkits", org.admin, "POST", { source: server.url, name: "linear" }))
        .status,
    ).toBe(201);
    expect(
      (await send(org, "/toolkits", org.alice, "POST", { source: server.url, name: "notes" }))
        .status,
    ).toBe(201);
    expect(
      errorOf(
        await send(org, "/toolkits", org.alice, "POST", { source: server.url, name: "linear" }),
      ),
    ).toBe("name_taken");
    expect(
      errorOf(
        await send(org, "/toolkits", org.alice, "POST", { source: server.url, name: "notes" }),
      ),
    ).toBe("name_taken");
    expect(
      (await send(org, "/toolkits", org.bob, "POST", { source: server.url, name: "notes" })).status,
    ).toBe(201);
  });
});

describe("private credentials on toolkits", () => {
  it("follow the org's private credentials setting, as they do in Models", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, {
      authorized: (request) => request.headers.get("authorization") === "Bearer alice-own",
      tools: [{ name: "t" }],
    });

    const org = await newOrg(false);

    const toolkit = toolkitOf(
      await send(org, "/toolkits", org.admin, "POST", {
        source: server.url,
        name: "kit",
        accepts: "private",
      }),
    );

    const credential = { kind: "bearer", token: "alice-own" };
    const path = `/toolkits/${toolkit.id}/credentials/private`;

    expect(await send(org, path, org.alice, "PUT", credential)).toMatchObject({
      status: 403,
      body: { error: "private_credentials_unavailable" },
    });

    expect(
      (await send(org, "/membership", org.admin, "PATCH", { private_credentials: true })).status,
    ).toBe(200);

    const connected = toolkitOf(await send(org, path, org.alice, "PUT", credential));

    expect(connected).toMatchObject({
      credentials: { mine: { kind: "bearer", active: true } },
      tool_list: { tools: 1 },
    });
    // An org admin sees that a member connected one, nothing more.
    expect(
      Schema.decodeUnknownSync(ToolkitsList)((await send(org, "/toolkits", org.admin)).body)
        .toolkits[0],
    ).toMatchObject({ credentials: { private_count: 1 } });

    expect(
      (await send(org, "/membership", org.admin, "PATCH", { private_credentials: false })).status,
    ).toBe(200);

    const off = Schema.decodeUnknownSync(ToolkitsList)(
      (await send(org, "/toolkits", org.alice)).body,
    ).toolkits[0];

    expect(off?.credentials.mine).toMatchObject({ active: false });
    expect(errorOf(await send(org, `/toolkits/${toolkit.id}/refresh`, org.alice, "POST"))).toBe(
      "no_credential",
    );
  });
});

describe("a private credential on an org toolkit", () => {
  it("is its owner's alone: another member neither sees nor removes it, an org admin only counts it", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "t" }] });
    const org = await newOrg();

    const toolkit = toolkitOf(
      await send(org, "/toolkits", org.admin, "POST", {
        source: server.url,
        name: "kit",
        accepts: "both",
      }),
    );

    const path = `/toolkits/${toolkit.id}/credentials/private`;

    expect(
      (await send(org, path, org.alice, "PUT", { kind: "bearer", token: "alice-key" })).status,
    ).toBe(200);

    const viewOf = async (who: Person) =>
      Schema.decodeUnknownSync(ToolkitsList)((await send(org, "/toolkits", who)).body).toolkits[0];

    expect((await viewOf(org.bob))?.credentials).toEqual({});
    expect(errorOf(await send(org, path, org.bob, "DELETE"))).toBe("not_found");
    expect((await viewOf(org.alice))?.credentials.mine).toMatchObject({ kind: "bearer" });
    expect((await viewOf(org.admin))?.credentials).toEqual({ private_count: 1 });
    expect(JSON.stringify((await send(org, "/toolkits", org.admin)).body)).not.toContain(
      "alice-key",
    );
  });
});

describe("prices and Spend limits (#199)", () => {
  it("prices an org toolkit and its tools through the routes, and limits its shared credential's Spend", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "search" }] });
    const org = await newOrg();

    const added = toolkitOf(
      await send(org, "/toolkits", org.admin, "POST", {
        source: server.url,
        name: "web",
        credential: { kind: "none", subject: EVERYONE },
      }),
    );

    const priced = await send(
      org,
      `/toolkits/${added.id}`,
      org.admin,
      "PATCH",
      { price_micros: 2_500 },
      revised(added.revision),
    );

    expect(priced.status).toBe(200);
    expect(toolkitOf(priced).price_micros).toBe(2_500);

    const tool = await send(
      org,
      `/toolkits/${added.id}/overrides`,
      org.admin,
      "PUT",
      { tool: "search", price_micros: 4_000 },
      revised(0),
    );

    expect(Schema.decodeUnknownSync(ToolView)(tool.body)).toMatchObject({
      price_micros: 4_000,
      override: { price_micros: 4_000 },
    });

    const cleared = await send(
      org,
      `/toolkits/${added.id}`,
      org.admin,
      "PATCH",
      { price_micros: null },
      revised(toolkitOf(priced).revision),
    );

    expect(toolkitOf(cleared).price_micros).toBeUndefined();
    expect(
      errorOf(
        await send(
          org,
          `/toolkits/${added.id}`,
          org.admin,
          "PATCH",
          { price_micros: 0.5 },
          revised(toolkitOf(cleared).revision),
        ),
      ),
    ).toBe("invalid");

    // The toolkit's shared credential takes a Spend limit, named by the toolkit's id; it goes with the credential.
    const limit = await send(org, "/spend/limits", org.admin, "POST", {
      kind: "toolkit_credential",
      subject: added.id,
      period: "day",
      amount_micros: 1_000_000,
    });

    expect(limit.status).toBe(201);
    expect(limit.body).toMatchObject({
      kind: "toolkit_credential",
      subject: added.id,
      label: "web",
    });
    expect(
      errorOf(
        await send(org, "/spend/limits", org.admin, "POST", {
          kind: "toolkit_credential",
          subject: "tk_nope",
          period: "day",
          amount_micros: 1,
        }),
      ),
    ).toBe("subject_not_found");

    const limits = async () =>
      (
        (await send(org, "/spend", org.admin)).body as {
          readonly limits: ReadonlyArray<{ readonly kind: string }>;
        }
      ).limits.map((entry) => entry.kind);

    expect(await limits()).toEqual(["toolkit_credential"]);
    expect(
      (await send(org, `/toolkits/${added.id}/credentials/shared`, org.admin, "DELETE")).status,
    ).toBe(200);
    expect(await limits()).toEqual([]);
  });

  it("refuses a price on a private toolkit", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "t" }] });
    const org = await newOrg();

    const mine = toolkitOf(
      await send(org, "/toolkits", org.alice, "POST", {
        source: server.url,
        name: "mine",
        credential: { kind: "none" },
      }),
    );

    const refused = await send(
      org,
      `/toolkits/${mine.id}`,
      org.alice,
      "PATCH",
      { price_micros: 1 },
      revised(mine.revision),
    );

    expect(refused.status).toBe(422);
    expect(errorOf(refused)).toBe("invalid");
  });
});

describe("the org export", () => {
  it("holds the toolkits the caller reaches, with what kind of credential they have, their grants and never a secret", async () => {
    const server = fakeMcpServer(`${origin()}/mcp`, { tools: [{ name: "t" }] });
    const org = await newOrg();

    const toolkit = toolkitOf(
      await send(org, "/toolkits", org.admin, "POST", {
        source: server.url,
        name: "kit",
        credential: {
          kind: "header",
          name: "X-Api-Key",
          value: "export-secret",
          subject: EVERYONE,
        },
      }),
    );

    await send(
      org,
      `/toolkits/${toolkit.id}/overrides`,
      org.admin,
      "PUT",
      { tool: "t", hidden: true },
      revised(0),
    );

    expect(
      (
        await send(org, "/grants/tools", org.admin, "POST", {
          subject: { kind: "member", id: org.alice.id },
          toolkit: toolkit.id,
          tools: { kind: "named", ids: [`${toolkit.id}:t`] },
        })
      ).status,
    ).toBe(200);

    const exported = await send(org, "/export", org.platform);

    expect(exported.status).toBe(200);
    expect((exported.body as { toolkits: unknown }).toolkits).toEqual([
      {
        name: "kit",
        kind: "mcp",
        source: server.url,
        private: false,
        accepts: "shared",
        credentials: [{ slot: "shared", kind: "header", name: "X-Api-Key" }],
        overrides: [{ tool: "t", hidden: true }],
        // Subjects by what a person reads, tools by upstream name.
        grants: [
          { subject: { kind: "everyone" }, tools: { kind: "all" }, updated_at: expect.any(String) },
          {
            subject: { kind: "member", email: `alice-${org.slug}@example.com` },
            tools: { kind: "named", tools: ["t"] },
            updated_at: expect.any(String),
          },
        ],
      },
    ]);
    expect(JSON.stringify(exported.body)).not.toContain("export-secret");
  });
});
