# Make Tool execution durable and resumable

## Tool contracts

`Tool.define` accepts a literal name and a Standard Schema value for input. Model-requested input must be JSON, but the schema can decode it to a richer handler-only value. Its output Standard Schema is optional. It can also accept a Failure schema.

Successful Tool outputs and declared Failure values are always provider-neutral JSON. With a schema, the constructor infers and validates the JSON output. Without an output schema, core still rejects values that cannot be stored as JSON. `Tool.Input`, `Tool.RequestedInput`, `Tool.Output`, `Tool.FailureValue`, and the identity-tagged terminal `Tool.Failure` expose the distinct types.

A Tool handler receives decoded input and one fixed Tool Execution Context. It returns successful output directly. It uses `Tool.failure` or `Tool.suspend` for other declared results.

## Rich Tool results

A successful Tool can return output directly or use `Tool.success(output, { content })` to add Tool Result Content. A declared failure can use `Tool.failure(failure, { content })` for the same purpose. Defects and Tool Suspensions cannot carry Tool Result Content.

The optional output schema validates only output. The optional Failure schema validates only the Failure value. Core validates Tool Result Content against its provider-neutral Content contract. Neither channel is an unvalidated extension point.

Core records the result value and content atomically in the durable Tool Call result. For a top-level Tool Call, its Tool Message contains the structured Tool Result followed by the ordered extra Content Parts. Content supplements the result value; it does not replace or hide that value from the Model.

A delegated child result stays outside Model history. Its parent invocation receives only the typed output or Failure value. Only the parent Tool result becomes model-visible, as defined by ADR 0006.

The Tool Execution Context contains a stable Tool Call ID and idempotency key. These values stay equal across Tool Attempts.

A suspension configuration supplies:

- A Standard Schema for external resume input.
- A Codec for durable continuation state.
- A resume handler.

The Agent Client `resumeRun` method records typed JSON resume input independently from `execute`. The resume schema validates it before acceptance. The Store keeps the submitted JSON, and each resume attempt decodes it again for the callback.

## Canonical Tool schema

During Agent Installation, core converts each Tool input schema to Draft-07 JSON Schema. It verifies that the value is a recursively JSON-compatible object.

Core keeps one immutable canonical copy in the installed Tool contract and Agent Revision. A conversion or validation error stops Agent Installation and identifies the Tool.

The Effect AI bridge passes this exact object as raw parameters in a handler-free dynamic Tool definition. Effect AI Tool resolution stays disabled. Commissary validates returned input and executes the durable Tool.

A provider that cannot translate a valid canonical schema reports a Provider Compatibility Interruption.

## Durable execution

When a Model requests Tools, the Machine first commits the assistant Message and complete Tool Call set atomically. It starts no Tool Attempt before this commit.

Recovery resumes unresolved committed Tool Calls. It keeps their Tool Call IDs and idempotency keys. It does not ask the Model to create them again.

Tool Attempts have at-least-once semantics. A Tool or its integration must use the idempotency key for exactly-once external effects. Core cannot transact with arbitrary external systems.

Before the first external attempt, core runs the captured Tool Hooks. It requires the Hook-effective input to be JSON, validates and decodes that JSON, and only then records the effective JSON atomically.

Each later attempt validates and decodes the recorded effective JSON again. It keeps the same idempotency key and does not apply a later Execution's Hooks again. Public snapshots expose both `requestedInput` and optional `effectiveInput`; one field never changes meaning.

## Dynamic Tool recovery

Core records the Provider ID and Tool name on every committed dynamic Tool Call. Each initial attempt, retry, or resume resolves the current Tool with that identity. Core does not store a Dynamic Tool Revision, schema hash, server version, or compatible-revision list.

For unresolved attempts, the recorded effective input must validate against the current Tool contract. For suspended work, the current Tool and Suspension select the continuation Codec, and that Codec must decode the stored state. A missing Tool, missing Suspension, invalid effective input, or continuation decode failure produces a Stale Agent Interruption. Core does not start a new Run or silently reinterpret incompatible state.

Each resolved dynamic Tool carries the same optional output, Failure, Event, and Suspension contracts as a static Tool. The dynamic boundary is type-erased, but it is not validation-free.

Without an output schema, successful output must still be a provider-neutral JSON value. Returning a declared Failure, emitting an Event, or returning a Suspension requires the matching declared contract. Core validates result values and resume input, validates Events, and encodes continuation state before any durable commit.

Static Tool Events, snapshots, suspensions, terminal Failures, and resume items form distributive unions keyed by the literal Tool name. Dynamic records require `dynamic: true` and `providerId`. Static records use optional `dynamic?: false` and have no Provider ID. Installing a dynamic provider does not widen valid static Tool names or inputs.

Every stored terminal Tool Failure contains `type: "tool-failure"`, the exact Tool name, Tool Call ID, and JSON `value`. Dynamic failures also contain their Provider ID. Model history and parent Tool handlers receive the declared raw Failure value; host observability receives the tagged durable value.

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
