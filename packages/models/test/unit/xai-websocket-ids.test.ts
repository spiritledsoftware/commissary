// xAI WebSocket id state store: 24 h idle eviction with in-flight protection (Go: xai_websockets_executor_test.go;
// upstream 679166b8).
import { describe, expect, it } from "vite-plus/test";
import { XAI_ID_STATE_IDLE_TTL_MS, XaiIdStateStore } from "../../src/executor/xai/websocket-ids.ts";

const TTL = XAI_ID_STATE_IDLE_TTL_MS;

describe("XaiIdStateStore", () => {
  it("returns the same state while it is used within 24 h", () => {
    const store = new XaiIdStateStore();
    const state = store.get("s1", 0);

    expect(store.get("s1", TTL - 1)).toBe(state);
    // Each use renews the idle window.
    expect(store.get("s1", 2 * TTL - 2)).toBe(state);
  });

  it("replaces a state idle for 24 h", () => {
    const store = new XaiIdStateStore();
    const state = store.get("s1", 0);
    state?.mapDownstreamToUpstream("resp_down", "resp_up");

    const fresh = store.get("s1", TTL);
    expect(fresh).not.toBe(state);
    expect(fresh?.upstreamIdForDownstream("resp_down")).toBe("resp_down");
  });

  it("evicts other idle states on access, least recently used first", () => {
    const store = new XaiIdStateStore();
    store.get("old", 0);
    store.get("recent", TTL / 2);

    store.get("new", TTL);
    expect(store.size).toBe(2);

    store.get("new", TTL + TTL / 2);
    expect(store.size).toBe(1);
  });

  it("never evicts a state with a stream in flight, and renews it on release", () => {
    const store = new XaiIdStateStore();
    const state = store.acquire("s1", 0);

    expect(state).toBeDefined();
    expect(store.get("other", 2 * TTL)).toBeDefined();
    expect(store.size).toBe(2);

    if (state !== undefined) store.release(state, 2 * TTL);
    expect(store.get("s1", 3 * TTL - 1)).toBe(state);
  });

  it("ignores a release of a state the session no longer holds", () => {
    const store = new XaiIdStateStore();
    const state = store.acquire("s1", 0);
    store.delete("s1");

    if (state !== undefined) store.release(state, 1);
    expect(store.size).toBe(0);
  });

  it("holds no state for a blank session id", () => {
    const store = new XaiIdStateStore();

    expect(store.get(" ", 0)).toBeUndefined();
    expect(store.acquire("", 0)).toBeUndefined();
  });
});
