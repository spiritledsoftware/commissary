// Cooldown / quota state machine (`markResult`) and retry planning, ported from the Go conductor tests with an
// injected clock: conductor_cooldown_monotonic_test.go, conductor_quota_clock_test.go, cooldown_backoff_test.go,
// conductor_subsecond_cooldown_test.go, conductor_cloudflare_520_test.go, conductor_cooling_precedence_test.go,
// connection_lifecycle_cooldown_test.go, codex_model_not_found_cooldown_test.go, conductor_recent_requests_test.go,
// quota_signals_test.go, conductor_availability_test.go.
import { describe, expect, it } from "vitest";
import {
  type CooldownSettings,
  DEFAULT_COOLDOWN_SETTINGS,
  markResult,
  nextQuotaCooldown,
  quotaCooldownAfterFailure,
} from "../../src/credentials/cooldown/mark-result.ts";
import {
  isCloudflareChallengeError,
  isConnectionLifecycleError,
  isModelSupportError,
  isRequestFault,
  isProviderSpecificRequestError,
  isRequestInvalidError,
  isTransientTransportError,
  shouldSkipCredentialCooldown,
} from "../../src/credentials/cooldown/classify.ts";
import { collectQuotaSignals } from "../../src/credentials/cooldown/quota-signals.ts";
import { recentRequestsSnapshot } from "../../src/credentials/cooldown/recent-requests.ts";
import type { CredentialState } from "../../src/credentials/model.ts";
import { emptyState } from "../../src/credentials/model.ts";
import { isBlockedForModel } from "../../src/credentials/selection/availability.ts";
import type { ReportResult } from "../../src/credentials/selection/types.ts";
import { cred, NOW } from "../support/credentials.ts";

const MIN = 60_000;

const HOUR = 60 * MIN;

const credential = cred("auth", { provider: "claude" });

const mark = (
  state: CredentialState,
  model: string,
  result: ReportResult,
  options: { now?: number; settings?: CooldownSettings; metadata?: Record<string, unknown> } = {},
): CredentialState =>
  markResult({
    credential: { provider: "claude", metadata: (options.metadata ?? {}) as never },
    state,
    now: options.now ?? NOW,
    model,
    result,
    settings: options.settings ?? DEFAULT_COOLDOWN_SETTINGS,
  });

const fail = (
  httpStatus: number,
  message = "failure",
  extra: Partial<ReportResult> = {},
): ReportResult => ({
  success: false,
  httpStatus,
  error: { message, retryable: false, httpStatus },
  ...extra,
});

const blocked = (state: CredentialState, model: string, now: number) =>
  isBlockedForModel(credential, state, model, now).blocked;

