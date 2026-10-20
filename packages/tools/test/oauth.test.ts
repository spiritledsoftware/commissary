// OAuth 2 sign-ins to toolkits (#202) through the Tools part over RPC, against a fake MCP server and a fake
// authorization server served in workerd: discovery (RFC 9728, RFC 8414), Commissary as the client through its CIMD
// document, dynamic client registration or the toolkit's own OAuth app, for the shared credential and a member's
// private one, PKCE and the RFC 8707 resource, the callback's single-use org-scoped state, its starter and the RFC 9207
// issuer check, token refreshes ahead of expiry, on a `401` and when the refresh token is refused, a registration made
// again for a new authorization server, the client credentials grant (an OpenAPI toolkit's too, against a fake HTTP
// API), and the outbound guard on every endpoint the metadata names. `TestClock` drives the time the Tools part reads: the callback window, a sign-in's expiry and when a
// token gets its refresh.
import { env, runInDurableObject } from "cloudflare:test";
import { type Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { TOOLKIT_OAUTH_CLIENT_PATH } from "@commissary/core";
import type { AddToolkitInput } from "../src/control-plane-part.ts";
import { clientMetadata, SIGN_IN_CALLBACK_PATH } from "../src/oauth/urls.ts";
import { fakeHttpServer } from "./support/http-server.ts";
import {
  fakeMcpServer,
  type FakeMcpServer,
  serveFakeMcpServers,
  serveOrigin,
} from "./support/mcp-server.ts";
import {
  bearerOf,
  type FakeAuthServer,
  type FakeAuthServerOptions,
  fakeAuthServer,
} from "./support/oauth-server.ts";

serveFakeMcpServers();

const POLICY = { ownHosts: [], localDevelopment: false };

const ADMIN = { member: "m-admin", admin: true };

const ALICE = { member: "m-alice", admin: false };

type Viewer = typeof ADMIN;

const EVERYONE = { kind: "everyone" as const };

const APP_HOST = "app.example.com";

const CALLBACK = `https://${APP_HOST}${SIGN_IN_CALLBACK_PATH}`;

/**
 * An org's ControlPlane whose Tools part reads the time from a `TestClock` at the real time: `adjust` moves it, `now`
 * reads it.
 */
const planeWithClock = async () => {
  const stub = env.CONTROL_PLANE.getByName(crypto.randomUUID());
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));

  await Effect.runPromise(clock.setTime(Date.now()));
  await runInDurableObject(stub, (instance) => instance.tools().useClock(clock));
  await stub.setMembershipSettings({ privateCredentials: true, privateToolkits: true });

  return {
    stub,
    clock: {
      adjust: (duration: Duration.Input) => Effect.runPromise(clock.adjust(duration)),
      now: () => clock.currentTimeMillisUnsafe(),
    },
  };
};

const plane = async () => (await planeWithClock()).stub;

type Stub = Awaited<ReturnType<typeof plane>>;

const origin = (name: string) => `https://${name}-${crypto.randomUUID().slice(0, 8)}.example.com`;

/** Commissary's CIMD document, served on an API host of its own as the API Worker serves it. */
const servedClientId = (): string => {
  const clientId = `${origin("api")}${TOOLKIT_OAUTH_CLIENT_PATH}`;

  serveOrigin(clientId, () => Response.json(clientMetadata(clientId, APP_HOST)));

  return clientId;
};

/** The fake MCP server at `url` behind `servers`, whose protected resource metadata names the first. */
const mcpBehind = (url: string, ...servers: ReadonlyArray<FakeAuthServer>): FakeMcpServer =>
  fakeMcpServer(url, {
    tools: [{ name: "echo", annotations: { readOnlyHint: true } }],
    authorized: (request) => servers.some((server) => bearerOf(server)(request)),
    challenge: `Bearer resource_metadata="${new URL(url).origin}/.well-known/oauth-protected-resource/mcp"`,
    resourceMetadata: { resource: url, authorization_servers: servers.map((s) => s.issuer) },
  });

/** An MCP server behind a fake authorization server, which its protected resource metadata names. */
const setup = (options: FakeAuthServerOptions = {}) => {
  const auth = fakeAuthServer(origin("auth"), options);

  return { auth, mcp: mcpBehind(`${origin("mcp")}/mcp`, auth) };
};

