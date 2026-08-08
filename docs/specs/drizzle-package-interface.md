# Drizzle Package Interface Technical Specification

> **Status**: Complete package and cross-adapter interface approved for implementation in issue #19.
>
> **Last updated**: 2026-08-08 during issue #19.

## Summary

`@commissary/drizzle` has one shared root entry point and one entry point for each supported SQL dialect. The root exports only shared definition contracts and definition failures. The `postgres`, `mysql`, and `sqlite` subpaths each export one generic Store definition factory, one Thread Store definition factory, one binder, and one binding error family.

The package accepts public Drizzle database base types. It does not enumerate drivers, own database clients, run migrations, or expose database-named runtime Store tiers. A binder preserves the exact definition, schema, create-input, operator, and public Drizzle result types. Literal transaction options preserve the exact returned Store capability. A non-literal Boolean returns a type-safe union.

The architectural source authority for Drizzle is the latest `main` branch. The compatibility source authority for the first implementation is the published `drizzle-orm` 0.45.2 npm package artifact. The first implementation targets exactly 0.45.2, declares the peer range `^0.45.2`, and uses no `main`-branch API that is absent from that published artifact.

## Governing Decisions

This specification extends:

- [ADR 0003](../adr/0003-keep-effect-behind-javascript-contracts.md), which requires ESM-only ES2022 packages with unbundled public entry points;
- [ADR 0016](../adr/0016-preserve-types-through-value-composition.md), which requires ordinary authoring without explicit generics, `as const`, or `satisfies`;
- [ADR 0019](../adr/0019-build-thread-store-on-generic-store-primitives.md), which forbids database-named runtime Store tiers;
- the [Store architecture specification](store.md);
- the [SQL Store tier specification](sql-store.md);
- the [shared Drizzle Store specification](drizzle-store.md); and
- the PostgreSQL, MySQL, and SQLite Drizzle adapter specifications.

Those documents remain authoritative for definition behavior, Store behavior, SQL behavior, transactions, failures, and live binding probes. This document owns package entry points, public names, dependency declarations, supported Drizzle database types, and package-level inference.

## Goals

- Keep shared definition contracts independent of one Drizzle dialect module.
- Give each dialect one complete, statically imported adapter entry point.
- Preserve exact table, relation, Record reference, create-input, and driver-result inference.
- Support generic and Thread Store definitions without a database-specific Thread Store binder.
- Accept common public Drizzle database types instead of driver unions.
- Make literal and non-literal transaction options type-safe.
- Let bundlers remove unused dialects and prevent Node.js from loading them through the root.
- State peer, direct, and host-owned optional dependencies exactly.

## Non-Goals

- Re-export Drizzle ORM, Store, Core, schema-library, or driver types.
- Export driver-specific binders, native clients, or a driver compatibility matrix.
- Export a PostgreSQL, MySQL, or SQLite runtime Store interface or alias.
- Export a named bound Store result type.
- Export package option aliases that duplicate constructor or binder parameters.
- Add a schema export helper, a second table map, or a nested relation map.
- Own database creation, credentials, pools, sessions, resource lifetime, migrations, DDL, or schema diffing.
- Make a compatibility promise for an untested Drizzle minor release.

## Invariants

1. **Shared root only**: `@commissary/drizzle` imports no dialect entry point and exports no dialect factory or binder.
2. **Three dialect entry points**: The package exports only `postgres`, `mysql`, and `sqlite` adapter subpaths in version 1.
3. **One dialect binder**: Each dialect subpath exports one binder for both generic and Thread Store definitions.
4. **No Thread binder**: The package exports no `bindPostgresThreadStore`, `bindMysqlThreadStore`, or `bindSqliteThreadStore` function.
5. **No runtime Store tier**: Binder results are structural compositions of `SqlStore` and, when requested, `TransactionStore`.
6. **Direct Drizzle types**: Binder parameters use Drizzle's public `PgDatabase`, `MySqlDatabase`, and `BaseSQLiteDatabase` types directly.
7. **Exact result inference**: A concrete database keeps its public command result type under `SqlCommandResult.driverResult`.
8. **Literal capability inference**: Omitted or literal-false `transaction` returns only the base SQL Store. Literal true also returns Transaction Store.
9. **Boolean honesty**: A non-literal Boolean returns the union of those two results and requires normal narrowing before transaction use.
10. **Direct generated values**: Definitions expose `records` and one flat `schema`. They expose no `tables`, `bindings`, nested `relations`, or export helper.
11. **Host schema exports**: Drizzle Kit users export the values in `definition.schema` directly from their schema module.
12. **Host-owned generators**: The package imports neither Drizzle Zod nor Drizzle Valibot. It accepts their generator functions as host values.
13. **Required Drizzle peer**: `drizzle-orm` is a required peer, not an optional peer or bundled direct dependency.
14. **Inert imports**: No public entry point creates a database, starts I/O, or runs a binding probe during module evaluation.
15. **Tree-shaking declaration**: The package declares `sideEffects: false` and keeps every dialect in a separate unbundled entry file.

