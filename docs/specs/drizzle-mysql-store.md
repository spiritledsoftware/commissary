# Drizzle MySQL Store Adapter Technical Specification

> **Status**: Design approved for implementation.
>
> **Last updated**: 2026-08-07 during Drizzle SQLite Store adapter approval.

## Summary

`@commissary/drizzle` binds one connection-free `DrizzleMysqlStore` definition to an existing host-owned Drizzle MySQL database. One public `bindMysqlStore` function returns `SqlStore` by default and adds `TransactionStore` only when the caller requests it. Every binding proves an actual MySQL 8.4-or-later server, a real serializable Drizzle transaction path, and InnoDB storage for every Store table.

MySQL has no full `RETURNING` clause. Root Collection mutations therefore run in one private serializable transaction and recover generated values through a safe candidate key before they commit. A declared primary key is preferred. A simple non-null Drizzle unique key or intrinsic `SERIAL` unique key can provide private adapter identity. A table without a safe key remains valid, but an operation that needs exact identity rejects instead of selecting a possible wrong row.

This specification extends:

- the [Store architecture specification](store.md);
- the [SQL Store tier specification](sql-store.md); and
- the [shared Drizzle Store specification](drizzle-store.md).

Those specifications remain authoritative except where this document gives a later MySQL adapter rule.

## Source authority

The Drizzle source authority is commit `b7862528fd8fc39bc2653a6c18dad7c1f4e68d10`. The approved database target is Oracle MySQL 8.4 and later. MariaDB, TiDB, Vitess, PlanetScale, and other MySQL-compatible engines are not part of this adapter contract.

## Goals

- Bind an existing Drizzle MySQL database without taking ownership of it.
- Use one public binder over the common public Drizzle MySQL database shape.
- Preserve the approved Store, SQL Store, and optional Transaction Store contracts.
- Translate opaque Commissary SQL Statements into public Drizzle SQL values without parsing placeholder text.
- Verify that every Store table uses InnoDB before a Store exists.
- Recover and validate MySQL-generated values without best-effort row selection.
- Support supplied and generated Drizzle tables, including read-capable tables without a safe candidate key.
- Keep `query` and `execute` available inside a requested Transaction View.
- Give Core either a plain or transactional Store backend without a MySQL-specific Thread Store binder.

## Non-goals

- Create, configure, close, or replace a database client or pool.
- Execute DDL, migrations, schema diffing, or general live table introspection.
- Support MariaDB, TiDB, Vitess, PlanetScale, or another MySQL-compatible engine under an Oracle MySQL guarantee.
- Export driver-specific binders or access a native client result outside the public Drizzle return value.
- Add a MySQL-named runtime Store tier or MySQL-specific Thread Store binder.
- Add preparation, streaming, batching, cancellation, local infile, session locks, or ordered multiple results.
- Generate host indexes other than the approved portable primary key.
- Infer a key through full-table comparison or return a best-effort created row.
- Configure or police the time zone of host-owned connections.

## Invariants

1. **One binder**: MySQL exports one `bindMysqlStore` function.
2. **Public Drizzle APIs only**: Definition, binding, CRUD, SQL execution, and transactions use public Drizzle APIs. They do not access a native client or driver session.
3. **Real MySQL**: Every binding proves a supported Oracle MySQL version and rejects compatible engines outside this contract.
4. **Transactional tables**: Every effective Store table must exist as an InnoDB base table before binding succeeds.
5. **Verified transaction path**: Every binding proves that Drizzle starts one read-only serializable transaction with the requested effective settings.
6. **Base capability honesty**: Omitted or false `transaction` returns no public `transaction` method, even though root mutations use private transactions.
7. **Requested transaction**: Literal true adds `TransactionStore` and keeps `query` and `execute` in its callback view.
8. **Host lifetime**: Binding never creates, configures, or closes the supplied database or its resources.
9. **Host UTC policy**: The host keeps every possible connection in UTC when it uses `TIMESTAMP` columns.
10. **Exact Statement structure**: SQL execution combines compiler `segments` with bound parameters. It never parses `?` or other placeholder-like text.
11. **One execution call**: One `query` or `execute` call makes at most one `database.execute` call and performs no retry.
12. **Portable result split**: `query` returns one row array. `execute` returns normalized `affectedRows` plus the exact public Drizzle result.
13. **One root mutation transaction**: One root `create`, `update`, or `delete` uses one private serializable transaction.
14. **Exact readback**: A write that needs a returned Record commits only after exact key-based readback and selected-record validation.
15. **No guessed identity**: Full-field matching and table-difference scans never stand in for a missing candidate key.
16. **Host-owned indexes**: The adapter never invents a non-primary index.
17. **Physical transaction sharing**: Collection and SQL work in a public transaction callback use the same Drizzle transaction database.
18. **No hidden callback retry**: The adapter invokes a public transaction callback at most once.
19. **Write uncertainty is explicit**: Every failed Store operation states whether writes can remain.