const add = async (stub: Stub, viewer: Viewer, input: AddToolkitInput) => {
  const added = await stub.tools().addToolkit(viewer, input, "test", POLICY);

  if (!added.ok) throw new Error(`add failed: ${added.message}`);

  return added.value;
};

const orgToolkit = (source: string): AddToolkitInput => ({
  source,
  name: "kit",
  private: false,
  accepts: "both",
});

const start = async (
  stub: Stub,
  viewer: Viewer,
  id: string,
  slot: "shared" | "private",
  clientId: string | undefined,
) => {
  const started = await stub
    .tools()
    .startSignIn(viewer, id, slot, slot === "shared" ? { subject: EVERYONE } : {}, "test", POLICY, {
      callback: CALLBACK,
      clientId,
    });

  if (!started.ok) throw new Error(`sign-in failed: ${started.message}`);

  return started.value;
};

/** The callback of the redirect `back`, as the public route hands it to the ControlPlane for `viewer`. */
const callback = (stub: Stub, back: URL, viewer: Viewer = ADMIN) =>
  stub.tools().completeSignIn(
    {
      state: back.searchParams.get("state") ?? "",
      code: back.searchParams.get("code") ?? "",
      error: back.searchParams.get("error") ?? "",
      iss: back.searchParams.get("iss") ?? undefined,
      member: viewer.member,
    },
    POLICY,
  );

const credentials = async (stub: Stub, viewer: Viewer, id: string) => {
  const listed = await stub.tools().listToolkits(viewer);
  const toolkit = listed.toolkits.find((entry) => entry.id === id);

  if (toolkit === undefined) throw new Error("no such toolkit");

  return toolkit.credentials;
};

const call = (stub: Stub, viewer: Viewer) =>
  stub.tools().callTool(viewer, { name: "kit_echo", arguments: {} }, POLICY);

const grants = (auth: FakeAuthServer) =>
  auth.tokenRequests.map((request) => request.form.get("grant_type"));

/** An org toolkit signed in to with its shared credential through Commissary's CIMD document. */
const signedInShared = async (options: FakeAuthServerOptions = {}) => {
  const { auth, mcp } = setup({ cimd: true, ...options });
  const { stub, clock } = await planeWithClock();
  const toolkit = await add(stub, ADMIN, orgToolkit(mcp.url));
  const started = await start(stub, ADMIN, toolkit.id, "shared", servedClientId());

  expect(await callback(stub, await auth.authorize(started.url))).toEqual({
    outcome: "completed",
  });

  return { auth, mcp, stub, clock, toolkit };
};

/** The toolkit's OAuth app at `auth`, its client `org-app`. */
const orgApp = (auth: FakeAuthServer, issuer?: string) => ({
  client_id: "org-app",
  client_secret: "app-secret",
  authorize_url: auth.authorizeUrl,
  token_url: auth.tokenUrl,
  ...(issuer === undefined ? {} : { issuer }),
});

/** An org toolkit of an MCP server that names no authorization server, behind an authorization server of its own. */
const appToolkit = async (options: FakeAuthServerOptions = {}) => {
  const auth = fakeAuthServer(origin("auth"), {
    clients: [{ id: "org-app", secret: "app-secret" }],
    ...options,
  });

  const mcp = fakeMcpServer(`${origin("mcp")}/mcp`, {
    tools: [{ name: "echo" }],
    authorized: bearerOf(auth),
  });

  const stub = await plane();
  const toolkit = await add(stub, ADMIN, orgToolkit(mcp.url));

  return { auth, mcp, stub, toolkit };
};

