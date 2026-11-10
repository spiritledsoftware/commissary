// End-to-end tests (workerd) of the Claude rate-limit handling on the request pipeline (CLIProxyAPI 0130d6f3, db1bab01,
// e458999b): Fable-only 429s stay model-scoped, per-minute 429s cool for their short Retry-After, and a model-cooldown
// 429 names its reset time (claude_executor_fable_ratelimit_test.go, claude_request_rate_test.go,
// code_handlers_cooldown_test.go TestClaudeCooldownMessagesRoute).
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { modelCooldown } from "../src/credentials/selection/failures.ts";
import { pickFailureError } from "../src/executor/control-plane-picker.ts";
import { CredentialPicker } from "../src/executor/picker.ts";
import { ModelProviders } from "../src/handlers/model-providers.ts";
import type { JsonObject } from "@commissary/json";
import { oauthPipeline } from "./support/claude-oauth.ts";
import { jsonResponse, loadConfig, makePipeline, postJson } from "./support/pipeline.ts";

const request = (model: string, extra: JsonObject = {}) =>
  postJson({
    model,
    max_tokens: 32,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });

const OK = {
  id: "msg_ok",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const weeklyReset = () => String(Math.floor(Date.now() / 1000) + 6 * 24 * 3600);

describe("Fable-only 429 without 5h headers", () => {
  it("stays model-scoped, so the same credential still serves Opus", async () => {
    const reset = weeklyReset();

    const h = oauthPipeline(
      (call) => {
        if (call.body.includes('"model":"claude-fable-5-1"')) {
          return jsonResponse(
            {
              type: "error",
              error: {
                type: "rate_limit_error",
                message: "This request would exceed your account's rate limit.",
              },
            },
            {
              status: 429,
              headers: {
                "retry-after": "546534",
                "anthropic-ratelimit-unified-status": "rejected",
                "anthropic-ratelimit-unified-representative-claim": "seven_day_overage_included",
                "anthropic-ratelimit-unified-7d-status": "allowed",
                "anthropic-ratelimit-unified-7d-utilization": "0.62",
                "anthropic-ratelimit-unified-7d_oi-status": "rejected",
                "anthropic-ratelimit-unified-overage-status": "rejected",
                "anthropic-ratelimit-unified-reset": reset,
              },
            },
          );
        }

        return jsonResponse(OK);
      },
      await loadConfig(""),
    );

    afterAll(h.pipeline.dispose);
    expect((await h.pipeline.call("/v1/messages", request("claude-fable-5-1"))).status).toBe(429);
    // Not credential-scoped, and no ~6 day weekly cooldown carried to the conductor.
    expect(h.reports[0]).toMatchObject({ success: false, httpStatus: 429 });
    expect((h.reports[0] as { credentialScoped?: boolean }).credentialScoped).not.toBe(true);
    expect((h.reports[0] as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();

    const opus = await h.pipeline.call("/v1/messages", request("claude-opus-5-5"));

    expect(opus.status).toBe(200);
    expect(h.reports[1]).toMatchObject({ success: true });
  });
});

describe("per-minute 429", () => {
  const perMinute = {
    type: "error",
    error: {
      type: "rate_limit_error",
      message:
        "This request would exceed the requests per minute rate limit. Please try again later.",
    },
  };

  const headers = () => ({
    "retry-after": "30",
    "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 4 * 3600),
  });

  it("cools for the short Retry-After instead of the unified reset", async () => {
    const h = oauthPipeline(
      () => jsonResponse(perMinute, { status: 429, headers: headers() }),
      await loadConfig(""),
    );

    afterAll(h.pipeline.dispose);
    expect((await h.pipeline.call("/v1/messages", request("claude-sonnet-4-5"))).status).toBe(429);
    const retryAfterMs = (h.reports[0] as { retryAfterMs?: number }).retryAfterMs ?? 0;

    // 30 s plus 1-30 s of fuzz (the 4 h unified reset is ignored).
    expect(retryAfterMs).toBeGreaterThanOrEqual(31_000);
    expect(retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("does the same on the Fast mode direct path", async () => {
    const h = oauthPipeline(
      () => jsonResponse(perMinute, { status: 429, headers: headers() }),
      await loadConfig(""),
    );

    afterAll(h.pipeline.dispose);

    const response = await h.pipeline.call(
      "/v1/messages",
      request("claude-sonnet-4-5", { speed: "fast" }),
    );

    expect(response.status).toBe(429);
    expect(JSON.parse(await response.text())).toEqual(perMinute);
    expect(h.reports[0]).toMatchObject({ success: false, httpStatus: 429 });
    const retryAfterMs = (h.reports[0] as { retryAfterMs?: number }).retryAfterMs ?? 0;

    expect(retryAfterMs).toBeGreaterThanOrEqual(31_000);
    expect(retryAfterMs).toBeLessThanOrEqual(60_000);
  });
});

describe("model-cooldown 429 reset hint", () => {
  const MESSAGE =
    "All credentials for model claude-sonnet-4-5 are cooling down via provider claude";

  const cooling = Layer.succeed(
    CredentialPicker,
    CredentialPicker.of({
      pick: () =>
        Effect.fail(pickFailureError(modelCooldown("claude-sonnet-4-5", "claude", 8_250_000))),
      report: () => Effect.void,
      planRetry: () => Effect.succeed({ retry: false }),
    }),
  );

  const providers = Layer.succeed(
    ModelProviders,
    ModelProviders.of({
      providersFor: () => Effect.succeed(["claude"]),
      firstAvailableModel: Effect.succeed("claude-sonnet-4-5"),
    }),
  );

  it.each([false, true])("names the reset time (stream: %s)", async (stream) => {
    const p = makePipeline({
      config: await loadConfig(""),
      respond: () => jsonResponse(OK),
      credentialPicker: cooling,
      modelProviders: providers,
    });

    afterAll(p.dispose);
    const response = await p.call("/v1/messages", request("claude-sonnet-4-5", { stream }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("8250");
    const body = JSON.parse(await response.text()) as { error: { type: string; message: string } };

    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toBe(`${MESSAGE} (reset after 2h17m30s)`);
    expect(p.calls).toHaveLength(0);
  });
});
