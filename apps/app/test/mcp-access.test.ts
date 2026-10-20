// The MCP endpoint on the app host of a self-hosted Commissary (#251, ADR 0045): behind the deployment's Access
// application, which signs MCP clients in (with Managed OAuth, or a `cloudflared` token or a service token without it),
// so a request comes with an Access JWT (`Cf-Access-Jwt-Assertion`) and is served as its member, with their whole reach
// narrowed by `?toolkits=`; an Access service token is served as its registered role's principal. `/o/<slug>/mcp` is an
// org's endpoint, bare `/mcp` the org `global`'s. The app Worker's Access gate with a fake JWKS, the MCP routes it
// mounts, the real ControlPlane and a Platform registry of the file's own, and fake upstream MCP servers.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, describe, expect, it } from "vitest";
import { AUD, fakeJwksLayer, makeFakeJwks } from "@commissary/auth/testing";
import { GLOBAL_ORG, newOrgId, type OrgId } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import { fakeMcpServer, serveFakeMcpServers } from "@commissary/tools/testing";
import { makeAccessLayer, makeWithAccess } from "../src/access/layer.ts";
import { AppMcpRoutes } from "../src/http/mcp.ts";
import { RootRoutes } from "../src/http/routes.ts";
import worker from "../src/index.ts";
import { requestContext } from "../src/worker-env.ts";
import { isolatedPlatform, key, serviceToken, token } from "./support/management.ts";

serveFakeMcpServers();

const POLICY = { ownHosts: [], localDevelopment: false };

const registry = isolatedPlatform();

/** A self-hosted Commissary behind Access: the team and the application's AUD the fake JWKS signs for. */
const accessEnv = {
  ...env,
  ...registry.bindings,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  PLATFORM_ADMIN_EMAILS: "",
  PLATFORM_ADMIN_SERVICE_TOKENS: "",
  ACCESS_DEV_BYPASS: "",
};

const access = makeAccessLayer(fakeJwksLayer(makeFakeJwks([key])));

const web = HttpRouter.toWebHandler(
  Layer.mergeAll(RootRoutes, access, makeWithAccess(access)(AppMcpRoutes)),
  { disableLogger: true },
);

afterAll(web.dispose);

const ctx = {} as unknown as ExecutionContext;

const HOST = "https://commissary.test";

const OWNER = { role: "owner", sensitive: true } as const;

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown> | undefined;
}

/** One JSON-RPC message POSTed to `path` of the app host, with `headers`. */
const send = async (
  path: string,
  message: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Answer> => {
  const url = `${HOST}${path}`;

  const response = await web.handler(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
    }),
    requestContext(accessEnv, ctx, url),
  );

  const text = await response.text();

  return {
    status: response.status,
    headers: response.headers,
    body: text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>),
  };
};

const signedIn = async (email: string) => ({ "cf-access-jwt-assertion": await token(email) });

const LIST = { method: "tools/list", params: {} };

const namesIn = (answer: Answer): ReadonlyArray<unknown> => {
  // SAFETY: read from a test's answer; one without a list fails the assertion that reads it.
  const result = answer.body?.["result"] as
    | { tools?: ReadonlyArray<{ name: unknown }> }
    | undefined;

  return (result?.tools ?? []).map((tool) => tool.name);
};

/** Makes `email` a member of `org` with `role`. */
const addMember = async (org: OrgId, email: string, role: "admin" | "member") => {
  const added = await controlPlaneOf(env, org).addMember({ email, role }, OWNER, "test");

  if (!added.ok) throw new Error(added.message);

  return { id: added.value.id, email };
};

/**
 * An org of its own in the file's registry, where members hold private credentials and toolkits: an admin, alice and
 * bob; `linear`, an org toolkit that takes shared and private credentials (with a shared one that needs no sign-in,
 * granted to the admin), and alice's private `notes`, signed in with her token. Its endpoint is `/o/<slug>/mcp`.
 */
