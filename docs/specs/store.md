# Store Architecture Technical Specification

> **Status**: Design complete for implementation. Confirmed decisions in this specification are binding.
>
> **Last updated**: 2026-08-07 during Drizzle PostgreSQL Store adapter approval.

## Summary

Add a generic `@commissary/store` package. It defines typed Stores, named Collections, per-field Standard Schemas, CRUD operations, typed query and update expressions, optional transactions, shared fallbacks, and adapter-owned operator sets.

`@commissary/core` depends on this package and defines `ThreadStore` as a Store specialization. Core implements Runtime transitions once over Core Collections. A plain Store gives serialized single-instance execution with possible partial persistence. A Transaction Store adds rollback, conflict reporting, and serializable overlap.

A host can customize every Core Record, add Custom Records, and use raw CRUD on every Collection. This power is intentional. Direct changes to claims, pending commands, idempotency Records, or any other Core state can break Runtime invariants.

The fallback operator list, object merge behavior, array filter behavior, operator edge behavior, transaction guarantees, error contract, and Core catalog are defined.

The [SQL Store Tier Technical Specification](sql-store.md) extends this base design with SQL Record definitions, Statements, execution, adapter helpers, and SQL conformance.

## Context / Current State

Today:

- `packages/core/src/store.ts` owns the `ThreadStore` interface and all durable Store input and result types.
- `ThreadRecord`, `BranchRecord`, `MessageEntry`, `RunRecord`, and `StoredToolCall` are TypeScript contracts without runtime Field Schemas.
- `packages/store-memory/src/index.ts` implements the complete `ThreadStore` contract directly.
- `packages/core/src/commissary.ts` accepts a `ThreadStore` and exposes safe Thread and Branch operations.
- `packages/core/src/schema.ts` already supports Standard Schema input/output inference.
- ADR 0004 keeps the Thread Store behind the Commissary Instance, while the host still owns the Store value that it supplied.
- No generic Store package, Collection interface, portable query language, custom Record catalog, or generic CRUD interface exists.

The requested design is broader than adding fields to existing interfaces. It introduces a typed persistence module that can:

1. add fields and validation to Core Records;
2. add new Custom Records;
3. expose raw typed CRUD;
4. let adapter factories add typed storage options without widening the base Record definition;
5. preserve specialized Core-owned Thread Store operations while representing Runtime state as Core Collections and accepting either plain or transactional backends.

## Goals

- Add `@commissary/store` as a schema-library-neutral persistence package.
- Infer Collection, CRUD input, query output, and update types from per-field Standard Schemas.
- Add omitted Core Record fields automatically.
- Reject structurally incompatible Core field overrides at compile time.
- Permit host-owned field refinements and defaults while concrete adapters own their typed storage options.
- Permit Custom Records such as `scheduledJobs`.
- Give the Store owner raw CRUD access to every Core and Custom Record.
- Make the behavior and portability of each query and update operator explicit.
- Let adapters use shared fallbacks, native implementations, or adapter-specific operators.
- Let primitive Store specializations expose wider capabilities without widening the base Store.
- Implement the current Runtime operations once in core through `ThreadStore extends Store`, with guarantees that follow the supplied backend.
- Let a host supply custom create values through typed Commissary command fields and per-Collection `beforeCreate` hooks.
- Provide shared fallback tests and adapter contract tests.

## Non-Goals

- Protect the Store owner from unsafe Core Record mutations.
- Replace specialized Thread Store operations with host-facing generic CRUD.
- Add joins, relations, grouping, aggregates, or raw database expressions to the base Store.
- Add a universal generated-field system in the first version.
- Guarantee cleanup or rollback after an adapter persists an invalid generated Record.
- Store `Date`, `Uint8Array`, class instances, or other non-JSON values.
- Define concrete adapter options, migrations, indexes, relation loading, or database-specific physical mappings in this base specification.
- Standardize every capability or configuration value that one future adapter might expose.
- Define concrete SQL adapter interfaces here. The separate [SQL Store tier specification](sql-store.md) defines the portable SQL primitive.

## Invariants

1. **JSON Records**: Selected Records are JSON-compatible values. Brands and refinements can keep richer TypeScript types only when their runtime values remain JSON-compatible.
2. **Core defaults**: Omitted Core Record definitions use the built-in definitions.
3. **Core compatibility**: A host Field Definition that replaces a built-in Core field must have a select output type compatible with that Core field. Additional validation can reject values at runtime; the host or adapter owns that risk.
4. **Raw owner access**: The Store owner can create, update, and delete every Core and Custom Record directly. This includes Runtime state used for claims, pending commands, idempotency, and finalization.
5. **Runtime authority**: Core owns and implements the specialized Thread Store operations for fencing, idempotency, branch-head checks, suspension, and finalization.
6. **Stable find shape**: `find` always returns an array, including when `limit` is `1`.
7. **Candidate-safe mutations**: `update` and `delete` validate or identify each candidate before its write. Base Store does not promise one operation-wide transaction.
8. **Valid updates**: Every field in each changed Record must satisfy its effective select Field Schema before that candidate is written.
9. **No mutation pagination**: Base `update` and `delete` use only `where` and, for update, `set`. They do not accept `orderBy`, `limit`, or `offset`.
10. **Unfiltered mutations**: An omitted `where` matches every Record. This risk is intentional.
11. **Defined fallback semantics**: Every shared fallback operator has one defined meaning.
12. **Capability honesty**: Fixed support is expressed by the Store type that a caller requires. Support that depends on input or backend state reports `UnsupportedStoreOperationError` instead of using an unsafe fallback. Store has no separate `supports` registry.
13. **Reported write uncertainty**: Every Store operational error states whether writes can remain. An operation returns an exact affected count only after complete success.
14. **No create rollback guarantee**: Invalid adapter-generated output is a defect. A rejected `create` can leave the backend write in place.
15. **Safe transaction overlap**: Overlapping transactions must produce the same stored result as some one-at-a-time order. Two conflicting transactions cannot both commit.
16. **Storage-level transaction enforcement**: Each Transaction Store adapter enforces this rule in its storage system. Core's plain-Store serialization does not provide cross-process isolation or rollback.
17. **One callback run**: One `transaction` call invokes its callback at most once. A Transaction Store reports a conflict instead of rerunning the callback.
18. **Backend-dependent Core attempts**: Core makes one attempt over a plain Store. Over a Transaction Store, it makes at most three storage-only attempts after reported conflicts.
19. **Adapter-owned rollback**: If a transaction callback fails, the adapter discards every write from that transaction with its own storage-specific rollback mechanism.
20. **Callback failure identity**: After rollback succeeds, `transaction` rejects with the exact value that caused its callback to fail.
21. **Rollback failure**: If rollback fails, `transaction` rejects with `TransactionRollbackError`, includes both failures, marks that writes can remain, and does not retry.
22. **No nested transactions**: A transaction callback receives a plain `Store` without `transaction`. It cannot start another transaction.
23. **Safe transaction capabilities**: A wider adapter keeps each capability that it can safely bind to the active transaction. The transaction view never keeps `transaction`.
24. **No transaction cancellation**: Version 1 `transaction` accepts no `AbortSignal` or other cancellation option.
25. **Create hook order**: A Thread Store runs `beforeCreate` before strict create-field validation and adapter generation for every Core or host create.
26. **Complete hook output**: A `beforeCreate` hook returns a complete patch over the create draft. Its merged result must pass normal strict create validation.
27. **Attempt-scoped hooks**: A hook runs once on a plain-Store Core attempt and once in each Transaction Store retry attempt.
28. **Required internal hook**: A required custom create field makes `beforeCreate` statically required only when Core can create that Record without a host-provided command input. A command create requires the field in its typed `fields` input instead. If both paths exist, both requirements apply.
29. **Snapshot and Record boundary**: A Run Snapshot keeps snapshot-owned properties at the top level, exposes the complete effective Run Record under `run`, and exposes complete effective Stored Tool Call Records directly as the items in `toolCalls`.
30. **Native Promise boundary**: Every asynchronous Store, Transaction Store, and Thread Store method returns a native `Promise`. Public contracts do not expose Effect values or custom `PromiseLike` thenables.
31. **No base CRUD cancellation**: Version 1 Collection CRUD methods accept no `AbortSignal`. A future cancellation-capable Store must define write outcome semantics as a separate primitive contract.
32. **No shared CRUD retry**: The base Store layer performs no automatic CRUD retry. An adapter can retry internally only when it preserves one logical operation and cannot duplicate a write.
33. **No base observability side effects**: Base Store performs no logging, tracing, scan warning, or native-versus-fallback reporting. A later observability primitive or higher-level wrapper can add these behaviors.
34. **Selected storage values**: Defined create, update, generated, and decoded values become effective Select Field Schema outputs before storage or selection.
35. **Closed transaction views**: A Transaction View closes when its callback settles. Later methods reject without starting Store work.
36. **No rollback race**: Active Transaction View work drains before rollback starts. A successful callback with active work fails with `TransactionUnsettledOperationError`.
37. **Caught transaction failures**: A rejected Transaction View operation marks the transaction for rollback even when callback code catches it.
38. **Transaction failure priority**: Callback rejection wins, then unsettled work, then the first failed View operation in call order.

## Design Constraints

- [ADR 0019](../adr/0019-build-thread-store-on-generic-store-primitives.md) records the generic Store seam, Core specialization, raw host access, and adapter capability model. This specification defines the detailed contract.
- The [SQL Store Tier Technical Specification](sql-store.md) is the binding extension for portable SQL Record, Statement, execution, and combined transaction behavior.
- Public interfaces use plain JavaScript values, native `Promise`, and Standard Schema. Effect remains behind adapters as required by ADR 0003.
- Public inference follows ADR 0016: no global augmentation, public `any`, required `as const`, or required explicit generics for ordinary use.
- Thread Store transition outcomes remain the Core authority. Their isolation and rollback guarantees now follow the supplied Store capability.
- The new package must not import `@commissary/core`.
- Core imports `@commissary/store`; concrete Thread Store adapters can import both.
- Stored data is parsed at the persistence boundary. Projected query results are validated according to the projection rules below.
- Adapter-specific capabilities stay on wider adapter interfaces instead of widening the base Store.

## Confirmed Decisions

### Package and interface layers

