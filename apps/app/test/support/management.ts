// Test harness for the management routes: Access gate with a fake JWKS, real ControlPlane, mocked outbound HTTP.
import { env } from "cloudflare:workers";
import { Context, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { makeAccessLayer, makeWithAccess } from "../../src/access/layer.ts";
import { orgAddressing } from "../../src/management/org-address.ts";
import { RootRoutes } from "../../src/http/routes.ts";
import { ManagementRoutes } from "../../src/management/routes.ts";
import { CurrentOrg, GLOBAL_ORG, type OrgId } from "@commissary/core";
import {
  AUD,
  fakeJwksLayer,
  makeFakeJwks,
  makeKey,
  serviceClaims,
  signToken,
  userClaims,
} from "@commissary/auth/testing";
import { requestContext } from "../../src/worker-env.ts";
import { OAuthCallbackRoutes } from "@commissary/models/management";
import { SignInCallbackRoutes } from "@commissary/tools/management";
import { managementServicesWith, type MockHandler, mockHttp } from "@commissary/models/testing";

// The ControlPlane helpers of Models' tests (the stub of an org, a pristine Models part, an auth file, a JSON body).
export {
  claudeFile,
  controlPlane,
  jsonInit,
  resetControlPlane,
  resetOrgControlPlane,
} from "@commissary/models/testing";

export const key = await makeKey("management-kid");

export const ADMIN = "admin@example.com";

/** An Access service token Client ID for tests that need a service-token administrator (`SERVICE_ADMIN_BINDINGS`). */
export const SERVICE_ADMIN = "automation.access";

/** Pass to `makeHarness` as the bindings to make `SERVICE_ADMIN` an administrator. */
export const SERVICE_ADMIN_BINDINGS: Partial<Env> = {
  PLATFORM_ADMIN_SERVICE_TOKENS: SERVICE_ADMIN,
};

const baseEnv = {
  ...env,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  PLATFORM_ADMIN_EMAILS: ADMIN,
  PLATFORM_ADMIN_SERVICE_TOKENS: "",
  ACCESS_DEV_BYPASS: "",
};

const ctx = {} as unknown as ExecutionContext;

export const token = async (email: string = ADMIN): Promise<string> =>
  await signToken({ key, now: Math.floor(Date.now() / 1000), claims: userClaims(email) });

/** An Access service token assertion for the client id `commonName`. */
export const serviceToken = async (commonName: string): Promise<string> =>
  await signToken({ key, now: Math.floor(Date.now() / 1000), claims: serviceClaims(commonName) });

export interface Harness {
  readonly call: (
    path: string,
    init?: RequestInit & { readonly auth?: false | string },
  ) => Promise<Response>;
  readonly json: (
    path: string,
    init?: RequestInit & { readonly auth?: false | string },
  ) => Promise<{ status: number; body: unknown; headers: Headers }>;
  readonly requests: ReturnType<typeof mockHttp>["requests"];
  readonly dispose: () => Promise<void>;
}

/**
 * `org`: the org every request of the harness belongs to (the Worker resolves `global` for now). The client API is the
 * API Worker's (apps/api/test/support/client.ts).
 */
export const makeHarness = (
  http: MockHandler = () => ({ status: 404 }),
  bindings: Partial<Env> = {},
  org: OrgId = GLOBAL_ORG,
): Harness => {
  const outbound = mockHttp(http);
  const access = makeAccessLayer(fakeJwksLayer(makeFakeJwks([key])));

  const routes = ManagementRoutes.pipe(Layer.provide(managementServicesWith(outbound.layer)));

  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      RootRoutes,
      OAuthCallbackRoutes,
      access,
      makeWithAccess(access)(routes),
      makeWithAccess(access)(SignInCallbackRoutes),
    ),
    { disableLogger: true, middleware: orgAddressing },
  );

  const call: Harness["call"] = async (path, init = {}) => {
    const { auth, ...rest } = init;
    const headers = new Headers(rest.headers);

    if (auth !== false) headers.set("Cf-Access-Jwt-Assertion", auth ?? (await token()));

    const url = `https://commissary.test${path}`;

    return await web.handler(
      new Request(url, { ...rest, headers }),
      Context.add(requestContext({ ...baseEnv, ...bindings }, ctx, url), CurrentOrg, org),
    );
  };

  return {
    call,
    json: async (path, init) => {
      const response = await call(path, init);
      const text = await response.text();

      return {
        status: response.status,
        body: text === "" ? undefined : (JSON.parse(text) as unknown),
        headers: response.headers,
      };
    },
    requests: outbound.requests,
    dispose: web.dispose,
  };
};

/**
 * A Platform registry of its own for one harness (the Worker has one object per deployment, which the tests of a file
 * share): pass `bindings` to `makeHarness`, and create and rename orgs through `platform` without touching other
 * tests' orgs.
 */
export const isolatedPlatform = () => {
  const stub = env.PLATFORM.getByName(`platform-${crypto.randomUUID()}`);

  // SAFETY: only `getByName` is read from the binding (`platformOf`), and it answers with a real Platform stub.
  const bindings = { PLATFORM: { getByName: () => stub } as unknown as Env["PLATFORM"] };

  return { bindings: bindings satisfies Partial<Env>, platform: stub };
};
