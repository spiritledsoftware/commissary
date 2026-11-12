// The Access gate of a self-hosted Commissary through the Worker's Durable Objects (`authenticateRequest`: the
// management entry point of @commissary/auth with the Worker's routes; `authenticateClient`, the API Worker's, for the
// same people on the client API), and the path zones. JWT verification, the principal and
// the Access settings are tested in packages/auth.
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { authenticateRequest } from "../src/access/authenticate.ts";
import { type AccessJwks, authenticateClient, callerScope } from "@commissary/auth";
import {
  AUD,
  fakeJwksLayer,
  type FakeJwks,
  makeFakeJwks,
  makeKey,
  serviceClaims,
  signToken,
  type TestKey,
  userClaims,
} from "@commissary/auth/testing";
import { classifyPath } from "../src/management/zones.ts";
import { env } from "cloudflare:workers";
import { GLOBAL_ORG, type OrgId } from "@commissary/core";
import { controlPlaneOf, platformOf } from "@commissary/state";
import { requestContext } from "../src/worker-env.ts";

const NOW_MS = 1_700_000_000_000;

const NOW = NOW_MS / 1000;

const keyA = await makeKey("kid-a");

/** Runs `body` at a fixed virtual time with one JWKS cache shared by every verification inside it. */
const withJwks = <A, E>(
  state: FakeJwks,
  body: Effect.Effect<A, E, AccessJwks>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);

    return yield* body.pipe(Effect.provide(fakeJwksLayer(state)));
  });

/** Who adds the members these tests need: an org owner with the sensitive powers. */
const OWNER = { role: "owner", sensitive: true } as const;

