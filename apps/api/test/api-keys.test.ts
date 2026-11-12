// API keys on the client API (ADR 0022, issue #67), the API Worker's gate: each header form a client sends keys in, the
// refusals (all `Invalid API key`), that a key only ever reaches its own org's ControlPlane and serves its member's
// private credentials, revocation within the cache window, and the Access sign-ins a client API route still takes while
// the org's `access_clients` setting is on. Through the gate with the real ControlPlanes and a Platform registry of its
// own; the cache window through `authenticateClient` with `TestClock`. Keys, members and orgs are set up straight
// through the state Worker's objects: the management routes that issue and revoke keys are the app Worker's
// (apps/app/test/api-keys.test.ts). The key text is tested in packages/auth (keys.test.ts).
import { env } from "cloudflare:workers";
import { assert, it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  type AccessJwks,
  AccessPrincipal,
  authenticateClient,
  mintApiKey,
  parseApiKey,
  VERIFIED_KEY_TTL_MS,
} from "@commissary/auth";
import { type CurrentOrg, GLOBAL_ORG, type OrgId } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import {
  fakeJwksLayer,
  makeFakeJwks,
  makeKey,
  signToken,
  userClaims,
} from "@commissary/auth/testing";
import { claudeFile, resetUsageDb } from "@commissary/models/testing";
import {
  ADMIN,
  isolatedPlatform,
  issueKey,
  key as accessSigningKey,
  makeClientHarness,
  serviceToken,
  staffedOrg as staffedOrgIn,
  token,
} from "./support/client.ts";
import { type EnvServices, requestContext } from "../src/worker-env.ts";

/** What the stand-in client API route saw of its caller. */
interface Seen {
  readonly principal_id: string;
  readonly org: string;
  readonly member_id?: string;
  readonly role?: string;
  readonly caller_scope: string;
}

const whoami = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  return HttpServerResponse.text(
    JSON.stringify({
      principal_id: identity.principalId,
      org: identity.org,
      member_id: identity.memberId,
      role: identity.role,
      caller_scope: identity.callerScope,
    }),
    { contentType: "application/json" },
  );
});

/**
 * Picks a Claude credential for the caller the way Commissary handlers do (`handlers/execute.ts`: the identity's org and
 * member), and answers which one, or the refusal.
 */
const pickForCaller = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  const picked = yield* Effect.promise(async () => {
    const answer = await controlPlaneOf(env, identity.org)
      .models()
      .pick({
        providers: ["claude"],
        model: "claude-sonnet-4-5",
        ...(identity.memberId === undefined ? {} : { memberId: identity.memberId }),
      });

    return answer.ok ? { credential: answer.credential.id } : { refused: true };
  });

  return HttpServerResponse.text(JSON.stringify(picked), { contentType: "application/json" });
});

const ClientApiRoutes = Layer.mergeAll(
  HttpRouter.add("POST", "/v1/chat/completions", pickForCaller),
  HttpRouter.add("GET", "/v1/models", whoami),
  HttpRouter.add("POST", "/v1/messages", whoami),
  HttpRouter.add("GET", "/v1beta/models", whoami),
  HttpRouter.add("POST", "/openai/v1/chat/completions", whoami),
  HttpRouter.add("POST", "/backend-api/codex/responses", whoami),
  HttpRouter.add("POST", "/responses", whoami),
);

const registry = isolatedPlatform();

const accessKey = await makeKey("api-keys-kid");

const harness = makeClientHarness(ClientApiRoutes, registry.bindings);

afterAll(harness.dispose);

const staffedOrg = (prefix: string, privateCredentials = false) =>
  staffedOrgIn(registry, prefix, privateCredentials);

/** A client API route called with `headers` only: no Access sign-in. */
const clientApi = async (path: string, headers: Record<string, string>, method = "GET") =>
  await harness.json(path, { method, headers, auth: false });

/** The keys of `memberId` in `org` (all of them without one), as the org's ControlPlane lists them. */
const keysOf = async (org: OrgId, memberId?: string) =>
  await controlPlaneOf(env, org).listApiKeys(memberId, Date.now());

