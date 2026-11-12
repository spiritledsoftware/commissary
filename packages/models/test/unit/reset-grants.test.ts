// Claude reset grants, the pure parts (src/quota/reset-grants.ts): the status parsing, the grant choice, the claim answers
// and the claim journal. The routes: apps/app/test/reset-grants.test.ts.
import { describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import type { ResetGrantStatus } from "@commissary/contract/credentials";
import type { Json } from "@commissary/json";
import {
  beginClaim,
  CLAIM_LEASE_MS,
  claimAnswer,
  type ClaimJournal,
  claimLanded,
  landedAnswer,
  parseOrganization,
  parseResetGrantStatus,
  pendingClaimJson,
  RETRY_WINDOW_MS,
  selectResetGrant,
  settleClaim,
} from "../../src/quota/reset-grants.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");

const grant = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: "Launch week",
  resets_total: 3,
  resets_left: 2,
  starts_at: "2026-01-01T00:00:00Z",
  ends_at: "2999-01-01T00:00:00Z",
  clears: ["five_hour", "seven_day"],
  paused: false,
  usable_now: true,
  use_requires_limit: false,
  ...extra,
});

const block = (extra: Record<string, unknown> = {}) => ({
  eligible: true,
  at_limit: true,
  weekly_resets_at: "2026-10-14T00:00:00Z",
  grants: [grant("g1")],
  ...extra,
});

const usage = (extra: Record<string, unknown> = {}) => ({
  five_hour: { utilization: 100 },
  cedar_ember: block(extra),
});

const parse = (payload: Json | undefined) => parseResetGrantStatus(payload, NOW);

describe("parseResetGrantStatus", () => {
  it("reads the block and picks the claimable grant", () => {
    const status = parse(
      usage({
        ineligible_reason: "something_new",
        next_grant_id: "g2",
        cooldown_until: "2026-10-11T11:00:00Z",
        grants: [
          grant("g1", {
            label: "  Bonus\u0000\nreset  ",
            clears: ["five_hour", "Bad Id!", "five_hour"],
          }),
          grant("g2", { resets_left: 1 }),
        ],
      }),
    );

    expect(status).toEqual({
      checked_at: new Date(NOW).toISOString(),
      eligible: true,
      ineligible_reason: "unknown",
      at_limit: true,
      cooldown_until: "2026-10-11T11:00:00.000Z",
      weekly_resets_at: "2026-10-14T00:00:00.000Z",
      next_grant_id: "g2",
      grants: [
        expect.objectContaining({ id: "g1", label: "Bonus reset", clears: ["five_hour"] }),
        expect.objectContaining({ id: "g2", resets_left: 1, resets_total: 3 }),
      ],
      claimable: "g2",
    });
  });

  it("fails closed on missing usability flags", () => {
    const status = parse(
      usage({ at_limit: false, grants: [{ id: "g1", resets_total: 1, resets_left: 1 }] }),
    );

    expect(status?.grants[0]).toMatchObject({
      usable_now: false,
      use_requires_limit: true,
      paused: false,
      label: "",
      clears: [],
    });
    expect(status?.blocked_by).toBe("unusable");
  });

  it("rejects the whole block on one malformed grant", () => {
    for (const bad of [
      [grant("g1"), grant("g1")],
      [grant("G 1")],
      [grant("g1", { resets_left: 4 })],
      [grant("g1", { ends_at: "not a date" })],
      [grant("g1", { resets_left: -1 })],
    ]) {
      expect(parse(usage({ grants: bad })), JSON.stringify(bad)).toBeUndefined();
    }

    expect(parse({ cedar_ember: null })).toBeUndefined();
    expect(parse({ five_hour: {} })).toBeUndefined();
    expect(parse(undefined)).toBeUndefined();
  });

  it("drops a next_grant_id that names no grant", () => {
    expect(parse(usage({ next_grant_id: "ghost" }))).not.toHaveProperty("next_grant_id");
  });
});

