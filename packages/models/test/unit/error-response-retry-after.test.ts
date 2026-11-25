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

// CLIProxyAPI df6c8ccb (`writeDirectErrorResponse`): a direct answer gets the safe Retry-After when its own headers lack
// one, and the headers of the stream it failed in with passthrough-headers (its own headers win).
const direct = (extra: Partial<ConstructorParameters<typeof ExecutionError>[0]>) =>
  error({ direct: true, headers: { "x-own": "1", "x-both": "own" }, ...extra });

describe("errorResponse of a direct answer", () => {
  it("adds the safe Retry-After unless the answer has its own", () => {
    const added = errorResponse("openai", direct({ safeHeaders: { "retry-after": "7" } }), {
      passthroughHeaders: false,
    });

    expect(added.headers["retry-after"]).toBe("7");
    expect(added.headers["x-own"]).toBe("1");

    const own = errorResponse(
      "openai",
      direct({
        headers: { "Retry-After": "999" },
        safeHeaders: { "retry-after": "7" },
      }),
      { passthroughHeaders: false },
    );

    expect(own.headers["retry-after"]).toBe("999");
  });

  it("adds the stream's headers only with passthrough-headers, below its own and a trusted Retry-After", () => {
    const failed = direct({
      streamHeaders: { "x-stream": "s", "x-both": "stream", "retry-after": "50" },
      safeHeaders: { "retry-after": "7" },
    });

    const passed = errorResponse("openai", failed, { passthroughHeaders: true });
    expect(passed.headers["x-stream"]).toBe("s");
    expect(passed.headers["x-both"]).toBe("own");
    expect(passed.headers["retry-after"]).toBe("7");

    const kept = errorResponse("openai", failed, { passthroughHeaders: false });
    expect(kept.headers["x-stream"]).toBeUndefined();
  });
});