describe("the gate on the client API", () => {
  it("takes a key in each header form a client sends, as its member in its org", async () => {
    const { org, alice } = await staffedOrg("gate-forms");
    const created = await issueKey(org, alice);
    const { key } = created;

    const forms: ReadonlyArray<readonly [string, string, Record<string, string>]> = [
      ["GET", "/v1/models", { authorization: `Bearer ${key}` }],
      ["POST", "/v1/messages", { "x-api-key": key }],
      ["GET", "/v1beta/models", { "x-goog-api-key": key }],
      ["GET", `/v1beta/models?key=${encodeURIComponent(key)}`, {}],
      ["POST", "/openai/v1/chat/completions", { authorization: `bearer ${key}` }],
      ["POST", "/backend-api/codex/responses", { authorization: `Bearer ${key}` }],
      ["POST", "/responses", { "x-api-key": key }],
      // An old shared key in one header does not hide an API key in another.
      ["GET", "/v1/models", { authorization: "Bearer sk-dummy", "x-api-key": key }],
    ];

    for (const [method, path, headers] of forms) {
      const reply = await clientApi(path, headers, method);

      expect(reply.status, `${method} ${path}`).toBe(200);
      expect(reply.body).toMatchObject({
        principal_id: `key:${created.id}`,
        org,
        member_id: alice.id,
        role: "member",
      });
    }

    expect((await keysOf(org, alice.id))[0]?.lastUsedAt).toBeDefined();
  });

  it("gives one member's keys one caller scope, apart from another member's", async () => {
    const { org, alice, bob } = await staffedOrg("gate-scope");

    const scopeOf = async (key: { readonly key: string }) =>
      ((await clientApi("/v1/models", { authorization: `Bearer ${key.key}` })).body as Seen)
        .caller_scope;

    const laptop = await scopeOf(await issueKey(org, alice, "laptop"));
    const desktop = await scopeOf(await issueKey(org, alice, "desktop"));
    const bobs = await scopeOf(await issueKey(org, bob));

    expect(laptop).toMatch(/^[0-9a-f]{64}$/);
    expect(desktop).toBe(laptop);
    expect(bobs).not.toBe(laptop);
  });

  it("makes the key's member the owner a private credential is picked for (ADR 0023)", async () => {
    const { org, alice, bob } = await staffedOrg("gate-private", true);

    // Alice connects a credential of her own, as `POST /credentials` does for her (private: the org allows it).
    const uploaded = await controlPlaneOf(env, org)
      .models()
      .importAuthFile(
        "alice.json",
        claudeFile(),
        { private: true },
        { member: alice.id, admin: false },
      );

    expect(uploaded.ok).toBe(true);

    const pickedWith = async (key: { readonly key: string }) =>
      (await clientApi("/v1/chat/completions", { authorization: `Bearer ${key.key}` }, "POST"))
        .body;

    expect(await pickedWith(await issueKey(org, alice))).toEqual({ credential: "alice.json" });
    expect(await pickedWith(await issueKey(org, bob))).toEqual({ refused: true });
  });

  it("answers wrong, unknown, revoked and expired keys with Invalid API key", async () => {
    const { org, alice } = await staffedOrg("gate-refusals");
    const other = await staffedOrg("gate-refusals-other");
    const { key } = await issueKey(org, alice);
    const parsed = parseApiKey(key);

    if (parsed === undefined) throw new Error("the issued key does not parse");
    const secret = key.slice(`cms_${org}_${parsed.keyId}_`.length);
    const flipped = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;

    const revoked = await issueKey(org, alice, "revoked");
    expect((await controlPlaneOf(env, org).revokeApiKey(revoked.id, Date.now(), alice.id)).ok).toBe(
      true,
    );

    // An expired key: issued directly, already past its expiry.
    const now = Date.now();

    const expired = await controlPlaneOf(env, org).createApiKey(
      { memberId: alice.id, name: "expired", expiresAt: now - 1000 },
      now - 2000,
    );

    if (!expired.ok) throw new Error(expired.message);

    const refused = {
      "wrong org prefix": `cms_${other.org}_${parsed.keyId}_${secret}`,
      "org that does not exist": `cms_no-such-org_${parsed.keyId}_${secret}`,
      "unknown key": mintApiKey(org).key,
      "wrong secret": `cms_${org}_${parsed.keyId}_${flipped}`,
      revoked: revoked.key,
      expired: expired.value.key,
      malformed: "cms_definitely-not-a-key",
    };

    for (const [why, presented] of Object.entries(refused)) {
      const reply = await clientApi("/v1/models", { authorization: `Bearer ${presented}` });

      expect([reply.status, reply.body], why).toEqual([401, { error: "Invalid API key" }]);
    }

    // A refused key is not saved by an Access sign-in sent with it.
    const withJwt = await harness.json("/v1/models", {
      headers: { authorization: `Bearer ${revoked.key}` },
      auth: await token(alice.email),
    });

    expect(withJwt.status).toBe(401);

    expect(await clientApi("/v1/models", {})).toMatchObject({
      status: 401,
      body: { error: "Missing API key" },
    });
  });

  it("refuses a key under the old cfp_ prefix", async () => {
    const { org, alice } = await staffedOrg("gate-old-prefix");
    const { key } = await issueKey(org, alice);
    const old = key.replace(/^cms_/, "cfp_");

    expect((await clientApi("/v1/models", { "x-api-key": key })).status).toBe(200);
    expect(parseApiKey(old)).toBeUndefined();

    for (const headers of [{ authorization: `Bearer ${old}` }, { "x-api-key": old }])
      expect((await clientApi("/v1/models", headers)).status).toBe(401);
  });

  it("refuses a management key: it is not accepted on the client API (ADR 0026)", async () => {
    const { org, admin } = await staffedOrg("gate-management-key");

    const issued = await controlPlaneOf(env, org).createManagementKey(
      { name: "ci", role: "admin", createdBy: admin.id },
      Date.now(),
    );

    if (!issued.ok) throw new Error(issued.message);

    expect(
      (await clientApi("/v1/models", { authorization: `Bearer ${issued.value.key}` })).status,
    ).toBe(401);
  });

  it("never takes a key of one org to another org's ControlPlane", async () => {
    const a = await staffedOrg("gate-org-a");
    const b = await staffedOrg("gate-org-b");
    const keyA = (await issueKey(a.org, a.alice)).key;
    const keyB = (await issueKey(b.org, b.alice)).key;
    const parsedA = parseApiKey(keyA);

    if (parsedA === undefined) throw new Error("the issued key does not parse");

    expect(((await clientApi("/v1/models", { "x-api-key": keyA })).body as Seen).org).toBe(a.org);
    expect(((await clientApi("/v1/models", { "x-api-key": keyB })).body as Seen).org).toBe(b.org);

    // Org B's ControlPlane does not know org A's key, even asked directly.
    expect(
      await controlPlaneOf(env, b.org).verifyApiKey(parsedA.keyId, parsedA.hash, Date.now()),
    ).toEqual({ ok: false, reason: "unknown" });

    // Asked through the gate with B's org in front of A's key: refused, and B records no use of any key.
    const relabelled = keyA.replace(`cms_${a.org}_`, `cms_${b.org}_`);
    expect((await clientApi("/v1/models", { "x-api-key": relabelled })).status).toBe(401);

    expect((await keysOf(b.org)).map((listed) => listed.id)).not.toContain(parsedA.keyId);
  });
});

