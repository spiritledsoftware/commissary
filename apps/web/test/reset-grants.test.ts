// The panel's wording of Claude reset grants (src/lib/reset-grants.ts).
import { describe, expect, it } from "vite-plus/test";
import type { ResetGrant, ResetGrantStatus } from "@commissary/contract/credentials";
import {
  attemptNotice,
  grantLines,
  resetsBrief,
  resetsView,
  unansweredWarning,
  windowList,
} from "../src/lib/reset-grants.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");

const day = 86_400_000;

const grant = (id: string, extra: Partial<ResetGrant> = {}): ResetGrant => ({
  id,
  label: "",
  resets_total: 3,
  resets_left: 2,
  starts_at: new Date(NOW - 10 * day).toISOString(),
  ends_at: new Date(NOW + 19 * day).toISOString(),
  clears: ["five_hour", "seven_day"],
  paused: false,
  usable_now: true,
  use_requires_limit: false,
  ...extra,
});

const status = (extra: Partial<ResetGrantStatus> = {}): ResetGrantStatus => ({
  checked_at: new Date(NOW).toISOString(),
  eligible: true,
  at_limit: true,
  grants: [grant("g1")],
  claimable: "g1",
  ...extra,
});

/** A status read when nothing was claimable, for `reason`. */
const blocked = (
  reason: NonNullable<ResetGrantStatus["blocked_by"]>,
  extra: Partial<ResetGrantStatus> = {},
): ResetGrantStatus => {
  const { claimable: _claimable, ...rest } = status(extra);

  return { ...rest, blocked_by: reason };
};

describe("windowList", () => {
  it("names the windows a reset empties", () => {
    expect(windowList(["five_hour", "seven_day"])).toBe("the 5-hour and weekly windows");
    expect(windowList(["five_hour"])).toBe("the 5-hour window");
    expect(windowList(["five_hour", "seven_day", "seven_day_overage_included"])).toBe(
      "the 5-hour, weekly and weekly with overage windows",
    );
    expect(windowList([])).toBe("the usage windows");
    // Ids without a name are never shown raw.
    expect(windowList(["five_hour", "seven_day_x"])).toBe("the 5-hour window and another window");
    expect(windowList(["five_hour", "a_b", "c_d"])).toBe("the 5-hour window and 2 other windows");
    expect(windowList(["seven_day_x"])).toBe("a usage window");
    expect(windowList(["a_b", "c_d"])).toBe("2 usage windows");
  });
});

describe("resetsView", () => {
  it("counts the resets usable now and says what using one does", () => {
    const view = resetsView(
      status({
        grants: [
          grant("g1"),
          grant("g2", { resets_left: 1, label: "Bonus" }),
          grant("old", { ends_at: new Date(NOW - day).toISOString() }),
        ],
      }),
      NOW,
    );

    expect(view).toMatchObject({
      left: 3,
      headline: "3 resets left",
      detail: "Using one empties the 5-hour and weekly windows at Anthropic. It cannot be undone.",
      readiness: "ready",
    });
    expect(view.lines.map((line) => [line.name, line.left, line.holdup, line.next])).toEqual([
      ["Grant 1", "2 of 3 left", undefined, true],
      ["Bonus", "1 of 3 left", undefined, false],
      ["Grant 3", "2 of 3 left", "Expired", false],
    ]);
    expect(view.lines[0]?.when).toBe("Expires Oct 30, 2026, in 19 d");
  });

  it("blocks when not offered, used up or in Anthropic's cooldown", () => {
    expect(resetsView(status({ eligible: false, ineligible_reason: "tier" }), NOW)).toMatchObject({
      headline: "Not offered",
      detail: "Anthropic does not offer resets to this account: the plan does not include them.",
      readiness: "blocked",
    });
    expect(resetsView(status({ eligible: false, ineligible_reason: "unknown" }), NOW).detail).toBe(
      "Anthropic does not offer resets to this account.",
    );

    const later = new Date(NOW + 2 * day).toISOString();

    const usedUp = resetsView(
      blocked("none_left", {
        grants: [grant("g1", { resets_left: 0 }), grant("g2", { starts_at: later })],
      }),
      NOW,
    );

    expect(usedUp).toMatchObject({ left: 0, headline: "No resets left", readiness: "blocked" });
    expect(usedUp.detail).toBe(
      "Every grant is used up or expired. The next one starts Oct 13, 2026.",
    );
    expect(usedUp.lines.map((line) => line.holdup)).toEqual(["Used up", "Not started"]);

    const cooling = resetsView(
      blocked("cooldown", { cooldown_until: new Date(NOW + 3 * 3_600_000).toISOString() }),
      NOW,
    );

    expect(cooling.readiness).toBe("blocked");
    expect(cooling.detail).toMatch(/^Anthropic allows the next reset in 3 h, /);

    // Once the cooldown has passed the server may allow one: worth asking.
    expect(
      resetsView(status({ cooldown_until: new Date(NOW - 1).toISOString() }), NOW).readiness,
    ).toBe("ready");
  });

  it("lets the operator ask when the last read said no but that can change", () => {
    const view = resetsView(
      blocked("not_limited", {
        at_limit: false,
        grants: [grant("g1", { use_requires_limit: true })],
      }),
      NOW,
    );

    expect(view).toMatchObject({ readiness: "maybe", headline: "2 resets left" });
    expect(view.detail).toContain("only once the account reaches a limit");
    expect(view.lines[0]?.holdup).toBe("Only at a limit");

    expect(
      resetsView(blocked("unusable", { grants: [grant("g1", { paused: true })] }), NOW),
    ).toMatchObject({ readiness: "maybe", detail: expect.stringContaining("paused") });
  });
});

