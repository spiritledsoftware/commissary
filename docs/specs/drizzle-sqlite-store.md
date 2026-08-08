# Drizzle SQLite Store Adapter Technical Specification

> **Status**: Design approved for implementation.
>
> **Last updated**: 2026-08-07 during issue #18 design approval.

## Summary

`@commissary/drizzle` binds one connection-free `DrizzleSqliteStore` definition to an existing host-owned Drizzle SQLite database. One public `bindSqliteStore` function returns `SqlStore` by default and adds `TransactionStore` only when the caller requests it and the database proves an asynchronous transaction path.

The binder accepts the common public Drizzle SQLite database contract. It does not enumerate better-sqlite3, Bun SQLite, Cloudflare D1, Durable Objects SQLite, Expo SQLite, libSQL, OP SQLite, Prisma SQLite, SQL.js, SQLite proxy, or future driver classes. Synchronous and asynchronous drivers can provide the base Store. A requested Transaction Store is capability-dependent.

The adapter uses public Drizzle SQL, query-builder, and transaction APIs. It does not access `$client`, inspect a driver session, create a client, or own client lifetime. SQLite-compatible services can bind when their public Drizzle path passes the same applicable checks.

This specification extends:

- the [Store Architecture Technical Specification](store.md);
- the [SQL Store Tier Technical Specification](sql-store.md); and
- the [Drizzle Store Technical Specification](drizzle-store.md).

Those specifications remain authoritative except where this document gives a SQLite-specific rule.

## Goals

- Bind every Drizzle SQLite driver through one common public database contract.
- Preserve the approved Store, SQL Store, and optional Transaction Store contracts.
- Translate opaque Commissary SQL Statements without parsing placeholder text.
- Map row-producing SQL to Drizzle `all()` and non-row-producing SQL to Drizzle `run()`.
- Preserve the exact public Drizzle command result and normalize only a verified affected-row count.
- Return stored SQLite values after defaults, ROWID generation, generated columns, affinity conversion, rounding, and identity-stable trigger work.
- Detect concurrent candidate changes before update or delete.
- Prove a requested asynchronous transaction path before exposing it.

## Non-Goals

- Create, configure, migrate, checkpoint, vacuum, back up, serialize, or close a SQLite database.
- Enumerate driver classes or expose a public driver capability matrix.
- Access native clients, Drizzle sessions, or internal dialect objects.
- Infer a driver from constructor names or private properties.
- Support SQLite before version 3.45.
- Parse SQL to decide whether it returns rows.
- Manufacture command metadata with `SELECT changes()` or another driver call.
- Promise support for views, virtual tables, or host triggers that change Store identity.
- Compare the live schema with the supplied Drizzle schema.
- Retry Store operations or transaction callbacks.

## Invariants

1. **One binder**: SQLite exports one `bindSqliteStore` function.
2. **Common database contract**: The public API accepts the common `BaseSQLiteDatabase` shape instead of a driver union.
3. **Public Drizzle APIs only**: Binding and Store work use public SQL, query-builder, `all`, `run`, and transaction APIs.
4. **SQLite 3.45**: Every binding proves `sqlite_version() >= 3.45.0`.
5. **Base support first**: Every accepted synchronous or asynchronous driver can provide the base SQL Store.
6. **Requested transaction**: Literal `transaction: true` adds Transaction Store only after a live asynchronous probe succeeds.
7. **Honest transaction capability**: A synchronous callback path or an asynchronous path that commits before an awaited continuation rejects binding.
8. **Host lifetime**: Binding never creates, configures, or closes the supplied database or its resources.
9. **Visible SQL mode**: `query()` is for row-producing statements and `execute()` is for statements that produce no row set.
10. **Exact Statement structure**: SQL conversion interleaves exact compiler segments and parameters. It never parses `?` or raw text.
11. **One SQL call**: One `query()` or `execute()` call makes at most one driver statement call and performs no retry.
12. **Stable command result**: `execute()` returns one normalized wrapper with an optional verified affected count and the exact Drizzle `run()` result.
13. **Private candidate identity**: A declared primary key is preferred. Otherwise the adapter uses an unshadowed ROWID alias.
14. **Identity required**: A Store table with neither a declared primary key nor an accessible ROWID alias is invalid.
15. **No silent overwrite**: Update and delete guard the candidate identity and every observed raw field value.
16. **Stored-value readback**: Create and update read the stored row again by identity before they report success.
17. **Identity-stable triggers**: Host trigger work can change non-identity fields, but it must not change the selected Store identity.
18. **Sequential mutation**: Candidate writes run one at a time. A later failure can leave earlier base writes in place.
19. **Physical transaction sharing**: Collection, `query`, and `execute` calls in a Transaction View use the same Drizzle transaction database.
20. **Normal SQLite isolation**: A requested transaction needs serializable behavior but does not require `BEGIN IMMEDIATE`.
21. **No callback retry**: The adapter invokes a transaction callback at most once.
22. **Structured conflict mapping**: Only structured SQLite `BUSY` codes become `TransactionConflictError`; messages are not parsed.
23. **No live schema introspection**: Binding does not inspect columns, keys, triggers, indexes, or generated expressions.
24. **Native Promise boundary**: Binding and Store methods return native Promises and do not throw synchronously.

