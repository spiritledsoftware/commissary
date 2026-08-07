# Drizzle Store Technical Specification

**Status:** Shared definition lifecycle and PostgreSQL and MySQL binding shapes approved. SQLite, package exports, and final cross-adapter approval remain in later design gates.

## Summary

`@commissary/drizzle` accepts lower-tier Record definitions and ordinary Drizzle tables in one Store definition. It can generate missing field schemas from host-supplied Drizzle schema functions, merge static Record overrides, build or accept dialect tables, attach host relations, and return one flat runtime schema without a database connection.

The same definition captures Store hooks. A later asynchronous binding stage accepts an existing host-owned Drizzle database, checks the concrete engine and requested transaction path, and returns the Store capabilities that path can preserve. Definition never creates a client, opens a connection, runs a migration, or inspects a live schema. Concrete binding performs only the live checks that its adapter specification requires.

## Context

The approved Store and SQL Store tiers already define:

- field-local Standard Schema contracts;
- Store-neutral Record contributions and host overrides;
- portable and database-specific SQL storage intent;
- synchronous database Record resolution;
- opaque SQL Record references;
- strict create, update, select, and transaction behavior; and
- Drizzle-independent PostgreSQL, MySQL, and SQLite physical plans.

This specification defines the shared concrete Drizzle definition lifecycle and the approved PostgreSQL and MySQL binding shapes. SQLite driver behavior remains in its concrete design gate.

The Drizzle source authority is commit `b7862528fd8fc39bc2653a6c18dad7c1f4e68d10`.

## Goals

- Accept a lower-tier Record definition or a dialect-correct Drizzle table under one `records` key.
- Let concrete Drizzle definitions accept Drizzle tables and column builders directly, without a repeated `drizzle` property or a second binding map.
- Allow optional top-level schema generation through ordinary Drizzle validation helpers.
- Keep static schemas available as complete or field-level overrides.
- Add every column from a supplied Drizzle table to the effective Record.
- Capture base Store and Thread Store `beforeCreate` hooks in the definition.
- Build relations only after every table exists.
- Return direct runtime tables and relation entities in one flat schema for application use and Drizzle Kit exports.
- Bind the same definition to one or more compatible host-owned database instances.
- Preserve dialect-specific database and result types while exposing transaction guarantees only when requested and verified.

## Non-goals

- Database client, pool, credential, or connection lifetime ownership.
- Migration execution, schema diffing, general live-table introspection, or TypeScript source generation.
- A common runtime PostgreSQL, MySQL, or SQLite Store interface.
- Native-client escape hatches or a public matrix of driver-specific binders.
- Integration-owned indexes, relations, or constraints other than the optional portable primary key in lower-tier Record definitions.
- Relation-aware Collection reads, eager loading, joins, cascades, or nested writes.
- Automatic support for every Standard Schema library that a Drizzle extension can return.

## Invariants

1. **One effective Record:** Every Collection still has one effective Record definition. Drizzle input fills or implements that definition; it does not create a parallel model.
2. **Concrete context is enough:** A concrete dialect definition accepts its Drizzle values directly. It does not nest them under `drizzle` or the database name again.
3. **Synchronous definition:** Definition performs no I/O and needs no database instance.
4. **Asynchronous binding:** Binding accepts an existing database and can perform read-only engine, driver, transaction, and session checks.
5. **Static schemas win:** Existing effective Field Schemas keep their normal fallback rules. Host static schema overrides win over generated schemas.
6. **Generated schemas fill gaps:** Schema generators supply Field Schemas only where the effective Record has no static schema contract.
7. **Every table column is a field:** A table supplied as a Record or override contributes each TypeScript column key as an effective Record Field. Physical database names stay unchanged.
8. **No hidden required column:** A required table column must be represented by an effective Record Field, a default, or generation. A Store hook can guarantee a represented field.
9. **Hooks are definition values:** Base Store and Thread Store definitions capture hooks. Binding does not accept a second hook map.
10. **Relations are catalog-wide:** Relations sit beside `records` and `overrides`, run after all tables exist, and return ordinary Drizzle relation entities.
11. **One flat schema:** Tables use Record keys. Relations use the keys returned by the host callback. All keys must be distinct.
12. **Direct exports remain necessary:** Drizzle Kit sees runtime entities exported directly from a schema module. It does not recursively inspect the flat schema object.
13. **Common driver path stays honest:** Each database has one binder that uses public Drizzle APIs for every accepted database. A transaction capability succeeds only after the adapter proves its required effective transaction settings.