- Generic persistence contracts live in `@commissary/store`, not `@commissary/core`.
- `Store` is the base interface.
- `ThreadStore` extends `Store` and adds Runtime-specific operations. Core implements these operations once over Core Collections. A plain Store or Transaction Store can supply the backend; adapters do not reimplement Runtime transition rules.
- `TransactionStore` extends `Store` with the one strong atomic grouping operation used by core and direct Store owners. There is no second internal `atomic` operation.
- Every `TransactionStore` must prevent conflicting transactions from both committing, even when callers use different processes.
- Shared Transaction Store contract tests start concurrent conflicting transactions and accept either admission serialization or a reported conflict. They assert that only a serial outcome is visible. The harness never waits for both callbacks to enter, because a lock-based adapter can correctly admit only one callback at a time. Adapter-specific tests use test controls to force internal overlap when the backend supports it.
- Core Runtime conformance has two profiles. The plain-Store profile proves serialized calls within one Thread Store instance, one attempt, actual-state reload, and partial-write reporting. The Transaction Store profile also proves rollback, bounded conflict retry, and serializable overlap.
- A Transaction Store never retries a callback. Core immediately starts a new transaction for its own storage-only work after a reported conflict and makes at most three total attempts. Core never retries a plain-Store transition.
- Transaction rollback has no shared fallback. Memory, SQL, and other adapters implement rollback with their own storage mechanisms.
- A successful rollback does not wrap or replace the selected callback boundary failure.
- `TransactionRollbackError` reports both the callback boundary failure and rollback failure. It marks that stored state is unknown and some writes can remain.
- The transaction callback view omits `transaction`. Version 1 has no nested transaction or savepoint behavior.
- The View closes when its callback settles. Each later method rejects with `TransactionClosedError` before it starts Store work.
- A successful callback with active Store work closes the View, drains that work, and fails with `TransactionUnsettledOperationError`.
- Every rejected View operation marks the transaction for rollback, even when callback code catches it. The first failed operation in call order wins when the callback otherwise succeeds.
- Failure priority is callback rejection, unsettled work, first View operation failure, then commit.
- A wider adapter defines the extra capabilities on its transaction view. Core uses the default plain Store view.
- Transaction cancellation is not portable while an arbitrary callback can continue running. Version 1 omits it from the base contract.
- Store specializations are designed as primitive contracts before concrete adapters. Adapters implement those contracts, and higher-level abstractions compose them. Shared primitives are not extracted from existing adapter APIs.
- `SqlStore` is the primitive defined by the [SQL Store tier specification](sql-store.md).
- One concrete value can implement multiple compatible Store specializations.
- An integration that needs a wider capability requires the matching Store interface in its own input type. It does not accept a base Store and inspect a runtime capability registry.
- An operator that an adapter never supports is absent from that adapter's Store Operator Set type.
- Support that depends on the exact operation input, schema, configuration, or current backend state is reported with `UnsupportedStoreOperationError`.
- Store defines no `supports`, feature-flag, or capability-matrix API.
- `Store`, `Collection`, and every CRUD option carry an adapter-supplied operator type. Base operators are defaults, not hard-coded callback types.
- Every asynchronous method on `Store`, `Collection`, `TransactionStore`, and `ThreadStore` returns a native `Promise`. An Effect-based adapter runs its Effect at this boundary.
- A Store-family method creates its native Promise before it invokes host callbacks or validates input. It never throws synchronously. A value thrown by a `where`, `orderBy`, `set`, or `filter` builder rejects that Promise unchanged and reaches no adapter operation.
- The base `RecordDefinition` contains only `fields`. A wider definition can preserve additional typed intent while remaining a valid base definition.
- Base Store defines no catch-all metadata object. The SQL Store tier owns only its named SQL table, column, and database-specific metadata seams.
- The adapter boundary is the public `Collection` API. Each adapter implements `find`, `create`, `update`, `delete`, and `count` directly.
- `@commissary/store` defines no universal low-level driver such as `scan`, `insert`, or `replace`.
- Shared fallbacks are optional helpers. An adapter can call them from a Collection method only when its own storage primitives make that fallback safe.
- `@commissary/store-memory` exports two separate factories backed by one memory storage engine.
- `MemoryStore.make` constructs a generic `TransactionStore` for the supplied Record catalog.
- `MemoryThreadStore.make` composes that generic backend with the Core builder and constructs a `ThreadStore`.
- Neither factory changes its return interface based on the shape of its input.

### Records and fields

- Version 1 exposes every Core Collection through `ThreadStore.collections`, including Thread, Branch, Message Entry, Run, Stored Tool Call, claims, pending commands, idempotency Records, and other Runtime state.
- A host can add or replace fields on every Core Record. The same select-output compatibility rule protects the types that Core reads.
- Core owns all Runtime transition rules. Adapters provide a `Store` over the complete effective Collection catalog. A `TransactionStore` preserves the stronger Runtime guarantee profile.
- A Record definition contains a `fields` map. Each entry is either one Field Schema shorthand or an object with `select`, optional `create`, and optional `update` Field Schemas.
- A plain Field Schema is used for select, create, and update.
- In an object definition, missing `create` uses `select`; missing `update` uses `create`, which can itself fall back to `select`.
- Store keeps each supplied schema object unchanged and depends only on its Standard Schema contract. Extra schema-library features remain available to other packages but are outside the Store contract.
- Field Schemas are deterministic validation and transformation functions for one input value. They must not perform external side effects or depend on invocation count. Hooks and adapter generation own effectful value production.
- Every defined Field Schema output must be JSON-compatible or `undefined`. An `undefined` output means the Record key is omitted; Store never returns or stores an own property whose value is `undefined`.
- Store validation is field-local. It does not express checks or transformations that depend on two Record fields. Core or host logic owns those rules.
- Full and projected reads use the selected fields' `select` schemas.
- Create validates each field with its `create` schema or fallback. Literal update validates each supplied field with its `update` schema or fallback.
- A missing read or create field is passed as `undefined` to its effective operation schema. Rejection means the field is required, a defined output supplies the field value or default, and an `undefined` output omits the key.
- An update field that is not present in `set` remains unchanged and its update schema does not run.
- Record parsing is strict at the top-level boundary. Create and update reject keys absent from the Record definition. Full adapter results reject unknown Record keys, and projected results reject keys that were not selected. Store never passes through or silently strips an unknown top-level key.
- A Field Schema owns parsing inside its one field value, including nested unknown-key behavior and intentional transformations.
- Every defined effective select, create, and update output must be assignable to the effective select input. `undefined` means omission and is excluded from this check. Static types check defined value shapes; runtime refinements run before a value becomes a selected or stored Record field.
- The Select Field Schema produces the canonical public, operator-facing, and stored field value. Defined create, update, expression, generated, and decoded values run through it, and Store keeps its output rather than the earlier operation output.
- A Select Field Schema output must be stable when it passes through that effective Select Field Schema again. This idempotence is a Record contract, not a second runtime validation pass. A non-idempotent Select transformation is not a valid Record definition.
- Every field in a complete changed Record passes its effective Select Field Schema before that candidate is written.
- Query and update field references read effective selected field values. A native operator must preserve this boundary. If it cannot, the adapter must use a safe fallback or report `UnsupportedStoreOperationError`.
- Adapter-specific generation can fill a field only when its parsed create output is `undefined`. A defined host value always wins. An adapter cannot overwrite it and must reject a create it cannot honor. Every generated value becomes an effective Select Field Schema output before storage.
- Every built-in Core Record field map is added automatically.
- `records` contributes complete new Records. `overrides` applies typed deep patches to existing Core, integration, or host contributions. One key never silently serves both roles.
- An override can refine existing fields or add complete fields, but it cannot remove contributor Record or field keys. Duplicate contributions fail until the host selects or renames one explicitly.
- Built-in Core Field Schemas can use Effect Schema internally. Public types accept any Standard Schema library.
- Custom Records are allowed beside Core Records.
- A Store definition can define one `beforeCreate` hook for each effective Collection. The hook applies to every host or Core call to `create`.
- Store passes the unvalidated create draft to the hook before any Create Field Schema runs. The hook returns a typed patch. Store shallow-merges that patch over the draft and then performs normal strict create validation.
- Required create fields that are required properties of the inferred hook patch become optional in the matching public `Collection.create` input. All other required create fields remain required.
- One logical Core operation runs a hook once over a plain Store. It can run once in each of three Transaction Store attempts. External hook side effects and repeat safety remain the host's responsibility.
- Every Commissary command that directly creates a Core Record accepts a typed `fields` bag that contains only host-added fields for that Record. Hook-supplied fields and optional or defaulted fields remain optional in that bag.
- A required custom field on an internal Core create path must be supplied by the inferred patch of that Collection's `beforeCreate` hook. A command-only create path does not require a hook.
- A Run Snapshot is a snapshot object with the complete effective selected Run Record under `run`.
- Snapshot-owned properties such as `head`, `toolCalls`, and `suspensions` remain at the top level.
- Every built-in and host-added Run Record field stays under `snapshot.run`. A matching built-in Core field uses its compatible narrowing there.
- Run Record properties are not copied to the snapshot top level. Separate namespaces allow `snapshot.head` and a host-defined `snapshot.run.head` to coexist.
- Each `snapshot.toolCalls` item is the complete effective selected Stored Tool Call Record. Host-added fields and compatible Core field narrowings stay directly on that item.
- There is no extra Tool Call wrapper and no `.toolCall` property inside each array item.

### Collection operations

- Store exposes one readonly `collections` map keyed by every Record name. Dot access supports known names, and bracket access supports typed dynamic names. There is no `collection(name)` method or direct Collection property on Store.
- Collection methods are `find`, `create`, `update`, `delete`, and `count`.
- Base Collection methods accept no `AbortSignal` or other cancellation option. An integration that needs cancellation must require a separately designed cancellation-capable Store type.
- There is no `findFirst` or `findMany`.
- `find` returns `readonly Record[]` or a projected readonly array.
- `find` supports `where`, `select`, `orderBy`, `limit`, and `offset`.
- Logical `find` order is `where`, `orderBy`, `offset`, `limit`, and then projection. The first returned order expression is the primary key, later expressions break ties, and an empty order array is the same as omitted `orderBy`.
- Without `orderBy`, result order is not portable. Callers must not use `offset` for stable paging unless they supply enough order fields to make the order unique.
- An omitted `limit` requests every matching Record. The fallback supports this. An adapter can document a global or per-Collection maximum and reject an excessive request with `UnsupportedStoreOperationError` feature `find.limit`; it cannot silently truncate.
- `limit` and `offset` must be nonnegative safe integers. `limit: 0` returns an empty array, and `offset: 0` skips nothing. Invalid values reject with `StoreValidationError`, phase `query`, and field `limit` or `offset` before the adapter runs.
- Fallback ordering is stable. Records that tie across every returned order expression keep their prior order. The Store adds no hidden tie-breaker. An adapter with different tie behavior documents it and covers it in adapter conformance tests.
- Joins, relations, grouping, aggregates, and custom expressions are not base `find` features.
- `create` accepts one input and returns one complete selected Record.
- Bulk creation is not a base operation. A caller can repeat `create` in a transaction; an adapter can add native bulk insertion.
- `update` and `delete` return the exact number of affected Records only after complete success.
- `update` accepts `where` and `set` only.
- `delete` accepts `where` only.
- Missing `where` means all Records.
- A mutation failure starts no later candidate writes, drains already active writes, and rejects with `writesMayRemain` set from the complete operation's progress.

### Query expressions

- `where` receives typed fields and Store operators. It does not accept an arbitrary JavaScript predicate.
- Every Store callback receives one `op` object that contains all operators from its Store Operator Set.
- The confirmed fallback operator set is:
  - `eq`
  - `lt`
  - `lte`
  - `gt`
  - `gte`
  - `and`
  - `or`
  - `not`
  - `inArray`
  - `isNull`
  - `asc`
  - `desc`
