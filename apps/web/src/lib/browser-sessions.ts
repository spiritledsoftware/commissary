// The browser toolkit's open sessions (#216, ADR 0039): what the Browser sessions page and a session's page say of each.
// Pure: no DOM, tested in test/browser-sessions.test.ts. The server decides who sees a session, whose it is (`own`: the
// caller is its member, which the wording follows) and who may watch it (`watchable`: its Live View and its handoff;
// an org admin's view of another member's session is neither, and they may only end it), and mints each Live View;
// these functions only word, order and gate what it answered.
import type {
  BrowserSessionHandoff,
  BrowserSessionOpener,
  BrowserSessionProfile,
  BrowserSessionView,
} from "@commissary/contract/browser-sessions";
import type { Me } from "@commissary/contract/orgs";
import { formatAgo, formatClock, formatDuration } from "./format.ts";

/** The Browser sessions page's path, under the Tools pages; each session's page is below it. */
export const BROWSER_SESSIONS_PAGE = "/tools/sessions";

/**
 * Whether the panel shows the Browser sessions pages and the links to them: only where the deployment has the browser
 * toolkit (ADR 0043). Elsewhere nothing mentions them.
 */
export const showsBrowserSessions = (me: Pick<Me, "deployment">): boolean => me.deployment.browser;

/** Whose a session is: "You" for the caller's own, else its member's email (or id), or a shared agent's. */
export const ownerText = (session: Pick<BrowserSessionView, "own" | "member">): string => {
  if (session.own) return "You";

  if (session.member === null) return "A shared agent";

  return session.member.email ?? session.member.member_id;
};

const OPENERS: Readonly<Record<BrowserSessionOpener, string>> = {
  api_key: "with an API key",
  person: "signed in",
  agent_run: "by an agent run",
};

/** How a session was opened, as a phrase that follows when: "with an API key", "signed in", "by an agent run". */
export const openerText = (opener: BrowserSessionOpener): string => OPENERS[opener];

/** The browser profile a session opened from; another member's private one is named by what it is, not its name. */
export const profileText = (profile: BrowserSessionProfile | null): string => {
  if (profile === null) return "None";

  return profile.name ?? "A member's private profile";
};

/** When a session opened, relative to `now`: "12 min ago". */
export const openedText = (session: Pick<BrowserSessionView, "opened_at">, now: number): string =>
  formatAgo(Math.max(0, now - Date.parse(session.opened_at)));

/** When and how a session opened, as its page's fact: "12 min ago, with an API key". */
export const openedHowText = (
  session: Pick<BrowserSessionView, "opened_at" | "opened_by">,
  now: number,
): string => `${openedText(session, now)}, ${openerText(session.opened_by)}`;

/** A list row's line under the owner: how the session opened and from which profile. */
export const aboutText = (session: Pick<BrowserSessionView, "opened_by" | "profile">): string => {
  const how = openerText(session.opened_by);
  const opened = `${how.charAt(0).toUpperCase()}${how.slice(1)}`;

  return session.profile === null ? opened : `${opened} · Profile: ${profileText(session.profile)}`;
};

/** The time left to answer a handoff, or that it is up (its end is on its way from the browser). */
export const handoffLeftText = (handoff: BrowserSessionHandoff, now: number): string => {
  const left = Date.parse(handoff.until) - now;

  return left <= 0 ? "Its time is up" : `${formatDuration(left)} left`;
};

/** A handoff in a sentence: until when it waits and how long that is. */
export const handoffWaitsText = (handoff: BrowserSessionHandoff, now: number): string => {
  const until = Date.parse(handoff.until);

  return until <= now
    ? "Its 30 minutes are up: the call is answering that it timed out."
    : `It waits until ${formatClock(until)} (${formatDuration(until - now)} left).`;
};

/** A row of the Browser sessions table. */
export interface SessionRow {
  readonly session: BrowserSessionView;
  readonly owner: string;
  /** How it opened and from which profile, under the owner. */
  readonly about: string;
  /** When it opened: "12 min ago". */
  readonly opened: string;
  /** The handoff waiting for the caller, worded; `undefined` when none waits. */
  readonly handoff: string | undefined;
}

export const sessionRow = (session: BrowserSessionView, now: number): SessionRow => ({
  session,
  owner: ownerText(session),
  about: aboutText(session),
  opened: openedText(session, now),
  handoff:
    session.handoff === null
      ? undefined
      : `Waits for you · ${handoffLeftText(session.handoff, now)}`,
});

const rank = (session: BrowserSessionView): number => {
  if (session.handoff !== null) return 0;

  return session.watchable ? 1 : 2;
};

/**
 * The sessions in the page's order, attention first: those that wait for the caller, then the others they may watch,
 * then the rest (an org admin's view of the other members'); each part oldest first, as the server lists them.
 */
export const sortSessions = (
  sessions: ReadonlyArray<BrowserSessionView>,
): ReadonlyArray<BrowserSessionView> =>
  sessions
    .map((session, index) => ({ session, index }))
    .toSorted((a, b) => rank(a.session) - rank(b.session) || a.index - b.index)
    .map(({ session }) => session);

/** The Browser sessions page's sentence when nothing is open. */
export const emptySessionsText = (admin: boolean): string =>
  admin
    ? "No browser session is open in the org. A client opens one with browser_open; it closes with browser_close, or after 10 minutes without a call."
    : "You have no open browser session. A client opens one with browser_open; it closes with browser_close, or after 10 minutes without a call.";

/** A session page's title: whose session it is. */
export const sessionTitle = (session: Pick<BrowserSessionView, "own" | "member">): string =>
  session.own ? "Your browser session" : `Browser session of ${ownerText(session)}`;

/** Why a session's page shows no Live View (`undefined`: the caller may watch it). */
export const notWatchableText = (
  session: Pick<BrowserSessionView, "own" | "watchable" | "member">,
): string | undefined => {
  if (session.watchable) return undefined;

  return session.member === null
    ? "A shared agent's session is not watched from the panel. You may end it."
    : `Only ${ownerText(session)} may watch this session or answer its handoffs. You may end it.`;
};

/** What a refused Live View says, by the server's error code. */
export const liveViewProblem = (error: string | undefined, message: string): string => {
  switch (error) {
    case "not_found":
      return "This session has closed, or it is not yours to watch.";
    case "forbidden":
      return "Only the session's member may watch it.";
    case "browser_failed":
      return "The browser did not start a Live View. Try again in a moment.";
    default:
      return message;
  }
};

/** What a refused end says, by the server's error code. */
export const endProblem = (error: string | undefined, message: string): string =>
  error === "not_found" ? "The session has closed already." : message;

/** The confirmation before ending a session: whose it is, and what its client meets next. */
export const endConfirmText = (session: Pick<BrowserSessionView, "own" | "member">): string =>
  `${
    session.own ? "Your" : `${ownerText(session)}'s`
  } browser closes, with whatever it had open. Its client's next call, and one waiting on a handoff, answer that the session is closed.`;
