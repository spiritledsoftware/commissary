// OpenCode Go usage quotas, pure parts: the `/usage` payload as quota windows, the probe target of a config key, the
// Accounts entry of a config key, and the usage-limit errors with their reset parsing.
import { describe, expect, it } from "vitest";
import { emptyState } from "../src/credentials/model.ts";
import { synthesizeConfigCredentials } from "../src/credentials/synthesize.ts";
import {
  openCodeStreamEventError,
  openCodeUpstreamError,
} from "../src/executor/opencode/errors.ts";
import { OPENCODE_GO, OPENCODE_ZEN } from "../src/executor/opencode/providers.ts";
import {
  OPENCODE_LIMIT_DEFAULT_COOLDOWN_MS,
  OPENCODE_LIMIT_MAX_COOLDOWN_MS,
  openCodeUsageLimit,
  parseResetsInMs,
} from "../src/executor/opencode/usage-limit.ts";
import { buildConfigCredentialEntry } from "../src/management/credential-entry.ts";
import {
  OPENCODE_GO_WINDOWS,
  openCodeGoUsageUrl,
  parseOpenCodeGoUsage,
} from "../src/quota/opencode-go.ts";
import {
  CONFIG_QUOTA_PROVIDERS,
  isConfigQuotaProvider,
  isQuotaProvider,
} from "../src/quota/report.ts";
import { buildQuotaTarget } from "../src/quota/target.ts";
import { loadConfig } from "./support/pipeline.ts";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");

const USAGE = {
  usage: {
    rolling: { status: "ok", percent: 12, resetsAt: "2026-10-12T14:28:13.000Z" },
    weekly: { status: "ok", percent: 40, resetsAt: "2026-10-19T00:00:00.000Z" },
    monthly: { status: "ok", percent: 0, resetsAt: "2026-11-05T10:59:17.000Z" },
  },
};

describe("OpenCode Go usage payload", () => {
  it("maps rolling, weekly and monthly onto the 5-hour, weekly and monthly windows", () => {
    expect(parseOpenCodeGoUsage(USAGE)).toEqual([
      {
        id: "five_hour",
        label: "5-hour",
        used_percent: 12,
        resets_at: "2026-10-12T14:28:13.000Z",
        window_seconds: 18_000,
      },
      {
        id: "weekly",
        label: "Weekly",
        used_percent: 40,
        resets_at: "2026-10-19T00:00:00.000Z",
        window_seconds: 604_800,
      },
      {
        id: "monthly",
        label: "Monthly",
        used_percent: 0,
        resets_at: "2026-11-05T10:59:17.000Z",
        window_seconds: 2_592_000,
      },
    ]);
    expect(OPENCODE_GO_WINDOWS.map((window) => window.key)).toEqual([
      "rolling",
      "weekly",
      "monthly",
    ]);
  });

  it("reads a status other than ok as a used-up window, keeping a higher share", () => {
    const windows = parseOpenCodeGoUsage({
      usage: {
        rolling: { status: "limited", percent: 87, resetsAt: "2026-10-12T14:28:13.000Z" },
        weekly: { status: "exhausted" },
        monthly: { status: "OK", percent: "33.5" },
      },
    });

    expect(windows?.map((window) => [window.id, window.used_percent])).toEqual([
      ["five_hour", 100],
      ["weekly", 100],
      ["monthly", 33.5],
    ]);
    expect(windows?.[1]?.resets_at).toBeUndefined();
  });

  it("leaves out windows without a share and rejects payloads without any window", () => {
    expect(
      parseOpenCodeGoUsage({ usage: { rolling: { status: "ok" }, weekly: { percent: 5 } } })?.map(
        (window) => window.id,
      ),
    ).toEqual(["weekly"]);

    for (const malformed of [
      {},
      { usage: null },
      { usage: [] },
      { usage: { rolling: "full" } },
      { usage: { rolling: { status: "ok", percent: "lots" } } },
      [],
      "usage",
      null,
    ])
      expect(parseOpenCodeGoUsage(malformed)).toBeUndefined();
  });

  it("derives the usage URL from the base URL", () => {
    expect(openCodeGoUsageUrl("https://opencode.ai/inference/go/v1")).toBe(
      "https://opencode.ai/inference/go/v1/usage",
    );
    expect(openCodeGoUsageUrl(" https://proxy.example/go/v1// ")).toBe(
      "https://proxy.example/go/v1/usage",
    );
  });
});

const CONFIG = `api-keys:
  opencode-go:
    - keys:
        - api-key: sk-go-one
    - base-url: https://proxy.example/go/v1/
      keys:
        - api-key: sk-go-two
          excluded-models: ["*"]
    - base-url: https://opencode.ai/zen/go/v1
      keys:
        - api-key: sk-go-three
  opencode-zen:
    - keys:
        - api-key: sk-zen-one
`;

