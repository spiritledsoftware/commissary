# Separate Run submission from execution

## Commands

The typed Agent Client separates durable submission from process-bound execution.

`submit(command)` records a start command or a Tool resume command. `execute(runId)` starts one Execution for a submitted Run.

An Execution contains branded Execution and Run IDs, an independently awaitable result, and an abort operation. The core Agent Client has no combined `run`, `stream`, or `resume` convenience.

Streaming belongs to the adapter in [ADR 0010](0010-fence-and-resolve-executions.md). Tool resume races belong to [ADR 0013](0013-make-tool-execution-durable-and-resumable.md).

Steering, abort, snapshot reads, and result reads remain separate operations.

## Run Snapshot

`readRunSnapshot(runId)` returns one typed point-in-time view of durable public Run state. One atomic Thread Store read returns:

- Run status.
- Branch and head IDs.
- The complete public Tool Call Graph.
- Unresolved suspensions.
- The terminal Run Result, when it exists.

The Tool Call Graph includes Model-requested and delegated calls. It contains public parent links, status, and results.

The snapshot excludes Execution Claims, fences, idempotency keys, private Tool continuations, Provider Data, and raw Thread Store records. It has no Run revision or Execution Event cursor. It does not create an atomic snapshot-to-live handoff.

## Result read

`readResult(runId)` returns only the durable terminal Run Result. It returns `undefined` before a terminal result exists.

This operation does not derive its value from `readRunSnapshot`. A result-only read must not build the complete Tool Call Graph. It adds no state or semantics that are absent from the snapshot.