describe("signing in to a toolkit with OAuth 2", () => {
  it("signs the shared credential in through Commissary's CIMD document, with PKCE and the resource", async () => {
    const { auth, mcp } = setup({ cimd: true, registration: true, iss: true });
    const stub = await plane();
    const clientId = servedClientId();
    const toolkit = await add(stub, ADMIN, orgToolkit(mcp.url));

    expect(toolkit.tool_list.built_at).toBeUndefined();

    const started = await start(stub, ADMIN, toolkit.id, "shared", clientId);
    const url = new URL(started.url);

    expect(url.origin + url.pathname).toBe(auth.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: started.state,
      code_challenge_method: "S256",
      resource: mcp.url,
    });
    expect(started.state).toMatch(/^org\./);
    expect(await stub.tools().signInStatus(ADMIN, toolkit.id, started.state)).toEqual({
      ok: true,
      value: { status: "wait" },
    });

    const back = await auth.authorize(started.url);

    expect(auth.fetchedDocuments).toEqual([clientId]);
    expect(await callback(stub, back)).toEqual({ outcome: "completed" });
    expect(await stub.tools().signInStatus(ADMIN, toolkit.id, started.state)).toEqual({
      ok: true,
      value: { status: "ok" },
    });

    // CIMD wins over registration: nothing was registered, and the code exchange named the resource.
    expect(auth.registrations).toEqual([]);
    expect(auth.tokenRequests).toHaveLength(1);
    expect(Object.fromEntries(auth.tokenRequests[0]?.form ?? [])).toMatchObject({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      resource: mcp.url,
    });
    expect(auth.tokenRequests[0]?.auth).toBe("none");

    expect((await credentials(stub, ADMIN, toolkit.id)).shared).toMatchObject({
      kind: "oauth",
      via: "cimd",
      active: true,
    });
    expect(
      (await stub.tools().listTools(ADMIN, toolkit.id)).ok &&
        (await stub.tools().servedTools(ALICE)).map((tool) => tool.name),
    ).toEqual(["kit_echo"]);
    expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });
  });

  it("registers Commissary dynamically for a member's private credential, and keeps the registration", async () => {
    const { auth, mcp } = setup({ registration: true });
    const stub = await plane();

    const toolkit = await add(stub, ALICE, {
      source: mcp.url,
      name: "kit",
      private: true,
      accepts: "private",
    });

    // No CIMD document where the authorization server takes none, nor where Commissary serves none.
    const first = await start(stub, ALICE, toolkit.id, "private", servedClientId());
    const registered = auth.registrations[0]?.clientId;

    expect(auth.registrations).toEqual([{ clientId: registered, redirectUris: [CALLBACK] }]);
    expect(new URL(first.url).searchParams.get("client_id")).toBe(registered);
    expect(await callback(stub, await auth.authorize(first.url), ALICE)).toEqual({
      outcome: "completed",
    });
    expect((await credentials(stub, ALICE, toolkit.id)).mine).toMatchObject({
      kind: "oauth",
      via: "dcr",
    });
    expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });

    // Signing in again reuses the registration.
    const again = await start(stub, ALICE, toolkit.id, "private", undefined);

    expect(new URL(again.url).searchParams.get("client_id")).toBe(registered);
    expect(await callback(stub, await auth.authorize(again.url), ALICE)).toEqual({
      outcome: "completed",
    });
    expect(auth.registrations).toHaveLength(1);

    // The sign-in is its starter's alone.
    expect(await stub.tools().signInStatus(ADMIN, toolkit.id, again.state)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("signs in with the toolkit's own OAuth app, its secret posted and no resource named", async () => {
    const { auth, stub, toolkit } = await appToolkit();

    const set = await stub
      .tools()
      .setOAuthApp(ADMIN, toolkit.id, { ...orgApp(auth), scopes: ["read", "write"] }, "test");

    expect(set).toMatchObject({
      ok: true,
      value: {
        oauth_app: { client_id: "org-app", client_secret: true, scopes: ["read", "write"] },
      },
    });
    expect(JSON.stringify(set)).not.toContain("app-secret");

    // Only the toolkit's managers set its app.
    expect(
      await stub
        .tools()
        .setOAuthApp(
          ALICE,
          toolkit.id,
          { client_id: "x", authorize_url: auth.authorizeUrl, token_url: auth.tokenUrl },
          "test",
        ),
    ).toMatchObject({ ok: false });

    const started = await start(stub, ADMIN, toolkit.id, "shared", servedClientId());
    const params = new URL(started.url).searchParams;

    expect(params.get("client_id")).toBe("org-app");
    expect(params.get("scope")).toBe("read write");
    expect(params.has("resource")).toBe(false);
    expect(await callback(stub, await auth.authorize(started.url))).toEqual({
      outcome: "completed",
    });
    expect(auth.tokenRequests[0]?.auth).toBe("post");
    expect(auth.tokenRequests[0]?.form.has("resource")).toBe(false);
    expect((await credentials(stub, ADMIN, toolkit.id)).shared).toMatchObject({
      kind: "oauth",
      via: "app",
    });
    expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });

    expect(await stub.tools().clearOAuthApp(ADMIN, toolkit.id)).toMatchObject({ ok: true });
  });

  it.each(["cimd", "app"] as const)(
    "signs a member's private credential in through %s, and calls with it",
    async (via) => {
      const { auth, mcp, stub, toolkit } =
        via === "cimd"
          ? await (async () => {
              const served = setup({ cimd: true });
              const org = await plane();

              return {
                ...served,
                stub: org,
                toolkit: await add(org, ADMIN, orgToolkit(served.mcp.url)),
              };
            })()
          : await appToolkit();

      if (via === "app")
        expect(
          await stub.tools().setOAuthApp(ADMIN, toolkit.id, orgApp(auth), "test"),
        ).toMatchObject({
          ok: true,
        });

      const started = await start(stub, ALICE, toolkit.id, "private", servedClientId());

      expect(await callback(stub, await auth.authorize(started.url), ALICE)).toEqual({
        outcome: "completed",
      });

      const { mine, shared } = await credentials(stub, ALICE, toolkit.id);

      expect(mine).toMatchObject({ kind: "oauth", via });
      expect(shared).toBeUndefined();
      expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });

      // Alice's token: the call went upstream with it, and nobody else has a credential to call with.
      expect(mcp.requests.at(-1)?.headers.get("authorization")).toMatch(/^Bearer access-/);
      expect(await call(stub, ADMIN)).toMatchObject({ outcome: "connect", reason: "missing" });
    },
  );

  it("refuses to start a sign-in for a caller without a member", async () => {
    const { mcp } = setup({ cimd: true });
    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(mcp.url));

    expect(
      await stub
        .tools()
        .startSignIn({ admin: true }, toolkit.id, "shared", { subject: EVERYONE }, "test", POLICY, {
          callback: CALLBACK,
          clientId: servedClientId(),
        }),
    ).toMatchObject({ ok: false, error: "forbidden" });
  });
});

