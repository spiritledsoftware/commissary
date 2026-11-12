// Selection tests ported from sdk/cliproxy/auth/selector_test.go (strategies, priorities, availability, affinity).
import { describe, expect, it } from "vite-plus/test";
import { SessionCache } from "../../src/credentials/selection/affinity.ts";
import { isBlockedForModel } from "../../src/credentials/selection/availability.ts";
import {
  MAX_SMOOTH_STATE_ENTRIES,
  RotationState,
  SmoothWeightedState,
  pickSmoothWeighted,
  successorIndex,
} from "../../src/credentials/selection/strategies.ts";
import {
  NOW,
  Harness,
  cooling,
  cred,
  defaultSettings,
  entry,
  state,
} from "../support/credentials.ts";

const wrr = () => new Harness({ ...defaultSettings, strategy: "weighted-round-robin" });

const fillFirst = () => new Harness({ ...defaultSettings, strategy: "fill-first" });

const affinity = () => new Harness({ ...defaultSettings, sessionAffinity: true });

const entries = (...ids: string[]) => ids.map((id) => entry(cred(id)));

describe("fill-first and round-robin", () => {
  it("fill-first picks the first ID deterministically", () => {
    const h = fillFirst();
    const pool = entries("b", "a", "c");
    expect(h.ids(pool, 4)).toEqual(["a", "a", "a", "a"]);
  });

  it("round-robin cycles through IDs in order", () => {
    const h = new Harness();
    expect(h.ids(entries("a", "b", "c"), 6)).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("only the highest priority tier is selectable", () => {
    const h = new Harness();

    const pool = [
      entry(cred("c", { priority: 0 })),
      entry(cred("a", { priority: 10 })),
      entry(cred("b", { priority: 10 })),
    ];

    expect(h.ids(pool, 4)).toEqual(["a", "b", "a", "b"]);
  });

  it("falls back to a lower tier while the higher tier cools down (fill-first)", () => {
    const h = fillFirst();

    const pool = [
      entry(
        cred("high", { priority: 10 }),
        state({ modelStates: { model: cooling(NOW + 30 * 60_000, true) } }),
      ),
      entry(cred("low", { priority: 0 })),
    ];

    expect(h.id(pool)).toBe("low");
  });

  it("shares the rotation cursor across thinking-suffix variants", () => {
    const h = new Harness();
    const pool = entries("a", "b", "c");
    const picked = ["m(low)", "m(high)", "m", "m(8192)"].map((model) => h.id(pool, { model }));
    expect(picked).toEqual(["a", "b", "c", "a"]);
  });

  it("resumes the rotation across retry exclusions", () => {
    const h = new Harness();
    const ids = ["a", "b", "c"];
    const pool = entries(...ids);
    const requests = 30;
    const first: Record<string, number> = {};

    for (let index = 0; index < requests; index += 1) {
      const tried: string[] = [];

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const id = h.id(pool, { tried });

        if (attempt === 0) first[id] = (first[id] ?? 0) + 1;
        tried.push(id);
      }
    }

    expect(first).toEqual({ a: 10, b: 10, c: 10 });
  });

  it("successorIndex resumes after the previous pick and wraps", () => {
    const ring = [{ id: "aaa" }, { id: "ccc" }, { id: "eee" }];
    expect(successorIndex(ring, "")).toBe(0);
    expect(successorIndex(ring, "aaa")).toBe(1);
    expect(successorIndex(ring, "bbb")).toBe(1);
    expect(successorIndex(ring, "eee")).toBe(0);
    expect(successorIndex(ring, "zzz")).toBe(0);
  });

  it("caps the number of rotation keys", () => {
    const rotation = new RotationState(2);
    const ring = [{ id: "a" }];
    rotation.roundRobin("gemini:m1", ring);
    rotation.roundRobin("gemini:m2", ring);
    rotation.roundRobin("gemini:m3", ring);
    expect(rotation.cursorKeys).toBe(1);
  });

  it("skips tried credentials and reports auth_not_found once all were tried", () => {
    const h = new Harness();
    const pool = entries("a", "b");
    expect(h.id(pool, { tried: ["a"] })).toBe("b");
    expect(h.id(pool, { tried: ["a", "b"] })).toBe("failure:auth_not_found");
  });

  it("restricts selection to a pinned credential", () => {
    const h = new Harness();
    expect(h.ids(entries("a", "b", "c"), 3, { pinnedAuthId: "b" })).toEqual(["b", "b", "b"]);
  });

  it("never selects disabled credentials or credentials of other providers", () => {
    const h = new Harness();

    const pool = [
      entry(cred("a", { disabled: true })),
      entry(cred("b", { provider: "claude" })),
      entry(cred("c")),
    ];

    expect(h.ids(pool, 3)).toEqual(["c", "c", "c"]);
    expect(h.id(pool, { providers: [] })).toBe("failure:provider_not_found");
  });

  it("selects one ID-sorted union across several providers", () => {
    const h = new Harness();

    const pool = [
      entry(cred("a", { provider: "claude" })),
      entry(cred("b")),
      entry(cred("c", { provider: "codex" })),
    ];

    expect(h.ids(pool, 4, { providers: ["gemini", "claude"] })).toEqual(["a", "b", "a", "b"]);
  });
});

describe("weighted round-robin", () => {
  const weighted = (id: string, weight: number, extra = {}) =>
    entry(cred(id, { weight, ...extra }));

  it("distributes by weight and skips non-positive weights", () => {
    const h = wrr();

    const pool = [
      weighted("a", 5),
      weighted("b", 3),
      weighted("c", 2),
      weighted("disabled-by-weight", 0),
    ];

    expect(h.counts(pool, 100)).toEqual({ a: 50, b: 30, c: 20 });
  });

  it("resets credits when a weight changes", () => {
    const h = wrr();
    const before = [weighted("a", 1_000_000), weighted("b", 1)];
    h.ids(before, 1000);
    const after = [weighted("a", 1), weighted("b", 1)];
    expect(h.counts(after, 20)).toEqual({ a: 10, b: 10 });
  });

  it("rebalances when the highest weight is unavailable", () => {
    const h = wrr();
    const pool = [weighted("a", 5, { disabled: true }), weighted("b", 3), weighted("c", 2)];
    expect(h.counts(pool, 100)).toEqual({ b: 60, c: 40 });
  });

  it("skips credentials unavailable for the model or quota-exceeded without recovery time", () => {
    const h = wrr();

    const pool = [
      entry(
        cred("model-unavailable"),
        state({ modelStates: { model: { ...cooling(0), nextRetryAfter: 0 } } }),
      ),
      entry(
        cred("quota-exceeded"),
        state({ quota: { exceeded: true, nextRecoverAt: 0, backoffLevel: 0 } }),
      ),
      entry(cred("available")),
    ];

    expect(h.id(pool, { model: "model" })).toBe("available");

    for (const id of h.ids(pool, 4, { model: "model" })) expect(id).toBe("available");
  });

  it("saturates corrupt credit state instead of overflowing", () => {
    const current = new Map<string, number>([
      ["a", Number.MAX_SAFE_INTEGER],
      ["b", -Number.MAX_SAFE_INTEGER],
    ]);

    const picked = pickSmoothWeighted(
      [
        { id: "a", weight: 1 },
        { id: "b", weight: 1 },
      ],
      current,
    );

    expect(picked?.id).toBe("a");
    expect(current.get("a")).toBe(Number.MAX_SAFE_INTEGER - 2);
    expect(current.get("b")).toBe(-Number.MAX_SAFE_INTEGER + 1);
  });

  it("lets a recovered credential return without accumulated credit", () => {
    const h = wrr();
    const a = weighted("a", 5);
    const b = weighted("b", 1);
    h.ids([a, b], 6);

    const cooled = entry(
      a.credential,
      state({ unavailable: true, nextRetryAfter: NOW + 3_600_000 }),
    );

    expect(h.ids([cooled, b], 6)).toEqual(["b", "b", "b", "b", "b", "b"]);
    expect(h.counts([a, b], 6)).toEqual({ a: 5, b: 1 });
  });

  it("uses weight 1 by default", () => {
    expect(wrr().counts(entries("a", "b", "c"), 30)).toEqual({ a: 10, b: 10, c: 10 });
  });

  it("keeps even distribution for filtered subsets (no alphabetical bias)", () => {
    const h = wrr();
    expect(h.counts(entries("auth-b", "auth-c", "auth-d"), 30)).toEqual({
      "auth-b": 10,
      "auth-c": 10,
      "auth-d": 10,
    });
  });

  it("keeps weight ratios when candidates are excluded", () => {
    const h = wrr();
    const pool = [weighted("auth-a", 5), weighted("auth-b", 3), weighted("auth-c", 1)];
    h.ids(pool, 9);
    expect(h.counts(pool.slice(1), 400)).toEqual({ "auth-b": 300, "auth-c": 100 });
  });

  it("keeps credits for transient subsets, resets on real changes and bounds growth", () => {
    const stateful = new SmoothWeightedState();
    stateful.prepare(
      new Map([
        ["a", 1],
        ["b", 1],
      ]),
    );
    stateful.current.set("a", -2);
    stateful.current.set("b", 1);
    stateful.prepare(new Map([["b", 1]]));
    expect(Object.fromEntries(stateful.current)).toEqual({ a: -2, b: 1 });
    stateful.prepare(new Map([["b", 5]]));
    expect(stateful.current.size).toBe(0);

    for (let index = 0; index < MAX_SMOOTH_STATE_ENTRIES * 3; index += 1) {
      stateful.prepare(new Map([[`churn-${index}`, 5]]));
      stateful.current.set(`churn-${index}`, 1);
    }

    expect(stateful.current.size).toBeLessThanOrEqual(MAX_SMOOTH_STATE_ENTRIES);
    expect(stateful.weights.size).toBeLessThanOrEqual(MAX_SMOOTH_STATE_ENTRIES);
  });

  it("reports auth_not_found when every weight is non-positive", () => {
    expect(wrr().id([weighted("a", 0)])).toBe("failure:auth_not_found");
  });
});

describe("availability", () => {
  const credential = cred("a");

  it("blocks an unavailable credential without a recovery time", () => {
    const block = isBlockedForModel(credential, state({ unavailable: true }), "", NOW);
    expect(block).toMatchObject({ blocked: true, reason: "other" });
  });

  it("blocks credential-level quota without a recovery time", () => {
    const block = isBlockedForModel(
      credential,
      state({ quota: { exceeded: true, nextRecoverAt: 0, backoffLevel: 0 } }),
      "",
      NOW,
    );

    expect(block.blocked).toBe(true);
  });

  it("treats an expired recovery time as available (lazy expiry)", () => {
    const past = state({ unavailable: true, nextRetryAfter: NOW - 1000 });
    expect(isBlockedForModel(credential, past, "", NOW).blocked).toBe(false);
    const pastModel = state({ modelStates: { m: cooling(NOW - 1) } });
    expect(isBlockedForModel(credential, pastModel, "m", NOW).blocked).toBe(false);
  });

  it("matches model states by canonical model (thinking suffix) in both directions", () => {
    const next = NOW + 60_000;
    const suffixed = state({ modelStates: { "claude-sonnet(8192)": cooling(next) } });
    expect(isBlockedForModel(credential, suffixed, "claude-sonnet", NOW)).toMatchObject({
      blocked: true,
      next,
    });
    const base = state({ modelStates: { "claude-sonnet": cooling(next) } });
    expect(isBlockedForModel(credential, base, "claude-sonnet(16000)", NOW).blocked).toBe(true);
    expect(isBlockedForModel(credential, base, "other-model", NOW).blocked).toBe(false);
  });

  it("blocks the whole credential on credential_quota and for an unauthorized terminal failure", () => {
    const quota = state({
      quota: {
        exceeded: true,
        reason: "credential_quota",
        nextRecoverAt: NOW + 5000,
        backoffLevel: 0,
      },
    });

    expect(isBlockedForModel(credential, quota, "m", NOW)).toMatchObject({
      blocked: true,
      reason: "cooldown",
    });

    const unauthorized = state({
      unavailable: true,
      status: "error",
      lastError: { message: "no", retryable: false, httpStatus: 401 },
    });

    expect(isBlockedForModel(credential, unauthorized, "m", NOW).blocked).toBe(true);
  });

  it("never hands out an expired OAuth token", () => {
    const expired = cred("e", {
      metadata: { access_token: "tok", expired: new Date(NOW - 1000).toISOString() },
    });

    const fresh = cred("f", {
      metadata: { access_token: "tok", expired: new Date(NOW + 60_000).toISOString() },
    });

    expect(isBlockedForModel(expired, state(), "m", NOW).blocked).toBe(true);
    expect(isBlockedForModel(fresh, state(), "m", NOW).blocked).toBe(false);
    const rejected = state({ rejectedAccessToken: "tok" });
    expect(isBlockedForModel(fresh, rejected, "m", NOW).blocked).toBe(true);
  });

  it("ignores aggregated per-model quota for the credential level unless credential_quota", () => {
    const aggregate = state({
      quota: { exceeded: true, reason: "quota", nextRecoverAt: NOW + 5000, backoffLevel: 1 },
      modelStates: { m: cooling(NOW + 5000, true) },
    });

    expect(isBlockedForModel(credential, aggregate, "", NOW).blocked).toBe(false);
  });
});

describe("pick failures", () => {
  const next = NOW + 60_000;
  const coolingState = state({ modelStates: { "test-model": cooling(next, true) } });
  const pool = [entry(cred("a"), coolingState), entry(cred("b"), coolingState)];

  it("reports model_cooldown with HTTP 429, Retry-After and the Go body (provider only when single)", () => {
    const failure = (() => {
      const outcome = fillFirst().select(pool, { model: "test-model" });

      if (outcome.ok) throw new Error("expected failure");

      return outcome.failure;
    })();

    expect(failure).toMatchObject({
      code: "model_cooldown",
      httpStatus: 429,
      retryAfterSeconds: 60,
    });
    const body = JSON.parse(failure.body ?? "{}") as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      code: "model_cooldown",
      model: "test-model",
      provider: "gemini",
      reset_time: "1m0s",
      reset_seconds: 60,
    });

    const mixed = fillFirst().select(
      [entry(cred("a"), coolingState), entry(cred("b", { provider: "claude" }), coolingState)],
      { model: "test-model", providers: ["gemini", "claude"] },
    );

    if (mixed.ok) throw new Error("expected failure");
    expect(JSON.parse(mixed.failure.body ?? "{}").error).not.toHaveProperty("provider");
  });

  it("reports a retryable 503 auth_unavailable when cooling without quota, plain otherwise", () => {
    const cooled = state({ unavailable: true, nextRetryAfter: next });
    const withRecovery = new Harness().select([entry(cred("a"), cooled)]);

    if (withRecovery.ok) throw new Error("expected failure");
    expect(withRecovery.failure).toMatchObject({
      code: "auth_unavailable",
      httpStatus: 503,
      retryAfterSeconds: 60,
    });
    const terminal = new Harness().select([entry(cred("a"), state({ unavailable: true }))]);

    if (terminal.ok) throw new Error("expected failure");
    expect(terminal.failure).toMatchObject({ code: "auth_unavailable", retryable: false });
    expect(terminal.failure.httpStatus).toBeUndefined();
  });
});

