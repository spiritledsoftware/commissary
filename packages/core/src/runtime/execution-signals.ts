import type { InterruptedExecutionResult } from "../runtime.js";
import type { JsonValue } from "../types.js";

/** A defect caused by an impossible Runtime state. */
export class RuntimeInvariantError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "RuntimeInvariantError";
  }
}

/** Internal control signal for a durable Abort Request. */
export class AbortExecution {
  constructor(readonly reason?: JsonValue) {}
}

/** Internal control signal for an admitted Model redirect. */
export class RedirectModelInvocation {}

/** Internal control signal for a declared Execution interruption. */
export class InterruptExecution {
  constructor(readonly result: InterruptedExecutionResult) {}
}

/** Internal control signal for a Hook block result. */
export class HookBlockedExecution {
  constructor(
    readonly point: string,
    readonly failure: unknown,
  ) {}
}

/** Internal control signal that restarts the execution loop. */
export class ContinueLoop {}

/** Internal control signal for a suspended delegated Tool. */
export class ChildSuspended {}
