// A SessionState backend that counts the Durable Object round trips (one `run` is one), for the tests that pin how many
// calls a request makes.
import { Effect } from "effect";
import {
  makeMemoryBackend,
  type SessionAddress,
  SessionStateError,
  type SessionStateBackend,
  type StateOp,
} from "@commissary/state";

export interface BackendCall {
  readonly store: string;
  readonly session: string;
  readonly ops: ReadonlyArray<StateOp["op"]>;
  /** The ops that slide a TTL, write or delete. */
  readonly writes: number;
}

export interface CountingBackend extends SessionStateBackend {
  readonly calls: BackendCall[];
  /** Round trips to `store` (every store when omitted). */
  readonly count: (store?: string) => number;
  /** Ops of kind `op` sent to `store`. */
  readonly ops: (op: StateOp["op"], store?: string) => number;
  /** Events (backend calls and anything the test marks) in order. */
  readonly events: string[];
}

const writesOf = (op: StateOp): boolean =>
  op.op !== "get" || ("extendTtlMs" in op && op.extendTtlMs !== undefined);

export const countingBackend = (
  inner: SessionStateBackend = makeMemoryBackend(() => 5_000_000),
): CountingBackend => {
  const calls: BackendCall[] = [];
  const events: string[] = [];

  return {
    calls,
    events,
    count: (store) => calls.filter((call) => store === undefined || call.store === store).length,
    ops: (op, store) =>
      calls
        .filter((call) => store === undefined || call.store === store)
        .reduce((total, call) => total + call.ops.filter((name) => name === op).length, 0),
    run: (address: SessionAddress, ops) => {
      calls.push({
        store: address.store,
        session: address.session,
        ops: ops.map((op) => op.op),
        writes: ops.filter(writesOf).length,
      });
      events.push(`state:${address.store}:${ops.map((op) => op.op).join("+")}`);

      return inner.run(address, ops);
    },
  };
};

/** A backend that always fails, as an unreachable Durable Object does. */
export const failingBackend = (): SessionStateBackend => ({
  run: () => Effect.fail(new SessionStateError({ message: "SessionState request failed" })),
});
