// Billing does nothing on a self-hosted Commissary (ADR 0042, ADR 0043): its routes (`/v9/management/billing*` and
// Polar's webhook) answer like a path the router does not know, even to a platform admin. Commissary Cloud's route is
// tested in test/hosted/billing.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { isolatedPlatform, makeHarness } from "./support/management.ts";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

describe("billing on a self-hosted Commissary", () => {
  it("answers 404", async () => {
    expect((await harness.call("/v9/management/billing")).status).toBe(404);
    expect((await harness.call("/v9/management/orgs/default/billing")).status).toBe(404);

    for (const path of [
      "/v9/management/billing/checkout",
      "/v9/management/billing/plan",
      "/webhooks/polar",
    ])
      expect(
        (
          await harness.call(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ plan: "free" }),
          })
        ).status,
      ).toBe(404);
  });
});
