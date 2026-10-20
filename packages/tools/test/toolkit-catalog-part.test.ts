// A toolkit added from the toolkit catalog (#207) through the Tools part over RPC: it keeps the catalog service and
// source it came from and gets the catalog additions' overrides of its tools; on Commissary Cloud its OAuth sign-ins use
// Commissary Cloud's managed OAuth app with the service (its secret never shown), unless the org gives the toolkit an
// OAuth app of its own, and only a toolkit added from that service's entry does.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AddToolkitInput } from "../src/control-plane-part.ts";
import { SIGN_IN_CALLBACK_PATH } from "../src/oauth/urls.ts";
import {
  MANAGED_AUTH_ORIGIN,
  MANAGED_CLIENT_ID,
  MANAGED_CLIENT_SECRET,
} from "./support/managed-apps.ts";
import { fakeHttpServer } from "./support/http-server.ts";
import { fakeMcpServer, serveFakeMcpServers } from "./support/mcp-server.ts";
import { bearerOf, fakeAuthServer } from "./support/oauth-server.ts";

serveFakeMcpServers();

const POLICY = { ownHosts: [], localDevelopment: false };

const ADMIN = { member: "m-admin", admin: true };

const EVERYONE = { kind: "everyone" as const };

const CALLBACK = `https://app.example.com${SIGN_IN_CALLBACK_PATH}`;

type Namespace = typeof env.CONTROL_PLANE | typeof env.CLOUD_CONTROL_PLANE;

const plane = (namespace: Namespace = env.CONTROL_PLANE) =>
  namespace.getByName(crypto.randomUUID());

type Stub = ReturnType<typeof plane>;

const origin = (name: string) => `https://${name}-${crypto.randomUUID().slice(0, 8)}.example.com`;

const add = async (stub: Stub, input: AddToolkitInput) => {
  const added = await stub.tools().addToolkit(ADMIN, input, "test", POLICY);

  if (!added.ok) throw new Error(`add failed: ${added.message}`);

  return added.value;
};

const fromCatalog = (source: string, service = "acme"): AddToolkitInput => ({
  source,
  name: service,
  private: false,
  accepts: "shared",
  catalog: { service, source: `${service}-mcp` },
});

const start = async (stub: Stub, id: string) => {
  const started = await stub
    .tools()
    .startSignIn(ADMIN, id, "shared", { subject: EVERYONE }, "test", POLICY, {
      callback: CALLBACK,
      clientId: undefined,
    });

  if (!started.ok) throw new Error(`sign-in failed: ${started.message}`);

  return new URL(started.value.url);
};