## Definition and table construction

The shared constructor remains connection-free:

```ts
const definition = DrizzleMysqlStore.define({
  schemas,
  records,
  overrides,
  relations,
  hooks,
});
```

A generated table uses the resolved MySQL database qualifier, table name, columns, defaults, generation, automatic increment, automatic update, nullability, and portable primary key. An unqualified table uses `mysqlTable`. A qualified table uses the matching public MySQL schema factory. A supplied table must agree with explicit lower-tier MySQL metadata.

Resolved direct and custom column codecs map through public MySQL column builders or `customType`. A parameter-free type, default, or generated Statement converts through the same Statement-segment path as runtime SQL. Definition never parses trusted raw SQL structure.

### Primary and unique keys

A lower-tier portable primary key remains a nonempty ordered tuple of logical field names. Generated tables emit it. A supplied Drizzle table contributes its column-level or table-level primary key. Both declarations must agree when both exist.

Binding keeps one private candidate-key plan for each table:

1. the portable or supplied primary key;
2. the intrinsic unique key from `SERIAL`; or
3. the first simple supplied Drizzle unique constraint or unique index whose complete columns are non-null.

A qualifying unique key contains only complete table columns. It contains no SQL expressions, prefixes, nullable columns, or partial-column ambiguity. Drizzle table-configuration declaration order breaks ties. The key remains private adapter state and creates no Store field or public identity value.

### Automatic-increment index proof

A non-`SERIAL` `AUTO_INCREMENT` column must start one declared index:

- a portable primary key can prove the rule for a generated table; or
- a primary, unique, or ordinary index on a supplied Drizzle table can prove it.

`SERIAL` proves the rule through its intrinsic unique key. The adapter does not generate another index and does not accept an undeclared live index as a substitute. A missing index is a definition error.

## Accepted database type

The binder accepts the common public Drizzle MySQL database contract used by `MySqlDatabase`. It does not enumerate mysql2, PlanetScale, TiDB, proxy, Prisma, or future driver classes in its public API.

A database is accepted only when public Drizzle operations prove all of these facts:

1. one valid Oracle MySQL version at or above 8.4;
2. one active read-only serializable transaction with autocommit disabled;
3. one current database when any effective table is unqualified;
4. one existing base table for every effective Record; and
5. InnoDB as the storage engine for every effective table.

A wrong engine, unsupported Drizzle transaction implementation, disabled transaction instrumentation, missing Performance Schema access, missing table, view, non-InnoDB table, malformed result, failed connection, or unsupported version rejects binding before a Store exists.

## Public binding API

The rough public shape is:

```ts
type DrizzleMysqlDriverResult<Database extends MySqlDatabase> = Awaited<
  ReturnType<Database["execute"]>
>;

export declare function bindMysqlStore<
  const Definition extends DrizzleMysqlStoreDefinition,
  const Database extends MySqlDatabase,
  const Transaction extends boolean = false,
>(options: {
  readonly definition: Definition;
  readonly database: Database;
  readonly transaction?: Transaction;
}): Promise<
  BoundDrizzleMysqlSqlStore<Definition, Database> &
    (Transaction extends true
      ? TransactionStore<
          DefinitionsOf<Definition>,
          OperatorsOf<Definition>,
          Pick<BoundDrizzleMysqlSqlStore<Definition, Database>, "query" | "execute">,
          CreateInputsOf<Definition>
        >
      : {})
>;
```

