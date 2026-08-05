# Store

Store defines provider-independent typed persistence contracts for Records, Collections, expressions, and transactions.

## Language

### Records, collections, and expressions

**Store**:
The base persistence interface for typed Collections and query operators. Its readonly `collections` map lets its owner read and change every Record in its Collection Catalog directly.
_Avoid_: Thread Store, Commissary Instance, application database, hidden Core Collection, `collection(name)` method

**Record**:
A JSON-compatible object assembled from independently validated Record Fields.
_Avoid_: Domain object, raw database row, arbitrary JavaScript value

**Record Definition**:
The storage-tier-neutral `fields` map that defines one Collection. Each value is one Field Definition; wider Store tiers can accept definitions with additional intent without changing this base contract.
_Avoid_: Whole-Record Schema, Record Extension, generic metadata object, adapter configuration standard

**Record Contribution**:
A complete named Record Definition that Core, an integration, or a host offers for a new Collection Catalog key.
_Avoid_: Record Override, silent merge, Collection

**Record Override**:
A host-owned patch that refines or augments an existing Record Definition while preserving every Record, field, selected-output, create-input, and update-input guarantee required by its contributor.
_Avoid_: Record Contribution, unchecked replacement, integration-owned patch, silent merge

**Effective Record Definition**:
The immutable Record Definition after Record Contributions and host Record Overrides compose. Every Store adapter uses this one contract for the related Collection.
_Avoid_: Original contributed definition, mutable merge result, adapter-specific schema copy

**SQL Record Definition**:
A Record Definition that also states portable and optional database-specific table and column storage intent. It remains a valid base Record Definition, and a Store without SQL capability ignores the wider intent.
_Avoid_: SQL companion schema, ORM table, database row, separate migration model

**Collection Catalog**:
The complete effective Core and Custom Record definitions available through the host Store's `collections` map.
_Avoid_: Collection Map, adapter-private table, subset of Core state, all physical storage

**Collection Map**:
The readonly `Store.collections` object keyed by every Record name in the Collection Catalog. Known names use dot access, and typed dynamic names use bracket access.
_Avoid_: Collection Catalog, `collection(name)` method, Collections placed directly on Store

**Runtime State Collection**:
A Core Collection for claims, pending commands, idempotency, finalization, or similar Runtime state. It is host-accessible and customizable. Direct host changes can break Runtime behavior.
_Avoid_: Hidden Collection, security boundary, safe host mutation, adapter-private table

**Runtime State Catalog**:
The fourteen Core Collections for `executionClaim`, `executionFence`, `pendingSteering`, `pendingRedirect`, `runCommandSequence`, `toolCallSequence`, `runSubmission`, `toolResumeRequest`, `steeringRequest`, `redirectRequest`, `commit`, `finalizationOutcome`, `modelCommitOutcome`, and `settlementOutcome`.
_Avoid_: Process-local control waiters, Tool Call graph indexes, hidden adapter state, optional Core subset

**Thread Store Backend**:
The Transaction Store over the same complete effective Collection Catalog exposed by the host-facing Thread Store. Core uses its `transaction` operation to implement Runtime transition rules. It can back a Thread Store only when the Core Runtime conformance suite passes with its actual operator semantics.
_Avoid_: Different private catalog, waived Core outcome, Thread Store, separate atomic capability, security boundary

**Record Field**:
One named top-level value in a Record.
_Avoid_: Complete Record, query expression, nested object path

**Field Schema**:
A deterministic, side-effect-free Standard Schema that validates and infers one Record Field for one or more Store operations. Store does not use it to enforce a rule between fields. Hooks and adapter generation own effectful value production.
_Avoid_: Effectful default, invocation-count dependency, Whole-Record Schema, cross-field validator, Zod-only contract

**Field Definition**:
Either one Field Schema used for select, create, and update, or an object with `select`, optional `create`, and optional `update` schemas. Missing `create` uses `select`. Missing `update` uses `create`.
_Avoid_: Whole-Record Schema, separate field extension helper

**Select Field Schema**:
The Field Schema used for full and projected reads, Store Operator field values, and final Record validation.
_Avoid_: Raw stored operator value, Create Field Schema, Update Field Schema, whole-Record validator

