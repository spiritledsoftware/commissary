// What a stream's exit reports for the attempt (`toExecutionError`): the upstream error as it is, the downstream's own
// stops as a request-scoped 500, nothing for interrupts.
import { Cause, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { ExecutionError } from "../src/executor/errors.ts";
import { cancelledAttemptError } from "../src/handlers/conductor.ts";
import { streamExitError, toExecutionError } from "../src/handlers/execute.ts";

describe("toExecutionError", () => {
  it("reports an ExecutionError as it is", () => {
    const error = new ExecutionError({ status: 429, message: "limit", credentialScoped: true });
    expect(toExecutionError(Cause.fail(error))).toBe(error);
  });

  it("reports any other failure as the downstream's: a request-scoped 500", () => {
    expect(toExecutionError(Cause.fail(new Error("the downstream stopped")))).toMatchObject({
      status: 500,
      message: "downstream forward failed",
      requestScoped: true,
    });
  });

  it("has no error for an interrupt or a defect", () => {
    expect(toExecutionError(Cause.interrupt())).toBeUndefined();
    expect(toExecutionError(Cause.die(new Error("boom")))).toBeUndefined();
  });
});

describe("cancelled attempts (CLIProxyAPI 3ad507bf)", () => {
  const limited = new ExecutionError({ status: 429, message: "limit", retryAfterMs: 60_000 });
  const plain = new ExecutionError({ status: 500, message: "upstream broke" });
  const fault = new ExecutionError({ status: 400, message: "bad", requestScoped: true });
  const cancelled = (error: ExecutionError) => Cause.combine(Cause.fail(error), Cause.interrupt());

  it("keeps the cooldown of an upstream error that carries a Retry-After", () => {
    expect(cancelledAttemptError(cancelled(limited))).toBe(limited);
    expect(streamExitError(Exit.failCause(cancelled(limited)))).toBe(limited);
  });

  it("reports a request-scoped error as it is", () => {
    expect(cancelledAttemptError(cancelled(fault))).toBe(fault);
  });

  it("reports a plain cancellation as the client's abort, never as a credential failure", () => {
    for (const cause of [cancelled(plain), Cause.interrupt()]) {
      expect(cancelledAttemptError(cause)).toMatchObject({
        status: 499,
        code: "connection_lifecycle",
      });
      expect(streamExitError(Exit.failCause(cause))).toMatchObject({
        code: "connection_lifecycle",
      });
    }
  });

  it("a stream that ended cleanly reports success, one that failed its own error", () => {
    expect(streamExitError(Exit.void)).toBeUndefined();
    expect(streamExitError(Exit.fail(plain))).toBe(plain);
  });
});
