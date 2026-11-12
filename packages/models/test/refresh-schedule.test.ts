// Refresh scheduling math and failure/success state transitions (pure, no I/O).
import { describe, expect, it } from "vite-plus/test";
import { emptyState } from "../src/credentials/model.ts";
import { applyRefreshFailure, applyRefreshSuccess } from "../src/credentials/refresh/outcome.ts";
import { isInvalidGrant, isUnauthorized } from "../src/credentials/refresh/error.ts";
import {
  invalidGrantBackoffMs,
  nextRefreshCheckAt,
  refreshLeadMs,
  shouldRefresh,
} from "../src/credentials/refresh/schedule.ts";
import { mergeRefreshedMetadata } from "../src/credentials/refresh/three-way.ts";
import { cred, state } from "./support/credentials.ts";
import { jwt, T0 } from "./support/refresh.ts";

const MIN = 60_000;

const HOUR = 60 * MIN;

const iso = (ms: number) => new Date(ms).toISOString();

const subject = (
  provider: string,
  metadata: Record<string, unknown>,
  attributes: Record<string, string> = {},
) =>
  cred(`${provider}.json`, {
    provider,
    metadata: metadata as never,
    attributes,
    authKind: "oauth",
  });

describe("provider leads", () => {
  it.each([
    ["codex", 96 * HOUR],
    ["claude", 4 * HOUR],
    ["antigravity", 30 * MIN],
    ["xai", 5 * MIN],
    ["kimi", 5 * MIN],
    ["kimi-ai", 5 * MIN],
    ["kimi.ai", 5 * MIN],
  ])("%s refreshes %d ms before expiry", (provider, lead) => {
    expect(refreshLeadMs(provider)).toBe(lead);
    const expiry = T0 + lead + 10 * MIN;

    const credential = subject(provider, {
      refresh_token: "r",
      access_token: "a",
      expired: iso(expiry),
    });

    expect(nextRefreshCheckAt(T0, credential, emptyState())).toBe(expiry - lead);
    expect(shouldRefresh(T0, credential, emptyState())).toBe(false);
    expect(shouldRefresh(T0 + 10 * MIN, credential, emptyState())).toBe(true);
    expect(nextRefreshCheckAt(T0 + 11 * MIN, credential, emptyState())).toBe(T0 + 11 * MIN);
  });

  it.each(["kimi.com", "devin", "meta", "vertex", "gemini", "aistudio", "openai-compatibility"])(
    "%s is never auto-refreshed",
    (provider) => {
      const credential = subject(provider, {
        refresh_token: "r",
        dca_token: "d",
        expired: iso(T0 - HOUR),
      });

      expect(nextRefreshCheckAt(T0, credential, emptyState())).toBeUndefined();
      expect(shouldRefresh(T0, credential, emptyState())).toBe(false);
    },
  );

  it("never schedules credentials without a refresh token", () => {
    const credential = subject("claude", { access_token: "a", expired: iso(T0 - HOUR) });
    expect(nextRefreshCheckAt(T0, credential, emptyState())).toBeUndefined();
  });
});

describe("expiry sources", () => {
  it("falls back to last_refresh + lead when no expiry is known, and is due when nothing is known", () => {
    const withLast = subject("codex", { refresh_token: "r", last_refresh: iso(T0 - 2 * HOUR) });
    expect(nextRefreshCheckAt(T0, withLast, emptyState())).toBe(T0 - 2 * HOUR + 96 * HOUR);
    expect(shouldRefresh(T0, withLast, emptyState())).toBe(false);
    const nothing = subject("codex", { refresh_token: "r" });
    expect(nextRefreshCheckAt(T0, nothing, emptyState())).toBe(T0);
    expect(shouldRefresh(T0, nothing, emptyState())).toBe(true);
  });

  it("lets a JWT exp claim outrank the expired metadata", () => {
    const exp = Math.floor((T0 + 2 * HOUR) / 1000);

    const credential = subject("claude", {
      refresh_token: "r",
      access_token: jwt({ exp }),
      expired: iso(T0 + 100 * HOUR),
    });

    // exp - 4h is already in the past: due now, even though `expired` says 100 h from now.
    expect(nextRefreshCheckAt(T0, credential, emptyState())).toBe(T0);
    expect(shouldRefresh(T0, credential, emptyState())).toBe(true);
  });

  it("treats a rejected access token as expired", () => {
    const credential = subject("claude", {
      refresh_token: "r",
      access_token: "tok",
      expired: iso(T0 + 100 * HOUR),
    });

    expect(shouldRefresh(T0, credential, emptyState())).toBe(false);
    expect(shouldRefresh(T0, credential, state({ rejectedAccessToken: "tok" }))).toBe(true);
    expect(shouldRefresh(T0, credential, state({ rejectedAccessToken: "other" }))).toBe(false);
  });

  it("honours a per-credential refresh_interval_seconds over the provider lead", () => {
    const credential = subject("claude", {
      refresh_token: "r",
      refresh_interval_seconds: 600,
      expired: iso(T0 + 100 * HOUR),
      last_refresh: iso(T0 - 5 * MIN),
    });

    expect(nextRefreshCheckAt(T0, credential, emptyState())).toBe(T0 + 5 * MIN);
    expect(shouldRefresh(T0 + 6 * MIN, credential, emptyState())).toBe(true);
  });
});

