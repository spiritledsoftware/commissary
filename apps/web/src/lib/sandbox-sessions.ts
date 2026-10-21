// The sandbox toolkit's open sessions on its page (#225, ADR 0041): what the Open sessions section says of each. Pure:
// no DOM, tested in test/sandbox-sessions.test.ts. The server decides who sees a session (a member their own, an org
// admin the org's), whose it is (`own`) and what it says of itself; these functions only word, order and gate what it
// answered. A session's files are never shown: the server has no read of them.
import {
  SANDBOX_SESSIONS_LISTED,
  type SandboxSessionComputer,
  type SandboxSessionView,
} from "@commissary/contract/sandbox-sessions";
import type { SandboxNetwork } from "@commissary/contract/tools";
import { openedText, openerText, ownerText } from "./browser-sessions.ts";

/** A session's network, as a cell reads it: "None", "The internet", "example.com, *.example.com", "3 hosts". */
export const sessionNetworkText = (network: SandboxNetwork | undefined): string => {
  if (network === undefined) return "Not known";

  if (network.kind === "none") return "None";

  if (network.kind === "open") return "The internet";

  const registries = network.presets?.includes("package_registries") === true;

  if (network.hosts.length === 0) return registries ? "The package registries" : "None";

  const named =
    network.hosts.length <= 2 ? network.hosts.join(", ") : `${network.hosts.length} hosts`;

  return registries ? `${named} and the package registries` : named;
};

const COMPUTER: Readonly<Record<SandboxSessionComputer, string>> = {
  off: "Not allowed",
  stopped: "Not running",
  running: "Running",
};

/** Where a session's computer stands, as a cell reads it. */
export const sessionComputerText = (computer: SandboxSessionComputer | undefined): string =>
  computer === undefined ? "Not known" : COMPUTER[computer];

/** A row of the Open sessions table. */
export interface SandboxSessionRow {
  readonly session: SandboxSessionView;
  readonly owner: string;
  /** How it was opened: "Signed in", "With an API key", "By an agent run". */
  readonly how: string;
  /** When it opened: "12 min ago". */
  readonly opened: string;
  readonly network: string;
  readonly computer: string;
}

export const sessionRow = (session: SandboxSessionView, now: number): SandboxSessionRow => {
  const how = openerText(session.opened_by);

  return {
    session,
    owner: ownerText(session),
    how: `${how.charAt(0).toUpperCase()}${how.slice(1)}`,
    opened: openedText(session, now),
    network: sessionNetworkText(session.network),
    computer: sessionComputerText(session.computer),
  };
};

/** The sessions in the page's order: the caller's own first, then the others; each part oldest first, as the server lists. */
export const sortSessions = (
  sessions: ReadonlyArray<SandboxSessionView>,
): ReadonlyArray<SandboxSessionView> =>
  sessions
    .map((session, index) => ({ session, index }))
    .toSorted((a, b) => Number(b.session.own) - Number(a.session.own) || a.index - b.index)
    .map(({ session }) => session);

/** What the section says above its list. */
export const sessionsIntroText = (admin: boolean): string =>
  admin
    ? "The toolkit's open sessions in the org. You may end any of them; no file of a session is shown to anyone."
    : "Your open sessions of the sandbox toolkit. You may end any of them; no file of a session is shown here.";

/** What the list says when more sessions are open than it holds. */
export const TRUNCATED_TEXT = `Showing the oldest ${SANDBOX_SESSIONS_LISTED} sessions.`;

/** The section's sentence when nothing is open. */
export const emptySessionsText = (admin: boolean): string =>
  admin
    ? "No sandbox session is open in the org. A client opens one with sandbox_open, and a hosted agent's run with a sandbox opens its own; one closes with sandbox_close, or after a day without a call."
    : "You have no open sandbox session. A client opens one with sandbox_open; it closes with sandbox_close, or after a day without a call.";

/** The confirmation before ending a session: whose it is, and what follows. */
export const endConfirmText = (session: Pick<SandboxSessionView, "own" | "member">): string =>
  `${session.own ? "Your" : `${ownerText(session)}'s`} sandbox closes and its files are deleted at once, with no way back. Its computer, if one runs, stops and its time is charged. Its client's next call answers that no such session is open.`;

/** What a refused end says, by the server's error code. */
export const endProblem = (error: string | undefined, message: string): string => {
  switch (error) {
    case "not_found":
      return "The session has closed already.";
    case "sandbox_failed":
      return "The sandbox could not be reached to end it. The session is still open: try again in a moment.";
    default:
      return message;
  }
};

/** The label of a row's End button, for a screen reader: whose session, and when it opened. */
export const endLabel = (row: Pick<SandboxSessionRow, "session" | "owner" | "opened">): string =>
  `End ${row.session.own ? "your" : `${row.owner}'s`} session opened ${row.opened}`;