/** Makes `email` a member of `org` with `role` (the member routes are tested in members.test.ts). */
const addMember = (org: OrgId, email: string, role: "owner" | "admin" | "member") =>
  Effect.promise(async () => {
    const added = await controlPlaneOf(env, org).addMember({ email, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return added.value;
  });

const token = (key: TestKey, overrides: Partial<Parameters<typeof signToken>[0]> = {}) =>
  Effect.promise(() =>
    signToken({ key, now: NOW, claims: userClaims("alice@example.com"), ...overrides }),
  );

describe("authenticateRequest", () => {
  const testEnv = {
    ...env,
    ACCESS_TEAM_DOMAIN: "team",
    ACCESS_AUD: AUD,
    PLATFORM_ADMIN_EMAILS: "Admin@Example.com",
    PLATFORM_ADMIN_SERVICE_TOKENS: "admin.access",
  };

  const context = requestContext(testEnv, {} as unknown as ExecutionContext);

  const run = <A, E>(
    state: FakeJwks,
    body: Effect.Effect<
      A,
      E,
      | import("../src/worker-env.ts").EnvServices
      | AccessJwks
      | import("@commissary/core").CurrentOrg
    >,
  ) => withJwks(state, body.pipe(Effect.provideContext(context)));

  it.effect("fails with Missing API key when the header is absent", () =>
    run(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          authenticateClient({}, "https://commissary.test/v1/models"),
        );

        assert.strictEqual(error._tag, "UnauthorizedError");
        assert.strictEqual(error.message, "Missing API key");
      }),
    ),
  );

  it.effect("derives the identity and enforces the admin allow-list for management", () =>
    run(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const url = "https://commissary.test/v9/management/config";
        const alice = { "cf-access-jwt-assertion": yield* token(keyA) };
        const identity = yield* authenticateClient(alice, url);
        assert.strictEqual(identity.principalId, "user:alice@example.com");
        assert.strictEqual(
          identity.callerScope,
          "21cd36b03d03c619f37e1df80f5e22b7c4c9319b4e8151ea93327b51520a06e9",
        );
        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest(alice, url)))._tag,
          "ForbiddenError",
        );

        const admin = {
          "cf-access-jwt-assertion": yield* token(keyA, {
            claims: userClaims("ADMIN@example.com"),
          }),
        };

        assert.strictEqual((yield* authenticateRequest(admin, url)).principal.kind, "user");

        const svc = {
          "cf-access-jwt-assertion": yield* token(keyA, { claims: serviceClaims("admin.access") }),
        };

        assert.strictEqual(
          (yield* authenticateRequest(svc, url)).principalId,
          "service:admin.access",
        );

        const other = {
          "cf-access-jwt-assertion": yield* token(keyA, { claims: serviceClaims("other.access") }),
        };

        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest(other, url)))._tag,
          "ForbiddenError",
        );
      }),
    ),
  );

  it.effect("admits members with the role the route needs, and nobody once removed", () =>
    run(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const config = "https://commissary.test/v9/management/config";
        const usage = "https://commissary.test/v9/management/observability/usage/records";
        const stub = controlPlaneOf(env, GLOBAL_ORG);
        const carol = yield* addMember(GLOBAL_ORG, "carol@example.com", "admin");
        const dan = yield* addMember(GLOBAL_ORG, "dan@example.com", "member");

        const as = (email: string) =>
          token(keyA, { claims: userClaims(email) }).pipe(
            Effect.map((jwt) => ({ "cf-access-jwt-assertion": jwt })),
          );

        const asCarol = yield* as("Carol@Example.com");
        const identity = yield* authenticateRequest(asCarol, config);
        assert.strictEqual(identity.role, "admin");
        assert.strictEqual(identity.memberId, carol.id);
        assert.isFalse(identity.platformAdmin);

        // A plain member reads usage and uses Commissary, but no admin route.
        const asDan = yield* as("dan@example.com");
        assert.strictEqual((yield* authenticateRequest(asDan, usage)).role, "member");
        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest(asDan, usage, "DELETE")))._tag,
          "ForbiddenError",
        );
        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest(asDan, config)))._tag,
          "ForbiddenError",
        );
        assert.strictEqual(
          (yield* authenticateClient(asDan, "https://commissary.test/v1/models")).memberId,
          dan.id,
        );

        // Removed: refused on the next request.
        yield* Effect.promise(async () => await stub.removeMember(carol.id, OWNER));
        yield* Effect.promise(() => stub.setMembershipSettings({ autoJoin: false }));

        try {
          assert.strictEqual(
            (yield* Effect.flip(authenticateRequest(asCarol, config)))._tag,
            "ForbiddenError",
          );
          assert.strictEqual(
            (yield* Effect.flip(authenticateClient(asCarol, "https://commissary.test/v1/models")))
              ._tag,
            "ForbiddenError",
          );
        } finally {
          yield* Effect.promise(() => stub.setMembershipSettings({ autoJoin: true }));
          yield* Effect.promise(async () => await stub.removeMember(dan.id, OWNER));
        }
      }),
    ),
  );

  it.effect("fails closed with a configuration error when Access is not configured", () =>
    withJwks(
      makeFakeJwks([keyA]),
      authenticateClient({}, "https://commissary.test/v1/models").pipe(
        Effect.provideContext(
          requestContext(
            { ...env, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" },
            {} as unknown as ExecutionContext,
          ),
        ),
        Effect.flip,
        Effect.map((error) => assert.strictEqual(error._tag, "ConfigurationError")),
      ),
    ),
  );
});

