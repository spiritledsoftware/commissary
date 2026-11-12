// CLIProxyAPI 9a35fa12 (sdk/api/handlers/handlers_errors.go, issue7017_retry_after_test.go): a locally computed
// Retry-After outranks the raw upstream one, even with passthrough-headers.
import { describe, expect, it } from "vite-plus/test";
import { ExecutionError } from "../../src/executor/errors.ts";
import { errorResponse } from "../../src/handlers/respond.ts";

const error = (extra: Partial<ConstructorParameters<typeof ExecutionError>[0]>): ExecutionError =>
  new ExecutionError({
    status: 429,
    message: "{}",
    headers: { "retry-after": "999", "x-upstream": "1" },
    ...extra,
  });

describe("errorResponse Retry-After precedence", () => {
  it("keeps the trusted local value over the passthrough upstream header", () => {
    const response = errorResponse("openai", error({ safeHeaders: { "retry-after": "7" } }), {
      passthroughHeaders: true,
    });

    expect(response.headers["retry-after"]).toBe("7");
    expect(response.headers["x-upstream"]).toBe("1");
  });

  it("passes the upstream value through when there is no local one", () => {
    const response = errorResponse("openai", error({}), { passthroughHeaders: true });

    expect(response.headers["retry-after"]).toBe("999");
  });
});
