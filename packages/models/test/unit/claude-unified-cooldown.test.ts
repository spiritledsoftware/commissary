// Claude unified rate-limit headers on local cooldown 429s (Go: conductor_selection_cooldown_test.go,
// code_handlers_cooldown_test.go; upstream cb70eacf): the rejected signals a 429 recorded, and the headers of the
// model_cooldown failure when every credential is cooling on a Claude quota.
import { describe, expect, it } from "vite-plus/test";
import {
  claudeUnifiedCooldown,
  claudeUnifiedCooldownHeaders,
} from "../../src/credentials/cooldown/claude-unified.ts";
import {
  DEFAULT_COOLDOWN_SETTINGS,
  markResult,
} from "../../src/credentials/cooldown/mark-result.ts";
import type { CredentialState } from "../../src/credentials/model.ts";
import type { ReportResult } from "../../src/credentials/selection/types.ts";
import {
  cooling,
  cred,
  defaultSettings,
  entry,
  Harness,
  NOW,
  state,
} from "../support/credentials.ts";

const HOUR = 60 * 60_000;

const reset = (seconds: number) => String(Math.floor(NOW / 1000) + seconds);

const REJECTED_5H = {
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-5h-status": "rejected",
  "anthropic-ratelimit-unified-5h-utilization": "1.0",
};

