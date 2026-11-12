// Cloudflare Access (ADR 0022): verifying the Access JWT against the team's signing keys, the principal and its caller
// scope, and the Access settings (team domain, audiences, platform admins, the dev bypass). Moved from the Worker's
// access.test.ts; the gate through the Worker's Durable Objects stays there.
import { assert, describe, it } from "@effect/vitest";
import { GLOBAL_ORG, OrgId } from "@commissary/core";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import {
  type AccessJwks,
  callerScope,
  devBypass,
  devBypassEmail,
  isAdmin,
  JWKS_REFRESH_COOLDOWN_MS,
  loadAccessConfig,
  makeIdentity,
  principalId,
  verifyAccessJwt,
} from "../src/index.ts";
import {
  AUD,
  fakeJwksLayer,
  type FakeJwks,
  ISSUER,
  JWKS_URL,
  makeFakeJwks,
  makeKey,
  serviceClaims,
  signToken,
  type TestKey,
  userClaims,
} from "./testing.ts";

const NOW_MS = 1_700_000_000_000;

const NOW = NOW_MS / 1000;

const config = { issuer: ISSUER, jwksUrl: JWKS_URL, audiences: [AUD] };

const keyA = await makeKey("kid-a");

const keyB = await makeKey("kid-b");

/** Runs `body` at a fixed virtual time with one JWKS cache shared by every verification inside it. */
const withJwks = <A, E>(
  state: FakeJwks,
  body: Effect.Effect<A, E, AccessJwks>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);

    return yield* body.pipe(Effect.provide(fakeJwksLayer(state)));
  });

const token = (key: TestKey, overrides: Partial<Parameters<typeof signToken>[0]> = {}) =>
  Effect.promise(() =>
    signToken({ key, now: NOW, claims: userClaims("alice@example.com"), ...overrides }),
  );

