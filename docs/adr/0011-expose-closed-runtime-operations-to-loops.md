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

A Loop resolves an Execution only with a result from the Runtime Operation that performed the durable transition. Completion, Failure, Suspension, abort, and Interruption are durable before their results exist.

A Loop that returns normally without such a result violates its contract. Core reports this condition as a Defect.