describe("a sign-in's callback", () => {
  it("takes a state once, in its own org, within the callback window", async () => {
    const { auth, mcp } = setup({ cimd: true });
    const { stub, clock } = await planeWithClock();
    const toolkit = await add(stub, ADMIN, orgToolkit(mcp.url));
    const clientId = servedClientId();

    // Another org's ControlPlane never started it.
    const elsewhere = await start(stub, ADMIN, toolkit.id, "shared", clientId);

    expect(await callback(await plane(), await auth.authorize(elsewhere.url))).toEqual({
      outcome: "rejected",
    });

    // Used once.
    const used = await start(stub, ADMIN, toolkit.id, "shared", clientId);
    const back = await auth.authorize(used.url);

    expect(await callback(stub, back)).toEqual({ outcome: "completed" });
    expect(await callback(stub, back)).toEqual({ outcome: "rejected" });

    // Past the five minutes the browser has to come back.
    const late = await start(stub, ADMIN, toolkit.id, "shared", clientId);
    const lateBack = await auth.authorize(late.url);

    await clock.adjust("5 minutes");
    await clock.adjust("1 second");

    expect(await callback(stub, lateBack)).toEqual({ outcome: "rejected" });
    expect(await stub.tools().signInStatus(ADMIN, toolkit.id, late.state)).toMatchObject({
      value: { status: "error", message: "the sign-in took too long: start it again" },
    });

    // An unknown one.
    expect(
      await stub
        .tools()
        .completeSignIn(
          { state: "org.x.0123", code: "c", error: "", iss: undefined, member: ADMIN.member },
          POLICY,
        ),
    ).toEqual({ outcome: "rejected" });
  });

  it("is forgotten 30 minutes after it started", async () => {
    const { auth, mcp } = setup({ cimd: true });
    const { stub, clock } = await planeWithClock();
    const toolkit = await add(stub, ADMIN, orgToolkit(mcp.url));
    const started = await start(stub, ADMIN, toolkit.id, "shared", servedClientId());
    const back = await auth.authorize(started.url);

    await clock.adjust("29 minutes");

    expect(await stub.tools().signInStatus(ADMIN, toolkit.id, started.state)).toMatchObject({
      ok: true,
    });

    await clock.adjust("1 minute");

    expect(await stub.tools().signInStatus(ADMIN, toolkit.id, started.state)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await callback(stub, back)).toEqual({ outcome: "rejected" });
  });

  it("is finished only by the member who started it, and stays pending for them", async () => {
    const { auth, mcp } = setup({ cimd: true });
    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(mcp.url));

    for (const [starter, slot] of [
      [ADMIN, "shared"],
      [ALICE, "private"],
    ] as const) {
      const started = await start(stub, starter, toolkit.id, slot, servedClientId());
      const back = await auth.authorize(started.url);
      const other = starter === ADMIN ? ALICE : ADMIN;

      // Another member, an org admin included, is refused like a state that is not known, and changes nothing.
      expect(await callback(stub, back, other)).toEqual({ outcome: "rejected" });
      expect(await stub.tools().signInStatus(starter, toolkit.id, started.state)).toEqual({
        ok: true,
        value: { status: "wait" },
      });
      expect(
        auth.tokenRequests.filter((request) => request.form.get("code") !== null),
      ).toHaveLength(starter === ADMIN ? 0 : 1);

      expect(await callback(stub, back, starter)).toEqual({ outcome: "completed" });
    }

    const { mine, shared } = await credentials(stub, ALICE, toolkit.id);

    expect(shared).toMatchObject({ kind: "oauth" });
    expect(mine).toMatchObject({ kind: "oauth" });
  });

  it("fails a sign-in whose answer names another issuer, or that the authorization server refused", async () => {
    const { auth, mcp } = setup({ cimd: true, iss: true });
    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(mcp.url));
    const clientId = servedClientId();

    const started = await start(stub, ADMIN, toolkit.id, "shared", clientId);

    const forged = await auth.authorize(started.url, { iss: "https://evil.example.com" });

    expect(await callback(stub, forged)).toEqual({ outcome: "failed" });
    expect(await stub.tools().signInStatus(ADMIN, toolkit.id, started.state)).toEqual({
      ok: true,
      value: {
        status: "error",
        message: "the answer did not come from the toolkit's authorization server",
      },
    });
    expect(auth.tokenRequests).toEqual([]);

    // The authorization server advertises `iss`, so an answer without one fails too.
    const bare = await auth.authorize(
      (await start(stub, ADMIN, toolkit.id, "shared", clientId)).url,
    );

    bare.searchParams.delete("iss");
    expect(await callback(stub, bare)).toEqual({ outcome: "failed" });

    // An error answer is read only once its issuer is checked (RFC 9207 §2.4).
    const spoofed = await start(stub, ADMIN, toolkit.id, "shared", clientId);

    expect(
      await stub.tools().completeSignIn(
        {
          state: spoofed.state,
          code: "",
          error: "access_denied",
          iss: "https://evil.example.com",
          member: ADMIN.member,
        },
        POLICY,
      ),
    ).toEqual({ outcome: "failed" });
    expect(await stub.tools().signInStatus(ADMIN, toolkit.id, spoofed.state)).toMatchObject({
      value: { message: "the answer did not come from the toolkit's authorization server" },
    });

    const denied = await start(stub, ADMIN, toolkit.id, "shared", clientId);

    expect(
      await stub.tools().completeSignIn(
        {
          state: denied.state,
          code: "",
          error: "access_denied",
          iss: auth.issuer,
          member: ADMIN.member,
        },
        POLICY,
      ),
    ).toEqual({ outcome: "failed" });
    expect(await stub.tools().signInStatus(ADMIN, toolkit.id, denied.state)).toMatchObject({
      value: {
        status: "error",
        message: "the authorization server did not sign in (access_denied)",
      },
    });
    expect((await credentials(stub, ADMIN, toolkit.id)).shared).toBeUndefined();
  });

  it.each([
    ["names no issuer", undefined, "completed"],
    ["names the server's issuer", "same", "completed"],
    ["names another issuer", "https://elsewhere.example.com", "failed"],
  ] as const)(
    "checks an OAuth app's answer that carries `iss` only against the issuer the app %s",
    async (_case, issuer, outcome) => {
      // The authorization server names itself in its answers; the app may not say who it is.
      const { auth, stub, toolkit } = await appToolkit({ iss: true });
      const named = issuer === "same" ? auth.issuer : issuer;

      expect(
        await stub.tools().setOAuthApp(ADMIN, toolkit.id, orgApp(auth, named), "test"),
      ).toMatchObject({
        ok: true,
        value: {
          oauth_app:
            named === undefined
              ? expect.not.objectContaining({ issuer: expect.anything() })
              : { issuer: named },
        },
      });

      const started = await start(stub, ADMIN, toolkit.id, "shared", undefined);
      const back = await auth.authorize(started.url);

      expect(back.searchParams.get("iss")).toBe(auth.issuer);
      expect(await callback(stub, back)).toEqual({ outcome });

      // An app that names its issuer requires it in the answer.
      if (named !== undefined) {
        const bare = await auth.authorize(
          (await start(stub, ADMIN, toolkit.id, "shared", undefined)).url,
        );

        bare.searchParams.delete("iss");
        expect(await callback(stub, bare)).toEqual({ outcome: "failed" });
      }
    },
  );
});