**Selected Field Value**:
The stable output of one Select Field Schema parse. It is the canonical field value that Store operations expose and adapters persist after create, update, or generated values pass through the Select Field Schema.
_Avoid_: Raw stored field, non-stable Select transform, repeated parse of one fallback field value

**Create Field Schema**:
The Field Schema used for one field in `create`. It falls back to the Select Field Schema.
_Avoid_: Complete create validator, Select Field Schema, adapter default

**Update Field Schema**:
The Field Schema used for a supplied literal field in `update`. It falls back to the Create Field Schema.
_Avoid_: Complete update validator, Select Field Schema, update expression

**Field Round-Trip Compatibility**:
The rule that every defined effective select, create, and update output must be accepted by the effective Select Field Schema, and that parsing a Select output must return the same value. `undefined` means omission and is excluded.
_Avoid_: Type compatibility alone, non-stable Select transform, raw operation output storage

**Missing Field**:
A Record Field whose key is absent. Read and create pass `undefined` to the effective Field Schema. A defined output supplies the value or default; an `undefined` output keeps the key absent. An omitted update field remains unchanged.
_Avoid_: `null`, own property with `undefined`, Unset Expression

**Adapter-Generated Field Value**:
An adapter-specific default that fills a field only after its Create Field Schema returns `undefined`. A defined host value always wins, and a generated value becomes a Selected Field Value before storage.
_Avoid_: Adapter-owned field, write protection, `create: false`, overwritten host value

**Strict Record Parsing**:
The top-level rule that rejects each key absent from the Record definition or requested projection. Store does not pass through or silently strip unknown Record keys. Each Field Schema still owns parsing inside its field value.
_Avoid_: Passthrough Record, stripped unknown Record key, nested Field Schema policy

**Core Record**:
A Record with fields and a contract required by core. Every Core Record type merges host fields and remains directly accessible through its Collection. A host field with the same name as a built-in Core field is one compatible validation narrowing, not a second field.
_Avoid_: Custom Record, adapter-private row, duplicate shadow field, safe host mutation

**Core Create Draft**:
The built-in create values that core supplies for one Core-created Record. Every Core Record has one draft entry. Command Create Fields are merged into this unvalidated draft before its Before Create Hook runs.
_Avoid_: Validated create input, selected Record, adapter-generated value

**Command Create Fields**:
The typed `fields` bag on a Commissary command that directly creates a Core Record. It contains only host-added fields for that Record. Required custom create fields are required in this bag.
_Avoid_: Built-in command argument, complete Record input, internal create fallback

**Command Create Path**:
A public Commissary command whose input exposes a custom `fields` bag for the primary Record that it creates. Version 1 has command create paths for Thread, Branch, and Run. Records created only as command side effects use Internal Create Paths.
_Avoid_: Raw Collection create, command side effect, internal Runtime create

**Internal Create Path**:
A path where core creates a Record without a host-provided command input for that Record. Version 1 uses it for every Core Record except Thread, Branch, and Run. A required custom create field on this path requires a Before Create Hook.
_Avoid_: Command Create Path, raw Collection create, private Collection

**Before Create Hook**:
A host callback for one Collection. It receives an unvalidated Core or host create draft and returns the complete create input before strict Field Schema validation. It can replace built-in fields and runs once per create attempt. A command-only create path does not make the hook required.
_Avoid_: After-create event, adapter default, validation bypass, once-per-logical-operation promise

**Required Custom Create Field**:
A host-added field on a Core-created Record whose effective Create Field Schema input excludes `undefined`. A command create requires it in Command Create Fields. An Internal Create Path requires a Before Create Hook. If both paths exist, both requirements apply.
_Avoid_: Optional field, defaulted create field, adapter-generated value, runtime-only hook check

**Collection**:
A typed set of Records with required find, create, update, delete, and count operations. An adapter that can never perform one safely does not implement Store.
_Avoid_: Optional base CRUD method, always-unsupported CRUD method, Thread Store operation, database table, repository

**Collection Adapter Boundary**:
The public Collection API that each adapter implements directly. An adapter can use native storage operations, optional shared Fallback Helpers, or both. There is no required low-level driver below this boundary.
_Avoid_: Universal `scan` driver, mandatory Record replacement API, adapter-specific public CRUD shape

