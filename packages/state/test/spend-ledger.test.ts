// The Spend ledger (issue #71): which limits a request meets before a credential is chosen, what it is charged to, and
// when a period resets. Pure over an in-memory book with an explicit `now`.
import { describe, expect, it } from "vitest";
import { type SpendCaller, SpendLedger } from "../src/spend/index.ts";
import { MemorySpendBook, limit, USD } from "./support/spend.ts";

const at = (iso: string): number => Date.parse(iso);

const ledgerOf = (book: MemorySpendBook, teams: Record<string, ReadonlyArray<string>> = {}) =>
  new SpendLedger(book, (member) => teams[member] ?? []);

/** Charges a request of `caller` served by a shared credential, as the pool does at report time. */
const spend = (
  ledger: SpendLedger,
  caller: SpendCaller,
  micros: number,
  now: number,
  credential = { id: "cred-a", shared: true },
) => ledger.charge(ledger.scopes(caller, credential), micros, now);

describe("SpendLedger.gate", () => {
  it("answers nothing while the org has no limits, whatever was spent", () => {
    const ledger = ledgerOf(new MemorySpendBook());

    spend(ledger, { memberId: "m1" }, 50 * USD, 0);

    expect(ledger.gate({ memberId: "m1", apiKeyId: "k1" }, 0)).toBeUndefined();
    expect(ledger.scopes({ memberId: "m1" }, { id: "c", shared: true })).toEqual([]);
  });

  it("refuses a member at their daily limit until the next midnight of the org's zone", () => {
    const book = new MemorySpendBook([limit("member", "m1", "day", 5 * USD)], {
      timeZone: "America/New_York",
    });

    const ledger = ledgerOf(book);
    const noon = at("2026-03-10T16:00:00Z");

    expect(ledger.gate({ memberId: "m1" }, noon)).toBeUndefined();
    spend(ledger, { memberId: "m1" }, 5 * USD, noon);

    expect(ledger.gate({ memberId: "m1" }, noon)?.sharedBlocked).toEqual({
      kind: "member",
      period: "day",
      // Midnight in New York (EDT, UTC-4).
      resetsAt: at("2026-03-11T04:00:00Z"),
    });

    // Another member is untouched.
    expect(ledger.gate({ memberId: "m2" }, noon)).toBeUndefined();
    // One second before the local midnight the limit still holds; at midnight a fresh day begins.
    expect(
      ledger.gate({ memberId: "m1" }, at("2026-03-11T03:59:59Z"))?.sharedBlocked,
    ).toBeDefined();
    expect(ledger.gate({ memberId: "m1" }, at("2026-03-11T04:00:00Z"))).toBeUndefined();
  });

  it("resets at local midnight across a DST change", () => {
    const book = new MemorySpendBook([limit("member", "m1", "day", 1 * USD)], {
      timeZone: "America/New_York",
    });

    const ledger = ledgerOf(book);
    // 2026-03-08: the day of the spring-forward change is 23 hours long (EST midnight 05:00Z to EDT midnight 04:00Z).
    const before = at("2026-03-08T06:00:00Z");
    spend(ledger, { memberId: "m1" }, 1 * USD, before);

    expect(ledger.gate({ memberId: "m1" }, before)?.sharedBlocked?.resetsAt).toBe(
      at("2026-03-09T04:00:00Z"),
    );
    // 23 hours after the day began is already the next local day.
    expect(ledger.gate({ memberId: "m1" }, at("2026-03-09T04:00:00Z"))).toBeUndefined();
    // The day after the change is back to 24 hours.
    spend(ledger, { memberId: "m1" }, 1 * USD, at("2026-03-09T04:00:00Z"));

    expect(
      ledger.gate({ memberId: "m1" }, at("2026-03-09T20:00:00Z"))?.sharedBlocked?.resetsAt,
    ).toBe(at("2026-03-10T04:00:00Z"));
  });

  it("counts a week from the org's first day of the week and a month from the first", () => {
    const book = new MemorySpendBook(
      [limit("member", "m1", "week", 1 * USD), limit("org", "", "month", 2 * USD)],
      { weekStart: "monday" },
    );

    const ledger = ledgerOf(book);
    const tuesday = at("2026-03-10T12:00:00Z");
    spend(ledger, { memberId: "m1" }, 1 * USD, tuesday);

    // Sunday evening is still the week of the Monday before; Monday morning starts a new one.
    expect(ledger.gate({ memberId: "m1" }, at("2026-03-15T23:59:59Z"))?.sharedBlocked).toEqual({
      kind: "member",
      period: "week",
      resetsAt: at("2026-03-16T00:00:00Z"),
    });
    expect(ledger.gate({ memberId: "m1" }, at("2026-03-16T00:00:00Z"))).toBeUndefined();

    // The org's monthly limit: 2 USD spent in March (1 above, 1 now) is used up until April 1.
    spend(ledger, { memberId: "m1" }, 1 * USD, at("2026-03-16T00:00:00Z"));

    expect(ledger.gate({ memberId: "m2" }, at("2026-03-31T23:59:59Z"))?.sharedBlocked).toEqual({
      kind: "org",
      period: "month",
      resetsAt: at("2026-04-01T00:00:00Z"),
    });
    expect(ledger.gate({ memberId: "m2" }, at("2026-04-01T00:00:00Z"))).toBeUndefined();
  });

  it("stacks member, team and org limits: any one without room blocks", () => {
    const book = new MemorySpendBook([
      limit("member", "m1", "day", 10 * USD),
      limit("member", "m3", "day", 1 * USD),
      limit("team", "t1", "day", 3 * USD),
      limit("org", "", "day", 100 * USD),
    ]);

    const ledger = ledgerOf(book, { m1: ["t1"], m2: ["t1"], m3: [] });
    const now = at("2026-03-10T12:00:00Z");
    spend(ledger, { memberId: "m1" }, 2 * USD, now);
    spend(ledger, { memberId: "m2" }, 1 * USD, now);

    // The team has spent 3 USD together: both of its members are blocked, though neither reached their own limit.
    expect(ledger.gate({ memberId: "m1" }, now)?.sharedBlocked?.kind).toBe("team");
    expect(ledger.gate({ memberId: "m2" }, now)?.sharedBlocked?.kind).toBe("team");
    // The member limit binds by itself too.
    expect(ledger.gate({ memberId: "m3" }, now)).toBeUndefined();
    spend(ledger, { memberId: "m3" }, 1 * USD, now);

    expect(ledger.gate({ memberId: "m3" }, now)?.sharedBlocked?.kind).toBe("member");
  });

  it("answers with the limit that frees up last when several have no room", () => {
    const book = new MemorySpendBook([
      limit("member", "m1", "day", 1 * USD),
      limit("member", "m1", "month", 1 * USD),
    ]);

    const ledger = ledgerOf(book);
    const now = at("2026-03-10T12:00:00Z");
    spend(ledger, { memberId: "m1" }, 1 * USD, now);

    expect(ledger.gate({ memberId: "m1" }, now)?.sharedBlocked).toEqual({
      kind: "member",
      period: "month",
      resetsAt: at("2026-04-01T00:00:00Z"),
    });
  });

  it("enforces an admin's and a member's limit on the same key together", () => {
    const book = new MemorySpendBook([
      limit("key", "k1", "day", 10 * USD, "admin"),
      limit("key", "k1", "day", 2 * USD, "member"),
    ]);

    const ledger = ledgerOf(book);
    const now = at("2026-03-10T12:00:00Z");
    spend(ledger, { memberId: "m1", apiKeyId: "k1" }, 2 * USD, now);

    expect(ledger.gate({ memberId: "m1", apiKeyId: "k1" }, now)?.refuse?.kind).toBe("key");
  });

  it("a key limit refuses whatever credential would serve", () => {
    const book = new MemorySpendBook([limit("key", "k1", "day", 1 * USD)]);
    const ledger = ledgerOf(book);
    const now = at("2026-03-10T12:00:00Z");
    spend(ledger, { memberId: "m1", apiKeyId: "k1" }, 1 * USD, now, {
      id: "p",
      shared: false,
    });
    const gate = ledger.gate({ memberId: "m1", apiKeyId: "k1" }, now);

    expect(gate?.refuse).toEqual({
      kind: "key",
      period: "day",
      resetsAt: at("2026-03-11T00:00:00Z"),
    });
    // A request without that key is not affected.
    expect(ledger.gate({ memberId: "m1" }, now)).toBeUndefined();
  });

  it("skips a shared credential at its own limit and leaves the others", () => {
    const book = new MemorySpendBook([limit("credential", "cred-a", "day", 1 * USD)]);
    const ledger = ledgerOf(book);
    const now = at("2026-03-10T12:00:00Z");
    spend(ledger, { memberId: "m1" }, 1 * USD, now);
    const gate = ledger.gate({ memberId: "m2" }, now);

    expect(gate?.refuse).toBeUndefined();
    expect(gate?.sharedBlocked).toBeUndefined();
    expect([...(gate?.credentials ?? [])]).toEqual([
      [
        "cred-a",
        {
          kind: "credential",
          period: "day",
          resetsAt: at("2026-03-11T00:00:00Z"),
        },
      ],
    ]);
  });
});