- `ne`, `notInArray`, and `isNotNull` are derived helpers, not adapter primitives.
- These rules define the shared fallback behavior. An adapter can define different behavior for the same operator names.
- Fallback query evaluation first parses each referenced field with its effective select Field Schema. A field whose parsed output remains missing is normalized to `null`. Thus `eq(field, null)`, `inArray(field, [null])`, and `isNull(field)` match both parsed-missing and explicit `null`, while a schema default is a defined value.
- Order comparisons accept optional or nullable string and numeric fields but return false when either parsed operand is missing or `null`.
- `asc` and `desc` accept only fields whose complete selected type is assignable to either required non-null `string` or finite `number`. They reject a string-or-number union, so fallback sorting needs no cross-type or null-placement rule.
- `eq` uses structural JSON equality:
  - object key order does not matter;
  - array order matters;
  - scalar values compare by value.
- Fallback `inArray(value, candidates)` uses the `eq` rules. An empty candidate array is always false, and duplicate candidates do not change the result. An adapter can document a candidate maximum and reject a larger array with `UnsupportedStoreOperationError` feature `query.inArray.candidate-limit`.
- Fallback `and` and `or` accept `undefined` arguments and ignore them. After removal, an empty `and()` is true and an empty `or()` is false. Other predicate operators do not accept `undefined`.
- Fallback order comparisons accept only strings or finite numbers. Both operands must have the same runtime type, and the fallback performs no coercion. A cross-type or non-finite supplied operand rejects with `StoreValidationError`, phase `query`, before storage execution.
- Fallback string ordering uses JavaScript relational comparison. It is case-sensitive and does not use locale rules. The same order applies to `lt`, `lte`, `gt`, `gte`, `asc`, and `desc`. An adapter that uses another collation documents the configured or backend-defined order and tests against that order.
- Nested query fields use immutable nonempty path tuples of object-key strings. They do not use dot-separated strings and do not expose array-index paths.
- `@commissary/store` provides a JavaScript reference evaluator and reference behavior tests.

### Fallbacks and mutation safety

- An adapter can implement a Collection method natively or delegate it to an optional shared fallback helper.
- The adapter owns fallback selection and supplies any storage-specific operations that the helper needs.
- Fallback helpers do not form a required adapter interface.
- Read operators can use JavaScript fallbacks, including scans where necessary.
- A mutation fallback identifies and validates each candidate before its write.
- A transaction can strengthen a mutation fallback with operation-wide rollback and isolation, but Base Store does not require it.
- A fallback can stage all candidates or process them incrementally. After the first failure it starts no new writes and drains already active writes.
- Every base Collection method is a required Store capability. An adapter that can never implement one safely does not implement `Store`.
- If a required method or typed operator is unavailable only for the supplied input, schema, configuration, or current backend state, the adapter reports `UnsupportedStoreOperationError`.
- An adapter omits an operator from its Store Operator Set type when the operator is never supported.
- Runtime-dependent limit failures use `UnsupportedStoreOperationError` with a stable feature string. Store exposes no runtime maximum or capability registry.
- Adapter output that violates an effective select Field Schema is a defect and states whether its write can remain.
- Failed create cleanup and rollback are out of scope for the first version.

### Update expressions

- Base Store update expressions are accepted as a useful capability.
- The `set` callback builds typed expressions; it is not an arbitrary JavaScript updater.
- `@commissary/store` provides reference fallback implementations for update operators.
- The confirmed fallback update operator set is `add`, `subtract`, `multiply`, `divide`, `modulo`, `concat`, `coalesce`, `ifElse`, `unset`, `merge`, and `filter`.
- Every fallback expression in one `set` callback reads the Record as it existed before the update. Object property order does not affect results.
- Fallback arithmetic uses JavaScript `number` behavior for `add`, `subtract`, `multiply`, `divide`, and `modulo`. Operands and results must be finite. A non-finite result rejects with `StoreValidationError`, phase `update`. Earlier candidate writes can remain.
- Fallback `concat` accepts either two strings or two arrays. It performs no coercion. Array concatenation preserves order and duplicates and infers a readonly array of the union of both element types; it does not preserve tuple length or tuple positions.
- Fallback `coalesce(left, fallback)` returns `left` unless it is `null` or missing. It evaluates `fallback` only when needed; false, zero, and the empty string are defined values. Its output type is the union of the defined left type and the fallback type.
- Fallback `ifElse(predicate, whenTrue, whenFalse)` evaluates the predicate and only the selected value branch. An error in an unselected branch does not reject the update. Its output type is the union of both branch types.
- Store validates the complete expression tree, including every lazy branch, before execution. Laziness applies only to value evaluation, not to operator-set or callback-scope validation.
- A raw literal returned beside expressions from a `set` callback passes through that field's effective update Field Schema. A `ValueExpression` result does not run through the update schema; it reads selected values and the complete changed Record must pass every effective select Field Schema.
- Fallback `unset()` removes either a top-level Record field or an object key inside `merge`. There is no separate path-based delete operator. A key is removable only when `{} extends Pick<Value, Key>` is true for the selected output type. Store uses no schema-library metadata. A required-key removal that bypasses static typing fails effective select Field Schema validation before that candidate is written.
- The `merge(target, patch)` fallback performs a shallow object merge:
  - patch keys replace target keys;
  - nested objects and arrays replace complete values;
  - `null` is a stored value;
  - `unset()` is the only way to remove a key.
- The fallback `filter(array, predicate)`:
  - passes only the current array element to `predicate`;
  - does not expose the element index or parent Record;
  - preserves the original order and keeps every matching duplicate;
  - exposes typed field references for object elements, such as `job.status`;
  - allows nested object fields at any depth but not array-index paths such as `job.steps[0]`;
  - uses the fallback query rules for `null` and missing fields: `isNull` matches both, and order comparisons match neither.
- Adapters can replace fallback operator implementations with native implementations or optimizations.
- Every adapter operator returns a Store Expression instead of a raw native expression object.
- A Store Expression contains the adapter's native value and carries its operator-set identity plus one opaque callback-scope token. Each `where`, `orderBy`, `set`, or `filter` callback invocation gets a new frozen token. Store invokes each builder callback once.
- `filter` validates its child predicate against the nested filter callback token before it creates the outer update expression. The returned outer node carries only the enclosing `set` token, so valid nested scopes do not look like escaped expressions.
- Store validates every returned expression node against both identities before adapter execution. An escaped expression, an expression reused in another callback, or an expression from another operator set rejects with `StoreValidationError` in the current query or update phase.
- Memory evaluates the expression language in JavaScript.
- Native adapters can translate expression values to native operations.
- The same operator name can behave differently in different adapters. Each adapter README documents fallback versus adapter-defined semantics, string collation, equal-value tie behavior, and any `inArray` or `find` limits.
- Each adapter test suite passes an adapter-owned conformance profile to shared test helpers. That profile is test input only; it is not exported on Store values as a runtime capability registry.

## Alternatives Considered

### Option 1: Put all Store interfaces in core

Core would define Store, Collection, operators, transactions, Thread Store operations, and adapter extensions.

**Rejected**:

- A generic persistence module is not core agent behavior.
- SQL and other adapter capabilities would expand core's public surface.
- Generic adapters could not depend on the Store contracts without also depending on core.

### Option 2: Separate Store package with a Thread Store specialization

```txt
@commissary/store
        ↑
@commissary/core
        ↑
Thread Store adapters
```

`@commissary/store` owns generic persistence. Core owns Core Records and Thread Store operations. Adapter packages combine the interfaces they support.

**Selected**: This places the seam at the reusable persistence contract while keeping Runtime invariants in core.

### Option 3: Expose only generic CRUD for Runtime transitions

Callers would implement submission, claims, commits, and finalization as their own Collection call sequences.

**Rejected**:

- Generic CRUD does not give callers the semantic outcomes of current multi-Record transitions.
- Each caller would have to reproduce fencing, idempotency, and conflict rules.
- The selected design keeps specialized Thread Store methods but implements them once in core with Collection calls inside a transaction.

### Option 4: Type-only extra-field map

A Thread Store generic would list extra fields for Thread, Branch, Message, Run, and Tool Call Records.

**Rejected**:

- It cannot define Custom Records.
- It has no runtime schema, validation, or typed adapter extension point.
- It creates a second input/output type system beside persistence schemas.

### Option 5: Whole-Record Schemas

One or more Standard Schemas would validate complete Records for reads, creates, and updates.

**Rejected**:

- Standard Schema exposes whole-value validation but does not expose a validator for one field.
- A projected read could not validate selected values without also reading the complete Record.
- Extending a Core Record across different schema libraries would require a special composition helper.
- Whole-Record checks and transformations can depend on fields that a projection does not contain.

The selected per-field model keeps Store validation local to each field. Core and host logic own rules between fields.

## Recommendation

Build `@commissary/store` around a small Store and Collection interface. Keep query and update expressions as typed immutable values. Let adapter modules translate or evaluate those values. Keep current Thread Store state transitions as the deeper Runtime interface.

Implementation must follow the confirmed contracts and the Red-Green test order in this document.

## Design

## Domain Model and Types

### Field Schemas

```ts
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { JsonValue } from "./json.js";

export type JsonObject = {
  readonly [key: string]: JsonValue;
};

export type FieldSchema<
  Input = unknown,
  Output extends JsonValue | undefined = JsonValue | undefined,
> = StandardSchemaV1<Input, Output>;

type FieldInput<Schema extends FieldSchema> = StandardSchemaV1.InferInput<Schema>;
type FieldOutput<Schema extends FieldSchema> = StandardSchemaV1.InferOutput<Schema>;

type DefinedFieldOutput<Schema extends FieldSchema> = Exclude<FieldOutput<Schema>, undefined>;

export type FieldDefinition =
  | FieldSchema
  | {
      readonly select: FieldSchema;
      readonly create?: FieldSchema;
      readonly update?: FieldSchema;
    };

export type FieldDefinitions = Readonly<Record<string, FieldDefinition>>;

export interface RecordDefinition<Fields extends FieldDefinitions = FieldDefinitions> {
  readonly fields: Fields;
}

type SelectFieldSchema<Field extends FieldDefinition> = Field extends FieldSchema
  ? Field
  : Field["select"];

type CreateFieldSchema<Field extends FieldDefinition> = Field extends FieldSchema
  ? Field
  : Field extends { readonly create: infer Schema extends FieldSchema }
    ? Schema
    : Field["select"];

type UpdateFieldSchema<Field extends FieldDefinition> = Field extends FieldSchema
  ? Field
  : Field extends { readonly update: infer Schema extends FieldSchema }
    ? Schema
    : CreateFieldSchema<Field>;

type RoundTripFieldDefinition<Field extends FieldDefinition> =
  DefinedFieldOutput<SelectFieldSchema<Field>> extends FieldInput<SelectFieldSchema<Field>>
    ? DefinedFieldOutput<CreateFieldSchema<Field>> extends FieldInput<SelectFieldSchema<Field>>
      ? DefinedFieldOutput<UpdateFieldSchema<Field>> extends FieldInput<SelectFieldSchema<Field>>
        ? Field
        : never
      : never
    : never;

export type SelectedRecord<Definition extends RecordDefinition> = RecordFromFieldOutputs<
  SelectFieldSchemas<Definition["fields"]>
>;

export type CreateInput<Definition extends RecordDefinition> = RecordFromFieldInputs<
  CreateFieldSchemas<Definition["fields"]>
>;

export type UpdateInput<Definition extends RecordDefinition> = Partial<
  RecordFromFieldInputs<UpdateFieldSchemas<Definition["fields"]>>
>;
```

