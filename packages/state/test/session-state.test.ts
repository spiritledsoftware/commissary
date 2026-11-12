// SessionState entry semantics (TTL, compare-and-swap generations, bounds, counters), run against the in-process
// engine and the real Durable Object (SQLite storage, chunked values, alarm sweep). Time is the caller-supplied
// `now`, so nothing sleeps.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import {
  MAX_TTL_MS,
  MemoryStateTable,
  MIN_TTL_MS,
  StateEngine,
  type StateOp,
  type StateResult,
} from "../src/index.ts";

type Run = (ops: StateOp[], now: number) => Promise<StateResult[]>;

const memory = (): Run => {
  const engine = new StateEngine(new MemoryStateTable());

  return async (ops, now) => engine.run(ops, now);
};

const durable = (): Run => {
  const stub = env.SESSION_STATE.getByName(`contract-${crypto.randomUUID()}`);

  return async (ops, now) => await stub.run(ops, now);
};

// A base time near the real clock: the Durable Object arms an alarm at the earliest expiry and must not fire it.
const T0 = Date.now();

const HOUR = 3_600_000;

describe.each([
  ["engine", memory],
  ["Durable Object", durable],
])("SessionState contract (%s)", (_name, makeRun) => {
  it("stores and reads values; an absent key has generation 0", async () => {
    const run = makeRun();
    expect(await run([{ op: "get", key: "k" }], T0)).toEqual([{ status: "ok", generation: 0 }]);
    const [put] = await run([{ op: "put", key: "k", value: "v1", ttlMs: HOUR }], T0);
    expect(put?.status).toBe("ok");
    const generation = put?.status === "ok" ? put.generation : 0;
    expect(generation).toBeGreaterThan(0);
    expect(await run([{ op: "get", key: "k" }], T0 + 1)).toEqual([
      { status: "ok", generation, value: "v1" },
    ]);
  });

  it("executes a batch in order with positional results", async () => {
    const run = makeRun();

    const results = await run(
      [
        { op: "put", key: "a", value: "1", ttlMs: HOUR },
        { op: "put", key: "b", value: "2", ttlMs: HOUR },
        { op: "get", key: "a" },
        { op: "delete", key: "a" },
        { op: "get", key: "a" },
        { op: "get", key: "b" },
      ],
      T0,
    );

    expect(
      results.map((result) => (result.status === "ok" ? (result.value ?? null) : result.status)),
    ).toEqual([null, null, "1", null, null, "2"]);
  });

  it("compare-and-swap: absent = 0, stale writers get the current state back", async () => {
    const run = makeRun();

    const [first] = await run(
      [{ op: "put", key: "k", value: "a", ttlMs: HOUR, ifGeneration: 0 }],
      T0,
    );

    expect(first?.status).toBe("ok");
    const g1 = first?.status === "ok" ? first.generation : -1;
    // A second "must be absent" writer loses and learns the winner's state.
    expect(
      await run([{ op: "put", key: "k", value: "b", ttlMs: HOUR, ifGeneration: 0 }], T0),
    ).toEqual([{ status: "conflict", generation: g1, value: "a" }]);

    const [second] = await run(
      [{ op: "put", key: "k", value: "c", ttlMs: HOUR, ifGeneration: g1 }],
      T0,
    );

    expect(second?.status).toBe("ok");
    const g2 = second?.status === "ok" ? second.generation : -1;
    expect(g2).toBeGreaterThan(g1);
    // The first generation is stale now, for writes and deletes.
    expect(
      (await run([{ op: "put", key: "k", value: "d", ttlMs: HOUR, ifGeneration: g1 }], T0))[0]
        ?.status,
    ).toBe("conflict");
    expect(await run([{ op: "delete", key: "k", ifGeneration: g1 }], T0)).toEqual([
      { status: "conflict", generation: g2, value: "c" },
    ]);
    expect(await run([{ op: "delete", key: "k", ifGeneration: g2 }], T0)).toEqual([
      { status: "ok", generation: 0 },
    ]);
    expect(await run([{ op: "get", key: "k" }], T0)).toEqual([{ status: "ok", generation: 0 }]);
  });

  it("expires entries at now + ttl, clamps the ttl and never reuses a generation", async () => {
    const run = makeRun();
    const [put] = await run([{ op: "put", key: "k", value: "v", ttlMs: 10_000 }], T0);
    const g1 = put?.status === "ok" ? put.generation : -1;
    expect((await run([{ op: "get", key: "k" }], T0 + 9_999))[0]).toMatchObject({ value: "v" });
    expect(await run([{ op: "get", key: "k" }], T0 + 10_000)).toEqual([
      { status: "ok", generation: 0 },
    ]);
    // An expired entry reads as absent for compare-and-swap too, and the new entry has a fresh generation.
    expect(
      (
        await run(
          [{ op: "put", key: "k", value: "w", ttlMs: 10_000, ifGeneration: g1 }],
          T0 + 20_000,
        )
      )[0],
    ).toEqual({
      status: "conflict",
      generation: 0,
    });

    const [again] = await run(
      [{ op: "put", key: "k", value: "w", ttlMs: 10_000, ifGeneration: 0 }],
      T0 + 20_000,
    );

    expect(again?.status === "ok" ? again.generation : 0).toBeGreaterThan(g1);

    await run([{ op: "put", key: "short", value: "v", ttlMs: 1 }], T0);
    expect((await run([{ op: "get", key: "short" }], T0 + MIN_TTL_MS - 1))[0]).toMatchObject({
      value: "v",
    });
    expect(await run([{ op: "get", key: "short" }], T0 + MIN_TTL_MS)).toEqual([
      { status: "ok", generation: 0 },
    ]);
    await run([{ op: "put", key: "long", value: "v", ttlMs: 10 * MAX_TTL_MS }], T0);
    expect((await run([{ op: "get", key: "long" }], T0 + MAX_TTL_MS - 1))[0]).toMatchObject({
      value: "v",
    });
    expect((await run([{ op: "get", key: "long" }], T0 + MAX_TTL_MS))[0]).toEqual({
      status: "ok",
      generation: 0,
    });
  });

  it("slides the expiry on a get with extendTtlMs without changing the generation", async () => {
    const run = makeRun();
    const [put] = await run([{ op: "put", key: "k", value: "v", ttlMs: 10_000 }], T0);
    const generation = put?.status === "ok" ? put.generation : -1;
    const [hit] = await run([{ op: "get", key: "k", extendTtlMs: 10_000 }], T0 + 8_000);
    expect(hit).toEqual({ status: "ok", generation, value: "v" });
    expect((await run([{ op: "get", key: "k" }], T0 + 17_000))[0]).toEqual({
      status: "ok",
      generation,
      value: "v",
    });
    expect((await run([{ op: "get", key: "k" }], T0 + 18_000))[0]).toEqual({
      status: "ok",
      generation: 0,
    });
  });

  it("bounds the entries: expired ones go first, then the oldest writes; the newest write survives", async () => {
    const run = makeRun();

    for (let index = 0; index < 3; index++) {
      await run(
        [{ op: "put", key: `k${index}`, value: String(index), ttlMs: HOUR, maxEntries: 3 }],
        T0 + index,
      );
    }

    await run([{ op: "put", key: "k3", value: "3", ttlMs: HOUR, maxEntries: 3 }], T0 + 3);
    const read = async (key: string) => (await run([{ op: "get", key }], T0 + 4))[0];
    expect(await read("k0")).toEqual({ status: "ok", generation: 0 });
    expect(await read("k1")).toMatchObject({ value: "1" });
    expect(await read("k3")).toMatchObject({ value: "3" });

    // A short-lived entry is purged before a live one is evicted.
    const other = makeRun();
    await other([{ op: "put", key: "live", value: "l", ttlMs: HOUR, maxEntries: 2 }], T0);
    await other(
      [{ op: "put", key: "short", value: "s", ttlMs: MIN_TTL_MS, maxEntries: 2 }],
      T0 + 1,
    );
    await other(
      [{ op: "put", key: "new", value: "n", ttlMs: HOUR, maxEntries: 2 }],
      T0 + 2 * MIN_TTL_MS,
    );
    expect((await other([{ op: "get", key: "live" }], T0 + 2 * MIN_TTL_MS))[0]).toMatchObject({
      value: "l",
    });
    expect((await other([{ op: "get", key: "new" }], T0 + 2 * MIN_TTL_MS))[0]).toMatchObject({
      value: "n",
    });
  });

  it("counts atomically with incr and restarts after expiry", async () => {
    const run = makeRun();

    const values = async (now: number) =>
      (await run([{ op: "incr", key: "c", ttlMs: 10_000 }], now)).map((result) =>
        result.status === "ok" ? result.value : result.status,
      );

    expect(await values(T0)).toEqual(["1"]);
    expect(await values(T0 + 1)).toEqual(["2"]);
    expect(
      await run(
        [
          { op: "incr", key: "c", ttlMs: 10_000 },
          { op: "incr", key: "c", ttlMs: 10_000 },
        ],
        T0 + 2,
      ),
    ).toMatchObject([{ value: "3" }, { value: "4" }]);
    expect(await values(T0 + 20_000)).toEqual(["1"]);
  });

  it("rejects empty keys", async () => {
    const run = makeRun();
    expect(await run([{ op: "put", key: "", value: "x", ttlMs: HOUR }], T0)).toEqual([
      { status: "rejected", reason: "invalid" },
    ]);
  });
});