const toolkitsOrg = async () => {
  const org = newOrgId();
  const plane = controlPlaneOf(env, org);
  const slug = `mcp-${crypto.randomUUID().slice(0, 8)}`;

  await plane.setMembershipSettings({ privateCredentials: true, privateToolkits: true });
  const created = await registry.platform.createOrg({ slug, name: slug, id: org }, Date.now());

  if (!created.ok) throw new Error(created.message);

  const admin = await addMember(org, `admin-${slug}@example.com`, "admin");
  const alice = await addMember(org, `alice-${slug}@example.com`, "member");
  const bob = await addMember(org, `bob-${slug}@example.com`, "member");
  const tools = plane.tools();

  const linear = fakeMcpServer(`https://linear-${slug}.example.com/mcp`, {
    tools: [{ name: "list_issues", annotations: { readOnlyHint: true } }],
  });

  const notes = fakeMcpServer(`https://notes-${slug}.example.com/mcp`, {
    authorized: (request) => request.headers.get("authorization") === "Bearer alice-notes",
    tools: [{ name: "add_note" }],
  });

  const added = async (
    by: { readonly id: string },
    admin_: boolean,
    input: Parameters<typeof tools.addToolkit>[1],
  ) => {
    const toolkit = await tools.addToolkit({ member: by.id, admin: admin_ }, input, "test", POLICY);

    if (!toolkit.ok) throw new Error(toolkit.message);

    return toolkit.value.id;
  };

  const linearId = await added(admin, true, {
    source: linear.url,
    name: "linear",
    private: false,
    accepts: "both",
    credential: { kind: "none", subject: { kind: "member", id: admin.id } },
  });

  await added(alice, false, {
    source: notes.url,
    name: "notes",
    private: true,
    accepts: "private",
    credential: { kind: "bearer", token: "alice-notes" },
  });

  return { org, slug, path: `/o/${slug}/mcp`, plane, admin, alice, bob, notes, linearId };
};