describe("quota ladder (cooldown_backoff_test.go)", () => {
  it("doubles from 1 s up to 30 min and stops escalating at the cap", () => {
    expect(nextQuotaCooldown(0, false)).toEqual([1000, 1]);
    expect(nextQuotaCooldown(3, false)).toEqual([8000, 4]);
    expect(nextQuotaCooldown(20, false)).toEqual([30 * MIN, 20]);
    expect(nextQuotaCooldown(2, true)).toEqual([0, 2]);
  });

  it("an in-window failure reuses the window and level (once per window)", () => {
    const first = quotaCooldownAfterFailure({ nextRecoverAt: 0, backoffLevel: 0 }, NOW);
    expect(first).toEqual([NOW + 1000, 1]);
    expect(
      quotaCooldownAfterFailure({ nextRecoverAt: first[0], backoffLevel: 1 }, NOW + 100),
    ).toEqual(first);
    expect(
      quotaCooldownAfterFailure({ nextRecoverAt: first[0], backoffLevel: 1 }, NOW + 2000),
    ).toEqual([NOW + 2000 + 2000, 2]);
  });

  it("TestMarkResultQuotaBackoffEscalatesOncePerWindow / AfterWindowExpiry", () => {
    const quota = fail(429, "quota", {
      error: { code: "rate_limit", message: "quota", retryable: true, httpStatus: 429 },
    });

    let state = mark(emptyState(), "gpt-5", quota);
    expect(state.modelStates["gpt-5"]?.quota.backoffLevel).toBe(1);
    const window = state.modelStates["gpt-5"]?.quota.nextRecoverAt as number;
    expect(window).toBe(NOW + 1000);
    state = mark(state, "gpt-5", quota, { now: NOW + 100 });
    expect(state.modelStates["gpt-5"]?.quota).toMatchObject({
      backoffLevel: 1,
      nextRecoverAt: window,
    });
    expect(state.modelStates["gpt-5"]?.nextRetryAfter).toBe(window);

    // After the window expired the next failure escalates (level 3 -> 4).
    const expired: CredentialState = {
      ...emptyState(),
      modelStates: {
        "gpt-5": {
          status: "error",
          unavailable: true,
          nextRetryAfter: NOW - 1000,
          quota: { exceeded: true, reason: "quota", nextRecoverAt: NOW - 1000, backoffLevel: 3 },
          updatedAt: 0,
        },
      },
    };

    const escalated = mark(expired, "gpt-5", quota);
    expect(escalated.modelStates["gpt-5"]?.quota.backoffLevel).toBe(4);
    expect(escalated.modelStates["gpt-5"]?.quota.nextRecoverAt).toBe(NOW + 8000);
  });

  it("credential-level (no model) 429 follows the same ladder (TestApplyAuthFailureStateQuotaBackoffOncePerWindow)", () => {
    let state = mark(emptyState(), "", fail(429, "quota"));
    expect(state.quota).toMatchObject({
      exceeded: true,
      reason: "quota",
      backoffLevel: 1,
      nextRecoverAt: NOW + 1000,
    });
    expect(state.statusMessage).toBe("quota exhausted");
    state = mark(state, "", fail(429, "quota"), { now: NOW + 100 });
    expect(state.quota).toMatchObject({ backoffLevel: 1, nextRecoverAt: NOW + 1000 });
    state = mark(state, "", fail(429, "quota"), { now: NOW + 2000 });
    expect(state.quota.backoffLevel).toBe(2);
  });
});

describe("deadlines (conductor_quota_clock_test.go, conductor_subsecond_cooldown_test.go)", () => {
  it("explicit Retry-After sets both the retry and the recover deadline", () => {
    const state = mark(emptyState(), "gpt-5", fail(429, "quota", { retryAfterMs: HOUR }));
    expect(state.modelStates["gpt-5"]).toMatchObject({ nextRetryAfter: NOW + HOUR });
    expect(state.modelStates["gpt-5"]?.quota.nextRecoverAt).toBe(NOW + HOUR);
  });

  it("credential scope with an explicit Retry-After sets the auth-level deadlines", () => {
    const state = mark(
      emptyState(),
      "gpt-5",
      fail(429, "quota", { retryAfterMs: HOUR, credentialScoped: true }),
    );

    expect(state.nextRetryAfter).toBe(NOW + HOUR);
    expect(state.quota).toMatchObject({
      exceeded: true,
      reason: "credential_quota",
      nextRecoverAt: NOW + HOUR,
    });
  });

  it("a sub-second Retry-After is raised to the 10 s floor (model and credential level)", () => {
    const model = mark(emptyState(), "m", fail(429, "quota", { retryAfterMs: 500 }));
    expect(model.modelStates.m?.nextRetryAfter).toBe(NOW + 10_000);
    const auth = mark(emptyState(), "", fail(429, "quota", { retryAfterMs: 500 }));
    expect(auth.nextRetryAfter).toBe(NOW + 10_000);
    const longer = mark(emptyState(), "m", fail(429, "quota", { retryAfterMs: 90_000 }));
    expect(longer.modelStates.m?.nextRetryAfter).toBe(NOW + 90_000);
  });
});