## Public Entry Points

The package exports exactly these entry points:

```json
{
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  },
  "./postgres": {
    "types": "./dist/postgres.d.ts",
    "import": "./dist/postgres.js"
  },
  "./mysql": {
    "types": "./dist/mysql.d.ts",
    "import": "./dist/mysql.js"
  },
  "./sqlite": {
    "types": "./dist/sqlite.d.ts",
    "import": "./dist/sqlite.js"
  }
}
```

There is no CommonJS condition and no arbitrary `src` subpath export. Published files still include `dist` and `src` for source inspection.

### Root: `@commissary/drizzle`

The root exports these values:

```ts
export { DrizzleDefinitionError };
```

The root exports these types:

```ts
export type {
  DrizzleDefinitionIssue,
  DrizzleDefinitionIssueCode,
  DrizzleSchemaGenerators,
  DrizzleStoreDefinition,
};
```

`DrizzleStoreDefinition` is the small shared result view. Concrete dialect definition types extend it through inaccessible package state:

```ts
export interface DrizzleStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends Readonly<Record<string, object>>,
> {
  readonly records: Records;
  readonly schema: Schema;

  // Inaccessible package state retains effective definitions, hooks,
  // table identity, create inputs, dialect, and definition kind.
}
```

`DrizzleSchemaGenerators` describes the three structural generator functions. Dialect factories infer the exact table and returned schema types from the supplied value. Ordinary callers do not provide its generic arguments.

The root does not re-export a dialect symbol. Dialect subpaths do not duplicate the shared root exports.

### PostgreSQL: `@commissary/drizzle/postgres`

Values:

```ts
export {
  DrizzlePostgresBindingError,
  DrizzlePostgresStore,
  DrizzlePostgresThreadStore,
  bindPostgresStore,
};
```

Types:

```ts
export type {
  DrizzlePostgresBindingErrorReason,
  DrizzlePostgresStoreDefinition,
  DrizzlePostgresThreadStoreDefinition,
};
```

### MySQL: `@commissary/drizzle/mysql`

Values:

```ts
export { DrizzleMysqlBindingError, DrizzleMysqlStore, DrizzleMysqlThreadStore, bindMysqlStore };
```

Types:

```ts
export type {
  DrizzleMysqlBindingErrorReason,
  DrizzleMysqlStoreDefinition,
  DrizzleMysqlThreadStoreDefinition,
};
```

Use `Mysql` in TypeScript symbols and `mysql` in import paths. Do not introduce the alternate `MySql` spelling.

### SQLite: `@commissary/drizzle/sqlite`

Values:

```ts
export { DrizzleSqliteBindingError, DrizzleSqliteStore, DrizzleSqliteThreadStore, bindSqliteStore };
```

Types:

```ts
export type {
  DrizzleSqliteBindingErrorReason,
  DrizzleSqliteStoreDefinition,
  DrizzleSqliteThreadStoreDefinition,
};
```

Use `Sqlite` in TypeScript symbols and `sqlite` in import paths. Do not introduce the alternate `SQLite` spelling.

## Definition Factories

Each dialect exports two synchronous factory values:

```ts
const genericDefinition = DrizzlePostgresStore.define({
  schemas,
  records,
  overrides,
  relations,
  hooks,
});

const threadDefinition = DrizzlePostgresThreadStore.define({
  schemas,
  records,
  overrides,
  relations,
  hooks,
});
```

MySQL and SQLite use the same shape under their matching names.