describe("Access sign-ins on the client API", () => {
  /** Turns global's `access_clients` setting on or off, as its owner does with `PATCH /membership`. */
  const setAccessClients = async (on: boolean) =>
    await controlPlaneOf(env, GLOBAL_ORG).setMembershipSettings({ accessClients: on });

  it("take the cloudflared header while global accepts them, and 401 once it does not", async () => {
    const jwt = await token("client@example.com");

    // `cloudflared access` sends the token in `cf-access-token`; clients often send a dummy key next to it.
    for (const headers of [
      { "cf-access-token": jwt },
      { "cf-access-token": jwt, authorization: "Bearer sk-dummy" },
      { "cf-access-token": jwt, "x-api-key": "sk-dummy" },
    ]) {
      const reply = await clientApi("/v1/models", headers);

      expect(reply.status).toBe(200);
      expect((reply.body as Seen).principal_id).toBe("user:client@example.com");
    }

    expect(await setAccessClients(false)).toMatchObject({ accessClients: false });

    try {
      expect(await clientApi("/v1/models", { "cf-access-token": jwt })).toMatchObject({
        status: 401,
        body: { error: "Missing API key" },
      });

      const viaEdge = await harness.json("/v1/models", { auth: jwt });
      expect([viaEdge.status, viaEdge.body]).toEqual([401, { error: "Missing API key" }]);

      const withDummy = await clientApi("/v1/models", {
        "cf-access-token": jwt,
        authorization: "Bearer sk-dummy",
      });

      expect([withDummy.status, withDummy.body]).toEqual([401, { error: "Invalid API key" }]);

      // Not even a platform admin's or a service token's sign-in is a client credential then.
      expect((await harness.json("/v1/models", { auth: await token(ADMIN) })).status).toBe(401);
      expect(
        (await harness.json("/v1/models", { auth: await serviceToken("bot.access") })).status,
      ).toBe(401);
    } finally {
      await setAccessClients(true);
    }
  });

  it("are checked as strictly as the Access edge checks them: signature, audience, issuer and expiry", async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = userClaims("client@example.com");
    const impostor = await makeKey(accessSigningKey.kid);

    const refused = {
      "bad signature": await signToken({ key: impostor, now, claims }),
      "unknown key id": await signToken({ key: impostor, kid: "nobody", now, claims }),
      "another application's audience": await signToken({
        key: accessSigningKey,
        audience: "another-app",
        now,
        claims,
      }),
      "another team": await signToken({
        key: accessSigningKey,
        issuer: "https://other.cloudflareaccess.com",
        now,
        claims,
      }),
      expired: await signToken({ key: accessSigningKey, now: now - 7200, expiresIn: 3600, claims }),
      "not yet valid": await signToken({
        key: accessSigningKey,
        now,
        notBefore: now + 600,
        claims,
      }),
    };

    for (const [why, jwt] of Object.entries(refused))
      for (const headers of [
        { "cf-access-token": jwt, authorization: "Bearer sk-dummy" },
        { "cf-access-jwt-assertion": jwt },
      ]) {
        const reply = await clientApi("/v1/models", headers);

        expect([reply.status, reply.body], why).toEqual([401, { error: "Invalid API key" }]);
      }

    // The same claims, signed properly for this application, pass.
    const valid = await signToken({ key: accessSigningKey, now, claims });

    expect(
      (
        await clientApi("/v1/models", {
          "cf-access-token": valid,
          authorization: "Bearer sk-dummy",
        })
      ).status,
    ).toBe(200);
  });
});