## Shared Definition Interface

The exact PostgreSQL, MySQL, and SQLite types specialize this shared shape. These rough types show the caller interface without erasing dialect values.

```ts
export interface DrizzleSchemaGenerators<
  Table,
  SelectRecordSchema extends StandardSchemaV1,
  InsertRecordSchema extends StandardSchemaV1,
  UpdateRecordSchema extends StandardSchemaV1,
> {
  readonly select: (table: Table) => SelectRecordSchema;
  readonly insert: (table: Table) => InsertRecordSchema;
  readonly update: (table: Table) => UpdateRecordSchema;
}

export type DrizzleRecordInput<Definition extends RecordDefinition, Table> = Definition | Table;

export type DrizzleRecordInputs<Definition extends RecordDefinition, Table> = Readonly<
  Record<string, DrizzleRecordInput<Definition, Table>>
>;

export type DrizzleRecordOverride<Override, Table, ColumnBuilder> =
  | Override
  | Table
  | (Override & {
      readonly table?: Table;
      readonly fields?: Readonly<Record<string, FieldOverride | ColumnBuilder>>;
    });

export interface DrizzleStoreDefinitionOptions<
  Records,
  Overrides,
  Tables,
  Relations,
  Hooks,
  SchemaGenerators,
> {
  readonly schemas?: SchemaGenerators;
  readonly records: Records;
  readonly overrides?: Overrides;
  readonly relations?: (tables: Tables) => Relations;
  readonly hooks?: Hooks;
}

export interface DrizzleStoreDefinition<
  Definitions extends RecordDefinitions,
  Records extends SqlRecordReferences<Definitions>,
  Schema extends Readonly<Record<string, object>>,
  CreateInputs extends StoreCreateInputMap<Definitions>,
> {
  readonly records: Records;
  readonly schema: Schema;

  // Package-owned inaccessible type and runtime state retains effective
  // definitions, hook patches, table identity, and binding facts.
}
```

There is no public `bindings`, `tables`, or nested `relations` output map. The definition module hides normalization and keeps the public result small.

## Record Inputs

### Lower-tier Record definition

A lower-tier Record keeps its static Field Schemas and SQL metadata:

```ts
const definition = DrizzlePostgresStore.define({
  records: {
    scheduledJob: ScheduledJob,
  },
});
```

The PostgreSQL Drizzle definition calls the approved PostgreSQL Record resolver and generates the matching table when the host supplies no complete table.

### Direct Drizzle table

With schema generators, an ordinary Drizzle table is a complete Record input:

```ts
const someRecordTable = pgTable("some_records", {
  id: text("id").notNull(),
  tenantId: text("tenant_id").notNull(),
  archived: boolean("archived").notNull().default(false),
});

const definition = DrizzlePostgresStore.define({
  schemas: {
    select: createSelectSchema,
    insert: createInsertSchema,
    update: createUpdateSchema,
  },
  records: {
    someRecord: someRecordTable,
  },
});
```

The effective Record has the TypeScript keys `id`, `tenantId`, and `archived`. The physical column remains `tenant_id`. All three generated object schemas must describe the same table and use one supported schema family.

Without `schemas`, every effective field needs a complete static schema contract. A direct table with a field that has no static schema produces a definition issue.

### Direct column builder

A concrete Record or override can use a dialect column builder as an existing-field shorthand:

```ts
const definition = DrizzlePostgresStore.define({
  schemas,
  records: {
    scheduledJob: ScheduledJob,
  },
  overrides: {
    scheduledJob: {
      fields: {
        queue: text("queue").notNull(),
      },
    },
  },
});
```

