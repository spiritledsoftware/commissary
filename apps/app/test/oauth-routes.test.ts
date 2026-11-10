// OAuth login routes (management + public callbacks) through the router with the real ControlPlane Durable Object.
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  controlPlane,
  jsonInit,
  makeHarness,
  resetControlPlane,
  SERVICE_ADMIN,
  SERVICE_ADMIN_BINDINGS,
  serviceToken,
  token,
} from "./support/management.ts";
import type { Json } from "@commissary/json";

// The ControlPlane talks to providers through Effect's FetchHttpClient, which resolves `globalThis.fetch` once:
// install one stable fetch that delegates to the current test's upstream table.
type Upstream = (request: { method: string; url: string; body: string }) => Response | undefined;

let upstream: Upstream = () => undefined;

const realFetch = globalThis.fetch;

const upstreamCalls: string[] = [];

const harness = makeHarness(undefined, SERVICE_ADMIN_BINDINGS);

beforeAll(() => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = new TextDecoder().decode(await request.arrayBuffer());
    upstreamCalls.push(`${request.method} ${request.url}`);

    return (
      upstream({ method: request.method, url: request.url, body }) ??
      new Response("no upstream route", { status: 599 })
    );
  };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await harness.dispose();
});

beforeEach(async () => {
  upstream = () => undefined;
  upstreamCalls.length = 0;
  await resetControlPlane();
});

const { call, json } = harness;

const claudeUpstream: Upstream = ({ method, url }) => {
  const key = `${method} ${url}`;

  if (key === "POST https://platform.claude.com/v1/oauth/token") {
    return Response.json({
      access_token: "sk-ant-oat-access",
      refresh_token: "sk-ant-ort-refresh",
      expires_in: 28800,
    });
  }

  if (key === "GET https://api.anthropic.com/api/oauth/profile") {
    return Response.json({
      account: { uuid: "acc-1", email: "me@x.com" },
      organization: { uuid: "org-1", name: "Org" },
    });
  }

  if (key === "GET https://api.anthropic.com/api/oauth/claude_cli/roles") return Response.json({});

  return undefined;
};

interface Started {
  readonly status: string;
  readonly url: string;
  readonly state: string;
  readonly flow?: string;
  readonly user_code?: string;
  readonly expires_in?: number;
}

const start = async (query: string): Promise<Started> => {
  const reply = await json(`/v9/management/oauth/auth-url?${query}`);
  expect(reply.status).toBe(200);

  return reply.body as Started;
};

const status = async (state: string) =>
  (await json(`/v9/management/oauth/status?state=${state}`)).body;