describe("the MCP endpoint on the app host of a self-hosted Commissary", () => {
  it("serves a member signed in through Access their whole reach in the org its address names, narrowed by ?toolkits=", async () => {
    const { path, alice, bob } = await toolkitsOrg();

    const alices = await send(path, LIST, await signedIn(alice.email));

    expect(alices.status).toBe(200);
    expect(namesIn(alices)).toEqual(["linear_list_issues", "notes_add_note"]);

    const narrowed = await send(`${path}/?toolkits=Notes`, LIST, await signedIn(alice.email));

    expect(namesIn(narrowed)).toEqual(["notes_add_note"]);

    // Another member: the org toolkit, never alice's private one.
    expect(namesIn(await send(path, LIST, await signedIn(bob.email)))).toEqual([
      "linear_list_issues",
    ]);
  });

  it("calls a tool as the member, on their own credential", async () => {
    const { path, alice, notes } = await toolkitsOrg();

    const called = await send(
      path,
      { method: "tools/call", params: { name: "notes_add_note", arguments: { text: "hi" } } },
      await signedIn(alice.email),
    );

    expect(called.status).toBe(200);
    expect(called.body?.["result"]).not.toHaveProperty("isError", true);

    const upstream = notes.requests.filter((request) => request.rpc === "tools/call");

    expect(upstream.map((request) => request.params?.["name"])).toEqual(["add_note"]);
    expect(upstream[0]?.headers.get("authorization")).toBe("Bearer alice-notes");
  });

  it("serves the org global at bare /mcp", async () => {
    const plane = controlPlaneOf(env, GLOBAL_ORG);
    const email = `carol-${crypto.randomUUID().slice(0, 8)}@example.com`;

    await plane.setMembershipSettings({ privateCredentials: true, privateToolkits: true });
    const carol = await addMember(GLOBAL_ORG, email, "member");

    const server = fakeMcpServer(`https://global-${carol.id}.example.com/mcp`, {
      tools: [{ name: "lookup" }],
    });

    const added = await plane.tools().addToolkit(
      { member: carol.id, admin: false },
      {
        source: server.url,
        name: "mine",
        private: true,
        accepts: "private",
        credential: { kind: "none" },
      },
      "test",
      POLICY,
    );

    if (!added.ok) throw new Error(added.message);

    expect(namesIn(await send("/mcp", LIST, await signedIn(email)))).toEqual(["mine_lookup"]);
  });

  it("refuses a request without an Access sign-in with 401, a Bearer challenge and where to sign in", async () => {
    const { path } = await toolkitsOrg();

    for (const at of [path, "/mcp"])
      for (const headers of [{}, { "cf-access-jwt-assertion": "eyJhbGciOiJSUzI1NiJ9.e30.c2ln" }]) {
        const refused = await send(at, LIST, headers);

        expect(refused.status, at).toBe(401);
        expect(refused.headers.get("www-authenticate")).toBe("Bearer");
        expect(refused.body).toEqual({ error: "Sign in through Access" });
      }
  });

  it("refuses a live management key, even beside an Access sign-in", async () => {
    const { path, plane, admin } = await toolkitsOrg();

    const issued = await plane.createManagementKey(
      { name: "script", role: "admin", createdBy: "test" },
      Date.now(),
    );

    if (!issued.ok) throw new Error(issued.message);

    for (const at of [path, "/mcp"]) {
      const refused = await send(at, LIST, {
        ...(await signedIn(admin.email)),
        authorization: `Bearer ${issued.value.key}`,
      });

      expect(refused.status, at).toBe(401);
      expect(refused.headers.get("www-authenticate")).toBe("Bearer");
      expect(refused.body).toEqual({ error: "Sign in through Access" });
    }
  });

  it("refuses a person outside the org its address names", async () => {
    const a = await toolkitsOrg();
    const b = await toolkitsOrg();

    expect((await send(b.path, LIST, await signedIn(a.alice.email))).status).toBe(403);
    expect((await send(a.path, LIST, await signedIn("stranger@example.com"))).status).toBe(403);
    expect((await send("/o/no-such-org/mcp", LIST, await signedIn(a.alice.email))).status).toBe(
      403,
    );
  });

  it("serves an Access service token as its registered role's principal", async () => {
    const { path, plane, linearId } = await toolkitsOrg();
    const clientId = `${crypto.randomUUID().slice(0, 8)}.access`;

    const registered = await plane.registerServiceToken(
      { clientId, role: "member" },
      OWNER,
      "test",
    );

    if (!registered.ok) throw new Error(registered.message);
    const asToken = { "cf-access-jwt-assertion": await serviceToken(clientId) };

    // No member: no private credential or toolkit, and no grant names it yet.
    const before = await send(path, LIST, asToken);

    expect(before.status).toBe(200);
    expect(namesIn(before)).toEqual([]);

    const granted = await plane.tools().writeGrant(
      {
        revision: 0,
        value: { subject: { kind: "everyone" }, toolkit: linearId, tools: { kind: "all" } },
      },
      "test",
    );

    if (!granted.ok) throw new Error(granted.message);

    expect(namesIn(await send(path, LIST, asToken))).toEqual(["linear_list_issues"]);

    const unknown = await serviceToken(`${crypto.randomUUID().slice(0, 8)}.access`);

    expect((await send(path, LIST, { "cf-access-jwt-assertion": unknown })).status).toBe(403);
  });

  it("refuses a request from another origin and a body that is not JSON, as the panel's writes", async () => {
    const { path, alice } = await toolkitsOrg();
    const headers = await signedIn(alice.email);

    expect(
      (await send(path, LIST, { ...headers, origin: "https://evil.example.com" })).status,
    ).toBe(403);
    expect((await send(path, LIST, { ...headers, "sec-fetch-site": "same-site" })).status).toBe(
      403,
    );
    expect((await send(path, LIST, { ...headers, "content-type": "text/plain" })).status).toBe(415);
  });
});

describe("the app Worker", () => {
  it("mounts the MCP endpoint at /mcp and /o/<slug>/mcp (the dev bypass signs the request in on localhost)", async () => {
    for (const path of ["/mcp", "/o/default/mcp"]) {
      const execution = createExecutionContext();

      // SAFETY: the default export reads no `cf` property of the request; workerd's own requests carry them.
      const request = new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      }) as Request<unknown, IncomingRequestCfProperties>;

      const response = await worker.fetch(request, env, execution);

      await waitOnExecutionContext(execution);

      expect(response.status, path).toBe(200);
      expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
    }
  });
});