describe("verifyAccessJwt", () => {
  it.effect("accepts a valid user token", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const principal = yield* verifyAccessJwt(yield* token(keyA), config);
        assert.deepStrictEqual(principal, {
          kind: "user",
          email: "alice@example.com",
          sub: "sub-alice@example.com",
        });
      }),
    ),
  );

  it.effect("accepts a valid service token", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const jwt = yield* token(keyA, { claims: serviceClaims("abc123.access") });
        const principal = yield* verifyAccessJwt(jwt, config);
        assert.deepStrictEqual(principal, { kind: "service", commonName: "abc123.access" });
      }),
    ),
  );

  it.effect("accepts any configured audience and tokens with several aud values", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const jwt = yield* token(keyA, { audience: ["other", "aud-tag-2"] });
        const principal = yield* verifyAccessJwt(jwt, { ...config, audiences: [AUD, "aud-tag-2"] });
        assert.strictEqual(principal.kind, "user");
      }),
    ),
  );

  it.effect("rejects a wrong audience", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          verifyAccessJwt(yield* token(keyA, { audience: "nope" }), config),
        );

        assert.strictEqual(error._tag, "UnauthorizedError");
        assert.strictEqual(error.message, "Invalid API key");
      }),
    ),
  );

  it.effect("rejects a wrong issuer", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const jwt = yield* token(keyA, { issuer: "https://evil.cloudflareaccess.com" });
        const error = yield* Effect.flip(verifyAccessJwt(jwt, config));
        assert.strictEqual(error._tag, "UnauthorizedError");
      }),
    ),
  );

  it.effect("rejects an expired token but tolerates small clock skew", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        // exp = now - 10s: inside the 30s skew.
        const skewed = yield* token(keyA, { now: NOW - 3610 });
        assert.strictEqual((yield* verifyAccessJwt(skewed, config)).kind, "user");
        // exp = now - 120s: expired.
        const expired = yield* token(keyA, { now: NOW - 3720 });
        assert.strictEqual(
          (yield* Effect.flip(verifyAccessJwt(expired, config)))._tag,
          "UnauthorizedError",
        );
      }),
    ),
  );

  it.effect("rejects a token that is not valid yet (nbf)", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const future = yield* token(keyA, { notBefore: NOW + 300 });
        assert.strictEqual(
          (yield* Effect.flip(verifyAccessJwt(future, config)))._tag,
          "UnauthorizedError",
        );
        const nearFuture = yield* token(keyA, { notBefore: NOW + 10 });
        assert.strictEqual((yield* verifyAccessJwt(nearFuture, config)).kind, "user");
      }),
    ),
  );

  it.effect("rejects a token signed by a different key with a known kid", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const forged = yield* token(keyB, { kid: "kid-a" });
        assert.strictEqual(
          (yield* Effect.flip(verifyAccessJwt(forged, config)))._tag,
          "UnauthorizedError",
        );
      }),
    ),
  );

  it.effect("rejects malformed tokens and tokens without claims identifying a principal", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        for (const bad of ["", "not-a-jwt", "a.b.c", "eyJhbGciOiJub25lIn0.e30."]) {
          assert.strictEqual(
            (yield* Effect.flip(verifyAccessJwt(bad, config)))._tag,
            "UnauthorizedError",
          );
        }

        const anonymous = yield* token(keyA, { claims: {} });
        assert.strictEqual(
          (yield* Effect.flip(verifyAccessJwt(anonymous, config)))._tag,
          "UnauthorizedError",
        );
      }),
    ),
  );

  it.effect("refetches the JWKS for an unknown kid, at most once per cooldown", () => {
    const state = makeFakeJwks([keyA]);

    return withJwks(
      state,
      Effect.gen(function* () {
        yield* verifyAccessJwt(yield* token(keyA), config);
        assert.strictEqual(state.fetches, 1);

        // Key rotation: B is published after the first fetch. Inside the cooldown the unknown kid is rejected
        // without hitting the endpoint.
        state.keys = [keyA.jwk, keyB.jwk];
        const early = yield* Effect.flip(verifyAccessJwt(yield* token(keyB), config));
        assert.strictEqual(early._tag, "UnauthorizedError");
        assert.strictEqual(state.fetches, 1);

        yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS + 1);
        const principal = yield* verifyAccessJwt(yield* token(keyB, { now: NOW + 31 }), config);
        assert.strictEqual(principal.kind, "user");
        assert.strictEqual(state.fetches, 2);

        // Known kids are served from the cache.
        yield* verifyAccessJwt(yield* token(keyA, { now: NOW + 31 }), config);
        assert.strictEqual(state.fetches, 2);
      }),
    );
  });

  it.effect("fails with InternalError when the JWKS cannot be fetched, and recovers", () => {
    const state = makeFakeJwks([keyA]);
    state.fail = true;

    return withJwks(
      state,
      Effect.gen(function* () {
        const error = yield* Effect.flip(verifyAccessJwt(yield* token(keyA), config));
        assert.strictEqual(error._tag, "InternalError");
        state.fail = false;
        assert.strictEqual((yield* verifyAccessJwt(yield* token(keyA), config)).kind, "user");
      }),
    );
  });

  it.effect("keeps serving cached keys when a refresh fails", () => {
    const state = makeFakeJwks([keyA]);

    return withJwks(
      state,
      Effect.gen(function* () {
        yield* verifyAccessJwt(yield* token(keyA), config);
        state.fail = true;
        yield* TestClock.adjust(11 * 60_000);
        const jwt = yield* token(keyA, { now: NOW + 660 });
        assert.strictEqual((yield* verifyAccessJwt(jwt, config)).kind, "user");
        assert.strictEqual(state.fetches, 2);
      }),
    );
  });
});

describe("principal", () => {
  it.effect("callerScope mirrors the Go derivation", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* callerScope("user:alice@example.com", GLOBAL_ORG),
        "21cd36b03d03c619f37e1df80f5e22b7c4c9319b4e8151ea93327b51520a06e9",
      );
      assert.strictEqual(
        yield* callerScope("service:abc.access", GLOBAL_ORG),
        "84a7bf2e7053ab5a89f0f60fc4e2fc30abb4cf0284421d8bb85ff4d38254733a",
      );
      assert.strictEqual(yield* callerScope("  ", GLOBAL_ORG), "");

      const identity = yield* makeIdentity(
        { kind: "service", commonName: "abc.access" },
        GLOBAL_ORG,
      );

      assert.strictEqual(
        identity.callerScope,
        "84a7bf2e7053ab5a89f0f60fc4e2fc30abb4cf0284421d8bb85ff4d38254733a",
      );
    }),
  );

  it.effect("callerScope keeps one principal's scopes in two orgs apart", () =>
    Effect.gen(function* () {
      const acme = yield* callerScope("user:alice@example.com", OrgId.make("acme"));
      const other = yield* callerScope("user:alice@example.com", OrgId.make("other"));
      assert.match(acme, /^[0-9a-f]{64}$/);
      assert.notStrictEqual(acme, other);
      assert.notStrictEqual(acme, yield* callerScope("user:alice@example.com", GLOBAL_ORG));
      assert.strictEqual(yield* callerScope("  ", OrgId.make("acme")), "");
    }),
  );

  it("principalId lowercases emails", () => {
    expect(principalId({ kind: "user", email: "Alice@Example.COM", sub: "s" })).toBe(
      "user:alice@example.com",
    );
  });
});

