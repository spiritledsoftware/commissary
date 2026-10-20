// The MCP endpoint on the app host of a self-hosted Commissary (#251, ADR 0045): behind the deployment's Access
// application, whose Managed OAuth signs MCP clients in, so a request comes with the person's Access JWT
// (`Cf-Access-Jwt-Assertion`) and is served as their member, with their whole reach narrowed by `?toolkits=`; an Access
// service token is served as its registered role's principal. The app Worker's Access gate with a fake JWKS, the MCP
// routes it mounts (`@commissary/tools/api`), the real ControlPlane, and fake upstream MCP servers. The request's org is
// the one the Worker gives an unaddressed request (`global`; here an org of each test's own).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Context, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, describe, expect, it } from "vitest";
import { AUD, fakeJwksLayer, makeFakeJwks } from "@commissary/auth/testing";
import { CurrentOrg, newOrgId, type OrgId } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import { McpRoutes } from "@commissary/tools/api";
import { fakeMcpServer, serveFakeMcpServers } from "@commissary/tools/testing";
import { makeAccessLayer, makeWithAccess } from "../src/access/layer.ts";
import { RootRoutes } from "../src/http/routes.ts";
import worker from "../src/index.ts";
import { requestContext } from "../src/worker-env.ts";
import { key, serviceToken, token } from "./support/management.ts";

serveFakeMcpServers();

const POLICY = { ownHosts: [], localDevelopment: false };

/** A self-hosted Commissary behind Access: the team and the application's AUD the fake JWKS signs for. */
const accessEnv = {
  ...env,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  PLATFORM_ADMIN_EMAILS: "",
  PLATFORM_ADMIN_SERVICE_TOKENS: "",
  ACCESS_DEV_BYPASS: "",
};

const access = makeAccessLayer(fakeJwksLayer(makeFakeJwks([key])));

