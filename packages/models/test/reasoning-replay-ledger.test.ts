// The retention of the reasoning-replay ledger (ADR 0027): the TTL slides, but no entry lives longer than its absolute age
// from the first write, however active the session is.
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { fixedBackend, makeMemoryBackend } from "@commissary/state";
import {
  ANTIGRAVITY_REPLAY_STORE,
  makeInMemoryReplayLedger,
  makeSessionStateReplayLedger,
  REPLAY_MAX_AGE_MS,
  REPLAY_TTL_MS,
  UNLOADED_SNAPSHOT,
} from "../src/executor/helps/reasoning-replay-ledger.ts";

const MODEL = "gemini-3-pro-preview";

const SIGNATURE = "CiQBsignature-from-upstream-0001";

const item = {
  type: "thought_signature",
  thoughtSignature: SIGNATURE,
  contentIndex: 1,
  partIndex: 0,
};

const STEP_MS = 50 * 60 * 1000;

it.effect("never replays an entry past its absolute age, however active the session is", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(10_000_000);
    const ledger = makeInMemoryReplayLedger();

    const born = yield* ledger.get(MODEL, "s");

    expect(yield* ledger.replaceIfUnchanged(MODEL, "s", born.snapshot, [item])).toBe(true);
    expect(STEP_MS).toBeLessThan(REPLAY_TTL_MS);

    // An active session: every turn reads (the TTL slides) and rewrites the entry, each inside the 1 h TTL.
    let elapsed = 0;
    let hits = 0;

    let capped = false;

    // At most 40 turns: a ledger without the cap would still be answering after them.
    for (let turn = 0; turn < 40 && !capped; turn++) {
      yield* TestClock.adjust(STEP_MS);
      elapsed += STEP_MS;
      const read = yield* ledger.get(MODEL, "s");

      if (read.items === undefined) {
        // The cap, not the TTL, ended it: wiped on this read, and this request writes its own entry.
        expect(elapsed).toBeGreaterThanOrEqual(REPLAY_MAX_AGE_MS);
        expect(elapsed).toBeLessThan(REPLAY_MAX_AGE_MS + STEP_MS);
        expect(read.snapshot).toEqual(UNLOADED_SNAPSHOT);
        capped = true;
        continue;
      }

      hits++;
      expect(elapsed).toBeLessThan(REPLAY_MAX_AGE_MS);
      expect(yield* ledger.replaceIfUnchanged(MODEL, "s", read.snapshot, [item])).toBe(true);
    }

    expect(capped).toBe(true);
    expect(hits).toBeGreaterThan(20);
    // The entry is gone from the store, not just ignored.
    expect((yield* ledger.peek(MODEL, "s")).items).toBeUndefined();

    // A new entry is born now and starts a new age.
    expect(yield* ledger.replaceIfUnchanged(MODEL, "s", UNLOADED_SNAPSHOT, [item])).toBe(true);
    yield* TestClock.adjust(STEP_MS);
    expect((yield* ledger.get(MODEL, "s")).items).toEqual([item]);
  }),
);

it.effect("still lets an entry expire after an hour without a read", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(10_000_000);
    const ledger = makeInMemoryReplayLedger();
    const born = yield* ledger.get(MODEL, "idle");

    yield* ledger.replaceIfUnchanged(MODEL, "idle", born.snapshot, [item]);
    yield* TestClock.adjust(REPLAY_TTL_MS + 1000);

    expect((yield* ledger.get(MODEL, "idle")).items).toBeUndefined();
  }),
);

it.effect(
  "keeps reading an entry written before the cap existed, and dates it from its next write",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000_000);
      const backend = makeMemoryBackend();
      const ledger = makeSessionStateReplayLedger(fixedBackend(backend), ANTIGRAVITY_REPLAY_STORE);

      // An entry as the ledger wrote it before the cap: the bare item array.
      yield* backend.run({ store: ANTIGRAVITY_REPLAY_STORE, scope: "", session: "legacy" }, [
        { op: "put", key: MODEL, value: JSON.stringify([item]), ttlMs: REPLAY_TTL_MS },
      ]);

      const read = yield* ledger.get(MODEL, "legacy");

      expect(read.items).toEqual([item]);
      expect(read.snapshot.firstWriteAt).toBeUndefined();

      yield* TestClock.adjust(STEP_MS);
      yield* ledger.replaceIfUnchanged(MODEL, "legacy", read.snapshot, [item]);

      expect((yield* ledger.get(MODEL, "legacy")).snapshot.firstWriteAt).toBe(10_000_000 + STEP_MS);
    }),
);