## Definition and candidate identity

The shared Drizzle definition lifecycle remains connection-free. It resolves SQLite tables, columns, codecs, defaults, generated columns, primary keys, and ROWID metadata before binding.

A supplied Drizzle table contributes its column-level or table-level primary key. A lower-tier SQL primary key and supplied table must name the same logical fields in the same order. An explicit SQLite ROWID column remains an `INTEGER PRIMARY KEY` and is the declared primary key identity.

The adapter resolves one private identity plan for each Store table:

```ts
type DrizzleSqliteIdentityPlan =
  | {
      readonly kind: "primary-key";
      readonly fields: readonly [string, ...string[]];
    }
  | {
      readonly kind: "rowid";
      readonly alias: "rowid" | "_rowid_" | "oid";
    };
```

When no primary key exists, the adapter selects the first name in this order that is not a physical column name:

1. `rowid`;
2. `_rowid_`; and
3. `oid`.

A physical column shadows the matching alias. A table that shadows all three aliases and has no declared primary key is invalid. The private alias never becomes a Record field, public identifier, migration asset, or returned property.

A SQLite `WITHOUT ROWID` table must have a primary key. The adapter does not inspect the live table form. The host must keep the supplied Drizzle table and live schema equivalent. A mismatch can cause a later typed adapter failure.

Views and virtual tables are outside this contract because SQLite does not give every such object the required `RETURNING` and ROWID behavior.

## Accepted database type

The binder accepts the common public Drizzle contract represented by:

```ts
BaseSQLiteDatabase<ResultKind, RunResult, FullSchema, RelationalSchema>;
```

where `ResultKind` is `"sync"` or `"async"`. The public binder does not enumerate concrete database classes. It preserves `RunResult` as the `driverResult` type returned by `SqlStore.execute()`.

A database is accepted for the base Store when:

1. its value is compatible with the common public Drizzle SQLite database contract;
2. its public `all()` path completes the version probe;
3. the probe returns exactly one valid SQLite version; and
4. that version is 3.45.0 or later.

The probe does not claim that the engine is the upstream SQLite library. D1, libSQL, and other SQLite-compatible services can pass when their observable path preserves this contract.

A mock, wrong dialect, failed connection, unsupported engine version, malformed result, or incompatible future implementation rejects binding before a Store exists. Binding performs no write probe.

## Public binding API

The [package interface specification](drizzle-package-interface.md) owns the exact overloads. Applied to SQLite:

```ts
const baseStore = await bindSqliteStore({
  definition,
  database,
}); // SqlStore

const transactionStore = await bindSqliteStore({
  definition,
  database,
  transaction: true,
}); // SqlStore & TransactionStore

const possibleTransactionStore = await bindSqliteStore({
  definition,
  database,
  transaction: runtimeBoolean,
}); // SqlStore | (SqlStore & TransactionStore)
```

