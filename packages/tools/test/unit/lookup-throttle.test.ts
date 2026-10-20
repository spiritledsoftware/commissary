// The throttle of an org's lookups at integrations.sh (#207): a fixed window a key, with how long until it ends.
import { describe, expect, it } from "vitest";
import { LOOKUP_WINDOW_MS, LookupThrottle } from "../../src/catalog/lookup-throttle.ts";

describe("LookupThrottle", () => {
  it("lets `limit` lookups of a key through a window, then says when the next may go", () => {
    const throttle = new LookupThrottle();

    expect(throttle.take("detect:m1", 2, 0)).toEqual({ ok: true });
    expect(throttle.take("detect:m1", 2, 1000)).toEqual({ ok: true });
    expect(throttle.take("detect:m1", 2, 20_000)).toEqual({
      ok: false,
      retryAfterMs: LOOKUP_WINDOW_MS - 20_000,
    });
    // Another key has a window of its own.
    expect(throttle.take("detect:m2", 2, 20_000)).toEqual({ ok: true });
    expect(throttle.take("detect:m1", 2, LOOKUP_WINDOW_MS)).toEqual({ ok: true });
  });
});
