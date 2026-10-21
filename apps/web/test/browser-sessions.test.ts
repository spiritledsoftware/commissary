import { describe, expect, it } from "vitest";
import type { BrowserSessionView } from "@commissary/contract/browser-sessions";
import {
  aboutText,
  BROWSER_SESSIONS_PAGE,
  emptySessionsText,
  endConfirmText,
  endProblem,
  handoffWaitsText,
  liveViewProblem,
  notWatchableText,
  openedHowText,
  profileText,
  sessionRow,
  sessionTitle,
  sortSessions,
} from "../src/lib/browser-sessions.ts";
import { pageAllowed } from "../src/lib/role.ts";

const NOW = Date.parse("2026-10-11T10:30:00.000Z");

const session = (id: string, extra: Partial<BrowserSessionView> = {}): BrowserSessionView => ({
  id,
  opened_at: "2026-10-11T10:18:00.000Z",
  member: { member_id: "m-alice", email: "alice@example.com" },
  opened_by: "api_key",
  own: true,
  watchable: true,
  profile: null,
  handoff: null,
  ...extra,
});

describe("the Browser sessions pages", () => {
  it("are opened by every member", () => {
    expect(pageAllowed("member", BROWSER_SESSIONS_PAGE)).toBe(true);
    expect(pageAllowed("member", `${BROWSER_SESSIONS_PAGE}/abc`)).toBe(true);
  });
});

describe("the Browser sessions list", () => {
  it("puts the sessions waiting for the caller first, then their own, then the other members', each oldest first", () => {
    const sessions = [
      session("other-old", {
        own: false,
        watchable: false,
        member: { member_id: "m-bob", email: "bob@example.com" },
      }),
      session("own-old"),
      session("own-waiting", { handoff: { until: "2026-10-11T10:50:00.000Z" } }),
      session("agent", { own: false, watchable: false, member: null, opened_by: "agent_run" }),
      session("own-new"),
    ];

    expect(sortSessions(sessions).map((each) => each.id)).toEqual([
      "own-waiting",
      "own-old",
      "own-new",
      "other-old",
      "agent",
    ]);
  });

  it("words each row: whose, how it opened and from which profile, when, and the handoff that waits", () => {
    expect(sessionRow(session("a"), NOW)).toMatchObject({
      owner: "You",
      about: "With an API key",
      opened: "12 min ago",
      handoff: undefined,
    });

    expect(
      sessionRow(
        session("b", {
          own: false,
          watchable: false,
          member: { member_id: "m-bob" },
          opened_by: "person",
          profile: { id: "p1", private: false, name: "marketing" },
        }),
        NOW,
      ),
    ).toMatchObject({ owner: "m-bob", about: "Signed in · Profile: marketing" });

    expect(
      sessionRow(session("c", { handoff: { until: "2026-10-11T10:54:00.000Z" } }), NOW).handoff,
    ).toBe("Waits for you · 24 min left");
    expect(
      sessionRow(session("d", { handoff: { until: "2026-10-11T10:29:00.000Z" } }), NOW).handoff,
    ).toBe("Waits for you · Its time is up");

    // An org admin's view of a shared agent's session, and of another member's private profile.
    expect(
      sessionRow(
        session("e", {
          own: false,
          watchable: false,
          member: null,
          opened_by: "agent_run",
          profile: { id: "p2", private: true },
        }),
        NOW,
      ),
    ).toMatchObject({
      owner: "A shared agent",
      about: "By an agent run · Profile: A member's private profile",
    });
  });

  it("says what opens a session when none is open", () => {
    expect(emptySessionsText(false)).toContain("You have no open browser session");
    expect(emptySessionsText(true)).toContain("No browser session is open in the org");
    expect(emptySessionsText(true)).toContain("browser_open");
  });
});

describe("a session's page", () => {
  it("is titled by whose session it is, with when, how and which profile", () => {
    expect(sessionTitle(session("a"))).toBe("Your browser session");
    expect(
      sessionTitle(
        session("b", {
          own: false,
          watchable: false,
          member: { member_id: "m-bob", email: "b@x.io" },
        }),
      ),
    ).toBe("Browser session of b@x.io");
    expect(openedHowText(session("a", { opened_by: "person" }), NOW)).toBe("12 min ago, signed in");
    expect(profileText(null)).toBe("None");
    expect(aboutText(session("a", { opened_by: "agent_run" }))).toBe("By an agent run");
  });

  it("shows a Live View only for the caller's own session; an org admin is told they may only end another's", () => {
    expect(notWatchableText(session("a"))).toBeUndefined();
    expect(
      notWatchableText(
        session("b", {
          own: false,
          watchable: false,
          member: { member_id: "m-bob", email: "bob@example.com" },
        }),
      ),
    ).toBe("Only bob@example.com may watch this session or answer its handoffs. You may end it.");
    expect(
      notWatchableText(session("c", { own: false, watchable: false, member: null })),
    ).toContain("You may end it");

    // Watching follows `watchable`, the wording `own`: a session the caller watches without being its member.
    const watched = session("d", { own: false, watchable: true, member: null });

    expect(notWatchableText(watched)).toBeUndefined();
    expect(sessionTitle(watched)).toBe("Browser session of A shared agent");
    expect(sortSessions([session("e", { own: false, watchable: false }), watched])[0]).toBe(
      watched,
    );
  });

  it("tells until when a handoff waits, and when its time is up", () => {
    expect(handoffWaitsText({ until: "2026-10-11T10:54:00.000Z" }, NOW)).toMatch(
      /^It waits until .+ \(24 min left\)\.$/,
    );
    expect(handoffWaitsText({ until: "2026-10-11T10:30:00.000Z" }, NOW)).toContain("timed out");
  });

  it("words a refused Live View by the server's code", () => {
    expect(liveViewProblem("not_found", "x")).toBe(
      "This session has closed, or it is not yours to watch.",
    );
    expect(liveViewProblem("forbidden", "x")).toBe("Only the session's member may watch it.");
    expect(liveViewProblem("browser_failed", "x")).toContain("Try again");
    expect(liveViewProblem(undefined, "The network is down.")).toBe("The network is down.");
  });
});

describe("ending a session", () => {
  it("is confirmed with whose browser closes and what its client meets next", () => {
    expect(endConfirmText(session("a"))).toMatch(/^Your browser closes/);
    expect(
      endConfirmText(
        session("b", {
          own: false,
          watchable: false,
          member: { member_id: "m-bob", email: "bob@example.com" },
        }),
      ),
    ).toMatch(/^bob@example.com's browser closes/);
    expect(endConfirmText(session("a"))).toContain(
      "one waiting on a handoff, answer that the session is closed",
    );
  });

  it("words a refusal: a session that closed meanwhile, else the server's message", () => {
    expect(endProblem("not_found", "x")).toBe("The session has closed already.");
    expect(endProblem("forbidden", "Not yours.")).toBe("Not yours.");
  });
});