const credentials = async () => synthesizeConfigCredentials(await loadConfig(CONFIG), NOW);

describe("OpenCode Go quota target and listing", () => {
  it("lists only OpenCode Go among the config key kinds", () => {
    expect(CONFIG_QUOTA_PROVIDERS).toEqual(["opencode-go"]);
    expect(isQuotaProvider(OPENCODE_GO)).toBe(true);
    expect(isConfigQuotaProvider(OPENCODE_ZEN)).toBe(false);
    expect(isConfigQuotaProvider("codex")).toBe(false);
  });

  it("builds the target from the config key and its base URL", async () => {
    const [first, second, third] = (await credentials()).filter(
      (credential) => credential.provider === OPENCODE_GO,
    );

    expect(buildQuotaTarget(first!, OPENCODE_GO)).toEqual({
      ok: true,
      target: {
        id: first!.id,
        provider: OPENCODE_GO,
        token: "sk-go-one",
        usageUrl: "https://opencode.ai/inference/go/v1/usage",
      },
    });
    expect(buildQuotaTarget(second!, OPENCODE_GO)).toMatchObject({
      ok: true,
      target: { token: "sk-go-two", usageUrl: "https://proxy.example/go/v1/usage" },
    });
    // An explicit base URL on the old `/zen` path is kept as written (#178: only the default moved).
    expect(buildQuotaTarget(third!, OPENCODE_GO)).toMatchObject({
      ok: true,
      target: { token: "sk-go-three", usageUrl: "https://opencode.ai/zen/go/v1/usage" },
    });

    const keyless = { ...first!, attributes: { ...first!.attributes, api_key: " " } };

    expect(buildQuotaTarget(keyless, OPENCODE_GO)).toMatchObject({
      ok: false,
      error: "unavailable",
    });
  });

  it("builds an Accounts entry named by the auth_index, with the key masked and nowhere else", async () => {
    const [first, second] = (await credentials()).filter(
      (credential) => credential.provider === OPENCODE_GO,
    );

    const state = {
      ...emptyState(),
      statusMessage: "Unauthorized: sk-go-one rejected",
    };

    const entry = buildConfigCredentialEntry(first!, state, NOW, () => "0123456789abcdef", {
      family: "opencode-go",
      index: 0,
    });

    expect(entry).toMatchObject({
      id: "0123456789abcdef",
      auth_index: "0123456789abcdef",
      name: "0123456789abcdef",
      provider: "opencode-go",
      source: "config",
      runtime_only: false,
      supports_quota: true,
      disabled: false,
      key_group: { family: "opencode-go", index: 0 },
    });
    expect(entry.account).toBe("[redacted]…-one");
    expect(entry.status_message).toBe("Unauthorized: [redacted] rejected");

    const serialized = JSON.stringify(entry);

    expect(serialized).not.toContain("sk-go-one");
    expect(serialized).not.toContain(first!.id);

    // `*` in the key's excluded-models is how a config key is disabled.
    expect(
      buildConfigCredentialEntry(second!, emptyState(), NOW, () => "fedcba9876543210", undefined),
    ).toMatchObject({ disabled: true, status: "disabled" });
  });
});

const limitBody = (message: string, limitName?: string) =>
  JSON.stringify({
    type: "error",
    error: { type: "GoUsageLimitError", message },
    ...(limitName === undefined ? {} : { metadata: { workspace: "wrk_1", limitName } }),
  });

const plainError = (type: string, message: string) =>
  JSON.stringify({ type: "error", error: { type, message } });

const FIVE_HOUR =
  "5-hour usage limit reached. Resets in 2hr 13min. To continue using this model now, …";