describe("monotonic deadlines (conductor_cooldown_monotonic_test.go)", () => {
  const models = ["model-a", "model-b"];

  const prime = (): CredentialState => {
    let state = emptyState();

    for (const model of models) state = mark(state, model, { success: true });

    return state;
  };

  it("a credential-scoped 429 never shortens a sibling's longer deadline nor promotes it into the quota", () => {
    let state = mark(prime(), "model-b", fail(401, "long 401"));
    expect(state.modelStates["model-b"]?.nextRetryAfter).toBe(NOW + 30 * MIN);
    state = mark(
      state,
      "model-a",
      fail(429, "credential 429", { retryAfterMs: 5 * MIN, credentialScoped: true }),
    );
    expect(state.modelStates["model-b"]?.nextRetryAfter).toBe(NOW + 30 * MIN);
    // model-a only waits for the 5 minute credential quota, model-b keeps its 30 minutes.
    expect(blocked(state, "model-a", NOW + 6 * MIN)).toBe(false);
    expect(blocked(state, "model-b", NOW + 6 * MIN)).toBe(true);
  });

  it("a sibling's 12 h 404 is not promoted to its quota recover time", () => {
    let state = mark(prime(), "model-b", fail(404, "model not found"));
    expect(state.modelStates["model-b"]?.nextRetryAfter).toBe(NOW + 12 * HOUR);
    state = mark(
      state,
      "model-a",
      fail(429, "credential 429", { retryAfterMs: 5 * MIN, credentialScoped: true }),
    );
    expect(state.modelStates["model-b"]?.nextRetryAfter).toBe(NOW + 12 * HOUR);
    expect(state.modelStates["model-b"]?.quota.nextRecoverAt).toBe(NOW + 5 * MIN);
    state = mark(
      state,
      "model-b",
      fail(429, "credential 429", { retryAfterMs: 5 * MIN, credentialScoped: true }),
    );
    expect(state.modelStates["model-a"]?.nextRetryAfter).toBe(NOW + 5 * MIN);
    expect(state.quota.nextRecoverAt).toBe(NOW + 5 * MIN);
    expect(blocked(state, "model-a", NOW + 6 * MIN)).toBe(false);
    expect(blocked(state, "model-b", NOW + 6 * MIN)).toBe(true);
  });

  it.each([
    ["401 then short 429", fail(429, "short 429", { retryAfterMs: 2 * MIN })],
    ["401 then transient 500", fail(500, "transient 500")],
  ])("a later shorter failure keeps the longer model deadline (%s)", (_name, second) => {
    let state = mark(emptyState(), "model-a", fail(401, "long 401"));
    state = mark(state, "model-a", second);
    expect(state.modelStates["model-a"]?.nextRetryAfter).toBe(NOW + 30 * MIN);
  });

  it.each([
    ["404 then invalid_grant", fail(400, "invalid_grant")],
    ["404 then cloudflare", fail(403, "just a moment... cloudflare challenge")],
    ["404 then transient 500", fail(500, "internal server error")],
  ])("a shorter credential-level failure keeps the 12 h deadline (%s)", (_name, second) => {
    let state = mark(emptyState(), "", fail(404, "credential not found"));
    expect(state.nextRetryAfter).toBe(NOW + 12 * HOUR);
    state = mark(state, "", second);
    expect(state.nextRetryAfter).toBe(NOW + 12 * HOUR);
  });

  it("credential scope does not inherit the model's own quota deadline or backoff level", () => {
    let state = mark(
      emptyState(),
      "claude-fable",
      fail(429, "usage credits required", { retryAfterMs: 8 * 24 * HOUR }),
    );

    expect(state.quota).toMatchObject({ reason: "quota", nextRecoverAt: NOW + 8 * 24 * HOUR });
    state = mark(
      state,
      "claude-sonnet",
      fail(429, "shared window rejected", { retryAfterMs: 3 * HOUR, credentialScoped: true }),
    );
    expect(state.quota).toMatchObject({
      reason: "credential_quota",
      nextRecoverAt: NOW + 3 * HOUR,
    });
    expect(state.nextRetryAfter).toBe(NOW + 3 * HOUR);
    // The credential is blocked as a whole until the shared window ends.
    expect(blocked(state, "anything", NOW + 2 * HOUR)).toBe(true);
    expect(blocked(state, "anything", NOW + 3 * HOUR + 1)).toBe(false);
  });

  it("credential-scope backoff persists across windows without a Retry-After", () => {
    let state = mark(emptyState(), "m", fail(429, "shared", { credentialScoped: true }));
    expect(state.quota).toMatchObject({
      reason: "credential_quota",
      backoffLevel: 1,
      nextRecoverAt: NOW + 1000,
    });
    state = mark(state, "m", fail(429, "shared", { credentialScoped: true }), { now: NOW + 2000 });
    expect(state.quota).toMatchObject({ backoffLevel: 2, nextRecoverAt: NOW + 2000 + 2000 });
  });
});

