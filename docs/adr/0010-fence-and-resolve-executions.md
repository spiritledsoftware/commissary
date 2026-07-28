# Fence and resolve Executions

## Execution Claims

An Execution must acquire an expiring fenced Execution Claim before it advances a Run. Core renews the Claim for the full Execution lifetime.

Every durable Runtime operation checks the Claim fence. A stale or late Execution cannot change Run state. Claim loss cancels active work and rejects `Execution.result` with `ExecutionClaimLostError`.

The host can schedule another Execution after the first Execution ends. Core has no durable retry scheduler.

Core requests a lease duration, not an absolute expiry time. The Thread Store calculates `expiresAt` with its backend clock. Core schedules renewal from the relative duration and does not compare process wall clocks.

`executionClaims.leaseDurationMs` must be finite and positive. It defaults to 60,000 milliseconds. Core renews halfway through the duration. There is no public heartbeat or separate renewal interval.

A Thread Store can implement `waitForExecutionControl({ claim, signal })`. This cancellable operation reports an Abort Request or Claim loss. It must close the read-before-subscribe race.

Core starts one control watch for each active Execution when the Thread Store supports it. Otherwise, Claim renewal reports `renewed`, `abort-requested`, or `claim-lost`. Renewal is the required correctness fallback.

A same-process Abort Request also signals the local controller. Claim-guarded Thread Store operations remain the authority.

## Abort

`requestAbort` records a durable request only while the Run is nonterminal. Each later progress write and non-abort finalization checks this request atomically.

If the Abort Request commits first, it wins. If terminal finalization commits first, abort returns `already-resolved` with the existing result.

`abort(runId)` returns `accepted` when the Thread Store records the request. It does not wait for the active Execution to stop. A caller waits on an existing Execution or calls `readResult` when it needs final settlement.

After an Execution observes the request, it can only perform guarded abort finalization. A later Execution finalizes an abort-pending Run without invoking the Agent.

Abort finalization marks every unresolved Tool Call Graph node as aborted. It appends deterministic failed Tool Results for unresolved top-level Tool Calls in durable sequence order.

Each generated Tool Result contains `{ "type": "aborted" }`. The caller's reason stays on the Aborted Run Result and control notification. Core never copies this reason into Model history.

## Execution Events and streaming

Core dispatches typed Execution Events through `onExecutionEvent`. Core has no event queue, `AsyncIterable`, or durable Event log.

The first official adapter after core is `@commissary/stream`. It provides plain JavaScript streams from the package root and Effect-native streams from `@commissary/stream/effect`.

The adapter registers a dynamic `onExecutionEvent` Hook before it calls `execute`. The Hook capture rule in [ADR 0012](0012-compose-machine-policy-through-typed-hooks.md) keeps that Hook on the new Execution. The adapter can remove the process registration after `execute` returns.

The adapter exposes one bounded single-consumer stream. Its capacity must be positive and defaults to 64. Stream consumption does not control execution or abort the Run.

The queue does not apply backpressure to core. When it is full, the adapter discards the oldest Events. It combines the loss count into one `{ type: "events-dropped", count }` adapter Event.

The adapter always reserves space for a terminal Error Event. It emits any pending loss marker first, then the terminal Error Event, and then closes the stream.

Text projection filters canonical nested `model-event` values. Core does not emit a second text Event.

After an Events Dropped Event, a host can mark its view as stale. It can call `readRunSnapshot` after the Execution settles and replace its durable projection. Uncommitted text or reasoning can remain absent.

The snapshot is not an Event cursor. The host must not infer gapless order between the snapshot and concurrent Events.

A later relay adapter owns fan-out, downstream queues, transport, replay, reconnect, retention, and authorization. It consumes the Stream Adapter once. Core does not let a new process attach to an existing Execution.

A relay cannot promise crash-lossless capture with the current Hook boundary. A future lossless adapter would need an awaited bounded append at the core emission boundary. Readers, cursors, and retention would remain outside core.

## Errors

`execute` rejects with `ExecutionUnavailableError` before it returns an Execution when:

- The Run does not exist.
- The Run belongs to another Agent.
- Another Execution owns the Run.
- The Run cannot execute in its current state.

The error contains the Run ID and a stable reason code.

After an Execution starts, core reports errors with `{ type: "error", error }`. A terminal Error Event occurs before `Execution.result` rejects with the same error. The stream adapter emits that Event before it closes.

An isolated notification Hook error does not reject the Execution result. [ADR 0012](0012-compose-machine-policy-through-typed-hooks.md) defines observer error delivery and recursion prevention.

Core wraps an undeclared execution exception in `UnexpectedExecutionError`. The error contains a stable phase code and keeps the original value as its cause.

`ExecutionClaimLostError`, `ThreadStoreError`, and `ArtifactStoreError` remain specific errors. Core does not wrap them again.

Failures and Interruptions remain declared result values. Core does not report them as errors.
