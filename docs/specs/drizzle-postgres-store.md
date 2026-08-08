# Drizzle PostgreSQL Store Adapter Technical Specification

> **Status**: Design approved for implementation.
>
> **Last updated**: 2026-08-07 during Drizzle SQLite Store adapter approval.

## Summary

`@commissary/drizzle` binds one connection-free `DrizzlePostgresStore` definition to an existing host-owned Drizzle PostgreSQL database. One public `bindPostgresStore` function returns `SqlStore` by default and adds `TransactionStore` only when the caller requests and the database proves a real serializable transaction path.

The adapter uses public Drizzle SQL, query-builder, and transaction APIs. It does not switch on driver classes, access native clients, create a client, or own client lifetime. Every Drizzle PostgreSQL database that preserves the common API and passes binding probes can provide the base Store.

Base mutations validate each candidate before its write and can partly complete. A Transaction Store callback adds rollback and serializable overlap. A declared SQL or Drizzle primary key identifies a row when available. A table without a primary key remains valid and uses a private PostgreSQL row-version token during fallback mutations.

This specification extends:

- the [Store architecture specification](store.md);
- the [SQL Store tier specification](sql-store.md); and
- the [shared Drizzle Store specification](drizzle-store.md).

Those specifications remain authoritative except where this document gives a later PostgreSQL adapter rule.

## Source authority

The Drizzle source authority is the latest `main` branch. The approved PostgreSQL target is PostgreSQL 15 and later.

## Goals

- Bind an existing Drizzle PostgreSQL database without taking ownership of it.
- Use one public binder for every accepted Drizzle PostgreSQL database.
- Preserve the approved Store, SQL Store, and optional Transaction Store contracts.
- Translate opaque Commissary SQL Statements into public Drizzle SQL values without parsing placeholder text.
- Support supplied and generated Drizzle tables, including tables without primary keys.
- Return generated database values through PostgreSQL `RETURNING`.
- Return unchecked query rows and normalize only a verified command affected-row count while preserving the public Drizzle result.
- Give Core either a plain or transactional Store backend without a PostgreSQL-specific Thread Store binder.

## Non-goals

- Create, configure, close, or replace a database client or pool.
- Execute DDL, migrations, schema diffing, or live table introspection.
- Export driver-specific binders or access a native client result outside the public Drizzle return value.
- Promise transactions when a common Drizzle database exposes a method that throws at runtime.
- Add a PostgreSQL-named runtime Store tier.
- Add a PostgreSQL-specific Thread Store binder.
- Add preparation, streaming, batching, cancellation, notifications, copy streams, portals, or session reservation.
- Add an `id` field or require every SQL table to have a primary key.

## Invariants

1. **One binder**: PostgreSQL exports one `bindPostgresStore` function.
2. **Public Drizzle APIs only**: Binding and Store operations use Drizzle SQL, query-builder, and transaction APIs. They do not access `$client` or driver sessions.
3. **Base first**: Omitted or false `transaction` returns a SQL Store without a `transaction` method.
4. **Requested transaction**: Literal true returns a SQL and Transaction Store only after a probe verifies that the server applied read-only serializable settings to the transaction.
5. **PostgreSQL 15**: Every binding proves `server_version_num >= 150000`.
6. **Host lifetime**: Binding never creates or closes the supplied database or its resources.
7. **Exact Statement structure**: SQL execution combines compiler `segments` with bound parameters. It never parses `$1` or other placeholder-like text.
8. **One execution call**: One `query` or `execute` call makes at most one `database.execute` call and performs no retry.
9. **Portable result split**: `query` returns one row array. `execute` returns normalized `affectedRows` plus the exact public Drizzle result.
10. **Candidate-safe fallback**: Each mutation candidate is identified and validated before its write.
11. **No silent overwrite**: A fallback write uses an observed PostgreSQL row version. A concurrent change causes failure instead of overwriting the changed row.
12. **Optional primary key**: Declared primary keys are preferred. Tables without primary keys use private PostgreSQL row identity.
13. **Success-only count**: Mutation affected counts are exact only after complete success.
14. **Physical transaction sharing**: Collection and SQL work in one transaction callback use the same Drizzle transaction database.
15. **No hidden callback retry**: The adapter invokes a transaction callback at most once.
16. **Generated values return**: Create returns and validates the complete inserted row from `RETURNING`.
17. **Write uncertainty is explicit**: Every failed Store operation states whether writes can remain.