`RoundTripFieldDefinition` rejects a Field Definition unless every defined effective select, create, and update output can be passed to the effective select input. An `undefined` output means omission and is not checked as a stored value. Store construction applies this constraint to every field. Runtime refinements can still reject a statically compatible value, so each written value also passes through its select parser.

`SelectFieldSchemas`, `CreateFieldSchemas`, and `UpdateFieldSchemas` map each field definition to the effective schema for that operation. `RecordFromFieldOutputs` and `RecordFromFieldInputs` make a property optional exactly when the related inferred output or input type permits `undefined`.

The base Store has no `create: false` or `update: false` flags. An adapter default fills only an omitted create output. A host can reject every supplied literal update value with a schema such as `z.never()`. Update expressions use selected values and final select validation instead; Field Schemas are validation contracts, not write authorization.

`FieldSchema`, `JsonValue`, and these inference helpers live in `@commissary/store`. The package does not import them from core. A complete Record is never passed to one Field Schema.

### Core Record compatibility

Type-level rule:

```ts
type CompatibleCoreField<CoreValue, Candidate extends FieldDefinition> =
  Exclude<StandardSchemaV1.InferOutput<SelectFieldSchema<Candidate>>, undefined> extends CoreValue
    ? Candidate
    : never;
```

This catches a wrongly typed override while allowing added fields:

```ts
MemoryThreadStore.make({
  records: {
    thread: {
      fields: {
        ownerId: z.string().uuid(),
      },
    },

    run: {
      fields: {
        // Compile-time error: Core Run status is a string union.
        status: z.number(),
      },
    },
  },
});
```

The exact compatibility type must keep useful field input inference and clear compiler errors. TypeScript cannot prove that a runtime refinement accepts every value core can produce.

### Effective Record catalog

```ts
type DurableEntityRecordDefinitions = {
  readonly thread: RecordDefinition<CoreThreadFields>;
  readonly branch: RecordDefinition<CoreBranchFields>;
  readonly message: RecordDefinition<CoreMessageFields>;
  readonly run: RecordDefinition<CoreRunFields>;
  readonly toolCall: RecordDefinition<CoreToolCallFields>;
};

type CoreRecordDefinitions = DurableEntityRecordDefinitions & RuntimeStateRecordDefinitions;

type EffectiveRecordDefinitions<Provided> = MergeRecordFields<CoreRecordDefinitions, Provided>;
```

`RuntimeStateRecordDefinitions` is the complete Core-owned map for claims, pending commands, idempotency Records, finalization outcomes, and other durable Runtime state.

The version 1 Runtime state catalog is:

```ts
type RuntimeStateRecordDefinitions = {
  readonly executionClaim: RecordDefinition<CoreExecutionClaimFields>;
  readonly executionFence: RecordDefinition<CoreExecutionFenceFields>;
  readonly pendingSteering: RecordDefinition<CorePendingSteeringFields>;
  readonly pendingRedirect: RecordDefinition<CorePendingRedirectFields>;
  readonly runCommandSequence: RecordDefinition<CoreRunCommandSequenceFields>;
  readonly toolCallSequence: RecordDefinition<CoreToolCallSequenceFields>;
  readonly runSubmission: RecordDefinition<CoreRunSubmissionFields>;
  readonly toolResumeRequest: RecordDefinition<CoreToolResumeRequestFields>;
  readonly steeringRequest: RecordDefinition<CoreSteeringRequestFields>;
  readonly redirectRequest: RecordDefinition<CoreRedirectRequestFields>;
  readonly commit: RecordDefinition<CoreCommitFields>;
  readonly finalizationOutcome: RecordDefinition<CoreFinalizationOutcomeFields>;
  readonly modelCommitOutcome: RecordDefinition<CoreModelCommitOutcomeFields>;
  readonly settlementOutcome: RecordDefinition<CoreSettlementOutcomeFields>;
};
```

| Collection            | Built-in Core fields                                  | Current Memory state replaced                |
| --------------------- | ----------------------------------------------------- | -------------------------------------------- |
| `executionClaim`      | `runId`, `executionId`, `token`, `fence`, `expiresAt` | `#claims`                                    |
| `executionFence`      | `runId`, `fence`                                      | `#fences`                                    |
| `pendingSteering`     | `runId`, `sequence`, `message`                        | entries inside `#pendingSteering`            |
| `pendingRedirect`     | `runId`, `sequence`, `message`                        | entries inside `#pendingRedirects`           |
| `runCommandSequence`  | `runId`, `sequence`                                   | `#commandSequences`                          |
| `toolCallSequence`    | `runId`, `sequence`                                   | `ToolCallGraph.nextSequence`                 |
| `runSubmission`       | `runId`, `fingerprint`, `result`                      | `#startFingerprints` and `#startSubmissions` |
| `toolResumeRequest`   | `runId`, `requestId`, `fingerprint`, `result`         | `#resumeRequests`                            |
| `steeringRequest`     | `runId`, `requestId`, `fingerprint`, `result`         | `#steeringRequests`                          |
| `redirectRequest`     | `runId`, `requestId`, `fingerprint`, `result`         | `#redirectRequests`                          |
| `commit`              | `commitId`, `fingerprint`                             | `#commits`                                   |
| `finalizationOutcome` | `commitId`, `outcome`                                 | `#finalizationOutcomes`                      |
| `modelCommitOutcome`  | `commitId`, `outcome`                                 | `#modelCommitOutcomes`                       |
| `settlementOutcome`   | `commitId`, `outcome`                                 | `#settlementOutcomes`                        |

The durable `toolCall` Collection replaces `ToolCallGraph.calls`. Tool Call order comes from `sequence`; delegated lookup comes from `runId`, `parentToolCallId`, and `delegationKey`; resumability comes from `status` and `suspension.resumeInput`. These are indexes or derived queries, not additional Collections. `#controlWaiters` remains process-local coordination and is not durable Record state.

The `result` and `outcome` fields use the effective customized Core Record types when they contain a Thread, Branch, Message, Run, or Tool Call value. Core does not narrow them back to the built-in Record types.

`MergeRecordFields` adds every omitted Core Record, keeps Custom Records, and merges the `fields` map for every supplied Core Record. A host field with the same name replaces the built-in Field Definition only after a compile-time compatibility check. No `extendRecord()` helper is required. Every resulting Collection is available through the host-facing Thread Store.

### Before-create hooks

Every generic Store and Thread Store definition can contain one synchronous `beforeCreate` hook for each effective Collection. The hook runs for host `Collection.create` calls and for Core create paths. It receives the unvalidated draft and returns a patch. Store shallow-merges the patch over the draft before it rejects unknown keys or runs any Create Field Schema.

Hook creation and Store definition perform no I/O. A hook can perform host work when a create operation invokes it, but it can run again for another create attempt. Core can make three storage-only transaction attempts after conflicts, so external hook effects must be repeat-safe.

The public type model is:

```ts
type RequiredKeys<Value> = {
  readonly [Key in keyof Value]-?: {} extends Pick<Value, Key> ? never : Key;
}[keyof Value];

type BeforeCreateHookConstraint<Definition extends RecordDefinition> = {
  readonly beforeCreate: (input: {
    readonly draft: Partial<CreateInput<Definition>>;
  }) => Partial<CreateInput<Definition>>;
};

type StoreHooks<Definitions extends RecordDefinitions> = Partial<{
  readonly [Name in keyof Definitions]: BeforeCreateHookConstraint<Definitions[Name]>;
}>;

type HookPatch<Hooks, Name extends PropertyKey> = Name extends keyof Hooks
  ? Hooks[Name] extends {
      readonly beforeCreate: (...arguments_: never[]) => infer Patch;
    }
    ? Patch
    : {}
  : {};

type HookProvidedCreateKeys<
  Hooks,
  Name extends PropertyKey,
  Definition extends RecordDefinition,
> = Extract<RequiredKeys<HookPatch<Hooks, Name>>, keyof CreateInput<Definition>>;

type HookAdjustedCreateInput<
  Definition extends RecordDefinition,
  HookProvidedKeys extends keyof CreateInput<Definition>,
> = Omit<CreateInput<Definition>, HookProvidedKeys> &
  Partial<Pick<CreateInput<Definition>, HookProvidedKeys>>;

export type DefaultStoreCreateInputs<Definitions extends RecordDefinitions> = {
  readonly [Name in keyof Definitions]: CreateInput<Definitions[Name]>;
};

type HookAdjustedStoreCreateInputs<
  Definitions extends RecordDefinitions,
  Hooks extends StoreHooks<Definitions>,
> = {
  readonly [Name in keyof Definitions]: HookAdjustedCreateInput<
    Definitions[Name],
    HookProvidedCreateKeys<Hooks, Name, Definitions[Name]>
  >;
};
```

The factory infers the exact hook return type before it checks `BeforeCreateHookConstraint`. A required property in that return type is a field the hook guarantees. An optional or conditional return property supplies no static guarantee and does not make the related create input optional. Store merges the returned patch into the draft; hooks need no separate list of supplied field names.

A base Store hook receives the matching public create input as its draft. The returned Store uses `HookAdjustedStoreCreateInputs`, so hook-provided required fields are optional for direct `Collection.create` calls. Without a hook, the Collection keeps its normal `CreateInput`.

Core drafts need additional rules. `CoreCreateDrafts` has one entry for every Core Record because Core creates each Record through a command or an internal Runtime path. The command-created Records are `thread`, `branch`, and `run`. Every other Core Record has an internal create path in version 1.

The durable entity drafts contain these built-in values:

| Collection | Core create draft fields                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread`   | `id`                                                                                                                                                                                                 |
| `branch`   | `id`, `threadId`, `name`, optional `head`                                                                                                                                                            |
| `message`  | `id`, `threadId`, optional `parent`, `message`                                                                                                                                                       |
| `run`      | `id`, `threadId`, `branchId`, `agent`, `admittedHead`, `status`, `abortRequested`, `settlementContinuations`                                                                                         |
| `toolCall` | `toolCallId`, `runId`, `sequence`, `toolName`, optional `parentToolCallId`, optional `providerId`, optional `delegationKey`, `requestedInput`, `status`, optional `providerData`, `historyCommitted` |

Each Runtime state draft contains all built-in fields listed in the Runtime state catalog table. Fields added later by update, such as Run `usage` or Tool Call `result`, are not create-draft fields.

For a Thread Store hook, the contextual draft type contains the known Core draft and makes every other effective create field optional. A required custom create field on an internal path must be a required property of the inferred hook patch. Otherwise, the Thread Store definition is a compile-time error. Runtime validation remains required because a Standard Schema can declare an `unknown` input and still reject `undefined`.

A command `fields` bag contains only host-added fields for its primary Core Record. A hook-provided field becomes optional in that bag. A required field that the hook does not guarantee remains required. A later Record can have both command and internal create paths; the same adjusted input rules apply to both.

Hook execution order is:

```txt
host create input, or Core built-in draft plus command fields
  -> beforeCreate hook returns a patch
  -> shallow-merge the patch over the draft
  -> reject unknown top-level keys
  -> parse every field with its effective create Field Schema
  -> adapter fills only omitted generated values
  -> adapter write
  -> select validation