**Fallback Helper**:
An optional reusable implementation of Store behavior. An adapter calls it only when the adapter can supply the storage operations and atomicity that make the behavior safe.
_Avoid_: Required adapter primitive, automatic unsafe fallback, universal storage driver

**Store Async Boundary**:
The public boundary where every asynchronous Store-family method creates and returns a native Promise before validation or host callback execution. It never throws synchronously. Effect values and custom thenables stay behind adapters. A Store builder callback throw rejects the Promise with the same value.
_Avoid_: Synchronous method throw, `PromiseLike`, public Effect value, adapter-specific async result

**Base Store Cancellation**:
Version 1 Base Store CRUD and Transaction Store operations accept no `AbortSignal`. A future cancellation-capable Store must first define whether an aborted write can still commit, and an integration that needs it must require that Store type.
_Avoid_: Best-effort base cancellation, silent background write, cancellation without write outcome semantics

**Base Store Retry**:
The rule that the shared Store layer never retries CRUD. An adapter can retry internal I/O only when it preserves one logical operation and cannot duplicate a write. Hosts own higher-level retry policy.
_Avoid_: Hidden write retry, shared retry loop, duplicated create, Core Transaction Retry

**Store Observability**:
Logging, tracing, query plans, full-scan warnings, or native-versus-fallback events around Store work. Base Store emits none. A later primitive or higher-level wrapper can add them.
_Avoid_: Base side effect, automatic console warning, runtime capability registry

**Unbounded Find**:
A `find` call without `limit` that requests every matching Record. An adapter can reject it but cannot silently truncate it.
_Avoid_: Automatic page, silent maximum, partial result

**Store Operator**:
A typed query or update operation supplied by a Store Operator Set. The shared fallback and an adapter can use the same name with different behavior.
_Avoid_: Arbitrary JavaScript function, raw SQL function, untyped adapter hook

**Store Operator Set**:
All query and update operators supplied by one Store adapter. The Store passes them as one `op` object to every Collection callback. Fixed support is part of the type.
_Avoid_: Separate query and update operator objects, global operator registry, hidden adapter override

**Adapter Conformance Profile**:
Test-only input that states one adapter's operator semantics, string order, equal-value tie behavior, and query limits for shared conformance helpers. It is not available on Store values.
_Avoid_: Runtime capability registry, production Store metadata, undocumented adapter behavior

**Store Expression**:
A typed value returned by a Store Operator. It carries the Store Operator Set identity and one opaque callback-scope token. Store rejects an expression that escapes or is reused in another callback.
_Avoid_: Raw native expression, expression from another Store Operator Set, escaped expression, reused expression

**Store Capability Requirement**:
The primitive Store interface that an integration requires in its input type. A required wider feature uses a wider Store type, such as Transaction Store, instead of a runtime capability check.
_Avoid_: `supports` registry, capability matrix, accept-base-Store-then-probe

**Primitive Store Contract**:
A storage capability interface designed before its concrete adapters. Adapters implement it, and higher-level abstractions compose it.
_Avoid_: Common interface extracted from adapters, adapter API treated as the primitive, bottom-up contract discovery

**Store Specialization Tier**:
A public Store-family interface that extends a more general Store capability contract without depending on one concrete adapter implementation. Use `Layer` only for an Effect dependency layer.
_Avoid_: Effect Layer, concrete adapter, runtime capability registry

**SQL Store**:
A Store specialization that lets an integration execute ORM-independent, parameter-safe SQL Statements. It retains Collections and promises only one unchecked Row set; transactions, preparation, streaming, cancellation, session scope, batches, and multiple results require separate Store interfaces.
_Avoid_: Standalone SQL client, concrete Adapter, ORM Store, runtime capability probe

**SQL Column Type**:
An opaque storage-family and value-conversion contract for one Selected Field Value. A portable type has stable meaning across SQL adapters, while a database-specific type narrows that intent for one database.
_Avoid_: Driver type, raw DDL, Field Schema, TypeScript primitive

**SQL Record Reference**:
An immutable resolved table or column identifier that an SQL definition returns for safe SQL Statement composition. It is independent of one database connection and is neither a Record Definition nor a raw identifier string.
_Avoid_: Store-scoped token, raw name, database row, unbound definition