describe("a toolkit added from the catalog", () => {
  it("keeps its catalog link and gets the additions' overrides of its tools", async () => {
    const mcp = fakeMcpServer(`${origin("mcp")}/mcp`, {
      tools: [{ name: "search" }, { name: "delete_all" }, { name: "echo" }],
    });

    const stub = plane();

    const toolkit = await add(stub, {
      ...fromCatalog(mcp.url),
      credential: { kind: "none", subject: EVERYONE },
      toolOverrides: {
        search: { name: "find", class: "read" },
        delete_all: { hidden: true },
        // Not a tool name: left out.
        echo: { name: "Echo Back" },
      },
    });

    expect(toolkit).toMatchObject({ catalog: { service: "acme", source: "acme-mcp" } });
    expect(toolkit).not.toHaveProperty("managed_oauth_app");

    const listed = await stub.tools().listTools(ADMIN, toolkit.id);

    if (!listed.ok) throw new Error(listed.message);
    const byUpstream = new Map(listed.value.tools.map((tool) => [tool.upstream_name, tool]));

    expect(byUpstream.get("search")).toMatchObject({
      name: "acme_find",
      class: "read",
      override: { updated_by: "catalog", revision: 1 },
    });
    expect(byUpstream.get("delete_all")?.flags.hidden).toBe(true);
    expect(byUpstream.get("echo")).toMatchObject({ name: "acme_echo" });
    expect(byUpstream.get("echo")).not.toHaveProperty("override");

    // An org admin changes a catalog override as any other.
    expect(
      await stub
        .tools()
        .setOverride(ADMIN, toolkit.id, 1, { tool: "delete_all", hidden: false }, "test"),
    ).toMatchObject({ ok: true });
  });

  it("builds an OpenAPI toolkit's tools from its document with the catalog's fixes applied", async () => {
    const docs = fakeHttpServer(origin("docs"), () =>
      Response.json({
        openapi: "3.0.0",
        info: { title: "Acme" },
        // integrations.sh's fixes: a wrong server, and a deprecated operation the registry shows.
        servers: [{ url: "http://wrong.example.com" }],
        paths: {
          "/items": { get: { operationId: "listItems" } },
          "/legacy": { get: { operationId: "legacy", deprecated: true } },
        },
      }),
    );

    const stub = plane();

    const patched = await add(stub, {
      source: `${docs.origin}/openapi.json`,
      kind: "openapi",
      name: "acme",
      private: false,
      accepts: "shared",
      catalog: { service: "acme", source: "acme-openapi" },
      specPatch: [
        { op: "replace", path: "/servers/0/url", value: "https://api.acme.example" },
        { op: "remove", path: "/paths/~1legacy" },
      ],
    });

    const listed = await stub.tools().listTools(ADMIN, patched.id);

    if (!listed.ok) throw new Error(listed.message);
    expect(listed.value.tools.map((tool) => tool.upstream_name)).toEqual(["listItems"]);
    expect(patched.tool_list).not.toHaveProperty("error");

    // Rebuilt, the fixes apply again; ones that no longer apply leave the document as it is, and say so.
    const rebuilt = await stub.tools().refreshToolList(ADMIN, patched.id, POLICY);

    expect(rebuilt.ok && rebuilt.value.tools.map((tool) => tool.upstream_name)).toEqual([
      "listItems",
    ]);

    const stale = await add(stub, {
      source: `${docs.origin}/openapi.json`,
      kind: "openapi",
      name: "acme_stale",
      private: false,
      accepts: "shared",
      specPatch: [{ op: "remove", path: "/paths/~1gone" }],
    });

    expect(stale.tool_list.error).toContain("the catalog's fixes to the document do not apply");
  });

  it("places a key that names no header where the catalog's source says, now and later", async () => {
    const mcp = fakeMcpServer(`${origin("mcp")}/mcp`, {
      tools: [{ name: "echo" }],
      authorized: (request) => request.headers.get("x-acme-key")?.startsWith("Token k-") === true,
    });

    const stub = plane();
    const placement = { kind: "header" as const, name: "X-Acme-Key", prefix: "Token" };

    const toolkit = await add(stub, {
      ...fromCatalog(mcp.url),
      catalog: { service: "acme", source: "acme-mcp", credential: placement },
      credential: { kind: "header", value: "k-1", subject: EVERYONE },
    });

    expect(toolkit).toMatchObject({
      catalog: { credential: placement },
      credentials: { shared: { kind: "header", name: "X-Acme-Key" } },
      tool_list: { tools: 1 },
    });
    expect(mcp.requests.at(-1)?.headers.get("x-acme-key")).toBe("Token k-1");

    // Connected again later without a name, or with the prefix already there: the same place, once.
    for (const value of ["k-2", "Token k-2"]) {
      const connected = await stub
        .tools()
        .connectCredential(
          ADMIN,
          toolkit.id,
          "shared",
          { kind: "header", value, subject: EVERYONE },
          "test",
          POLICY,
        );

      expect(connected).toMatchObject({ ok: true });
      expect(await stub.tools().refreshToolList(ADMIN, toolkit.id, POLICY)).toMatchObject({
        ok: true,
      });
      expect(mcp.requests.at(-1)?.headers.get("x-acme-key")).toBe("Token k-2");
    }

    // A toolkit whose source says nothing refuses a key without a name.
    const byUrl = await add(stub, {
      ...fromCatalog(`${origin("mcp")}/mcp`),
      name: "plain",
      catalog: undefined,
    });

    expect(
      await stub
        .tools()
        .connectCredential(
          ADMIN,
          byUrl.id,
          "shared",
          { kind: "query", value: "k", subject: EVERYONE },
          "test",
          POLICY,
        ),
    ).toMatchObject({ ok: false, error: "invalid", path: "name" });
  });

  it("signs in on a self-hosted Commissary as any toolkit does: no managed app", async () => {
    const stub = plane();
    const toolkit = await add(stub, fromCatalog(`${origin("mcp")}/mcp`));

    expect(toolkit).not.toHaveProperty("managed_oauth_app");
  });
});