```

The hook can replace any draft value. This power can break Runtime behavior and is intentional. A hook runs once per create attempt. A thrown value is wrapped in `StoreHookError`; no adapter work starts.

### Query expressions

```ts
declare const fieldType: unique symbol;
declare const predicateType: unique symbol;
declare const orderType: unique symbol;

export type FieldPath = readonly [string, ...string[]];

interface FieldNode<Value> {
  readonly [fieldType]: Value;
}

type NestedFields<Value> =
  NonNullable<Value> extends readonly JsonValue[]
    ? {}
    : NonNullable<Value> extends JsonObject
      ? Fields<NonNullable<Value>>
      : {};

export type Field<Value> = FieldNode<Value> & NestedFields<Value>;

export interface Predicate {
  readonly [predicateType]: true;
}

export interface Order {
  readonly [orderType]: true;
}

export type Fields<Record extends JsonObject> = {
  readonly [Key in keyof Record]-?: Field<Record[Key]>;
};

export interface QueryOperators {
  readonly eq: <Value extends JsonValue>(
    left: Field<Value | undefined> | Value,
    right: Field<Value | undefined> | Value,
  ) => Predicate;

  readonly lt: CompareOperator;
  readonly lte: CompareOperator;
  readonly gt: CompareOperator;
  readonly gte: CompareOperator;

  readonly and: (...predicates: readonly (Predicate | undefined)[]) => Predicate;
  readonly or: (...predicates: readonly (Predicate | undefined)[]) => Predicate;
  readonly not: (predicate: Predicate) => Predicate;

  readonly inArray: <Value extends JsonValue>(
    field: Field<Value | undefined>,
    values: readonly Value[],
  ) => Predicate;

  readonly isNull: (field: Field<JsonValue | undefined>) => Predicate;
  readonly asc: OrderOperator;
  readonly desc: OrderOperator;
}

interface CompareOperator {
  <Value extends string>(
    left: Field<Value | null | undefined> | Value,
    right: Field<Value | null | undefined> | Value,
  ): Predicate;

  <Value extends number>(
    left: Field<Value | null | undefined> | Value,
    right: Field<Value | null | undefined> | Value,
  ): Predicate;
}

interface OrderOperator {
  (field: Field<string>): Order;
  (field: Field<number>): Order;
}
```

The base fallback owns its expression tree. Each adapter owns the native payload inside its Store Expressions. `@commissary/store` does not require one universal expression tree for every adapter.

The public `Field` type exposes nested object fields through normal property access. Internally, each field node stores its root and `FieldPath`, the operator-set identity, and the current callback-scope token. Array values expose no numeric properties. `filter` uses a separate element root and the same object-key tuple representation below that root; the root itself is not an array index or encoded path segment.

### Update expressions

Confirmed shape and operator names:

```ts
declare const valueExpressionType: unique symbol;
declare const unsetType: unique symbol;
declare const baseStoreOperatorSet: unique symbol;

export type BaseStoreOperatorSetId = typeof baseStoreOperatorSet;

export interface ValueExpression<Value extends JsonValue | undefined, OperatorSet> {
  readonly [valueExpressionType]: {
    readonly value: Value;
    readonly operatorSet: OperatorSet;
  };
}

export interface UnsetExpression<OperatorSet> {
  readonly [unsetType]: OperatorSet;
}

export type OptionalKeys<Value extends object> = {
  readonly [Key in keyof Value]-?: {} extends Pick<Value, Key> ? Key : never;
}[keyof Value];

export type UpdateValue<
  LiteralInput,
  SelectedValue extends JsonValue | undefined,
  OperatorSet,
  Removable extends boolean,
> =
  | LiteralInput
  | ValueExpression<SelectedValue, OperatorSet>
  | (Removable extends true ? UnsetExpression<OperatorSet> : never);

type SelectedFieldValue<
  Definition extends RecordDefinition,
  Key extends keyof Definition["fields"],
> = Extract<
  Key extends keyof SelectedRecord<Definition> ? SelectedRecord<Definition>[Key] : never,
  JsonValue | undefined
>;

export type UpdateSet<Definition extends RecordDefinition, OperatorSet> = {
  readonly [Key in keyof Definition["fields"]]?: UpdateValue<
    FieldInput<UpdateFieldSchema<Definition["fields"][Key]>>,
    SelectedFieldValue<Definition, Key>,
    OperatorSet,
    Key extends OptionalKeys<SelectedRecord<Definition>> ? true : false
  >;
};

export interface UpdateExpressionOperators<OperatorSet = BaseStoreOperatorSetId> {
  // Every returned expression is bound to one callback scope.
  readonly add: NumericBinaryExpression<OperatorSet>;
  readonly subtract: NumericBinaryExpression<OperatorSet>;
  readonly multiply: NumericBinaryExpression<OperatorSet>;
  readonly divide: NumericBinaryExpression<OperatorSet>;
  readonly modulo: NumericBinaryExpression<OperatorSet>;
  readonly concat: ConcatExpression<OperatorSet>;
  readonly coalesce: CoalesceExpression<OperatorSet>;
  readonly ifElse: IfElseExpression<OperatorSet>;
  readonly unset: () => UnsetExpression<OperatorSet>;
  readonly merge: ObjectMergeExpression<OperatorSet>;

  readonly filter: ArrayFilterExpression<OperatorSet>;
}
```

Every expression in one `set` operation reads the pre-update Record. Callback property order cannot change expression inputs.

## Types, Interfaces, and APIs

### Collection

Confirmed interface:

```ts
export interface StoreOperatorTypes {
  readonly operators: object;
  readonly predicate: unknown;
  readonly order: unknown;
  readonly expressionOwner: unknown;
}

export type BaseStoreOperators = QueryOperators & UpdateExpressionOperators<BaseStoreOperatorSetId>;

export type BaseStoreOperatorTypes = {
  readonly operators: BaseStoreOperators;
  readonly predicate: Predicate;
  readonly order: Order;
  readonly expressionOwner: BaseStoreOperatorSetId;
};

export interface Collection<
  Definition extends RecordDefinition,
  Operators extends StoreOperatorTypes = BaseStoreOperatorTypes,
  Create extends JsonObject = CreateInput<Definition>,
> {
  readonly find: <
    const Select extends Selection<SelectedRecord<Definition>> | undefined = undefined,
  >(
    options?: FindOptions<SelectedRecord<Definition>, Select, Operators>,
  ) => Promise<readonly Project<SelectedRecord<Definition>, Select>[]>;

  readonly create: (input: Create) => Promise<SelectedRecord<Definition>>;

  readonly update: (input: UpdateOptions<Definition, Operators>) => Promise<number>;

  readonly delete: (
    input?: DeleteOptions<SelectedRecord<Definition>, Operators>,
  ) => Promise<number>;

  readonly count: (input?: CountOptions<SelectedRecord<Definition>, Operators>) => Promise<number>;
}

export interface FindOptions<
  Record extends JsonObject,
  Select extends Selection<Record> | undefined,
  Operators extends StoreOperatorTypes,
> {
  readonly where?: (
    fields: Fields<Record>,
    operators: Operators["operators"],
  ) => Operators["predicate"];
  readonly select?: Select;
  readonly orderBy?: (
    fields: Fields<Record>,
    operators: Operators["operators"],
  ) => ReadonlyArray<Operators["order"]>;
  readonly limit?: number;
  readonly offset?: number;
}

export interface UpdateOptions<
  Definition extends RecordDefinition,
  Operators extends StoreOperatorTypes,
> {
  readonly where?: (
    fields: Fields<SelectedRecord<Definition>>,
    operators: Operators["operators"],
  ) => Operators["predicate"];
  readonly set:
    | UpdateInput<Definition>
    | ((
        fields: Fields<SelectedRecord<Definition>>,
        operators: Operators["operators"],
      ) => UpdateSet<Definition, Operators["expressionOwner"]>);
}

export interface WhereOptions<Record extends JsonObject, Operators extends StoreOperatorTypes> {
  readonly where?: (
    fields: Fields<Record>,
    operators: Operators["operators"],
  ) => Operators["predicate"];
}

export type DeleteOptions<
  Record extends JsonObject,
  Operators extends StoreOperatorTypes,
> = WhereOptions<Record, Operators>;

export type CountOptions<
  Record extends JsonObject,
  Operators extends StoreOperatorTypes,
> = WhereOptions<Record, Operators>;
```

An omitted `where` matches all Records.

### Store

```ts
export type RecordDefinitions = Readonly<Record<string, RecordDefinition>>;

export type StoreCreateInputMap<Definitions extends RecordDefinitions> = {
  readonly [Name in keyof Definitions]: JsonObject;
};

export type StoreCollections<
  Definitions extends RecordDefinitions,
  Operators extends StoreOperatorTypes,
  CreateInputs extends StoreCreateInputMap<Definitions>,
> = {
  readonly [Name in keyof Definitions]: Collection<
    Definitions[Name],
    Operators,
    CreateInputs[Name]
  >;
};

export interface Store<
  Definitions extends RecordDefinitions,
  Operators extends StoreOperatorTypes = BaseStoreOperatorTypes,
  CreateInputs extends StoreCreateInputMap<Definitions> = DefaultStoreCreateInputs<Definitions>,
> {
  readonly collections: StoreCollections<Definitions, Operators, CreateInputs>;
}
```

Known and dynamic names use the same map:

```ts
const threads = store.collections.thread;
const selected = store.collections[name];
```

Store has no `collection(name)` method and does not place Collections directly on itself.

### Store errors

Store methods reject their native Promise with specific exported Error classes. Expected operational failures extend `StoreError`. Adapter contract violations use a separate defect class. Both error families report whether writes from the failed operation can remain.

```ts
export type StoreCollectionOperation = "find" | "create" | "update" | "delete" | "count";
export type StoreOperation = StoreCollectionOperation | "transaction" | "execute";
export type StoreValidationPhase = "query" | "create" | "update";

export interface StoreValidationIssue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}

export declare abstract class StoreError extends Error {
  readonly writesMayRemain: boolean;
}

export declare class StoreValidationError extends StoreError {
  readonly name: "StoreValidationError";
  readonly collection: string;
  readonly operation: StoreCollectionOperation;
  readonly phase: StoreValidationPhase;
  readonly field?: string;
  readonly issues: readonly StoreValidationIssue[];
}

export declare class StoreHookError extends StoreError {
  readonly name: "StoreHookError";
  readonly collection: string;
  readonly hook: "beforeCreate";
  readonly cause: unknown;
}

export declare class UnsupportedStoreOperationError extends StoreError {
  readonly name: "UnsupportedStoreOperationError";
  readonly collection: string;
  readonly operation: StoreCollectionOperation;
  readonly feature: string;
}

export declare class StoreAdapterError extends StoreError {
  readonly name: "StoreAdapterError";
  readonly collection?: string;
  readonly operation: StoreOperation;
  readonly cause: unknown;
}

export declare class TransactionConflictError extends StoreError {
  readonly name: "TransactionConflictError";
  readonly writesMayRemain: false;
  readonly cause?: unknown;
}

export declare class TransactionClosedError extends StoreError {
  readonly name: "TransactionClosedError";
  readonly writesMayRemain: false;
}

export declare class TransactionUnsettledOperationError extends StoreError {
  readonly name: "TransactionUnsettledOperationError";
  readonly writesMayRemain: false;
}

