// Spend limits in the credential pool (issue #71): the `pick` check (a request-level 429 with `Retry-After`, no cooldown),
// shared credentials at their own limit skipped, private credentials outside member/team/org limits, the lease that
// carries the scopes to charge, and the charge made by `report`. The pool runs with an injected clock and an in-memory
// ledger book, so the reset at local midnight (with a DST change) is driven by `clock.advance`.
import { describe, expect, it } from "vitest";
import type { PickResult, ReportResult } from "../src/credentials/selection/types.ts";
import { SpendLedger } from "@commissary/state/spend";
import { makePool, TestNow } from "./support/pool.ts";
import { limit, MemorySpendBook, USD } from "@commissary/state/testing";

const group = (name: string) => `
    - name: ${name}
      base-url: https://${name}.example/v1
      models: [{ name: m }]
      keys: [{ api-key: key-${name} }]`;

const config = (...names: ReadonlyArray<string>) => `
api-keys:
  openai-compatibility:${names.map(group).join("")}
`;

/** The credential id a group's key gets (content-addressed): found by its label. */
const idOf = (harness: Awaited<ReturnType<typeof makePool>>, label: string): string => {
  const found = harness.pool.list().find((credential) => credential.label === label);

  if (found === undefined) throw new Error(`no credential labelled ${label}`);

  return found.id;
};

const at = (iso: string): number => Date.parse(iso);

const request = {
  providers: ["openai-compatible-a", "openai-compatible-b", "openai-compatible-p"],
  model: "m",
};

const success = (costMicros?: number): ReportResult => ({
  success: true,
  httpStatus: 200,
  ...(costMicros === undefined ? {} : { costMicros }),
});

const picked = (result: PickResult) => {
  if (!result.ok) throw new Error(`pick failed: ${result.failure.code}`);

  return result;
};

const ledgerOf = (book: MemorySpendBook, teams: Record<string, ReadonlyArray<string>> = {}) =>
  new SpendLedger(book, (member) => teams[member] ?? []);

