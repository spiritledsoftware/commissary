// Counting requests against free usage and the plan limit (src/meter.ts), over the real Billing part: what Models'
// request path calls when it starts serving a client API request. `TestClock` drives the month; the part answers for
// the time it is given.
import { env } from "cloudflare:workers";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { CurrentOrg, newOrgId, type OrgId } from "@commissary/core";
import { platformOf } from "@commissary/state";
import {
  type BillingBindings,
  BillingEnv,
  countRequest,
  PlanLimitReached,
  uncountRequest,
} from "../src/api.ts";
import {
  FREE_USAGE,
  requestsUsed,
  resetBillingCaches,
  seedRequestsUsed,
  setPlan,
} from "./testing.ts";

const MID_MARCH = Date.UTC(2026, 2, 15, 12);

const FIRST_OF_APRIL = Date.UTC(2026, 3, 1);

const SELF_HOSTED: BillingBindings = { ...env, COMMISSARY_MODE: undefined };

/** Runs `effect` as a request of `org` on `bindings` (Commissary Cloud's by default). */
const asOrg = <A, E>(
  org: OrgId,
  effect: Effect.Effect<A, E, BillingEnv | CurrentOrg>,
  bindings: BillingBindings = env,
) =>
  effect.pipe(Effect.provideService(BillingEnv, bindings), Effect.provideService(CurrentOrg, org));

