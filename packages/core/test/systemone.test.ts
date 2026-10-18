// The System One error shape (ADR 0032): TypeSafe's `{"detail":{"error_type","message"}}` and the path that uses it.
import { describe, expect, it } from "vitest";
import { isSystemOnePath, systemOneErrorBody } from "../src/index.ts";

describe("System One errors", () => {
  it("are TypeSafe-shaped, with an error type from the status unless one is given", () => {
    expect(JSON.parse(systemOneErrorBody(429, "slow down"))).toEqual({
      detail: { error_type: "rate_limit_error", message: "slow down" },
    });
    expect(JSON.parse(systemOneErrorBody(529, "busy")).detail.error_type).toBe("overloaded_error");
    expect(JSON.parse(systemOneErrorBody(502, "bad")).detail.error_type).toBe("api_error");
    expect(JSON.parse(systemOneErrorBody(400, "no", "validation_error")).detail.error_type).toBe(
      "validation_error",
    );
  });

  it("answer the System One path only", () => {
    expect(isSystemOnePath("https://api.example/v1/systemone")).toBe(true);
    expect(isSystemOnePath("/v1//SystemOne/")).toBe(true);
    expect(isSystemOnePath("/v1/chat/completions")).toBe(false);
    expect(isSystemOnePath("/v1/systemone/x")).toBe(false);
  });
});