const quota429 = (headers?: Record<string, string>, retryAfterMs?: number): ReportResult => ({
  success: false,
  httpStatus: 429,
  error: { message: "rate limited", retryable: false, httpStatus: 429 },
  ...(headers === undefined ? {} : { headers }),
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

const mark = (
  previous: CredentialState,
  result: ReportResult,
  provider = "claude",
  now = NOW,
): CredentialState =>
  markResult({
    credential: { provider, metadata: {} },
    state: previous,
    now,
    model: "claude-sonnet-4-5",
    result,
    settings: DEFAULT_COOLDOWN_SETTINGS,
  });

describe("claudeUnifiedCooldownHeaders", () => {
  it("guesses the five-hour or seven-day window without recorded signals", () => {
    expect(claudeUnifiedCooldownHeaders(undefined, 7200, NOW)).toEqual({
      "Anthropic-Ratelimit-Unified-Status": "rejected",
      "Anthropic-Ratelimit-Unified-Reset": reset(7200),
      "Anthropic-Ratelimit-Unified-Representative-Claim": "five_hour",
      "Anthropic-Ratelimit-Unified-Overage-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Reset": reset(7200),
    });
    expect(
      claudeUnifiedCooldownHeaders(undefined, 6 * 3600, NOW)[
        "Anthropic-Ratelimit-Unified-Representative-Claim"
      ],
    ).toBe("seven_day");
    expect(claudeUnifiedCooldownHeaders(undefined, 0, NOW)).toEqual({});
  });

  it("keeps the recorded windows and aligns their reset with Retry-After", () => {
    const headers = claudeUnifiedCooldownHeaders(
      {
        "Anthropic-Ratelimit-Unified-Status": "rejected",
        "Anthropic-Ratelimit-Unified-7d-Status": "rejected",
        "Anthropic-Ratelimit-Unified-7d-Reset": "1",
        "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
        "Retry-After": "99",
      },
      7823,
      NOW,
    );

    expect(headers).toMatchObject({
      "Anthropic-Ratelimit-Unified-Status": "rejected",
      "Anthropic-Ratelimit-Unified-Reset": reset(7823),
      "Anthropic-Ratelimit-Unified-7d-Reset": reset(7823),
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
      "Anthropic-Ratelimit-Unified-Representative-Claim": "seven_day",
      "Anthropic-Ratelimit-Unified-Overage-Status": "rejected",
    });
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("reports an overage-only rejection as the overage claim", () => {
    const headers = claudeUnifiedCooldownHeaders(
      {
        "Anthropic-Ratelimit-Unified-Status": "rejected",
        "Anthropic-Ratelimit-Unified-Overage-Status": "rejected",
        "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
        "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
      },
      60,
      NOW,
    );

    expect(headers["Anthropic-Ratelimit-Unified-Representative-Claim"]).toBe("overage");
    expect(headers["Anthropic-Ratelimit-Unified-5h-Reset"]).toBeUndefined();
  });
});

describe("retained cooldown signals", () => {
  it("records the rejected unified headers of a Claude 429 and keeps them through a later 429 without them", () => {
    const first = mark(state(), quota429(REJECTED_5H, 2 * HOUR));
    const model = first.modelStates["claude-sonnet-4-5"];

    expect(model?.quota.cooldownSignals).toMatchObject({
      "Anthropic-Ratelimit-Unified-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
    });
    expect(claudeUnifiedCooldown("claude", first, "claude-sonnet-4-5", NOW).claude).toBe(true);

    // A burst 429 inside the open window keeps the window and its signals.
    const second = mark(first, quota429(), "claude", NOW + 1000);

    expect(second.modelStates["claude-sonnet-4-5"]?.quota.cooldownSignals).toEqual(
      model?.quota.cooldownSignals,
    );
  });

  it("does not count an ordinary rate limit, another provider or a cloudflare challenge", () => {
    const perMinute = mark(state(), quota429({ "retry-after": "30" }, 30_000));

    expect(perMinute.modelStates["claude-sonnet-4-5"]?.quota.cooldownEvaluated).toBe(true);
    expect(claudeUnifiedCooldown("claude", perMinute, "claude-sonnet-4-5", NOW).claude).toBe(false);

    const codex = mark(state(), quota429(REJECTED_5H, HOUR), "codex");

    expect(codex.modelStates["claude-sonnet-4-5"]?.quota.cooldownSignals).toBeUndefined();
    expect(claudeUnifiedCooldown("codex", codex, "claude-sonnet-4-5", NOW).claude).toBe(false);
  });

  it("falls back to the passive signals of a cooldown that was never evaluated", () => {
    const next = NOW + HOUR;

    const credentialQuota = state({
      unavailable: true,
      nextRetryAfter: next,
      quota: {
        exceeded: true,
        reason: "credential_quota",
        nextRecoverAt: next,
        backoffLevel: 0,
        signals: { "Anthropic-Ratelimit-Unified-Status": "rejected" },
      },
    });

    expect(claudeUnifiedCooldown("claude", credentialQuota, "m", NOW)).toEqual({
      claude: true,
      signals: { "Anthropic-Ratelimit-Unified-Status": "rejected" },
    });
  });
});

describe("model_cooldown failure", () => {
  const h = () => new Harness({ ...defaultSettings, strategy: "fill-first" });
  const next = NOW + 2 * HOUR;

  const claudeCooling = state({
    modelStates: {
      "claude-sonnet-4-5": {
        ...cooling(next, true),
        quota: {
          exceeded: true,
          reason: "quota",
          nextRecoverAt: next,
          backoffLevel: 0,
          cooldownEvaluated: true,
          cooldownSignals: { "Anthropic-Ratelimit-Unified-5h-Status": "rejected" },
        },
      },
    },
  });

  it("carries the unified headers when every candidate cools on a Claude quota", () => {
    const outcome = h().select(
      [
        entry(cred("a", { provider: "claude" }), claudeCooling),
        entry(cred("b", { provider: "claude" }), claudeCooling),
      ],
      { model: "claude-sonnet-4-5", providers: ["claude"] },
    );

    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.retryAfterSeconds).toBe(7200);
    expect(outcome.failure.headers).toMatchObject({
      "Anthropic-Ratelimit-Unified-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Reset": reset(7200),
      "Anthropic-Ratelimit-Unified-Representative-Claim": "five_hour",
    });
  });

  it("carries none when a candidate cools for another reason", () => {
    const outcome = h().select(
      [
        entry(cred("a", { provider: "claude" }), claudeCooling),
        entry(
          cred("b", { provider: "claude" }),
          state({ modelStates: { "claude-sonnet-4-5": cooling(next, true) } }),
        ),
      ],
      { model: "claude-sonnet-4-5", providers: ["claude"] },
    );

    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.code).toBe("model_cooldown");
    expect(outcome.failure.headers).toBeUndefined();
  });
});
