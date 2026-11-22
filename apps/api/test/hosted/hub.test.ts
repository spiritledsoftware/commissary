// The hub API (ADR 0052) on Commissary Cloud: its requests count against the org's plan ceiling, as the client API's
// do (the test Worker allows 5 per minute on Free, vitest.config.ts), after the management key is authenticated. The
// routes themselves are tested on a self-hosted Commissary (test/hub.test.ts).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { RATE_LIMITED } from "@commissary/billing/api";
import { resetUsageDb } from "@commissary/models/testing";
import { controlPlaneOf } from "@commissary/state";
import { call, keyedOrg, roomInWindow } from "./support.ts";

beforeAll(async () => {
  await resetUsageDb();
});

const FREE_LIMIT = 5;

const authFiles = (key: string) =>
  call("/v0/management/auth-files", { headers: { authorization: `Bearer ${key}` } });

describe("the hub API on Commissary Cloud", () => {
  it("counts against the plan's request-rate ceiling", async () => {
    const email = `hub-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const { org } = await keyedOrg(email);

    const issued = await controlPlaneOf(env, org).createManagementKey(
      { name: "t3", role: "owner", createdBy: "test", ownerEmail: email },
      Date.now(),
    );

    if (!issued.ok) throw new Error(issued.message);
    const { key } = issued.value;

    await roomInWindow();

    for (let sent = 0; sent < FREE_LIMIT; sent += 1) {
      const response = await authFiles(key);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ files: [] });
    }

    const limited = await authFiles(key);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: RATE_LIMITED });
  });

  it("takes no request without a management key, and counts none", async () => {
    const response = await call("/v0/management/auth-files");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Missing API key" });
  });
});
