/**
 * Reasoning replay ledger over the `SessionState` Durable Object: Antigravity's, and (Go cc95661c) the Gemini API's and
 * Vertex's, each in its own store (the store name is a parameter).
 *
 * Go source: internal/cache/antigravity_reasoning_replay_cache.go (normalisation, TTL 1 h, snapshot-guarded replace
 * and delete, tombstones). The Go local mode keeps a revision per entry and fences a miss with a tombstone; here the
 * Durable Object generation is the snapshot (`0` = absent), and a delete writes a tombstone entry with a fresh
 * generation so a stale writer that read the older state cannot publish over the delete. Entry bounds (4096 items,
 * 16 MiB) are the Go ones; the 10240-entry cap is replaced by the per-session instance and the TTL sweep.
 */
import { Effect } from "effect";
import { asString, get, isJsonArray, type Json, type JsonObject } from "@commissary/json";
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  makeMemoryBackend,
  resolveBackend,
  type SessionAddress,
} from "@commissary/state";

export const REPLAY_TTL_MS = 60 * 60 * 1000;

export const REPLAY_MAX_ITEMS_PER_ENTRY = 4096;

export const REPLAY_MAX_BYTES_PER_ENTRY = 16 << 20;

const MIN_THOUGHT_SIGNATURE_LEN = 16;

/** The SessionState store of each target (a session served by another target starts without replay state). */
export const ANTIGRAVITY_REPLAY_STORE = "antigravity-replay";

export const GEMINI_REPLAY_STORE = "gemini-reasoning-replay";

export const VERTEX_REPLAY_STORE = "vertex-reasoning-replay";

const MAX_MODELS_PER_SESSION = 64;

const SKIP_VALIDATOR = "skip_thought_signature_validator";

const TOMBSTONE = JSON.stringify({ deleted: true });

/** The exact ledger state one request read (`AntigravityReasoningReplaySnapshot`). */
export interface LedgerSnapshot {
  /** False when the state was never read: writes are then unconditional. */
  readonly loaded: boolean;
  /** Generation of the entry or tombstone that was read (0 = absent). */
  readonly generation: number;
}

export const UNLOADED_SNAPSHOT: LedgerSnapshot = { loaded: false, generation: 0 };

export interface LedgerRead {
  /** The replayable items; undefined for a miss or a tombstone. */
  readonly items: ReadonlyArray<Json> | undefined;
  readonly snapshot: LedgerSnapshot;
}

export interface ReplayLedger {
  /** `GetAntigravityReasoningReplayItemsWithSnapshotRequired` (a hit slides the TTL). */
  readonly get: (modelName: string, sessionKey: string) => Effect.Effect<LedgerRead>;
  /** `PeekAntigravityReasoningReplayItemsWithSnapshotRequired`: the same read without sliding the TTL (token counting). */
  readonly peek: (modelName: string, sessionKey: string) => Effect.Effect<LedgerRead>;
  /** `ReplaceAntigravityReasoningReplayItemsIfUnchanged`: false when another request changed the state. */
  readonly replaceIfUnchanged: (
    modelName: string,
    sessionKey: string,
    snapshot: LedgerSnapshot,
    items: ReadonlyArray<Json>,
  ) => Effect.Effect<boolean>;
  /** `DeleteAntigravityReasoningReplayItemsIfUnchanged`. */
  readonly deleteIfUnchanged: (
    modelName: string,
    sessionKey: string,
    snapshot: LedgerSnapshot,
  ) => Effect.Effect<boolean>;
}

const numberOf = (value: Json | undefined): number | undefined =>
  typeof value === "number" ? value : undefined;