`BoundDrizzleMysqlSqlStore` is an explanatory type, not a MySQL-named primitive Store tier. The concrete function can expose its structural return type directly.

Omitted or false `transaction` still runs the binding transaction probe because private root mutations require that path. It returns no public `transaction` method. Literal true exposes the already-proved physical transaction path and keeps `query` and `execute` on the callback view.

The return type preserves the supplied definition, operator, create-input, database, and public Drizzle command-result types. Binding returns a native Promise before probe work starts.

## Binding probes

### Server probe

Every binding performs one public Drizzle execution equivalent to:

```sql
SELECT
  VERSION() AS version,
  @@version_comment AS version_comment,
  DATABASE() AS current_database
```

The adapter requires exactly one object row. It accepts a recognized Oracle MySQL version form at or above 8.4 and rejects MariaDB, TiDB, Vitess, PlanetScale, Percona, and other non-Oracle engine markers. An unrecognized version or comment is unsupported rather than guessed.

`current_database` can be `null` only when every effective table has an explicit database qualifier.

### Transaction probe

Every binding delegates once to the public Drizzle transaction API with:

```ts
{
  isolationLevel: "serializable",
  accessMode: "read only",
}
```

Inside that transaction it executes:

```sql
SELECT
  STATE AS state,
  ACCESS_MODE AS access_mode,
  ISOLATION_LEVEL AS isolation_level,
  AUTOCOMMIT AS autocommit
FROM performance_schema.events_transactions_current
WHERE THREAD_ID = PS_CURRENT_THREAD_ID()
  AND END_EVENT_ID IS NULL
```

The normalized result must contain exactly one object row with `ACTIVE`, `READ ONLY`, `SERIALIZABLE`, and `NO`. Successful acceptance of a Drizzle options object is not sufficient. This rejects Drizzle paths that ignore transaction options or do not expose a real transaction.

Performance Schema transaction instrumentation and its current-event consumer are host server requirements. The adapter does not enable them.

### Table-engine probe

Binding resolves every table to an exact database and table-name pair, then performs one parameterized `information_schema.TABLES` query. It requires exactly one matching row per effective Record with:

- `TABLE_TYPE = 'BASE TABLE'`; and
- `ENGINE = 'InnoDB'`.

This is the only live table-structure exception to the shared no-introspection rule. Binding does not inspect columns, defaults, indexes, constraints, foreign keys, migrations, row counts, collations, or generated expressions.

## Binding errors

Binding rejects with one adapter-owned error before a Store value exists:

```ts
export type DrizzleMysqlBindingErrorReason =
  | "invalid-database"
  | "probe-failed"
  | "invalid-version-result"
  | "unsupported-mysql-version"
  | "unsupported-mysql-engine"
  | "current-database-required"
  | "transaction-unavailable"
  | "invalid-transaction-result"
  | "invalid-table-result"
  | "table-unavailable"
  | "unsupported-storage-engine";

export declare class DrizzleMysqlBindingError extends Error {
  readonly name: "DrizzleMysqlBindingError";
  readonly reason: DrizzleMysqlBindingErrorReason;
  readonly cause?: unknown;
}
```

Messages, table names, version comments, and causes can contain application or database data and are not safe default telemetry. Binding errors contain no credentials, connection strings, query text, or result rows in safe metadata.

## Host connection contract

The host owns the Drizzle database, pool, connection initialization, SQL modes, character sets, collations, limits, and time-zone policy.

For a resolved MySQL `TIMESTAMP` column, the host must configure `@@session.time_zone` as UTC on every connection that the supplied database can use and keep it in UTC. The adapter uses the ordinary Drizzle timestamp path. It does not mutate sessions, reserve connections, wrap timestamp columns in conversion functions, or claim that one connection probe proves a pool-wide setting.

Mixed or non-UTC connection time zones are outside the adapter contract. `date`, `datetime`, `time`, and `year` keep the approved timezone-free meanings.