describe("error table (MarkResult)", () => {
  it.each([
    [401, 30 * MIN],
    [402, 30 * MIN],
    [403, 30 * MIN],
    [404, 12 * HOUR],
    [500, MIN],
    [502, MIN],
    [503, MIN],
    [504, MIN],
    [408, MIN],
    [525, MIN],
    [418, MIN],
  ])("status %i cools the model for %i ms", (status, expected) => {
    const state = mark(emptyState(), "m", fail(status));
    expect(state.modelStates.m).toMatchObject({
      unavailable: true,
      status: "error",
      nextRetryAfter: NOW + expected,
    });
    expect(state.status).toBe("error");
  });

  it("model-support errors (400/404/422 + message) cool the model for 12 h and honour Retry-After", () => {
    const state = mark(
      emptyState(),
      "m",
      fail(400, '{"error":{"message":"The requested model is not supported."}}'),
    );

    expect(state.modelStates.m?.nextRetryAfter).toBe(NOW + 12 * HOUR);
    expect(
      mark(emptyState(), "m", fail(422, "unsupported model", { retryAfterMs: 5 * MIN })).modelStates
        .m?.nextRetryAfter,
    ).toBe(NOW + 5 * MIN);
  });

  it("codex structured model_not_found cools the model (codex_model_not_found_cooldown_test.go)", () => {
    const body = JSON.stringify({ error: { code: "model_not_found", message: "no" } });
    const state = mark(emptyState(), "gpt-9", fail(404, body));
    expect(state.modelStates["gpt-9"]?.nextRetryAfter).toBe(NOW + 12 * HOUR);
    expect(isModelSupportError({ status: 404, message: body })).toBe(true);
    // A generic 404 body is not a model problem; the generic 404 row still applies.
    expect(isModelSupportError({ status: 404, message: "Not Found" })).toBe(false);
  });

  it("cloudflare challenge: ladder with a 10 s floor, quota reason, StatusMessage", () => {
    const state = mark(
      emptyState(),
      "m",
      fail(403, "<html>Just a moment... Cloudflare challenge-platform</html>"),
    );

    expect(state.modelStates.m).toMatchObject({
      nextRetryAfter: NOW + 10_000,
      statusMessage: "cloudflare challenge",
    });
    expect(state.modelStates.m?.quota).toMatchObject({
      exceeded: true,
      reason: "cloudflare challenge",
      backoffLevel: 1,
    });
  });

  it("Cloudflare 520 origin errors are transient failures, never a challenge (conductor_cloudflare_520_test.go)", () => {
    const body = "cloudflare: just a moment, cf-mitigated";
    expect(isCloudflareChallengeError({ status: 520, message: body })).toBe(false);
    expect(isCloudflareChallengeError({ status: 403, message: body })).toBe(true);
    const state = mark(emptyState(), "m", fail(520, body));
    expect(state.modelStates.m).toMatchObject({ nextRetryAfter: NOW + MIN });
    expect(state.modelStates.m?.quota.exceeded).toBe(false);
  });

  it("transient-error-cooldown-seconds: custom, disabled (-1, also ignoring Retry-After), and hint wins", () => {
    const custom = mark(emptyState(), "m", fail(520), {
      settings: { disableCooling: false, transientErrorCooldownSeconds: 5 },
    });

    expect(custom.modelStates.m?.nextRetryAfter).toBe(NOW + 5000);
    const off = { disableCooling: false, transientErrorCooldownSeconds: -1 };

    for (const result of [fail(520), fail(503, "x", { retryAfterMs: 7000 })]) {
      const state = mark(emptyState(), "m", result, { settings: off });
      expect(state.modelStates.m).toMatchObject({ nextRetryAfter: 0, unavailable: false });
    }

    expect(mark(emptyState(), "", fail(520), { settings: off })).toMatchObject({
      nextRetryAfter: 0,
      unavailable: false,
    });
    expect(
      mark(emptyState(), "m", fail(503, "x", { retryAfterMs: 7000 })).modelStates.m?.nextRetryAfter,
    ).toBe(NOW + 7000);
    expect(mark(emptyState(), "", fail(520)).statusMessage).toBe("transient upstream error");
  });

  it("disable-cooling precedence: credential metadata beats the global switch (TestManagerMarkResultUsesCredentialCoolingPrecedence)", () => {
    const global = { disableCooling: true, transientErrorCooldownSeconds: 0 };
    expect(mark(emptyState(), "m", fail(429), { settings: global }).modelStates.m).toMatchObject({
      nextRetryAfter: 0,
      unavailable: false,
    });

    const override = mark(emptyState(), "m", fail(429), {
      settings: global,
      metadata: { disable_cooling: false },
    });

    expect(override.modelStates.m?.nextRetryAfter).toBe(NOW + 1000);
    const off = mark(emptyState(), "m", fail(429), { metadata: { disable_cooling: true } });
    expect(off.modelStates.m).toMatchObject({ nextRetryAfter: 0, unavailable: false });
    expect(off.modelStates.m?.quota.exceeded).toBe(false);
  });

  it("success resets the model and clears credential state when no model has errors", () => {
    let state = mark(emptyState(), "m", fail(500));
    expect(state.unavailable).toBe(true);
    state = mark(state, "m", { success: true }, { now: NOW + 1 });
    expect(state.modelStates.m).toMatchObject({
      unavailable: false,
      status: "active",
      nextRetryAfter: 0,
    });
    expect(state).toMatchObject({ unavailable: false, status: "active", success: 1, failed: 1 });
    expect(state.lastError).toBeUndefined();
  });

  it("an active credential_quota window survives a success", () => {
    let state = mark(
      emptyState(),
      "m",
      fail(429, "shared", { retryAfterMs: HOUR, credentialScoped: true }),
    );

    state = mark(state, "other", { success: true }, { now: NOW + 1000 });
    expect(state.quota.reason).toBe("credential_quota");
    expect(blocked(state, "x", NOW + 2000)).toBe(true);
  });

  it("force_cooldown cools even request-scoped codes and overrides disable-cooling; zero deadline gets 1 min", () => {
    const forced = fail(400, "stop", {
      error: { code: "force_cooldown", message: "stop", retryable: false, httpStatus: 400 },
    });

    const state = mark(emptyState(), "m", forced, { metadata: { disable_cooling: true } });
    expect(state.modelStates.m).toMatchObject({ unavailable: true, nextRetryAfter: NOW + MIN });
  });

  it("never cools: request-scoped, connection lifecycle and transient transport failures (connection_lifecycle_cooldown_test.go)", () => {
    for (const result of [
      fail(400, "bad request body", { requestScoped: true }),
      {
        success: false,
        error: { code: "connection_lifecycle", message: "context canceled", retryable: false },
      },
      {
        success: false,
        error: { code: "transient_transport", message: "connection reset", retryable: true },
      },
      { success: false, error: { message: "unexpected EOF", retryable: false } },
    ] satisfies ReportResult[]) {
      const state = mark(emptyState(), "m", result);
      expect(state.modelStates.m, JSON.stringify(result)).toBeUndefined();
      expect(state).toMatchObject({ failed: 1, unavailable: false });
    }

    // An HTTP status with lifecycle-looking text still cools.
    const withStatus = mark(emptyState(), "m", fail(503, "context canceled"));
    expect(withStatus.modelStates.m?.unavailable).toBe(true);
    expect(isConnectionLifecycleError({ status: 503, message: "context canceled" })).toBe(false);
    expect(isTransientTransportError({ status: 0, message: "Network connection lost." })).toBe(
      true,
    );
  });

  it("availability-neutral results (responses/compact) only count the request", () => {
    const state = mark(emptyState(), "m", fail(500, "x", { availabilityNeutral: true }));
    expect(state).toMatchObject({ failed: 1, unavailable: false, modelStates: {} });
  });

  it("redacts secrets in the stored error", () => {
    const state = mark(emptyState(), "m", fail(500, "failed with Bearer abcdefghijklmnop123"));
    expect(JSON.stringify(state)).not.toContain("abcdefghijklmnop123");
  });
});

