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
A Record Definition that also states portable and optional database-specific table and column storage intent. It remains a valid base Record Definition, and a Store without SQL capability ignores the wider intent. Database-specific Record refinements remain definition seams even though database identity does not create a runtime Store tier.
_Avoid_: SQL companion schema, ORM table, database row, separate migration model

**SQL Metadata Helper**:
An optional immutable constructor, such as `sql.table()` or `sql.column()`, that gives integration authors typed portable database metadata without a second Record Definition.
_Avoid_: Required wrapper, second definition factory, ORM table builder

**PostgreSQL Record Refinement**:
The `pg.table()` and `pg.column()` metadata inside one SQL Record Definition. An integration owns this metadata, and the host gives the Record to its concrete PostgreSQL adapter.
_Avoid_: `PostgresRecord`, `PostgresSql` definition factory, Drizzle type, host-authored schema copy

**PostgreSQL Column Type**:
A direct, enum, array, or custom PostgreSQL storage type with a JSON-safe selected value contract and synchronous scalar conversion rules.
_Avoid_: Driver value leak, ORM column type, implicit lossy number conversion

**PostgreSQL Record Resolution**:
The synchronous adapter-facing step that applies effective definitions, validates PostgreSQL metadata, and produces table, column, reference, and enum assets without database I/O or DDL.
_Avoid_: Migration execution, database introspection, host-facing Store tier, ORM schema

**MySQL Record Refinement**:
The `mysql.table()` and `mysql.column()` metadata inside one SQL Record Definition. An integration owns this metadata, and the host gives the Record to its concrete MySQL adapter.
_Avoid_: `MySqlRecord`, MySQL definition factory, Drizzle type, host-authored schema copy

**MySQL Column Type**:
A direct, inline-enum, or custom MySQL storage type with a driver-independent selected value contract and synchronous conversion rules.
_Avoid_: Driver output mode, ORM column type, implicit lossy number conversion, reusable enum asset

**MySQL Record Resolution**:
The synchronous adapter-facing step that applies effective definitions, validates MySQL metadata, and produces table, column, and reference assets without database I/O or DDL.
_Avoid_: Migration execution, database introspection, host-facing Store tier, ORM schema

**SQLite Record Refinement**:
The `sqlite.table()` and `sqlite.column()` metadata inside one SQL Record Definition. An integration owns this metadata, and the host gives the Record to its concrete SQLite adapter.
_Avoid_: `SqliteRecord`, SQLite definition factory, Drizzle type, host-authored schema copy

**SQLite Column Type**:
A named direct or custom SQLite storage contract with one driver-independent JSON-safe selected value and synchronous conversion rules.
_Avoid_: Drizzle mode option, driver value leak, inferred affinity, implicit lossy number conversion

**SQLite Record Resolution**:
The synchronous adapter-facing step that applies effective definitions, validates SQLite metadata, and produces table, column, and reference assets without database I/O or DDL.
_Avoid_: Migration execution, database introspection, host-facing Store tier, ORM schema

**SQLite ROWID Contract**:
The resolved `INTEGER PRIMARY KEY` identity and generation policy for one SQLite column. It states whether committed ROWID reuse is allowed or prevented with `AUTOINCREMENT`; it is not a general primary-key or index definition.
_Avoid_: Gap-free sequence, Store-owned constraint model, automatic host index, generic identifier abstraction

**Automatic-Increment Key Requirement**:
The resolved MySQL fact that a non-serial `AUTO_INCREMENT` column needs a host-owned index that starts with the column. A concrete adapter proves the index; MySQL `SERIAL` satisfies the requirement with its intrinsic unique index.
_Avoid_: Store-owned index definition, required unique host index, generated migration, runtime capability

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

**SQL Store Conformance Profile**:
Test-only input that gives the expected SQL text and ordered driver parameters for one fixed shared SQL Statement. It lets the shared suite check database-specific identifier quoting, placeholder syntax, and portable parameter conversion without guessing a dialect. It is not available on Store values.
_Avoid_: Runtime dialect registry, production Store metadata, normalized test parameters, shared dialect guess