describe("management oauth routes", () => {
  it("requires a signed-in member of the org", async () => {
    expect(
      (await call("/v9/management/oauth/auth-url?provider=claude", { auth: false })).status,
    ).toBe(401);
    // A plain member starts a login for their own private credential.
    expect(
      (
        await call("/v9/management/oauth/auth-url?provider=claude", {
          auth: await token("other@x.com"),
        })
      ).status,
    ).toBe(200);
    expect(
      (await call("/v9/management/oauth/callback", { method: "POST", auth: false })).status,
    ).toBe(401);
  });

  it("completes a Claude login the way the panel does (paste the localhost redirect URL)", async () => {
    upstream = claudeUpstream;
    const started = await start("provider=claude&is_webui=true");
    expect(started).toMatchObject({ status: "ok" });
    expect(started.url.startsWith("https://claude.ai/oauth/authorize?")).toBe(true);
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await status(started.state)).toEqual({ status: "wait" });
    expect(await status("")).toEqual({ status: "ok" });

    // The panel posts {provider, redirect_url}; Claude's code page appends `#state`, which is ignored.
    const posted = await json(
      "/v9/management/oauth/callback",
      jsonInit("POST", {
        provider: "claude",
        redirect_url: `http://localhost:54545/callback?code=auth-code%23frag&state=${started.state}`,
      }),
    );

    expect(posted).toMatchObject({ status: 200, body: { status: "ok" } });
    expect(await status(started.state)).toEqual({ status: "ok" });

    // The credential is stored like the Go file and immediately selectable.
    const entries = (await json("/v9/management/credentials")).body as {
      files: Array<{ name: string }>;
    };

    expect(entries.files.map((file) => file.name)).toHaveLength(1);
    const stored = entries.files[0]?.name ?? "";
    expect(stored).toMatch(/^claude-[0-9a-f]{8}-me@x\.com\.json$/);

    const download = await json(
      `/v9/management/credentials/download?name=${encodeURIComponent(stored)}`,
      { auth: await serviceToken(SERVICE_ADMIN) },
    );

    expect(download.body).toMatchObject({
      type: "claude",
      email: "me@x.com",
      access_token: "sk-ant-oat-access",
      refresh_token: "sk-ant-ort-refresh",
      account_uuid: "acc-1",
      organization_uuid: "org-1",
      disabled: false,
    });

    const picked = await controlPlane()
      .models()
      .pick({ providers: ["claude"], model: "claude-sonnet-4-5" });

    expect(picked).toMatchObject({
      ok: true,
      credential: { id: stored, provider: "claude", authKind: "oauth" },
    });

    // Replaying the callback is a conflict.
    const replay = await json(
      "/v9/management/oauth/callback",
      jsonInit("POST", { provider: "claude", state: started.state, code: "again" }),
    );

    expect(replay).toMatchObject({
      status: 409,
      body: { status: "error", error: "oauth flow is already completed" },
    });
  });

  it("answers the Go error shapes", async () => {
    expect(await json("/v9/management/oauth/auth-url")).toMatchObject({
      status: 400,
      body: { error: "provider is required" },
    });
    expect(await json("/v9/management/oauth/auth-url?provider=nope")).toMatchObject({
      status: 404,
      body: { error: "provider_not_found" },
    });
    expect(await json("/v9/management/oauth/status?state=../x")).toMatchObject({
      status: 400,
      body: { status: "error", error: "invalid state" },
    });
    expect(await json(`/v9/management/oauth/status?state=${"a".repeat(32)}`)).toMatchObject({
      status: 200,
      body: { status: "error", error: "unknown or expired state" },
    });
    expect(await json("/v9/management/oauth/session", { method: "DELETE" })).toMatchObject({
      status: 400,
      body: { status: "error", error: "missing state" },
    });
    const post = (body: Json) => json("/v9/management/oauth/callback", jsonInit("POST", body));
    expect(
      await json("/v9/management/oauth/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "nope",
      }),
    ).toMatchObject({
      status: 400,
      body: { status: "error", error: "invalid body" },
    });
    expect(await post({ provider: "claude" })).toMatchObject({
      status: 400,
      body: { error: "state is required" },
    });
    expect(
      await post({ redirect_url: "http://localhost:54545/callback?state=" + "a".repeat(32) }),
    ).toMatchObject({
      status: 400,
      body: { error: "code or error is required" },
    });
    expect(await post({ state: "a".repeat(32), code: "c" })).toMatchObject({
      status: 404,
      body: { status: "error", error: "unknown or expired state" },
    });
  });

  it("cancels a pending login and rejects its callback", async () => {
    const started = await start("provider=codex");

    const cancelled = await json(`/v9/management/oauth/session?state=${started.state}`, {
      method: "DELETE",
    });

    expect(cancelled.body).toEqual({ status: "ok", cancelled: true });
    expect(
      (await json(`/v9/management/oauth/session?state=${started.state}`, { method: "DELETE" }))
        .body,
    ).toEqual({
      status: "ok",
      cancelled: false,
    });

    const posted = await json(
      "/v9/management/oauth/callback",
      jsonInit("POST", { provider: "codex", state: started.state, code: "c" }),
    );

    expect(posted.status).toBe(404);
    expect((await json("/v9/management/credentials")).body).toMatchObject({ files: [] });
  });

  it("records a provider error posted to the callback; the GET form is not served", async () => {
    const started = await start("provider=antigravity");

    expect(
      (
        await call(
          `/v9/management/oauth/callback?provider=antigravity&state=${started.state}&error=access_denied`,
        )
      ).status,
    ).toBe(404);
    expect(await status(started.state)).toMatchObject({ status: "wait" });

    const reply = await json(
      "/v9/management/oauth/callback",
      jsonInit("POST", { provider: "antigravity", state: started.state, error: "access_denied" }),
    );

    expect(reply).toMatchObject({ status: 200, body: { status: "ok" } });
    expect(await status(started.state)).toEqual({
      status: "error",
      error: "Authentication failed",
    });
  });

  it("reports the panel's expiry: the 5 minute callback window", async () => {
    const started = await start("provider=claude");
    await runInDurableObject(controlPlane(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE oauth_sessions SET deadline_at = ? WHERE state = ?",
        Date.now() - 1,
        started.state,
      );
    });
    expect(await status(started.state)).toEqual({
      status: "error",
      error: "Timeout waiting for OAuth callback",
    });

    const late = await json(
      "/v9/management/oauth/callback",
      jsonInit("POST", { provider: "claude", state: started.state, code: "c" }),
    );

    expect(late).toMatchObject({
      status: 409,
      body: { status: "error", error: "Timeout waiting for OAuth callback" },
    });
    expect(upstreamCalls).toEqual([]);
  });

  it("drives a device login by polling the status endpoint", async () => {
    let tokenCalls = 0;
    upstream = ({ method, url }) => {
      const key = `${method} ${url}`;

      if (key === "GET https://auth.x.ai/.well-known/openid-configuration") {
        return Response.json({
          device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
          token_endpoint: "https://auth.x.ai/oauth2/token",
        });
      }

      if (key === "POST https://auth.x.ai/oauth2/device/code") {
        return Response.json({
          device_code: "dc",
          user_code: "UC-1",
          verification_uri: "https://x.ai/device",
          expires_in: 900,
        });
      }

      if (key === "POST https://auth.x.ai/oauth2/token") {
        tokenCalls++;

        return tokenCalls === 1
          ? Response.json({ error: "authorization_pending" })
          : Response.json({ access_token: "xai-at", refresh_token: "xai-rt", expires_in: 3600 });
      }

      return undefined;
    };

    const started = await start("provider=xai");
    expect(started).toMatchObject({
      status: "ok",
      url: "https://x.ai/device",
      flow: "device",
      user_code: "UC-1",
      expires_in: 900,
    });
    expect(await status(started.state)).toEqual({ status: "wait" });
    // Polls before the provider interval (5 s) never reach the provider.
    expect(await status(started.state)).toEqual({ status: "wait" });
    expect(tokenCalls).toBe(1);
    await runInDurableObject(controlPlane(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE oauth_sessions SET next_poll_at = 0 WHERE state = ?",
        started.state,
      );
    });
    expect(await status(started.state)).toEqual({ status: "ok" });
    expect(tokenCalls).toBe(2);

    const files = (await json("/v9/management/credentials")).body as {
      files: Array<{ name: string; type?: string }>;
    };

    expect(files.files.map((file) => file.name)).toEqual([
      expect.stringMatching(/^xai-\d+\.json$/),
    ]);
    expect(
      await controlPlane()
        .models()
        .pick({ providers: ["xai"], model: "grok-4" }),
    ).toMatchObject({
      ok: true,
    });
  });
});