describe("back-off and terminal states", () => {
  it("waits for nextRefreshAfter", () => {
    const credential = subject("claude", { refresh_token: "r", expired: iso(T0 - HOUR) });
    const backoff = state({ nextRefreshAfter: T0 + 5 * MIN });
    expect(nextRefreshCheckAt(T0, credential, backoff)).toBe(T0 + 5 * MIN);
    expect(shouldRefresh(T0, credential, backoff)).toBe(false);
    expect(shouldRefresh(T0 + 5 * MIN, credential, backoff)).toBe(true);
  });

  it("stops scheduling after a terminal unauthorized failure and for disabled + invalid_grant", () => {
    const credential = subject("claude", { refresh_token: "r", expired: iso(T0 - HOUR) });

    const terminal = state({
      unavailable: true,
      status: "error",
      lastError: { code: "unauthorized", message: "x", retryable: false, httpStatus: 401 },
    });

    expect(nextRefreshCheckAt(T0, credential, terminal)).toBeUndefined();

    const disabled = cred("d.json", {
      provider: "claude",
      disabled: true,
      metadata: { refresh_token: "r", expired: iso(T0 - HOUR) },
    });

    const invalid = state({ lastError: { message: "invalid_grant", retryable: false } });
    expect(nextRefreshCheckAt(T0, disabled, invalid)).toBeUndefined();
    expect(nextRefreshCheckAt(T0, disabled, emptyState())).toBe(T0);
  });

  it("doubles the invalid_grant back-off from 1 to 30 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => invalidGrantBackoffMs(n) / MIN)).toEqual([
      1, 2, 4, 8, 16, 30, 30, 30,
    ]);
  });

  it("classifies errors by text like Go", () => {
    expect(isUnauthorized({ message: "x", status: 401 })).toBe(true);
    expect(isUnauthorized({ message: "kimi: refresh token rejected (status 401)" })).toBe(true);
    expect(isUnauthorized({ message: "failed with status 401: nope" })).toBe(true);
    expect(isInvalidGrant({ message: 'status 400: {"error":"invalid_grant"}', status: 400 })).toBe(
      true,
    );
    expect(isInvalidGrant({ message: "invalid_grant", status: 500 })).toBe(false);
    expect(isInvalidGrant({ message: "invalid_grant" })).toBe(true);
  });
});

describe("refresh failure transitions", () => {
  const base = {
    now: T0,
    message: "token refresh failed",
    disabled: false,
    hasValidAccessToken: false,
    accessTokenRejected: false,
    force: false,
  };

  it("expired token + transient failure: unavailable, retry in 5 minutes", () => {
    const out = applyRefreshFailure(emptyState(), { ...base, status: 500 });
    expect(out.schedule).toBe("reschedule");
    expect(out.state).toMatchObject({
      status: "error",
      unavailable: true,
      nextRefreshAfter: T0 + 5 * MIN,
      statusMessage: "token expired",
      refreshFailures: 0,
    });
  });

  it("expired token + invalid_grant: exponential back-off and failure counter", () => {
    const first = applyRefreshFailure(emptyState(), {
      ...base,
      message: "status 400: invalid_grant",
      status: 400,
    });

    expect(first.state).toMatchObject({
      refreshFailures: 1,
      nextRefreshAfter: T0 + MIN,
      statusMessage: "invalid grant (retrying)",
    });

    const third = applyRefreshFailure(state({ refreshFailures: 2 }), {
      ...base,
      message: "status 400: invalid_grant",
      status: 400,
    });

    expect(third.state).toMatchObject({ refreshFailures: 3, nextRefreshAfter: T0 + 4 * MIN });
  });

  it("401 without a valid token is terminal until re-login", () => {
    const out = applyRefreshFailure(emptyState(), { ...base, status: 401 });
    expect(out.state).toMatchObject({
      unavailable: true,
      status: "error",
      nextRefreshAfter: 0,
      statusMessage: "unauthorized",
      lastError: { code: "unauthorized", httpStatus: 401 },
    });
    // already terminal: nothing changes unless forced
    expect(applyRefreshFailure(out.state, { ...base, status: 500 }).state).toBe(out.state);
    expect(applyRefreshFailure(out.state, { ...base, status: 500, force: true }).schedule).toBe(
      "unschedule",
    );
  });

  it("a rejected access token + invalid_grant is terminal", () => {
    const out = applyRefreshFailure(emptyState(), {
      ...base,
      message: "invalid_grant",
      status: 400,
      accessTokenRejected: true,
      hasValidAccessToken: true,
    });

    expect(out.schedule).toBe("unschedule");
    expect(out.state).toMatchObject({
      unavailable: true,
      nextRefreshAfter: 0,
      statusMessage: "unauthorized (refresh token invalid)",
      lastError: { code: "unauthorized" },
    });
  });

  it("keeps serving a still valid token and retries before it expires", () => {
    const out = applyRefreshFailure(emptyState(), {
      ...base,
      status: 500,
      hasValidAccessToken: true,
      tokenExpiry: T0 + 2 * MIN,
    });

    expect(out.state.unavailable).toBe(false);
    expect(out.state.status).toBe("active");
    expect(out.state.nextRefreshAfter).toBe(T0 + 2 * MIN);

    const later = applyRefreshFailure(emptyState(), {
      ...base,
      status: 500,
      hasValidAccessToken: true,
    });

    expect(later.state.nextRefreshAfter).toBe(T0 + 5 * MIN);
  });

  it("disabled credentials: invalid_grant unschedules, other errors retry in 5 minutes", () => {
    const grant = applyRefreshFailure(emptyState(), {
      ...base,
      message: "invalid_grant",
      disabled: true,
    });

    expect(grant.schedule).toBe("unschedule");
    expect(grant.state).toMatchObject({
      status: "disabled",
      statusMessage: "disabled (invalid grant)",
    });
    const other = applyRefreshFailure(emptyState(), { ...base, status: 503, disabled: true });
    expect(other.state.nextRefreshAfter).toBe(T0 + 5 * MIN);
  });
});