describe("an OAuth credential's tokens", () => {
  it("are refreshed by the alarm before they expire, which is set for it", async () => {
    const { auth, stub, clock, toolkit } = await signedInShared({ expiresIn: 120 });
    const before = (await credentials(stub, ADMIN, toolkit.id)).shared?.expires_at;

    // The ControlPlane's alarm is set at the latest for the token refresh, halfway through a two-minute token's life.
    const { alarm, refreshAt } = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      refreshAt: state.storage.sql
        .exec<{ refresh_at: number }>(`SELECT refresh_at FROM toolkit_credentials`)
        .one().refresh_at,
    }));

    expect(refreshAt).toBe(Date.parse(before ?? "") - 60_000);
    expect(alarm).not.toBeNull();
    expect(alarm ?? Infinity).toBeLessThanOrEqual(refreshAt);

    // Not yet due: nothing is asked.
    await clock.adjust("59 seconds");
    await runInDurableObject(stub, async (instance) => {
      await instance.tools().alarm(clock.now());
    });

    expect(grants(auth)).toEqual(["authorization_code"]);

    await clock.adjust("2 seconds");
    await runInDurableObject(stub, async (instance) => {
      await instance.tools().alarm(clock.now());
    });

    expect(grants(auth)).toEqual(["authorization_code", "refresh_token"]);
    expect(auth.tokenRequests[1]?.form.get("resource")).toBe(
      auth.tokenRequests[0]?.form.get("resource"),
    );

    const after = (await credentials(stub, ADMIN, toolkit.id)).shared?.expires_at;

    expect(Date.parse(after ?? "")).toBeGreaterThan(Date.parse(before ?? ""));
    expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });
  });

  it("are refreshed before a call within a minute of their expiry goes upstream", async () => {
    const { auth, mcp, stub, clock } = await signedInShared({ expiresIn: 3600 });

    expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });
    const old = new Set(auth.accessTokens);

    // Half a minute before the hour is up: the token is still good at the server, but not for Commissary.
    await clock.adjust("59 minutes");
    await clock.adjust("30 seconds");
    const sent = mcp.requests.length;

    expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });
    expect(grants(auth)).toEqual(["authorization_code", "refresh_token"]);

    const presented = mcp.requests
      .slice(sent)
      .map((request) => request.headers.get("authorization")?.slice("Bearer ".length));

    expect(presented.length).toBeGreaterThan(0);
    expect(presented.filter((token) => token !== undefined && old.has(token))).toEqual([]);
  });

  it("are refreshed when the MCP server refuses the access token", async () => {
    const { auth, stub } = await signedInShared();

    expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });

    auth.accessTokens.clear();

    expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });
    expect(grants(auth)).toEqual(["authorization_code", "refresh_token"]);
  });

  it("need sign-in again once the refresh token is refused", async () => {
    const { auth, stub, toolkit } = await signedInShared();

    auth.accessTokens.clear();
    auth.revokeRefreshTokens();

    expect(await call(stub, ALICE)).toMatchObject({
      outcome: "connect",
      reason: "sign_in",
      slot: "shared",
      toolkit: { id: toolkit.id, name: "kit" },
    });
    expect((await credentials(stub, ADMIN, toolkit.id)).shared).toMatchObject({
      kind: "oauth",
      needs_sign_in: true,
    });

    // The credential is not tried again until someone signs in.
    const asked = auth.tokenRequests.length;

    expect(await call(stub, ALICE)).toMatchObject({ outcome: "connect", reason: "sign_in" });
    expect(auth.tokenRequests).toHaveLength(asked);

    const started = await start(stub, ADMIN, toolkit.id, "shared", servedClientId());

    expect(await callback(stub, await auth.authorize(started.url))).toEqual({
      outcome: "completed",
    });
    expect((await credentials(stub, ADMIN, toolkit.id)).shared?.needs_sign_in).not.toBe(true);
    expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });
  });
});