## SQL Statement translation

The adapter calls `compileSqlStatement` with MySQL rules:

- identifiers use backtick escaping and double an embedded backtick;
- every placeholder in compiled `text` is `?`;
- direct parameters accept the portable `SqlParameterValue` union;
- boolean becomes `1` or `0`;
- negative zero becomes zero; and
- strings containing NUL and non-finite numbers reject before Drizzle work.

The adapter reconstructs one public Drizzle SQL value from exact segments:

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

The adapter never splits `compiled.text`. Caller-authored raw `?`, `$1`, or `:name` text stays inside its original segment. Parameters remain parameters.

`query` and `execute` use the root database outside a public transaction and the transaction callback database inside one. Each Store method makes one public `database.execute` call.

## SQL result normalization

`query<Row>()` recognizes:

1. a mysql2-style tuple whose first item is one row array and whose second item is field metadata; and
2. a result object with an array-valued `rows` property.

The adapter returns the recognized row array without copying or freezing it. A nested set of row arrays is a multiple-result response and rejects with the approved `multiple-results` error. Another successful shape is an invalid SQL result contract defect.

`execute()` recognizes one mutation header in the public result. It returns `SqlCommandResult<DrizzleMysqlDriverResult<Database>>`:

- `driverResult` is the exact public Drizzle result by reference; and
- `affectedRows` comes only from a recognized `affectedRows` or `rowsAffected` property that is a nonnegative safe integer.

A missing or invalid count becomes `undefined`. The adapter never derives it from row length, insertion ID, warning count, or changed-row count. Insertion IDs, field packets, warnings, and other public facts remain available only through the typed `driverResult`.

A nested set of result headers is a multiple-result response and rejects. The adapter does not select or combine one result.

## Operator semantics

The adapter exposes the base Store operator names. It uses MySQL expressions only when the resolved column encoding preserves the selected-value contract. Otherwise it uses a shared JavaScript fallback inside the active mutation transaction or reports `UnsupportedStoreOperationError` when no safe path exists.

- Native string comparison and ordering use the active MySQL collation.
- Shared fallback string ordering uses JavaScript relational order.
- Native equality uses resolved physical values and MySQL null rules.
- JSON structural equality, nested paths, binary encodings, and custom conversions use a native path only when it preserves the approved selected-value behavior.
- An input-dependent native limitation falls back when safe or rejects with a stable feature.

The adapter conformance profile states native versus fallback behavior, collation, equal-value ordering, and configured `inArray` or unbounded-find limits. Store values expose no runtime profile.

## Collection behavior

### Find and count

`find` validates options and expression ownership before database work. A native path selects through Drizzle and validates every returned selected field. A fallback path fetches only the fields required by filtering, ordering, and projection when safe. Complete results reject unknown top-level fields; projections reject unselected fields.

`count` uses a native MySQL count only when the predicate preserves selected-value semantics. Otherwise it uses the same safe matching path as fallback `find`. It returns a nonnegative safe integer.

### Root mutation boundary

One root `create`, `update`, or `delete` delegates once to the proved Drizzle transaction path at serializable isolation. Candidate selection, locking, validation, writes, readback, and final selected-record validation remain inside that transaction.

Any failure rolls back the complete Collection operation. Successful rollback preserves the selected failure and reports `writesMayRemain: false`. Rollback failure or uncertain commit uses the approved transaction errors with `writesMayRemain: true`.

A mutation called through a public Transaction View reuses that transaction database and does not start a nested transaction. The stronger root behavior does not widen the portable base Store guarantee.

### Create

`create`:

1. runs the definition's `beforeCreate` hook;
2. shallow-merges the hook patch over the draft;
3. validates strict create fields;
4. omits canonical `undefined` fields;
5. encodes defined values through resolved columns;
6. proves that one candidate key is explicit, generated by a known client-side rule, or exactly recoverable from automatic increment;
7. inserts one row through Drizzle;
8. recovers an omitted automatic-increment value on the same transaction connection as exact decimal text;
9. selects exactly one row by the complete candidate key; and
10. decodes and validates every selected field before commit.