**SQL Store Conformance Controls**:
Test-only adapter controls that record driver call count, SQL text, and ordered driver parameters, and script the next driver outcome as rows, failure, multiple results, or an invalid result. A scripted failure states whether it occurs before the statement call starts or during that call so conformance can check `executionMayHaveOccurred`. Each adapter fixture maps the shared outcome to its real driver result shape. The controls are not available on production Store values.
_Avoid_: Runtime capability, production driver access, hidden call log, optional SQL check

**SQL Store Conformance Fixture**:
A new empty SQL Store and new SQL Store Conformance Controls created for one independently executable conformance scenario. Shared state and a reset operation are unnecessary.
_Avoid_: Shared Store, shared call history, reset method, scenario-order dependency

**SQL Transaction Conformance Statements**:
Adapter-specific SQL Statement factories that insert and delete the fixed conformance Record. The combined SQL Transaction Store suite uses them with Collection operations to prove that both paths share committed and rolled-back data without exposing a physical transaction identifier.
_Avoid_: Production migration API, raw transaction identifier, driver session handle, mocked shared state

**Transaction Conformance Controls**:
Test-only adapter controls that hold and release one operation, force rollback failure, and count physical transaction starts, commits, and rollbacks so shared Transaction Store checks are deterministic and can prove that one public transaction uses one physical transaction. They are not available on production Store values.
_Avoid_: runtime capability, timing sleep, production failure injection, optional transaction check

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
A public Store-family interface that extends a more general Store capability contract without depending on one concrete adapter implementation. It represents one coherent caller capability; database identity alone does not qualify. Use `Layer` only for an Effect dependency layer.
_Avoid_: Effect Layer, concrete adapter, runtime capability registry, database capability bundle

**Focused Store Capability**:
A primitive Store contract for one proven caller workflow that a lower-tier Store cannot preserve. It carries an observable stream, callback, resource scope, cleanup rule, result lifecycle, or engine guarantee; its deletion loses observable caller behavior; and it has at least one working adapter path. Name it for the behavior, not for a database. Driver-independent contracts live in `@commissary/store`; driver- or ORM-specific contracts live with their adapter.
_Avoid_: `PostgresStore`, `MySqlStore`, `SqliteStore`, speculative engine feature, optional method, runtime capability registry

**SQL Store**:
A Store specialization that lets an integration execute ORM-independent, parameter-safe SQL Statements. It retains Collections, promises only one unchecked Row set, and makes at most one driver statement call for each `execute`; transactions, preparation, streaming, cancellation, session scope, batches, and multiple results require separate Store interfaces.
_Avoid_: Standalone SQL client, concrete Adapter, ORM Store, runtime capability probe

**SQL Column Type**:
An opaque storage-family and value-conversion contract for one Selected Field Value. A portable type has stable meaning across SQL adapters, while a database-specific type narrows that intent for one database.
_Avoid_: Driver type, raw DDL, Field Schema, TypeScript primitive

**SQL Literal**:
An opaque portable database default created by `sql.literal()` from one supported scalar value. It is definition metadata, not Raw SQL Text, an SQL Statement, or a Create Schema default.
_Avoid_: SQL expression, generated value, JSON default, bound parameter

**SQL Definition Resolution**:
The synchronous, I/O-free stage that combines Record Contributions and Record Overrides, selects active database metadata, resolves storage evidence and physical names, and returns immutable SQL Record References. It rebuilds every resolved fact after overrides.
_Avoid_: Store construction I/O, migration, schema diff, stale contributor metadata

**SQL Definition Error**:
One synchronous `SqlDefinitionError` that contains all independent SQL definition issues as stable codes, paths, and diagnostic messages.
_Avoid_: Store Error, first-error-only throw, database I/O failure, safe-to-log message

**SQL Record Reference**:
An immutable resolved table or column identifier that an SQL definition returns for safe SQL Statement composition. It is independent of one database connection and is neither a Record Definition nor a raw identifier string. It supplies no direct-SQL parameter conversion.
_Avoid_: Store-scoped token, raw name, database row, unbound definition

