// Retry planning and cooldown-aware selection in the credential pool (injected clock, no Durable Object):
// conductor_retry_round_test.go, conductor_selection_cooldown_test.go, conductor_alias_cooldown_test.go,
// conductor_subsecond_cooldown_test.go (retry storms), openai_compat_pool_test.go.
import { describe, expect, it } from "vitest";
import type { PickResult } from "../src/credentials/selection/types.ts";
import type { CredentialPool } from "../src/credentials/pool.ts";
import { makePool, MemoryPoolStore, TestNow } from "./support/pool.ts";

const group = (name: string, extra = "", model = "{ name: m }") => `
    - name: ${name}
      base-url: https://${name}.example/v1
      ${extra}
      models: [${model}]
      keys: [{ api-key: key-${name} }]`;

const config = (groups: string, extra = "") => `
${extra}
api-keys:
  openai-compatibility:${groups}
`;

const providers = (names: string[]) => names.map((name) => `openai-compatible-${name}`);

const ok = (result: PickResult) => {
  if (!result.ok) throw new Error(`pick failed: ${result.failure.code}`);

  return result;
};

/** Picks until nothing is selectable, like one retry round of the conductor. */
const round = (
  pool: CredentialPool,
  names: string[],
  roundNumber: number,
  requestRetry = 0,
  model = "m",
): string[] => {
  const tried: string[] = [];
  const executors: string[] = [];

  for (;;) {
    const result = pool.pick({
      providers: providers(names),
      model,
      tried,
      retryRound: roundNumber,
      requestRetry,
    });

    if (!result.ok) return executors;
    tried.push(result.credential.id);
    executors.push(result.credential.executor);
  }
};

describe("retry rounds (TestExecuteRetryRoundCredentialWindows)", () => {
  it("credentials age out of later rounds once their own request-retry is spent", async () => {
    const { pool } = await makePool(
      config(
        group("a", "request-retry: 3\n      disable-cooling: true") +
          group("b", "request-retry: 2\n      disable-cooling: true") +
          group("c", "request-retry: 2\n      disable-cooling: true"),
      ),
    );

    const names = ["a", "b", "c"];
    const ids = (r: number) => round(pool, names, r);
    expect(ids(0).toSorted()).toEqual(names.map((n) => `openai-compatible-${n}`));
    expect(ids(2)).toHaveLength(3);
    expect(ids(3)).toEqual(["openai-compatible-a"]);
    expect(ids(4)).toEqual([]);
  });

  it("uses the default request-retry for credentials without an override", async () => {
    const { pool } = await makePool(config(group("a") + group("b", "request-retry: 5")));
    expect(round(pool, ["a", "b"], 1, 1)).toHaveLength(2);
    expect(round(pool, ["a", "b"], 2, 1)).toHaveLength(1);
  });
});