## Definition and primary keys

The shared constructor remains connection-free:

```ts
const definition = DrizzlePostgresStore.define({
  schemas,
  records,
  overrides,
  relations,
  hooks,
});
```

A lower-tier SQL Record can declare a portable primary key:

```ts
const ScheduledJob = SqlRecord.define({
  table: sql.table({
    name: "scheduled_jobs",
    primaryKey: ["id"],
    postgres: pg.table({ schema: "jobs" }),
  }),
  fields: {
    id: jobIdField,
    status: statusField,
  },
});
```

The tuple contains logical Record field names. It is nonempty, ordered, duplicate-free, and resolves only to non-null columns. Composite keys are valid. Generated Drizzle tables emit the related primary-key constraint.

A direct Drizzle table contributes its declared column-level or table-level primary key. When a lower-tier primary key and supplied table are both present, their logical field order must match. A mismatch is a definition error. An omitted primary key is valid.

Primary-key data stays in hidden definition state used by binding. It does not add a Store field or a public identity object.

## Accepted database type

The binder accepts the common Drizzle PostgreSQL database contract used by `PgDatabase`. It does not enumerate node-postgres, postgres.js, Neon, Vercel, PGlite, Bun SQL, AWS Data API, Netlify, Xata, proxy, Prisma, or future driver classes in its public API.

A database is accepted for the base Store when:

1. its value is compatible with the supported Drizzle PostgreSQL database contract;
2. its public `execute` path completes the version probe;
3. the probe returns one valid PostgreSQL `server_version_num`; and
4. the version is PostgreSQL 15 or later.

A mock, wrong dialect, failed connection, permission failure, malformed result, or incompatible future implementation rejects binding before a Store exists.

## Public binding API

The rough public shape is:

```ts
type DrizzlePostgresDriverResult<Database extends PgDatabase> = Awaited<
  ReturnType<Database["execute"]>
>;

export declare function bindPostgresStore<
  const Definition extends DrizzlePostgresStoreDefinition,
  const Database extends PgDatabase,
  const Transaction extends boolean = false,
>(options: {
  readonly definition: Definition;
  readonly database: Database;
  readonly transaction?: Transaction;
}): Promise<
  BoundDrizzlePostgresSqlStore<Definition, Database> &
    (Transaction extends true
      ? TransactionStore<
          DefinitionsOf<Definition>,
          OperatorsOf<Definition>,
          Pick<BoundDrizzlePostgresSqlStore<Definition, Database>, "query" | "execute">,
          CreateInputsOf<Definition>
        >
      : {})
>;
```

`BoundDrizzlePostgresSqlStore` is an explanatory type in this specification, not a new database-named primitive Store tier. The concrete function can expose its structural return type directly.

Omitted or false `transaction` never calls `database.transaction` during binding and returns no transaction method. Literal true runs the transaction probe and keeps `query` and `execute` on the transaction callback view.

The return type preserves the supplied definition, operator, create-input, database, and public Drizzle command-result types. Binding returns a native Promise before any probe work starts.

## Binding probes

### Version probe

Every binding performs one public Drizzle execution equivalent to:

```sql
SHOW server_version_num
```

The adapter accepts the common object-row and array-row result containers described below. It requires exactly one row and a decimal version value that normalizes to a safe integer. A value below `150000` rejects as an unsupported version.

### Transaction probe

Only `transaction: true` performs a transaction probe equivalent to:

```ts
const settings = await database.transaction(
  async (transaction) =>
    normalizePostgresExecutionResult(
      await transaction.execute(drizzleSql`
        SELECT
          current_setting('transaction_isolation') AS transaction_isolation,
          current_setting('transaction_read_only') AS transaction_read_only
      `),
    ),
  {
    isolationLevel: "serializable",
    accessMode: "read only",
  },
);

requireSingleTransactionSettingsRow(settings, {
  transaction_isolation: "serializable",
  transaction_read_only: "on",
});
```