A database-generated candidate-key value that the adapter cannot recover exactly rejects before insertion. The adapter never uses unique-field guessing, full-field matching, or a later independent connection.

A defined host or hook value is never overwritten by a default, automatic increment, generated expression, or automatic update. Defaults and generated values fill only omitted fields. Missing, duplicate, unknown, or invalid readback is a contract defect and rolls back.

### Update

`update` selects matching complete Records and candidate keys under locking reads in the active serializable transaction. It evaluates every expression against the pre-update selected Record and validates every complete changed Record before its write.

A safe native bulk path can replace repeated writes only when it preserves the same selected-value and readback behavior. Otherwise the adapter writes candidates in stable selected order. The locked candidate key guards each write. If an update changes a key, readback uses the validated new key. Automatic-update, padding, rounding, defaults, and generated values come from the stored row and pass decoding and Select validation before commit.

An update that lacks a safe candidate key rejects before its first write with `UnsupportedStoreOperationError`. Complete success returns the exact number of selected candidates.

### Delete

`delete` selects and validates its matching set inside the active transaction. A safe native delete can remove a keyless selected set when the native predicate proves the exact same set. A fallback or per-candidate delete requires a candidate key. A key guard must affect exactly one row.

Complete success returns the exact selected candidate count. Failure rolls back the complete root operation or the surrounding public transaction.

## Transaction behavior

The public transaction method delegates once to Drizzle with serializable isolation. It uses the shared transaction callback runner to close the View, track and drain active work, record caught operation failures, and select callback failure priority.

The callback view contains:

- the same Collections and operator semantics;
- `query` and `execute` bound to the same Drizzle transaction database; and
- no `transaction` method.

Collection and SQL calls therefore share one physical transaction.

### Caller-owned SQL boundary

The adapter does not parse or police SQL. Transaction guarantees apply only while callback SQL stays inside MySQL transactional behavior. These inputs are unsupported caller behavior:

- manual transaction-control SQL;
- DDL or another statement that causes an implicit commit; and
- reads or writes against a nontransactional object.

Binding proves InnoDB only for the Store catalog. Direct SQL can address other objects, and the caller owns those objects and statements.

### Conflict mapping

The adapter walks structured Drizzle causes without matching message text:

- MySQL error `1213` or SQLSTATE `40001` maps to `TransactionConflictError`;
- MySQL error `1205` maps to `TransactionConflictError` after successful rollback; and
- other start, callback, commit, and rollback failures use the approved Store transaction rules.

The adapter never reruns the public callback. Core can start a new storage-only transaction under its existing three-attempt limit. Failed rollback creates `TransactionRollbackError` with `writesMayRemain: true`.

## Core composition

The MySQL adapter returns a generic backend and no MySQL-specific Thread Store:

```ts
const backend = await bindMysqlStore({
  definition: threadDefinition,
  database,
});

const threadStore = createThreadStore({ backend });
```

The plain backend gives Core one serialized attempt for each transition. Private per-Collection transactions do not make a multi-Collection Core transition atomic.

A requested transactional backend preserves the strong Core path:

```ts
const backend = await bindMysqlStore({
  definition: threadDefinition,
  database,
  transaction: true,
});

const threadStore = createThreadStore({ backend });
```

Core then uses serializable transactions, conflict reporting, bounded storage retry, and rollback.

## Operation errors

- Caller query, create, and update validation uses `StoreValidationError`.
- Hook failures use `StoreHookError`.
- Missing safe candidate identity and other input-dependent unavailable behavior use `UnsupportedStoreOperationError`.
- Drizzle and MySQL operation failures use `StoreAdapterError` with the original cause.
- Invalid decoded, generated, returned, or compiled adapter data uses `StoreAdapterContractError`.
- Direct SQL Statement and execution failures use the SQL Store error contract.
- Transaction conflicts and rollback use the Transaction Store error contract.

Every expected Store error and adapter contract defect reports `writesMayRemain`. Messages and causes can contain application or database data and are not safe default telemetry. The adapter does not add SQL text, parameters, credentials, complete inputs, Records, version comments, or table names to safe error metadata.