describe("planRetry (shouldRetryAfterErrorWithAttempted steps 3-5)", () => {
  const retryQuery = (extra: Record<string, unknown> = {}) => ({
    providers: providers(["a"]),
    model: "m",
    round: 0,
    requestRetry: 2,
    status: 500,
    attempted: [] as string[],
    maxWaitMs: 0,
    ...extra,
  });

  it("retries immediately while a credential is available and budget remains", async () => {
    const { pool } = await makePool(config(group("a")));
    expect(pool.planRetry(retryQuery())).toEqual({ retry: true, waitMs: 0 });
    expect(pool.planRetry(retryQuery({ round: 2 }))).toEqual({ retry: false });
  });

  it("an attempted credential that just failed with 429 waits for the cooldown, with a 10 s floor", async () => {
    const { pool, clock } = await makePool(config(group("a", "")));
    const picked = ok(pool.pick({ providers: providers(["a"]), model: "m" }));
    pool.report(picked.lease, {
      success: false,
      httpStatus: 429,
      error: { message: "slow down", retryable: true, httpStatus: 429 },
      retryAfterMs: 12_000,
    });
    const query = retryQuery({ status: 429, attempted: [picked.credential.id], maxWaitMs: 60_000 });
    expect(pool.planRetry(query)).toEqual({ retry: true, waitMs: 12_000 });
    // Less than 10 s left: the 10 s floor applies to a credential that just failed with 429.
    clock.advance(11_000);
    expect(pool.planRetry(query)).toEqual({ retry: true, waitMs: 10_000 });
    // Cooldown over: an attempted credential still must not trigger an immediate retry (TestClosestCooldownWait...).
    clock.advance(2000);
    expect(pool.planRetry(query)).toEqual({ retry: true, waitMs: 10_000 });
    // Not attempted in the failed round -> zero wait.
    expect(pool.planRetry({ ...query, attempted: [] })).toEqual({ retry: true, waitMs: 0 });
  });

  it("declines when the recovery is longer than max-retry-interval and reports it for Retry-After", async () => {
    const { pool } = await makePool(config(group("a")));
    const picked = ok(pool.pick({ providers: providers(["a"]), model: "m" }));
    pool.report(picked.lease, {
      success: false,
      httpStatus: 429,
      error: { message: "q", retryable: true, httpStatus: 429 },
      retryAfterMs: 120_000,
    });
    const query = retryQuery({ status: 429, attempted: [picked.credential.id] });
    expect(pool.planRetry({ ...query, maxWaitMs: 0 })).toEqual({
      retry: false,
      retryAfterMs: 120_000,
    });
    expect(pool.planRetry({ ...query, maxWaitMs: 30_000 })).toEqual({
      retry: false,
      retryAfterMs: 120_000,
    });
    expect(pool.planRetry({ ...query, maxWaitMs: 120_000 })).toEqual({
      retry: true,
      waitMs: 120_000,
    });
  });

  it("a credential cooling for a non-retry-round reason (401) does not open another round", async () => {
    const { pool } = await makePool(config(group("a")));
    const picked = ok(pool.pick({ providers: providers(["a"]), model: "m" }));
    pool.report(picked.lease, {
      success: false,
      httpStatus: 401,
      error: { message: "no", retryable: false, httpStatus: 401 },
    });
    expect(
      pool.planRetry(
        retryQuery({ status: 401, attempted: [picked.credential.id], maxWaitMs: 3_600_000 }),
      ),
    ).toEqual({
      retry: false,
    });
  });

  it("falls back to the error's Retry-After when no credential reports a recovery time", async () => {
    const { pool } = await makePool(config(group("a", "disable-cooling: true")));
    const picked = ok(pool.pick({ providers: providers(["a"]), model: "m" }));
    pool.report(picked.lease, {
      success: false,
      httpStatus: 503,
      error: { message: "x", retryable: true, httpStatus: 503 },
    });
    // Cooling is disabled: the credential stays available, so the retry is immediate.
    expect(pool.planRetry(retryQuery({ status: 503, attempted: [picked.credential.id] }))).toEqual({
      retry: true,
      waitMs: 0,
    });
  });
});

describe("cooldown-aware selection", () => {
  it("returns model_cooldown (429 + Retry-After) when every candidate is cooling", async () => {
    const { pool, clock } = await makePool(config(group("a")));
    const picked = ok(pool.pick({ providers: providers(["a"]), model: "m" }));
    pool.report(picked.lease, {
      success: false,
      httpStatus: 429,
      error: { message: "q", retryable: true, httpStatus: 429 },
      retryAfterMs: 30_000,
    });
    const blocked = pool.pick({ providers: providers(["a"]), model: "m" });
    expect(blocked).toMatchObject({
      ok: false,
      failure: { code: "model_cooldown", httpStatus: 429, retryAfterSeconds: 30 },
    });
    clock.advance(30_001);
    expect(pool.pick({ providers: providers(["a"]), model: "m" }).ok).toBe(true);
  });

  it("a cooling credential is skipped in favour of another one", async () => {
    const { pool } = await makePool(config(group("a") + group("b")));
    const first = ok(pool.pick({ providers: providers(["a", "b"]), model: "m" }));
    pool.report(first.lease, {
      success: false,
      httpStatus: 500,
      error: { message: "x", retryable: true, httpStatus: 500 },
    });

    for (let index = 0; index < 4; index += 1) {
      expect(
        ok(pool.pick({ providers: providers(["a", "b"]), model: "m" })).credential.id,
      ).not.toBe(first.credential.id);
    }
  });

  it("a stale lease (credential replaced meanwhile) is ignored", async () => {
    const { pool } = await makePool(config(group("a")));
    const picked = ok(pool.pick({ providers: providers(["a"]), model: "m" }));
    const stale = { ...picked.lease, credentialVersion: 0 };
    expect(pool.report(stale, { success: false, httpStatus: 500 })).toEqual({
      ok: true,
      applied: false,
    });
    expect(pool.pick({ providers: providers(["a"]), model: "m" }).ok).toBe(true);
  });
});