**SQL Identifier**:
An SQL Statement part created by `sql.identifier()` from one nonempty caller-supplied database name part without NUL. The SQL Store Adapter quotes the complete part for its database and never splits it on `.`. Every other character remains part of that one name. It is not Raw SQL Text or a bound value.
_Avoid_: SQL Record Reference, Raw SQL Text, SQL Parameter Value, database permission

**Integration SQL Record Scope**:
The resolved SQL Record References that a host passes to an integration factory. They state which Records the integration is intended to use but do not restrict SQL text or create a security boundary.
_Avoid_: enforced table allowlist, database permission, SQL sandbox, every host database identifier

**SQL Statement**:
An immutable, composable value that keeps SQL structure separate from bound values until a SQL Store Adapter executes it. Package SQL helpers validate their structural arguments immediately, throw `TypeError` for invalid arguments, and return only valid, immutable SQL Statements. Resolved SQL Record References also create valid SQL Statements. Compatible installed package copies accept each other's Statements; `execute` rejects incompatible or counterfeit values. SQL text can use one database dialect, and the database decides whether genuine empty SQL is valid.
_Avoid_: Portable SQL, driver query object, executed query, mutable text-and-values bag

**SQL Statement Compiler**:
The official adapter-facing `@commissary/store/sql-adapter` operation that checks and compiles an opaque SQL Statement with adapter-supplied identifier quoting, zero-based parameter placeholders, a parameter support check, and parameter conversion. It processes parameters from left to right, runs each explicit encoder before that parameter's support check, applies the shared finite-number, negative-zero, and NUL-string rules, then calls adapter conversion. It stops at the first failure without calling the driver. An unsupported value becomes `SqlStatementError` reason `unsupported-parameter`; a thrown encoder, support, or conversion failure becomes `invalid-parameter` with its zero-based position and cause. A failing identifier quote or placeholder callback, or its non-string output, becomes `StoreAdapterContractError` violation `invalid-sql-compilation`. The compiler returns SQL text and ordered driver values without exposing Statement internals.
_Avoid_: integration API, public Statement data, driver query builder, adapter-specific Statement

**SQL Statement Parameter Requirement**:
The union of bound-value kinds in an SQL Statement. Primitive literal values use their broader primitive types, such as `string`, `number`, and `boolean`, instead of exact value types. `never` means that the Statement has no bound values; `unknown` means that callers know no narrower requirement. The exported `SqlStatement<out Parameter>` type is covariant and has no default requirement, while normal Statement construction infers it.
_Avoid_: result row type, accepted Store parameter type, runtime value array, default type argument

**SQL Statement Join**:
An immutable SQL Statement created by `sql.join(statements, separator?)`. It takes a shallow snapshot of the input list, keeps input order, and inserts the SQL Statement separator only between items. Later list changes have no effect. Empty input produces an empty SQL Statement.
_Avoid_: string join, automatic array expansion, mutation, automatic parentheses

**SQL Parameter Value**:
A value kept separate from SQL structure inside an SQL Statement. Every SQL Store Adapter accepts `null`, boolean, finite number, and string values. It converts `null` to SQL `NULL`, converts booleans to the database's normal boolean representation, normalizes negative zero to zero, and rejects non-finite numbers and strings containing NUL. An interpolated array remains one bound value and is never expanded into SQL structure. A host or integration converts richer direct-SQL values before interpolation unless it requires a wider SQL Store. A mutable wider value is read when `execute` starts and must not change while that execution remains active.
_Avoid_: SQL fragment, Raw SQL Text, identifier, direct driver pass-through, non-finite number

**Explicit SQL Parameter**:
An SQL Parameter Value wrapped by `sql.param(value, options?)` for direct SQL. Without options, the input is the bound value and its type is the SQL Statement parameter requirement. With `{ encode }`, construction captures the function reference so later options-object changes have no effect. The synchronous function runs once for each occurrence on each execution after `execute()` returns its Promise and before the driver call; its output type becomes the requirement. Reusing one explicit parameter in two places runs the encoder twice and creates two ordered driver parameters. The SQL Store Adapter validates and converts each bound value for its database. Encoder output cannot contain an SQL Statement: TypeScript rejects it, and execution rejects a bypass as an invalid parameter instead of inserting SQL structure.
_Avoid_: SQL Identifier, Raw SQL Text, implicit field conversion, driver parameter

