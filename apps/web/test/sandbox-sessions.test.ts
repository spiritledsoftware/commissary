import { describe, expect, it } from "vitest";
import {
  SANDBOX_SESSIONS_LISTED,
  type SandboxSessionView,
} from "@commissary/contract/sandbox-sessions";
import {
  emptySessionsText,
  endConfirmText,
  endLabel,
  endProblem,
  sessionComputerText,
  sessionNetworkText,
  sessionRow,
  sessionsIntroText,
  sortSessions,
  TRUNCATED_TEXT,
} from "../src/lib/sandbox-sessions.ts";

const NOW = Date.parse("2026-10-11T10:30:00.000Z");

const session = (id: string, extra: Partial<SandboxSessionView> = {}): SandboxSessionView => ({
  id,
  opened_at: "2026-10-11T10:18:00.000Z",
  member: { member_id: "m-alice", email: "alice@example.com" },
  opened_by: "api_key",
  own: true,
  network: { kind: "none" },
  computer: "off",
  ...extra,
});

describe("the sandbox toolkit's open sessions list (#225)", () => {
  it("says how many sessions it holds when more are open", () => {
    expect(TRUNCATED_TEXT).toBe(`Showing the oldest ${SANDBOX_SESSIONS_LISTED} sessions.`);
    expect(TRUNCATED_TEXT).toBe("Showing the oldest 200 sessions.");
  });

  it("says when a session opened, how, its network and where its computer stands", () => {
    expect(
      sessionRow(session("a", { network: { kind: "open" }, computer: "running" }), NOW),
    ).toMatchObject({
      owner: "You",
      how: "With an API key",
      opened: "12 min ago",
      network: "The internet",
      computer: "Running",
    });
    expect(
      sessionRow(session("b", { opened_by: "person", computer: "stopped" }), NOW),
    ).toMatchObject({
      how: "Signed in",
      computer: "Not running",
    });
    expect(
      sessionRow(session("c", { opened_by: "agent_run", member: null, own: false }), NOW),
    ).toMatchObject({
      owner: "A shared agent",
      how: "By an agent run",
    });
  });

  it("names another member by their email, else their id", () => {
    const other = { own: false, member: { member_id: "m-bob", email: "bob@example.com" } };

    expect(sessionRow(session("a", other), NOW).owner).toBe("bob@example.com");
    expect(
      sessionRow(session("a", { own: false, member: { member_id: "m-bob" } }), NOW).owner,
    ).toBe("m-bob");
  });

  it("words a network: none, the internet, a short list of hosts, a count, the package registries", () => {
    expect(sessionNetworkText({ kind: "none" })).toBe("None");
    expect(sessionNetworkText({ kind: "open" })).toBe("The internet");
    expect(sessionNetworkText({ kind: "hosts", hosts: ["a.dev", "*.b.dev"] })).toBe(
      "a.dev, *.b.dev",
    );
    expect(sessionNetworkText({ kind: "hosts", hosts: ["a.dev", "b.dev", "c.dev"] })).toBe(
      "3 hosts",
    );
    expect(sessionNetworkText({ kind: "hosts", hosts: [], presets: ["package_registries"] })).toBe(
      "The package registries",
    );
    expect(
      sessionNetworkText({ kind: "hosts", hosts: ["a.dev"], presets: ["package_registries"] }),
    ).toBe("a.dev and the package registries");
  });

  it("says so when the sandbox could not be asked about a session, instead of dropping it", () => {
    const { network: _network, computer: _computer, ...bare } = session("a");
    const unread = sessionRow(bare, NOW);

    expect(unread.network).toBe("Not known");
    expect(unread.computer).toBe("Not known");
    expect(sessionComputerText("off")).toBe("Not allowed");
  });

  it("lists the caller's own sessions first, then the others', each oldest first as the server sends them", () => {
    const sessions = [
      session("other-old", { own: false, member: { member_id: "m-bob" } }),
      session("own-old"),
      session("other-new", { own: false, member: { member_id: "m-bob" } }),
      session("own-new"),
    ];

    expect(sortSessions(sessions).map((each) => each.id)).toEqual([
      "own-old",
      "own-new",
      "other-old",
      "other-new",
    ]);
  });

  it("says a member sees their own and an org admin the org's, and that no file is shown", () => {
    expect(sessionsIntroText(false)).toMatch(/Your open sessions/);
    expect(sessionsIntroText(true)).toMatch(/in the org/);

    for (const admin of [false, true]) expect(sessionsIntroText(admin)).toMatch(/no file/);
    expect(emptySessionsText(false)).toMatch(/You have no open sandbox session/);
    expect(emptySessionsText(true)).toMatch(/in the org/);
  });

  it("asks before ending, naming whose session it is and that its files go at once", () => {
    expect(endConfirmText(session("a"))).toMatch(
      /^Your sandbox closes and its files are deleted at once/,
    );
    expect(
      endConfirmText(
        session("a", { own: false, member: { member_id: "m-bob", email: "bob@example.com" } }),
      ),
    ).toMatch(/^bob@example\.com's sandbox/);
  });

  it("labels each End button with whose session it ends and when it opened", () => {
    expect(endLabel(sessionRow(session("a"), NOW))).toBe("End your session opened 12 min ago");
    expect(
      endLabel(
        sessionRow(
          session("a", { own: false, member: { member_id: "m-bob", email: "bob@example.com" } }),
          NOW,
        ),
      ),
    ).toBe("End bob@example.com's session opened 12 min ago");
  });

  it("says what a refused end means", () => {
    expect(endProblem("not_found", "x")).toBe("The session has closed already.");
    expect(endProblem("sandbox_failed", "x")).toMatch(/still open/);
    expect(endProblem(undefined, "boom")).toBe("boom");
  });
});
