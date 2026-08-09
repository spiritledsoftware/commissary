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
import { SqlRecord, sql } from "@commissary/store";

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

The package exports generic Store and Transaction Store contracts, typed filtering and update expressions, record validation helpers, structured Store errors, and JavaScript fallback operator compilers.

Adapter packages can use `@commissary/store/conformance` to verify observable Store behavior.

This package is ESM-only. It supports Node.js 22.14 or later, the current stable Bun and Deno releases, modern browsers, and Cloudflare Workers.