## Conformance

The adapter runs:

- Store conformance for the base binder;
- SQL Statement and SQL Store conformance;
- Transaction Store conformance when `transaction: true`; and
- combined SQL and Collection transaction conformance when `transaction: true`.

MySQL-specific scenarios cover:

1. Oracle MySQL 8.4 acceptance and older-version rejection;
2. rejection of MariaDB, TiDB, Vitess, PlanetScale, and unknown engine markers;
3. a successful active read-only serializable transaction probe;
4. rejection when Drizzle accepts but ignores transaction options;
5. disabled or unavailable Performance Schema transaction evidence;
6. current-database resolution for qualified and unqualified tables;
7. missing, view, and non-InnoDB table rejection;
8. generated and supplied table agreement;
9. primary, `SERIAL`, and simple non-null unique candidate keys;
10. nullable, expression, prefix, and otherwise ambiguous unique-key rejection;
11. host-owned automatic-increment index proof;
12. Statement segments containing raw `?`, `$1`, and `:name` text;
13. public Drizzle SQL reconstruction with bound parameters in source order;
14. mysql2 tuple and object query result normalization;
15. multiple-result rejection;
16. exact driver-result preservation and verified `affectedRows`;
17. explicit, client-generated, and automatic-increment create-key readback;
18. pre-insert rejection of an unrecoverable generated key;
19. default, generated, rounded, padded, and automatic-update readback;
20. no host-value overwrite;
21. one private serializable transaction per root mutation;
22. complete root-operation rollback;
23. safe keyless native delete and unsupported identity-dependent paths;
24. `query`, `execute`, and Collections sharing one public transaction;
25. closed views, drained work, and caught operation failure;
26. MySQL `1213`, SQLSTATE `40001`, and error `1205` conflict mapping;
27. rollback failure and commit uncertainty; and
28. Core composition over plain and transactional backends.

The compile-tested prototype proves the binder return types, active-setting and InnoDB probes, exact Statement reconstruction, result normalization, candidate-key preference, one root mutation transaction, full transaction capabilities, and structured conflict recognition without adding a production Drizzle dependency.

## Approval examples

### Base Store

```ts
const store = await bindMysqlStore({ definition, database });

await store.collections.job.update({
  where: (fields, op) => op.eq(fields.status, "ready"),
  set: { status: "running" },
});
```

The root update uses one private serializable transaction, but `store` has no public `transaction` method.

### Requested transaction

```ts
const store = await bindMysqlStore({
  definition,
  database,
  transaction: true,
});

await store.transaction(async (transaction) => {
  await transaction.collections.job.update({
    where: (fields, op) => op.eq(fields.id, jobId),
    set: { status: "done" },
  });

  await transaction.execute(
    sql`INSERT INTO ${definition.records.auditEvent} (${definition.records.auditEvent.fields.kind}) VALUES (${"job-done"})`,
  );
});
```

Both calls share the same physical MySQL transaction when the direct SQL stays inside the supported transactional boundary.

## References

- [Issue #24](https://github.com/spiritledsoftware/commissary/issues/24)
- [Drizzle research decision](https://github.com/spiritledsoftware/commissary/issues/26#issuecomment-5166874940)
- [Drizzle MySQL database API](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-core/db.ts)
- [Drizzle MySQL transaction API](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-core/session.ts)
- [Drizzle mysql2 transaction implementation](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql2/session.ts)
- [Drizzle MySQL table metadata](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-core/utils.ts)
- [MySQL 8.4 transaction characteristics](https://dev.mysql.com/doc/refman/8.4/en/set-transaction.html)
- [MySQL 8.4 current transaction metadata](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-events-transactions-current-table.html)
- [MySQL 8.4 table metadata](https://dev.mysql.com/doc/refman/8.4/en/information-schema-tables-table.html)
- [Better Auth Drizzle adapter comparison](https://github.com/better-auth/better-auth/blob/main/packages/drizzle-adapter/src/drizzle-adapter.ts)