The factory parameter remains inline. The package does not export `DefineDrizzlePostgresStoreOptions` or another option alias. The concrete call is the inference seam.

A generic factory uses only supplied Record contributions. A Thread factory first adds every Core Record, then applies host contributions, overrides, schema generation, hooks, relations, and dialect checks. The two results have distinct concrete definition types so Core composition can require a Thread definition without a runtime flag.

Public constructors use const generics and readonly maps. Ordinary calls preserve:

- every Record key;
- every Drizzle table and column type;
- every generated or static Field Schema input and output;
- every relation key and entity type;
- every resolved SQL Record reference;
- every required hook patch and adjusted create input; and
- whether the definition contains the complete Thread Store catalog.

Ordinary authoring requires no explicit generic, `as const`, `satisfies`, runtime `$Infer` property, or global type augmentation.

## Generated Records and Schema

Every definition exposes only:

```ts
definition.records;
definition.schema;
```

`records` is the exact map of resolved SQL Record references. `schema` is the exact flat map of final Drizzle tables and host relation entities. Record keys become table keys. Relation callback keys remain exact and must not collide.

Applications pass the flat value to Drizzle:

```ts
const database = drizzle(client, {
  schema: definition.schema,
});
```

Drizzle Kit loads direct runtime exports. The host schema module exports the generated values directly:

```ts
export const { job, jobRelations, thread } = definition.schema;
```

The package exports no `exportDrizzleSchema`, `tables`, `relations`, or generated source-file helper. Callers use `typeof definition.schema` when they need its type.

## Supported Drizzle Database Types

Binders use these public Drizzle types directly:

| Dialect    | Drizzle type         | Public import path        |
| ---------- | -------------------- | ------------------------- |
| PostgreSQL | `PgDatabase`         | `drizzle-orm/pg-core`     |
| MySQL      | `MySqlDatabase`      | `drizzle-orm/mysql-core`  |
| SQLite     | `BaseSQLiteDatabase` | `drizzle-orm/sqlite-core` |

The signatures infer each Drizzle generic parameter instead of replacing the database with a package-owned structural approximation. PostgreSQL retains its `PgQueryResultHKT`, full schema, and relational schema. MySQL retains its query-result HKT, prepared-query HKT, full schema, and relational schema. SQLite retains its sync-or-async result kind, run result, full schema, and relational schema.

The package exports no `DrizzlePostgresDatabase`, `DrizzleMysqlDatabase`, `DrizzleSqliteDatabase`, `AnyDrizzleDatabase`, or driver union.

A database is supported when all these conditions hold:

1. its type extends the matching public Drizzle database base type within the declared peer range;
2. the concrete binder's public operation path is available;
3. its live version, engine, transaction, and table probes pass where required; and
4. its operations preserve the related adapter specification.

A future driver can work without a package release when it uses the supported Drizzle minor, extends the common public type, and passes the same probes. A new Drizzle minor needs compile-time and runtime conformance before the peer range expands.

The package never declares a peer on `pg`, `postgres`, `mysql2`, `better-sqlite3`, D1 types, libSQL, Bun types, or another driver package. The host selects and installs its Drizzle driver.

## Binder Interface and Transaction Inference

Each binder accepts either its matching generic definition or matching Thread definition. It returns a native Promise before validation or probe work starts.

The public interface uses three overload groups rather than one conditional Boolean generic:

```ts
bindPostgresStore({
  definition,
  database,
  transaction: true,
}); // Promise<SqlStore & TransactionStore>

bindPostgresStore({
  definition,
  database,
  transaction: false,
}); // Promise<SqlStore>

bindPostgresStore({
  definition,
  database,
}); // Promise<SqlStore>

bindPostgresStore({
  definition,
  database,
  transaction: runtimeBoolean,
}); // Promise<SqlStore | (SqlStore & TransactionStore)>
```

MySQL and SQLite use the same compile-time rule. Their runtime probe rules remain dialect-specific.

The non-literal Boolean overload is required. A conditional generic of the form `Transaction extends true ? ... : ...` is not valid for `boolean`, because it can report the base type when runtime binding returns a transaction method. Callers narrow the union with ordinary property presence:

```ts
const store = await bindSqliteStore({
  definition,
  database,
  transaction: configuration.transactions,
});

if ("transaction" in store) {
  await store.transaction(useTransaction);
}
```

The return type is structural and unnamed. It preserves:

- the definition's effective Record catalog;
- operator and hook-adjusted create-input types;
- `query` row inference;
- the database's exact public command result under `driverResult`; and
- transaction-bound `query` and `execute` capabilities when the wider Store is present.

No public `BoundDrizzlePostgresStore`, `BoundDrizzleMysqlStore`, or `BoundDrizzleSqliteStore` alias exists.

## Thread Store Composition

The Thread Store definition factories are the only database-named Thread helpers in this package:

```ts
const definition = DrizzlePostgresThreadStore.define(options);
const backend = await bindPostgresStore({
  definition,
  database,
  transaction: true,
});
const threadStore = createThreadStore({ backend });
```

`createThreadStore` remains owned and exported by `@commissary/core`. The Drizzle package does not wrap it, re-export it, or add a combined convenience factory. The same binder works for generic and Thread definitions. This keeps connection ownership and Core Runtime transition ownership at their established seams.

## Dependency Policy

The package manifest declares:

```json
{
  "dependencies": {
    "@commissary/core": "workspace:^",
    "@commissary/store": "workspace:^",
    "@standard-schema/spec": "^1.1.0"
  },
  "peerDependencies": {
    "drizzle-orm": "^0.45.2"
  },
  "devDependencies": {
    "drizzle-orm": "0.45.2"
  }
}
```

The release manifest replaces workspace ranges through the normal workspace publishing process.

`drizzle-orm` is a required peer because every useful dialect entry point imports Drizzle runtime values. Keeping it as a peer prevents a second ORM copy and keeps the host's tables, columns, SQL values, and database instances on one compatible Drizzle identity.

The package has no `optionalDependencies` and no `peerDependenciesMeta` entries. The exact initial host-owned generator matrix is `drizzle-zod` 0.8.3 with Zod `^3.25.0 || ^4.0.0`, and `drizzle-valibot` 0.4.2 with Valibot `^1.0.0`. The package imports none of these four packages. It receives public generator functions and returned schemas as values. Support expands only after compile-time and runtime conformance.

## Tree-Shaking and Runtime Loading

The package declares:

```json
{
  "type": "module",
  "sideEffects": false
}
```

Source entry files follow these rules:

- `src/index.ts` exports only shared definition contracts and failures.
- `src/postgres.ts` imports only shared package internals and public PostgreSQL Drizzle modules.
- `src/mysql.ts` imports only shared package internals and public MySQL Drizzle modules.
- `src/sqlite.ts` imports only shared package internals and public SQLite Drizzle modules.
- Dialect entry files do not import each other.
- Type-only dependencies use `import type` and `export type`.
- No entry point uses a dynamic import for an ordinary dependency.
- No entry point performs top-level I/O.

This split matters even when a bundler is absent. Importing the root with Node.js evaluates no dialect module. Importing one dialect evaluates no other dialect module. A bundler can also remove unused internal exports because the package has no declared side effects.

## Failure Ownership

The shared root owns `DrizzleDefinitionError`, its issue type, and its issue-code union. Definition errors can include lower-tier SQL definition issue codes and Drizzle-specific issue codes.

Each dialect subpath owns its binding error class and reason union. A binding error occurs before a Store value exists.

Store, SQL Statement, SQL execution, adapter contract, and transaction failures remain owned by `@commissary/store`. The Drizzle package does not re-export those classes. Callers import errors from the module that owns them.

## Package Verification

Implementation must verify these package contracts:

1. Root import loads no dialect module.
2. Each dialect subpath imports in Node.js and Bun without a configured database.
3. Every public entry point has matching `types` and `import` conditions.
4. The package archive contains `dist` and `src`, and no tests or prototypes.
5. The package declares no CommonJS output and no arbitrary source export.
6. Root and subpath declarations contain no public `any`, global augmentation, runtime `$Infer`, or required explicit generic.
7. A direct Drizzle table preserves every schema key and relation key.
8. Each concrete common Drizzle database type is accepted without a package-owned alias.
9. A wrong-dialect database or definition fails at compile time.
10. Omitted and false transaction options expose no transaction method.
11. Literal true exposes transaction-bound `query` and `execute`.
12. A Boolean variable returns a union that needs narrowing.
13. PostgreSQL and MySQL retain the exact public `execute` result type.
14. SQLite retains the exact `RunResult` type.
15. A Thread definition binds through the normal dialect binder and composes through `createThreadStore`.
16. Hook-adjusted create inputs are identical through base and transaction binding. A hook-guaranteed field is optional and an unrelated required field stays required.
17. The exact 19-key Core catalog retains every approved physical table name, column name, and primary-key tuple.
18. Direct table and relation exports load as top-level schema-module values for Drizzle Kit in all three dialects.
19. Drizzle Zod 0.8.3 with its approved Zod range and Drizzle Valibot 0.4.2 with Valibot 1 work when installed only by the host.
20. Unsupported generator families fail with `unsupported-schema-family`. Versions outside the approved matrix have no compatibility promise.
21. Building and importing one dialect does not require a native driver package for another dialect.
22. The implementation compiles against exactly published `drizzle-orm` 0.45.2, and every used API inspected on `main` also exists in that npm package artifact.
23. Each dialect passes the complete conformance matrix in the shared Drizzle Store specification.

The compile-tested prototype is `packages/store/prototypes/drizzle-package-interface.prototype.ts`.

The final cross-adapter prototype is `packages/store/prototypes/complete-sql-drizzle-specification.prototype.ts`.

Run it with:

```sh
pnpm exec tsc --ignoreConfig --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext packages/store/prototypes/drizzle-package-interface.prototype.ts
pnpm exec bun packages/store/prototypes/drizzle-package-interface.prototype.ts
```

## Rejected Alternatives

### Root re-exports every dialect

Rejected because unbundled Node.js ESM evaluates the complete static re-export graph. `sideEffects: false` helps bundlers but does not stop Node from loading all dialect modules.

### Optional Drizzle peer

Rejected because every useful dialect entry point requires Drizzle runtime values. An optional peer would suppress a required installation constraint.

### Direct Drizzle dependency

Rejected because the host must use one compatible Drizzle identity for its tables, SQL values, schemas, and database instances.

### Schema-library peers

Rejected because the package imports no Drizzle Zod, Drizzle Valibot, Zod, or Valibot module. Host-supplied generator functions are sufficient.

### Package-owned database aliases or driver unions

Rejected because they add no behavior, age faster than Drizzle's public base types, and can imply support that the live adapter cannot preserve.

### Conditional Boolean return type

Rejected because a widened `boolean` can produce an unsound base-only return type. Explicit overloads preserve literal inference and report a union for runtime configuration.

### Named bound Store types

Rejected because they would look like database-named runtime Store tiers. The concrete binder returns the structural primitive composition it implements.

### Combined Thread Store binder

Rejected because Core owns Thread Store Runtime transitions and the host owns the database. Definition, binding, and Core composition remain three visible stages.

### Schema export helper

Rejected because `definition.schema` already contains the exact flat runtime entities. Direct destructuring is the form Drizzle Kit needs.

## References

- [Issue #15](https://github.com/spiritledsoftware/commissary/issues/15)
- [Final approval issue #19](https://github.com/spiritledsoftware/commissary/issues/19)
- [Wayfinder map #7](https://github.com/spiritledsoftware/commissary/issues/7)
- [Drizzle Store Technical Specification](drizzle-store.md)
- [Drizzle PostgreSQL Store Adapter Technical Specification](drizzle-postgres-store.md)
- [Drizzle MySQL Store Adapter Technical Specification](drizzle-mysql-store.md)
- [Drizzle SQLite Store Adapter Technical Specification](drizzle-sqlite-store.md)
- [Drizzle PostgreSQL database type](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/pg-core/db.ts)
- [Drizzle MySQL database type](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/mysql-core/db.ts)
- [Drizzle SQLite database type](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/sqlite-core/db.ts)
- [Drizzle Zod package](https://github.com/drizzle-team/drizzle-orm/tree/main/drizzle-zod)
- [Drizzle Valibot package](https://github.com/drizzle-team/drizzle-orm/tree/main/drizzle-valibot)
- [Published Drizzle ORM 0.45.2 package](https://www.npmjs.com/package/drizzle-orm/v/0.45.2)
