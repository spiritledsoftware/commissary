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

Core owns the specialized Thread Store transitions for claims, fencing, idempotency, branch heads, suspension, commits, interruption, and finalization. Core implements each transition once with Collections over the same effective Store catalog. Adapters do not reimplement Runtime transition rules.

A plain Store can back a Thread Store with weaker guarantees. Core serializes complete transitions within one Thread Store instance, makes one attempt, and reloads stored state before the next operation. It cannot roll back a partly persisted transition or prevent another process or Thread Store instance from overlapping. An operational failure reports whether writes can remain.

When the backend is a `TransactionStore`, Core runs the transition inside `TransactionStore.transaction`. The callback runs at most once and receives a transaction-bound Store without `transaction`. Each adapter enforces serializable overlap and rollback in its storage system. Core can start a new storage-only transaction after a conflict, with at most three total attempts.

The first Core specialization materializes and diffs the complete Core Collection catalog for each operation. Database Stores can preserve the same behavior, but this approach performs full-catalog reads and writes. Core must scope them to the Records required by each transition before database-backed Thread Stores are suitable for production-scale catalogs.

## Capabilities and adapters

An integration requires the exact primitive Store interface that it needs. Store has no runtime `supports` registry. An operator that an adapter never supports is absent from its operator-set type. Support that depends on input or backend state rejects with `UnsupportedStoreOperationError`.

A concrete Collection can use native operations, optional shared fallback helpers, or both. There is no required low-level storage driver. The Core Runtime conformance suite has a plain-Store profile for serialized single-instance behavior and a Transaction Store profile for rollback, conflicts, and serializable overlap.

`@commissary/store-memory` uses one storage engine. `MemoryStore.make` exposes it as a generic Transaction Store. `MemoryThreadStore.make` composes it with the Core specialization and exposes a Thread Store. The separately designed [SQL Store tier](../specs/sql-store.md) is another primitive contract; concrete SQL adapters implement it instead of defining the shared seam.

Database identity alone does not create a Store specialization tier. There are no general `PostgresStore`, `MySqlStore`, or `SqliteStore` runtime interfaces or aliases. Concrete database and ORM adapters compose the primitive Store contracts that they implement. Database-specific Record refinements and concrete factory names remain valid definition and adapter seams.

A focused Store capability is added only when a proven caller needs a stream, callback, resource scope, cleanup rule, result lifecycle, or engine guarantee that lower-tier contracts cannot preserve, a deletion test shows that deletion loses observable caller behavior, and at least one working adapter path exists. Driver-independent primitive contracts belong in `@commissary/store`; driver- or ORM-specific contracts remain with their adapter. Store has no speculative optional capability methods. Core accepts `Store` and preserves stronger guarantees when the supplied value also implements `TransactionStore`.

## Public boundary and failures

Every asynchronous Store-family method returns a native `Promise`. Base CRUD and transactions accept no `AbortSignal`. Base Store performs no shared CRUD retry, logging, tracing, query-plan reporting, or full-scan warning.

Base `update` and `delete` do not promise one operation-wide transaction. Each candidate is validated before its write. A later validation, conflict, or adapter failure can leave earlier writes in place. Every `StoreError` states whether writes can remain. Adapter contract violations use a separate defect error. Store-generated safe metadata does not copy complete inputs or Records. The Store specification defines the exact error classes and failure behavior.