For a new field, an object can combine static schema intent and a direct column builder. With schema generators, the column builder can supply the missing schema evidence.

### Complete table override

A direct table can replace the generated table for an existing Record:

```ts
const definition = DrizzlePostgresThreadStore.define({
  schemas,
  records,
  overrides: {
    thread: threadTable,
  },
  hooks,
});
```

The object form combines a table with static field changes:

```ts
overrides: {
  thread: {
    table: threadTable,
    fields: {
      tenantId: tenantIdSchema,
    },
  },
}
```

A complete table supplies all Drizzle columns and its own table extra configuration. It cannot also accept separate column-builder replacements or a second table extra-configuration callback.

## Schema Generation

`schemas` is optional and accepts the three ordinary functions from one supported Drizzle validation package:

```ts
schemas: {
  select: createSelectSchema,
  insert: createInsertSchema,
  update: createUpdateSchema,
}
```

The functions return whole-table object schemas. Store still needs one Field Schema for each operation. Standard Schema V1 exposes no portable object-field reflection, so `@commissary/drizzle` recognizes the public object shape of each supported generator family. The first required families are Drizzle Zod and Drizzle Valibot. An unsupported family reports a definition issue instead of guessing.

Generation order is:

1. build or accept the final Drizzle table;
2. call the three schema functions;
3. verify that each result is a supported object schema for the same table keys;
4. extract generated select, insert, and update field schemas;
5. apply static field schemas over generated schemas; and
6. apply the normal Store Field Schema round-trip and JSON-value checks.

A lower-tier Field Definition keeps its established fallback: missing create uses select, and missing update uses create. Generators do not reinterpret that contract. For a field that comes only from a Drizzle table or column, the three generated schemas form its initial Field Definition. A static shorthand replaces all three operations; an operation object replaces only its named generated operations.

Generated schemas can still be invalid Store schemas. Definition rejects selected `Date`, `Uint8Array`, class instances, non-JSON values, unstable transforms, incompatible create or update outputs, unsupported omission, or any other violation of the Store Record contract. A host can supply a static schema that converts a Drizzle value into the approved JSON-compatible selected value.

## Hooks

Both generic and Thread definitions accept `hooks`:

```ts
const definition = DrizzlePostgresStore.define({
  schemas,
  records: {
    someRecord: someRecordTable,
  },
  hooks: {
    someRecord: {
      beforeCreate: () => ({
        tenantId: currentTenantId(),
      }),
    },
  },
});
```

The Store specification defines hook patch inference. In this example, `tenantId` is a required property of the patch, so it becomes optional in `someRecord.create`. `id` remains required. A database default makes `archived` optional independently.

Thread definitions add Core Records before they check hooks. A required custom field on an internal Core create path must be guaranteed by its hook patch. Command inputs omit hook-guaranteed custom fields in the same way as direct Collection create inputs.

## Relations

Relations sit beside Record inputs because they connect the complete table catalog:

```ts
const definition = DrizzlePostgresThreadStore.define({
  schemas,
  records: {
    someRecord: someRecordTable,
    scheduledJob: ScheduledJob,
  },
  overrides,
  relations: (tables) => ({
    someRecordRelations: relations(tables.someRecord, ({ one }) => ({
      job: one(tables.scheduledJob, {
        fields: [tables.someRecord.jobId],
        references: [tables.scheduledJob.id],
      }),
    })),
  }),
  hooks,
});
```

The callback runs once after every final table exists. It returns ordinary Drizzle relation entities under host-selected keys. It does not return relation configuration fragments for Commissary to reinterpret.

Relations do not create migration foreign keys. Host table definitions own indexes, checks, foreign keys, unique constraints, and other dialect table configuration. A lower-tier SQL Record can contribute its optional portable primary key; generated tables emit it. A supplied Drizzle table owns its declared primary key, which must agree with lower-tier metadata when both exist.

## Definition Result and Drizzle Kit