The probe must start and finish one real read-only serializable transaction. It queries the effective settings from inside that transaction and requires exactly one object row with the values shown above. Successful acceptance of the Drizzle transaction options is not sufficient. An inherited method that reports unsupported transactions, ignores the requested settings, returns a different setting, or returns an invalid result rejects binding. A probe failure never creates a weaker Store under the requested wider type.

Binding does not run write probes, inspect live tables, compare migrations, or prove host permissions beyond the read-only calls it performs.

## Binding errors

Binding rejects with one adapter-owned error before a Store value exists:

```ts
export type DrizzlePostgresBindingErrorReason =
  | "invalid-database"
  | "probe-failed"
  | "invalid-version-result"
  | "unsupported-postgres-version"
  | "transaction-unavailable";

export declare class DrizzlePostgresBindingError extends Error {
  readonly name: "DrizzlePostgresBindingError";
  readonly reason: DrizzlePostgresBindingErrorReason;
  readonly cause?: unknown;
}
```

`unsupported-postgres-version` can expose the normalized version number. Messages and causes are not safe default telemetry. Binding errors contain no credentials, connection strings, query text, or result rows.

## SQL Statement translation

The adapter calls `compileSqlStatement` with PostgreSQL rules:

- identifiers use double-quote escaping;
- placeholders in `text` are `$1`, `$2`, and later positions;
- direct parameters accept the portable `SqlParameterValue` union;
- boolean remains boolean;
- negative zero becomes zero; and
- strings containing NUL and non-finite numbers reject before Drizzle work.

The compiled value contains `text`, `parameters`, and exact `segments`. The adapter creates one public Drizzle SQL value:

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

The adapter never splits `compiled.text`. Caller-authored raw text such as `$1`, `?`, or `:name` remains exact unchecked structure inside its original segment. Parameters remain parameters.

`query` and `execute` pass the Drizzle SQL value to the active database's public `execute` method. At the root they use the supplied database. In a transaction callback they use the Drizzle transaction database. Each Store method makes one database call.

## SQL result normalization

`query<Row>()` recognizes two row result families:

1. an array-like row container, where the container is the rows; or
2. an object with an array-valued `rows` property.

The adapter returns the row container without copying or freezing it. A successful result without one recognized row array is `StoreAdapterContractError` with violation `invalid-sql-result`.

`execute()` returns `SqlCommandResult<DrizzlePostgresDriverResult<Database>>`:

- `driverResult` is the exact public Drizzle result by reference; and
- `affectedRows` is the result's `rowCount` only when it is a nonnegative safe integer, otherwise `undefined`.

The adapter does not derive `affectedRows` from query row length or another property. PostgreSQL `command`, field metadata, notices, and other facts remain available only through the typed `driverResult`.

```ts
const rows = await store.query<{ readonly id: string }>(statement);
rows[0]?.id;

const command = await store.execute(statement);
command.affectedRows;
command.driverResult;
```

## Operator semantics

The adapter exposes the base Store operator names. It uses PostgreSQL expressions only when the resolved column encoding preserves the selected-value contract for that operator. Otherwise it uses the shared JavaScript fallback.

- PostgreSQL string ordering uses the active database collation when native comparison or ordering is selected.
- Shared fallback string ordering uses JavaScript relational order.
- Native equality uses the resolved PostgreSQL column type and encoded value.
- JSON, nested paths, arrays, or custom conversions use native operations only when their resolved contract preserves the base observable result.
- Unsupported input-dependent native cases fall back when safe or reject with `UnsupportedStoreOperationError`.

The adapter conformance profile states native versus fallback behavior, collation, equal-value ordering, and any configured `inArray` or unbounded-find limits. Store values expose no runtime profile.

## Collection behavior

### Find

`find` validates options and expression ownership before database work. A native path selects through Drizzle and validates returned selected fields. A fallback path fetches only the fields required by filtering, ordering, and projection when Drizzle can express that projection safely.

A complete result rejects unknown top-level fields. A projection rejects unselected fields. Defined values pass their effective Select Field Schemas and remain JSON-compatible. Omitted parsed values do not appear as own properties.

