import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { makeAccessLayer, makeWithAccess } from "../src/access/layer.ts";
import { AccessPrincipal } from "@commissary/auth";
import { RootRoutes } from "../src/http/routes.ts";
import {
  AUD,
  fakeJwksLayer,
  makeFakeJwks,
  makeKey,
  serviceClaims,
  signToken,
  userClaims,
} from "@commissary/auth/testing";
import { requestContext } from "../src/worker-env.ts";

const key = await makeKey("router-kid");

const whoami = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  return HttpServerResponse.text(
    JSON.stringify(identity.principal) + "|" + identity.callerScope.slice(0, 8),
  );
});

// A stand-in management route. The client API's gate is the API Worker's (apps/api/test/access-router.test.ts).
const TestRoutes = HttpRouter.add("GET", "/v9/management/config", whoami);

const accessEnv = {
  ...env,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  PLATFORM_ADMIN_EMAILS: "admin@example.com",
  PLATFORM_ADMIN_SERVICE_TOKENS: "admin.access",
  ACCESS_DEV_BYPASS: "",
};

const ctx = {} as unknown as ExecutionContext;

const makeHandler = () => {
  const access = makeAccessLayer(fakeJwksLayer(makeFakeJwks([key])));

  return HttpRouter.toWebHandler(
    Layer.mergeAll(RootRoutes, access, makeWithAccess(access)(TestRoutes)),
    {
      disableLogger: true,
    },
  );
};

const withToken = async (claims: Record<string, unknown>): Promise<RequestInit> => ({
  headers: { "Cf-Access-Jwt-Assertion": await jwt(claims) },
});

const now = () => Math.floor(Date.now() / 1000);

const jwt = (claims: Record<string, unknown>) => signToken({ key, now: now(), claims });

describe("Access gate through the router", () => {
  const { handler, dispose } = makeHandler();
  afterAll(dispose);

  const call = (
    path: string,
    init: RequestInit = {},
    bindings: Env = accessEnv,
    base = "https://commissary.test",
  ) => handler(new Request(`${base}${path}`, init), requestContext(bindings, ctx));

  it("keeps /healthz public and gates / (the control panel)", async () => {
    expect((await call("/healthz")).status).toBe(200);
    expect((await call("/")).status).toBe(401);
    expect((await call("/nope")).status).toBe(404);
  });

  it("rejects management routes without a token and never adds CORS headers there", async () => {
    const response = await call("/v9/management/config");
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":"Missing API key"}');
    expect(response.headers.get("access-control-allow-origin")).toBeNull();

    const admin = await call(
      "/v9/management/config",
      await withToken(userClaims("admin@example.com")),
    );

    expect(admin.status).toBe(200);
    expect(admin.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await call("/v9/management/config", {
      method: "OPTIONS",
      headers: { origin: "https://evil.test", "access-control-request-method": "POST" },
    });

    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-headers")).toBeNull();
  });

  it("enforces the admin allow-list on management routes", async () => {
    const alice = await call(
      "/v9/management/config",
      await withToken(userClaims("alice@example.com")),
    );

    expect(alice.status).toBe(403);
    expect(await alice.text()).toBe('{"error":"Forbidden"}');

    const admin = await call(
      "/v9/management/config",
      await withToken(userClaims("Admin@Example.com")),
    );

    expect(admin.status).toBe(200);

    const adminService = await call(
      "/v9/management/config",
      await withToken(serviceClaims("admin.access")),
    );

    expect(adminService.status).toBe(200);

    const otherService = await call(
      "/v9/management/config",
      await withToken(serviceClaims("other.access")),
    );

    expect(otherService.status).toBe(403);
  });

  it("dev bypass works for loopback hosts only", async () => {
    const dev = { ...accessEnv, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", ACCESS_DEV_BYPASS: "true" };
    const local = await call("/v9/management/config", {}, dev, "http://localhost:8787");
    expect(local.status).toBe(200);
    expect(await local.text()).toContain('"email":"dev@localhost"');
    const remote = await call("/v9/management/config", {}, dev);
    expect(remote.status).toBe(500);
  });

  it("refuses the dev bypass when Access is configured (team domain or AUD set)", async () => {
    for (const bindings of [
      { ...accessEnv, ACCESS_DEV_BYPASS: "true" },
      { ...accessEnv, ACCESS_AUD: "", ACCESS_DEV_BYPASS: "true" },
      { ...accessEnv, ACCESS_TEAM_DOMAIN: "", ACCESS_DEV_BYPASS: "true" },
    ]) {
      const response = await call("/v9/management/config", {}, bindings, "http://localhost:8787");
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain("dev@localhost");
    }

    // With full Access settings the request is authenticated normally.
    const refused = await call(
      "/v9/management/config",
      {},
      { ...accessEnv, ACCESS_DEV_BYPASS: "true" },
      "http://localhost:8787",
    );

    expect(refused.status).toBe(401);

    const token = await call(
      "/v9/management/config",
      await withToken(userClaims("admin@example.com")),
      { ...accessEnv, ACCESS_DEV_BYPASS: "true" },
      "http://localhost:8787",
    );

    expect(token.status).toBe(200);
  });
});