The result contains final SQL Record references and one flat Drizzle schema:

```ts
definition.records.someRecord;
definition.schema.someRecord;
definition.schema.someRecordRelations;
```

Applications pass the flat schema to Drizzle:

```ts
const database = drizzle(client, {
  schema: definition.schema,
});
```

Drizzle Kit executes configured schema modules and inspects direct exports. It does not recurse into `definition.schema`. The schema module must therefore export each entity directly:

```ts
export const { someRecord, someRecordRelations, scheduledJob } = definition.schema;
```

The destructured values are direct module exports. Their export names do not change physical table or column names.

The package snapshots and freezes its own Record maps, override results, references, schema map, and hidden definition state. It does not clone or freeze Drizzle tables, columns, relation entities, or third-party schema objects. The host must not mutate those values after definition.

## Definition Order and Conflicts

Definition uses this stable order:

1. Record contribution and override conflicts;
2. schema-generator presence and family checks;
3. each Record's source, table identity, qualifier, physical name, and portable or supplied primary key;
4. each field's static schema, generated schema, selected value, column identity, physical type, default, nullability, generation, and cross-property checks;
5. hook patch compatibility and required Core create guarantees;
6. table-wide column, primary-key, index, constraint, and identity checks;
7. relations in callback return order; and
8. flat schema key collisions.

Static and generated schema facts do not silently beat explicit physical metadata. A direct Drizzle column or table can supply physical evidence when lower-tier SQL or database metadata is absent. If explicit lower-tier metadata exists, the Drizzle value must agree with it. A mismatch is a definition issue.

A table-valued `records` entry and a table-valued override for the same key conflict unless the override is the selected host replacement. A complete table conflicts with separate column-builder replacements and second table extra configuration for that same Record. Relation keys must not collide with Record or relation keys.

## Definition Failures

Definition throws synchronously with one error containing all independent issues:

```ts
export type DrizzleDefinitionIssueCode =
  | SqlDefinitionIssueCode
  | "schema-generators-required"
  | "invalid-schema-generator"
  | "unsupported-schema-family"
  | "invalid-generated-schema"
  | "incompatible-generated-schema"
  | "invalid-drizzle-table"
  | "incompatible-drizzle-table"
  | "invalid-drizzle-column"
  | "incompatible-drizzle-column"
  | "invalid-drizzle-override"
  | "invalid-before-create-hook"
  | "invalid-drizzle-relations"
  | "duplicate-schema-key";

export interface DrizzleDefinitionIssue {
  readonly code: DrizzleDefinitionIssueCode;
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly cause?: unknown;
}

export declare class DrizzleDefinitionError extends Error {
  readonly name: "DrizzleDefinitionError";
  readonly issues: readonly DrizzleDefinitionIssue[];
}
```

The concrete definition absorbs lower-tier SQL definition issues into this one ordered issue list. A failed table or field suppresses only checks that depend on that value. Independent Records, fields, hooks, and relation return entries continue when they can be checked safely.

Messages and causes can contain application data and are not safe for default logs or telemetry.

## Live Binding

Definition and live binding are separate:

```ts
const definition = DrizzlePostgresStore.define({
  schemas,
  records,
  overrides,
  relations,
  hooks,
});

const database = drizzle(hostClient, {
  schema: definition.schema,
});

const store = await bindPostgresStore({
  definition,
  database,
});

const transactionStore = await bindPostgresStore({
  definition,
  database,
  transaction: true,
});

const mysqlStore = await bindMysqlStore({
  definition: mysqlDefinition,
  database: mysqlDatabase,
});
```

Binding:

- accepts an existing configured Drizzle database;
- uses public Drizzle SQL and database APIs instead of native clients;
- performs the concrete adapter's server and transaction probes;
- verifies that the concrete path can preserve every interface in its declared return type;
- retains the definition's hooks and adjusted create inputs;
- returns native-Promise Store methods; and
- can reuse one definition with several compatible database instances.

