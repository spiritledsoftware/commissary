// The per-plan request-rate ceiling of Commissary Cloud's client API (`@commissary/billing`'s `limitClientRate`, called
// by the gate) on the API Worker: the test Worker's bindings allow 5 requests per minute and org on Free and 8 on Pay as
// you go (vitest.config.ts). That the management API on the app Worker is not limited is tested there
// (apps/app/test/hosted/rate-limit.test.ts).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { RATE_LIMITED } from "@commissary/billing/api";
import { setPlan } from "@commissary/billing/testing";
import { resetUsageDb } from "@commissary/models/testing";
import { keyedOrg, models } from "./support.ts";

beforeAll(async () => {
  await resetUsageDb();
});

const FREE_LIMIT = 5;

const PAYG_LIMIT = 8;

/** The time a burst of requests is given to stay in one rate-limit window, with room to spare on a slow runner. */
const BURST_MS = 10_000;

/**
 * Waits, if need be, until the current rate-limit window has {@link BURST_MS} left. Miniflare's rate limiter counts in
 * windows aligned to the wall-clock minute, so a burst that crossed a minute boundary would start counting again
 * halfway and never reach its ceiling.
 */
const roomInWindow = async () => {
  const left = 60_000 - (Date.now() % 60_000);

  if (left < BURST_MS) await new Promise((resolve) => setTimeout(resolve, left + 100));
};

describe("the per-org rate ceiling", () => {
  it("answers 429 with Retry-After over a Free org's ceiling and leaves other orgs alone", async () => {
    const busy = (await keyedOrg("busy@example.com")).key;
    const quiet = (await keyedOrg("quiet@example.com")).key;

    await roomInWindow();

    for (let sent = 0; sent < FREE_LIMIT; sent += 1) expect((await models(busy)).status).toBe(200);

    const limited = await models(busy);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: RATE_LIMITED });

    expect((await models(quiet)).status).toBe(200);
  });

  it("is higher on Pay as you go", async () => {
    const { org, key } = await keyedOrg("paying@example.com");

    await setPlan(env, org, "payg");
    await roomInWindow();

    for (let sent = 0; sent < PAYG_LIMIT; sent += 1) expect((await models(key)).status).toBe(200);

    const limited = await models(key);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("follows the plan an org is on, from its next request", async () => {
    const { org, key } = await keyedOrg("switching@example.com");

    await roomInWindow();

    for (let sent = 0; sent < FREE_LIMIT; sent += 1) expect((await models(key)).status).toBe(200);
    expect((await models(key)).status).toBe(429);

    // The other binding counts the org on its own: a plan switch is not held back by what the old one counted.
    await setPlan(env, org, "payg");
    expect((await models(key)).status).toBe(200);
  });
});
