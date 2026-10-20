// Test harness for the API Worker's client gate: the gate (src/http/gate.ts) with a fake Access JWKS in front of
// client API routes (stand-ins or the real ones), on the real ControlPlanes. Orgs, members and API keys are set up
// straight through the state Worker's objects: the management routes that do it are the app Worker's
// (apps/app/test/support/management.ts).
import { env } from "cloudflare:workers";
import { Context, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { type AccessPrincipal, AuthDirectory, syncOrgIndex } from "@commissary/auth";
import {
  AUD,
  fakeJwksLayer,
  makeFakeJwks,
  makeKey,
  serviceClaims,
  signToken,
  userClaims,
} from "@commissary/auth/testing";
import type { ToolScope } from "@commissary/contract/api-keys";
import { CurrentOrg, GLOBAL_ORG, newOrgId, type OrgId } from "@commissary/core";
import { controlPlaneOf, stateAuthDirectory } from "@commissary/state";
import { makeBehindGate, makeGateLayer } from "../../src/http/gate.ts";
import { RootRoutes } from "../../src/http/routes.ts";
import { requestContext } from "../../src/worker-env.ts";

export const key = await makeKey("client-kid");

export const ADMIN = "admin@example.com";

const baseEnv = {
  ...env,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  PLATFORM_ADMIN_EMAILS: ADMIN,
  PLATFORM_ADMIN_SERVICE_TOKENS: "",
  ACCESS_DEV_BYPASS: "",
};

// SAFETY: the gate and the routes under test never call the execution context's methods.
const ctx = {} as unknown as ExecutionContext;

/** An Access sign-in of `email`, as `Cf-Access-Jwt-Assertion` carries it. */
export const token = async (email: string = ADMIN): Promise<string> =>
  await signToken({ key, now: Math.floor(Date.now() / 1000), claims: userClaims(email) });

/** An Access service token assertion for the client id `commonName`. */
export const serviceToken = async (commonName: string): Promise<string> =>
  await signToken({ key, now: Math.floor(Date.now() / 1000), claims: serviceClaims(commonName) });

export interface ClientHarness {
  readonly call: (
    path: string,
    init?: RequestInit & { readonly auth?: false | string },
  ) => Promise<Response>;
  readonly json: (
    path: string,
    init?: RequestInit & { readonly auth?: false | string },
  ) => Promise<{ status: number; body: unknown; headers: Headers }>;
  readonly dispose: () => Promise<void>;
}

/**
 * `routes` (client API routes, stand-ins or real) behind the gate, with `bindings` over the test Worker's. A request
 * carries an Access sign-in of {@link ADMIN} unless `auth` names another JWT or is `false`.
 */
export const makeClientHarness = (
  routes: Layer.Layer<
    never,
    never,
    HttpRouter.HttpRouter | HttpRouter.Request<"Requires", AccessPrincipal>
  >,
  bindings: Partial<Env> = {},
): ClientHarness => {
  const gate = makeGateLayer(fakeJwksLayer(makeFakeJwks([key])));

  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(RootRoutes, gate, makeBehindGate(gate)(routes)),
    { disableLogger: true },
  );

  const call: ClientHarness["call"] = async (path, init = {}) => {
    const { auth, ...rest } = init;
    const headers = new Headers(rest.headers);

    if (auth !== false) headers.set("Cf-Access-Jwt-Assertion", auth ?? (await token()));

    return await web.handler(
      new Request(`https://commissary.test${path}`, { ...rest, headers }),
      Context.add(requestContext({ ...baseEnv, ...bindings }, ctx), CurrentOrg, GLOBAL_ORG),
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
    dispose: web.dispose,
  };
};

/**
 * A Platform registry of its own for one harness (the Worker has one object per deployment, which the tests of a file
 * share): pass `bindings` to `makeClientHarness`, and create orgs through it without touching other tests' orgs.
 */
export const isolatedPlatform = () => {
  const stub = env.PLATFORM.getByName(`platform-${crypto.randomUUID()}`);

  // SAFETY: only `getByName` is read from the binding (`platformOf`), and it answers with a real Platform stub.
  const bindings = { PLATFORM: { getByName: () => stub } as unknown as Env["PLATFORM"] };

  return { bindings: bindings satisfies Partial<Env>, platform: stub };
};

/** Who sets up the orgs here: an owner with the sensitive powers, as a platform admin is. */
const OWNER = { role: "owner", sensitive: true } as const;

/** A member of an org, as the tests act as them: their id and email. */
export interface TestMember {
  readonly id: string;
  readonly email: string;
}

/** Makes `email` a member of `org` with `role`, as `POST /members` does (the member routes are the app Worker's). */
export const addMember = async (
  org: OrgId,
  email: string,
  role: "owner" | "admin" | "member",
): Promise<TestMember> => {
  const added = await controlPlaneOf(env, org).addMember({ email, role }, OWNER, "test");

  if (!added.ok) throw new Error(added.message);

  return { id: added.value.id, email };
};

/**
 * An org of its own in `registry`, with an admin and two plain members, as `POST /orgs` and `POST /members` create
 * them (the membership index included); `privateCredentials` lets its members connect their own.
 */
export const staffedOrg = async (
  registry: ReturnType<typeof isolatedPlatform>,
  prefix: string,
  privateCredentials = false,
) => {
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const org = newOrgId();

  if (privateCredentials)
    await controlPlaneOf(env, org).setMembershipSettings({ privateCredentials: true });

  const created = await registry.platform.createOrg({ slug, name: slug, id: org }, Date.now());

  if (!created.ok) throw new Error(created.message);

  const staff = {
    org,
    slug,
    admin: await addMember(org, `admin-${slug}@example.com`, "admin"),
    alice: await addMember(org, `alice-${slug}@example.com`, "member"),
    bob: await addMember(org, `bob-${slug}@example.com`, "member"),
  };

  await Effect.runPromise(
    syncOrgIndex(org).pipe(
      Effect.provideService(AuthDirectory, stateAuthDirectory({ ...env, ...registry.bindings })),
    ),
  );

  return staff;
};

/**
 * An API key of `member` in `org`, issued as `POST /api-keys` issues it: its id and whole text. `toolScope` gives it a
 * tool scope (#200); without one it may use every tool its member may use.
 */
export const issueKey = async (
  org: OrgId,
  member: TestMember,
  name = "laptop",
  expiresAt?: number,
  toolScope?: ToolScope,
): Promise<{ readonly id: string; readonly key: string }> => {
  const issued = await controlPlaneOf(env, org).createApiKey(
    {
      memberId: member.id,
      name,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(toolScope === undefined ? {} : { toolScope }),
    },
    Date.now(),
  );

  if (!issued.ok) throw new Error(issued.message);

  return { id: issued.value.record.id, key: issued.value.key };
};