The binder accepts Drizzle's public `BaseSQLiteDatabase` type directly. It accepts a matching generic or Thread Store definition and preserves `ResultKind`, `RunResult`, full-schema, and relational-schema inference. Omitted or literal-false `transaction` makes no transaction probe and exposes no transaction method. Literal true runs the transaction probe. A non-literal Boolean returns a union and requires capability narrowing.

The structural result preserves `RunResult` as the exact `SqlCommandResult.driverResult` type. It has no exported database-named bound Store alias. Binding returns a native Promise before definition checks or database work.

## Binding probes

### Version probe

Every binding performs one public Drizzle `all()` call equivalent to:

```sql
SELECT sqlite_version() AS sqlite_version
```

The result must be one array with exactly one object row and one string `sqlite_version` field. The adapter parses three nonnegative decimal safe-integer components and requires version 3.45.0 or later. It does not use lexical version comparison or accept suffix text as an additional component.

### Transaction probe

Only `transaction: true` performs the transaction probe. The adapter delegates once to `database.transaction` without requiring a transaction behavior option. Inside the callback it performs the equivalent of:

```ts
await transaction.run(sql.raw("PRAGMA defer_foreign_keys = ON"));
await Promise.resolve();

const liveness = await transaction.all(sql.raw("PRAGMA defer_foreign_keys"));
const isolation = await transaction.all(sql.raw("PRAGMA read_uncommitted"));
const journal = await transaction.all(sql.raw("PRAGMA journal_mode"));
```

The probe requires:

- `defer_foreign_keys` to remain `1` after the asynchronous continuation;
- `read_uncommitted` to be `0`; and
- `journal_mode`, normalized to lowercase, to be `delete`, `truncate`, `persist`, `memory`, or `wal`.

SQLite resets `defer_foreign_keys` at commit or rollback. A synchronous Drizzle transaction that commits when the callback returns therefore reads `0` after the Promise continuation and fails the probe. An asynchronous implementation that does not await its callback also fails.

The probe starts and finishes one real transaction. It does not write a table, request `BEGIN IMMEDIATE`, test concurrent connections, or alter a persistent journal mode.

## Binding errors

Binding rejects with one adapter-owned error before a Store value exists:

```ts
export type DrizzleSqliteBindingErrorReason =
  | "invalid-database"
  | "probe-failed"
  | "invalid-version-result"
  | "unsupported-sqlite-version"
  | "transaction-unavailable";

export declare class DrizzleSqliteBindingError extends Error {
  readonly name: "DrizzleSqliteBindingError";
  readonly reason: DrizzleSqliteBindingErrorReason;
  readonly cause?: unknown;
}
```

`unsupported-sqlite-version` can expose the normalized version tuple. Messages and causes are not safe default telemetry. Binding errors contain no SQL parameters, result rows, credentials, or connection details.

`invalid-database` reports a value without the required public database methods. `probe-failed` reports a rejected or thrown version call. `invalid-version-result` reports a fulfilled call with a malformed row container, row, field, or version component. A valid older version preserves `unsupported-sqlite-version`.

## SQL Statement translation

The adapter calls `compileSqlStatement` with SQLite rules:

- identifiers use double-quote escaping;
- placeholders in compiled text are `?`;
- portable direct parameters accept `SqlParameterValue`;
- boolean becomes `1` or `0`;
- negative zero becomes zero; and
- strings containing NUL and non-finite numbers reject before Drizzle work.

The compiler returns `text`, `parameters`, and exact `segments`. The adapter creates one public Drizzle SQL value by interleaving segments with parameters:

```ts
function toDrizzleSql<Parameter>(compiled: CompiledSqlStatement<Parameter>): DrizzleSql {
  const chunks: DrizzleSqlChunk[] = [];

  for (const [index, segment] of compiled.segments.entries()) {
    chunks.push(drizzleSql.raw(segment));
    if (index < compiled.parameters.length) {
      chunks.push(drizzleSql.param(compiled.parameters[index]));
    }
  }

  return drizzleSql.join(chunks);
}
```

Raw text that contains `?`, quotes, comments, or complete statements remains one raw chunk. The adapter never parses or rewrites it.

