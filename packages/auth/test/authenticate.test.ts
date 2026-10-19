// The two entry points (`authenticateClient`, `authenticateManagement`) over the in-memory AuthDirectory, on a
// self-hosted Commissary (Access) and on Commissary Cloud. The gate through the Worker's router and Durable Objects is
// tested in apps/app (access.test.ts, api-keys.test.ts, management-keys.test.ts, test/hosted/), the sign-up on a
// session's start in apps/auth (test/sign-up.test.ts).
import { assert, describe, it } from "@effect/vitest";
import { CurrentOrg, GLOBAL_ORG, OrgSlug } from "@commissary/core";
import { Context, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach } from "vitest";
import {
  type AccessJwks,
  AuthConfig,
  type AuthBindings,
  type AuthDirectory,
  authenticateClient,
  authenticateManagement,
  ensureSignedUp,
  NOT_SIGNED_IN,
  resetApiKeyCaches,
  resetManagementKeyCache,
  resetStandingCaches,
  type SignedInPerson,
  SignInSessions,
  SUSPENDED,
} from "../src/index.ts";
import {
  AUD,
  fakeJwksLayer,
  makeFakeJwks,
  makeKey,
  type MemoryDirectory,
  memoryDirectory,
  serviceClaims,
  signToken,
  userClaims,
} from "./testing.ts";

const NOW_MS = 1_700_000_000_000;

const key = await makeKey("kid-a");

const SELF_HOSTED: AuthBindings = {
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  PLATFORM_ADMIN_EMAILS: "admin@example.com",
  PLATFORM_ADMIN_SERVICE_TOKENS: "admin.access",
  ACCESS_DEV_BYPASS: "",
};

const CLIENT_URL = "https://commissary.test/v1/models";

const MANAGEMENT_URL = "https://commissary.test/v9/management/config";

/** The sessions a Commissary Cloud test signs people in with: by cookie. */
const sessions = (people: Record<string, SignedInPerson>) =>
  SignInSessions.of({ person: (cookie) => Effect.succeed(people[cookie]) });

/** Runs `body` at a fixed time with `directory`, the deployment's settings and `sessions`, in the org `global`. */
const run = <A, E>(
  directory: MemoryDirectory,
  body: Effect.Effect<A, E, AuthConfig | AuthDirectory | CurrentOrg | AccessJwks | SignInSessions>,
  config: AuthBindings = SELF_HOSTED,
  people: Record<string, SignedInPerson> = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);

    return yield* body.pipe(
      Effect.provideContext(
        Context.make(AuthConfig, config).pipe(
          Context.add(CurrentOrg, GLOBAL_ORG),
          Context.add(SignInSessions, sessions(people)),
        ),
      ),
      Effect.provide(Layer.merge(directory.layer, fakeJwksLayer(makeFakeJwks([key])))),
    );
  });

const signedIn = (claims: Record<string, unknown>) =>
  Effect.promise(async () => ({
    "cf-access-jwt-assertion": await signToken({ key, now: NOW_MS / 1000, claims }),
  }));

/** A directory with `global` (slug `default`) and the org `acme`, whose admin is carol and whose member is dan. */
const staffed = () => {
  const directory = memoryDirectory();

  directory.addOrg("default", GLOBAL_ORG);
  const acme = directory.addOrg("acme");

  directory.addMember(acme, "carol@example.com", "admin");
  directory.addMember(acme, "dan@example.com", "member");

  return { directory, acme };
};

const route = (needs: "platform" | "member" | "admin" | "owner", slug?: string) => ({
  needs,
  slug: slug === undefined ? undefined : OrgSlug.make(slug),
});

beforeEach(() => {
  resetApiKeyCaches();
  resetManagementKeyCache();
  resetStandingCaches();
});

describe("authenticateClient", () => {
  it.effect(
    "takes an API key as its member, in the key's org, and asks again only after the cache window",
    () => {
      const { directory, acme } = staffed();
      const text = directory.issueApiKey(acme, "dan@example.com");

      return run(
        directory,
        Effect.gen(function* () {
          const identity = yield* authenticateClient({ "x-api-key": text }, CLIENT_URL);

          assert.strictEqual(identity.org, acme);
          assert.strictEqual(identity.role, "member");
          assert.strictEqual(identity.principal.kind, "key");
          assert.isFalse(identity.platformAdmin);

          yield* authenticateClient({ authorization: `Bearer ${text}` }, CLIENT_URL);
          assert.strictEqual(directory.calls.filter((call) => call === "verifyApiKey").length, 1);
        }),
      );
    },
  );

  it.effect(
    "refuses a revoked or unknown key with Invalid API key, and a request without one",
    () => {
      const { directory, acme } = staffed();
      const text = directory.issueApiKey(acme, "dan@example.com");

      directory.revokeKey(acme, text);

      return run(
        directory,
        Effect.gen(function* () {
          const revoked = yield* Effect.flip(authenticateClient({ "x-api-key": text }, CLIENT_URL));

          assert.strictEqual(revoked._tag, "UnauthorizedError");
          assert.strictEqual(revoked.message, "Invalid API key");

          const none = yield* Effect.flip(authenticateClient({}, CLIENT_URL));

          assert.strictEqual(none.message, "Missing API key");
        }),
      );
    },
  );

  it.effect("takes an Access sign-in only while the org still accepts them from clients", () => {
    const { directory } = staffed();

    directory.addMember(GLOBAL_ORG, "erin@example.com", "member");

    return run(
      directory,
      Effect.gen(function* () {
        const erin = yield* signedIn(userClaims("erin@example.com"));
        const refused = yield* Effect.flip(authenticateClient(erin, CLIENT_URL));

        assert.strictEqual(refused.message, "Missing API key");

        directory.setOrg(GLOBAL_ORG, { accessClients: true });
        const identity = yield* authenticateClient(erin, CLIENT_URL);

        assert.strictEqual(identity.org, GLOBAL_ORG);
        assert.strictEqual(identity.principalId, "user:erin@example.com");
      }),
    );
  });
});