describe("the verified-key cache", () => {
  const NOW_MS = 1_800_000_000_000;

  const context = requestContext(
    { ...env, ...registry.bindings, ACCESS_TEAM_DOMAIN: "team", ACCESS_AUD: "unused" },
    // SAFETY: authenticating a key never calls the execution context's methods.
    {} as unknown as ExecutionContext,
  );

  const run = <A, E>(body: Effect.Effect<A, E, EnvServices | AccessJwks | CurrentOrg>) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);

      return yield* body.pipe(
        Effect.provide(fakeJwksLayer(makeFakeJwks([accessKey]))),
        Effect.provideContext(context),
      );
    });

  effectIt.effect("lets a key revoked in another isolate through for at most its window", () =>
    run(
      Effect.gen(function* () {
        const slug = `cache-${crypto.randomUUID().slice(0, 8)}`;

        const org = yield* Effect.promise(async () => {
          const created = await registry.platform.createOrg({ slug, name: slug }, NOW_MS);

          if (!created.ok) throw new Error(created.message);

          return created.org.id;
        });

        const stub = controlPlaneOf(env, org);

        const key = yield* Effect.promise(async () => {
          const member = await stub.addMember(
            { email: "carol@example.com", role: "member" },
            { role: "owner", sensitive: true },
            "test",
          );

          if (!member.ok) throw new Error(member.message);

          const issued = await stub.createApiKey(
            { memberId: member.value.id, name: "cli" },
            NOW_MS,
          );

          if (!issued.ok) throw new Error(issued.message);

          return issued.value;
        });

        const headers = { authorization: `Bearer ${key.key}` };
        const url = "https://commissary.test/v1/models";
        const identity = yield* authenticateClient(headers, url);

        assert.strictEqual(identity.principalId, `key:${key.record.id}`);
        assert.strictEqual(identity.org, org);

        // Revoked behind this isolate's back (another isolate's request).
        yield* Effect.promise(async () => await stub.revokeApiKey(key.record.id, NOW_MS));

        yield* TestClock.adjust(VERIFIED_KEY_TTL_MS - 1);
        assert.strictEqual((yield* authenticateClient(headers, url)).org, org);

        yield* TestClock.adjust(1);
        const refused = yield* Effect.flip(authenticateClient(headers, url));

        assert.strictEqual(refused._tag, "UnauthorizedError");
        assert.strictEqual(refused.message, "Invalid API key");
        assert.isAtMost(VERIFIED_KEY_TTL_MS, 60_000);
      }),
    ),
  );

  /**
   * Verifies `key` (so this isolate caches it), runs `revoke` (what a management request of the app Worker does, which
   * never reaches this isolate's cache), then shows the key still serves for the rest of its window and is refused the
   * moment the window has passed.
   */
  const refusedOnceTheWindowPassed = (key: string, revoke: () => Promise<void>) =>
    Effect.gen(function* () {
      const headers = { authorization: `Bearer ${key}` };
      const url = "https://commissary.test/v1/models";

      yield* authenticateClient(headers, url);
      yield* Effect.promise(revoke);

      yield* TestClock.adjust(VERIFIED_KEY_TTL_MS - 1);
      yield* authenticateClient(headers, url);

      yield* TestClock.adjust(1);
      const refused = yield* Effect.flip(authenticateClient(headers, url));

      assert.strictEqual(refused._tag, "UnauthorizedError");
      assert.strictEqual(refused.message, "Invalid API key");
    });

  /** Who removes members and deletes orgs here: an owner with the sensitive powers, as a platform admin is. */
  const OWNER = { role: "owner", sensitive: true } as const;

  effectIt.effect("refuses a key revoked by its member once its window has passed", () =>
    run(
      Effect.gen(function* () {
        const { org, alice } = yield* Effect.promise(async () => await staffedOrg("window-revoke"));

        const created = yield* Effect.promise(async () => await issueKey(org, alice));

        yield* refusedOnceTheWindowPassed(created.key, async () => {
          const revoked = await controlPlaneOf(env, org).revokeApiKey(
            created.id,
            Date.now(),
            alice.id,
          );

          expect(revoked.ok).toBe(true);
        });
      }),
    ),
  );

  effectIt.effect("refuses the keys of a removed member once the window has passed", () =>
    run(
      Effect.gen(function* () {
        const { org, bob } = yield* Effect.promise(async () => await staffedOrg("window-removed"));
        const created = yield* Effect.promise(async () => await issueKey(org, bob));

        yield* refusedOnceTheWindowPassed(created.key, async () => {
          expect((await controlPlaneOf(env, org).removeMember(bob.id, OWNER)).ok).toBe(true);
        });
      }),
    ),
  );

  effectIt.effect("refuses the keys of a deleted org once the window has passed", () =>
    run(
      Effect.gen(function* () {
        // As the app Worker's org deletion (apps/app/src/platform/org-deletion.ts) needs the usage table it wipes.
        yield* Effect.promise(async () => await resetUsageDb());

        const { org, alice } = yield* Effect.promise(
          async () => await staffedOrg("window-deleted"),
        );

        const created = yield* Effect.promise(async () => await issueKey(org, alice));

        // What deleting an org does to its keys: its ControlPlane wiped, then its registry entry removed.
        yield* refusedOnceTheWindowPassed(created.key, async () => {
          await controlPlaneOf(env, org).wipeOrg();
          expect((await registry.platform.deleteOrg(org)).ok).toBe(true);
        });
      }),
    ),
  );
});