describe("countRequest", () => {
  it.effect("counts a request on Commissary Cloud and answers what to take back", () =>
    Effect.gen(function* () {
      const org = newOrgId();

      yield* TestClock.setTime(MID_MARCH);

      const counted = yield* asOrg(org, countRequest);

      assert.deepStrictEqual(counted, { monthStart: Date.UTC(2026, 2, 1) });
      assert.strictEqual(yield* Effect.promise(() => requestsUsed(env, org, MID_MARCH)), 1);

      yield* asOrg(org, uncountRequest(counted));
      assert.strictEqual(yield* Effect.promise(() => requestsUsed(env, org, MID_MARCH)), 0);
    }),
  );

  it.effect(
    "refuses a Free org's request over 25,000 until the first of next month, then serves again",
    () =>
      Effect.gen(function* () {
        const org = newOrgId();

        yield* Effect.promise(() => seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests));
        yield* TestClock.setTime(MID_MARCH);

        const refused = yield* Effect.flip(asOrg(org, countRequest));

        assert.instanceOf(refused, PlanLimitReached);
        assert.strictEqual(refused.retryAfterSeconds, (FIRST_OF_APRIL - MID_MARCH) / 1000);
        assert.strictEqual(refused.resetsAt, "2026-04-01T00:00:00.000Z");
        assert.include(refused.message, "25,000 requests and tool calls");
        assert.include(refused.message, "2026-04-01T00:00:00.000Z");
        assert.deepStrictEqual(JSON.parse(refused.body), {
          error: {
            code: "plan_limit_reached",
            message: refused.message,
            limit: "requests",
            allowed: 25_000,
            resets_at: "2026-04-01T00:00:00.000Z",
            reset_seconds: (FIRST_OF_APRIL - MID_MARCH) / 1000,
          },
        });

        // The refusal counted nothing.
        assert.strictEqual(
          yield* Effect.promise(() => requestsUsed(env, org, MID_MARCH)),
          FREE_USAGE.requests,
        );

        yield* TestClock.setTime(FIRST_OF_APRIL - 1);
        assert.isTrue((yield* Effect.flip(asOrg(org, countRequest))) instanceof PlanLimitReached);

        yield* TestClock.setTime(FIRST_OF_APRIL);
        assert.deepStrictEqual(yield* asOrg(org, countRequest), { monthStart: FIRST_OF_APRIL });
      }),
  );

  it.effect(
    "keeps refusing an org the plan refused, without asking its ControlPlane, for a short while",
    () =>
      Effect.gen(function* () {
        const org = newOrgId();

        yield* Effect.promise(() => seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests));
        yield* TestClock.setTime(MID_MARCH);
        yield* Effect.flip(asOrg(org, countRequest));

        // Changed behind the cache's back (another isolate switched the plan): seen after the TTL, not before.
        yield* Effect.promise(
          async () => await env.CONTROL_PLANE.getByName(org).billing().setPlan("payg"),
        );

        const again = yield* Effect.flip(asOrg(org, countRequest));

        assert.instanceOf(again, PlanLimitReached);
        assert.strictEqual(again.retryAfterSeconds, (FIRST_OF_APRIL - MID_MARCH) / 1000);

        yield* TestClock.adjust("31 seconds");
        assert.isDefined(yield* asOrg(org, countRequest));
      }),
  );

  it.effect("links the refusal to the org's billing page on the app host", () =>
    Effect.gen(function* () {
      const org = newOrgId();
      const slug = `org-${crypto.randomUUID().slice(0, 8)}`;

      const created = yield* Effect.promise(
        async () => await platformOf(env).createOrg({ slug, name: slug, id: org }, MID_MARCH),
      );

      assert.isTrue(created.ok);
      yield* Effect.promise(() => seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests));
      yield* TestClock.setTime(MID_MARCH);

      const refused = yield* Effect.flip(asOrg(org, countRequest));

      assert.include(refused.message, `https://app.example.com/o/${slug}/billing`);

      resetBillingCaches();

      const withoutHost = yield* Effect.flip(
        asOrg(org, countRequest, { ...env, APP_DOMAIN: undefined }),
      );

      assert.include(withoutHost.message, "the billing page of the panel");
      assert.notInclude(withoutHost.message, `/${slug}/billing`);
    }),
  );

  it.effect("does not stop a Pay as you go org at its free usage", () =>
    Effect.gen(function* () {
      const org = newOrgId();

      yield* Effect.promise(() => setPlan(env, org, "payg"));
      yield* Effect.promise(() => seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests));
      yield* TestClock.setTime(MID_MARCH);

      assert.isDefined(yield* asOrg(org, countRequest));
      assert.strictEqual(
        yield* Effect.promise(() => requestsUsed(env, org, MID_MARCH)),
        FREE_USAGE.requests + 1,
      );
    }),
  );

  it.effect(
    "refuses a Pay as you go org's billed request at its billing cap, naming the cap until next month",
    () =>
      Effect.gen(function* () {
        const org = newOrgId();

        yield* Effect.promise(() => setPlan(env, org, "payg"));
        // $50 above free usage: 10,000,000 requests at $0.50 per 100,000.
        yield* Effect.promise(() =>
          seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + 10_000_000),
        );
        yield* TestClock.setTime(MID_MARCH);

        const refused = yield* Effect.flip(asOrg(org, countRequest));

        assert.instanceOf(refused, PlanLimitReached);
        assert.strictEqual(refused.retryAfterSeconds, (FIRST_OF_APRIL - MID_MARCH) / 1000);
        assert.include(refused.message, "billing cap of $50.00");
        assert.include(refused.message, "2026-04-01T00:00:00.000Z");
        assert.include(refused.message, "the billing page of the panel");
        assert.deepStrictEqual(JSON.parse(refused.body), {
          error: {
            code: "plan_limit_reached",
            message: refused.message,
            limit: "billing_cap",
            allowed: 50,
            resets_at: "2026-04-01T00:00:00.000Z",
            reset_seconds: (FIRST_OF_APRIL - MID_MARCH) / 1000,
          },
        });
        resetBillingCaches();
      }),
  );

  it.effect(
    "forgets a billing-cap refusal within 5 seconds, so a cap raised elsewhere lets use resume",
    () =>
      Effect.gen(function* () {
        const org = newOrgId();

        yield* Effect.promise(() => setPlan(env, org, "payg"));
        yield* Effect.promise(() =>
          seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests + 10_000_000),
        );
        yield* TestClock.setTime(MID_MARCH);
        assert.instanceOf(yield* Effect.flip(asOrg(org, countRequest)), PlanLimitReached);

        // An owner removed the cap through the app Worker: this isolate's refusal was not forgotten.
        yield* Effect.promise(
          async () => await env.CONTROL_PLANE.getByName(org).billing().setBillingCap(null),
        );
        assert.instanceOf(yield* Effect.flip(asOrg(org, countRequest)), PlanLimitReached);

        yield* TestClock.adjust("4999 millis");
        assert.instanceOf(yield* Effect.flip(asOrg(org, countRequest)), PlanLimitReached);

        yield* TestClock.adjust("1 millis");
        assert.isDefined(yield* asOrg(org, countRequest));
      }),
  );

  it.effect("holds a past-due Pay as you go org to Free's stop, and says why", () =>
    Effect.gen(function* () {
      const org = newOrgId();

      yield* Effect.promise(async () => {
        await env.CONTROL_PLANE.getByName(org).billing().applySubscription({
          status: "past_due",
          subscriptionId: "sub_1",
          customerId: "cus_1",
          changedAt: MID_MARCH,
        });
      });
      yield* Effect.promise(() => seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests));
      yield* TestClock.setTime(MID_MARCH);

      const refused = yield* Effect.flip(asOrg(org, countRequest));

      assert.instanceOf(refused, PlanLimitReached);
      assert.include(refused.message, "until a payment succeeds");
      resetBillingCaches();
    }),
  );

  it.effect("counts nothing and refuses nothing on a self-hosted Commissary", () =>
    Effect.gen(function* () {
      const org = newOrgId();

      yield* Effect.promise(() => seedRequestsUsed(env, org, MID_MARCH, FREE_USAGE.requests * 2));
      yield* TestClock.setTime(MID_MARCH);

      assert.isUndefined(yield* asOrg(org, countRequest, SELF_HOSTED));
      yield* asOrg(org, uncountRequest(undefined), SELF_HOSTED);

      assert.strictEqual(
        yield* Effect.promise(() => requestsUsed(env, org, MID_MARCH)),
        FREE_USAGE.requests * 2,
      );
    }),
  );

  it.effect("lets the request through when the Billing part cannot be reached", () =>
    Effect.gen(function* () {
      const broken: BillingBindings = {
        ...env,
        CONTROL_PLANE: {
          getByName: () => {
            throw new Error("control plane down");
          },
          // SAFETY: only `getByName` is called, and it fails.
        } as unknown as BillingBindings["CONTROL_PLANE"],
      };

      assert.isUndefined(yield* asOrg(newOrgId(), countRequest, broken));
    }),
  );
});
