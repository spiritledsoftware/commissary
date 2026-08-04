# Pass dependencies through factories and closures

## Application dependencies

The host passes Runtime dependencies to `commissary`. It must pass a Thread Store. It can also pass a Loop, Clock, ID generator, and Artifact Store.

Models, Context contributions, Tools, Tool Providers, Hooks, and integrations receive application clients through factories or closures. The host acquires, shares, and releases these clients. Public callbacks receive `AbortSignal` when they support cancellation.

Core has no dependency container, typed-key registry, provider graph, or public scope system. A managed integration must acquire its client and close over it.

## Tool-owned Model calls

Core does not add Model invocation to the Tool Execution Context. A Tool that needs a Model receives a host-owned client through its factory or closure and converts that client's output into its declared Tool result.

The host owns Model selection, retries, usage accounting, and client lifetime for that call. It can connect the Tool's AbortSignal when the client supports cancellation. The call does not dispatch core Model Hooks, record core Model Usage or Model Events, enter Thread history, or become a Composite Model child.

This is not a subagent. Subagent orchestration remains outside core.

## Clock and IDs

The optional Clock provides synchronous `now()` and cancellable `sleep(milliseconds, signal)` operations. Core uses it for claim renewal and Execution-local delay. The default uses the runtime clock and timers.

Core does not pass this Clock to Thread Store adapters. A durable Thread Store uses its backend clock for claim expiry. A Memory Thread Store can accept a test Clock explicitly. The Effect adapter maps the active Effect Clock to the core Clock.

The optional `generateId` function creates every core-owned ID. It takes no ID type and defaults to `crypto.randomUUID()`. Caller-owned Run IDs and request IDs pass through unchanged.

## Thread Store

Every host passes a Thread Store to `commissary`. Core has no automatic storage default. [ADR 0019](0019-build-thread-store-on-generic-store-primitives.md) supersedes this section's original Thread Store boundary and defines the generic Store primitives, complete Collection catalog, raw host access, Core specialization, adapter capabilities, and Store failure hierarchy.

`MemoryThreadStore.make()` comes from `@commissary/store-memory`. It is process-local and not durable. It is suitable for examples, tests, and local development.

The Commissary Instance does not expose its Thread Store. The host keeps the Store value that it supplied and can use its Core and Custom Collections directly. Core still owns the specialized Runtime transition rules. Raw host changes can break Runtime invariants.

The `StoreError` hierarchy replaces `ThreadStoreError`. [ADR 0010](0010-fence-and-resolve-executions.md) defines error delivery during an Execution.

## Safe Thread facade

The Commissary Instance exposes these flat methods:

- `createThread`.
- `readThread`.
- `createBranch`.
- `readBranch`.
- `renameBranch`.
- `readBranchHistory`.

`createBranch({ from })` forks from a known Message Entry. [ADR 0006](0006-store-thread-history-as-branching-messages.md) defines Branch history.

The Commissary Instance does not provide Thread or Branch listing, search, deletion, retention, or administration. A host that needs these operations uses its retained Store value or adapter-specific interfaces and owns the related tenancy and storage policy.

## Provider integration lifetime

Provider integrations own authentication protocols and safe token refresh. The host owns credential storage and all user interaction.

A provider integration never opens a browser, prints a code, or prompts during Model execution. The host starts authentication through an explicit integration operation. A Model call can refresh valid credentials without user interaction.

Each provider package exposes a synchronous factory for a Provider Integration Instance. Factory creation performs no I/O. The instance creates Model contributions and shares its transport and refresh coordination.

The host selects the instance lifetime and credential scope. A Commissary Instance acquires no application-lifetime Model resources and needs no required close operation.

## Artifact Store

The host can pass one Artifact Store beside the Thread Store. All leaf Models use this provider-neutral store for Artifact References. This rule keeps replay possible across providers.

Concrete Artifact Stores remain adapters. One storage package can implement the Thread Store and Artifact Store contracts for one backend.

An `ArtifactStoreError` names the failed `read` or `write` operation and keeps the original error as its cause. If no Artifact Store exists when core needs one, the Execution ends with an Artifact Storage Required Interruption.

The host can add the Artifact Store and execute the same Run again. Core does not inline bytes or use a second storage path.
