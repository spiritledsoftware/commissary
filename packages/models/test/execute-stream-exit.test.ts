// What a stream's exit reports for the attempt (`toExecutionError`): the upstream error as it is, the downstream's own
// stops as a request-scoped 500, nothing for interrupts.
import { Cause } from "effect";
import { describe, expect, it } from "vitest";
import { ExecutionError } from "../src/executor/errors.ts";
import { toExecutionError } from "../src/handlers/execute.ts";

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