**SQL Statement**:
An inert, composable value that keeps SQL structure separate from bound values until a SQL Store Adapter executes it. Its SQL text can use one database dialect.
_Avoid_: Portable SQL language, driver query object, executed query, mutable text-and-values bag

**SQL Execution Result**:
The generic result of one SQL Statement, containing exactly one readonly `rows` array of unchecked driver values. A Store specialization adds only result facts that it guarantees.
_Avoid_: Selected Records, normalized row values, guessed mutation facts, multiple result sets

**Raw SQL Text**:
SQL structure inserted by `sql.raw()` without parameter handling. It can be a fragment or a complete statement, and its caller owns its safety.
_Avoid_: Unchecked SQL Row, bound parameter, driver result

**Store Error**:
The base Error class for expected Store operational failures. Specific subclasses identify validation, Hook, unsupported-operation, adapter I/O, transaction-conflict, and rollback failures. Successful result types do not include these errors.
_Avoid_: Adapter Contract Error, result union, one generic wrapper, Transaction Callback Failure

**Store Validation Error**:
An expected Store Error for invalid query, create, or update input or result. Its safe fields identify the Collection, operation, phase, optional field, and normalized issue paths. Field Schema issue messages are diagnostic data, not safe default telemetry.
_Avoid_: Rejected Record value, safe-to-log issue message, Adapter Contract Error, schema-library error object

**Store Hook Error**:
An expected Store Error that identifies a failed `beforeCreate` Hook and preserves the thrown value as its cause.
_Avoid_: Invalid Hook output, swallowed Hook failure, safe-to-log cause

**Store Adapter Error**:
An expected Store Error that identifies an adapter I/O failure and preserves the adapter failure as its cause.
_Avoid_: Adapter Contract Error, raw adapter error contract, safe-to-log cause

**Store Adapter Contract Error**:
A defect Error outside the Store Error hierarchy. It reports that an adapter returned invalid data, overwrote a host value, produced an impossible expression result, or broke its transaction contract.
_Avoid_: Expected Store Error, caller validation failure, unsupported operation, recoverable result

**Safe Store Error Metadata**:
Store-generated names, operations, phases, paths, features, violations, and write-state flags that can be logged without copying a complete input or Record. Field Schema issue messages, causes, callback failures, and rollback failures are excluded from default logging and telemetry.
_Avoid_: Complete Record, operation input, validation issue message, automatic cause logging, rejected field value

**Unsupported Store Operation**:
An expected `UnsupportedStoreOperationError` reported when an adapter cannot execute an operation safely for the supplied input or current backend state. Its fields identify the Collection, operation, and feature. An operator that is never supported is absent from the adapter type.
_Avoid_: Always-throwing typed operator, unsafe fallback, silent no-op, Defect, capability registry

**Store Query**:
A typed expression over effective selected Collection field values that uses Store Operators. Each referenced field first passes through its Select Field Schema. A parsed-missing value then normalizes to `null`. Nested object access uses Field Paths. Arrays expose no index paths.
_Avoid_: Raw stored value, arbitrary JavaScript predicate, SQL string, raw adapter query object, array-index path

**Field Path**:
An immutable nonempty tuple of object-key strings stored inside a field reference. It does not use dot-separated encoding and never contains an array index.
_Avoid_: Dotted string, escaped key syntax, array-index path, exported database column path

**Find Evaluation Order**:
The logical order `where`, lexicographic `orderBy`, `offset`, `limit`, and projection. The first order expression is primary. Without `orderBy`, result order is not portable.
_Avoid_: Projection before filtering, limit before offset, implicit identifier tie-breaker, stable unordered paging

**Fallback String Order**:
The case-sensitive, non-locale JavaScript string order used by fallback comparisons and sorting.
_Avoid_: Database collation promise, locale-aware order, case folding

**Update Expression**:
A typed Store Expression that calculates a field's new selected value during `update`. It reads effective selected field values. A raw literal beside expressions passes through the Update Field Schema, while an expression result passes through final Select Field Schema validation.
_Avoid_: Arbitrary JavaScript updater, raw stored field, Store Query, raw adapter expression object, update-schema bypass for a raw literal

**Update Evaluation Snapshot**:
The Record state before an update. Every fallback expression in one `set` callback reads this same state.
_Avoid_: Left-to-right assignment state, partially updated Record, callback property order

