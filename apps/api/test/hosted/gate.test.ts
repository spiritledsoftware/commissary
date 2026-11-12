// The gate of Commissary Cloud (ADR 0026, packages/auth/src/hosted-gate.ts) on the API Worker: API keys only on the
// client API, no session cookie and no Access credential, and no key of a suspended person or org. Suspension is set
// straight on the Platform registry, as the app Worker's people and org routes set it (apps/app/test/hosted/gate.test.ts);
// those routes forget the standing their own isolate cached, so the API Worker's isolates learn it within
// `STANDING_TTL_MS` (packages/auth/src/standing.ts), which the tests skip by emptying the cache.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { resetStandingCaches } from "@commissary/auth";
import { platformOf } from "@commissary/state";
import { resetUsageDb } from "@commissary/models/testing";
import { call, keyedOrg, models } from "./support.ts";

beforeEach(async () => {
  await resetUsageDb();
  resetStandingCaches();
});

/** The owned-org limit of a person the tests suspend (the app Worker's `OWNED_ORG_LIMIT` default). */
const ORG_LIMIT = 3;

describe("authentication", () => {
  it("takes only API keys on the client API", async () => {
    expect((await call("/v1/models")).status).toBe(401);

    const { key } = await keyedOrg("ada@example.com");

    for (const headers of [
      { cookie: "__Secure-better-auth.session_token=session.signature" },
      { "cf-access-jwt-assertion": "eyJhbGciOiJSUzI1NiJ9.e30.c2ln" },
      { "cf-access-client-id": "admin-token.access", "cf-access-client-secret": "secret" },
    ])
      expect((await call("/v1/models", { headers })).status).toBe(401);

    expect((await models(key)).status).toBe(200);
  });
});

describe("suspension", () => {
  it("refuses the API keys of a suspended person until it is lifted", async () => {
    const { key } = await keyedOrg("mallory@example.com");

    expect((await models(key)).status).toBe(200);

    const suspend = async (suspended: boolean) => {
      await platformOf(env).updatePerson(
        "mallory@example.com",
        { suspended },
        Date.now(),
        ORG_LIMIT,
      );
      resetStandingCaches();
    };

    await suspend(true);

    const refused = await models(key);

    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Suspended" });

    await suspend(false);
    expect((await models(key)).status).toBe(200);
  });

  it("refuses every API key of a suspended org until a platform admin unsuspends it", async () => {
    const { slug, key } = await keyedOrg("owner@example.com");

    const suspend = async (suspended: boolean) => {
      expect((await platformOf(env).setOrgSuspended(slug, suspended, Date.now())).ok).toBe(true);
      resetStandingCaches();
    };

    await suspend(true);
    expect((await models(key)).status).toBe(403);

    await suspend(false);
    expect((await models(key)).status).toBe(200);
  });
});