## SQL query and command behavior

`query<Row>()` calls `database.all<Row>()` exactly once. It accepts one array result and returns that same row container without copying it. The caller-selected `Row` type is unchecked. A non-array successful result is `StoreAdapterContractError` with violation `invalid-sql-result`.

`execute()` calls `database.run()` exactly once and returns:

```ts
interface SqlCommandResult<out DriverResult = unknown> {
  readonly affectedRows: number | undefined;
  readonly driverResult: DriverResult;
}
```

`driverResult` is the exact public Drizzle result by reference. The adapter does not copy, freeze, or reshape it.

The adapter recognizes `affectedRows` only from documented SQLite driver result paths:

- a top-level `changes` value;
- a top-level `rowsAffected` value; or
- a `meta.changes` value.

A normalized value must be a nonnegative safe integer. An absent, malformed, ambiguous, or unsupported result path produces `affectedRows: undefined`; it does not fail a command that already completed. Bun SQLite, SQL.js, Prisma SQLite, and future drivers can therefore execute commands without promising a count.

The normalized meaning is the number of rows directly changed by the statement as reported by the driver. It does not add trigger, foreign-key, replace, or other indirect effects unless the driver includes them in that documented count.

The adapter does not call `changes()`, inspect `lastInsertRowid`, parse the command, derive a count from another result, or enumerate a driver class.

## Operator semantics

The adapter exposes the base Store operator names. It uses SQLite expressions only when the resolved column encoding and collation preserve the selected-value contract. Otherwise it uses the shared JavaScript fallback.

- Native string ordering uses the active SQLite collation.
- Shared fallback string ordering uses JavaScript relational order.
- Native equality uses the resolved storage encoding and SQLite affinity behavior.
- JSON, nested paths, BLOB values, or custom conversions use native operations only when the resolved contract preserves the base observable result.
- Unsupported input-dependent native cases fall back when safe or reject with `UnsupportedStoreOperationError`.

The conformance profile states native versus fallback behavior, collation, equal-value ordering, and configured limits. Store values expose no runtime profile.

## Collection behavior

### Find

`find` validates options and expression ownership before database work. A native path selects through Drizzle and validates returned fields. A fallback path fetches the fields required by filtering, ordering, and projection.

A complete result rejects unknown top-level fields. A projection rejects unselected fields. Defined values pass their effective Select Field Schemas and remain JSON-compatible. Omitted parsed values do not appear as own properties.

### Count

`count` uses a native SQLite count only when the predicate preserves selected-value semantics. Otherwise it uses the same safe candidate path as fallback `find`. It returns a nonnegative safe integer.

### Create

`create` performs these steps:

1. run the definition's `beforeCreate` hook;
2. shallow-merge the hook patch over the draft;
3. validate strict create fields;
4. omit canonical create outputs that are `undefined`;
5. encode defined values through the resolved SQLite columns;
6. issue one Drizzle `insert(...).returning(identity)` call;
7. require exactly one returned identity;
8. select the complete stored row by that identity; and
9. decode and validate every selected field.

A defined host or hook value is never overwritten by a default or generated rule. Generated columns reject explicit values. SQLite defaults and ROWID generation fill only omitted fields.

The readback occurs after the insert statement finishes. It therefore observes ordinary defaults, ROWID generation, generated columns, affinity conversion, rounding, and completed non-identity `AFTER` trigger changes.

If identity or readback is missing, malformed, or invalid after the write, the adapter reports a contract defect with `writesMayRemain: true`. It does not attempt cleanup outside a caller transaction.

### Update

The portable path processes candidates one at a time:

1. select matching data, the private identity, and every raw physical field value;
2. parse the fields used by the predicate and update expressions;
3. evaluate expressions against the pre-update selected Record;
4. validate and encode every changed candidate field;
5. issue one guarded Drizzle update with `RETURNING` for the post-update identity;
6. require exactly one returned identity;
7. select the complete stored row by that identity; and
8. decode and validate every selected field.

The guard combines the selected identity with `IS` comparisons for every observed raw field value. It detects a changed or deleted candidate between selection and mutation without needing a SQLite row-version field.