describe("SpendLedger.scopes", () => {
  const book = () =>
    new MemorySpendBook([
      limit("member", "m1", "day", 1 * USD),
      limit("team", "t1", "day", 1 * USD),
      limit("org", "", "day", 1 * USD),
      limit("credential", "shared-1", "day", 1 * USD),
      limit("key", "k1", "day", 1 * USD),
    ]);

  it("charges a shared credential's traffic to the member, their teams, the org, the credential and the key", () => {
    const ledger = ledgerOf(book(), { m1: ["t1", "t2"] });

    expect(
      ledger.scopes({ memberId: "m1", apiKeyId: "k1" }, { id: "shared-1", shared: true }),
    ).toEqual([
      { kind: "key", subject: "k1" },
      { kind: "member", subject: "m1" },
      { kind: "team", subject: "t1" },
      { kind: "org", subject: "" },
      { kind: "credential", subject: "shared-1" },
    ]);
  });

  it("charges a private credential's traffic to the API key only", () => {
    const ledger = ledgerOf(book(), { m1: ["t1"] });

    expect(
      ledger.scopes({ memberId: "m1", apiKeyId: "k1" }, { id: "mine", shared: false }),
    ).toEqual([{ kind: "key", subject: "k1" }]);
    expect(ledger.scopes({ memberId: "m1" }, { id: "mine", shared: false })).toEqual([]);
  });

  it("private traffic counts toward key limits and never toward member, team or org limits", () => {
    const b = book();
    const ledger = ledgerOf(b, { m1: ["t1"] });
    const now = at("2026-03-10T12:00:00Z");
    const caller = { memberId: "m1", apiKeyId: "k1" };
    spend(ledger, caller, 5 * USD, now, { id: "mine", shared: false });

    // The key is used up; the member's, team's and org's limits saw nothing.
    const gate = ledger.gate(caller, now);
    expect(gate?.refuse?.kind).toBe("key");
    expect(gate?.sharedBlocked).toBeUndefined();
  });

  it("charges nothing for an unpriced request and ignores negative amounts", () => {
    const b = book();
    const ledger = ledgerOf(b);
    const now = at("2026-03-10T12:00:00Z");
    spend(ledger, { memberId: "m1" }, 0, now);
    spend(ledger, { memberId: "m1" }, -5, now);

    expect(ledger.gate({ memberId: "m1" }, now)).toBeUndefined();
  });
});