describe("a dynamic registration", () => {
  it("is made again for a new authorization server, kept once its sign-in completes, and retires the old client", async () => {
    const first = fakeAuthServer(origin("auth"), { registration: true });
    const second = fakeAuthServer(origin("auth"), { registration: true });
    const url = `${origin("mcp")}/mcp`;

    mcpBehind(url, first, second);

    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(url));
    const shared = await start(stub, ADMIN, toolkit.id, "shared", undefined);

    expect(await callback(stub, await first.authorize(shared.url))).toEqual({
      outcome: "completed",
    });
    expect(first.registrations).toHaveLength(1);

    // The MCP server moves to another authorization server: Alice's sign-in registers Commissary there.
    mcpBehind(url, second, first);

    const alice = await start(stub, ALICE, toolkit.id, "private", undefined);
    const firstClient = first.registrations[0]?.clientId;
    const secondClient = second.registrations[0]?.clientId;

    expect(new URL(alice.url).origin).toBe(second.issuer);
    expect(new URL(alice.url).searchParams.get("client_id")).toBe(secondClient);
    expect(secondClient).not.toBe(firstClient);

    // Until it completes, the shared credential's token refresh still uses the first registration.
    first.accessTokens.clear();

    expect(await call(stub, ADMIN)).toMatchObject({ outcome: "result" });
    expect(grants(first)).toEqual(["authorization_code", "refresh_token"]);

    expect(await callback(stub, await second.authorize(alice.url), ALICE)).toEqual({
      outcome: "completed",
    });
    expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });

    // Now the toolkit's registration is the second: the shared credential, issued to the first, needs sign-in again.
    first.accessTokens.clear();

    expect(await call(stub, ADMIN)).toMatchObject({ outcome: "connect", reason: "sign_in" });
    expect((await credentials(stub, ADMIN, toolkit.id)).shared).toMatchObject({
      via: "dcr",
      needs_sign_in: true,
    });
    expect(grants(first)).toEqual(["authorization_code", "refresh_token"]);
  });
});

