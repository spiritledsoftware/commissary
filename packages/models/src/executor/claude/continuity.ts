/**
 * Claude continuity store: per (credential, session) previous message/request ids and prompt id.
 *
 * Go source: internal/runtime/executor/helps/claude_diagnostics.go (BeginClaudeContinuity, CommitClaudeContinuity;
 * TTL 1 h sliding, at most 4096 entries). Go keeps it in process memory; here it lives in the `SessionState` Durable
 * Object (one instance per session key hash, shared across isolates) behind a small interface with a per-isolate
 * in-memory fallback. A turn costs one read (which slides the TTL), one write when the prompt id changed, and one
 * compare-and-swap write at commit (the generation is carried in {@link ContinuityState}). The session's pinned
 * `currentDate` is not part of it: it must outlive this 1 h entry and a credential switch, so it has a store of its
 * own (`date-pin.ts`).
 */
import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { isJsonObject, type Json, tryParseJson } from "@commissary/json";
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

const TTL_MS = 60 * 60 * 1000;

const STORE_NAME = "claude-continuity";

const ENTRY_KEY = "state";

export interface ContinuityState {
  readonly key: string;
  readonly previousMessageId: string;
  readonly previousRequestId: string;
  readonly promptId: string;
  /** Compare-and-swap token of the stored entry (0 when it could not be stored). */
  readonly generation: number;
}

export interface ContinuityStore {
  /** Starts a request of a session: returns the stored previous ids and the active prompt id. */
  readonly begin: (
    credentialIdentity: string,
    sessionId: string,
    isNewPromptTurn: boolean,
    explicitPromptId: string,
  ) => Effect.Effect<ContinuityState | undefined>;
  /** Records a completed response. */
  readonly commit: (
    state: ContinuityState,
    messageId: string,
    requestId: string,
    promptId: string,
  ) => Effect.Effect<void>;
}

interface Entry {
  previousMessageId: string;
  previousRequestId: string;
  promptId: string;
}

const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REQUEST_ID = /^req_[A-Za-z0-9_-]{1,36}$/;

export const isValidPromptId = (id: string): boolean => PROMPT_ID.test(id.trim());

/** `ClaudeDeterministicPromptID`: a v4-shaped UUID derived from a seed. */
export const deterministicPromptId = (seed: string): string => {
  const digest = createHash("sha256").update(seed).digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const emptyEntry = (): Entry => ({
  previousMessageId: "",
  previousRequestId: "",
  promptId: "",
});

const parseEntry = (text: string | undefined): Entry | undefined => {
  if (text === undefined) return undefined;

  try {
    const parsed = tryParseJson(text);

    if (parsed === undefined || parsed === null || typeof parsed !== "object") return undefined;
    const record = isJsonObject(parsed) ? parsed : {};
    const field = (value: Json | undefined): string => (typeof value === "string" ? value : "");

    return {
      previousMessageId: field(record.previousMessageId),
      previousRequestId: field(record.previousRequestId),
      promptId: field(record.promptId),
    };
  } catch {
    return undefined;
  }
};

const addressOf = (key: string): SessionAddress => ({ store: STORE_NAME, scope: "", session: key });

const stateOf = (key: string, entry: Entry, generation: number): ContinuityState => ({
  key,
  ...entry,
  generation,
});

/** Store over the `SessionState` backend of the current request (Durable Object, or the per-isolate fallback). */
export const makeSessionStateContinuityStore = (
  backend: BackendResolver = resolveBackend(),
): ContinuityStore => ({
  begin: (credentialIdentity, sessionId, isNewPromptTurn, explicitPromptId) => {
    const identity = credentialIdentity.trim();
    const session = sessionId.trim();

    if (identity === "" || session === "") return Effect.succeed(undefined);
    const key = createHash("sha256").update(`${identity}\u0000${session}`).digest("hex");
    const explicit = explicitPromptId.trim();

    return bestEffort(
      "claude continuity begin",
      // The backend is unreachable: continue without stored history (previous ids empty, new prompt id).
      stateOf(
        key,
        {
          ...emptyEntry(),
          promptId:
            explicit !== "" && isValidPromptId(explicit) ? explicit.toLowerCase() : randomUUID(),
        },
        0,
      ),
      Effect.gen(function* () {
        const state = yield* backend;
        let next = emptyEntry();

        const outcome = yield* updateEntry(
          state,
          addressOf(key),
          ENTRY_KEY,
          { ttlMs: TTL_MS, maxEntries: 1, slideTtl: true },
          (current) => {
            const stored = parseEntry(current);
            const entry: Entry = { ...(stored ?? emptyEntry()) };

            if (explicit !== "" && isValidPromptId(explicit))
              entry.promptId = explicit.toLowerCase();
            else if (isNewPromptTurn || entry.promptId === "") entry.promptId = randomUUID();

            next = entry;
            const unchanged = stored !== undefined && stored.promptId === entry.promptId;

            return unchanged ? keepValue : putValue(JSON.stringify(entry));
          },
        );

        return stateOf(key, next, outcome.generation);
      }),
    );
  },
  commit: (state, messageId, requestId, promptId) => {
    const id = messageId.trim();

    if (id === "") return Effect.void;

    return bestEffort(
      "claude continuity commit",
      undefined,
      Effect.gen(function* () {
        const backendState = yield* backend;

        const known: Entry = {
          previousMessageId: state.previousMessageId,
          previousRequestId: state.previousRequestId,
          promptId: state.promptId,
        };

        yield* updateEntry(
          backendState,
          addressOf(state.key),
          ENTRY_KEY,
          {
            ttlMs: TTL_MS,
            maxEntries: 1,
            known: {
              generation: state.generation,
              value: state.generation === 0 ? undefined : JSON.stringify(known),
            },
          },
          (current) => {
            // An expired or never stored session is not resurrected by a commit.
            const stored = parseEntry(current);

            if (stored === undefined) return keepValue;
            stored.previousMessageId = id;
            stored.previousRequestId = REQUEST_ID.test(requestId.trim()) ? requestId.trim() : "";

            if (isValidPromptId(promptId)) stored.promptId = promptId.toLowerCase();

            return putValue(JSON.stringify(stored));
          },
        );
      }),
    );
  },
});

/** In-memory store for tests (`now` is injectable). */
export const makeMemoryContinuityStore = (now?: () => number): ContinuityStore =>
  makeSessionStateContinuityStore(fixedBackend(makeMemoryBackend(now)));