export declare class TransactionRollbackError extends StoreError {
  readonly name: "TransactionRollbackError";
  readonly callbackFailure: unknown;
  readonly rollbackFailure: unknown;
  readonly writesMayRemain: true;
}

export type StoreAdapterContractViolation =
  | "unknown-record-key"
  | "invalid-selected-record"
  | "generated-value-overwrite"
  | "invalid-expression-result"
  | "transaction-contract"
  | "invalid-sql-compilation"
  | "invalid-sql-result";

export declare class StoreAdapterContractError extends Error {
  readonly name: "StoreAdapterContractError";
  readonly collection?: string;
  readonly operation: StoreOperation;
  readonly violation: StoreAdapterContractViolation;
  readonly field?: string;
  readonly writesMayRemain: boolean;
  readonly cause?: unknown;
}
```

`writesMayRemain: false` means no write from the failed operation can remain. `true` is conservative: one or more writes can remain, but the error does not report which ones. Validation, unsupported-operation, hook, and adapter failures calculate the value from complete operation progress. A plain-Store Core transition wraps a later failure when earlier Collection calls succeeded so the exposed error reports `true`. A Transaction Store failure reports `false` after successful rollback and `TransactionRollbackError` reports `true`.

Store-generated messages and metadata never copy a complete operation input or Record. Safe metadata is limited to names, operation, Collection, phase, normalized issue path, field path, feature, violation, and `writesMayRemain`. A validation issue contains only a message and normalized path; it has no rejected-value property.

`StoreValidationIssue.message` comes from the Field Schema and can contain application data. Like `cause`, `callbackFailure`, and `rollbackFailure`, it is available for diagnosis but is not safe for default logs or telemetry. Store does not add Record values to these fields.

A transaction callback can still fail with any value. After successful rollback, `transaction` rejects with the selected callback boundary failure rather than wrapping it in `StoreError`.
A value thrown by a `where`, `orderBy`, `set`, or `filter` builder is also caller failure, not a Store operational failure. The method rejects its already-created native Promise with that exact value. The separate `beforeCreate` contract still wraps a thrown value in `StoreHookError`.

### Transaction Store

`TransactionStore.transaction` is the strong atomic grouping primitive. Core uses it when the supplied Thread Store backend implements `TransactionStore`. Overlapping transactions must produce the same result as some one-at-a-time order. One call invokes its callback at most once and reports a conflict instead of rerunning it. The callback View closes when its callback settles. Active Store work drains before rollback, and a rejected View operation marks the transaction for rollback even when callback code catches it. After rollback succeeds, `transaction` rejects with the exact selected boundary failure. If rollback fails, it rejects with `TransactionRollbackError` and does not retry. The callback cannot start a nested transaction. A wider adapter keeps each extra capability that it can bind to the same physical transaction.

```ts
export interface TransactionStore<
  Definitions extends RecordDefinitions,
  Operators extends StoreOperatorTypes = BaseStoreOperatorTypes,
  TransactionCapabilities extends {
    readonly [Key in keyof TransactionCapabilities]: Key extends "transaction"
      ? never
      : TransactionCapabilities[Key];
  } = {},
  CreateInputs extends StoreCreateInputMap<Definitions> = DefaultStoreCreateInputs<Definitions>,
> extends Store<Definitions, Operators, CreateInputs> {
  readonly transaction: <Value>(
    use: (
      transaction: Store<Definitions, Operators, CreateInputs> & TransactionCapabilities,
    ) => Promise<Value>,
  ) => Promise<Value>;
}

type ThreadStoreBackend<
  Definitions extends ThreadRecordDefinitions,
  Operators extends StoreOperatorTypes,
  CreateInputs extends StoreCreateInputMap<Definitions>,
> = Store<Definitions, Operators, CreateInputs>;
```

The callback argument intentionally has no `transaction` method. The default view is a plain Store. A wider adapter adds only capabilities that it can bind safely to the active transaction. Adapters do not implement nested transactions, savepoints, or adapter-specific nesting behavior in version 1.

The shared adapter helper at `@commissary/store/transaction-adapter` creates the View, tracks each complete View operation, closes the View, drains active work, and selects the callback boundary result. It does not start, commit, or roll back the adapter's physical transaction.

Failure priority is the callback's exact rejection, `TransactionUnsettledOperationError` for a successful callback with active work, the first failed View operation in call order, then commit. A method called after closure rejects with `TransactionClosedError` and starts no independent Store work.

If active work never settles, the transaction stays pending. It does not commit or race rollback against that work. Hosts must use backend-specific operation, transaction, session, and lock limits plus monitoring because base Store has no safe timeout or cancellation rule.

Core keeps the `ThreadStoreBackend` in a closure and returns `ThreadStore<Definitions, Operators>`. Both use the same complete effective Collection catalog.

For a plain Store, Core places complete storage-backed Thread Store operations in one queue per Thread Store instance. It reloads actual stored state for each operation, makes one attempt, and starts the next queued operation after success or failure. The queue does not protect another process or Thread Store instance and cannot undo completed writes.

When the backend is a Transaction Store, each adapter enforces transaction safety and rollback in its own storage system. The Memory adapter can use one lock plus its own rollback mechanism. A SQL adapter can use a native database transaction and rollback. Core makes at most three storage-only transaction attempts after reported conflicts and adds no retry delay. The adapter never reruns one callback because it can contain work outside Store.

### Thread Store

```ts
export interface ThreadStore<
  Definitions extends ThreadRecordDefinitions = CoreRecordDefinitions,
  Operators extends StoreOperatorTypes = BaseStoreOperatorTypes,
  CreateInputs extends StoreCreateInputMap<Definitions> = DefaultStoreCreateInputs<Definitions>,
> extends Store<Definitions, Operators, CreateInputs> {
  // Keep the current specialized operations and semantic result types.
  readonly submitRun: (
    input: SubmitRunStoreInput<Definitions>,
  ) => Promise<AcceptedRun | BranchConflict | RunConflict>;

  readonly acquireExecutionClaim: (input: AcquireExecutionClaimInput) => Promise<ClaimResult>;

  readonly commitModelInvocation: (
    input: CommitModelInvocationInput<Definitions>,
  ) => Promise<CommitModelInvocationStoreResult<Definitions>>;

  readonly finalizeRun: (
    input: FinalizeRunStoreInput<Definitions>,
  ) => Promise<FinalizeRunStoreResult<Definitions>>;

  // All other current ThreadStore operations remain.
}
```

A specialized Run Snapshot preserves the boundary between snapshot state and stored Records. Its `run` property contains the complete effective selected Run Record, including every host-added field and every compatible Core field narrowing. Its `toolCalls` property contains complete effective selected Stored Tool Call Records directly. Agent-aware specializations of Core Run and Stored Tool Call fields apply inside those Records. Other snapshot-owned values stay at the top level.

```ts
const snapshot = await client.readRunSnapshot(runId);

snapshot.head; // Snapshot head derived from the Branch.
snapshot.run.id; // Core Run ID.
snapshot.run.tenantId; // Host-added Run field.
snapshot.run.head; // A different host-added Run field named "head".

const call = snapshot.toolCalls[0];
call?.toolCallId; // Core Tool Call ID.
call?.traceId; // Host-added Stored Tool Call field.
```

Run Record properties are not duplicated at the snapshot top level. The two `head` properties can coexist because they belong to different objects. A Tool Call item needs no extra wrapper because the `toolCalls` array already supplies its namespace.

### Store capability composition

Most integrations state one required primitive Store contract in their input type. Core is the deliberate exception: it accepts a plain Store and preserves the stronger guarantee profile when the supplied value also implements `TransactionStore`. Store exposes no general capability registry.

```ts
interface AtomicIntegrationOptions<Definitions extends RecordDefinitions> {
  readonly store: TransactionStore<Definitions>;
}

interface CoreThreadStoreOptions<Definitions extends ThreadRecordDefinitions> {
  readonly backend: Store<Definitions>;
}
```

`SqlStore` is the separate primitive contract defined by the [SQL Store Tier Technical Specification](sql-store.md). Concrete SQL adapters must implement that contract rather than infer a shared interface from driver APIs.

### Core construction and inference

```ts
const threadStore = MemoryThreadStore.make({
  records: {
    scheduledJobs: {
      fields: {
        id: z.string().uuid(),
        status: z.enum(["pending", "running", "done"]),
      },
    },
  },

  overrides: {
    thread: {
      fields: {
        ownerId: z.string().uuid(),
      },
    },

    executionClaim: {
      fields: {
        traceId: z.string(),
      },
    },
  },

  hooks: {
    executionClaim: {
      beforeCreate: ({ draft }) => ({
        ...draft,
        traceId: getActiveTraceId(),
      }),
    },
  },
});

const app = commissary({ threadStore });

const thread = await app.createThread({
  fields: { ownerId: currentUserId },
});
thread.ownerId; // string

const claims = threadStore.collections.executionClaim;
const jobs = threadStore.collections.scheduledJobs;
const found = await jobs.find({
  select: { id: true, status: true },
  limit: 1,
});
const first = found[0];
```

`commissary` still accepts a ready Thread Store. The host keeps that value and can use every Core and Custom Collection directly.

## Seams, Adapters, and Implementations

### `@commissary/store`

Owns:

- Field Schema and Record inference;
- Record definition and catalog types;
- Store and Collection interfaces;
- query and update expression protocols;
- JavaScript reference evaluator;
- optional read and mutation fallback helpers;
- adapter capability checks;
- shared fallback tests and adapter contract test helpers.
- portable SQL Record, Statement, Store, error, adapter-helper, and conformance contracts defined by the SQL Store tier specification.

Must not know:

- Agent, Run, Thread, Branch, or Tool semantics;
- concrete SQL drivers, DynamoDB, or other provider protocols;
- core Runtime transitions.

### `@commissary/core`

Owns:

- every Core Record field map and contract;
- compatibility rules for every Core field override;
- `CoreCreateDrafts`, Core create-path unions, command custom-field types, conditional hook requirements, and hook execution;
- the internal `ThreadStoreBackend` type over the complete effective catalog;
- the implementation, inputs, results, queue, and errors for Runtime operations;
- plain-Store and Transaction Store Core Runtime conformance profiles;
- propagation of customized Core Record types through the Commissary Instance and Runtime.

Must not know:

- SQL indexes, foreign keys, native query objects, or backend clients.

### Memory Store adapter

Owns:

- process-local storage for the complete supplied Record catalog;
- JavaScript evaluation of Store expressions;
- one lock around each `TransactionStore.transaction` callback and its Collection operations;
- the memory Transaction Store and rollback mechanism;
- `MemoryStore.make`, which exposes that engine as a generic `TransactionStore`;
- `MemoryThreadStore.make`, which composes the same engine with the Core builder and exposes a `ThreadStore`.

Must not own:

- Runtime transition rules for claims, fencing, commits, suspension, or finalization.

## Call Stacks and Data Flow

### Current / Old Flow

```txt
commissary command
  -> core Runtime
  -> specialized ThreadStore method
  -> MemoryThreadStore maps and atomic JavaScript logic
  -> core Record/result
  -> Commissary caller