const web = HttpRouter.toWebHandler(
  Layer.mergeAll(RootRoutes, access, makeWithAccess(access)(McpRoutes)),
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

/** One JSON-RPC message POSTed to `path` of the app host in `org`, with `headers`. */
const send = async (
  org: OrgId,
  message: Record<string, unknown>,
  headers: Record<string, string> = {},
  path = "/mcp",
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
    Context.add(requestContext(accessEnv, ctx, url), CurrentOrg, org),
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

/**
 * An org of its own where members hold private credentials: an admin, alice and bob; `linear`, an org toolkit that takes
 * private credentials (its list built with a shared one that needs no sign-in), and alice's private `notes`, signed in
 * with her token.
 */
const toolkitsOrg = async () => {
  const org = newOrgId();
  const plane = controlPlaneOf(env, org);
  const suffix = crypto.randomUUID().slice(0, 8);

  await plane.setMembershipSettings({ privateCredentials: true });

  const member = async (name: string, role: "admin" | "member") => {
    const email = `${name}-${suffix}@example.com`;
    const added = await plane.addMember({ email, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return { id: added.value.id, email };
  };

  const admin = await member("admin", "admin");
  const alice = await member("alice", "member");
  const bob = await member("bob", "member");
  const tools = plane.tools();

  const linear = fakeMcpServer(`https://linear-${suffix}.example.com/mcp`, {
    tools: [{ name: "list_issues", annotations: { readOnlyHint: true } }],
  });

  const notes = fakeMcpServer(`https://notes-${suffix}.example.com/mcp`, {
    authorized: (request) => request.headers.get("authorization") === "Bearer alice-notes",
    tools: [{ name: "add_note" }],
  });

  for (const [by, admin_, input] of [
    [
      admin,
      true,
      {
        source: linear.url,
        name: "linear",
        private: false,
        accepts: "both" as const,
        credential: { kind: "none" as const },
      },
    ],
    [
      alice,
      false,
      {
        source: notes.url,
        name: "notes",
        private: true,
        accepts: "private" as const,
        credential: { kind: "bearer" as const, token: "alice-notes" },
      },
    ],
  ] as const) {
    const added = await tools.addToolkit({ member: by.id, admin: admin_ }, input, "test", POLICY);

    if (!added.ok) throw new Error(added.message);
  }

  return { org, plane, admin, alice, bob, notes };
};

describe("the MCP endpoint on the app host of a self-hosted Commissary", () => {
  it("serves a member signed in through Access their whole reach, narrowed by ?toolkits=", async () => {
    const { org, alice, bob } = await toolkitsOrg();

    const alices = await send(org, LIST, await signedIn(alice.email));

    expect(alices.status).toBe(200);
    expect(namesIn(alices)).toEqual(["linear_list_issues", "notes_add_note"]);

    const narrowed = await send(org, LIST, await signedIn(alice.email), "/mcp?toolkits=Notes");

    expect(namesIn(narrowed)).toEqual(["notes_add_note"]);

    // Another member: the org toolkit, never alice's private one.
    expect(namesIn(await send(org, LIST, await signedIn(bob.email)))).toEqual([
      "linear_list_issues",
    ]);
  });

  it("calls a tool as the member, on their own credential", async () => {
    const { org, alice, notes } = await toolkitsOrg();

    const called = await send(
      org,
      { method: "tools/call", params: { name: "notes_add_note", arguments: { text: "hi" } } },
      await signedIn(alice.email),
    );

    expect(called.status).toBe(200);
    expect(called.body?.["result"]).not.toHaveProperty("isError", true);

    const upstream = notes.requests.filter((request) => request.rpc === "tools/call");

    expect(upstream.map((request) => request.params?.["name"])).toEqual(["add_note"]);
    expect(upstream[0]?.headers.get("authorization")).toBe("Bearer alice-notes");
  });

  it("refuses a request without an Access sign-in with 401 and a Bearer challenge", async () => {
    const { org } = await toolkitsOrg();

    for (const headers of [{}, { "cf-access-jwt-assertion": "eyJhbGciOiJSUzI1NiJ9.e30.c2ln" }]) {
      const refused = await send(org, LIST, headers);

      expect(refused.status).toBe(401);
      expect(refused.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  it("refuses a person who is not a member of the org", async () => {
    const { org } = await toolkitsOrg();

    expect((await send(org, LIST, await signedIn("stranger@example.com"))).status).toBe(403);
  });

  it("serves an Access service token as its registered role's principal", async () => {
    const { org, plane } = await toolkitsOrg();
    const clientId = `${crypto.randomUUID().slice(0, 8)}.access`;

    const registered = await plane.registerServiceToken(
      { clientId, role: "member" },
      OWNER,
      "test",
    );

    if (!registered.ok) throw new Error(registered.message);

    // A service token is no member: it holds no private credential, and shared credentials need grants (#198).
    const served = await send(org, LIST, {
      "cf-access-jwt-assertion": await serviceToken(clientId),
    });

    expect(served.status).toBe(200);
    expect(namesIn(served)).toEqual([]);

    const unknown = await serviceToken(`${crypto.randomUUID().slice(0, 8)}.access`);

    expect((await send(org, LIST, { "cf-access-jwt-assertion": unknown })).status).toBe(403);
  });

  it("refuses a request from another origin and a body that is not JSON, as the panel's writes", async () => {
    const { org, alice } = await toolkitsOrg();
    const headers = await signedIn(alice.email);

    expect((await send(org, LIST, { ...headers, origin: "https://evil.example.com" })).status).toBe(
      403,
    );
    expect((await send(org, LIST, { ...headers, "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await send(org, LIST, { ...headers, "content-type": "text/plain" })).status).toBe(415);
  });
});

describe("the app Worker", () => {
  it("mounts the MCP endpoint (the dev bypass signs the request in on localhost)", async () => {
    const execution = createExecutionContext();

    // SAFETY: the default export reads no `cf` property of the request; workerd's own requests carry them.
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    }) as Request<unknown, IncomingRequestCfProperties>;

    const response = await worker.fetch(request, env, execution);

    await waitOnExecutionContext(execution);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
  });
});
