// What agent runs cost (#234, `management/run-costs.ts`), as the Agents area's run routes read it through the app
// Worker: `Some` with each run's cost from its records (a run with none left out, which the routes show as 0), and
// `None`, never a failure, when the usage store is missing or cannot be read, so the routes leave the cost out rather
// than say 0.
import { env } from "cloudflare:workers";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { ModelsEnv } from "../src/env.ts";
import { runCosts } from "../src/management/run-costs.ts";
import { insertUsageRecord } from "../src/usage/d1.ts";
import { resetUsageDb, sampleRecord } from "./support/usage.ts";

beforeEach(async () => {
  await resetUsageDb();
});

/** `runCosts` of `runs` in the org `global`, over `usage` as the usage store. */
const costsWith = (usage: D1Database | undefined, runs: ReadonlyArray<string>) =>
  Effect.runPromise(
    runCosts(runs, undefined).pipe(
      // SAFETY: a deployment without the usage store leaves `USAGE` unbound, which the type does not say.
      Effect.provideService(ModelsEnv, { ...env, USAGE: usage as D1Database }),
      Effect.provideService(CurrentOrg, GLOBAL_ORG),
    ),
  );

describe("what agent runs cost", () => {
  it("is each run's records' cost, a run with none left out", async () => {
    await insertUsageRecord(
      env.USAGE,
      sampleRecord({
        principalId: "run:ar_1",
        run: { agentId: "ag_1", runId: "ar_1" },
        cost: { micros: 1_200, unpriced: false },
      }),
    );

    expect(await costsWith(env.USAGE, ["ar_1", "ar_2"])).toEqual(
      Option.some(new Map([["ar_1", 1_200]])),
    );
  });

  it("is None without the usage store", async () => {
    expect(await costsWith(undefined, ["ar_1"])).toEqual(Option.none());
  });

  it("is None, not a failure, when the usage store cannot be read", async () => {
    const failing = {
      prepare: () => {
        throw new Error("D1 is unavailable");
      },
    };

    // SAFETY: only `prepare` is called, and it fails as an unreachable database does.
    expect(await costsWith(failing as unknown as D1Database, ["ar_1"])).toEqual(Option.none());
  });
});
