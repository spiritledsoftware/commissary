# Portable SQL capability interfaces

Research date: 2026-08-03. This compares established interfaces; it does **not** design Commissary's final API.

## Sources and snapshots

| System | Pinned first-party snapshot | Scope |
| --- | --- | --- |
| Effect SQL | vendored `effect` **4.0.0-beta.102**, commit [`f4151e1937c26de14f1d64566f8126173f1b5014`](https://github.com/Effect-TS/effect/tree/f4151e1937c26de14f1d64566f8126173f1b5014) | Current `.repos/effect` core SQL plus PostgreSQL adapter; version at `.repos/effect/packages/effect/package.json:1-12`. |
| Kysely | **0.29.4**, commit [`bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b`](https://github.com/kysely-org/kysely/tree/bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b), from the first-party [`v0.29.4` release](https://github.com/kysely-org/kysely/releases/tag/v0.29.4) | Mature cross-dialect query builder and driver contract. |
| Slonik | **49.10.9**, commit [`0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70`](https://github.com/gajus/slonik/tree/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70), from the first-party [`slonik@49.10.9` release](https://github.com/gajus/slonik/releases/tag/slonik@49.10.9) | Mature PostgreSQL-specific client, used as a contrasting interface rather than cross-dialect evidence. |

“Fact” below is directly evidenced; “implication” is an evidence-derived portability consequence.

## Comparison at a glance

| Dimension | Effect SQL | Kysely | Slonik |
| --- | --- | --- | --- |
| Statement/binding | Ordinary interpolations become parameters; fragments remain structure; `unsafe`/`literal` are explicit bypasses. | Builders/tag compile to separate SQL and parameters; explicit helpers handle identifiers/literals/raw SQL. | Only SQL-tag tokens execute; primitives become placeholders plus values; explicit tokens represent structure. |
| Rows | Generic compile-time row type; separate `SqlSchema` runtime encode/decode helpers. | Compile-time types only; driver values pass through. | Standard Schema parser and inferred output travel with query; validation runs only when an interceptor is installed. |
| Mutation result | Normal path returns rows; raw result is driver-specific `unknown`; no core affected-count/id contract. | Rows plus optional `bigint` affected/changed counts and insert id. | PostgreSQL result includes command, `rowCount: number`, rows, fields, notices. |
| Errors | Structured reasons, cause, operation, retryability; adapters classify driver errors. | No common database-error taxonomy; logs and rethrows driver error. | Mapped `SlonikError` subclasses; native error retained as diagnostic `cause`. |
| Transaction | Effect-context-bound connection; nesting via savepoints. | Callback gets query-capable `Transaction<DB>`; success commits, throw rolls back/rethrows; nested transaction callback unsupported. | Callback gets common query methods plus transaction metadata; savepoint nesting and retry-driven callback replay. |

## 1. Statement construction and binding

### Effect SQL

**Fact.** `Statement<A>` is both a fragment and `Effect<ReadonlyArray<A>, SqlError>`; compilation yields `[sql, params]` ([`Statement.ts:63-82`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/Statement.ts#L63-L82)). A parameter is an explicit segment containing an unknown value ([`Statement.ts:193-214`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/Statement.ts#L193-L214)). Tag construction preserves fragments/segments and converts every ordinary interpolation to `parameter(arg)` ([`Statement.ts:610-644`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/Statement.ts#L610-L644)). Direct text insertion is conspicuous through `unsafe` and `literal` ([`Statement.ts:422-447`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/Statement.ts#L422-L447)).

### Kysely

**Fact.** Its `sql` tag sends substitutions as parameters rather than interpolated text; `ref`, `table`, `id`, `lit`, and `raw` are separate structural/literal helpers ([`sql.ts:12-31`](https://github.com/kysely-org/kysely/blob/bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b/src/raw-builder/sql.ts#L12-L31)). Compiled driver input has distinct `sql` and `parameters` fields ([`compiled-query.ts:8-13`](https://github.com/kysely-org/kysely/blob/bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b/src/query-compiler/compiled-query.ts#L8-L13)). Kysely warns that unchecked dynamic references are injection hazards ([`sql.ts:150-175`](https://github.com/kysely-org/kysely/blob/bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b/src/raw-builder/sql.ts#L150-L175)).

### Slonik

**Fact.** Slonik accepts query tokens, not plain query strings, and documents `${userInput}` becoming a value binding ([`README.md:353-409`](https://github.com/gajus/slonik/blob/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70/README.md#L353-L409)). Its tag checks for a frozen template literal, turns primitive expressions into placeholders and `parameterValues`, and treats only recognized SQL tokens as structure ([`createSqlTag.ts:40-96`](https://github.com/gajus/slonik/blob/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70/packages/sql-tag/src/factories/createSqlTag.ts#L40-L96)). Manual query objects are rejected and generated tokens frozen ([`README.md:1460-1503`](https://github.com/gajus/slonik/blob/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70/README.md#L1460-L1503)).

**Implication.** The common safety property is two channels—SQL structure and bound data—not a particular placeholder syntax. Dynamic identifiers need a distinct trusted path. Runtime provenance and immutability can reinforce this when TypeScript brands disappear at a JavaScript boundary, but do not replace binding.

## 2. Compile-time typing versus runtime validation

### Effect SQL

**Fact.** The generic `A` determines a statement's static row type, while the low-level connection returns `ReadonlyArray<any>` or raw `unknown` ([`SqlConnection.ts:26-62`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/SqlConnection.ts#L26-L62)). Runtime checking is opt-in through `SqlSchema`: `findAll` encodes a request, executes against unknown rows, decodes the array, and exposes `SchemaError` ([`SqlSchema.ts:19-49`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/SqlSchema.ts#L19-L49)). Other helpers make non-empty, required-first, and optional-first cardinalities explicit ([`SqlSchema.ts:65-84`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/SqlSchema.ts#L65-L84), [`115-139`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/SqlSchema.ts#L115-L139), [`148-171`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/SqlSchema.ts#L148-L171)).

### Kysely

**Fact.** The first-party [data-type guide](https://www.kysely.dev/docs/recipes/data-types) says table declarations are TypeScript-only, cannot alter runtime values, and Kysely returns driver data unchanged (apart from transforming plugins). A raw SQL generic declares `RawBuilder<T>` but supplies no runtime decoder ([`sql.ts:126-132`](https://github.com/kysely-org/kysely/blob/bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b/src/raw-builder/sql.ts#L126-L132)).

### Slonik

**Fact.** `sql.type(parser)`/aliases attach a Standard Schema parser, while `sql.unsafe` attaches an unknown parser ([`createSqlTag.ts:220-273`](https://github.com/gajus/slonik/blob/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70/packages/sql-tag/src/factories/createSqlTag.ts#L220-L273)); output is inferred through `StandardSchemaV1.InferOutput<T>` ([`types.ts:345-350`](https://github.com/gajus/slonik/blob/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70/packages/slonik/src/types.ts#L345-L350)). Crucially, Slonik does **not** automatically run the parser: official docs require an interceptor; the example calls `resultParser["~standard"].validate(row)` and throws `SchemaValidationError` on issues ([`README.md:1190-1262`](https://github.com/gajus/slonik/blob/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70/README.md#L1190-L1262)).

**Implication.** Static result types do not prove rows were checked. A JavaScript boundary should make runtime decoding explicit and distinguish static typing, decoding, and cardinality checking.

## 3. Mutation result normalization

**Effect fact.** `Statement.raw` returns `unknown`; ordinary/unprepared execution returns rows ([`Statement.ts:71-81`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/Statement.ts#L71-L81)). The driver contract preserves that distinction ([`SqlConnection.ts:26-62`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/SqlConnection.ts#L26-L62)). `SqlSchema.void` deliberately discards a mutation result ([`SqlSchema.ts:86-105`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/SqlSchema.ts#L86-L105)). Core Effect therefore claims no portable affected-count/id shape.

**Kysely fact.** `QueryResult<O>` always has `rows`, but `numAffectedRows`, MySQL-specific `numChangedRows`, and `insertId` are optional `bigint`s ([`database-connection.ts:39-69`](https://github.com/kysely-org/kysely/blob/bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b/src/driver/database-connection.ts#L39-L69)). Insert id can be unavailable on PostgreSQL and counts have MySQL caveats ([`insert-result.ts:1-52`](https://github.com/kysely-org/kysely/blob/bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b/src/query-builder/insert-result.ts#L1-L52)); updates distinguish updated rows from optional changed rows ([`update-result.ts:1-20`](https://github.com/kysely-org/kysely/blob/bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b/src/query-builder/update-result.ts#L1-L20)).

**Slonik fact.** Its PostgreSQL result has a command discriminator, `rowCount: number`, rows, fields, and notices ([`types.ts:352-360`](https://github.com/gajus/slonik/blob/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70/packages/slonik/src/types.ts#L352-L360)). This is PostgreSQL evidence, not a cross-dialect guarantee.

**Implication.** A universal success contract cannot require insert id, changed count, or one numeric representation. Preserve only reported facts; never fabricate `0` or an id. Returned rows are separate from command metadata. If values cross JSON, `bigint` requires an explicit serialization policy rather than lossy conversion.

## 4. Error exposure and translation

### Effect SQL

**Fact.** Effect's reason union covers connection, authentication/authorization, syntax, uniqueness/constraint, deadlock, serialization, lock timeout, statement timeout, and unknown failures. Reasons retain cause/operation metadata and retryability; `SqlError` delegates to the reason ([`SqlError.ts:19-50`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/SqlError.ts#L19-L50), [`328-421`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/SqlError.ts#L328-L421)). The PostgreSQL adapter classifies native connect/acquisition failures into these reasons ([`PgClient.ts:179-202`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/sql/pg/src/PgClient.ts#L179-L202), [`302-329`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/sql/pg/src/PgClient.ts#L302-L329)). Runtime decoding separately adds `SchemaError`.

### Kysely

**Fact.** The database connection declares no common database-error type ([`database-connection.ts:8-36`](https://github.com/kysely-org/kysely/blob/bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b/src/driver/database-connection.ts#L8-L36)). The runtime wrapper catches for logging and rethrows the same value ([`runtime-driver.ts:207-231`](https://github.com/kysely-org/kysely/blob/bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b/src/driver/runtime-driver.ts#L207-L231)). Database classification remains driver-specific, though Kysely itself has API/cardinality errors.

### Slonik

**Fact.** All mapped errors derive from `SlonikError`. The original `node-postgres` error is retained as `cause`, but docs say it is diagnostic only and must not drive conditional logic ([`README.md:2883-2910`](https://github.com/gajus/slonik/blob/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70/README.md#L2883-L2910)).

**Implication.** Translate at the boundary into stable plain data with a deliberately coarse category, message, retryability/unknown, and optional metadata; preserve native causes internally. Do not expose Effect/Slonik classes or require Kysely consumers to inspect driver fields. Keep database, decoding, and cardinality failures distinguishable.

## 5. Transaction-bound capabilities

### Effect SQL

**Fact.** `SqlClient` exposes `withTransaction(effect)` and a transaction-context service ([`SqlClient.ts:30-62`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/SqlClient.ts#L30-L62)). Statement acquisition uses the context connection when present ([`SqlClient.ts:138-176`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/SqlClient.ts#L138-L176)). It begins at depth zero, uses savepoints when nested, installs the same connection, commits on successful exit, and rolls back transaction/savepoint on failure or interruption ([`SqlClient.ts:213-290`](https://github.com/Effect-TS/effect/blob/f4151e1937c26de14f1d64566f8126173f1b5014/packages/effect/src/unstable/sql/SqlClient.ts#L213-L290)).

### Kysely

**Fact.** `transaction().execute(callback)` supplies `Transaction<DB>`, which inherits the query API; throw rolls back and rethrows, otherwise callback success commits ([`kysely.ts:242-327`](https://github.com/kysely-org/kysely/blob/bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b/src/kysely.ts#L242-L327)). `Transaction<DB>` rejects another `transaction()` call, so automatic nesting is absent ([`kysely.ts:651-673`](https://github.com/kysely-org/kysely/blob/bcd6e4e3c60f8068da6de105bb2f2c82d3a6b04b/src/kysely.ts#L651-L673)).

### Slonik

**Fact.** `DatabaseTransactionConnection` contains `CommonQueryMethods` plus connection id, transaction id/depth, and events ([`types.ts:119-140`](https://github.com/gajus/slonik/blob/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70/packages/slonik/src/types.ts#L119-L140), [`167-185`](https://github.com/gajus/slonik/blob/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70/packages/slonik/src/types.ts#L167-L185)). Callback resolution commits and rejection rolls back; nesting uses savepoints ([`README.md:2655-2758`](https://github.com/gajus/slonik/blob/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70/README.md#L2655-L2758)). Rollback-class failures can rerun the callback under retry limits ([`README.md:2760-2770`](https://github.com/gajus/slonik/blob/0d9da1dcf8e4e85c3318c3bdfe69d5af10232f70/README.md#L2760-L2770)).

**Implication.** The common pattern is a lexical operation routing enclosed queries through one transaction connection and settling from callback completion. Ambient Effect context, Kysely classes, and Slonik connection/event types are not portable. Savepoint nesting and callback replay are separate capabilities and must not be inferred silently.

## Evidence-derived patterns for a plain-JavaScript boundary

These are constraints and patterns, **not a proposed Commissary API**. Exact names and shapes remain for later design.

1. **Carry statements as inert data with separate text and parameters.** Ordinary values enter only the parameter channel; trusted identifiers/fragments/raw text require an explicit path. Do not expose Effect statements, Kysely builders, Slonik tokens, or driver prepared-statement objects.
2. **Make runtime row decoding explicit.** TypeScript generics vanish at the boundary. Effect has an explicit schema adapter; Slonik attaches a schema but requires an interceptor; Kysely performs no validation. Treat static typing, decoding, and cardinality checking as distinct properties.
3. **Use plain rows as the common success payload and command metadata as optional facts.** Counts, changed counts, ids, command tags, and numeric representations differ. Never synthesize missing facts; establish a deliberate JSON-safe count/id encoding if serialization is required.
4. **Normalize failures without erasing diagnostics.** Use plain boundary data and a small stable classification. Preserve native causes internally; separate database execution, decoding, and cardinality failures. Avoid Effect/Slonik classes and driver-specific fields in the boundary contract.
5. **Pass a transaction-bound query capability to a lexical callback.** It can support the same boundary-level operations while hiding physical connections and framework context. Commit/rollback follows callback settlement. Declare nesting and retry/replay independently.
6. **Keep escape hatches visibly unsafe.** All three systems separate dynamic SQL structure from values. At a JavaScript boundary, runtime guards are useful because TypeScript brands cannot establish provenance.

The shared lesson is a boundary around **execution capability**, not one library's fluent builder: safe compiled input, explicit decode policy, conservative result facts, normalized failures, and transaction-scoped execution can be represented without leaking Effect or driver types. The final Commissary interface is intentionally undecided.