describe("authenticateManagement", () => {
  it.effect("needs the role the route names in the org the URL addresses", () => {
    const { directory, acme } = staffed();

    return run(
      directory,
      Effect.gen(function* () {
        const dan = yield* signedIn(userClaims("dan@example.com"));
        const carol = yield* signedIn(userClaims("Carol@Example.com"));

        const member = yield* authenticateManagement(dan, MANAGEMENT_URL, route("member", "acme"));

        assert.strictEqual(member.org, acme);
        assert.strictEqual(member.role, "member");

        const forbidden = yield* Effect.flip(
          authenticateManagement(dan, MANAGEMENT_URL, route("admin", "acme")),
        );

        assert.strictEqual(forbidden._tag, "ForbiddenError");
        assert.strictEqual(
          (yield* authenticateManagement(carol, MANAGEMENT_URL, route("admin", "acme"))).role,
          "admin",
        );
        // Not a member of `global`, the org of an unscoped URL.
        assert.strictEqual(
          (yield* Effect.flip(authenticateManagement(carol, MANAGEMENT_URL, route("member"))))._tag,
          "ForbiddenError",
        );
        // A platform-level route needs no role.
        assert.isUndefined(
          (yield* authenticateManagement(carol, MANAGEMENT_URL, route("platform"))).role,
        );
      }),
    );
  });

  it.effect(
    "makes the platform admins owners of every org, and tells them an unknown slug is missing",
    () => {
      const { directory, acme } = staffed();

      return run(
        directory,
        Effect.gen(function* () {
          const admin = yield* signedIn(userClaims("admin@example.com"));
          const service = yield* signedIn(serviceClaims("admin.access"));

          const identity = yield* authenticateManagement(
            admin,
            MANAGEMENT_URL,
            route("owner", "acme"),
          );

          assert.strictEqual(identity.org, acme);
          assert.strictEqual(identity.role, "owner");
          assert.isTrue(identity.platformAdmin);
          assert.isTrue(
            (yield* authenticateManagement(service, MANAGEMENT_URL, route("owner"))).platformAdmin,
          );

          const missing = yield* Effect.flip(
            authenticateManagement(admin, MANAGEMENT_URL, route("admin", "nobody")),
          );

          assert.strictEqual(missing._tag, "NotFoundError");

          const dan = yield* signedIn(userClaims("dan@example.com"));

          assert.strictEqual(
            (yield* Effect.flip(
              authenticateManagement(dan, MANAGEMENT_URL, route("admin", "nobody")),
            ))._tag,
            "ForbiddenError",
          );
        }),
      );
    },
  );

  it.effect("takes a management key in its own org only, up to its role", () => {
    const { directory, acme } = staffed();
    const text = directory.issueManagementKey(acme, "deploy", "admin");
    const headers = { authorization: `Bearer ${text}` };

    return run(
      directory,
      Effect.gen(function* () {
        const identity = yield* authenticateManagement(headers, MANAGEMENT_URL, route("admin"));

        assert.strictEqual(identity.org, acme);
        assert.strictEqual(identity.principal.kind, "mkey");
        assert.strictEqual(
          (yield* authenticateManagement(headers, MANAGEMENT_URL, route("admin", "acme"))).org,
          acme,
        );
        assert.strictEqual(
          (yield* Effect.flip(authenticateManagement(headers, MANAGEMENT_URL, route("owner"))))
            ._tag,
          "ForbiddenError",
        );
        assert.strictEqual(
          (yield* Effect.flip(
            authenticateManagement(headers, MANAGEMENT_URL, route("admin", "default")),
          ))._tag,
          "ForbiddenError",
        );
      }),
    );
  });

  it.effect("brings the registry's index up to date when an admission finds it behind", () => {
    const { directory, acme } = staffed();

    return run(
      directory,
      Effect.gen(function* () {
        const dan = yield* signedIn(userClaims("dan@example.com"));

        yield* authenticateManagement(dan, MANAGEMENT_URL, route("member", "acme"));

        assert.deepStrictEqual([...(directory.index.get("dan@example.com") ?? [])], [acme]);
        assert.includeMembers(directory.calls, ["replaceOrgIndex", "markIndexSynced"]);

        const before = directory.calls.length;

        yield* authenticateManagement(dan, MANAGEMENT_URL, route("member", "acme"));
        assert.notInclude(directory.calls.slice(before), "replaceOrgIndex");
      }),
    );
  });

  it.effect(
    "fails closed when the org's membership cannot be asked, but lets a platform admin in",
    () => {
      const { directory } = staffed();

      directory.failing.add("admit");

      return run(
        directory,
        Effect.gen(function* () {
          const dan = yield* signedIn(userClaims("dan@example.com"));

          const failed = yield* Effect.flip(
            authenticateManagement(dan, MANAGEMENT_URL, route("member")),
          );

          assert.strictEqual(failed._tag, "InternalError");
          assert.strictEqual(failed.message, "admit: unreachable");

          const admin = yield* signedIn(userClaims("admin@example.com"));

          assert.isTrue(
            (yield* authenticateManagement(admin, MANAGEMENT_URL, route("admin"))).platformAdmin,
          );
        }),
      );
    },
  );
});