**SQL Execution Result**:
The generic result of one SQL Statement, containing exactly one readonly `rows` array of unchecked driver values. The adapter can return driver row containers without copying or freezing them, but it must not change them after fulfillment. A later change is an adapter defect and cannot retroactively reject the fulfilled Promise. Generic `execute` rejects multiple result sets; a future Batch Store feature can handle them when a Store supports that feature and a real caller needs it. A Store specialization adds only result facts that it guarantees.
_Avoid_: Selected Records, normalized row values, guessed mutation facts, multiple result sets

**Raw SQL Text**:
SQL structure inserted by `sql.raw()` without parameter handling. It can be a fragment or a complete statement, and its caller owns its safety.
_Avoid_: Unchecked SQL Row, bound parameter, driver result

**Manual SQL Transaction Control**:
`BEGIN`, `COMMIT`, `ROLLBACK`, savepoint, or equivalent SQL submitted through `execute`. It is unsupported because `TransactionStore.transaction()` owns transaction boundaries. An adapter need not detect it. Transaction Store guarantees apply only when callers do not submit it, and conformance tests never submit it.
_Avoid_: Transaction Store operation, supported Raw SQL Text, nested transaction, portable session control

**SQL Statement Error**:
An expected Store Error with fixed operation `execute`. Reason `invalid-statement` reports an incompatible or counterfeit SQL Statement. Reasons `unsupported-parameter` and `invalid-parameter` include the zero-based parameter position. An explicit parameter encoder failure or SQL Statement output uses `invalid-parameter`; a thrown encoder or conversion failure is preserved as its optional cause. Safe metadata contains no SQL text or parameter value.
_Avoid_: SQL Execution Error, database failure, unsafe parameter logging, Adapter Contract Error

**SQL Execution Error**:
An expected Store Error with fixed operation `execute` reported when an SQL Store Adapter cannot execute a valid SQL Statement. Reason `execution-failed` requires the original failure as `cause` and a boolean `executionMayHaveOccurred`. Reason `multiple-results` has no cause, and `executionMayHaveOccurred` is always `true`, because execution succeeded and returned data must not enter the error. Safe metadata contains no SQL text or parameter values.
_Avoid_: SQL Statement Error, driver error exposed directly, database-specific failure taxonomy, safe-to-log cause

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
A defect Error outside the Store Error hierarchy. It reports that an adapter returned invalid data, overwrote a host value, produced an impossible expression result, failed SQL compilation, or broke its transaction contract. SQL compilation callback defects use operation `execute` and violation `invalid-sql-compilation`. An SQL result with an invalid shape rejects before fulfillment with operation `execute` and violation `invalid-sql-result`; it never retains returned data as `cause`, but it can retain a separate failure thrown while checking that data.
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
A Store specialization with one `transaction` operation. Its callback receives a Transaction View without `transaction`, so nesting is not supported. A wider adapter adds each capability that is safe inside the active transaction. Version 1 accepts no cancellation option. Overlapping transactions must act as if they ran one at a time, and two conflicting transactions cannot both commit. Each adapter enforces this rule in its storage system. It can use a database or ORM transaction operation internally, but it must wrap that operation to preserve every Transaction Store guarantee. One transaction call invokes its callback at most once. If the callback fails, the adapter discards all of its writes. A successful rollback reports the same failure value; a failed rollback reports a Transaction Rollback Error.
_Avoid_: Sequential fallback, shared in-process lock, weaker overlap guarantee, hidden callback retry, `AbortSignal`

**Transaction Callback Runner**:
The shared adapter-facing `@commissary/store/transaction-adapter` helper that supplies `track` to a Transaction View factory, invokes the public callback once, closes the View, tracks and drains operations, records caught failures, and selects the Transaction Callback Failure. It does not begin, commit, or roll back the adapter's physical transaction.
_Avoid_: public transaction API, physical transaction manager, nested transaction, driver session