describe("alias pools (TestManager alias cooldown, openai_compat_pool_test.go)", () => {
  const pooled = config(`
    - name: p
      base-url: https://p.example/v1
      models:
        - { name: up-1, alias: shared }
        - { name: up-2, alias: shared }
      keys: [{ api-key: key-p }]`);

  it("rotates the starting upstream model per pick and marks the route pooled", async () => {
    const { pool } = await makePool(pooled);

    const orders = Array.from({ length: 4 }, () => {
      const picked = ok(pool.pick({ providers: providers(["p"]), model: "shared" }));
      expect(picked.route.pooled).toBe(true);

      return picked.route.upstreamModels.join(",");
    });

    expect(new Set(orders)).toEqual(new Set(["up-1,up-2", "up-2,up-1"]));
  });

  it("skips upstream models whose own cooldown is active and tracks state per upstream model", async () => {
    const { pool, clock } = await makePool(pooled);
    const picked = ok(pool.pick({ providers: providers(["p"]), model: "shared" }));
    pool.report(picked.lease, {
      success: false,
      httpStatus: 429,
      error: { message: "q", retryable: true, httpStatus: 429 },
      retryAfterMs: 60_000,
      model: "up-1",
    });

    for (let index = 0; index < 3; index += 1) {
      const next = ok(pool.pick({ providers: providers(["p"]), model: "shared" }));
      expect(next.route.upstreamModels).toEqual(["up-2"]);
      expect(next.route.pooled).toBe(true);
    }

    // Both cooling: the credential has no usable upstream model -> model_cooldown.
    pool.report(picked.lease, {
      success: false,
      httpStatus: 429,
      error: { message: "q", retryable: true, httpStatus: 429 },
      retryAfterMs: 30_000,
      model: "up-2",
    });
    expect(pool.pick({ providers: providers(["p"]), model: "shared" })).toMatchObject({
      ok: false,
      failure: { code: "model_cooldown" },
    });
    clock.advance(31_000);
    expect(
      ok(pool.pick({ providers: providers(["p"]), model: "shared" })).route.upstreamModels,
    ).toEqual(["up-2"]);
    clock.advance(30_000);
    expect(
      ok(pool.pick({ providers: providers(["p"]), model: "shared" })).route.upstreamModels,
    ).toHaveLength(2);
  });
});

describe("cooldown persistence (always on: an eviction is not a restart)", () => {
  const failure = {
    success: false,
    httpStatus: 500,
    error: { message: "boom", retryable: true, httpStatus: 500 },
  } as const;

  it.each([
    ["by default", config(group("a"))],
    [
      "with save-cooldown-status: false",
      config(group("a"), "routing:\n  cooldown:\n    save-cooldown-status: false"),
    ],
  ])("persists counters, the last error and active cooldowns %s", async (_label, yaml) => {
    const store = new MemoryPoolStore();
    const clock = new TestNow();
    const { pool } = await makePool(yaml, { store, clock });
    const picked = ok(pool.pick({ providers: providers(["a"]), model: "m" }));
    pool.report(picked.lease, failure);
    expect(store.states.get(picked.credential.id)).toMatchObject({
      failed: 1,
      lastError: { httpStatus: 500 },
      unavailable: true,
    });

    const restarted = await makePool(yaml, { store, clock });
    expect(restarted.pool.pick({ providers: providers(["a"]), model: "m" })).toMatchObject({
      ok: false,
      failure: { code: "auth_unavailable", httpStatus: 503, retryAfterSeconds: 60 },
    });
    clock.advance(61_000);
    expect(restarted.pool.pick({ providers: providers(["a"]), model: "m" }).ok).toBe(true);
  });
});