```

There is no Field Schema catalog or generic CRUD path.

### New Flow: Store construction

```txt
host Record contributions + typed overrides + beforeCreate hooks
  -> Thread Store factory
  -> core contributes every built-in Core Record
  -> compose new Records and explicit Core or integration overrides
  -> core checks contributor compatibility
  -> types require command fields for command creates and hooks for internal creates
  -> adapter constructs one Store over the complete effective catalog
  -> core wraps create operations with the effective hook catalog
  -> core selects its plain or transactional execution path
  -> return ThreadStore<EffectiveRecordDefinitions>
```

Every Collection in `EffectiveRecordDefinitions` is available through the returned Thread Store.

### New Flow: Thread Store operation

```txt
commissary command + typed custom fields
  -> core Runtime
  -> Core-owned specialized ThreadStore operation
  -> plain Store:
     -> enter the Thread Store instance queue
     -> reload actual state
     -> run once and persist sequentially
     -> partial writes can remain after failure
  -> Transaction Store:
     -> backend.transaction
     -> run against the transaction-bound Store
     -> adapter commits all changes or none
     -> core can retry a reported conflict
  -> core Record/result
  -> Commissary caller
```

Core owns transition rules and hook invocation in both paths. A plain-Store operation runs hooks once. A Transaction Store retry runs them again. No separate atomic storage API exists.

### New Flow: Find

```txt
FindOptions
  -> validate limit and offset
  -> invoke where/order callbacks once and validate expression ownership and scope
  -> adapter capability selection
     -> native implementation:
        -> preserve effective selected values for where/order
        -> reject unselected returned keys
        -> parse each returned projection field once
     -> JavaScript reference fallback:
        -> fetch selected fields plus fields referenced by where/order
        -> parse each referenced field once and cache its selected value
        -> where -> lexicographic orderBy -> offset -> limit
        -> parse each remaining selected field once, reuse cached values, and project
  -> omit every key whose parsed output is undefined
  -> check each defined parsed value is JSON-compatible
  -> readonly full or projected array
```

`limit: 1` still returns an array.
One raw field value runs through its Select Field Schema at most once during one fallback `find`; a selected field that is also used by `where` or `orderBy` reuses the cached parsed value.

### New Flow: Create

```txt
Core or host create draft
  -> effective beforeCreate hook, when configured
  -> reject every returned top-level key absent from the Record definition
  -> pass each supplied or missing field to its effective create Field Schema
  -> omit every key whose parsed output is undefined
  -> canonical create field outputs
  -> adapter fills only fields whose create output is omitted; defined hook or host values win
  -> parse every defined candidate value with its effective Select Field Schema
  -> adapter writes the selected outputs
  -> reject every returned top-level key absent from the Record definition
  -> parse database-returned fields with their effective Select Field Schemas
  -> selected Record
```

If database-generated output fails the final parse after the write, the Store reports a defect. Cleanup and rollback are not guaranteed.
Create-schema and adapter-generated values use effective Select outputs before storage. Parsing a database-returned value must be stable and returns the same selected value.

### New Flow: Update with literal values

```txt
UpdateOptions
  -> reject every literal set key absent from the Record definition
  -> parse only each supplied literal value with its effective update Field Schema
  -> invoke the optional where callback once and validate its expression scope
  -> adapter identifies matching candidates
  -> for each candidate before its write:
     -> parse fields referenced by where with their effective select Field Schemas
     -> merge parsed literal outputs into a storage candidate
     -> run every candidate field through its effective Select Field Schema
     -> write that candidate
  -> on failure, start no later writes and drain active writes
  -> exact affected count after complete success
```

A later invalid candidate or write failure can leave earlier candidate writes in place. The error reports `writesMayRemain`. A Transaction Store callback can add operation-wide rollback.

### New Flow: Update with expressions

```txt
UpdateOptions with set callback
  -> invoke the optional where callback once
  -> invoke the set callback once with fields + Update Expression operators
  -> validate each expression against its operator set and separate callback scope
  -> reject every set key absent from the Record definition
  -> parse each raw literal with its effective update Field Schema
  -> adapter identifies matching candidates
  -> for each candidate before its write:
     -> parse fields referenced by where or set with their effective select Field Schemas
     -> evaluate expressions against that pre-update selected Record
     -> merge literal outputs and expression outputs into a storage candidate; unset omits its key
     -> run every candidate field through its effective Select Field Schema
     -> write that candidate
  -> on failure, start no later writes and drain active writes
  -> exact affected count after complete success
```

Every expression reads the pre-update Record. Expression order cannot observe earlier assignments. A native update implementation must preserve the same selected-value boundary or report `UnsupportedStoreOperationError`.

### New Flow: Delete

```txt
DeleteOptions
  -> invoke the optional where callback once and validate its expression scope
  -> adapter identifies matching candidates
  -> delete each identified candidate
  -> on failure, start no later writes and drain active writes
  -> exact affected count after complete success
```

### New Flow: Runtime transition

```txt
Agent Client / Commissary Instance
  -> core Runtime Operation
  -> specialized ThreadStore method
  -> plain Store queue or Transaction Store callback
  -> core Collection reads and writes
  -> guarded semantic result
  -> core Runtime
  -> public result
```

Core implements this flow with generic Collection calls inside the transaction. The host still uses the specialized Thread Store method.

### Raw owner flow

```txt
host
  -> store.collections.executionClaim.update/delete/create
  -> raw Store operation
  -> Core Record changes