describe("selectResetGrant", () => {
  const status = (extra: Partial<ResetGrantStatus> = {}) => {
    const parsed = parse(usage());

    if (parsed === undefined) throw new Error("fixture does not parse");

    return { ...parsed, ...extra };
  };

  const one = (extra: Record<string, unknown>) =>
    status({ grants: [parse(usage({ grants: [grant("g1", extra)] }))!.grants[0]!] });

  it("explains every blocker in the panel's order", () => {
    expect(selectResetGrant(status({ eligible: false }), NOW)).toEqual({
      blocked_by: "ineligible",
    });
    expect(selectResetGrant(status({ cooldown_until: "2026-10-11T13:00:00.000Z" }), NOW)).toEqual({
      blocked_by: "cooldown",
    });
    expect(selectResetGrant(one({ resets_left: 0 }), NOW)).toEqual({ blocked_by: "none_left" });
    expect(selectResetGrant(one({ ends_at: "2026-10-01T00:00:00Z" }), NOW)).toEqual({
      blocked_by: "none_left",
    });
    expect(selectResetGrant(one({ starts_at: "2026-12-01T00:00:00Z" }), NOW)).toEqual({
      blocked_by: "none_left",
    });
    expect(selectResetGrant(one({ paused: true }), NOW)).toEqual({ blocked_by: "unusable" });
    expect(
      selectResetGrant({ ...one({ use_requires_limit: true }), at_limit: false }, NOW),
    ).toEqual({ blocked_by: "not_limited" });
  });

  it("prefers next_grant_id, else the lowest usable id", () => {
    const two = parse(
      usage({ grants: [grant("zz"), grant("aa"), grant("mm", { paused: true })] }),
    )!;

    expect(selectResetGrant(two, NOW)).toEqual({ claimable: "aa" });
    expect(selectResetGrant({ ...two, next_grant_id: "zz" }, NOW)).toEqual({ claimable: "zz" });
    expect(selectResetGrant({ ...two, next_grant_id: "mm" }, NOW)).toEqual({ claimable: "aa" });
  });
});

describe("claim answers and organization", () => {
  it("maps statuses and results like the panel", () => {
    expect(claimAnswer(200, { result: "reset" })).toBe("reset");
    expect(claimAnswer(200, { result: "already_used" })).toBe("already_used");
    expect(claimAnswer(200, { result: "surprise" })).toBe("unknown");
    expect(claimAnswer(200, {})).toBe("unknown");
    expect(claimAnswer(429, { result: "reset" })).toBe("rate_limited");
    expect(claimAnswer(401, undefined)).toBe("auth_error");
    expect(claimAnswer(403, undefined)).toBe("auth_error");
    expect(claimAnswer(500, { result: "reset" })).toBe("unknown");
  });

  it("reads only a UUID organization", () => {
    expect(
      parseOrganization({ organization: { uuid: "ABCDEF01-2345-6789-ABCD-EF0123456789" } }),
    ).toBe("abcdef01-2345-6789-abcd-ef0123456789");
    expect(parseOrganization({ organization: { uuid: "../../admin" } })).toBeUndefined();
    expect(parseOrganization({})).toBeUndefined();
  });
});