### Count

`count` uses a native PostgreSQL count only when the predicate can preserve selected-value semantics. Otherwise it uses the same safe matching path as fallback `find` and counts validated matches. It returns a nonnegative safe integer.

### Create

`create` performs these steps:

1. run the definition's `beforeCreate` hook;
2. shallow-merge the hook patch over the draft;
3. validate strict create fields;
4. omit fields whose canonical create output is `undefined`;
5. encode defined values through resolved columns;
6. execute one Drizzle `insert(...).returning()` call;
7. require exactly one complete returned row; and
8. decode and validate every selected field.

A defined host or hook value is never overwritten by a database default, identity, or generated rule. A generated column or `GENERATED ALWAYS` identity rejects an explicit value when PostgreSQL cannot honor it. PostgreSQL defaults, identities, and stored generated columns fill only omitted fields.

If the final returned row is missing, has unknown fields, fails decoding, or fails Select validation, the adapter reports a contract defect with `writesMayRemain: true`. It does not attempt cleanup outside a caller transaction.

### Update

The portable path processes candidates one at a time:

1. select matching data plus a private row identity and version;
2. parse the fields used by the predicate and update expressions;
3. evaluate all expressions against the pre-update selected Record;
4. validate every field of the changed candidate;
5. issue one guarded Drizzle update with `RETURNING`;
6. require exactly one returned row; and
7. validate the returned selected Record.

The first failure starts no later candidate write. Because writes are sequential, no candidate write remains active when the method rejects. Earlier writes can remain. Complete success returns the exact number of updated Records.

### Delete

Delete identifies matching candidates and issues guarded deletes one at a time. A guarded delete must affect exactly one row. The first failure starts no later delete. Earlier deletes can remain. Complete success returns the exact number of deleted Records.

### Root operations on a Transaction Store

A Store bound with `transaction: true` still gives root Collection calls the base Store guarantee. Callers that require rollback group work inside `store.transaction`. The adapter can provide a stronger root implementation, but callers do not rely on it.

## PostgreSQL candidate identity

The adapter reads one of two private identity forms:

```ts
type DrizzlePostgresCandidateIdentity =
  | {
      readonly kind: "primary-key";
      readonly values: readonly unknown[];
      readonly xmin: string;
    }
  | {
      readonly kind: "physical-row";
      readonly tableOid: string;
      readonly tupleId: string;
      readonly xmin: string;
    };
```

### Declared primary key

A declared key uses every resolved key column in order plus the observed `xmin`:

```sql
UPDATE jobs
SET status = $1
WHERE id = $2
  AND xmin = $3::xid
RETURNING *
```

The key locates the row. `xmin` proves that the selected row version did not change after validation. A composite key adds every key comparison.

### No primary key

A table without a primary key uses the short-lived PostgreSQL system values `tableoid`, `ctid`, and `xmin`:

```sql
UPDATE audit_events
SET payload = $1
WHERE tableoid = $2::oid
  AND ctid = $3::tid
  AND xmin = $4::xid
RETURNING *
```

`tableoid` separates partitions and physical tables. `ctid` locates the tuple version. `xmin` detects replacement or update. These values are used only between candidate selection and its guarded write. They are never stored, returned, added to schema output, or treated as permanent identifiers.

A guard that returns no row reports an adapter failure caused by a concurrent change. `writesMayRemain` is true only when this operation can have completed an earlier candidate write.

## Transaction behavior

The bound transaction method delegates once to the public Drizzle transaction API with serializable isolation. It uses the shared transaction callback runner to close the view, track and drain active Store work, and select callback failure priority.

The callback view contains:

- the same Collections and operator semantics;
- `query` and `execute` bound to the same Drizzle transaction database; and
- no `transaction` method.

Collection and SQL calls therefore share one physical PostgreSQL transaction.

The adapter examines PostgreSQL SQLSTATE values without matching localized message text:

- `40001` (`serialization_failure`) becomes `TransactionConflictError`;
- `40P01` (`deadlock_detected`) becomes `TransactionConflictError`; and
- other start, callback, commit, or rollback failures use the approved Store transaction error rules.