describe("OpenCode Go usage limits", () => {
  it("parses the reset durations of the limit messages", () => {
    expect(parseResetsInMs(FIVE_HOUR)).toBe((2 * 60 + 13) * 60_000);
    expect(parseResetsInMs("Weekly usage limit reached. Resets in 3 days. To continue …")).toBe(
      3 * 86_400_000,
    );
    expect(parseResetsInMs("Monthly usage limit reached. Resets in 1 day.")).toBe(86_400_000);
    expect(parseResetsInMs("Resets in 45min")).toBe(45 * 60_000);
    expect(parseResetsInMs("Resets in 2h 13m")).toBe((2 * 60 + 13) * 60_000);
    expect(parseResetsInMs("Resets in 1.5 hours.")).toBe(90 * 60_000);
    // The capture ends at "To continue" even without a period, so later figures do not count.
    expect(parseResetsInMs("Resets in 2hr To continue, add 5 days of balance")).toBe(2 * 3_600_000);
    expect(parseResetsInMs("usage limit reached")).toBeUndefined();
    expect(parseResetsInMs("Resets in soon")).toBeUndefined();
  });

  it("recognises the limit by its type, or by a leading message on a 402/403/429, with the window", () => {
    expect(openCodeUsageLimit(500, limitBody(FIVE_HOUR, "5 hour"), new Headers(), NOW)).toEqual({
      window: "five_hour",
      retryAfterMs: (2 * 60 + 13) * 60_000,
    });

    expect(
      openCodeUsageLimit(
        403,
        plainError("api_error", "Weekly usage limit reached. Resets in 3 days."),
        new Headers(),
        NOW,
      ),
    ).toEqual({ window: "weekly", retryAfterMs: 3 * 86_400_000 });

    expect(
      openCodeUsageLimit(402, "Monthly usage limit reached. Resets in 4 days.", new Headers(), NOW),
    ).toEqual({ window: "monthly", retryAfterMs: 4 * 86_400_000 });
  });

  it("does not take an echo of the phrase, or the phrase on another status, for a limit", () => {
    const echoed = plainError(
      "invalid_request_error",
      'Invalid prompt: "5-hour usage limit reached. Resets in 2hr."',
    );

    for (const status of [400, 403, 429])
      expect(openCodeUsageLimit(status, echoed, new Headers(), NOW)).toBeUndefined();

    expect(
      openCodeUsageLimit(400, plainError("api_error", FIVE_HOUR), new Headers(), NOW),
    ).toBeUndefined();
    expect(
      openCodeUsageLimit(
        429,
        plainError("rate_limit_error", "Too many requests"),
        new Headers(),
        NOW,
      ),
    ).toBeUndefined();
  });

  it("takes the longer of Retry-After and the message, the default without either, and clamps", () => {
    const body = limitBody("Weekly usage limit reached. Resets in 3 days.", "weekly");

    expect(
      openCodeUsageLimit(429, body, new Headers({ "retry-after": "7200" }), NOW)?.retryAfterMs,
    ).toBe(3 * 86_400_000);
    expect(
      openCodeUsageLimit(429, body, new Headers({ "retry-after": String(4 * 86_400) }), NOW)
        ?.retryAfterMs,
    ).toBe(4 * 86_400_000);
    expect(
      openCodeUsageLimit(429, limitBody("Usage limit reached."), new Headers(), NOW)?.retryAfterMs,
    ).toBe(OPENCODE_LIMIT_DEFAULT_COOLDOWN_MS);
    expect(
      openCodeUsageLimit(429, body, new Headers({ "retry-after": "999999999" }), NOW)?.retryAfterMs,
    ).toBe(OPENCODE_LIMIT_MAX_COOLDOWN_MS);
    expect(
      openCodeUsageLimit(
        429,
        limitBody("Monthly usage limit reached. Resets in 400 days."),
        new Headers(),
        NOW,
      )?.retryAfterMs,
    ).toBe(OPENCODE_LIMIT_MAX_COOLDOWN_MS);
  });

  it("classifies a Go limit as a credential-scoped 429 whatever the status, and never a Zen answer", () => {
    for (const status of [429, 403, 402]) {
      const error = openCodeUpstreamError({
        provider: OPENCODE_GO,
        status,
        body: limitBody(FIVE_HOUR, "5 hour"),
        headers: new Headers({ "retry-after": "8000" }),
        nowMs: NOW,
      });

      expect(error).toMatchObject({ status: 429, credentialScoped: true, retryAfterMs: 8_000_000 });
      expect(error.code).toBeUndefined();
    }

    const zen = openCodeUpstreamError({
      provider: OPENCODE_ZEN,
      status: 403,
      body: limitBody(FIVE_HOUR, "5 hour"),
      headers: new Headers(),
      nowMs: NOW,
    });

    expect(zen.status).toBe(403);
    expect(zen.credentialScoped).toBeUndefined();
  });

  it("classifies a limit in a Responses stream error event", () => {
    const event = {
      type: "error",
      error: { type: "GoUsageLimitError", message: FIVE_HOUR },
      metadata: { limitName: "5 hour" },
    };

    const error = openCodeStreamEventError(OPENCODE_GO)(event, JSON.stringify(event), NOW);

    expect(error).toMatchObject({
      status: 429,
      credentialScoped: true,
      retryAfterMs: (2 * 60 + 13) * 60_000,
    });
    expect(openCodeStreamEventError(OPENCODE_ZEN)(event, JSON.stringify(event), NOW)).toMatchObject(
      { status: 502 },
    );
  });
});