describe("config", () => {
  const base = {
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    PLATFORM_ADMIN_EMAILS: "",
    PLATFORM_ADMIN_SERVICE_TOKENS: "",
  };

  it.effect("normalises the team domain and splits the lists", () =>
    Effect.gen(function* () {
      const loaded = yield* loadAccessConfig({
        ACCESS_TEAM_DOMAIN: "https://Team.cloudflareaccess.com/",
        ACCESS_AUD: "a1, a2\nb3",
        PLATFORM_ADMIN_EMAILS: "One@x.com,two@x.com",
        PLATFORM_ADMIN_SERVICE_TOKENS: "t1.access",
      });

      assert.strictEqual(loaded.issuer, "https://team.cloudflareaccess.com");
      assert.strictEqual(loaded.jwksUrl, "https://team.cloudflareaccess.com/cdn-cgi/access/certs");
      assert.deepStrictEqual(loaded.audiences, ["a1", "a2", "b3"]);
      assert.isTrue(isAdmin(loaded, { kind: "user", email: "ONE@x.com", sub: "" }));
      assert.isFalse(isAdmin(loaded, { kind: "user", email: "three@x.com", sub: "" }));
      assert.isTrue(isAdmin(loaded, { kind: "service", commonName: "t1.access" }));

      const short = yield* loadAccessConfig({
        ...base,
        ACCESS_TEAM_DOMAIN: "team",
        ACCESS_AUD: "a",
      });

      assert.strictEqual(short.issuer, "https://team.cloudflareaccess.com");
    }),
  );

  it.effect("rejects missing or invalid settings", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* Effect.flip(loadAccessConfig(base)))._tag, "ConfigurationError");
      const noAud = loadAccessConfig({ ...base, ACCESS_TEAM_DOMAIN: "team" });
      assert.strictEqual((yield* Effect.flip(noAud))._tag, "ConfigurationError");

      const badHost = loadAccessConfig({
        ...base,
        ACCESS_TEAM_DOMAIN: "evil.com/path?x",
        ACCESS_AUD: "a",
      });

      assert.strictEqual((yield* Effect.flip(badHost))._tag, "ConfigurationError");
    }),
  );

  it("dev bypass is honoured for loopback hosts only", () => {
    expect(
      devBypassEmail({ ACCESS_DEV_BYPASS: "" }, "http://localhost:8787/v1/models"),
    ).toBeUndefined();
    expect(devBypassEmail({ ACCESS_DEV_BYPASS: "true" }, "http://localhost:8787/v1/models")).toBe(
      "dev@localhost",
    );
    expect(devBypassEmail({ ACCESS_DEV_BYPASS: "me@x.com" }, "http://127.0.0.1:8787/")).toBe(
      "me@x.com",
    );
    expect(
      devBypassEmail({ ACCESS_DEV_BYPASS: "true" }, "https://proxy.example.com/v1/models"),
    ).toBeUndefined();
    expect(
      devBypassEmail({ ACCESS_DEV_BYPASS: "true" }, "https://localhost.evil.com/v1/models"),
    ).toBeUndefined();
    // Never once Access is configured.
    const configured = { ACCESS_DEV_BYPASS: "true", ACCESS_TEAM_DOMAIN: "team", ACCESS_AUD: "" };
    expect(devBypassEmail(configured, "http://localhost:8787/v1/models")).toBeUndefined();
    expect(devBypass(configured, "http://localhost:8787/v1/models")?._tag).toBe("Refused");
    expect(
      devBypass({ ACCESS_DEV_BYPASS: "1", ACCESS_AUD: "aud" }, "http://127.0.0.1/")?._tag,
    ).toBe("Refused");
    const active = devBypass({ ACCESS_DEV_BYPASS: "1", ACCESS_AUD: " " }, "http://127.0.0.1/");
    expect(active?._tag).toBe("Active");
    expect(active).toMatchObject({ email: "dev@localhost" });
  });
});