```

This can violate any Runtime invariant. The Store permits it because the host owns the data and accepts the footguns.

### Failure Flow

Confirmed classifications:

- caller query, create, or update validation rejects with `StoreValidationError`;
- an unknown caller Record key is a `StoreValidationError`;
- an invalid `beforeCreate` result is a `StoreValidationError` and reaches no adapter write;
- a value thrown by `beforeCreate` is wrapped in `StoreHookError.cause`;
- an operation that is unavailable for the supplied input or backend state rejects with `UnsupportedStoreOperationError`;
- an adapter I/O failure is wrapped in `StoreAdapterError.cause`;
- a transaction conflict rejects with `TransactionConflictError`, and the adapter does not rerun the callback;
- Core consumes `TransactionConflictError` while fewer than three attempts have run and reports it after the third attempt fails;
- non-finite fallback arithmetic rejects the complete update with `StoreValidationError`;
- an unknown adapter Record key, invalid selected Record, overwritten host create value, impossible expression result, or broken transaction guarantee is a `StoreAdapterContractError` defect;
- a closed Transaction View method rejects with `TransactionClosedError` and starts no Store work;
- a successful callback with active Store work drains that work and selects `TransactionUnsettledOperationError`;
- a failed View operation selects rollback even when callback code catches it;
- rollback removes all transaction writes after any selected callback boundary failure;
- after successful rollback, `transaction` reports the exact selected failure without wrapping it;
- failed rollback reports both failures in `TransactionRollbackError`, marks that writes can remain, and causes no Core retry.

Every expected Store failure rejects the Promise. CRUD result types contain only successful values; they do not include error unions.

### Retry / Cancellation / Idempotency Flow

- Existing Thread Store idempotency and fencing remain unchanged.
- The shared Store layer performs no automatic CRUD retry.
- An adapter can retry internal I/O only when it preserves one logical Store operation and cannot duplicate a write. This is part of that adapter's implementation and documentation.
- Hosts and integrations own any retry policy above base CRUD.
- Base CRUD performs no cancellation and accepts no `AbortSignal`.
- A future cancellation-capable Store must define whether an aborted write can still commit before adapters implement it.
- A Transaction Store never reruns a transaction callback. It reports a conflict.
- Core makes at most three immediate attempts for its own storage-only transaction. It adds no retry delay.

### Observability Flow

Base Store emits no logs, traces, query plans, full-scan warnings, or native-versus-fallback events. An unbounded `find` is an explicit request and produces no warning. A future observability primitive can define adapter-internal events before implementations adopt it. Higher-level wrappers can observe public Store calls without changing the base contract.

Default error logging and telemetry include only Safe Store Error Metadata. They exclude validation issue messages, `cause`, `callbackFailure`, `rollbackFailure`, complete inputs, and complete Records.

## Files to Add / Change / Delete

### Add

- `packages/store/package.json` — package manifest and exports.
- `packages/store/tsconfig.json` and `packages/store/tsconfig.build.json` — package typecheck and build.
- `packages/store/src/index.ts` — public exports.
- `packages/store/src/record.ts` — Field Schemas, Record definitions, catalogs, and inference.
- `packages/store/src/expression.ts` — query and update expression contracts and reference evaluator.
- `packages/store/src/store.ts` — Store, Collection, and Transaction Store interfaces.
- `packages/store/test/store.test.ts` — Field Schema, reference evaluator, and local contract-fixture tests that do not depend on a concrete adapter package.
- `packages/store/test/inference.test.ts` — public compile-time inference and rejected misuse.
- `packages/store/test/conformance.test.ts` or an exported conformance subpath — shared operator behavior.
- `docs/adr/0019-build-thread-store-on-generic-store-primitives.md` — record the generic Store seam, raw owner access, Field Schema catalog, Core specialization, and adapter capability model.

Exact source-file splitting can be reduced if these modules remain small. The ownership listed above must remain clear.

### Change

- `package.json`, `pnpm-lock.yaml`, and `turbo.json` — add the package and build/test relationships.
- `packages/core/package.json` — depend on `@commissary/store`.
- `packages/core/src/store.ts` — define every Core Record map and Core create draft; define conditional hook types and execution; make Thread Store extend Store; implement specialized Runtime transitions over its Collections; bind specialized types to effective Record definitions.
- `packages/core/src/schema.ts` — reuse or move generic Standard Schema helpers without creating a dependency cycle.
- `packages/core/src/commissary.ts` — infer customized Core Record outputs and the confirmed command custom-field inputs.
- `packages/core/src/index.ts` — export Core Record maps, Thread Store factory types, hooks, and Thread Store types.
- `packages/core/test/inference.test.ts` — prove every Core field merge, conditional hook requirement, hook output inference, and incompatible field rejection.
- `packages/core/test/runtime/*` — preserve every Runtime semantic outcome through the new Store seam and test both backend guarantee profiles.
- `packages/store-memory/package.json` — depend on the new package.
- `packages/store-memory/src/index.ts` — implement one Transaction Store over the complete effective catalog and compose the Memory Thread Store factory with the Core builder. Remove adapter-owned Runtime transition rules after the Core implementation passes the existing behavior tests.
- `packages/store-memory/test/store.test.ts` — run Store conformance and Runtime-specific cases.
- `CONTEXT.md` — maintain the confirmed Store vocabulary.
- `docs/adr/0004-pass-dependencies-through-factories-and-closures.md` — point its Thread Store section to ADR 0019 while preserving its remaining dependency and safe-facade decisions.

### Delete

No file deletion is confirmed. Keep every specialized Thread Store operation. Remove the current adapter-owned transition logic only after the Core-owned replacement passes the existing Runtime tests.

## RGR TDD Test Plan

The confirmed public test seams are:

1. `MemoryStore.make` and `Store.collections` for generic persistence behavior;
2. `MemoryThreadStore.make` for complete Core catalog inference and create hooks;
3. the exported Store expression conformance interface for adapter behavior;
4. `commissary({ threadStore })` for Runtime behavior;
5. `TransactionStore.transaction` for transaction behavior.

Each slice is one Red-Green cycle. Do not write all tests first.

### Slice 1: Custom Record create and find

- **Red**: Define `scheduledJobs` with shorthand and operation-specific Field Schemas. Prove create and find infer the Record from the effective field inputs and outputs.
- **Green**: Add the smallest Record definition, Collection, and Memory implementation.
- **Check**: Invalid field input and unknown top-level Record keys reject with `StoreValidationError` through the Collection interface.

### Slice 2: Core defaults and field inference

- **Red**: Omit Core Records and prove every Core Collection is still available. Add fields to Thread and Execution Claim and prove both selected Records include them.
- **Green**: Compose every built-in and Custom Record contribution with explicit compatible overrides.
- **Compile checks**: Reject an incompatible Core field override and a duplicate contribution. Prove a compatible Core field replacement narrows the matching public snapshot property. Require no explicit generic, cast, or `as const` for ordinary use.
- **Catalog checks**: Prove all five durable entity Collections and all fourteen Runtime state Collections are present. Prove Tool Call graph indexes are derived and process-local control waiters are absent.

### Slice 3: Before-create hooks

- **Red**: Add required `ownerId` to Thread and prove construction needs no Thread hook, while `createThread` fails to compile without `fields.ownerId`. Add required `traceId` to Execution Claim without a hook and prove construction fails to compile.
- **Green**: Add the complete `CoreCreateDrafts`, exact Core create-path unions, command custom-field inference, required custom create-key inference, the conditional hook map, and the smallest hook runner.
- **Output check**: Require the hook to return the complete create input. Reject unknown keys and invalid field values with `StoreValidationError` before the adapter writes. Wrap a thrown hook value in `StoreHookError.cause`.
- **Order check**: Prove command fields enter the draft before the hook, and prove the hook runs before create Field Schemas and can replace a built-in or command value.
- **Scope check**: Prove the hook runs for both Core and host creates.
- **Attempt check**: Prove a plain-Store Core operation runs the hook once. Force two Core transaction conflicts and prove the hook runs once in each of the three Transaction Store attempts.
- **Path check**: Prove a command-only create path requires no hook, an internal create path requires one, and a Collection with both paths has both compile-time requirements.
- **Optional check**: Prove optional and defaulted custom create fields require neither a command value nor a hook.

### Slice 4: Find expressions

- **Red**: Query with `eq`, `and`, and `isNull`; prove missing and null fields match the agreed semantics.
- **Green**: Add expression values and the JavaScript evaluator.
- **Schema boundary**: Prove operators read effective select outputs, a select default replaces missing before evaluation, and parsed-missing still normalizes to `null`.
- **Property checks**: Structural JSON equality ignores object key order and preserves array order.

### Slice 5: Ordering and pagination

- **Red**: Prove same-type string and numeric ordering, multi-field precedence, `offset` before `limit`, and projection after paging.
- **Green**: Add the minimum evaluator behavior.
- **Negative checks**: Reject cross-type ordering and non-finite numbers. Prove order is not portable when `orderBy` is omitted.
- **Adapter documentation**: Prove each adapter conformance profile and README state string collation, equal-value tie behavior, and any `find` or `inArray` maximum without adding runtime capability fields to Store.

### Slice 6: Projection

- **Red**: Select two fields and prove the output type and runtime value omit all others.
- **Green**: Add projection and selected-field validation.
- **Regression**: Validate selected result fields and any fields that a fallback references for filtering or ordering, but no unrelated fields.

### Slice 7: Create, update, delete, and count results

- **Red**: Create returns one Record; update and delete return affected counts; count accepts `where`.
- **Green**: Add only the required operations.
- **Risk check**: Omitted update/delete `where` changes all matching Records.
- **No cancellation**: Prove the base Collection methods accept no `AbortSignal` or other cancellation option.
- **Storage normalization**: Prove create, literal update, and expression update store effective Select outputs. Use an idempotent normalization that changes the operation-schema output and remains stable when a read applies Select again.
- **Round-trip contract**: Apply Select twice to representative fixture outputs and prove equality. A prefixing Select transform is a negative contract example, not accepted Store behavior.

### Slice 8: Candidate mutation validation

- **Red**: Make an early candidate valid and a later candidate invalid. Prove the later `StoreValidationError` reports whether the earlier write can remain.
- **Green**: Validate each candidate before its write, stop starting writes after the first failure, drain active writes, and return an exact count only after complete success.
- **Adapter contract**: An adapter without a safe candidate implementation for one input reports `UnsupportedStoreOperationError`.

### Slice 9: Update expressions

- **Red**: Add one accepted numeric expression and prove its candidate is validated before its write.
- **Green**: Add the smallest expression node and evaluator.
- Repeat one expression at a time through the confirmed operator set.
- Add fallback behavior cases for every expression and edge condition.
- Add scope tests that reject escaped, reused, and cross-operator-set expressions before adapter execution.
- Add type tests for readonly-array `concat` inference and optional-key-only `unset`.
- Add behavior tests for lazy `coalesce` and `ifElse`, JavaScript remainder and division-by-zero failure, mixed raw literals and expressions, and update-schema parsing of each raw callback literal.

### Slice 10: Adapter contracts

- Test the JavaScript fallback against its defined behavior.
- Test every adapter against the behavior that adapter documents.
- Do not compare a native implementation with the fallback unless the adapter states that it uses fallback behavior.
- Prove that expressions from different Store Operator Sets cannot be mixed.
- Prove an adapter can satisfy the Collection contract with native methods, safe fallback helpers, or a mix of both, without implementing a universal low-level driver.
- Prove an integration that requires `TransactionStore` rejects a base Store at compile time.
- Prove a permanently absent operator is absent from the adapter type, while input-dependent support reports `UnsupportedStoreOperationError`.
- Prove every asynchronous Store-family method returns `Promise` before validation or host callback execution, exposes standard `catch` and `finally`, converts a synchronous builder throw into rejection with the exact value, and accepts no Effect value or custom thenable as its declared result.
- Prove Store exposes no runtime capability registry.
- Prove expected failures extend `StoreError`, adapter contract defects do not, and CRUD result types contain no error union.
- Prove every Store error and adapter contract defect reports `writesMayRemain`, including a later candidate failure after an earlier write.
- Prove Store-generated messages and safe metadata contain no complete input or Record. Prove default telemetry excludes Field Schema issue messages, `cause`, `callbackFailure`, and `rollbackFailure`.
- Prove base Store performs no shared retries, emits no observability side effects, and produces no full-scan warning.

### Slice 11: Thread Store integration

- **Red**: Run the existing create/execute/finalize scenario through the Core-owned Thread Store implementation over both a plain Store and the Memory Transaction Store with a required Execution Claim `traceId`.
- **Green**: Implement the specialized operations in core with Collection calls over the complete effective catalog. Queue plain-Store operations per Thread Store instance and use `transaction` when available.
- **Plain profile**: Prove one attempt, same-instance serialization, actual-state reload after failure, no cross-instance guarantee, and partial-write reporting.
- **Boundary check**: Prove every Core Collection is host-accessible, while the Memory adapter contains no claim, fencing, commit, suspension, or finalization rules.
- **Snapshot check**: Add `tenantId` and `head` to Run and `traceId` to Stored Tool Call. Prove the public Run Snapshot returns Run fields under `snapshot.run`, keeps the derived `snapshot.head`, and returns complete inferred Tool Call Records directly in `snapshot.toolCalls`. Prove compatible Core field narrowings propagate inside both Record types.
- Keep every current claim, abort, redirect, steering, Tool suspension, and finalization test passing in both guarantee profiles.
- Run the matching Core Runtime conformance profile against every concrete Thread Store backend. An adapter-defined operator difference cannot change a Core semantic result.

### Slice 12: Transactions

- **Red**: Start concurrent lost-update and write-skew transactions. Prove that the visible result matches a serial order and never requires both callbacks to enter before the first can finish.
- **Green**: Make the Memory adapter hold one lock around each complete transaction callback.
- **Adapter contract**: Run the same concurrent cases against every Transaction Store adapter. Accept admission serialization or a reported conflict, but never a nonserial result.
- **Backend overlap**: Use adapter-specific test controls to force internal overlap and conflict when that backend admits concurrent callbacks. Do not add these controls to the runtime Store interface.
- **Callback count**: Use a conflict-capable test adapter or backend control to prove one `transaction` call invokes its callback at most once.
- **Core retry**: Inject conflicts through a test Transaction Store and prove the specialized Thread Store operation makes no more than three immediate transaction attempts without a timer.
- **Rollback**: Change multiple Collections, fail the callback, and prove that none of its writes remain.
- **Closed View**: Capture the View, settle the callback, and prove each later method rejects with `TransactionClosedError` without Store work.
- **Active work**: Hold one View operation, let the callback succeed, prove rollback waits for settlement, and then rejects with `TransactionUnsettledOperationError`.
- **Caught failure**: Catch one failed View operation, return success, and prove the transaction still rolls back with that exact operation failure.
- **Failure order**: Prove callback rejection wins over unsettled work and operation failures, unsettled work wins over operation failures, and several operation failures use call order.
- **Failure identity**: Fail with a unique value, complete rollback, and prove `transaction` rejects with that same value.
- **Rollback failure**: Force rollback to fail and prove the error contains both failures, sets `writesMayRemain` to `true`, and causes no retry.
- **No nesting**: Prove the callback Store has no `transaction` method in its public type or runtime value.
- **No fallback**: An adapter without a safe storage-level implementation does not implement `TransactionStore`.
- **No cancellation**: Prove `transaction` accepts no `AbortSignal` or other cancellation option.
- **Wider view**: Prove a test-only wider adapter keeps one transaction-bound extra capability while omitting `transaction`.

## Residual Risks

- Raw host CRUD can break every Runtime invariant because the host owns all Core state.
- A statically compatible Core field refinement can still reject a Core value at runtime.
- Adapter-defined operator semantics can change query or update results when a host changes adapters.
- A failed Select parse of a database-generated value after create can leave the backend write in place.
- `beforeCreate` side effects can repeat across Core transaction attempts; the host owns repeat safety.
- Concrete adapters must migrate and store all five durable entity Collections and fourteen Runtime state Collections.
- Base Store has no cancellation, shared retry, or observability behavior; integrations that need these capabilities require separately designed primitives or higher-level wrappers.
- The conditional schema and command inference is type-heavy. Compile-time tests must protect ordinary inference and readable errors.

## References

- [SQL Store Tier Technical Specification](sql-store.md)
- [Drizzle Store Technical Specification](drizzle-store.md)
- [Better Auth database schema extensions](https://www.better-auth.com/docs/concepts/database#extending-core-schema)
- [Drizzle query interface](https://orm.drizzle.team/docs/rqb)
- [Drizzle Zod Select, Insert, and Update schemas](https://orm.drizzle.team/docs/zod)
- [Drizzle MySQL update capabilities](https://orm.drizzle.team/docs/mysql/update)
- [DynamoDB update expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.UpdateExpressions.html)
- [PostgreSQL JSON functions and operators](https://www.postgresql.org/docs/current/functions-json.html)
- [Effect Schema to Standard Schema](https://www.effect.website/docs/v3/schema/standard-schema)