describe("refresh success transitions", () => {
  it("clears errors, rejected token and failure counters; guards against ineffective refresh", () => {
    const current = state({
      status: "error",
      unavailable: true,
      statusMessage: "token expired",
      lastError: { message: "boom", retryable: false },
      refreshFailures: 3,
      nextRefreshAfter: T0 - 1,
      rejectedAccessToken: "old",
    });

    const ok = applyRefreshSuccess(current, current, T0, false, false);
    expect(ok).toMatchObject({
      status: "active",
      unavailable: false,
      refreshFailures: 0,
      nextRefreshAfter: 0,
    });
    expect(ok.lastError).toBeUndefined();
    expect(ok.rejectedAccessToken).toBeUndefined();
    expect(applyRefreshSuccess(current, current, T0, true, false).nextRefreshAfter).toBe(
      T0 + 30_000,
    );
  });

  it("keeps a cooldown or error that appeared while the refresh was running", () => {
    const base = emptyState();

    const cooling = state({
      unavailable: true,
      nextRetryAfter: T0 + MIN,
      statusMessage: "cooling down",
    });

    expect(applyRefreshSuccess(base, cooling, T0, false, false)).toMatchObject({
      unavailable: true,
      statusMessage: "cooling down",
    });

    const errored = state({
      status: "error",
      unavailable: true,
      lastError: { message: "new 503", retryable: true },
    });

    expect(applyRefreshSuccess(base, errored, T0, false, false)).toMatchObject({
      status: "error",
      lastError: { message: "new 503" },
    });
  });

  it("lifts unauthorized model cooldowns", () => {
    const stale = {
      status: "error" as const,
      unavailable: true,
      nextRetryAfter: T0 + 30 * MIN,
      quota: { exceeded: false, nextRecoverAt: 0, backoffLevel: 0 },
      lastError: { message: "401", retryable: false, httpStatus: 401 },
      updatedAt: 0,
    };

    const healthy = { ...stale, lastError: { message: "500", retryable: true, httpStatus: 500 } };
    const current = state({ modelStates: { a: stale, b: healthy } });
    const out = applyRefreshSuccess(emptyState(), current, T0, false, false);
    expect(Object.keys(out.modelStates)).toEqual(["b"]);
  });
});

describe("three-way metadata merge", () => {
  it("applies executor changes, keeps concurrent user edits and takes token fields from the refresh", () => {
    const base = { access_token: "a1", refresh_token: "r1", priority: 1, prefix: "old", note: "x" };
    const current = { ...base, priority: 9, prefix: "user", disabled: true };

    const updated = {
      ...base,
      access_token: "a2",
      refresh_token: "r2",
      prefix: "exec",
      email: "me@x.com",
      extra: 1,
    };

    const merged = mergeRefreshedMetadata(base, current, updated);
    expect(merged).toMatchObject({
      access_token: "a2",
      refresh_token: "r2",
      priority: 9,
      prefix: "user",
      disabled: true,
      email: "me@x.com",
      extra: 1,
    });
  });

  it("only deletes keys the user did not touch", () => {
    const base = { a: 1, b: 2, expired: "x" };
    const merged = mergeRefreshedMetadata(base, { a: 5, b: 2, expired: "x" }, { a: 1 });
    expect(merged).toEqual({ a: 5 });
  });
});