The adapter never reruns the callback. After successful rollback, no write remains and the selected failure identity is preserved. A rollback failure becomes `TransactionRollbackError` with `writesMayRemain: true`.

Manual transaction-control SQL submitted through `query` or `execute` remains outside the guarantee.

## Core composition

The PostgreSQL adapter returns a generic backend. It does not create a Thread Store:

```ts
const backend = await bindPostgresStore({
  definition: threadDefinition,
  database,
});

const threadStore = createThreadStore({ backend });
```

The plain backend makes Core serialize complete transitions within one Thread Store instance. It makes one attempt, gives no cross-process isolation, and can leave partial persistence.

A transactional backend preserves the stronger path:

```ts
const backend = await bindPostgresStore({
  definition: threadDefinition,
  database,
  transaction: true,
});

const threadStore = createThreadStore({ backend });
```

Core uses real transactions, conflict reporting, bounded retry, and rollback. No PostgreSQL-specific Thread Store binder exists.

## Operation errors

- Caller query, create, and update validation uses `StoreValidationError`.
- Hook failures use `StoreHookError`.
- Input- or schema-dependent unavailable behavior uses `UnsupportedStoreOperationError`.
- Drizzle and PostgreSQL operation failures use `StoreAdapterError` with the original cause.
- Invalid decoded, generated, returned, or compiled adapter data uses `StoreAdapterContractError`.
- Direct SQL Statement and execution failures use the SQL Store error contract.
- Transaction conflicts and rollback use the Transaction Store error contract.

Every expected Store error and adapter contract defect reports `writesMayRemain`. Messages and causes can contain application or database data and are not safe default telemetry. The adapter does not add SQL text, parameters, credentials, complete inputs, or Records to safe error metadata.

## Conformance

The adapter runs the shared suites for every interface it returns:

- Store conformance for the base binder;
- SQL Statement and SQL Store conformance;
- Transaction Store conformance when `transaction: true`; and
- combined SQL and Collection transaction conformance.

PostgreSQL-specific scenarios cover:

1. PostgreSQL 15 acceptance and older-version rejection;
2. base binding that never calls `database.transaction`;
3. a successful probe that verifies the effective read-only serializable settings;
4. rejection when a transaction method accepts but does not apply the requested settings;
5. rejection of an inherited but unsupported transaction method;
6. Statement segments that contain raw `$1`, `?`, and `:name` text;
7. public Drizzle SQL reconstruction with bound parameters in source order;
8. array-row and object-row query result normalization;
9. verified `affectedRows` plus exact driver-result preservation;
10. supplied single and composite primary keys;
11. generated-table primary-key emission;
12. primary-key mismatch rejection;
13. a table without a primary key;
14. guarded update and delete through both identity forms;
15. an `xmin` conflict before any write and after an earlier write;
16. generated default, identity, and stored-column values returned and validated;
17. no host-value overwrite;
18. partial base mutation reporting;
19. SQLSTATE `40001` and `40P01` conflict mapping;
20. Collection, `query`, and `execute` work sharing one physical transaction; and
21. Core composition over plain and transactional backends.

The compile-tested prototype proves the binder return type, effective transaction-setting check, optional primary-key shape, Statement segment conversion, structural result normalization, guarded candidate identity, and Core guarantee selection without adding a production Drizzle dependency.

## Approval examples

### Base Store over a transaction-free database

```ts
const store = await bindPostgresStore({ definition, database });

await store.collections.auditEvent.update({
  where: (fields, op) => op.eq(fields.kind, "login"),
  set: { reviewed: true },
});
```

A later candidate conflict can reject with `writesMayRemain: true`.

### Requested transaction

```ts
const store = await bindPostgresStore({
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

Both calls commit or roll back together.

## References

- [Issue #20](https://github.com/spiritledsoftware/commissary/issues/20)
- [Drizzle research note](https://github.com/spiritledsoftware/commissary/issues/26)
- [Drizzle SQL source](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/sql/sql.ts)
- [PostgreSQL 15 constraints](https://www.postgresql.org/docs/15/ddl-constraints.html)
- [PostgreSQL 15 error codes](https://www.postgresql.org/docs/15/errcodes-appendix.html)