const normalizeThoughtSignature = (item: Json): JsonObject | undefined => {
  let signature = asString(get(item, "thoughtSignature")).trim();

  if (signature === "") signature = asString(get(item, "thought_signature")).trim();

  if (
    signature === "" ||
    signature === SKIP_VALIDATOR ||
    signature.length < MIN_THOUGHT_SIGNATURE_LEN
  )
    return undefined;
  const out: JsonObject = { type: "thought_signature", thoughtSignature: signature };
  const contentIndex = numberOf(get(item, "contentIndex"));

  if (contentIndex !== undefined) out["contentIndex"] = Math.trunc(contentIndex);
  const partIndex = numberOf(get(item, "partIndex"));

  if (partIndex !== undefined) out["partIndex"] = Math.trunc(partIndex);
  const targetKind = asString(get(item, "targetKind")).trim();

  if (targetKind === "text" || targetKind === "thought") out["targetKind"] = targetKind;
  const targetHash = asString(get(item, "targetHash")).trim();

  if (targetHash !== "") out["targetHash"] = targetHash;
  const occurrence = numberOf(get(item, "targetOccurrence"));

  if (occurrence !== undefined && Math.trunc(occurrence) >= 0)
    out["targetOccurrence"] = Math.trunc(occurrence);
  const contextHash = asString(get(item, "contextHash")).trim();

  if (contextHash !== "") out["contextHash"] = contextHash;

  return out;
};

const normalizeFunctionCallPart = (item: Json): JsonObject | undefined => {
  let callId = asString(get(item, "call_id")).trim();

  if (callId === "") callId = asString(get(item, "id")).trim();
  let name = asString(get(item, "name")).trim();
  let args = get(item, "args");

  if (name === "" || args === undefined) {
    const call = get(item, "functionCall");

    if (call !== undefined) {
      if (callId === "") callId = asString(get(call, "id")).trim();

      if (name === "") name = asString(get(call, "name")).trim();

      if (args === undefined) args = get(call, "args");
    }
  }

  if (name === "" || args === undefined) return undefined;
  const out: JsonObject = { type: "function_call_part" };

  if (callId !== "") out["call_id"] = callId;
  out["name"] = name;
  out["args"] = args;
  const signature = asString(get(item, "thoughtSignature")).trim();

  if (signature !== "" && signature !== SKIP_VALIDATOR) out["thoughtSignature"] = signature;
  const contentIndex = numberOf(get(item, "contentIndex"));

  if (contentIndex !== undefined) out["contentIndex"] = Math.trunc(contentIndex);
  const partIndex = numberOf(get(item, "partIndex"));

  if (partIndex !== undefined) out["partIndex"] = Math.trunc(partIndex);
  const occurrence = numberOf(get(item, "targetOccurrence"));

  if (occurrence !== undefined && Math.trunc(occurrence) >= 0)
    out["targetOccurrence"] = Math.trunc(occurrence);
  const contextHash = asString(get(item, "contextHash")).trim();

  if (contextHash !== "") out["contextHash"] = contextHash;

  return out;
};

/** `normalizeAntigravityReasoningReplayItems`: undefined when over the bounds or nothing is replayable. */
export const normalizeReplayItems = (items: ReadonlyArray<Json>): Json[] | undefined => {
  if (items.length > REPLAY_MAX_ITEMS_PER_ENTRY) return undefined;
  const normalized: Json[] = [];
  let totalBytes = 0;

  for (const item of items) {
    let out: JsonObject | undefined;

    switch (asString(get(item, "type")).trim()) {
      case "thought_signature":
        out = normalizeThoughtSignature(item);
        break;
      case "function_call_part":
        out = normalizeFunctionCallPart(item);
        break;
    }

    if (out === undefined) continue;
    totalBytes += JSON.stringify(out).length;

    if (totalBytes > REPLAY_MAX_BYTES_PER_ENTRY) return undefined;
    normalized.push(out);
  }

  return normalized.length > 0 ? normalized : undefined;
};

const addressOf = (store: string, sessionKey: string): SessionAddress => ({
  store,
  scope: "",
  session: sessionKey.trim(),
});

const parseEntry = (text: string | undefined): Json[] | undefined => {
  if (text === undefined) return undefined;

  try {
    const parsed: unknown = JSON.parse(text);

    if (!isJsonArray(parsed)) return undefined;

    return parsed;
  } catch {
    return undefined;
  }
};

const cacheKey = (modelName: string, sessionKey: string): string =>
  modelName.trim() === "" || sessionKey.trim() === "" ? "" : modelName.trim();