describe("authenticateRequest and orgs", () => {
  const testEnv = {
    ...env,
    ACCESS_TEAM_DOMAIN: "team",
    ACCESS_AUD: AUD,
    PLATFORM_ADMIN_EMAILS: "admin@example.com",
    PLATFORM_ADMIN_SERVICE_TOKENS: "",
  };

  const context = requestContext(testEnv, {} as unknown as ExecutionContext);

  const run = <A, E>(
    body: Effect.Effect<
      A,
      E,
      | import("../src/worker-env.ts").EnvServices
      | AccessJwks
      | import("@commissary/core").CurrentOrg
    >,
  ) => withJwks(makeFakeJwks([keyA]), body.pipe(Effect.provideContext(context)));

  const as = (email: string) =>
    Effect.promise(async () => ({
      "cf-access-jwt-assertion": await signToken({
        key: keyA,
        now: NOW,
        claims: userClaims(email),
      }),
    }));

  const registered = (slug: string) =>
    Effect.promise(async () => {
      const created = await platformOf(env).createOrg({ slug, name: slug }, NOW_MS);

      if (!created.ok) throw new Error(created.message);

      return created.org;
    });

  it.effect("gives a platform admin any org the registry lists, by its slug", () =>
    run(
      Effect.gen(function* () {
        const org = yield* registered("acme-access");
        const admin = yield* as("admin@example.com");

        const scoped = yield* authenticateRequest(
          admin,
          "https://commissary.test/v9/management/orgs/acme-access/config",
        );

        assert.strictEqual(scoped.org, org.id);
        assert.isTrue(scoped.platformAdmin);
        // Its caller scope is the one of that org, not of `global`.
        assert.strictEqual(
          scoped.callerScope,
          yield* callerScope("user:admin@example.com", org.id),
        );

        const panel = yield* authenticateRequest(
          admin,
          "https://commissary.test/o/acme-access/accounts",
        );

        assert.strictEqual(panel.org, org.id);

        const unscoped = yield* authenticateRequest(
          admin,
          "https://commissary.test/v9/management/config",
        );

        assert.strictEqual(unscoped.org, GLOBAL_ORG);
        assert.isTrue(unscoped.platformAdmin);

        // Platform-level routes address no org.
        const platformLevel = yield* authenticateRequest(
          admin,
          "https://commissary.test/v9/management/orgs/acme-access",
        );

        assert.strictEqual(platformLevel.org, GLOBAL_ORG);
      }),
    ),
  );

  it.effect("answers an unknown slug with 404 to a platform admin and 403 to anyone else", () =>
    run(
      Effect.gen(function* () {
        const url = "https://commissary.test/v9/management/orgs/nobody-here/config";

        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest(yield* as("admin@example.com"), url)))._tag,
          "NotFoundError",
        );
        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest(yield* as("carol@example.com"), url)))._tag,
          "ForbiddenError",
        );
        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest(yield* as("dave@example.com"), url)))._tag,
          "ForbiddenError",
        );
        // Not signed in: 401 before anything is looked up.
        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest({}, url)))._tag,
          "UnauthorizedError",
        );
      }),
    ),
  );

  it.effect("limits an org admin to the orgs they are a member of", () =>
    run(
      Effect.gen(function* () {
        yield* registered("acme-limits");
        const carol = yield* as("erin@example.com");
        yield* addMember(GLOBAL_ORG, "erin@example.com", "admin");

        const own = yield* authenticateRequest(
          carol,
          "https://commissary.test/v9/management/orgs/default/config",
        );

        assert.strictEqual(own.org, GLOBAL_ORG);
        assert.isFalse(own.platformAdmin);

        assert.strictEqual(
          (yield* authenticateRequest(carol, "https://commissary.test/v9/management/config")).org,
          GLOBAL_ORG,
        );

        for (const url of [
          "https://commissary.test/v9/management/orgs/acme-limits/config",
          "https://commissary.test/o/acme-limits/accounts",
        ]) {
          assert.strictEqual(
            (yield* Effect.flip(authenticateRequest(carol, url)))._tag,
            "ForbiddenError",
          );
        }
      }),
    ),
  );

  it.effect("marks the platform admins of a protected route without scoping it", () =>
    run(
      Effect.gen(function* () {
        const alice = yield* authenticateClient(
          yield* as("alice@example.com"),
          "https://commissary.test/v1/models",
        );

        const admin = yield* authenticateClient(
          yield* as("admin@example.com"),
          "https://commissary.test/v1/models",
        );

        assert.isFalse(alice.platformAdmin);
        assert.isTrue(admin.platformAdmin);
        assert.strictEqual(alice.org, GLOBAL_ORG);
      }),
    ),
  );
});

describe("classifyPath", () => {
  it("classifies public, protected and management paths", () => {
    expect(classifyPath("https://x.test/healthz")).toBe("public");
    expect(classifyPath("https://x.test/")).toBe("management");
    expect(classifyPath("https://x.test/nope")).toBe("public");

    for (const path of [
      "/v1/chat/completions",
      "/v1",
      "/v1beta/models/gemini:generateContent",
      "/v1internal:generateContent",
      "/openai/v1/videos",
      "/backend-api/codex/responses",
    ]) {
      expect(classifyPath(`https://x.test${path}?q=1`)).toBe("protected");
    }

    expect(classifyPath("https://x.test/v9/management/config")).toBe("management");
  });

  it("is not fooled by alternative spellings", () => {
    expect(classifyPath("https://x.test//v1/models")).toBe("protected");
    expect(classifyPath("https://x.test/V1/models")).toBe("protected");
    expect(classifyPath("https://x.test/%76%31/models")).toBe("protected");
    expect(classifyPath("https://x.test/a/../v1/models")).toBe("protected");
    expect(classifyPath("https://x.test/V9/Management/x")).toBe("management");
    expect(classifyPath("https://x.test/%2576%31/models")).toBe("public");
  });
});