describe("session affinity", () => {
  const session = (id: string, extra = {}) => ({ session: { id, ...extra } });

  it("keeps a session on the same credential", () => {
    const h = affinity();
    const pool = entries("auth-a", "auth-b", "auth-c");
    const first = h.id(pool, session("s1"));
    expect(h.ids(pool, 10, session("s1"))).toEqual(Array(10).fill(first));
  });

  it("spreads different sessions and keeps each consistent", () => {
    const h = affinity();
    const pool = entries("auth-a", "auth-b", "auth-c");
    const picks = ["s1", "s2", "s3"].map((id) => h.id(pool, session(id)));
    expect(new Set(picks).size).toBe(3);
    expect(["s1", "s2", "s3"].map((id) => h.id(pool, session(id)))).toEqual(picks);
  });

  it("falls back to the strategy without a session id", () => {
    const h = affinity();
    expect(h.id(entries("auth-b", "auth-a"), {})).toBe("auth-a");
    expect(h.id(entries("auth-b", "auth-a"), { session: { id: "  " } })).toBe("auth-b");
  });

  it("fails over when the bound credential becomes unavailable and keeps the new binding", () => {
    const h = affinity();
    const pool = entries("auth-a", "auth-b", "auth-c");
    const first = h.id(pool, session("failover"));
    const without = pool.filter((item) => item.credential.id !== first);
    const second = h.id(without, session("failover"));
    expect(second).not.toBe(first);
    expect(h.ids(without, 5, session("failover"))).toEqual(Array(5).fill(second));
    // The previous credential returning does not steal the session back.
    expect(h.id(pool, session("failover"))).toBe(second);
  });

  it("shares the binding across thinking-suffix variants of a model", () => {
    const h = affinity();
    const pool = entries("a", "b", "c");
    const first = h.id(pool, { ...session("s"), model: "claude-3(8192)" });
    expect(h.id(pool, { ...session("s"), model: "claude-3" })).toBe(first);
    expect(h.id(pool, { ...session("s"), model: "claude-3(high)" })).toBe(first);
  });

  it("keeps separate bindings per model and per provider set", () => {
    const h = affinity();

    const pool = [
      ...entries("a", "b"),
      entry(cred("c", { provider: "claude" })),
      entry(cred("d", { provider: "claude" })),
    ];

    const g1 = h.id(pool, { ...session("s"), model: "m1" });
    expect(g1).toBe("a");

    // `a` cools down for m2 only: the m2 binding differs while the m1 binding is untouched.
    const m2Pool = [
      entry(pool[0]!.credential, state({ modelStates: { m2: cooling(NOW + 60_000) } })),
      ...pool.slice(1),
    ];

    expect(h.id(m2Pool, { ...session("s"), model: "m2" })).toBe("b");
    expect(h.id(pool, { ...session("s"), model: "m1" })).toBe("a");
    const claude = h.id(pool, { ...session("s"), providers: ["claude"] });
    expect(["c", "d"]).toContain(claude);
    expect(h.id(pool, { ...session("s"), model: "m1" })).toBe("a");
  });

  it("isolates bindings between callers (same session id, different scope)", () => {
    const h = affinity();
    const pool = entries("a", "b");
    const alice = h.id(pool, session("shared", { callerScope: "alice" }));
    const bob = h.id(pool, session("shared", { callerScope: "bob" }));
    expect(alice).not.toBe(bob);
    expect(h.id(pool, session("shared", { callerScope: "alice" }))).toBe(alice);
    expect(h.id(pool, session("shared", { callerScope: "bob" }))).toBe(bob);
  });

  it("rebinds after the bound weight becomes zero and stays sticky when it recovers", () => {
    const h = new Harness({
      ...defaultSettings,
      strategy: "weighted-round-robin",
      sessionAffinity: true,
    });

    const a = (weight: number) => entry(cred("auth-a", { weight }));
    const b = entry(cred("auth-b", { weight: 1 }));
    expect(h.id([a(1), b], session("w"))).toBe("auth-a");
    expect(h.id([a(0), b], session("w"))).toBe("auth-b");
    expect(h.id([a(10), b], session("w"))).toBe("auth-b");
  });

  it("keeps a binding to a lower tier while the higher tier is available (binding outranks priority)", () => {
    const h = affinity();
    const low = entry(cred("low", { priority: 0 }));
    const high = entry(cred("high", { priority: 10 }));
    expect(h.id([low], session("s"))).toBe("low");
    expect(h.id([low, high], session("s"))).toBe("low");
    expect(h.id([low, high], session("other"))).toBe("high");
  });

  it("expires bindings after the TTL and refreshes them on use", () => {
    const h = affinity();
    const pool = entries("a", "b");
    const first = h.id(pool, session("ttl"));
    h.now += 59_000;
    expect(h.id(pool, session("ttl"))).toBe(first); // refreshed
    h.now += 59_000;
    expect(h.id(pool, session("ttl"))).toBe(first); // still alive thanks to the refresh
    h.now += 61_000;
    const second = h.id(pool, session("ttl"));
    expect(second).not.toBe(first); // round-robin moved on, the binding had expired
  });

  it("forks and subagents inherit the parent binding (subagents only when enabled)", () => {
    const parentPicks = (subagents: boolean) => {
      const h = new Harness({
        ...defaultSettings,
        sessionAffinity: true,
        sessionAffinitySubagents: subagents,
      });

      const pool = entries("a", "b", "c");
      const parent = h.id(pool, session("parent"));
      const fork = h.id(pool, session("child", { parentId: "parent", isFork: true }));
      const sub = h.id(pool, session("parent:agent:1", { parentId: "parent" }));

      return { parent, fork, sub };
    };

    const enabled = parentPicks(true);
    expect(enabled.fork).toBe(enabled.parent);
    expect(enabled.sub).toBe(enabled.parent);
    const disabled = parentPicks(false);
    expect(disabled.fork).toBe(disabled.parent);
    expect(disabled.sub).not.toBe(disabled.parent);
  });

  it("session cache: capacity eviction, touch, compare-and-delete and invalidation", () => {
    const cache = new SessionCache(1000, 2);
    cache.set("k1", "a", 0);
    cache.set("k2", "a", 0);
    cache.set("k3", "b", 0);
    expect(cache.get("k1", 1)).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(cache.touch("k2", "b", 10)).toBe(false);
    expect(cache.touch("k2", "a", 900)).toBe(true);
    expect(cache.get("k2", 1800)).toBe("a");
    expect(cache.compareAndDelete("k3", "a")).toBe(false);
    expect(cache.compareAndDelete("k3", "b")).toBe(true);
    cache.invalidateAuth("a");
    expect(cache.size).toBe(0);
  });
});