A zero-row result reports a concurrent candidate failure. The first failure starts no later candidate write. Earlier base writes can remain. Complete success returns the exact number of updated Records.

### Delete

Delete selects the same candidate identity and raw guard values, then issues guarded deletes one at a time with `RETURNING` for the identity. Each delete must return exactly one identity. A zero-row result reports a concurrent candidate failure.

The first failure starts no later delete. Earlier base deletes can remain. Complete success returns the exact number of deleted Records.

### Trigger identity rule

A host `AFTER` trigger can change non-identity fields. Create and update readback returns and validates those stored values.

A host trigger must not change a declared primary key or selected ROWID identity during a Store write. Such a change makes exact readback impossible. A missing readback after a successful write is an adapter contract failure with `writesMayRemain: true`.

SQLite behavior that is undefined for a self-modifying `BEFORE` trigger is outside this contract.

### Root operations on a Transaction Store

A Store bound with `transaction: true` still gives root Collection calls the base Store guarantee. Callers that require operation-wide rollback group work inside `store.transaction`.

## Transaction behavior

The public `transaction` method delegates once to the accepted Drizzle transaction API without requiring a behavior option. SQLite remains serializable when `read_uncommitted` is disabled. A deferred transaction can fail with `SQLITE_BUSY` or `SQLITE_BUSY_SNAPSHOT`; this is a conflict result, not a reason to rerun callback work.

The shared transaction callback runner closes the View, tracks and drains active Store work, and selects failure priority. The callback View contains:

- the same Collections;
- `query` bound to the transaction database;
- `execute` bound to the transaction database; and
- every other safe capability declared by the concrete Store.

The View has no nested `transaction` method. Later calls after closure reject without driver work. Active calls drain before commit or rollback.

The adapter never retries the callback. A transaction implementation that retries internally is incompatible with this contract and must fail binding when the probe can observe that defect.

## SQLite conflict mapping

The adapter walks structured error causes without parsing localized text. It recognizes numeric SQLite result codes by their low byte and documented extended `BUSY` codes, including:

- `SQLITE_BUSY` (`5`);
- `SQLITE_BUSY_RECOVERY` (`261`);
- `SQLITE_BUSY_SNAPSHOT` (`517`); and
- `SQLITE_BUSY_TIMEOUT` (`773`).

It can also accept the equivalent exact structured string codes when a driver supplies them in a documented code property.

A recognized `BUSY` failure inside the public transaction boundary becomes `TransactionConflictError`. The error keeps the original cause and reports whether writes can remain under the shared transaction rules. `SQLITE_LOCKED`, message-only failures, validation failures, and unrelated driver failures remain their normal typed Store errors.

The adapter performs no retry, backoff, busy-timeout change, or journal-mode change.

## Error behavior

- Definition and identity failures use the shared Drizzle definition error and stable issue ordering.
- Binding failures use `DrizzleSqliteBindingError`.
- Invalid Statements and parameters use `SqlStatementError` with operation `query` or `execute`.
- Driver failures use `SqlExecutionError` with the matching operation and exact `executionMayHaveOccurred` value.
- Invalid successful row results use `StoreAdapterContractError` with `invalid-sql-result`.
- Invalid database-returned Records use `StoreAdapterContractError` with `invalid-selected-record`.
- A guarded candidate miss uses `StoreAdapterError`; `writesMayRemain` is true only when an earlier candidate write or the failed write can remain.
- Recognized transaction `BUSY` failures use `TransactionConflictError`.
- Rollback failures use the shared transaction rollback error and preserve both failures.

Safe errors contain no SQL text, parameters, row values, credentials, connection strings, or driver result objects. Causes are not safe default telemetry.

## Conformance

The SQLite adapter runs the shared Store, SQL Store, and optional SQL Transaction Store suites. Its focused suite also covers:

1. the common `BaseSQLiteDatabase` input type without a driver-class union;
2. synchronous and asynchronous base Store paths;
3. SQLite 3.45 acceptance, older-version rejection, malformed rows, and unsafe version components;
4. invalid database values and failed version probes;
5. `query()` using one `all()` call and `execute()` using one `run()` call;
6. exact Statement segments, `?` placeholders, identifier quoting, and boolean conversion;
7. generic unchecked row inference;
8. affected-row normalization from exactly one unambiguous `changes`, `rowsAffected`, or `meta.changes` path;
9. unavailable, malformed, and ambiguous affected-row metadata;
10. exact `driverResult` identity;
11. declared single and composite primary keys;
12. each available ROWID alias and all-alias shadowing rejection;
13. guarded update and delete with observed raw values;
14. a candidate conflict before any write and after an earlier write;
15. create and update readback after defaults, generation, conversion, and non-identity trigger changes;
16. identity-changing trigger failure reporting;
17. sequential candidate work and exact complete-success counts;
18. omitted and false transaction options making no transaction probe;
19. a valid asynchronous transaction probe;
20. synchronous, early-commit, `read_uncommitted`, `journal_mode=off`, and unknown journal-mode rejection;
21. root and View SQL methods using the correct database;
22. closed Views and active-work draining through the shared transaction callback runner;
23. structured current and future extended `BUSY` mapping without message parsing; and
24. one callback invocation with no retry.

The compile-tested prototype is `packages/store/prototypes/drizzle-sqlite-store-adapter.prototype.ts`. It proves the public generic result type, common sync/async database shape, SQL method dispatch, metadata normalization, identity selection and guarding, stored-value readback, transaction liveness probe, and structured conflict mapping without adding a production Drizzle dependency.

## Approval examples

### Base Store on a synchronous driver

```ts
const store = await bindSqliteStore({
  definition,
  database: betterSqliteDatabase,
});

const rows = await store.query<{ readonly id: number }>(sql`SELECT id FROM jobs`);

const result = await store.execute(sql`UPDATE jobs SET state = ${"ready"}`);

result.affectedRows;
result.driverResult;
// store.transaction does not exist
```

### Requested transaction on an asynchronous driver

```ts
const store = await bindSqliteStore({
  definition,
  database: d1Database,
  transaction: true,
});

await store.transaction(async (transaction) => {
  await transaction.collections.jobs.create(job);
  await transaction.execute(sql`DELETE FROM staging_jobs`);
});
```

A synchronous Drizzle database can still provide the base Store, but the same literal transaction request rejects binding.

## Residual risks

- The host can supply a Drizzle schema that does not match the live schema. Binding does not inspect it.
- A future driver can preserve the common type while changing runtime result behavior. The applicable probe or operation then rejects.
- A driver that reports only message text cannot receive structured `BUSY` conflict mapping.
- A driver can omit affected-row metadata. `affectedRows` then remains `undefined`.
- A host trigger can change Store identity after `RETURNING`. The write can remain even though readback rejects.
- A concurrent write after a successful mutation and before readback can change the row observed by readback.
- Manual transaction SQL through `query` or `execute` can break transaction guarantees because the adapter does not parse SQL.
- A transaction operation that never settles keeps the transaction pending. Portable Store cannot cancel it safely.

## References

- [ADR 0019: Build Thread Store on generic Store primitives](../adr/0019-build-thread-store-on-generic-store-primitives.md)
- [Store Architecture Technical Specification](store.md)
- [SQL Store Tier Technical Specification](sql-store.md)
- [Drizzle Store Technical Specification](drizzle-store.md)
- [Drizzle SQLite database API](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/sqlite-core/db.ts)
- [Drizzle SQLite transaction API](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/sqlite-core/session.ts)
- [Drizzle SQLite drivers](https://github.com/drizzle-team/drizzle-orm/tree/main/drizzle-orm/src)
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite isolation](https://www.sqlite.org/isolation.html)
- [SQLite RETURNING](https://www.sqlite.org/lang_returning.html)
- [SQLite PRAGMA statements](https://www.sqlite.org/pragma.html)
- [SQLite result codes](https://www.sqlite.org/rescode.html)
- [Cloudflare D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- [Approved issue #18 decisions](https://github.com/spiritledsoftware/commissary/issues/18)