describe("terminal unauthorized credentials stay blocked", () => {
  const terminal: CredentialState = {
    ...emptyState(),
    status: "error",
    unavailable: true,
    lastError: { message: "unauthorized", retryable: false, httpStatus: 401 },
  };

  it("a model failure does not make it selectable again; a success clears only the model state", () => {
    const failed = mark(terminal, "m", fail(429));
    expect(failed.unavailable).toBe(true);
    expect(failed.nextRetryAfter).toBe(0);
    expect(failed.lastError?.httpStatus).toBe(401);
    const ok = mark(terminal, "m", { success: true });
    expect(ok.unavailable).toBe(true);
  });
});

describe("classification", () => {
  it("request faults (internal/clienterror)", () => {
    expect(isRequestFault(400, "bad")).toBe(true);
    expect(isRequestFault(409, "x")).toBe(true);
    expect(isRequestFault(500, "x")).toBe(false);
    expect(isRequestFault(429, '{"error":{"code":"invalid_request_error"}}')).toBe(false);
    expect(isRequestFault(402, '{"error":{"code":"invalid_value"}}')).toBe(false);
    expect(
      isRequestFault(
        401,
        '{"error":{"type":"authentication_error","code":"invalid_request_error"}}',
      ),
    ).toBe(false);
    expect(isRequestFault(500, '{"error":{"code":"context_length_exceeded"}}')).toBe(true);
    expect(isRequestFault(404, '{"error":{"code":"model_not_found"}}')).toBe(false);
    expect(
      isRequestFault(
        404,
        "Item with id 'x' not found. Items are not persisted when `store` is set to false.",
      ),
    ).toBe(true);
    expect(
      isRequestFault(
        404,
        '{"error":{"type":"not_found_error","message":"thread state for previous_message_id gone"}}',
      ),
    ).toBe(true);
  });

  it("request-invalid excludes challenges, invalid grants and model-support errors", () => {
    expect(isRequestInvalidError({ status: 400, message: "bad" })).toBe(true);
    expect(isRequestInvalidError({ status: 400, message: "invalid_grant" })).toBe(false);
    expect(isRequestInvalidError({ status: 400, message: "unsupported model" })).toBe(false);
    expect(isRequestInvalidError({ status: 429, message: "x", code: "request_scoped" })).toBe(true);
    expect(shouldSkipCredentialCooldown({ status: 400, message: "bad" })).toBe(true);
    expect(
      shouldSkipCredentialCooldown({ status: 400, message: "bad", code: "force_cooldown" }),
    ).toBe(false);
  });
});