describe("claim journal", () => {
  const ORG = "abcdef01-2345-6789-abcd-ef0123456789";
  const fresh = { grantId: "g1", requestId: "req-1" };

  const started = (): ClaimJournal => {
    const begun = beginClaim(undefined, { organization: ORG, fresh, current: true }, NOW);

    if (!begun.ok) throw new Error("claim did not start");

    return begun.journal;
  };

  it("blocks a second claim while one is in flight", () => {
    const journal = started();

    expect(beginClaim(journal, { organization: ORG, fresh, current: true }, NOW + 1)).toEqual({
      ok: false,
      error: "busy",
    });
    expect(
      beginClaim(journal, { organization: ORG, fresh, current: true }, NOW + CLAIM_LEASE_MS).ok,
    ).toBe(true);
  });

  it("resends an unanswered claim with the same ids, for the same organization only", () => {
    const open = settleClaim(started(), "req-1", "unknown").journal;

    expect(open).toMatchObject({ in_flight_until: 0, attempts: 1 });

    const retry = beginClaim(
      open,
      { organization: ORG, fresh: { grantId: "g9", requestId: "x" }, current: true },
      NOW + 5,
    );

    expect(retry).toMatchObject({
      ok: true,
      retry: true,
      journal: { grant_id: "g1", request_id: "req-1", attempts: 2 },
    });
    expect(beginClaim(open, { organization: "other", fresh, current: true }, NOW + 5)).toEqual({
      ok: false,
      error: "identity",
    });
  });

  it("starts fresh after the retry window, or answers expired without a fresh claim", () => {
    const open = settleClaim(started(), "req-1", "unknown").journal;
    const later = NOW + RETRY_WINDOW_MS;

    expect(beginClaim(open, { organization: ORG, fresh: undefined, current: true }, later)).toEqual(
      {
        ok: false,
        error: "expired",
      },
    );
    expect(beginClaim(open, { organization: "other", fresh, current: true }, later)).toMatchObject({
      ok: true,
      retry: false,
    });
  });

  it("closes on a definite answer; a resend's refusal keeps it open; already_used on a resend spent", () => {
    expect(settleClaim(started(), "req-1", "reset")).toEqual({ journal: undefined, spent: true });
    expect(settleClaim(started(), "req-1", "not_limited")).toEqual({
      journal: undefined,
      spent: false,
    });
    expect(settleClaim(started(), "req-1", "already_used").spent).toBe(false);

    const open = settleClaim(started(), "req-1", "unknown").journal;

    const resent = beginClaim(
      open,
      { organization: ORG, fresh: undefined, current: true },
      NOW + 5,
    );

    if (!resent.ok) throw new Error("resend refused");
    expect(settleClaim(resent.journal, "req-1", "already_used")).toEqual({
      journal: undefined,
      spent: true,
    });
    expect(settleClaim(resent.journal, "req-1", "rate_limited")).toMatchObject({
      journal: { request_id: "req-1" },
      spent: false,
    });
    // An answer to another request leaves the journal alone.
    expect(settleClaim(resent.journal, "other", "reset").journal).toBe(resent.journal);
  });

  it("refuses a fresh claim decided on a status read before the last claim activity", () => {
    expect(beginClaim(undefined, { organization: ORG, fresh, current: false }, NOW)).toEqual({
      ok: false,
      error: "stale",
    });
    // A resend does not depend on the status.
    const open = settleClaim(started(), "req-1", "unknown").journal;
    expect(beginClaim(open, { organization: ORG, fresh, current: false }, NOW + 5).ok).toBe(true);
  });

  it("tells a resend whose claim was answered meanwhile from one that expired", () => {
    expect(
      beginClaim(undefined, { organization: ORG, fresh: undefined, current: true }, NOW),
    ).toEqual({ ok: false, error: "settled" });
  });

  it("marks a pending claim in flight while a request of it runs", () => {
    const journal = started();
    expect(pendingClaimJson(journal, NOW + 1).in_flight).toBe(true);

    const open = settleClaim(journal, "req-1", "unknown").journal;
    expect(open === undefined ? undefined : pendingClaimJson(open, NOW + 1).in_flight).toBe(false);
  });

  it("sees an unanswered claim land in a later status", () => {
    const journal: ClaimJournal = { ...started(), resets_left: 2 };

    const later = (extra: Record<string, unknown>) => {
      const status = parse(usage(extra));

      if (status === undefined) throw new Error("bad status");

      return status;
    };

    expect(claimLanded(journal, later({ grants: [grant("g1", { resets_left: 1 })] }))).toBe(true);
    expect(claimLanded(journal, later({ grants: [grant("g1")] }))).toBe(false);
    expect(claimLanded(journal, later({ grants: [grant("g2", { resets_left: 0 })] }))).toBe(false);
    expect(
      claimLanded(journal, later({ cooldown_until: new Date(NOW + 60_000).toISOString() })),
    ).toBe(true);
    expect(
      claimLanded(journal, later({ cooldown_until: new Date(NOW - 60_000).toISOString() })),
    ).toBe(false);
    // An older journal without the count only goes by the cooldown.
    expect(claimLanded(started(), later({ grants: [grant("g1", { resets_left: 0 })] }))).toBe(
      false,
    );
    // Landed counts as spent only when the account is no longer at a limit.
    expect(landedAnswer(journal, later({ at_limit: false }))).toBe("already_used");
    expect(landedAnswer(journal, later({ at_limit: true }))).toBe("not_confirmed");
    // Once answered not_confirmed, the next resend sends the request after all.
    expect(landedAnswer({ ...journal, unconfirmed: true }, later({ at_limit: true }))).toBe(
      undefined,
    );
  });

  it("keeps a resend settled as not confirmed open, without counting it spent", () => {
    const open = settleClaim(started(), "req-1", "unknown").journal;

    const resent = beginClaim(
      open,
      { organization: ORG, fresh: undefined, current: true },
      NOW + 5,
    );

    if (!resent.ok) throw new Error("resend refused");
    expect(settleClaim(resent.journal, "req-1", "not_confirmed")).toEqual({
      journal: { ...resent.journal, in_flight_until: 0, unconfirmed: true },
      spent: false,
    });
  });

  it("holds one claim per organization across auth files", () => {
    const inFlight = started();
    const open = settleClaim(started(), "req-1", "unknown").journal;

    if (open === undefined) throw new Error("claim closed");

    const begin = (others: readonly ClaimJournal[], now = NOW + 5) =>
      beginClaim(undefined, { organization: ORG, fresh, current: true, others }, now);

    expect(begin([inFlight])).toEqual({ ok: false, error: "busy" });
    expect(begin([open])).toEqual({ ok: false, error: "busy" });
    expect(begin([{ ...open, organization: "other" }]).ok).toBe(true);
    // An open claim past its retry window no longer holds the organization.
    expect(begin([open], NOW + RETRY_WINDOW_MS).ok).toBe(true);
  });

  it("resends only the claim the caller saw", () => {
    const open = settleClaim(started(), "req-1", "unknown").journal;

    const resend = (requestId: string) =>
      beginClaim(
        open,
        { organization: ORG, fresh: undefined, resend: requestId, current: true },
        NOW + 5,
      );

    expect(resend("req-0")).toEqual({ ok: false, error: "settled" });
    expect(resend("req-1")).toMatchObject({ ok: true, retry: true });
  });
});