**Fallback Arithmetic**:
Update Expression arithmetic that uses JavaScript number behavior. A non-finite operand or result rejects the complete update with a Store Validation Error.
_Avoid_: Decimal arithmetic, database-native arithmetic promise, partial update

**Array Concat Expression**:
An Update Expression that concatenates two arrays and returns a readonly array of the union of both element types. It preserves runtime order and duplicates but does not preserve tuple positions.
_Avoid_: Tuple-shape promise, element coercion, set union

**Coalesce Expression**:
An Update Expression that returns its left value unless that value is `null` or missing. It evaluates its fallback only when needed. False, zero, and the empty string are defined values.
_Avoid_: Truthiness fallback, eager fallback evaluation, null-only fallback

**Conditional Update Expression**:
An Update Expression that evaluates one predicate and only the selected result branch.
_Avoid_: Eager branch evaluation, statement-level conditional, JavaScript callback

**Array Filter Expression**:
An Update Expression that keeps array elements selected by a predicate. The fallback preserves order and duplicates, uses Field Paths below the element root, exposes no array index, and uses the fallback Store Query rules for null and missing values.
_Avoid_: JavaScript callback, element index, parent Record access, array-index path

**Unset Expression**:
An Update Expression that removes an optional top-level Record field or optional object key inside `merge`. A key is optional when `{} extends Pick<Value, Key>` is true for its selected output type.
_Avoid_: Required field removal, schema-library metadata, `null`, path-based delete, complete Record deletion

### Transactions

**Transaction Store**:
A Store specialization with one `transaction` operation. Its callback receives a Transaction View without `transaction`, so nesting is not supported. A wider adapter adds each capability that is safe inside the active transaction. Version 1 accepts no cancellation option. Overlapping transactions must act as if they ran one at a time, and two conflicting transactions cannot both commit. Each adapter enforces this rule in its storage system. One transaction call invokes its callback at most once. If the callback fails, the adapter discards all of its writes and then reports the same failure value. A failed rollback reports a Transaction Rollback Error.
_Avoid_: Sequential fallback, shared in-process lock, weaker overlap guarantee, hidden callback retry, `AbortSignal`

**Transaction View**:
The Store passed to a transaction callback. It uses the transaction's Records and operators, includes adapter capabilities that are safe inside the active transaction, and has no `transaction` method.
_Avoid_: Transaction Store, nested transaction, savepoint, independent Store

**Transaction Capability**:
An adapter feature that remains safe and bound to the active transaction. The adapter defines which wider capabilities its Transaction View includes.
_Avoid_: Nested `transaction`, capability used outside the active transaction, mandatory base Store feature

**Transaction Conflict**:
An expected `TransactionConflictError` reported when a transaction cannot commit without breaking the overlap guarantee. The Transaction Store does not rerun the callback. Core starts a new transaction for its storage-only work while fewer than three attempts have run.
_Avoid_: Adapter I/O failure, partial commit, hidden callback retry, Defect

**Transaction Rollback**:
The adapter-owned action that discards every write from a failed transaction callback. Each adapter uses its own storage mechanism. Core provides no shared rollback fallback. After rollback succeeds, Store preserves the callback failure. After rollback fails, stored state is unknown.
_Avoid_: Failed create cleanup, partial commit, Core rollback, shared rollback implementation

**Transaction Rollback Error**:
An expected Store Error for a failed Transaction Rollback. It contains the callback failure and rollback failure, sets `writesMayRemain` to `true`, and prevents a Core retry. Its failure values are not safe default telemetry.
_Avoid_: Transaction Callback Failure, Transaction Conflict, known clean state, automatic retry, safe metadata

**Transaction Callback Failure**:
The exact value that causes a transaction callback to fail. After rollback succeeds, `transaction` rejects with this value unchanged.
_Avoid_: Transaction Conflict, Store wrapper, rollback failure, Adapter I/O failure

**Core Transaction Retry**:
A new transaction started immediately by a specialized Thread Store operation after a Transaction Conflict. The Core callback only reads and writes Store data. One operation makes at most three transaction attempts: the first attempt and two retries.
_Avoid_: Adapter callback retry, unbounded retry, retry of external work
