// Zero data retention (ADR 0027) and Spend limits (issue #71): an org's Spend limits and counters go with the org, through
// the Worker's org deletion. A member's and an API key's: packages/models/test/spend-deletion.test.ts.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { ModelsEnv } from "@commissary/models/api";
import { orgDeletionStep } from "@commissary/models/management";
import { HELD, resetUsageDb, spendingOrg, spendRows } from "@commissary/models/testing";
import { controlPlaneOf } from "@commissary/state";
import { deleteOrg } from "../src/platform/org-deletion.ts";

beforeAll(async () => {
  await resetUsageDb();
});

/** Models' org-deletion step over the test Worker's bindings. */
const modelsStep = () => Effect.runPromise(Effect.provideService(orgDeletionStep, ModelsEnv, env));

describe("Spend data of an org that is deleted", () => {
  it("leaves no limit, counter or setting behind", async () => {
    const org = await spendingOrg();
    const other = await spendingOrg();

    expect(await deleteOrg(env, [await modelsStep()], org.org, { now: Date.now() })).toEqual({
      state: "deleted",
    });

    // The wiped object holds no table at all, so no Spend table and no row of one.
    const tables = await runInDurableObject(controlPlaneOf(env, org.org), (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'spend_%'",
        )
        .toArray(),
    );

    expect(tables).toEqual([]);
    expect(await spendRows(other, "member", other.alice.id)).toEqual(HELD);
  });
});