describe("SpendLedger and tool calls (#199)", () => {
  const toolkit = { id: "kit-1", shared: true, kind: "toolkit_credential" } as const;
  const now = at("2026-03-10T12:00:00Z");

  it("charges a call on a toolkit's shared credential to the member, their teams, the org, the toolkit and the key", () => {
    const ledger = ledgerOf(
      new MemorySpendBook([
        limit("member", "m1", "day", 1 * USD),
        limit("team", "t1", "day", 1 * USD),
        limit("org", "", "day", 1 * USD),
        limit("toolkit_credential", "kit-1", "day", 1 * USD),
        limit("credential", "kit-1", "day", 1 * USD),
        limit("key", "k1", "day", 1 * USD),
      ]),
      { m1: ["t1"] },
    );

    expect(ledger.scopes({ memberId: "m1", apiKeyId: "k1" }, toolkit)).toEqual([
      { kind: "key", subject: "k1" },
      { kind: "member", subject: "m1" },
      { kind: "team", subject: "t1" },
      { kind: "org", subject: "" },
      { kind: "toolkit_credential", subject: "kit-1" },
    ]);
  });

  it("refuses a call that any limit it would be charged to has no room under", () => {
    const book = new MemorySpendBook([
      limit("toolkit_credential", "kit-1", "day", 1 * USD),
      limit("member", "m1", "month", 3 * USD),
    ]);

    const ledger = ledgerOf(book);
    const caller = { memberId: "m1" };

    expect(ledger.refusal(caller, toolkit, now)).toBeUndefined();
    spend(ledger, caller, 1 * USD, now, toolkit);
    expect(ledger.refusal(caller, toolkit, now)).toEqual({
      kind: "toolkit_credential",
      period: "day",
      resetsAt: at("2026-03-11T00:00:00Z"),
    });
    // Another toolkit's shared credential has its own limit; the member's month still has room.
    expect(ledger.refusal(caller, { ...toolkit, id: "kit-2" }, now)).toBeUndefined();

    spend(ledger, caller, 2 * USD, now, { ...toolkit, id: "kit-2" });
    expect(ledger.refusal(caller, { ...toolkit, id: "kit-2" }, now)?.kind).toBe("member");
  });

  it("refuses a call on a private credential only by its API key's limits", () => {
    const book = new MemorySpendBook([
      limit("member", "m1", "day", 1 * USD),
      limit("key", "k1", "day", 1 * USD),
    ]);

    const ledger = ledgerOf(book);
    const caller = { memberId: "m1", apiKeyId: "k1" };
    const mine = { id: "kit-1", shared: false, kind: "toolkit_credential" } as const;

    spend(ledger, { memberId: "m1" }, 1 * USD, now, toolkit);
    expect(ledger.refusal(caller, mine, now)).toBeUndefined();
    expect(ledger.refusal(caller, toolkit, now)?.kind).toBe("member");

    spend(ledger, caller, 1 * USD, now, mine);
    expect(ledger.refusal(caller, mine, now)?.kind).toBe("key");
  });
});