describe("a client credentials grant", () => {
  it("mints a token at the discovered token endpoint for the shared credential, and mints again on a 401", async () => {
    const { auth, mcp } = setup({ clients: [{ id: "machine", secret: "machine-secret" }] });
    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(mcp.url));

    const connected = await stub.tools().connectCredential(
      ADMIN,
      toolkit.id,
      "shared",
      {
        kind: "client_credentials",
        client_id: "machine",
        client_secret: "machine-secret",
        scope: "tools",
        subject: EVERYONE,
      },
      "test",
      POLICY,
    );

    expect(connected).toMatchObject({
      ok: true,
      value: { credentials: { shared: { kind: "client_credentials" } }, tool_list: { tools: 1 } },
    });
    expect(JSON.stringify(connected)).not.toContain("machine-secret");
    expect(auth.tokenRequests[0]?.auth).toBe("basic");
    expect(Object.fromEntries(auth.tokenRequests[0]?.form ?? [])).toEqual({
      grant_type: "client_credentials",
      scope: "tools",
      resource: mcp.url,
    });
    expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });

    auth.accessTokens.clear();

    expect(await call(stub, ALICE)).toMatchObject({ outcome: "result" });
    expect(grants(auth)).toEqual(["client_credentials", "client_credentials"]);
  });

  it("is a shared credential only", async () => {
    const { mcp } = setup();
    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(mcp.url));

    expect(
      await stub
        .tools()
        .connectCredential(
          ALICE,
          toolkit.id,
          "private",
          { kind: "client_credentials", client_id: "machine", client_secret: "s" },
          "test",
          POLICY,
        ),
    ).toMatchObject({ ok: false, error: "invalid" });
  });
});