describe("public browser callbacks", () => {
  const get = (path: string) => call(path, { auth: false });

  it("completes a pending login without any Access credentials and exposes nothing", async () => {
    upstream = claudeUpstream;
    const started = await start("provider=claude");
    const response = await get(`/anthropic/callback?code=SECRET-CODE&state=${started.state}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("Authentication successful!");

    for (const secret of [
      "SECRET-CODE",
      started.state,
      "sk-ant-oat-access",
      "sk-ant-ort-refresh",
    ]) {
      expect(html).not.toContain(secret);
    }

    expect(await status(started.state)).toEqual({ status: "ok" });
    expect(
      ((await json("/v9/management/credentials")).body as { files: unknown[] }).files,
    ).toHaveLength(1);
  });

  it("only accepts the state of a pending login of that route's provider", async () => {
    upstream = claudeUpstream;
    const started = await start("provider=claude");

    const rejected = async (path: string) => {
      const response = await get(path);
      expect(response.status, path).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid request");
      expect(html).not.toContain("SECRET");
    };

    await rejected(`/anthropic/callback?code=SECRET&state=${"a".repeat(32)}`); // unknown state
    await rejected(`/codex/callback?code=SECRET&state=${started.state}`); // another provider's route
    await rejected(`/antigravity/callback?code=SECRET&state=${started.state}`);
    await rejected(`/devin/callback?code=SECRET&state=${started.state}`);
    await rejected(`/callback?code=SECRET&state=${started.state}`);
    await rejected("/anthropic/callback?code=SECRET"); // no state
    await rejected(`/anthropic/callback?state=${started.state}`); // neither code nor error
    await rejected("/anthropic/callback?code=SECRET&state=../../etc");
    expect(upstreamCalls).toEqual([]);
    expect(await status(started.state)).toEqual({ status: "wait" });

    // Device logins never take callbacks.
    upstream = ({ method, url }) =>
      `${method} ${url}` === "POST https://auth.openai.com/api/accounts/deviceauth/usercode"
        ? Response.json({ device_auth_id: "dai", user_code: "UC" })
        : undefined;
    const device = await start("provider=codex&flow=device");
    await rejected(`/codex/callback?code=SECRET&state=${device.state}`);

    // The right route works, once.
    expect((await get(`/anthropic/callback?code=ok&state=${started.state}`)).status).toBe(200);
    await rejected(`/anthropic/callback?code=ok&state=${started.state}`);
  });

  it("maps /callback and /devin/callback to Devin and answers failures with a neutral page", async () => {
    upstream = ({ method, url }) =>
      `${method} ${url}` === "POST https://api.devin.ai/auth/cli/token"
        ? new Response("denied", { status: 401 })
        : undefined;
    const started = await start("provider=devin");
    expect(started.url).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A8317%2Fcallback");
    const response = await get(`/devin/callback?code=SECRET-CODE&state=${started.state}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Authentication failed");
    expect(html).not.toContain("SECRET-CODE");
    expect(html).not.toContain("denied");
    expect(await status(started.state)).toEqual({
      status: "error",
      error: "Failed to exchange authorization code for tokens",
    });

    const other = await start("provider=devin");
    expect((await get(`/callback?error=access_denied&state=${other.state}`)).status).toBe(200);
    expect(await status(other.state)).toEqual({
      status: "error",
      error: "Devin authorization denied",
    });
  });
});

describe("production wiring", () => {
  it("serves the public callback routes without Access (and refuses unknown states)", async () => {
    const response = await exports.default.fetch(
      new Request(`https://commissary.test/anthropic/callback?code=c&state=${"a".repeat(32)}`),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("Invalid request");
  });
});