describe("SessionState Durable Object", () => {
  const stubFor = () => env.SESSION_STATE.getByName(`do-${crypto.randomUUID()}`);

  it("keeps instances apart and survives values larger than a SQLite row", async () => {
    const a = stubFor();
    const b = stubFor();
    // 700k units with astral characters (4 bytes each in UTF-8) span several chunks.
    const big = "😀".repeat(350_000) + "tail";
    await a.run([{ op: "put", key: "big", value: big, ttlMs: HOUR }], T0);
    const [read] = await a.run([{ op: "get", key: "big" }], T0);
    expect(read?.status === "ok" ? read.value === big : false).toBe(true);
    expect(await b.run([{ op: "get", key: "big" }], T0)).toEqual([{ status: "ok", generation: 0 }]);
    // Overwriting with a shorter value leaves no stale chunks behind.
    await a.run([{ op: "put", key: "big", value: "small", ttlMs: HOUR }], T0);
    expect((await a.run([{ op: "get", key: "big" }], T0))[0]).toMatchObject({ value: "small" });
  });

  it("arms an alarm at the earliest expiry and sweeps expired entries and then the whole instance", async () => {
    const stub = stubFor();
    await stub.run([{ op: "put", key: "early", value: "e", ttlMs: 60_000 }], T0);
    await stub.run([{ op: "put", key: "late", value: "l", ttlMs: HOUR }], T0);
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBe(T0 + 60_000);

    // The sweep drops the expired entry, keeps the live one and re-arms for it.
    await runInDurableObject(stub, (instance) => instance.sweep(T0 + 61_000));
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
      T0 + HOUR,
    );
    expect((await stub.run([{ op: "get", key: "early" }], T0 + 30_000))[0]).toEqual({
      status: "ok",
      generation: 0,
    });
    expect((await stub.run([{ op: "get", key: "late" }], T0 + 30_000))[0]).toMatchObject({
      value: "l",
    });

    // Once nothing is left the instance deletes its storage (and the alarm) and keeps working afterwards.
    await runInDurableObject(stub, (instance) => instance.sweep(T0 + 2 * HOUR));
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).toBeNull();
    expect(await stub.run([{ op: "get", key: "late" }], T0 + 2 * HOUR)).toEqual([
      { status: "ok", generation: 0 },
    ]);

    const [fresh] = await stub.run(
      [{ op: "put", key: "again", value: "a", ttlMs: HOUR }],
      T0 + 2 * HOUR,
    );

    expect(fresh?.status).toBe("ok");
  });

  it("never reuses a generation after the instance emptied itself", async () => {
    const stub = stubFor();
    const [first] = await stub.run([{ op: "put", key: "k", value: "a", ttlMs: MIN_TTL_MS }], T0);
    const g1 = first?.status === "ok" ? first.generation : -1;
    await runInDurableObject(stub, (instance) => instance.sweep(T0 + 2 * MIN_TTL_MS));

    const [second] = await stub.run(
      [{ op: "put", key: "k", value: "b", ttlMs: MIN_TTL_MS }],
      T0 + 2 * MIN_TTL_MS,
    );

    expect(second?.status === "ok" ? second.generation : 0).toBeGreaterThan(g1);
    // The stale token of the first entry cannot overwrite the second.
    expect(
      (
        await stub.run(
          [{ op: "put", key: "k", value: "c", ttlMs: MIN_TTL_MS, ifGeneration: g1 }],
          T0 + 2 * MIN_TTL_MS,
        )
      )[0]?.status,
    ).toBe("conflict");
  });
});