describe("resetsView in context", () => {
  it("hedges the count and names no next grant while an unanswered attempt can be tried again", () => {
    const view = resetsView(status({ grants: [grant("g1", { resets_left: 3 })] }), NOW, {
      unanswered: true,
    });

    expect(view.headline).toBe("3 resets left, or 2 if the last attempt went through");
    expect(view.lines.some((line) => line.next)).toBe(false);
    expect(
      resetsView(status({ grants: [grant("g1", { resets_left: 1 })] }), NOW, { unanswered: true })
        .headline,
    ).toBe("1 reset left, or none if the last attempt went through");
  });

  it("blocks while another tab uses a reset, and says when the limits were emptied", () => {
    expect(resetsView(status(), NOW, { inFlight: true })).toMatchObject({
      readiness: "blocked",
      detail: "A reset is being used from another tab right now. Check resets in a minute.",
    });

    // The headline and the button follow the status read after the reset.
    const after = resetsView(
      blocked("cooldown", { cooldown_until: new Date(NOW + 3_600_000).toISOString() }),
      NOW,
      { emptiedAt: NOW - 60_000 },
    );

    expect(after).toMatchObject({ readiness: "blocked", detail: "Limits emptied at 11:59 AM." });
  });
});

describe("grantLines", () => {
  it("orders live grants first, each group by end date", () => {
    const { ends_at: _ends, ...openEnded } = grant("open");

    const lines = grantLines(
      status({
        grants: [
          grant("late", { ends_at: new Date(NOW + 40 * day).toISOString() }),
          grant("gone", { resets_left: 0 }),
          grant("soon", { ends_at: new Date(NOW + 2 * day).toISOString() }),
          openEnded,
        ],
      }),
      NOW,
    );

    expect(lines.map((line) => line.id)).toEqual(["soon", "late", "open", "gone"]);
    expect(lines[2]?.when).toBe("No end date given");
  });
});

describe("attemptNotice", () => {
  it("says whether anything was spent", () => {
    expect(attemptNotice({ outcome: "reset", retried: false, cooldownCleared: true })).toEqual({
      tone: "done",
      text: "Reset used. Anthropic emptied the limits. Commissary cleared its cooldowns too.",
    });
    expect(
      attemptNotice({ outcome: "already_used", retried: true, cooldownCleared: false }).tone,
    ).toBe("done");
    expect(
      attemptNotice({ outcome: "already_used", retried: false, cooldownCleared: false }).tone,
    ).toBe("held");

    for (const outcome of [
      "not_limited",
      "cooldown",
      "ineligible",
      "unavailable",
      "rate_limited",
    ] as const) {
      const notice = attemptNotice({ outcome, retried: false, cooldownCleared: false });

      expect(notice.tone, outcome).toBe("held");
      expect(notice.text, outcome).toMatch(/^Nothing was spent: /);
    }

    expect(
      attemptNotice({ outcome: "not_confirmed", retried: true, cooldownCleared: false }),
    ).toEqual({
      tone: "problem",
      text: "The last attempt is unconfirmed: the account is still limited. Check resets to see whether it went through.",
    });
  });

  it("warns about an unanswered attempt, or an unconfirmed one, until it lapses", () => {
    const until = Date.parse("2026-10-11T16:24:00");

    expect(unansweredWarning(until, false)).toBe(
      "Anthropic did not answer the last attempt, so a reset may have been spent. Trying again before Sun 4:24 PM sends the same request, which cannot spend another.",
    );
    expect(unansweredWarning(until, true)).toBe(
      "The last attempt is unconfirmed: the account is still limited. Trying again before Sun 4:24 PM sends the same request, which cannot spend another reset.",
    );

    expect(
      attemptNotice({ outcome: "auth_error", retried: false, cooldownCleared: false }).tone,
    ).toBe("problem");
    expect(
      attemptNotice({
        outcome: "none_available",
        retried: false,
        cooldownCleared: false,
        blocked: "Every grant is used up or expired.",
      }).text,
    ).toBe("Nothing was spent: Every grant is used up or expired.");

    const unknown = attemptNotice({
      outcome: "unknown",
      retried: false,
      cooldownCleared: false,
      retryUntil: NOW + 600_000,
    });

    expect(unknown.tone).toBe("problem");
    expect(unknown.text).toContain("a reset may have been spent. Try again before");
    expect(unknown.text).toContain("cannot spend a second reset");

    // The operator never reads "claim".
    for (const outcome of ["reset", "already_used", "unknown", "none_available"] as const)
      for (const retried of [false, true])
        expect(
          attemptNotice({ outcome, retried, cooldownCleared: true, retryUntil: NOW }).text,
        ).not.toMatch(/claim/i);
  });
});

describe("resetsBrief", () => {
  it("is the list's short line, only with resets left", () => {
    expect(resetsBrief(status({ at_limit: false }), NOW)).toEqual({
      text: "2 resets left",
      tone: "quiet",
    });
    expect(
      resetsBrief(blocked("cooldown", { grants: [grant("g1", { resets_left: 1 })] }), NOW),
    ).toEqual({ text: "1 reset left", tone: "quiet" });
    // At a limit with one usable now: worth acting on.
    expect(resetsBrief(status({ grants: [grant("g1", { resets_left: 3 })] }), NOW)).toEqual({
      text: "3 resets left, one usable now",
      tone: "ink",
    });
    expect(resetsBrief(status({ grants: [grant("g1", { resets_left: 0 })] }), NOW)).toBeUndefined();
    expect(resetsBrief(status({ eligible: false }), NOW)).toBeUndefined();
    expect(resetsBrief(undefined, NOW)).toBeUndefined();
  });
});