describe("Commissary Cloud's managed OAuth apps", () => {
  const managedAuth = () =>
    fakeAuthServer(MANAGED_AUTH_ORIGIN, {
      clients: [
        { id: MANAGED_CLIENT_ID, secret: MANAGED_CLIENT_SECRET },
        { id: "org-app", secret: "org-secret" },
      ],
    });

  it("sign a catalog toolkit in with the service's managed app, its secret never shown", async () => {
    const auth = managedAuth();

    const mcp = fakeMcpServer(`${origin("mcp")}/mcp`, {
      tools: [{ name: "echo" }],
      authorized: bearerOf(auth),
    });

    const stub = plane(env.CLOUD_CONTROL_PLANE);
    const toolkit = await add(stub, fromCatalog(mcp.url));

    expect(toolkit).toMatchObject({ catalog: { service: "acme" }, managed_oauth_app: true });
    expect(toolkit).not.toHaveProperty("oauth_app");

    const url = await start(stub, toolkit.id);

    expect(url.origin).toBe(MANAGED_AUTH_ORIGIN);
    expect(url.searchParams.get("client_id")).toBe(MANAGED_CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe("read");

    const back = await auth.authorize(url.toString());

    expect(
      await stub.tools().completeSignIn(
        {
          state: back.searchParams.get("state") ?? "",
          code: back.searchParams.get("code") ?? "",
          error: "",
          iss: undefined,
          member: ADMIN.member,
        },
        POLICY,
      ),
    ).toEqual({ outcome: "completed" });
    expect(auth.tokenRequests[0]?.form.get("client_id")).toBe(MANAGED_CLIENT_ID);

    const listed = await stub.tools().listToolkits(ADMIN);
    const view = listed.toolkits.find((entry) => entry.id === toolkit.id);

    expect(view?.credentials.shared).toMatchObject({ kind: "oauth", via: "app" });
    expect(JSON.stringify(listed)).not.toContain(MANAGED_CLIENT_SECRET);
    expect(
      await stub.tools().callTool(ADMIN, { name: "acme_echo", arguments: {} }, POLICY),
    ).toMatchObject({ outcome: "result" });
  });

  it("give way to the org's own OAuth app", async () => {
    const auth = managedAuth();
    const stub = plane(env.CLOUD_CONTROL_PLANE);
    const toolkit = await add(stub, fromCatalog(`${origin("mcp")}/mcp`));

    const set = await stub.tools().setOAuthApp(
      ADMIN,
      toolkit.id,
      {
        client_id: "org-app",
        client_secret: "org-secret",
        authorize_url: auth.authorizeUrl,
        token_url: auth.tokenUrl,
      },
      "test",
    );

    expect(set).toMatchObject({ ok: true, value: { oauth_app: { client_id: "org-app" } } });
    expect(set.ok && set.value).not.toHaveProperty("managed_oauth_app");
    expect((await start(stub, toolkit.id)).searchParams.get("client_id")).toBe("org-app");

    // Cleared, the managed app is back.
    expect(await stub.tools().clearOAuthApp(ADMIN, toolkit.id)).toMatchObject({
      ok: true,
      value: { managed_oauth_app: true },
    });
  });

  it("are for toolkits from their service's catalog entry, with their secret bound", async () => {
    const stub = plane(env.CLOUD_CONTROL_PLANE);
    const byUrl = await add(stub, { ...fromCatalog(`${origin("mcp")}/mcp`), catalog: undefined });

    const unbound = await add(stub, {
      ...fromCatalog(`${origin("mcp")}/mcp`, "unbound"),
      name: "unbound",
    });

    expect(byUrl).not.toHaveProperty("managed_oauth_app");
    expect(byUrl).not.toHaveProperty("catalog");
    // What the app Worker asks for the catalog's views, which binds no secret itself.
    expect(await stub.tools().hasManagedApp("acme")).toBe(true);
    expect(await stub.tools().hasManagedApp("unbound")).toBe(false);
    expect(await plane().tools().hasManagedApp("acme")).toBe(false);
    expect(unbound).toMatchObject({ catalog: { service: "unbound" } });
    expect(unbound).not.toHaveProperty("managed_oauth_app");
  });
});
