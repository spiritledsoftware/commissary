// Billing's cron task (src/scheduled-tasks.ts) and its org-deletion step (src/org-deletion.ts) against a fake billing
// provider that counts meter events the way Polar does (by their external id): only usage above free usage and not sent
// before goes out, and a batch sent again is not counted twice. `TestClock` drives the time and the task's pause.
import { env } from "cloudflare:workers";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { CurrentOrg, newOrgId, type OrgId } from "@commissary/core";
import { type BillingBindings, BillingEnv, scheduledTasks } from "../src/api.ts";
import { orgDeletionStep } from "../src/management.ts";
import type { BillingProvider } from "../src/provider.ts";
import { SEND_PAUSE } from "../src/scheduled-tasks.ts";
import { BillingProviders, fakeBillingProvider, FREE_USAGE, seedRequestsUsed } from "./testing.ts";

const NOW = Date.UTC(2026, 2, 15, 12);

const task = scheduledTasks.find((candidate) => candidate.name === "billing-meter-events");

const billingOf = (org: OrgId) => env.CONTROL_PLANE.getByName(org).billing();

/** One round trip to the org's part: lets the task's own calls to it (real I/O) go on meanwhile. */
const roundTrip = (org: OrgId) => Effect.promise(async () => void (await billingOf(org).plan()));

/** One cron run of the task for `org`, forked: it fails with the task's failure, if any. */
const forkTask = (
  org: OrgId,
  provider: BillingProvider | undefined,
  bindings: BillingBindings = env,
) => {
  if (task === undefined) return Effect.die(new Error("no billing-meter-events task"));

  return task.run.pipe(
    Effect.provideService(CurrentOrg, org),
    Effect.provideService(BillingEnv, bindings),
    Effect.provideService(BillingProviders, () => provider),
    Effect.flip,
    Effect.option,
    Effect.forkChild,
  );
};

/** One cron run of the task for `org`, its pauses passed on the test clock; its failure, if any. */
const runTask = (org: OrgId, provider: BillingProvider | undefined) =>
  Effect.gen(function* () {
    const fiber = yield* forkTask(org, provider);

    for (let turn = 0; fiber.pollUnsafe() === undefined; turn += 1) {
      if (turn > 50) return yield* Effect.die(new Error("the task did not finish"));
      yield* roundTrip(org);
      yield* TestClock.adjust(SEND_PAUSE);
    }

    return yield* Fiber.join(fiber);
  });

const seed = (org: OrgId, used: number) =>
  Effect.promise(() => seedRequestsUsed(env, org, NOW, used));

/** An org on Pay as you go with a Polar customer, as after its checkout. */
const payingOrg = Effect.gen(function* () {
  const org = newOrgId();

  yield* TestClock.setTime(NOW);

  yield* Effect.promise(() =>
    billingOf(org).applySubscription({
      status: "active",
      subscriptionId: "sub_1",
      customerId: "cus_1",
      changedAt: NOW - 1000,
    }),
  );

  return org;
});