Binding does not create or close the database client, run DDL, compare migrations, or add relations to an existing database object. PostgreSQL does not inspect live table structure. MySQL has one narrow exception: binding confirms that each defined physical table is the expected base table and uses InnoDB. It does not infer columns, keys, or indexes from the live schema.

PostgreSQL has one public binder. Omitted or false `transaction` returns `SqlStore`. Literal true returns `SqlStore & TransactionStore` and rejects when the common Drizzle transaction probe cannot prove the effective server settings.

MySQL also has one public binder. Omitted or false `transaction` returns `SqlStore`. Literal true returns `SqlStore & TransactionStore`. Every binding requires actual Oracle MySQL 8.4 or later, a working Drizzle transaction callback, effective serializable settings, and InnoDB for all defined tables. The host must configure every possible connection with a UTC session time zone.

Neither adapter exposes a public driver matrix, runtime driver-class switch, or native-client bridge. A binding failure rejects with a concrete adapter error before a Store value exists. Later Store operations use the approved Store and SQL Store error contracts. The [Drizzle PostgreSQL Store adapter specification](drizzle-postgres-store.md) and [Drizzle MySQL Store adapter specification](drizzle-mysql-store.md) define the exact probes, behavior, and errors.

## Generic and Thread Definitions

Generic and Thread definitions use separate constructors and the same internal lifecycle:

```ts
const postgresDefinition = DrizzlePostgresStore.define(options);
const postgresThreadDefinition = DrizzlePostgresThreadStore.define(options);
const mysqlDefinition = DrizzleMysqlStore.define(options);
const mysqlThreadDefinition = DrizzleMysqlThreadStore.define(options);
```

Each generic definition uses the supplied Record catalog. Each Thread definition adds every Core Record, applies host overrides, validates Core compatibility, calculates required hook patches, and then runs the same Drizzle normalization. There is no `includeCore` flag.

The database's one binder accepts either matching definition and returns its generic Store backend. Core composes a Thread definition's backend with `createThreadStore`. An adapter does not export a separate Thread Store binder.

The constructors are concrete factory values, not database-named runtime Store interfaces.

## Approval Scenarios

The compile-tested prototype covers these shared scenarios:

1. a plain Drizzle table becomes a Record without static schemas when the three schema generators exist;
2. every TypeScript table column key becomes a selected Record Field;
3. a static field schema overrides generated schema evidence;
4. a hook returns a patch and makes only its guaranteed required field optional for create;
5. an unrelated required field stays required at compile time;
6. a database default remains independently optional for create;
7. relations run after all tables and enter the flat schema under their returned key; and
8. runtime creation merges the hook patch and a column default.

Prototype: `packages/store/prototypes/shared-drizzle-definition-lifecycle.prototype.ts`.

Run it with:

```sh
pnpm exec tsc --ignoreConfig --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext packages/store/prototypes/shared-drizzle-definition-lifecycle.prototype.ts
pnpm exec bun packages/store/prototypes/shared-drizzle-definition-lifecycle.prototype.ts
```

Expected runtime output:

```json
{
  "schemaKeys": ["someRecord", "someRecordRelations"],
  "created": { "id": "record-1", "tenantId": "tenant-from-hook", "archived": false }
}
```

## Deferred Decisions

The following remain in later tickets:

- root and subpath exports;
- package peer and optional dependencies;
- supported SQLite driver groups;
- concrete SQLite database and transaction types;
- SQLite raw SQL result normalization;
- SQLite CRUD translation and generated-value recovery;
- SQLite transaction implementation and conformance;
- concrete SQLite binding errors and probe queries; and
- complete cross-dialect approval.

## References

- [ADR 0019: Build Thread Store on generic Store primitives](../adr/0019-build-thread-store-on-generic-store-primitives.md)
- [Store Architecture Technical Specification](store.md)
- [SQL Store Tier Technical Specification](sql-store.md)
- [Drizzle API research](https://github.com/spiritledsoftware/commissary/issues/26#issuecomment-5166874940)
- [Shared lifecycle issue](https://github.com/spiritledsoftware/commissary/issues/14)