describe("provider-specific request errors (issue #185)", () => {
  it("an upstream 400 or 422 may be specific to one provider", () => {
    expect(isProviderSpecificRequestError({ status: 400, message: "bad" })).toBe(true);
    expect(
      isProviderSpecificRequestError({
        status: 400,
        message:
          '{"type":"error","error":{"type":"invalid_request_error","message":"x: Extra inputs are not permitted"}}',
      }),
    ).toBe(true);
    expect(isProviderSpecificRequestError({ status: 422, message: "bad" })).toBe(true);
  });

  it("other request faults and Commissary's own request-scoped errors stay with the request", () => {
    expect(isProviderSpecificRequestError({ status: 409, message: "bad" })).toBe(false);
    expect(isProviderSpecificRequestError({ status: 413, message: "bad" })).toBe(false);
    expect(
      isProviderSpecificRequestError({ status: 404, message: "bad", code: "request_scoped" }),
    ).toBe(false);
    expect(
      isProviderSpecificRequestError({ status: 400, message: "bad", code: "request_scoped" }),
    ).toBe(false);
  });

  it("errors that are not request faults at all are not provider-specific request errors", () => {
    expect(isProviderSpecificRequestError({ status: 400, message: "invalid_grant" })).toBe(false);
    expect(isProviderSpecificRequestError({ status: 400, message: "unsupported model" })).toBe(
      false,
    );
    expect(isProviderSpecificRequestError({ status: 429, message: "bad" })).toBe(false);
    expect(isProviderSpecificRequestError({ status: 0, message: "bad" })).toBe(false);
  });
});