// CLIProxyAPI 2f6f2924 (selector_guardian_affinity_test.go): a Guardian review runs another model, so another affinity
// key, and would lose the parent's credential and its prompt cache; it inherits the parent's latest binding instead.
describe("guardian reviews inherit the parent credential", () => {
  const PARENT = "main-thread";

  const REVIEW = "review-thread";

  const parentRequest = { providers: ["codex"], model: "gpt-6.1-sol", session: { id: PARENT } };

  const review = (extra: Record<string, unknown> = {}, sessionExtra = {}) => ({
    providers: ["codex"],
    model: "codex-auto-review",
    session: { id: REVIEW, parentId: PARENT, isGuardian: true, ...sessionExtra },
    ...extra,
  });

  const codex = (id: string) => entry(cred(id, { provider: "codex" }));

  const bound = () => {
    const h = new Harness({ ...defaultSettings, sessionAffinity: true });
    // The parent's credential is `auth-b`, while the strategy alone would pick `auth-a` for the review.
    expect(h.id([codex("auth-b")], parentRequest)).toBe("auth-b");

    return h;
  };

  const pool = () => [codex("auth-a"), codex("auth-b")];

  it("takes the parent's credential across models, where an ordinary request takes the strategy's", () => {
    const h = bound();

    expect(h.id(pool(), review())).toBe("auth-b");
    expect(bound().id(pool(), review({}, { isGuardian: false }))).toBe("auth-a");
  });

  it("matches a custom review model too, since it keys on the request, not the model", () => {
    expect(bound().id(pool(), review({ model: "custom-review-model" }))).toBe("auth-b");
  });

  it("uses the parent's latest binding, whatever model it was on", () => {
    const h = new Harness({ ...defaultSettings, sessionAffinity: true });
    expect(h.id([codex("auth-a")], { ...parentRequest, model: "older-model" })).toBe("auth-a");
    expect(h.id([codex("auth-b")], parentRequest)).toBe("auth-b");

    expect(h.id(pool(), review())).toBe("auth-b");
  });

  it("is not reordered by a TTL refresh of an older binding", () => {
    const h = new Harness({ ...defaultSettings, sessionAffinity: true });
    expect(h.id([codex("auth-a")], { ...parentRequest, model: "older-model" })).toBe("auth-a");
    expect(h.id([codex("auth-b")], parentRequest)).toBe("auth-b");
    // The older binding is used again, which refreshes it and is the parent's newest selection.
    expect(h.id(pool(), { ...parentRequest, model: "older-model" })).toBe("auth-a");
    h.now += 1000;
    h.affinity.touch("::codex::main-thread::older-model", "auth-a", h.now);

    expect(h.id(pool(), review())).toBe("auth-a");
  });

  it("keeps the review's own binding once it has one", () => {
    const h = new Harness({ ...defaultSettings, sessionAffinity: true });
    expect(h.id([codex("auth-a")], review())).toBe("auth-a");
    expect(h.id([codex("auth-b")], parentRequest)).toBe("auth-b");

    expect(h.id(pool(), review())).toBe("auth-a");
  });

  it("does not change a fork, which keeps its own parent alias", () => {
    expect(bound().id(pool(), review({}, { isFork: true }))).toBe("auth-a");
  });

  it("falls back to the strategy without a parent, with subagent affinity off, or when the parent credential is gone", () => {
    expect(bound().id(pool(), review({}, { parentId: undefined }))).toBe("auth-a");

    const off = new Harness({
      ...defaultSettings,
      sessionAffinity: true,
      sessionAffinitySubagents: false,
    });

    expect(off.id([codex("auth-b")], parentRequest)).toBe("auth-b");
    expect(off.id(pool(), review())).toBe("auth-a");

    expect(bound().id([codex("auth-a")], review())).toBe("auth-a");
  });

  it("only inherits a binding on a provider the review may use", () => {
    const h = new Harness({ ...defaultSettings, sessionAffinity: true });

    const claudeParent = { providers: ["claude"], model: "claude-sonnet", session: { id: PARENT } };
    expect(h.id([entry(cred("auth-b", { provider: "claude" }))], claudeParent)).toBe("auth-b");

    // A codex-only review ignores it; a mixed pool of both providers may take it.
    expect(h.id([codex("auth-a")], review())).toBe("auth-a");
    const mixed = [codex("auth-a"), entry(cred("auth-b", { provider: "claude" }))];
    expect(h.id(mixed, review({ providers: ["codex", "claude"] }))).toBe("auth-b");
  });

  it("never inherits across callers that share a session id", () => {
    const h = new Harness({ ...defaultSettings, sessionAffinity: true });

    const scoped = (callerScope: string, extra = {}) => ({
      ...review(),
      session: { id: REVIEW, parentId: PARENT, isGuardian: true, callerScope, ...extra },
    });

    expect(
      h.id([codex("auth-b")], {
        ...parentRequest,
        session: { id: PARENT, callerScope: "alice" },
      }),
    ).toBe("auth-b");

    // Bob's review names the same parent thread id, but alice's binding is not his.
    expect(h.id(pool(), scoped("bob"))).toBe("auth-a");
    expect(h.id(pool(), scoped("alice"))).toBe("auth-b");
  });

  it("forgets a parent binding that expired or was dropped", () => {
    const expired = bound();
    expired.now += 61_000;
    expect(expired.id(pool(), review())).toBe("auth-a");

    const dropped = bound();
    dropped.affinity.invalidateAuth("auth-b");
    expect(dropped.id(pool(), review())).toBe("auth-a");
  });
});

describe("codex preferences", () => {
  it("prefers websocket credentials for websocket requests and skips free plans on demand", () => {
    const h = new Harness();
    const providers = ["codex"];

    const pool = [
      entry(cred("a", { provider: "codex" })),
      entry(cred("b", { provider: "codex", attributes: { websockets: "true" } })),
      entry(cred("c", { provider: "codex", attributes: { plan_type: "free" } })),
    ];

    expect(h.ids(pool, 3, { providers, preferWebsockets: true })).toEqual(["b", "b", "b"]);
    expect(h.ids(pool, 4, { providers, disallowFreeCodex: true })).toEqual(["a", "b", "a", "b"]);
  });
});
