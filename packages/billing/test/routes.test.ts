// `GET /v9/management/billing` (src/routes.ts) through a router of its own, with the current org the Worker's gate
// would have set: the plan and the month's usage against free usage on Commissary Cloud, a 404 elsewhere.
import { env } from "cloudflare:workers";
import { Context, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { describe, expect, it } from "vitest";
import { BillingView } from "@commissary/contract/billing";
import { CurrentOrg, newOrgId } from "@commissary/core";
import { type BillingBindings, BillingEnv } from "../src/api.ts";
import { BillingRoutes } from "../src/management.ts";
import { seedRequestsUsed, setPlan } from "./testing.ts";

const { handler } = HttpRouter.toWebHandler(BillingRoutes, { disableLogger: true });

const get = async (bindings: BillingBindings, org = newOrgId()): Promise<Response> =>
  await handler(
    new Request("https://commissary.test/v9/management/billing"),
    Context.make(BillingEnv, bindings).pipe(Context.add(CurrentOrg, org)),
  );

describe("GET /billing", () => {
  it("shows a new org on Free with nothing used of its free usage", async () => {
    const response = await get(env);

    expect(response.status).toBe(200);

    const view = Schema.decodeUnknownSync(BillingView)(await response.json());
    const start = new Date(view.month_start);
    const resets = new Date(view.resets_at);

    expect(view.plan).toBe("free");
    // A calendar month in UTC: it starts on the first at midnight and resets on the first of the next month.
    expect(start.getUTCDate()).toBe(1);
    expect(start.getUTCHours()).toBe(0);
    expect(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1)).toBe(resets.getTime());
    expect(view.usage).toEqual({
      requests: { used: 0, free: 25_000 },
      browser_hours: { used: 0, free: 1 },
      computer_hours: { used: 0, free: 0 },
    });
  });

  it("shows the plan and what the month used", async () => {
    const org = newOrgId();

    await setPlan(env, org, "payg");
    await seedRequestsUsed(env, org, Date.now(), 25_300);

    const view = Schema.decodeUnknownSync(BillingView)(await (await get(env, org)).json());

    expect(view.plan).toBe("payg");
    expect(view.usage.requests).toEqual({ used: 25_300, free: 25_000 });
    expect(new Date(view.resets_at).getUTCDate()).toBe(1);
  });

  it("answers 404 on a self-hosted Commissary", async () => {
    const response = await get({ ...env, COMMISSARY_MODE: undefined });

    expect(response.status).toBe(404);
  });
});
