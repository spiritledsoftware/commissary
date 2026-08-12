# `@commissary/drizzle`

Connection-free PostgreSQL, MySQL, and SQLite Store definitions for Commissary.

## Install

```sh
pnpm add @commissary/drizzle drizzle-orm
```

When using generated schemas, install one supported host-owned generator family too:

```sh
pnpm add drizzle-zod zod
# or: pnpm add drizzle-valibot valibot
```

Import shared definition failures and contracts from `@commissary/drizzle`. Import one isolated dialect factory from `@commissary/drizzle/postgres`, `@commissary/drizzle/mysql`, or `@commissary/drizzle/sqlite`. Importing the root loads no Drizzle dialect module.

Definitions synchronously combine lower-tier Records or direct Drizzle tables, static overrides, optional host schema generators, Before Create Hooks, and relations. They perform no I/O and return exact SQL Record references plus one flat Drizzle schema. Database binding is supplied by the dialect adapter work that follows the definition lifecycle; this package does not create clients, run migrations, or own credentials or connections.

Schema generation supports host-installed `drizzle-zod` 0.8.3 with Zod `^3.25.0 || ^4.0.0`, or `drizzle-valibot` 0.4.2 with Valibot `^1.0.0`. This package imports none of those libraries. Static Field Schemas override generated schemas.

## Usage

```ts
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";

import { DrizzleSqliteStore } from "@commissary/drizzle/sqlite";

const jobs = sqliteTable("jobs", {
  id: text("id").notNull(),
  queue: text("queue").notNull(),
});

const definition = DrizzleSqliteStore.define({
  schemas: {
    select: createSelectSchema,
    insert: createInsertSchema,
    update: createUpdateSchema,
  },
  records: { job: jobs },
});

export const { job } = definition.schema;
```

For a direct table without generators, provide a complete static Field Schema under `overrides.<record>.fields`. Static shorthand applies to select, create, and update; an operation object replaces only the named generated operation.

Definition failures are synchronous and aggregated:

```ts
import { DrizzleDefinitionError } from "@commissary/drizzle";

try {
  DrizzleSqliteStore.define(options);
} catch (error) {
  if (error instanceof DrizzleDefinitionError) {
    for (const issue of error.issues) console.error(issue.code, issue.path, issue.message);
  }
}
```

PostgreSQL definitions accept an exact `enums` map for enum entities referenced by supplied tables or column builders. Export each value in `definition.schema` directly from a Drizzle Kit schema module; Drizzle Kit does not recursively inspect the map.

The initial implementation targets published `drizzle-orm` 0.45.2. That version cannot represent an explicitly named PostgreSQL identity sequence qualified differently from its table or MySQL `DATETIME ON UPDATE CURRENT_TIMESTAMP`; definitions report these cases without changing their physical intent.

The package is ESM-only and supports Node.js 22.14+, current Bun and Deno, modern browsers, and Cloudflare Workers.

See the [project README](../../README.md) and [Drizzle Store specification](../../docs/specs/drizzle-store.md).