export const makeSessionStateReplayLedger = (
  backend: BackendResolver = resolveBackend(),
  storeName: string = ANTIGRAVITY_REPLAY_STORE,
): ReplayLedger => {
  const read = (
    modelName: string,
    sessionKey: string,
    slide: boolean,
  ): Effect.Effect<LedgerRead> => {
    const key = cacheKey(modelName, sessionKey);

    if (key === "") return Effect.succeed({ items: undefined, snapshot: UNLOADED_SNAPSHOT });

    return bestEffort(
      `${storeName} get`,
      { items: undefined, snapshot: UNLOADED_SNAPSHOT } satisfies LedgerRead,
      Effect.gen(function* () {
        const state = yield* backend;

        const [result] = yield* state.run(addressOf(storeName, sessionKey), [
          { op: "get", key, ...(slide ? { extendTtlMs: REPLAY_TTL_MS } : {}) },
        ]);

        if (result?.status !== "ok")
          return { items: undefined, snapshot: UNLOADED_SNAPSHOT } satisfies LedgerRead;
        const snapshot: LedgerSnapshot = { loaded: true, generation: result.generation };
        const stored = parseEntry(result.value);

        if (
          stored === undefined ||
          stored.length === 0 ||
          stored.length > REPLAY_MAX_ITEMS_PER_ENTRY
        ) {
          return { items: undefined, snapshot } satisfies LedgerRead;
        }

        const normalized = normalizeReplayItems(stored);

        return {
          items:
            normalized !== undefined && normalized.length === stored.length
              ? normalized
              : undefined,
          snapshot,
        } satisfies LedgerRead;
      }),
    );
  };

  return {
    get: (modelName, sessionKey) => read(modelName, sessionKey, true),
    peek: (modelName, sessionKey) => read(modelName, sessionKey, false),
    replaceIfUnchanged: (modelName, sessionKey, snapshot, items) => {
      const key = cacheKey(modelName, sessionKey);
      const normalized = key === "" ? undefined : normalizeReplayItems(items);

      if (normalized === undefined) return Effect.succeed(false);

      return bestEffort(
        `${storeName} replace`,
        false,
        Effect.gen(function* () {
          const state = yield* backend;

          const [result] = yield* state.run(addressOf(storeName, sessionKey), [
            {
              op: "put",
              key,
              value: JSON.stringify(normalized),
              ttlMs: REPLAY_TTL_MS,
              maxEntries: MAX_MODELS_PER_SESSION,
              ...(snapshot.loaded ? { ifGeneration: snapshot.generation } : {}),
            },
          ]);

          return result?.status === "ok";
        }),
      );
    },
    deleteIfUnchanged: (modelName, sessionKey, snapshot) => {
      const key = cacheKey(modelName, sessionKey);

      if (key === "") return Effect.succeed(false);

      return bestEffort(
        `${storeName} delete`,
        false,
        Effect.gen(function* () {
          const state = yield* backend;

          const [result] = yield* state.run(addressOf(storeName, sessionKey), [
            {
              op: "put",
              key,
              value: TOMBSTONE,
              ttlMs: REPLAY_TTL_MS,
              maxEntries: MAX_MODELS_PER_SESSION,
              ...(snapshot.loaded ? { ifGeneration: snapshot.generation } : {}),
            },
          ]);

          return result?.status === "ok";
        }),
      );
    },
  };
};

/** In-memory ledger for tests (`now` is injectable). */
export const makeInMemoryReplayLedger = (now?: () => number): ReplayLedger =>
  makeSessionStateReplayLedger(fixedBackend(makeMemoryBackend(now)));

/** Default ledger: the `SessionState` Durable Object when bound, else per isolate. */
export const defaultReplayLedger: ReplayLedger = makeSessionStateReplayLedger();

/** The Gemini API and Vertex ledgers: one store per target, the same entry layout (Go shares one key space). */
export const defaultGeminiReplayLedger: ReplayLedger = makeSessionStateReplayLedger(
  resolveBackend(),
  GEMINI_REPLAY_STORE,
);

export const defaultVertexReplayLedger: ReplayLedger = makeSessionStateReplayLedger(
  resolveBackend(),
  VERTEX_REPLAY_STORE,
);