describe("Commissary Cloud", () => {
  const CLOUD: AuthBindings = { ...SELF_HOSTED, COMMISSARY_MODE: "cloud" };

  it.effect("takes API keys only on the client API and refuses a suspended person's", () => {
    const { directory, acme } = staffed();
    const dan = directory.issueApiKey(acme, "dan@example.com");
    const carol = directory.issueApiKey(acme, "carol@example.com");
    directory.suspendPerson("carol@example.com");

    return run(
      directory,
      Effect.gen(function* () {
        const access = yield* signedIn(userClaims("admin@example.com"));

        assert.strictEqual(
          (yield* Effect.flip(authenticateClient(access, CLIENT_URL))).message,
          "Missing API key",
        );

        const suspended = yield* Effect.flip(
          authenticateClient({ "x-api-key": carol }, CLIENT_URL),
        );

        assert.strictEqual(suspended._tag, "ForbiddenError");
        assert.strictEqual(suspended.message, SUSPENDED);
        assert.strictEqual((yield* authenticateClient({ "x-api-key": dan }, CLIENT_URL)).org, acme);
      }),
      CLOUD,
    );
  });

  it.effect("signs a person in by their session, and leaves signing up to the auth Worker", () => {
    const { directory } = staffed();
    const people = { "session=frank": { userId: "u-frank", email: "frank@example.com" } };

    return run(
      directory,
      Effect.gen(function* () {
        const none = yield* Effect.flip(
          authenticateManagement({}, MANAGEMENT_URL, route("platform")),
        );

        assert.strictEqual(none.message, NOT_SIGNED_IN);

        const access = yield* signedIn(userClaims("admin@example.com"));

        assert.strictEqual(
          (yield* Effect.flip(authenticateManagement(access, MANAGEMENT_URL, route("platform"))))
            .message,
          NOT_SIGNED_IN,
        );

        const frank = yield* authenticateManagement(
          { cookie: "session=frank" },
          MANAGEMENT_URL,
          route("platform"),
        );

        assert.strictEqual(frank.principalId, "user:frank@example.com");
        // The auth Worker signed them up when their sign-in started the session (`ensureSignedUp`).
        assert.isFalse(directory.signedUp.has("frank@example.com"));
      }),
      CLOUD,
      people,
    );
  });

  it.effect(
    "signs a person up once, with a Personal org unless invited, and refuses a suspended person",
    () => {
      const { directory } = staffed();

      directory.suspendPerson("erin@example.com");

      return run(
        directory,
        Effect.gen(function* () {
          yield* ensureSignedUp("Frank@example.com");
          assert.isTrue(directory.signedUp.has("frank@example.com"));
          assert.strictEqual(directory.index.get("frank@example.com")?.size, 1);

          // Signed up already: nothing changes.
          yield* ensureSignedUp("frank@example.com");
          assert.strictEqual(directory.index.get("frank@example.com")?.size, 1);

          // Invited (a member of acme): no Personal org.
          yield* ensureSignedUp("dan@example.com");
          assert.isTrue(directory.signedUp.has("dan@example.com"));
          assert.strictEqual(directory.index.get("dan@example.com")?.size, 1);

          const refused = yield* Effect.flip(ensureSignedUp("erin@example.com"));

          assert.strictEqual(refused._tag, "ForbiddenError");
          assert.strictEqual(refused.message, SUSPENDED);
          assert.isFalse(directory.signedUp.has("erin@example.com"));
        }),
        CLOUD,
      );
    },
  );

  it.effect("refuses a suspended person's session", () => {
    const { directory } = staffed();
    const people = { "session=dan": { userId: "u-dan", email: "dan@example.com" } };

    directory.suspendPerson("dan@example.com");

    return run(
      directory,
      Effect.gen(function* () {
        const refused = yield* Effect.flip(
          authenticateManagement(
            { cookie: "session=dan" },
            MANAGEMENT_URL,
            route("member", "acme"),
          ),
        );

        assert.strictEqual(refused._tag, "ForbiddenError");
        assert.strictEqual(refused.message, SUSPENDED);
      }),
      CLOUD,
      people,
    );
  });
});
