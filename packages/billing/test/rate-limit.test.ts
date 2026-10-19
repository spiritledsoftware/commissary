// The request-rate ceiling per plan (src/rate-limit.ts): the binding the org's plan picks, keyed by the org.
import { env } from "cloudflare:workers";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { newOrgId } from "@commissary/core";
import {
  type BillingBindings,
  BillingEnv,
  limitClientRate,
  RATE_LIMITED,
  type RateLimiter,
  REQUEST_RATE_CEILING,
} from "../src/api.ts";
import { setPlan } from "./testing.ts";

/** A limiter that lets `allowed` requests through and records the keys it was asked about. */
const limiter = (allowed: number) => {
  const keys: string[] = [];

  const limit: RateLimiter = {
    limit: async ({ key }) => {
      keys.push(key);

      return { success: keys.length <= allowed };
    },
  };

  return { limit, keys };
};

const bindings = (limits: Partial<BillingBindings>): BillingBindings => ({ ...env, ...limits });

describe("limitClientRate", () => {
  it("is 60 a minute on Free and 600 a minute on Pay as you go", () => {
    assert.deepStrictEqual(REQUEST_RATE_CEILING, { free: 60, payg: 600 });
  });

  it.effect("counts a Free org on the Free binding and a Pay as you go org on the other", () =>
    Effect.gen(function* () {
      const free = newOrgId();
      const paying = newOrgId();
      const onFree = limiter(1);
      const onPayg = limiter(2);

      yield* Effect.promise(() => setPlan(env, paying, "payg"));

      const run = (org: typeof free) =>
        limitClientRate(org).pipe(
          Effect.provideService(
            BillingEnv,
            bindings({ FREE_RATE_LIMIT: onFree.limit, PAYG_RATE_LIMIT: onPayg.limit }),
          ),
        );

      yield* run(free);
      yield* run(paying);
      yield* run(paying);

      assert.deepStrictEqual(onFree.keys, [free]);
      assert.deepStrictEqual(onPayg.keys, [paying, paying]);

      const over = yield* Effect.flip(run(free));

      assert.strictEqual(over._tag, "RateLimitedError");
      assert.strictEqual(over.message, RATE_LIMITED);
      assert.strictEqual(over.retryAfterSeconds, 60);

      // The Pay as you go binding is not the Free one's: its third request is the one it refuses.
      assert.strictEqual((yield* Effect.flip(run(paying)))._tag, "RateLimitedError");
    }),
  );

  it.effect("reads an org's plan once for a short while, then asks again", () =>
    Effect.gen(function* () {
      const org = newOrgId();
      const onFree = limiter(10);
      const onPayg = limiter(10);

      const run = limitClientRate(org).pipe(
        Effect.provideService(
          BillingEnv,
          bindings({ FREE_RATE_LIMIT: onFree.limit, PAYG_RATE_LIMIT: onPayg.limit }),
        ),
      );

      yield* run;

      // Changed behind the cache's back (a plan change in another isolate): not seen at once, seen after the TTL.
      yield* Effect.promise(
        async () => await env.CONTROL_PLANE.getByName(org).billing().setPlan("payg"),
      );
      yield* run;
      assert.deepStrictEqual([onFree.keys.length, onPayg.keys.length], [2, 0]);

      yield* TestClock.adjust("31 seconds");
      yield* run;
      assert.deepStrictEqual([onFree.keys.length, onPayg.keys.length], [2, 1]);
    }),
  );

  it.effect("has no ceiling where no binding is declared, or on a self-hosted Commissary", () =>
    Effect.gen(function* () {
      const org = newOrgId();
      const refusing = limiter(0);

      yield* limitClientRate(org).pipe(Effect.provideService(BillingEnv, bindings({})));

      yield* limitClientRate(org).pipe(
        Effect.provideService(
          BillingEnv,
          bindings({ COMMISSARY_MODE: undefined, FREE_RATE_LIMIT: refusing.limit }),
        ),
      );

      assert.deepStrictEqual(refusing.keys, []);
    }),
  );

  it.effect("lets a request through when the binding fails", () =>
    Effect.gen(function* () {
      const failing: RateLimiter = {
        limit: () => Promise.reject(new Error("binding down")),
      };

      yield* limitClientRate(newOrgId()).pipe(
        Effect.provideService(BillingEnv, bindings({ FREE_RATE_LIMIT: failing })),
      );
    }),
  );

  it.effect("gives an org whose plan cannot be read Free's ceiling", () =>
    Effect.gen(function* () {
      const onFree = limiter(10);

      const unreadable = bindings({
        FREE_RATE_LIMIT: onFree.limit,
        PAYG_RATE_LIMIT: limiter(0).limit,
        CONTROL_PLANE: {
          getByName: () => {
            throw new Error("control plane down");
          },
          // SAFETY: only `getByName` is called, and it fails.
        } as unknown as BillingBindings["CONTROL_PLANE"],
      });

      const org = newOrgId();

      yield* limitClientRate(org).pipe(Effect.provideService(BillingEnv, unreadable));
      assert.deepStrictEqual(onFree.keys, [org]);
    }),
  );
});
