# Make Tool execution durable and resumable

## Tool contracts

`Tool.define` accepts a literal name and Standard Schema values for input and output. It can also accept a Failure schema.

The constructor infers handler inputs and all declared results. `Tool.Input`, `Tool.Output`, and `Tool.Failure` expose these types. `Tool.dynamic` is the explicit interface for runtime-discovered Tools.

A Tool handler receives validated input and one fixed Tool Execution Context. It returns successful output directly. It uses `Tool.failure` or `Tool.suspend` for other declared results.

The Tool Execution Context contains a stable Tool Call ID and idempotency key. These values stay equal across Tool Attempts.

A suspension configuration supplies:

- A Standard Schema for external resume input.
- A Codec for durable continuation state.
- A resume handler.

[ADR 0002](0002-identify-agents-by-installed-composition.md) defines continuation compatibility. `AgentClient.submit` records typed resume input independently from `execute`.

## Canonical Tool schema

During Agent Installation, core converts each Tool input schema to Draft-07 JSON Schema. It verifies that the value is a recursively JSON-compatible object.

Core keeps one immutable canonical copy in the installed Tool contract and Agent Revision. A conversion or validation error stops Agent Installation and identifies the Tool.

The Effect AI bridge passes this exact object as raw parameters in a handler-free dynamic Tool definition. Effect AI Tool resolution stays disabled. Commissary validates returned input and executes the durable Tool.

A provider that cannot translate a valid canonical schema reports a Provider Compatibility Interruption.

## Durable execution

When a Model requests Tools, the Machine first commits the assistant Message and complete Tool Call set atomically. It starts no Tool Attempt before this commit.

Recovery resumes unresolved committed Tool Calls. It keeps their Tool Call IDs and idempotency keys. It does not ask the Model to create them again.

Tool Attempts have at-least-once semantics. A Tool or its integration must use the idempotency key for exactly-once external effects. Core cannot transact with arbitrary external systems.

Before the first external attempt, core runs the captured Tool Hooks. It validates and atomically records the effective input, including any Hook change.

Each later attempt uses this recorded input and the same idempotency key. It does not apply a later Execution's Hooks again.

## Tool delegation

A Tool can invoke another installed Tool only through its Tool Execution Context. A direct handler call is not an installed Tool invocation.

A static invocation supplies an explicit Tool, JSON input, and caller-stable key. A dynamic invocation supplies an installed Tool Provider, a Tool name from its current set, JSON input, and a stable key.

Core performs no global string lookup. It verifies the target, derives the child Tool Call ID and idempotency key, and records the child before its first attempt.

The same parent key, target, and input address the same child call. Reuse with a different target or input is a Defect.

The active delegation path must be acyclic. A Tool cannot invoke itself or an ancestor. Sibling calls to the same Tool are valid when they use different keys.

A static invocation keeps the child Tool's input, output, and Failure types. A Tool Provider can keep a known Tool union or report unknown result types honestly.

Invocation returns `success` with output or `failure` with declared Failure data. A Defect rejects the invocation.

A child suspension does not return to the active parent attempt. Core later starts the parent again. The parent can transform or propagate a child Failure after it receives one.

Core records delegated calls in the Tool Call Graph. [ADR 0006](0006-store-thread-history-as-branching-messages.md) defines their history boundary. [ADR 0009](0009-separate-run-admission-from-execution.md) defines their snapshot view.

## Suspension and resume

Core can suspend any number of Tool Calls at one time. This includes parallel top-level calls and delegated child calls.

Core emits `tool-suspended` only after the suspension is durable. A host can submit resume input while sibling work or the owning Execution is active.

Newly ready work can continue in the active Execution. Guarded settlement prevents a lost wake-up. Otherwise, a later Execution consumes the input.

When no Tool work can run, the Execution resolves with unresolved suspensions in durable Tool Call order. One resume submission can attach input to any nonempty subset.

When a child suspends, core discards the process-bound parent attempt. After required child results commit, core starts a new parent attempt with the same idempotency key.

The repeated delegation key returns the stored child result. Parent work before that point can run again under the at-least-once contract.

Core has no Tool approval type or policy. An approval integration uses normal Tool Suspension and resume contracts.

## Provider capabilities

A provider-executed capability is not a core Tool. Its provider package keeps the capability in Model configuration and translates it inside the Model adapter.

Such a capability does not enter Agent Tool composition, the Tool Call Graph, Tool Hooks, idempotency, suspension, resume, or delegation. [ADR 0005](0005-own-the-provider-neutral-model-protocol.md) defines the `pause` continuation result.

A provider capability that needs a host callback uses an ordinary `Tool.define` value. The Model adapter maps the provider wire call to the canonical Tool Call and maps the committed result back.

Automatic provider callback resolution stays disabled. The Tool receives normal validation, Hooks, idempotency, Failure, suspension, resume, and delegation behavior. Core has no Provider Callback Tool type.
