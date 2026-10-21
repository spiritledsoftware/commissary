/**
 * The open browser sessions of the browser toolkit (`/v9/management/browser-sessions`,
 * `packages/tools/src/management/browser-session-routes.ts`; ADR 0039, ADR 0044, #216): what the panel's Browser sessions
 * page lists, a session's page with its Live View, and ending a session. Shared with the browser: imports `effect` and
 * `./errors.ts` only.
 *
 * - A member sees their own sessions (opened with any of their API keys, or signed in), with the handoff that waits
 *   for them, and may watch each one (its Live View) and end it.
 * - An org admin also sees the org's other sessions: whose each is, when it opened and its browser profile, and may end
 *   any of them, but never watch one: only the session's member gets its Live View.
 * - A Live View link is a bearer link to the session's browser, minted on demand for its member only, which starts a
 *   connection only within 60 seconds (Browser Run's shortest). It is shown in the panel only: no tool result, log line
 *   or other route carries it.
 * - Ending a session closes it as `browser_close` would: later calls of its tools answer that it is closed.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/** Who opened a session: a member, and their email when the org has it. */
export const BrowserSessionMember = Schema.Struct({
  member_id: Schema.String,
  email: optional(Schema.String),
});

export type BrowserSessionMember = typeof BrowserSessionMember.Type;

/** The browser profile a session opened from (#215): its name, unless it is another member's private profile. */
export const BrowserSessionProfile = Schema.Struct({
  id: Schema.String,
  name: optional(Schema.String),
  private: Schema.Boolean,
});

export type BrowserSessionProfile = typeof BrowserSessionProfile.Type;

/** A handoff that waits for the session's member: until when, and, on the session's own page, what they are asked. */
export const BrowserSessionHandoff = Schema.Struct({
  until: Schema.String,
  reason: optional(Schema.String),
});

export type BrowserSessionHandoff = typeof BrowserSessionHandoff.Type;

/** How a session was opened: with an API key, by a person signed in (through Access), or by a hosted agent's run. */
export const BrowserSessionOpener = Schema.Literals(["api_key", "person", "agent_run"]);

export type BrowserSessionOpener = typeof BrowserSessionOpener.Type;

export const BrowserSessionView = Schema.Struct({
  id: Schema.String,
  opened_at: Schema.String,
  /** Its member; `null` for a shared agent's run, which opened it as the agent. */
  member: Schema.NullOr(BrowserSessionMember),
  opened_by: BrowserSessionOpener,
  /** The caller's own session: they are its member. */
  own: Schema.Boolean,
  /**
   * The caller may watch it: open its Live View and answer its handoff (today its member alone; an agent run's watchers
   * with #232). An org admin's view of another member's session is `false`: they may only end it.
   */
  watchable: Schema.Boolean,
  profile: Schema.NullOr(BrowserSessionProfile),
  /** The handoff that waits for the caller, in a session they may watch only; `null` otherwise. */
  handoff: Schema.NullOr(BrowserSessionHandoff),
});

export type BrowserSessionView = typeof BrowserSessionView.Type;

/** `GET /browser-sessions`: the caller's open sessions, and for an org admin the org's others too, oldest first. */
export const BrowserSessionsList = Schema.Struct({ sessions: Schema.Array(BrowserSessionView) });

export type BrowserSessionsList = typeof BrowserSessionsList.Type;

/** `POST /browser-sessions/:id/live-view`: a Live View link of the session's current tab, and until when it connects. */
export const BrowserLiveView = Schema.Struct({ url: Schema.String, expires_at: Schema.String });

export type BrowserLiveView = typeof BrowserLiveView.Type;

export const EndedBrowserSession = Schema.Struct({
  id: Schema.String,
  ended: Schema.Literal(true),
});

export type EndedBrowserSession = typeof EndedBrowserSession.Type;

const idParam = { params: { id: Schema.String } };

export class BrowserSessionsGroup extends HttpApiGroup.make("browserSessions").add(
  HttpApiEndpoint.get("list", "/browser-sessions", {
    success: BrowserSessionsList,
    error: managementErrors,
  }),
  /** `404 not_found` for a session the caller may not see, or that is closed. */
  HttpApiEndpoint.get("get", "/browser-sessions/:id", {
    ...idParam,
    success: BrowserSessionView,
    error: managementErrors,
  }),
  /**
   * Mints a Live View link (`Cache-Control: no-store`). `403 forbidden` for an org admin's view of another member's
   * session, `404 not_found` for one the caller may not see, `502` when the browser provider could not mint one.
   */
  HttpApiEndpoint.post("liveView", "/browser-sessions/:id/live-view", {
    ...idParam,
    success: BrowserLiveView,
    error: managementErrors,
  }),
  /** Ends the session: its member's, or any for an org admin. */
  HttpApiEndpoint.delete("end", "/browser-sessions/:id", {
    ...idParam,
    success: EndedBrowserSession,
    error: managementErrors,
  }),
) {}
