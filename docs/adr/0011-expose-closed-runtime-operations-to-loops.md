# Expose closed Runtime Operations to Loops

The Machine is the default Run loop. A host can supply a Loop when it must replace Machine policy and phase order.

A Loop can call only the closed set of Runtime Operations. These operations keep authority over:

- Execution Claims and renewal.
- Transcript loading.
- Render and validation.
- Agent Compatibility.
- Fencing and persistence.
- Atomic state changes.

A Loop cannot mutate the Thread Store directly. It cannot access private Machine stages. Agent Fragments cannot add Runtime Operations or replace the Machine loop.

Runtime Operations return branded products with validated data and semantic result types. Only Runtime can create these products. Durable continuation and finalization accept the original products, not caller-built copies.

A Model invocation operation commits its Tool Call Message before it returns executable Tool Call capabilities. Thus, a Loop cannot start a Tool Attempt before the Tool Call is durable.

`prepare` returns Prepared Work, not an opaque prepared view. Prepared Work identifies either one Model invocation or the committed top-level Tool Calls that must advance before another Model invocation. Later Runtime Operations accept only capabilities from that Prepared Work.

A Loop chooses the order and concurrency of Tool Calls from one Tool Work value. Core preserves durable Tool Result order, rejects Tool Calls from another preparation, and prevents terminal settlement while any top-level Tool Call remains unresolved.

This union lets a new Execution recover work that a prior Execution committed before process loss. A separate pending-work query is rejected because it would split one authoritative preparation across two reads.

A Loop resolves an Execution only with a result from the Runtime Operation that performed the durable transition. Completion, Failure, Suspension, abort, and Interruption are durable before their results exist.

A Loop that returns normally without such a result violates its contract. Core reports this condition as a Defect.

The Settlement Gate runs inside the terminal Runtime Operation. If it requests continuation, core atomically commits the instruction and reports ready work instead of creating a Resolved Execution. The Runtime re-enters the default Machine or custom Loop under the same Run and active Execution Claim. A custom Loop must tolerate this re-entry.