describe("the meter-events task", () => {
  it.effect("sends only usage above free usage that was not sent before", () =>
    Effect.gen(function* () {
      const org = yield* payingOrg;
      const fake = fakeBillingProvider();

      yield* seed(org, FREE_USAGE.requests + 100);
      yield* runTask(org, fake.provider);
      yield* runTask(org, fake.provider);
      assert.strictEqual(fake.total("requests"), 100);
      assert.lengthOf(
        fake.calls.filter((made) => made.call === "sendMeterEvents"),
        1,
      );

      yield* seed(org, FREE_USAGE.requests + 130);
      yield* runTask(org, fake.provider);
      assert.strictEqual(fake.total("requests"), 130);
    }),
  );

  it.effect("pauses after a batch it sent, so the runner stays under Polar's rate limit", () =>
    Effect.gen(function* () {
      const org = yield* payingOrg;
      const fake = fakeBillingProvider();

      yield* seed(org, FREE_USAGE.requests + 5);

      const fiber = yield* forkTask(org, fake.provider);

      for (let turn = 0; fake.total("requests") === 0; turn += 1) {
        if (turn > 50) return yield* Effect.die(new Error("the batch was not sent"));
        yield* roundTrip(org);
      }

      // Time for the task to record the batch as sent; then it waits for the clock.
      for (let turn = 0; turn < 5; turn += 1) yield* roundTrip(org);
      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust(SEND_PAUSE);
      assert.isTrue(Option.isNone(yield* Fiber.join(fiber)));
    }),
  );

  it.effect(
    "sends a batch Polar may have taken again with the same ids, so it is counted once",
    () =>
      Effect.gen(function* () {
        const org = yield* payingOrg;
        const fake = fakeBillingProvider();

        yield* seed(org, FREE_USAGE.requests + 50);
        fake.state.answersLost = true;
        assert.isTrue(Option.isSome(yield* runTask(org, fake.provider)));

        fake.state.answersLost = false;
        yield* runTask(org, fake.provider);
        assert.strictEqual(fake.total("requests"), 50);

        const batches = fake.calls.filter((made) => made.call === "sendMeterEvents");

        assert.lengthOf(batches, 2);
        assert.deepStrictEqual(batches[0]?.input, batches[1]?.input);
      }),
  );

  it.effect("sends nothing for an org that never checked out, or without a billing provider", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const free = newOrgId();
      const fake = fakeBillingProvider();

      yield* seed(free, FREE_USAGE.requests);
      yield* runTask(free, fake.provider);
      assert.deepStrictEqual(fake.calls, []);

      const paying = yield* payingOrg;

      yield* seed(paying, FREE_USAGE.requests + 10);
      assert.isTrue(Option.isNone(yield* runTask(paying, undefined)));
      assert.isNotNull(yield* Effect.promise(() => billingOf(paying).meterBatch(NOW)));
    }),
  );

  it.effect("sends nothing more for an org that went back to Free", () =>
    Effect.gen(function* () {
      const org = yield* payingOrg;
      const fake = fakeBillingProvider();

      yield* seed(org, FREE_USAGE.requests + 20);
      yield* runTask(org, fake.provider);
      yield* Effect.promise(() => billingOf(org).endSubscription(NOW));

      yield* seed(org, FREE_USAGE.requests + 40);
      yield* runTask(org, fake.provider);
      assert.strictEqual(fake.total("requests"), 20);
    }),
  );
});

/** Billing's org-deletion step with `provider`, run for `org` with a large budget. */
const deleteOrg = (org: OrgId, provider: BillingProvider | undefined) =>
  Effect.gen(function* () {
    const run = yield* orgDeletionStep.pipe(
      Effect.provideService(BillingEnv, env),
      Effect.provideService(BillingProviders, () => provider),
    );

    return yield* Effect.promise(() => run(org, 400));
  });

describe("deleting an org", () => {
  it.effect("sends a Pay-as-you-go org's usage, then cancels its subscription", () =>
    Effect.gen(function* () {
      const org = yield* payingOrg;
      const fake = fakeBillingProvider();

      yield* seed(org, FREE_USAGE.requests + 7);

      assert.include(yield* deleteOrg(org, fake.provider), { complete: true });
      assert.strictEqual(fake.total("requests"), 7);
      assert.deepStrictEqual(
        fake.calls.map((made) => made.call),
        ["sendMeterEvents", "cancelSubscription"],
      );
      assert.strictEqual(fake.calls[1]?.input, "sub_1");
    }),
  );

  it.effect("asks to be run again when the provider cannot be reached", () =>
    Effect.gen(function* () {
      const org = yield* payingOrg;
      const fake = fakeBillingProvider();

      fake.failing.add("cancelSubscription");
      assert.include(yield* deleteOrg(org, fake.provider), { complete: false, part: "billing" });

      fake.failing.clear();
      assert.include(yield* deleteOrg(org, fake.provider), { complete: true });
    }),
  );

  it.effect("finishes when the provider refuses for good, so the org can still be deleted", () =>
    Effect.gen(function* () {
      const org = yield* payingOrg;
      const fake = fakeBillingProvider();

      yield* seed(org, FREE_USAGE.requests + 3);
      fake.refusing.add("sendMeterEvents");

      assert.include(yield* deleteOrg(org, fake.provider), { complete: true });
      assert.deepStrictEqual(
        fake.calls.map((made) => made.call),
        ["sendMeterEvents"],
      );
    }),
  );

  it.effect("has nothing to do without a billing provider", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* deleteOrg(yield* payingOrg, undefined), {
        complete: true,
        calls: 0,
      });
    }),
  );
});
