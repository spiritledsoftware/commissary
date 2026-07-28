# Keep multi-Run orchestration outside core

Commissary core ends at one Run. It has no handoff protocol, Subagent type, Follow-up queue, Run chain, or durable post-commit Job system.

Hosts and adapters can build these features from Tools, Tool Suspension, `readResult`, and idempotent `submit` calls.

The host's durable workflow owns cross-Run transactions, outboxes, recovery workers, routing, permissions, retries, and result composition.

Core still owns all work that one Run needs for correct execution. Durable one-Run work does not move outside core only because it is durable.

[ADR 0009](0009-separate-run-admission-from-execution.md) defines why `readResult` remains a core operation.
