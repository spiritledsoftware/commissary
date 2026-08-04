# Build Thread Store on generic Store primitives

This ADR supersedes the **Thread Store** section of [ADR 0004](0004-pass-dependencies-through-factories-and-closures.md). The other dependency, factory, closure, and safe-facade decisions in ADR 0004 remain in force.

This ADR also supersedes the Run Snapshot field exclusions in the **Run Snapshot** section of [ADR 0009](0009-separate-run-admission-from-execution.md). Run and Tool Call values in a snapshot are complete selected Records from the effective catalog. They include host-defined fields and persisted continuation and Provider Data fields.

The detailed interface, behavior, and test contract is [the Store architecture specification](../specs/store.md).

## Generic Store seam

`@commissary/store` owns the schema-library-neutral persistence primitives. `Store` is the base interface. It exposes one readonly `collections` map whose values implement `find`, `create`, `update`, `delete`, and `count`.

A Record definition contains a `fields` map. Each Field Definition uses Standard Schema for select, create, and update inference and validation. Adapter factories can accept wider typed storage options without adding those options to the base Record definition.

A Store contains its complete effective Collection catalog. The host keeps the Store value that it passes to Commissary and can use raw CRUD on every Core and Custom Collection, including Runtime state. The Commissary Instance does not expose that Store. Raw host changes can break Runtime invariants; Store is not a security boundary or a safe administration facade.

## Core specialization

`@commissary/core` depends on `@commissary/store` and defines `ThreadStore` as a Store specialization. The effective catalog contains all five durable entity Collections, all fourteen Runtime state Collections, and every host-defined Custom Collection. Core and host fields merge by Record and field name. A host replacement for a built-in Core field must keep a compatible selected output type.

Core owns the specialized Thread Store transitions for claims, fencing, idempotency, branch heads, suspension, commits, interruption, and finalization. Core implements each transition once with Collections inside `TransactionStore.transaction`. A Thread Store adapter supplies a Transaction Store over the same effective catalog and does not reimplement Runtime transition rules.

`TransactionStore.transaction` is the only atomic grouping primitive. Its callback runs at most once and receives a transaction-bound Store without `transaction`. Each adapter enforces serializable overlap and rollback in its storage system. Core can start a new storage-only transaction after a conflict, with at most three total attempts.

The first Core specialization can materialize and diff the complete Core Collection catalog for each operation. This tradeoff is accepted for the process-local Memory Thread Store only. It is not a Store conformance requirement. Before Commissary supports a database-backed Thread Store, Core must scope these reads and writes to the records required by each transition without moving transition rules into the adapter.

## Capabilities and adapters

An integration requires the exact primitive Store interface that it needs. Store has no runtime `supports` registry. An operator that an adapter never supports is absent from its operator-set type. Support that depends on input or backend state rejects with `UnsupportedStoreOperationError`.

A concrete Collection can use native operations, optional shared fallback helpers, or both. There is no required low-level storage driver. A backend can back `ThreadStore` only when the Core Runtime conformance suite passes with that backend's actual operator semantics.

`@commissary/store-memory` uses one storage engine. `MemoryStore.make` exposes it as a generic Transaction Store. `MemoryThreadStore.make` composes it with the Core specialization and exposes a Thread Store. A future SQL Store contract must be designed as a primitive before concrete SQL adapters; it is outside this decision.

## Public boundary and failures

Every asynchronous Store-family method returns a native `Promise`. Base CRUD and transactions accept no `AbortSignal`. Base Store performs no shared CRUD retry, logging, tracing, query-plan reporting, or full-scan warning.

The `StoreError` hierarchy replaces `ThreadStoreError` for expected Store operational failures. Adapter contract violations use a separate defect error. Store-generated safe metadata does not copy complete inputs or Records. The Store specification defines the exact error classes and failure behavior.
