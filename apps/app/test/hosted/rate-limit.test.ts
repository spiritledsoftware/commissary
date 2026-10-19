// The per-plan request-rate ceiling of Commissary Cloud (packages/billing/src/rate-limit.ts) is the client API's, which the
// API Worker serves (apps/api/test/hosted/rate-limit.test.ts): the management API on the app Worker is not limited.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearPeople, installFakes, panelHeaders, restoreFetch, signIn } from "./support.ts";

beforeAll(async () => {
  await installFakes();
  await clearPeople();
});

afterAll(restoreFetch);

/** The Free ceiling of the API Worker's test binding (apps/api/vitest.config.ts). */
const LIMIT = 5;

describe("the per-org rate ceiling", () => {
  it("does not limit the management API", async () => {
    const cookie = await signIn({ email: "admin-heavy@example.com" });

    for (let sent = 0; sent < LIMIT + 2; sent += 1)
      expect((await call("/v9/management/me", { headers: panelHeaders(cookie) })).status).toBe(200);
  });
});
