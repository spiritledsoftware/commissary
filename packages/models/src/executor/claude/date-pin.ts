/**
 * Claude session date pin: the `currentDate` of a cloaked session, kept byte-stable for 7 days.
 *
 * Go source: internal/runtime/executor/helps/claude_diagnostics.go (`PinClaudeSessionDate` with a positive retention,
 * `LookupClaudeSessionDatePin`), claude_executor_cloaking.go (`resolveClaudeSessionPinnedDate`). The date sits in the
 * first user message, so a re-anchored date changes the prefix of the whole conversation: Anthropic drops every earlier
 * signed thinking block (`prefix_binding_mismatch`) and the prompt cache misses (CLIProxyAPI #6682). The pin therefore
 * survives a credential switch and an idle gap, which the 1 h continuity entry (keyed by credential) cannot.
 *
 * Differences from Go (ARCHITECTURE.md, "Claude provider"):
 *  - The key is the org, the caller scope and the session, never the credential. Go keys it by session alone, which is
 *    safe on one tenant only: here a member who knows another member's session id could anchor its date.
 *  - The retention is 7 days, with no `session-date-pin-days` setting (the store caps TTLs at 7 days, so a knob could
 *    only shorten the pin or turn it off, and "off" is the bug).
 *  - The 7-day expiry is extended at most once a day instead of on every request: a request is one `SessionState`
 *    round trip while the pin is fresh, and a write happens about once a day per active session.
 */
import { Clock, Effect } from "effect";
import { isJsonObject, tryParseJson } from "@commissary/json";
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  keepValue,
  makeMemoryBackend,
  putValue,
  resolveBackend,
  type SessionAddress,
  updateEntry,
} from "@commissary/state";

const STORE_NAME = "claude-date-pin";

const ENTRY_KEY = "date";

/** How long a pin outlives its last refresh (the store's longest TTL). */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A pin refreshed less than this long ago is not written again. */
const REFRESH_MS = 24 * 60 * 60 * 1000;

export interface DatePinStore {
  /**
   * The session's pinned date. The first request of a session anchors `candidate` (an earlier or concurrent anchor
   * wins); a stored pin is always returned, whatever `candidate` is. A backend failure returns `candidate`.
   */
  readonly resolve: (
    callerScope: string,
    sessionId: string,
    candidate: string,
  ) => Effect.Effect<string>;
}

interface Pin {
  readonly date: string;
  /** When the 7-day expiry was last extended (epoch milliseconds). */
  readonly refreshedAt: number;
}

const parsePin = (text: string | undefined): Pin | undefined => {
  if (text === undefined) return undefined;
  const parsed = tryParseJson(text);

  if (!isJsonObject(parsed)) return undefined;
  const { date, refreshedAt } = parsed;

  return typeof date === "string" && date !== "" && typeof refreshedAt === "number"
    ? { date, refreshedAt }
    : undefined;
};

/** Store over the `SessionState` backend of the current request (Durable Object, or the per-isolate fallback). */
export const makeSessionStateDatePinStore = (
  backend: BackendResolver = resolveBackend(),
  now?: () => number,
): DatePinStore => ({
  resolve: (callerScope, sessionId, candidate) => {
    const session = sessionId.trim();

    if (session === "" || candidate === "") return Effect.succeed(candidate);
    const address: SessionAddress = { store: STORE_NAME, scope: callerScope, session };

    return bestEffort(
      "claude date pin",
      candidate,
      Effect.gen(function* () {
        const state = yield* backend;
        const at = now === undefined ? yield* Clock.currentTimeMillis : now();
        let pinned = candidate;

        yield* updateEntry(
          state,
          address,
          ENTRY_KEY,
          // No `slideTtl`: a read does not move the expiry, so a fresh pin costs one round trip and no write.
          { ttlMs: RETENTION_MS, maxEntries: 1 },
          (current) => {
            const stored = parsePin(current);

            // First anchor; a concurrent first request that wins the compare-and-swap hands over its pin instead.
            if (stored === undefined) {
              pinned = candidate;

              return putValue(JSON.stringify({ date: candidate, refreshedAt: at }));
            }

            pinned = stored.date;

            return at - stored.refreshedAt < REFRESH_MS
              ? keepValue
              : putValue(JSON.stringify({ date: stored.date, refreshedAt: at }));
          },
        );

        return pinned;
      }),
    );
  },
});

/** In-memory store for tests (`now` is injectable). */
export const makeMemoryDatePinStore = (now?: () => number): DatePinStore =>
  makeSessionStateDatePinStore(fixedBackend(makeMemoryBackend(now)), now);
