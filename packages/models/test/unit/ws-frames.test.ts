// Terminal error frames of the Responses WebSocket: which failures reach the client and the frame they get
// (CLIProxyAPI b5e6027c: shouldExposeResponsesUpstreamError, buildResponsesWebsocketErrorPayload).
import { describe, expect, it } from "vitest";
import { ExecutionError } from "../../src/executor/errors.ts";
import {
  buildErrorPayload,
  isQuotaOrCooldownError,
  shouldExposeError,
} from "../../src/handlers/responses/websocket/frames.ts";

const failure = (fields: ConstructorParameters<typeof ExecutionError>[0]) =>
  new ExecutionError(fields);

describe("shouldExposeError", () => {
  it("exposes a 429, a quota failure and a model cooldown, however they are shaped", () => {
    expect(shouldExposeError(failure({ status: 429, message: "slow down" }))).toBe(true);

    for (const body of [
      { error: { type: "usage_limit_reached" } },
      { error: { code: "model_cooldown" } },
      { type: "usage_limit_reached" },
      { code: "model_cooldown" },
      { response: { error: { type: "usage_limit_reached" } } },
      { body: { error: { code: "usage_limit_reached" } } },
    ]) {
      expect(shouldExposeError(failure({ status: 500, message: JSON.stringify(body) }))).toBe(true);
    }

    expect(shouldExposeError(failure({ status: 503, code: "model_cooldown", message: "x" }))).toBe(
      true,
    );
  });

  it("keeps other credential and transport failures silent and exposes request faults and terminal auth", () => {
    expect(shouldExposeError(failure({ status: 500, message: "boom" }))).toBe(false);
    expect(
      shouldExposeError(failure({ status: 503, code: "auth_unavailable", message: "x" })),
    ).toBe(false);
    expect(shouldExposeError(failure({ status: 400, message: "bad input" }))).toBe(true);
    expect(shouldExposeError(failure({ status: 401, message: "no", terminalAuth: true }))).toBe(
      true,
    );
    expect(isQuotaOrCooldownError({ message: "not json" })).toBe(false);
  });
});

describe("buildErrorPayload", () => {
  it("writes the trusted Retry-After as a canonical top-level header and drops the raw one", () => {
    const payload = buildErrorPayload(
      failure({
        status: 429,
        message: JSON.stringify({ error: { type: "usage_limit_reached", message: "limit" } }),
        safeHeaders: { "retry-after": "42" },
        headers: { "retry-after": "999", "x-codex-primary-used-percent": "100" },
      }),
    );

    expect(payload).toEqual({
      type: "error",
      status: 429,
      headers: { "Retry-After": "42", "X-Codex-Primary-Used-Percent": "100" },
      error: { type: "usage_limit_reached", message: "limit" },
    });
  });

  it("keeps a raw Retry-After when nothing trusted replaces it", () => {
    const payload = buildErrorPayload(
      failure({ status: 429, message: "limit", headers: { "retry-after": "7" } }),
    );

    expect(payload["headers"]).toEqual({ "Retry-After": "7" });
  });

  it("coerces a quota or cooldown failure with a 5xx or missing status to 429", () => {
    const quota = JSON.stringify({ error: { type: "usage_limit_reached", message: "limit" } });
    expect(buildErrorPayload(failure({ status: 500, message: quota }))["status"]).toBe(429);
    expect(buildErrorPayload(failure({ status: 503, message: quota }))["status"]).toBe(429);
    expect(
      buildErrorPayload(failure({ status: 503, code: "model_cooldown", message: "cooling" }))[
        "status"
      ],
    ).toBe(429);
    expect(buildErrorPayload(failure({ status: 503, message: "busy" }))["status"]).toBe(503);
    expect(buildErrorPayload(failure({ status: 409, message: quota }))["status"]).toBe(409);
  });
});
