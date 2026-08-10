# @commissary/store

Typed persistence contracts, record validation, query expressions, update expressions, and adapter conformance helpers for Commissary.

## Install

```sh
pnpm add @commissary/store
```

## Use

Define a catalog with Standard Schema field definitions, then implement or select a Store adapter for that catalog:

```ts
import type { RecordDefinitions, Store } from "@commissary/store";

const records = {
  users: {
    fields: {
      id: idSchema,
      name: nameSchema,
    },
  },
} as const satisfies RecordDefinitions;

declare const store: Store<typeof records>;

const users = await store.collections.users.find();
```

## Define portable SQL Records

Use `SqlRecord.define()` to add driver-independent SQL names, storage types, defaults, and primary-key metadata to one Record definition:

```ts
import { SqlRecord, sql } from "@commissary/store/sql";

const scheduledJob = SqlRecord.define({
  table: sql.table({
    name: "scheduled_jobs",
    primaryKey: ["id"],
  }),
  fields: {
    id: {
      select: idSchema,
      column: sql.column({
        name: "job_id",
        type: sql.text(),
        notNull: true,
      }),
    },
  },
});
```

Field Schemas still control selected, create, and update types. The SQL metadata does not create a database client or add an ORM dependency.

## Refine Records for PostgreSQL

Use `pg.table()`, `pg.column()`, and the PostgreSQL column type helpers to add
PostgreSQL intent without an ORM dependency:

```ts
import { SqlRecord, sql } from "@commissary/store/sql";
import { pg } from "@commissary/store/sql/postgres";

const scheduledJob = SqlRecord.define({
  table: sql.table({
    name: "scheduled_jobs",
    postgres: pg.table({ schema: "jobs" }),
  }),
  fields: {
    id: {
      select: idSchema,
      column: sql.column({
        type: sql.text(),
        postgres: pg.column({ type: pg.uuid(), notNull: true }),
      }),
    },
  },
});
```

Concrete PostgreSQL adapters use `resolvePostgresRecords()` from
`@commissary/store/sql/postgres/adapter`. The synchronous resolver applies
Record overrides, validates names and physical options, and returns frozen
table, column, reference, codec, identity, generated-column, and enum assets.
It performs no database or driver work.

## Refine Records for MySQL

Use `mysql.table()`, `mysql.column()`, and the MySQL column type helpers to add
MySQL intent without an ORM dependency:

```ts
import { SqlRecord, sql } from "@commissary/store/sql";
import { mysql } from "@commissary/store/sql/mysql";

const scheduledJob = SqlRecord.define({
  table: sql.table({
    name: "scheduled_jobs",
    mysql: mysql.table({ database: "jobs" }),
  }),
  fields: {
    id: {
      select: idSchema,
      column: sql.column({
        type: sql.text(),
        mysql: mysql.column({ type: mysql.bigint(), autoIncrement: true }),
      }),
    },
  },
});
```

Concrete MySQL adapters use `resolveMysqlRecords()` from
`@commissary/store/sql/mysql/adapter`. The synchronous resolver applies Record
overrides, validates names and physical options, and returns frozen table,
column, reference, codec, automatic-increment, generated-column, and inline-enum
assets. It performs no database or driver work.

## Compose SQL Statements

Use the callable `sql` helper to keep SQL structure separate from bound values. Nested Statements add structure. Plain interpolations add one parameter, including array values:

```ts
import { sql } from "@commissary/store/sql";

const statement = sql`
  SELECT *
  FROM ${sql.identifier("scheduled_jobs")}
  WHERE status = ${"pending"}
`;
```

Use `sql.raw()` only for trusted SQL structure, `sql.identifier()` for one complete name part, `sql.param()` for an explicit parameter or encoder, and `sql.join()` for immutable Statement composition.

Store adapter packages compile Statements through the separate adapter API:

```ts
import { compileSqlStatement } from "@commissary/store/sql/adapter";
```

The compiler quotes identifiers and creates placeholders through adapter callbacks. It returns final text, a fresh ordered parameter array, and frozen exact text segments. It does not parse SQL or call a database driver.

## Implement an SQL Store adapter

Use `createSqlStore()` to combine a Collection Map with Statement compiler callbacks and one prepared driver call for each result mode:

```ts
import { createSqlStore } from "@commissary/store/sql";
```

The shared runtime returns a native Promise before compilation or adapter work starts. It validates Statement parameters, preserves unchecked query row arrays and exact command driver results, verifies affected-row counts, and reports whether an execution can have occurred. Adapter code supplies driver-result classification but does not expose those callbacks on the Store.

Transaction adapters use `runTransactionCallback()` from `@commissary/store/transaction-adapter` inside their physical transaction operation. The helper closes the Transaction View, drains active operations, records caught operation failures, and selects the rollback cause. The adapter still owns begin, commit, rollback, and resource release.

The root package exports generic Store and Transaction Store contracts, typed filtering and update expressions, record validation helpers, structured Store errors, and JavaScript fallback operator compilers. SQL-specific contracts and helpers are under `@commissary/store/sql`.

Adapter packages use `@commissary/store/conformance` for generic Store scenarios and `@commissary/store/sql/conformance` for Statement, SQL Store, and combined SQL and Collection transaction scenarios.

This package is ESM-only. It supports Node.js 22.14 or later, the current stable Bun and Deno releases, modern browsers, and Cloudflare Workers.
