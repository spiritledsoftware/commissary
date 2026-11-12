// The API Worker's client gate through the router (src/http/gate.ts): CORS, the cross-site checks and
// `@commissary/auth`'s `authenticateClient` in front of stand-in client API routes, with a fake Access JWKS. API keys
// themselves are tested in api-keys.test.ts.
import { env, exports } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { makeBehindGate, makeGateLayer } from "../src/http/gate.ts";
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

// Stand-ins for the client API's handlers, one per gated prefix.
const TestRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/v1/models", whoami),
  HttpRouter.add("POST", "/v1/chat/completions", whoami),
  HttpRouter.add("GET", "/v1beta/models", whoami),
  HttpRouter.add("GET", "/openai/v1/videos", whoami),
  HttpRouter.add("POST", "/backend-api/codex/responses", whoami),
);

const accessEnv = {
  ...env,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  PLATFORM_ADMIN_EMAILS: "admin@example.com",
  PLATFORM_ADMIN_SERVICE_TOKENS: "admin.access",
  ACCESS_DEV_BYPASS: "",
};

// SAFETY: the gate and the routes under test never call the execution context's methods.
const ctx = {} as unknown as ExecutionContext;

const makeHandler = () => {
  const gate = makeGateLayer(fakeJwksLayer(makeFakeJwks([key])));

  return HttpRouter.toWebHandler(
    Layer.mergeAll(RootRoutes, gate, makeBehindGate(gate)(TestRoutes)),
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

describe("client gate through the router", () => {
  const { handler, dispose } = makeHandler();
  afterAll(dispose);

  const call = (
    path: string,
    init: RequestInit = {},
    bindings: Env = accessEnv,
    base = "https://commissary.test",
  ) => handler(new Request(`${base}${path}`, init), requestContext(bindings, ctx));

  it.each([
    ["GET", "/v1/models"],
    ["POST", "/v1/chat/completions"],
    ["GET", "/v1beta/models"],
    ["GET", "/openai/v1/videos"],
    ["POST", "/backend-api/codex/responses"],
    ["POST", "/chat/completions"],
    ["POST", "/completions"],
    ["POST", "/responses"],
    ["POST", "/responses/compact"],
    ["GET", "//Responses"],
  ])(
    "rejects %s %s without a token (flat Go-style body, CORS headers kept)",
    async (method, path) => {
      const response = await call(path, { method });
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.text()).toBe('{"error":"Missing API key"}');
    },
  );

  it("rejects malformed and foreign tokens with Invalid API key", async () => {
    const malformed = await call("/v1/models", {
      headers: { "cf-access-jwt-assertion": "garbage" },
    });

    expect(malformed.status).toBe(401);
    expect(await malformed.text()).toBe('{"error":"Invalid API key"}');

    const other = await makeKey("router-kid");

    const forged = await signToken({
      key: other,
      now: now(),
      claims: userClaims("alice@example.com"),
    });

    expect(
      (await call("/v1/models", { headers: { "cf-access-jwt-assertion": forged } })).status,
    ).toBe(401);

    const wrongAud = await signToken({
      key,
      now: now(),
      claims: userClaims("a@x.com"),
      audience: "nope",
    });

    expect(
      (await call("/v1/models", { headers: { "cf-access-jwt-assertion": wrongAud } })).status,
    ).toBe(401);
  });

  it("passes a valid user token to the handler with the principal", async () => {
    const response = await call("/v1/models", await withToken(userClaims("alice@example.com")));
    expect(response.status).toBe(200);
    const [principal, scope] = (await response.text()).split("|");
    expect(JSON.parse(principal ?? "")).toEqual({
      kind: "user",
      email: "alice@example.com",
      sub: "sub-alice@example.com",
    });
    expect(scope).toBe("21cd36b0");
  });

  it("accepts service tokens on the client API", async () => {
    const response = await call("/v1/chat/completions", {
      method: "POST",
      ...(await withToken(serviceClaims("some.access"))),
    });

    expect(response.status).toBe(200);
    expect(
      (await response.text()).startsWith('{"kind":"service","commonName":"some.access"}'),
    ).toBe(true);
  });

  it("answers CORS preflights without authentication", async () => {
    const response = await call("/v1/models", {
      method: "OPTIONS",
      headers: { origin: "https://x.test" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("does not let alternative path spellings bypass the gate", async () => {
    for (const path of [
      "//v1/models",
      "/%76%31/models",
      "/V1/models",
      "/./v1/models",
      "/a/../v1/models",
    ]) {
      const response = await call(path);
      expect([401, 404], path).toContain(response.status);
      expect(await response.text()).not.toContain("kind");
    }
  });

  it("fails closed with 500 when Access is not configured", async () => {
    const response = await call("/v1/models", await withToken(userClaims("alice@example.com")), {
      ...accessEnv,
      ACCESS_TEAM_DOMAIN: "",
      ACCESS_AUD: "",
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"Authentication service error"}');
    expect((await call("/healthz", {}, { ...accessEnv, ACCESS_TEAM_DOMAIN: "" })).status).toBe(200);
  });
});

const fetchWorker = (path: string) =>
  exports.default.fetch(new Request(`https://commissary.test${path}`));

describe("Worker entry point", () => {
  it("serves public routes and gates protected ones (unconfigured defaults fail closed)", async () => {
    expect((await fetchWorker("/healthz")).status).toBe(200);
    const response = await fetchWorker("/v1/models");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"Authentication service error"}');
  });
});