describe("an OpenAPI toolkit", () => {
  it("calls with a client credentials grant's token as its bearer, and mints again on a 401", async () => {
    const auth = fakeAuthServer(origin("auth"), {
      clients: [{ id: "machine", secret: "machine-secret" }],
    });

    const authorized = bearerOf(auth);

    const api = fakeHttpServer(origin("api"), (request) =>
      authorized(new Request(request.url, { headers: request.headers }))
        ? Response.json({ pong: true })
        : Response.json({ error: "unauthorized" }, { status: 401 }),
    );

    const stub = await plane();

    const toolkit = await add(stub, ADMIN, {
      kind: "openapi",
      source: "",
      name: "ops",
      private: false,
      accepts: "shared",
      document: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Ops", version: "1" },
        servers: [{ url: api.origin }],
        components: {
          securitySchemes: {
            oauth: {
              type: "oauth2",
              flows: { clientCredentials: { tokenUrl: auth.tokenUrl, scopes: {} } },
            },
          },
        },
        security: [{ oauth: [] }],
        paths: { "/ping": { get: { operationId: "ping" } } },
      }),
    });

    expect(
      await stub.tools().connectCredential(
        ADMIN,
        toolkit.id,
        "shared",
        {
          kind: "client_credentials",
          client_id: "machine",
          client_secret: "machine-secret",
          token_url: auth.tokenUrl,
          subject: EVERYONE,
        },
        "test",
        POLICY,
      ),
    ).toMatchObject({
      ok: true,
      value: { credentials: { shared: { kind: "client_credentials" } } },
    });

    const ping = () => stub.tools().callTool(ALICE, { name: "ops_ping", arguments: {} }, POLICY);

    expect(await ping()).toMatchObject({ outcome: "result" });

    const [minted] = auth.accessTokens;

    expect(api.requests.at(-1)?.headers.get("authorization")).toBe(`Bearer ${minted}`);

    // The API refuses the token now: a new one is minted, and the call goes through with it.
    auth.accessTokens.clear();

    const called = await ping();

    expect(called).toMatchObject({ outcome: "result" });
    expect(JSON.stringify(called)).not.toContain("unauthorized");
    expect(grants(auth)).toEqual(["client_credentials", "client_credentials"]);

    const [again] = auth.accessTokens;

    expect(again).not.toBe(minted);
    expect(api.requests.at(-1)?.headers.get("authorization")).toBe(`Bearer ${again}`);
    expect(api.requests).toHaveLength(3);
  });
});

describe("the outbound guard on a sign-in", () => {
  it("refuses an endpoint the authorization server's metadata names on a private address", async () => {
    const { mcp } = setup({ cimd: true, tokenEndpoint: "https://10.0.0.1/token" });
    const stub = await plane();
    const toolkit = await add(stub, ADMIN, orgToolkit(mcp.url));

    expect(
      await stub
        .tools()
        .startSignIn(ADMIN, toolkit.id, "shared", { subject: EVERYONE }, "test", POLICY, {
          callback: CALLBACK,
          clientId: servedClientId(),
        }),
    ).toMatchObject({ ok: false, error: "outbound_refused", path: "token_endpoint" });
  });
});
