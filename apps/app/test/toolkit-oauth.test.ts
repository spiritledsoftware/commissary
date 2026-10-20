// OAuth 2 sign-ins to toolkits (#202) through the app Worker: the management routes that start a sign-in, read where it
// stands and set a toolkit's own OAuth app, the callback page, which only the member who started the sign-in gets
// through, and the outbound guard on every URL an admin enters (an OAuth app's, a client credentials grant's token URL), against a fake MCP server and a fake authorization
// server served in workerd.
import { afterAll, describe, expect, it } from "vitest";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import {
  bearerOf,
  fakeAuthServer,
  fakeMcpServer,
  serveFakeMcpServers,
} from "@commissary/tools/testing";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";

serveFakeMcpServers();

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

type Payload = Parameters<typeof jsonInit>[1];

interface Org {
  readonly slug: string;
  readonly admin: string;
  readonly alice: string;
}

const send = async (
  org: Pick<Org, "slug">,
  path: string,
  auth: string,
  method = "GET",
  body?: Payload,
): Promise<{ status: number; body: unknown }> =>
  await harness.json(`/v9/management/orgs/${org.slug}${path}`, {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    auth,
  });

/** An org with an org admin and a plain member. */
const newOrg = async (): Promise<Org> => {
  const slug = `oauth-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  const created = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", { slug, name: slug, private_credentials: true, private_toolkits: true }),
  );

  expect(created.status).toBe(201);

  const person = async (name: string, role: string) => {
    const email = `${name}-${slug}@example.com`;
    const added = await send({ slug }, "/members", platform, "POST", { email, role });

    expect(added.status).toBe(201);

    return await token(email);
  };

  return { slug, admin: await person("admin", "admin"), alice: await person("alice", "member") };
};

const origin = (name: string) => `https://${name}-${crypto.randomUUID().slice(0, 8)}.example.com`;

const EVERYONE = { kind: "everyone" };

/** An org toolkit of an MCP server behind a fake authorization server that registers clients. */
const toolkitBehindOAuth = async (org: Org) => {
  const auth = fakeAuthServer(origin("auth"), { registration: true, iss: true });
  const url = `${origin("mcp")}/mcp`;

  fakeMcpServer(url, {
    tools: [{ name: "echo" }],
    authorized: bearerOf(auth),
    resourceMetadata: { resource: url, authorization_servers: [auth.issuer] },
  });

  const added = await send(org, "/toolkits", org.admin, "POST", {
    source: url,
    name: "kit",
    accepts: "both",
  });

  expect(added.status).toBe(201);

  return { auth, id: (added.body as { id: string }).id };
};

const callbackPath = (back: URL) => `${back.pathname}${back.search}`;

describe("a toolkit's OAuth sign-in through the management API", () => {
  it("starts at the sign-in route, comes back through the callback page, and reads as done", async () => {
    const org = await newOrg();
    const { auth, id } = await toolkitBehindOAuth(org);

    const started = await send(
      org,
      `/toolkits/${id}/credentials/shared/sign-in`,
      org.admin,
      "POST",
      { subject: EVERYONE },
    );

    expect(started.status).toBe(201);
    const { state, url } = started.body as { state: string; url: string };

    // The redirect URI is the callback on the app host; the authorization server takes no CIMD document here.
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(
      "https://commissary.test/oauth/toolkits/callback",
    );
    expect(auth.registrations).toHaveLength(1);

    expect(await send(org, `/toolkits/${id}/sign-in?state=${state}`, org.admin)).toMatchObject({
      status: 200,
      body: { status: "wait" },
    });
    // Only its starter (or an org admin, for the shared credential) reads it.
    expect((await send(org, `/toolkits/${id}/sign-in?state=${state}`, org.alice)).status).toBe(404);

    const back = await auth.authorize(url);
    const page = await harness.call(callbackPath(back), { auth: org.admin });
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Signed in");
    expect(html).not.toContain(state);
    expect(html).not.toContain(back.searchParams.get("code") ?? "");

    expect(await send(org, `/toolkits/${id}/sign-in?state=${state}`, org.admin)).toMatchObject({
      status: 200,
      body: { status: "ok" },
    });

    const listed = await send(org, "/toolkits", org.admin);

    const toolkit = (listed.body as { toolkits: ReadonlyArray<{ id: string }> }).toolkits.find(
      (entry) => entry.id === id,
    );

    expect(toolkit).toMatchObject({
      credentials: { shared: { kind: "oauth", via: "dcr", active: true } },
      tool_list: { tools: 1 },
    });

    // Used once.
    expect((await harness.call(callbackPath(back), { auth: org.admin })).status).toBe(400);
  });

  it("refuses at the callback a state that is forged or another org's", async () => {
    const org = await newOrg();
    const { auth, id } = await toolkitBehindOAuth(org);

    const started = await send(
      org,
      `/toolkits/${id}/credentials/shared/sign-in`,
      org.admin,
      "POST",
      { subject: EVERYONE },
    );

    const back = await auth.authorize((started.body as { url: string }).url);
    const state = back.searchParams.get("state") ?? "";
    const hex = state.split(".").at(-1) ?? "";

    for (const forged of [`org.someone-else.${hex}`, hex, `${state}0`, "not a state"]) {
      const moved = new URL(back);

      moved.searchParams.set("state", forged);

      const page = await harness.call(callbackPath(moved), { auth: org.admin });

      expect(page.status).toBe(400);
      expect(await page.text()).toContain("invalid or has expired");
    }

    // The real one still works.
    expect((await harness.call(callbackPath(back), { auth: org.admin })).status).toBe(200);
  });

  it("refuses the callback to anyone but the member who started the sign-in, and leaves it to them", async () => {
    const org = await newOrg();
    const { auth, id } = await toolkitBehindOAuth(org);
    const outsider = await newOrg();

    for (const [starter, slot, others] of [
      // The shared credential's sign-in: not another org admin's, the platform admin's or a plain member's to finish.
      ["admin", "shared", [org.alice, await token(ADMIN), outsider.admin, false]],
      // A member's private one: not even an org admin's.
      ["alice", "private", [org.admin, outsider.alice, false]],
    ] as const) {
      const started = await send(
        org,
        `/toolkits/${id}/credentials/${slot}/sign-in`,
        org[starter],
        "POST",
        slot === "shared" ? { subject: EVERYONE } : {},
      );

      expect(started.status).toBe(201);
      const { state, url } = started.body as { state: string; url: string };
      const back = await auth.authorize(url);

      for (const other of others) {
        const page = await harness.call(callbackPath(back), { auth: other });

        expect(page.status).toBe(400);
        expect(await page.text()).toContain("invalid or has expired");
      }

      // Still pending: nothing was exchanged, and its starter finishes it.
      expect(await send(org, `/toolkits/${id}/sign-in?state=${state}`, org[starter])).toMatchObject(
        {
          status: 200,
          body: { status: "wait" },
        },
      );

      const page = await harness.call(callbackPath(back), { auth: org[starter] });

      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Signed in");
    }

    const listed = await send(org, "/toolkits", org.alice);

    expect(
      (
        listed.body as { toolkits: ReadonlyArray<{ id: string; credentials: unknown }> }
      ).toolkits.find((entry) => entry.id === id)?.credentials,
    ).toMatchObject({ shared: { kind: "oauth" }, mine: { kind: "oauth" } });
  });
});

describe("the outbound guard on what an admin enters", () => {
  it("refuses an OAuth app's URLs and a client credentials grant's token URL on a private or plain address", async () => {
    const org = await newOrg();
    const url = `${origin("mcp")}/mcp`;

    fakeMcpServer(url, { tools: [{ name: "echo" }] });

    const added = await send(org, "/toolkits", org.admin, "POST", { source: url, name: "kit" });
    const id = (added.body as { id: string }).id;

    const app = {
      client_id: "app",
      client_secret: "app-secret",
      authorize_url: "https://auth.example.com/authorize",
      token_url: "https://auth.example.com/token",
    };

    for (const [field, value] of [
      ["authorize_url", "http://auth.example.com/authorize"],
      ["token_url", "https://10.0.0.1/token"],
      ["token_url", "https://commissary.test/token"],
    ] as const)
      expect(
        await send(org, `/toolkits/${id}/oauth-app`, org.admin, "PUT", { ...app, [field]: value }),
      ).toMatchObject({ status: 422, body: { error: OUTBOUND_REFUSED_MESSAGE, path: field } });

    const set = await send(org, `/toolkits/${id}/oauth-app`, org.admin, "PUT", app);

    expect(set).toMatchObject({
      status: 200,
      body: { oauth_app: { client_id: "app", client_secret: true } },
    });
    expect(JSON.stringify(set.body)).not.toContain("app-secret");
    expect((await send(org, `/toolkits/${id}/oauth-app`, org.alice, "PUT", app)).status).toBe(403);
    expect((await send(org, `/toolkits/${id}/oauth-app`, org.admin, "DELETE")).status).toBe(200);

    const grant = {
      kind: "client_credentials",
      client_id: "machine",
      client_secret: "s",
      token_url: "https://192.168.0.1/token",
      subject: EVERYONE,
    };

    expect(
      await send(org, `/toolkits/${id}/credentials/shared`, org.admin, "PUT", grant),
    ).toMatchObject({ status: 422, body: { error: OUTBOUND_REFUSED_MESSAGE, path: "token_url" } });

    expect(
      await send(org, "/toolkits", org.admin, "POST", {
        source: url,
        name: "kit2",
        credential: grant,
      }),
    ).toMatchObject({
      status: 422,
      body: { error: OUTBOUND_REFUSED_MESSAGE, path: "credential.token_url" },
    });
  });
});
