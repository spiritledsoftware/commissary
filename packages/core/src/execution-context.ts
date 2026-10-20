import { Context, Effect, Option } from "effect";

/**
 * What Commissary uses of a Cloudflare `ExecutionContext`. Structural, so this package needs no Workers types: a
 * Worker's `ctx` is one.
 */
export interface InvocationContext {
  waitUntil<T>(promise: Promise<T>): void;
  passThroughOnException(): void;
}

/** Cloudflare `ExecutionContext` (`waitUntil`, `passThroughOnException`) of the current invocation. */
export class WorkerExecutionContext extends Context.Service<
  WorkerExecutionContext,
  InvocationContext
>()("commissary/core/WorkerExecutionContext") {}

const noop = (): void => undefined;

/**
 * Keeps the invocation alive (`ctx.waitUntil`) until the returned `release` is called. Used for bookkeeping that must
 * survive a client disconnect: workerd cancels the invocation's pending work when the client goes away unless a
 * `waitUntil` promise is outstanding, and the cancellation of a streamed body is processed asynchronously. Register
 * the hold while the request is still live, release it once the work is done. Without an execution context (unit
 * tests, after the invocation ended) this is a no-op.
 */
export const holdInvocation: Effect.Effect<() => void> = Effect.serviceOption(
  WorkerExecutionContext,
).pipe(
  Effect.map((ctx) => {
    if (Option.isNone(ctx)) return noop;
    let release: () => void = noop;

    const done = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    try {
      ctx.value.waitUntil(done);
    } catch {
      return noop;
    }

    return release;
  }),
);

/**
 * Runs `effect` off the response path: in `ctx.waitUntil`, so it never delays the response, with the caller's context
 * (its services and loggers). Without an execution context, or once the invocation has finished (`waitUntil` throws),
 * the caller awaits it instead. `effect` must handle its own failures: a write of bookkeeping (a usage record) logs
 * and drops what it could not store.
 */
export const runAfterResponse = <R>(
  effect: Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const run = Effect.runPromiseWith(context)(effect);
    const ctx = Context.getOrUndefined(context, WorkerExecutionContext);

    if (ctx !== undefined) {
      try {
        ctx.waitUntil(run);

        return;
      } catch {
        // waitUntil is unavailable (the invocation already finished): await the work instead.
      }
    }

    yield* Effect.promise(() => run);
  });