describe("SpendLedger and agent runs (#228)", () => {
  const toolkit = { id: "kit-1", shared: true, kind: "toolkit_credential" } as const;
  const now = at("2026-03-10T12:00:00Z");

  it("counts a shared agent's run toward the agent's own limit and the org's, never its starter's", () => {
    const book = new MemorySpendBook([
      limit("agent", "agent-1", "day", 1 * USD),
      limit("org", "", "day", 10 * USD),
      limit("member", "m1", "day", 10 * USD),
    ]);

    const ledger = ledgerOf(book, { m1: ["t1"] });
    // A shared agent's run acts as the agent: no member, no API key.
    const run = { agentId: "agent-1" };

    expect(ledger.scopes(run, { id: "shared-1", shared: true })).toEqual([
      { kind: "org", subject: "" },
      { kind: "agent", subject: "agent-1" },
    ]);
    expect(ledger.scopes(run, toolkit)).toEqual([
      { kind: "org", subject: "" },
      { kind: "agent", subject: "agent-1" },
    ]);

    spend(ledger, run, 1 * USD, now);

    // At its limit, the agent's shared credentials are kept away and its tool calls refused.
    expect(ledger.gate(run, now)?.sharedBlocked).toEqual({
      kind: "agent",
      period: "day",
      resetsAt: at("2026-03-11T00:00:00Z"),
    });
    expect(ledger.refusal(run, toolkit, now)?.kind).toBe("agent");
    // The member who started it, and another shared agent, are untouched.
    expect(ledger.gate({ memberId: "m1" }, now)).toBeUndefined();
    expect(ledger.gate({ agentId: "agent-2" }, now)).toBeUndefined();
  });
});