describe("pick with a Spend limit", () => {
  it("serves a member until their daily limit is spent, then refuses with 429 and Retry-After to local midnight", async () => {
    const book = new MemorySpendBook([limit("member", "m1", "day", 5 * USD)], {
      timeZone: "America/New_York",
    });

    const clock = new TestNow(at("2026-03-10T16:00:00Z"));
    const h = await makePool(config("a"), { clock, spend: ledgerOf(book) });
    const first = picked(h.pool.pick({ ...request, memberId: "m1" }));

    expect(first.lease.spend).toEqual([{ kind: "member", subject: "m1" }]);

    h.pool.report(first.lease, success(5 * USD));
    const refused = h.pool.pick({ ...request, memberId: "m1" });

    expect(refused).toMatchObject({
      ok: false,
      failure: {
        code: "spend_limit_reached",
        httpStatus: 429,
        retryable: false,
      },
    });

    if (refused.ok) return;
    // 16:00Z is noon in New York (EDT); midnight is 12 hours away.
    expect(refused.failure.retryAfterSeconds).toBe(12 * 3600);
    expect(refused.failure.message).toContain("daily Spend limit of your membership");
    expect(JSON.parse(refused.failure.body ?? "{}")).toMatchObject({
      error: { code: "spend_limit_reached", period: "day", limit: "member" },
    });
    // Others are served.
    expect(h.pool.pick({ ...request, memberId: "m2" }).ok).toBe(true);
  });

  it("starts a fresh day at local midnight, across a DST change", async () => {
    const book = new MemorySpendBook([limit("member", "m1", "day", 1 * USD)], {
      timeZone: "America/New_York",
    });

    // 2026-03-08 in New York is 23 hours long: 05:00Z (EST midnight) to 04:00Z the next day (EDT midnight).
    const clock = new TestNow(at("2026-03-08T06:00:00Z"));
    const h = await makePool(config("a"), { clock, spend: ledgerOf(book) });
    h.pool.report(picked(h.pool.pick({ ...request, memberId: "m1" })).lease, success(1 * USD));

    clock.value = at("2026-03-09T03:59:59Z");
    expect(h.pool.pick({ ...request, memberId: "m1" }).ok).toBe(false);

    clock.value = at("2026-03-09T04:00:00Z");
    expect(h.pool.pick({ ...request, memberId: "m1" }).ok).toBe(true);
  });

  it("changes week at the org's first day of the week and month on the first", async () => {
    const book = new MemorySpendBook(
      [limit("member", "m1", "week", 1 * USD), limit("member", "m2", "month", 1 * USD)],
      { weekStart: "monday" },
    );

    const clock = new TestNow(at("2026-03-10T12:00:00Z"));
    const h = await makePool(config("a"), { clock, spend: ledgerOf(book) });
    h.pool.report(picked(h.pool.pick({ ...request, memberId: "m1" })).lease, success(1 * USD));
    h.pool.report(picked(h.pool.pick({ ...request, memberId: "m2" })).lease, success(1 * USD));

    clock.value = at("2026-03-15T23:59:59Z");
    expect(h.pool.pick({ ...request, memberId: "m1" }).ok).toBe(false);
    clock.value = at("2026-03-16T00:00:00Z");
    expect(h.pool.pick({ ...request, memberId: "m1" }).ok).toBe(true);

    // The monthly limit of m2 holds through March and ends on April 1.
    clock.value = at("2026-03-31T23:59:59Z");
    expect(h.pool.pick({ ...request, memberId: "m2" }).ok).toBe(false);
    clock.value = at("2026-04-01T00:00:00Z");
    expect(h.pool.pick({ ...request, memberId: "m2" }).ok).toBe(true);
  });

  it("stacks team and org limits with the member's own", async () => {
    const book = new MemorySpendBook([
      limit("member", "m1", "day", 10 * USD),
      limit("team", "t1", "day", 3 * USD),
      limit("org", "", "day", 4 * USD),
    ]);

    const h = await makePool(config("a"), {
      spend: ledgerOf(book, { m1: ["t1"], m2: ["t1"], m3: [] }),
    });

    h.pool.report(picked(h.pool.pick({ ...request, memberId: "m1" })).lease, success(2 * USD));
    h.pool.report(picked(h.pool.pick({ ...request, memberId: "m2" })).lease, success(1 * USD));

    // The team (m1 + m2) has spent its 3 USD: both are refused, m3 (not on the team) is not.
    expect(h.pool.pick({ ...request, memberId: "m1" })).toMatchObject({
      failure: { code: "spend_limit_reached" },
    });
    expect(h.pool.pick({ ...request, memberId: "m2" }).ok).toBe(false);
    const third = picked(h.pool.pick({ ...request, memberId: "m3" }));
    h.pool.report(third.lease, success(1 * USD));

    // The org has now spent its 4 USD: everyone is refused, naming the org.
    const refused = h.pool.pick({ ...request, memberId: "m3" });
    expect(refused).toMatchObject({
      ok: false,
      failure: { code: "spend_limit_reached" },
    });

    if (!refused.ok) expect(refused.failure.message).toContain("your org");
  });

  it("refusal is request-level: no credential is cooled and nothing else is tried", async () => {
    const book = new MemorySpendBook([limit("key", "k1", "day", 1 * USD)]);
    const h = await makePool(config("a", "b"), { spend: ledgerOf(book) });
    h.pool.report(
      picked(h.pool.pick({ ...request, memberId: "m1", apiKeyId: "k1" })).lease,
      success(1 * USD),
    );

    const refused = h.pool.pick({
      ...request,
      memberId: "m1",
      apiKeyId: "k1",
    });

    expect(refused).toMatchObject({
      ok: false,
      failure: { code: "spend_limit_reached" },
    });

    for (const credential of h.pool.list()) {
      expect(credential.unavailable).toBe(false);
      expect(credential.failed).toBe(0);
    }

    // The same member without that key is served.
    expect(h.pool.pick({ ...request, memberId: "m1" }).ok).toBe(true);
  });

  it("skips a shared credential at its own limit while another serves, and answers 503 when none can", async () => {
    const probe = await makePool(config("a", "b"));
    const a = idOf(probe, "a");
    const b = idOf(probe, "b");

    const book = new MemorySpendBook([
      limit("credential", a, "day", 1 * USD),
      limit("credential", b, "day", 1 * USD),
    ]);

    const clock = new TestNow(at("2026-03-10T12:00:00Z"));

    const h = await makePool(config("a", "b"), {
      clock,
      spend: ledgerOf(book),
    });

    const first = picked(h.pool.pick({ ...request, memberId: "m1" }));
    h.pool.report(first.lease, success(1 * USD));

    // Whatever the first was, the other one serves now.
    const second = picked(h.pool.pick({ ...request, memberId: "m1" }));
    expect(second.credential.id).not.toBe(first.credential.id);
    h.pool.report(second.lease, success(1 * USD));

    const none = h.pool.pick({ ...request, memberId: "m1" });
    expect(none).toMatchObject({
      ok: false,
      failure: {
        code: "auth_unavailable",
        httpStatus: 503,
        retryAfterSeconds: 12 * 3600,
      },
    });
    // Nothing was cooled.

    for (const credential of h.pool.list()) expect(credential.unavailable).toBe(false);

    clock.value = at("2026-03-11T00:00:00Z");
    expect(h.pool.pick({ ...request, memberId: "m1" }).ok).toBe(true);
  });

  it("keeps shared credentials away from a member at a member limit but lets their private credential serve", async () => {
    const book = new MemorySpendBook([
      limit("member", "m1", "day", 1 * USD),
      limit("key", "k1", "day", 10 * USD),
    ]);

    const clock = new TestNow(at("2026-03-10T12:00:00Z"));

    const h = await makePool(config("a"), {
      clock,
      spend: ledgerOf(book),
      privateConfigs: { m1: config("p") },
    });

    const caller = { ...request, memberId: "m1", apiKeyId: "k1" };
    // Spend the member limit on a shared credential (pin it so the private one is not chosen).
    const shared = picked(h.pool.pick({ ...caller, pinnedAuthId: idOf(h, "a") }));
    h.pool.report(shared.lease, success(1 * USD));

    const next = picked(h.pool.pick(caller));
    expect(next.credential.owner).toBe("m1");
    // Its traffic counts toward the key only: the lease charges the key and nothing else.
    expect(next.lease.spend).toEqual([{ kind: "key", subject: "k1" }]);
    h.pool.report(next.lease, success(4 * USD));

    // The member limit never saw the private traffic: still exactly the first 1 USD.
    const day = at("2026-03-10T00:00:00Z");
    expect(book.spent({ kind: "member", subject: "m1" }, "day", day)).toBe(1 * USD);
    expect(book.spent({ kind: "key", subject: "k1" }, "day", day)).toBe(5 * USD);
    // Nothing else may serve a member without a private credential.

    const other = h.pool.pick({
      ...request,
      memberId: "m1",
      pinnedAuthId: idOf(h, "a"),
    });

    expect(other).toMatchObject({
      ok: false,
      failure: { code: "spend_limit_reached" },
    });
  });

  it("refuses with the spend error when only shared credentials exist and the member limit has no room", async () => {
    const book = new MemorySpendBook([limit("member", "m1", "day", 1 * USD)]);
    const h = await makePool(config("a"), { spend: ledgerOf(book) });
    h.pool.report(picked(h.pool.pick({ ...request, memberId: "m1" })).lease, success(1 * USD));

    expect(h.pool.pick({ ...request, memberId: "m1" })).toMatchObject({
      ok: false,
      failure: { code: "spend_limit_reached", httpStatus: 429 },
    });
  });

  it("a request without a member or a key meets only the org and credential limits", async () => {
    const book = new MemorySpendBook([
      limit("member", "m1", "day", 0),
      limit("key", "k1", "day", 0),
    ]);

    const h = await makePool(config("a"), { spend: ledgerOf(book) });

    expect(h.pool.pick(request).ok).toBe(true);
  });

  it("does not limit anything while no limit is stored", async () => {
    const h = await makePool(config("a"), {
      spend: ledgerOf(new MemorySpendBook()),
    });

    const first = picked(h.pool.pick({ ...request, memberId: "m1", apiKeyId: "k1" }));

    expect(first.lease.spend).toBeUndefined();
    h.pool.report(first.lease, success(1_000_000 * USD));
    expect(h.pool.pick({ ...request, memberId: "m1", apiKeyId: "k1" }).ok).toBe(true);
  });
});

describe("retry planning with Spend limits", () => {
  it("does not retry a round for credentials at their limit and hints Retry-After for the period", async () => {
    const probe = await makePool(config("a"));
    const a = idOf(probe, "a");
    const book = new MemorySpendBook([limit("credential", a, "day", 1 * USD)]);
    const clock = new TestNow(at("2026-03-10T12:00:00Z"));
    const h = await makePool(config("a"), { clock, spend: ledgerOf(book) });
    h.pool.report(picked(h.pool.pick({ ...request, memberId: "m1" })).lease, success(1 * USD));

    const plan = h.pool.planRetry({
      providers: request.providers,
      model: "m",
      round: 0,
      requestRetry: 3,
      status: 503,
      maxWaitMs: 30_000,
      memberId: "m1",
    });

    expect(plan).toEqual({ retry: false, retryAfterMs: 12 * 3_600_000 });
  });
});
