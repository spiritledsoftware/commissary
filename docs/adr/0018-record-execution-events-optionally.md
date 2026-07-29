# Record Execution Events optionally

A host can supply an optional Execution Event Store when it needs crash-lossless capture. Core appends ordered nonempty Event batches before process-local observation. The Store assigns each Event a strictly increasing Run-local sequence and persists the resulting Execution Event Records atomically. Without the Store, existing best-effort Event delivery stays unchanged.

Core combines adjacent text and reasoning updates and flushes within 16 milliseconds, at 64 Events, at 64 KiB, and before Tool, error, finish, or settlement Events. A full bounded buffer backpressures Model consumption instead of dropping Events. An append failure rejects the current Execution and leaves the Run nonterminal.

The core Store contract is append-only. Retention, TTL, reading, cursors, replay, fan-out, and transport belong to concrete adapters.