**Transaction View**:
The Store passed to a transaction callback. It uses the transaction's Records and operators, includes adapter capabilities that are safe inside the active transaction, and has no `transaction` method. Each method rejects after the View closes, tracks its returned Promise until that Promise settles, and records a rejection even if callback code catches it. A rejected operation marks the transaction for rollback because recovery requires an unsupported savepoint or nested transaction. Overlapping calls are allowed, but an adapter can serialize them and the Store promises no order or parallel execution; callers await calls in sequence when order matters. The View closes when the callback settles.
_Avoid_: Transaction Store, nested transaction, savepoint, independent Store

**Transaction Closed Error**:
An expected `TransactionClosedError` reported when an operation uses a Transaction View after its callback has settled. Its constructor accepts no options and exposes no operation or input data. The closed View never uses another connection or starts independent work.
_Avoid_: Adapter I/O failure, implicit new transaction, independent Store operation, use-after-scope

**Transaction Unsettled Operation Error**:
An expected `TransactionUnsettledOperationError` with no constructor options or operation data, reported when a transaction callback succeeds while a Store operation that it started remains active. This error takes priority over settled operation failures when the callback itself succeeded. The adapter closes the Transaction View, drains active work, and rolls back instead of committing unawaited work. JavaScript cannot report whether a settled Promise was awaited, so an operation that finished before the callback settled is not active. If active work never settles, the transaction remains pending because the base contract has no safe timeout or cancellation rule. Hosts must use backend-specific operation, transaction, session, and lock limits plus monitoring to bound resources; these controls are outside the portable Store contract and must make the active operation settle before rollback starts.
_Avoid_: silent commit, fire-and-forget transaction work, assumed cancellation, Transaction Closed Error

**Transaction Operation Failure**:
The exact rejection value from a Transaction View operation. It marks the transaction for rollback even when callback code catches it because databases differ on whether work can continue safely after an operation fails. If a successful callback has no active work and multiple operations failed, the first operation in call order supplies the failure.
_Avoid_: recoverable caught error, implicit savepoint, successful callback, database-specific continuation

**Transaction Capability**:
An adapter feature that remains safe and bound to the active transaction. The adapter defines which wider capabilities its Transaction View includes.
_Avoid_: Nested `transaction`, capability used outside the active transaction, mandatory base Store feature

**Transaction Conflict**:
An expected `TransactionConflictError` reported when a transaction cannot commit without breaking the overlap guarantee. The Transaction Store does not rerun the callback. Core starts a new transaction for its storage-only work while fewer than three attempts have run.
_Avoid_: Adapter I/O failure, partial commit, hidden callback retry, Defect

**Transaction Rollback**:
The adapter-owned action that discards every write after a transaction callback fails, succeeds with an active Store operation, or catches a failed Transaction View operation. The adapter closes the Transaction View and drains active work before rollback; it never races rollback against an active operation. Each adapter uses its own storage mechanism and can delegate the physical transaction to a wrapped database or ORM operation. Core provides no shared rollback fallback. After rollback succeeds, Store preserves the callback boundary failure. After rollback fails, stored state is unknown.
_Avoid_: Failed create cleanup, partial commit, Core rollback, shared rollback implementation

**Transaction Rollback Error**:
An expected Store Error for a failed Transaction Rollback. It contains the callback boundary failure under `callbackFailure` and the rollback failure under `rollbackFailure`, sets `writesMayRemain` to `true`, and prevents a Core retry. Its failure values are not safe default telemetry.
_Avoid_: Transaction Callback Failure, Transaction Conflict, known clean state, automatic retry, safe metadata

**Transaction Callback Failure**:
The exact boundary failure selected in this order: the value rejected by the callback; a Transaction Unsettled Operation Error when a successful callback leaves active work; or the first Transaction Operation Failure in call order when the callback otherwise succeeds. After rollback succeeds, `transaction` rejects with this value unchanged.
_Avoid_: Transaction Conflict, Store wrapper, rollback failure, Adapter I/O failure

**Core Transaction Retry**:
A new transaction started immediately by a specialized Thread Store operation after a Transaction Conflict. The Core callback only reads and writes Store data. One operation makes at most three transaction attempts: the first attempt and two retries.
_Avoid_: Adapter callback retry, unbounded retry, retry of external work