describe("in-flight successes do not clear a newer cooldown (CLIProxyAPI 35af74f9)", () => {
  const quota = {
    success: false as const,
    httpStatus: 429,
    error: { message: "slow down", retryable: true, httpStatus: 429 },
    retryAfterMs: 60_000,
  };

  it("a success dispatched before the 429 leaves the model cooling; one dispatched after clears it", async () => {
    const { pool, clock } = await makePool(config(group("a")));
    const request = { providers: providers(["a"]), model: "m" };
    const early = ok(pool.pick(request));
    const failing = ok(pool.pick(request));

    pool.report(failing.lease, quota);
    expect(pool.pick(request).ok).toBe(false);

    // The early request was dispatched before the cooldown: it proves nothing about recovery.
    pool.report(early.lease, { success: true });
    expect(pool.pick(request).ok).toBe(false);
    expect(pool.list()[0]).toMatchObject({ success: 1, failed: 1, unavailable: true });

    // A dispatch after the cooldown (credits fallback ignores it) is a real recovery.
    clock.advance(1000);
    const late = ok(pool.pick({ ...request, ignoreCooldown: true }));
    pool.report(late.lease, { success: true });
    expect(pool.pick(request).ok).toBe(true);
  });

  it("many in-flight successes cannot reopen an exhausted credential before it recovers", async () => {
    const { pool, clock } = await makePool(config(group("a")));
    const request = { providers: providers(["a"]), model: "m" };
    const inflight = [1, 2, 3, 4].map(() => ok(pool.pick(request)));
    const failing = ok(pool.pick(request));

    pool.report(failing.lease, quota);

    for (const lease of inflight) {
      pool.report(lease.lease, { success: true });
      expect(pool.pick(request).ok).toBe(false);
    }

    clock.advance(61_000);
    expect(pool.pick(request).ok).toBe(true);
  });

  it("a credential-scoped 429 keeps every model cooling against stale successes", async () => {
    const { pool } = await makePool(config(group("a", "", "{ name: m }, { name: n }")));
    const requestN = { providers: providers(["a"]), model: "n" };
    const early = ok(pool.pick(requestN));
    const failing = ok(pool.pick({ providers: providers(["a"]), model: "m" }));

    pool.report(failing.lease, { ...quota, credentialScoped: true });
    expect(pool.pick(requestN).ok).toBe(false);
    pool.report(early.lease, { success: true });
    expect(pool.pick(requestN).ok).toBe(false);
  });

  it("a lease issued before a restart cannot clear a cooldown recorded after it", async () => {
    const store = new MemoryPoolStore();
    const clock = new TestNow();
    const yaml = config(group("a"));
    const first = await makePool(yaml, { store, clock });
    const request = { providers: providers(["a"]), model: "m" };
    const oldLeases = Array.from({ length: 50 }, () => ok(first.pool.pick(request)));

    clock.advance(5000);
    const restarted = await makePool(yaml, { store, clock });
    const failing = ok(restarted.pool.pick(request));
    restarted.pool.report(failing.lease, quota);

    for (const old of oldLeases) restarted.pool.report(old.lease, { success: true });
    expect(restarted.pool.pick(request).ok).toBe(false);
  });

  it("a failure reported under another spelling of the model keeps its mark", async () => {
    const { pool } = await makePool(config(group("a")));
    const request = { providers: providers(["a"]), model: "m" };
    const early = ok(pool.pick(request));
    const failing = ok(pool.pick(request));

    pool.report(failing.lease, { ...quota, model: "M" });
    pool.report(early.lease, { success: true, model: "m" });
    expect(pool.pick(request).ok).toBe(false);
  });

  it("a restart forgets the dispatch order: a restored cooldown is cleared by any success", async () => {
    const store = new MemoryPoolStore();
    const clock = new TestNow();
    const yaml = config(group("a"));
    const first = await makePool(yaml, { store, clock });
    const request = { providers: providers(["a"]), model: "m" };
    const failing = ok(first.pool.pick(request));
    first.pool.report(failing.lease, quota);

    const restarted = await makePool(yaml, { store, clock });
    const restored = ok(restarted.pool.pick({ ...request, ignoreCooldown: true }));
    restarted.pool.report(restored.lease, { success: true });
    expect(restarted.pool.pick(request).ok).toBe(true);
  });
});
