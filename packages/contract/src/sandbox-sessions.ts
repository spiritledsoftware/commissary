/**
 * The open sandbox sessions of the sandbox toolkit (`/v9/management/sandbox-sessions`,
 * `packages/tools/src/management/sandbox-session-routes.ts`; ADR 0041, #225): what the sandbox toolkit's page in the panel
 * lists, and ending a session. Imports `effect`, `./errors.ts`, `./tools.ts` and the browser sessions' member and opener
 * (`./browser-sessions.ts`) only.
 *
 * - A member sees their own sessions (opened with any of their API keys, or signed in): when each opened, its network
 *   and whether its computer runs. They may end any of them.
 * - An org admin also sees the org's other sessions, with the same facts, and may end any of them.
 * - A session's files are never shown: no name, no size, no content, to anyone. There is no route to read one.
 * - Ending a session closes it as `sandbox_close` would, its files deleted at once and its computer's last stretch
 *   charged to its opener's Spend limits; later calls of its tools answer that no such session is open.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { BrowserSessionMember, BrowserSessionOpener } from "./browser-sessions.ts";
import { managementErrors } from "./errors.ts";
import { SandboxNetwork } from "./tools.ts";

const optional = Schema.optionalKey;

/**
 * Where a session's computer stands: `off` (the session may not use it), `stopped` (it may, and none runs now: a command
 * the shell cannot run starts one) or `running` (it runs now, and is metered).
 */
export const SandboxSessionComputer = Schema.Literals(["off", "stopped", "running"]);

export type SandboxSessionComputer = typeof SandboxSessionComputer.Type;

export const SandboxSessionView = Schema.Struct({
  id: Schema.String,
  opened_at: Schema.String,
  /** Its member; `null` for a shared agent's run, which opened it as the agent. */
  member: Schema.NullOr(BrowserSessionMember),
  opened_by: BrowserSessionOpener,
  /** The caller's own session: they are its member. */
  own: Schema.Boolean,
  /** The network the session opened with, which it keeps; absent when the sandbox could not be asked. */
  network: optional(SandboxNetwork),
  /** Whether its computer runs; absent when the sandbox could not be asked. */
  computer: optional(SandboxSessionComputer),
});

export type SandboxSessionView = typeof SandboxSessionView.Type;

/** How many sessions the list holds at most: the oldest of the caller's view. */
export const SANDBOX_SESSIONS_LISTED = 200;

/** `GET /sandbox-sessions`: the caller's open sessions, and for an org admin the org's others too, oldest first. */
export const SandboxSessionsList = Schema.Struct({
  sessions: Schema.Array(SandboxSessionView),
  /** More sessions are open than the list holds (the oldest `SANDBOX_SESSIONS_LISTED` of the caller's view are listed). */
  truncated: Schema.Boolean,
});

export type SandboxSessionsList = typeof SandboxSessionsList.Type;

export const EndedSandboxSession = Schema.Struct({
  id: Schema.String,
  ended: Schema.Literal(true),
});

export type EndedSandboxSession = typeof EndedSandboxSession.Type;

export class SandboxSessionsGroup extends HttpApiGroup.make("sandboxSessions").add(
  HttpApiEndpoint.get("list", "/sandbox-sessions", {
    success: SandboxSessionsList,
    error: managementErrors,
  }),
  /**
   * Ends the session: its member's, or any for an org admin. `404 not_found` for a session the caller may not see, or
   * that is closed; `502 sandbox_failed` when the sandbox could not be reached (the session stays open: try again).
   */
  HttpApiEndpoint.delete("end", "/sandbox-sessions/:id", {
    params: { id: Schema.String },
    success: EndedSandboxSession,
    error: managementErrors,
  }),
) {}