describe("passive quota signals and recent requests", () => {
  it("collects bounded, canonical-cased signals per provider", () => {
    expect(
      collectQuotaSignals("claude", {
        "anthropic-ratelimit-unified-5h-utilization": "0.5",
        "retry-after": "3",
        "x-codex-plan-type": "plus",
        "content-type": "json",
      }),
    ).toEqual({ "Anthropic-Ratelimit-Unified-5h-Utilization": "0.5", "Retry-After": "3" });
    expect(
      collectQuotaSignals("codex", {
        "x-codex-primary-used-percent": "10",
        "x-codex-plan-type": "pro",
      }),
    ).toEqual({
      "X-Codex-Plan-Type": "pro",
      "X-Codex-Primary-Used-Percent": "10",
    });
    expect(collectQuotaSignals("claude", { "retry-after": "bad\nvalue" })).toBeUndefined();
    expect(collectQuotaSignals("gemini", { "retry-after": "3" })).toBeUndefined();
  });

  it("markResult replaces the snapshot only when headers qualify and keeps cooldown fields", () => {
    let state = mark(
      emptyState(),
      "m",
      fail(429, "q", { headers: { "retry-after": "30" }, retryAfterMs: 30_000 }),
    );

    expect(state.quota.signals).toEqual({ "Retry-After": "30" });
    expect(state.quota.observedAt).toBe(NOW);
    expect(state.modelStates.m?.quota.signals).toEqual({ "Retry-After": "30" });
    state = mark(state, "m", fail(500), { now: NOW + 1 });
    expect(state.quota.signals).toEqual({ "Retry-After": "30" });
    state = mark(state, "m", { success: true, headers: { "retry-after": "0" } }, { now: NOW + 2 });
    expect(state.quota.signals).toEqual({ "Retry-After": "0" });

    const skipped = mark(state, "m", {
      success: true,
      skipQuotaObservation: true,
      headers: { "retry-after": "9" },
    });

    expect(skipped.quota.signals).toEqual({ "Retry-After": "0" });
  });

  it("keeps a 20 x 10 min ring (conductor_recent_requests_test.go)", () => {
    let state = emptyState();
    state = mark(state, "m", { success: true }, { now: NOW });
    state = mark(state, "m", fail(400, "x", { requestScoped: true }), { now: NOW + 1000 });
    state = mark(state, "m", { success: true }, { now: NOW + 11 * MIN });
    const snapshot = recentRequestsSnapshot(state.recentRequests, NOW + 11 * MIN);
    expect(snapshot).toHaveLength(20);
    expect(snapshot.at(-1)).toMatchObject({ success: 1, failed: 0 });
    expect(snapshot.at(-2)).toMatchObject({ success: 1, failed: 1 });
    expect(
      recentRequestsSnapshot(state.recentRequests, NOW + 300 * MIN).every(
        (entry) => entry.success === 0,
      ),
    ).toBe(true);
  });
});
