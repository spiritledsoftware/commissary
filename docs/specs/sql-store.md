# SQL Store Tier Technical Specification

> **Status**: Complete SQL and Drizzle Store specification approved for implementation in issue #19.
>
> **Last updated**: 2026-08-08 during final cross-adapter approval.

## Summary

Add a portable SQL Store specialization and Drizzle-independent PostgreSQL, MySQL, and SQLite Record metadata to `@commissary/store`. The package gains one immutable SQL Record definition form, optional portable primary-key metadata, symmetric portable and database metadata helpers, one opaque SQL Statement algebra, shared adapter helpers, SQL errors, and shared conformance tests.

The `SqlStore` interface remains portable. SQL text can use one database dialect. `query()` returns one unchecked caller-typed row array. `execute()` returns one normalized command wrapper with an optional verified affected-row count and the exact driver result. Integrations can add PostgreSQL, MySQL, or SQLite refinements without an ORM dependency, while hosts call only their selected concrete adapter.

This specification extends the [Store Architecture Technical Specification](store.md). That specification remains authoritative for Records, Collections, operators, Store errors, and transactions except where this document gives a later rule.

## Goals

- Let integrations require SQL without depending on an ORM or driver.
- Keep SQL structure separate from bound values until execution.
- Compile lower-tier Record definitions into SQL storage intent.
- Preserve Standard Schema validation and Store inference.
- Give hosts safe resolved table and column references.
- Keep SQL and Collection work in one physical transaction when a Store supports both capabilities.
- Give adapter authors one Statement compiler with exact parameter segments and one transaction callback runner.
- Define deterministic conformance controls without exposing driver state on production Stores.

## Non-Goals

- Make SQL text portable between databases.
- Parse or validate returned rows.
- Add preparation, streaming, cancellation, session reservation, batches, or ordered multiple results.
- Invent affected counts, generated identifiers, warnings, or notices that a driver does not report.
- Add indexes other than an optional primary key, relations, migrations, schema diffing, introspection, or client creation.
- Make resolved Record references a database permission or security boundary.
- Apply Collection Field Schemas, Hooks, expressions, generated values, or field conversion to direct SQL.
- Add an Effect-specific SQL definition interface. `@commissary/store` keeps one plain JavaScript interface. A later `@commissary/effect` adapter must earn its own seam.

## Invariants

1. **One Store specialization**: `SqlStore` extends `Store` and adds `query` and `execute`.
2. **One Statement algebra**: Complete statements, fragments, raw text, identifiers, parameters, joins, and resolved Record references use `SqlStatement`.
3. **Opaque values**: Only package helpers and resolved definitions create valid SQL Statements, SQL Column Types, SQL Literals, and SQL Record References.
4. **Compatible copies**: Compatible installed copies accept the same opaque value format. Incompatible formats and plain lookalikes fail before driver work.
5. **Immutable structure**: Package-owned Statement and definition structure is snapshotted and frozen. Bound wider values and third-party schema objects remain by reference.
6. **Native Promise boundary**: `query`, `execute`, and transaction helpers return a native Promise before validation, conversion, callbacks, or driver work. They never throw synchronously.
7. **One driver statement call**: One `query` or `execute` call makes at most one driver statement call and performs no retry.
8. **Visible result mode**: `query` is for one row-producing result. `execute` is for a statement that produces no row set.
9. **Unchecked rows**: `query` row containers and members are driver values under an unchecked caller-selected type. Callers own parsing and cardinality checks.
10. **Portable values**: Every generic SQL Store accepts `null`, boolean, finite number, and NUL-free string.
11. **No array expansion**: An array interpolation is one parameter. Only explicit Statements can add SQL structure.
12. **Source order**: Parameter encoding, support checks, portable validation, and conversion run from left to right and stop at the first failure.
13. **Definition precedence**: Active database metadata wins over portable metadata, which wins over Select Schema reflection, which wins over adapter defaults.
14. **Select-owned storage**: Defined create, update, generated, and decoded values become the output of the effective Select Field Schema before storage or selection.
15. **No inferred database default**: Create Schema defaults and JSON Schema annotations never become database defaults.
16. **One physical transaction**: SQL and Collection work in one transaction callback use the same physical transaction.
17. **Closed transaction view**: A transaction view closes when its callback settles. Later methods reject without driver work.
18. **No rollback race**: Active transaction work drains before rollback starts.
19. **Caught failure still fails**: A rejected transaction-view operation marks the transaction for rollback even when callback code catches it.
20. **Exact rollback failure**: Successful rollback preserves the selected callback boundary failure without wrapping it.
21. **No manual control guarantee**: Transaction guarantees apply only when callers do not submit manual transaction SQL through `query` or `execute`.
22. **Capability over database identity**: Database identity alone does not create a Store specialization. Concrete adapters compose primitive contracts, and a focused capability requires a proven caller workflow.
23. **Optional primary key**: A SQL Record can name one nonempty primary-key field tuple. SQL tables without a primary key remain valid.
24. **Exact parameter segments**: Compiled Statements retain the exact text segments around parameters, so an ORM adapter never parses generated placeholder text.

## Confirmed Decisions

### Package and interface ownership

`@commissary/store` owns:

- SQL Record definition and reference types;
- portable SQL Column Types and SQL Literals;
- SQL Statement construction;
- Drizzle-independent PostgreSQL, MySQL, and SQLite Record metadata helpers;
- the adapter-facing database Record resolvers;
- `SqlStore` and SQL errors;
- the `@commissary/store/sql/adapter` Statement compiler;
- the `@commissary/store/transaction-adapter` callback runner; and
- the `@commissary/store/sql/conformance` types and suites.

Caller-facing SQL contracts and helpers use `@commissary/store/sql`. Generic Store contracts remain at the root, and generic conformance remains at `@commissary/store/conformance`.

Database-specific metadata helpers use `@commissary/store/sql/postgres`, `@commissary/store/sql/mysql`, and `@commissary/store/sql/sqlite`. Each database Record resolver uses the matching `/adapter` subpath.

Concrete adapters own:

- database clients, credentials, pools, and resource lifetime;
- driver result recognition;
- physical transaction start, commit, rollback, and release;
- mapping resolved database Record assets into ORM or driver runtime values;
- concrete adapter definition and live Store factories;
- database-specific parameter and result facts; and
- optional driver features outside this tier.

There is no standalone `SqlExecutor`, exported `SqlTag`, or production alias for a combined SQL Transaction Store. Code can use `typeof sql` when it needs the tag type. Tests use an inline intersection for the combined capability.

### Database-specific runtime seams

Do not export general `PostgresStore`, `MySqlStore`, or `SqliteStore` runtime interfaces or aliases. Database identity, dialect syntax, metadata, result shape, and thin query aliases do not by themselves earn a Store specialization.

A concrete database or ORM adapter returns a structural composition of the primitive Store contracts that it implements, such as `SqlStore` and `TransactionStore`. It can accept more SQL parameter types and preserve its public driver result through `SqlCommandResult.driverResult` while it remains assignable to generic `SqlStore`. A caller typed against generic `SqlStore` sees normalized `affectedRows` and an `unknown` driver result. This structural widening does not earn a database-named tier.

A new focused Store capability requires:

1. a proven integration-facing workflow that a lower-tier Store cannot preserve;
2. an observable stream, callback, resource scope, cleanup rule, result lifecycle, or engine guarantee;
3. a deletion test that shows real caller behavior would otherwise be lost; and
4. at least one working adapter path.

Driver- and ORM-independent primitive contracts belong in `@commissary/store`. Driver- or ORM-specific contracts remain in their adapter package. Do not add speculative optional methods or a runtime capability registry.

PostgreSQL notifications, copy streams, portals, and advisory locks; MySQL local infile streams, ordered multiple results, and session locks; and SQLite backup, serialization, hooks, and changesets are separate workflows. They do not form coherent database-wide Store interfaces. Add one only when a caller and adapter satisfy the focused capability rules.

### SQL Record definitions

A SQL Record definition remains a valid base `RecordDefinition`. Memory and other lower-tier Stores use its Field Schemas and ignore SQL metadata. SQL adapters compile the same effective definition after contributions and host overrides.

Provide two definition helpers:

- `StoreRecord.define()` for immutable base definitions; and
- `SqlRecord.define()` for immutable definitions with SQL intent.

Plain structural definitions remain valid. Do not add `PostgresRecord`, `MySqlRecord`, or `SqliteRecord` constructors. Database-specific metadata stays under the named `postgres`, `mysql`, and `sqlite` properties and becomes typed at the matching database definition seam.

The public type shape is:

```ts
export type SqlLiteralValue = string | number | boolean;
export type SqlCustomEncodedValue = string | number | boolean | Uint8Array;

export interface SqlColumnType<in Value extends JsonValue> {
  // Opaque package-owned value family and conversion contract.
}

export interface SqlLiteral<out Value extends SqlLiteralValue> {
  // Opaque package-owned portable database default.
}

export interface SqlTableDefinition {
  readonly name?: string;
  readonly primaryKey?: readonly [string, ...string[]];
  readonly postgres?: object;
  readonly mysql?: object;
  readonly sqlite?: object;
}

export interface SqlColumnDefinition<Value extends JsonValue> {
  readonly name?: string;
  readonly type?: SqlColumnType<Value>;
  readonly default?: SqlLiteral<Extract<Value, SqlLiteralValue>>;
  readonly notNull?: boolean;
  readonly postgres?: object;
  readonly mysql?: object;
  readonly sqlite?: object;
}

type SqlFieldDefinition<Field extends FieldDefinition> = Field extends FieldSchema
  ? Field
  : Field & {
      readonly column?: SqlColumnDefinition<
        Exclude<FieldOutput<SelectFieldSchema<Field>>, undefined>
      >;
    };

export type SqlRecordDefinition<Definition extends RecordDefinition> = Omit<
  Definition,
  "fields"
> & {
  readonly table?: SqlTableDefinition;
  readonly fields: {
    readonly [Name in keyof Definition["fields"]]: SqlFieldDefinition<Definition["fields"][Name]>;
  };
};

type RoundTripDefinition<Definition extends RecordDefinition> = Definition & {
  readonly fields: RoundTripFieldDefinitions<Definition["fields"]>;
};

export declare const StoreRecord: {
  readonly define: <const Definition extends RecordDefinition>(
    definition: RoundTripDefinition<Definition>,
  ) => Readonly<Definition>;
};

export declare const SqlRecord: {
  readonly define: <const Definition extends RecordDefinition>(
    definition: RoundTripDefinition<Definition> & SqlRecordDefinition<Definition>,
  ) => Readonly<Definition & SqlRecordDefinition<Definition>>;
};

export declare const sql: {
  readonly table: <const Table extends SqlTableDefinition>(table: Table) => Readonly<Table>;
  readonly column: <Value extends JsonValue, const Column extends SqlColumnDefinition<Value>>(
    column: Column,
  ) => Readonly<Column>;
  // Statement, type, and literal constructors are shown below.
};
```

`SqlCustomEncodedValue` is the one driver-independent storage-edge output for custom column encoders. Numbers must be finite at runtime. SQL `NULL` bypasses custom encoders and is not part of this union.

The named database metadata properties accept an object at the portable stage and preserve its inferred type. The matching database helper gives integration authors a typed, locally validated object. The matching adapter resolver activates it after contributions and overrides. This rule avoids global type augmentation and keeps ORM and driver types out of `@commissary/store`.

`table.primaryKey` contains logical Record field names in primary-key order. `SqlRecord.define()` preserves its tuple and checks it against the same definition's `fields`. The tuple must be nonempty, contain no duplicate name, name only existing fields, and resolve only to non-null columns. A composite key is valid. An omitted key means that the SQL Record declares no portable primary key.

`sql.table()` and `sql.column()` are the recommended metadata authoring helpers. They snapshot and freeze their package-owned options. Plain structural metadata remains valid, and typed deep overrides can use helpers or plain patches.

#### Portable column types and defaults

The `sql` value includes these constructors:

```ts
sql.table(options);
sql.column(options);
sql.text();
sql.number();
sql.integer();
sql.boolean();
sql.json();
sql.literal(value);
```

Their contracts are:

- `text()` accepts selected strings and selected null.
- `number()` accepts finite JavaScript binary64 numbers and selected null.
- `integer()` accepts safe JavaScript integers and selected null. Storage uses a signed 64-bit integer family, but writes and reads must not lose JavaScript precision.
- `boolean()` accepts booleans and selected null.
- `json()` accepts JSON values. SQL `NULL` means a missing field; selected JSON `null` remains JSON `null`.
- `literal()` accepts a string, finite number, safe integer, or boolean. It rejects NUL strings, non-finite numbers, and unsafe integer values.

Portable defaults do not include `null`, JSON, current time, UUID generation, identity, sequences, or SQL expressions. Those values need database-specific metadata.

#### Portable physical mappings

Each database resolver maps an active portable type, including a type inferred from Select evidence, to one final physical direct type:

| Portable contract | Application value     | PostgreSQL         | MySQL           | SQLite                                |
| ----------------- | --------------------- | ------------------ | --------------- | ------------------------------------- |
| `sql.text()`      | `string`              | `TEXT`             | `TEXT`          | `TEXT`                                |
| `sql.number()`    | finite `number`       | `DOUBLE PRECISION` | `DOUBLE`        | `REAL`                                |
| `sql.integer()`   | safe integer `number` | `BIGINT`           | signed `BIGINT` | `INTEGER`                             |
| `sql.boolean()`   | `boolean`             | `BOOLEAN`          | `BOOLEAN`       | `INTEGER` with zero-or-one conversion |
| `sql.json()`      | `JsonValue`           | `JSON`             | `JSON`          | `TEXT` with JSON conversion           |

The safe-number codec on portable `sql.integer()` remains distinct from the exact-string codec on explicit `pg.bigint()` and `mysql.bigint()`, even though the physical PostgreSQL and MySQL type is `BIGINT`. An active database-specific type still wins over this mapping.

#### Select Schema reflection

An explicit `column.type` wins and prevents reflection work for that field. Without an explicit type, the definition resolver:

1. checks for the Standard JSON Schema output converter;
2. requests Draft 2020-12 output;
3. retries once with Draft 07 when the first conversion throws or returns unusable output;
4. resolves local references with cycle detection;
5. reduces `type`, `const`, `enum`, `anyOf`, `oneOf`, and `allOf` to one storage family; and
6. reports `column-type-required` when the result is missing, unconstrained, mixed, remote, invalid, or unclear.

A union can include JSON `null` and still resolve from its one non-null family. `integer` plus `number` resolves to `number`. A string and number union is unclear. Object and array both resolve to `json`. Validation constraints, enum checks, lengths, formats, and annotations do not become SQL constraints.

Only Select output reflection controls inference. Create and Update Schemas need no Standard JSON Schema converter.

#### Null and missing fields

Use final Select evidence and explicit metadata:

```txt
required string | null -> SQL NULL can represent selected null
optional string        -> SQL NULL can represent missing
optional string | null -> three states; requires an explicit representation
```

For `sql.json()`, SQL `NULL` represents missing and a JSON encoding represents selected JSON `null`.

Generate `NOT NULL` only from final evidence or `column.notNull: true`. `column.notNull: false` forces a nullable column. Unknown presence stays nullable. The database-specific tier must reject a representation that cannot preserve every selected state.

#### Contributions and overrides

`records` contains new complete Record contributions. `overrides` changes an existing contribution. A key cannot silently act as both.

Override rules are Store-neutral:

- An override is a typed deep patch.
- `null` removes exactly one inherited optional setting.
- Unspecified settings remain unchanged.
- A new field in an override must be a complete Field Definition.
- Existing fields accept partial patches.
- Contributor Record and field keys cannot be removed.
- Duplicate contributions fail before overrides. The host must select or rename a contribution explicitly.
- Integration conflicts never merge by order.

Static compatibility requires:

```ts
SelectedRecord<Effective> extends SelectedRecord<Contributor>;
CreateInput<Contributor> extends CreateInput<Effective>;
UpdateInput<Contributor> extends UpdateInput<Effective>;
```

This rule permits a string-to-UUID refinement and rejects a string-to-number replacement. A runtime refinement can still reject a contributor value. The host owns that risk.

After the patch, the definition stage rebuilds all reflection and physical metadata. It never retains stale facts from the contributor.

#### Definition lifecycle and failures

Definition has two synchronous, I/O-free stages:

1. `StoreRecord.define()` or `SqlRecord.define()` checks local structure, including portable primary-key field names, snapshots package-owned containers, and returns an immutable unbound definition.
2. A concrete database definition combines contributions and overrides, resolves storage intent, primary-key columns, and physical names, checks conflicts, and returns resolved references plus its database-specific assets.

Do not clone or freeze third-party schema objects. Snapshot and freeze package-owned field wrappers, table and column metadata, primary-key tuples, override results, SQL opaque values, and references.

A failed SQL definition stage throws one `SqlDefinitionError` with all independent issues:

```ts
export type SqlDefinitionIssueCode =
  | "invalid-definition"
  | "invalid-name"
  | "duplicate-name"
  | "conflicting-contribution"
  | "column-type-required"
  | "invalid-column-type"
  | "invalid-column-default"
  | "invalid-database-options"
  | "invalid-override"
  | "incompatible-override"
  | "invalid-primary-key";

export interface SqlDefinitionIssue {
  readonly code: SqlDefinitionIssueCode;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export declare class SqlDefinitionError extends Error {
  readonly name: "SqlDefinitionError";
  readonly issues: readonly SqlDefinitionIssue[];
}
```

A table or column name must be a nonempty NUL-free string. Omitted table and column names use their exact catalog and field keys. There is no automatic case conversion, pluralization, or snake-case conversion. Equal final physical names are definition errors. Database-specific qualification and identifier limits belong to the matching database tier.

Primary-key entries use logical field names. Definition reports `invalid-primary-key` for an empty tuple, duplicate or unknown field, a field that can remain missing or null, or a conflict with database-specific table metadata. A primary key contributes a database constraint only when a concrete definition generates the physical table. Binding a supplied table verifies its declared primary key instead.

#### Core SQL catalog

Core publishes the following exact physical catalog from the same definitions that own its Field Schemas. All table names use the `commissary_` prefix. All physical column names are explicit snake-case names. Core and adapters perform no automatic case conversion, pluralization, or snake-case conversion.

| Core Record key       | Physical table                     | Primary-key field tuple   |
| --------------------- | ---------------------------------- | ------------------------- |
| `thread`              | `commissary_threads`               | `["id"]`                  |
| `branch`              | `commissary_branches`              | `["id"]`                  |
| `message`             | `commissary_messages`              | `["id"]`                  |
| `run`                 | `commissary_runs`                  | `["id"]`                  |
| `toolCall`            | `commissary_tool_calls`            | `["runId", "toolCallId"]` |
| `executionClaim`      | `commissary_execution_claims`      | `["runId"]`               |
| `executionFence`      | `commissary_execution_fences`      | `["runId"]`               |
| `pendingSteering`     | `commissary_pending_steerings`     | `["runId", "sequence"]`   |
| `pendingRedirect`     | `commissary_pending_redirects`     | `["runId", "sequence"]`   |
| `runCommandSequence`  | `commissary_run_command_sequences` | `["runId"]`               |
| `toolCallSequence`    | `commissary_tool_call_sequences`   | `["runId"]`               |
| `runSubmission`       | `commissary_run_submissions`       | `["runId"]`               |
| `toolResumeRequest`   | `commissary_tool_resume_requests`  | `["runId", "requestId"]`  |
| `steeringRequest`     | `commissary_steering_requests`     | `["runId", "requestId"]`  |
| `redirectRequest`     | `commissary_redirect_requests`     | `["runId", "requestId"]`  |
| `commit`              | `commissary_commits`               | `["commitId"]`            |
| `finalizationOutcome` | `commissary_finalization_outcomes` | `["commitId"]`            |
| `modelCommitOutcome`  | `commissary_model_commit_outcomes` | `["commitId"]`            |
| `settlementOutcome`   | `commissary_settlement_outcomes`   | `["commitId"]`            |

Every Core Field declares the following exact physical name:

```ts
const coreSqlColumnNames = {
  thread: {
    id: "id",
  },
  branch: {
    id: "id",
    threadId: "thread_id",
    name: "name",
    head: "head",
  },
  message: {
    id: "id",
    threadId: "thread_id",
    parent: "parent",
    message: "message",
  },
  run: {
    id: "id",
    threadId: "thread_id",
    branchId: "branch_id",
    agent: "agent",
    admittedHead: "admitted_head",
    status: "status",
    abortRequested: "abort_requested",
    settlementContinuations: "settlement_continuations",
    usage: "usage",
    abortReason: "abort_reason",
    result: "result",
  },
  toolCall: {
    toolCallId: "tool_call_id",
    runId: "run_id",
    sequence: "sequence",
    toolName: "tool_name",
    parentToolCallId: "parent_tool_call_id",
    providerId: "provider_id",
    delegationKey: "delegation_key",
    requestedInput: "requested_input",
    effectiveInput: "effective_input",
    status: "status",
    result: "result",
    suspension: "suspension",
    providerData: "provider_data",
    historyCommitted: "history_committed",
  },
  executionClaim: {
    runId: "run_id",
    executionId: "execution_id",
    token: "token",
    fence: "fence",
    expiresAt: "expires_at",
  },
  executionFence: {
    runId: "run_id",
    fence: "fence",
  },
  pendingSteering: {
    runId: "run_id",
    sequence: "sequence",
    message: "message",
  },
  pendingRedirect: {
    runId: "run_id",
    sequence: "sequence",
    message: "message",
  },
  runCommandSequence: {
    runId: "run_id",
    sequence: "sequence",
  },
  toolCallSequence: {
    runId: "run_id",
    sequence: "sequence",
  },
  runSubmission: {
    runId: "run_id",
    fingerprint: "fingerprint",
    result: "result",
  },
  toolResumeRequest: {
    runId: "run_id",
    requestId: "request_id",
    fingerprint: "fingerprint",
    result: "result",
  },
  steeringRequest: {
    runId: "run_id",
    requestId: "request_id",
    fingerprint: "fingerprint",
    result: "result",
  },
  redirectRequest: {
    runId: "run_id",
    requestId: "request_id",
    fingerprint: "fingerprint",
    result: "result",
  },
  commit: {
    commitId: "commit_id",
    fingerprint: "fingerprint",
  },
  finalizationOutcome: {
    commitId: "commit_id",
    outcome: "outcome",
  },
  modelCommitOutcome: {
    commitId: "commit_id",
    outcome: "outcome",
  },
  settlementOutcome: {
    commitId: "commit_id",
    outcome: "outcome",
  },
} as const;
```

These existing logical key tuples are the portable primary keys. Core string primary-key components accept at most 95 Unicode code points. Generated MySQL tables use `VARCHAR(95)` for them; generated PostgreSQL and SQLite tables use their portable text mapping. This bound keeps the largest two-string `utf8mb4` Core key within the 768-byte InnoDB key limit for a 4 KiB page.

Core sequences, fences, counters, and expiry times are nonnegative safe integers in their Field Schemas and use `sql.integer()`. Core booleans use `sql.boolean()`, JSON values use `sql.json()`, and other strings use `sql.text()`. Core imports no ORM or driver type.

#### Resolved SQL Record references

A concrete definition result exposes every resolved Record under `.records`:

```ts
export interface SqlFieldReference extends SqlStatement<never> {
  // Opaque resolved column identifier.
}

export interface SqlRecordReference<
  Definition extends RecordDefinition,
> extends SqlStatement<never> {
  readonly fields: {
    readonly [Name in keyof Definition["fields"]]: SqlFieldReference;
  };
}

export type SqlRecordReferences<Definitions extends RecordDefinitions> = {
  readonly [Name in keyof Definitions]: SqlRecordReference<Definitions[Name]>;
};
```

A Record reference is the final table identifier. Its field references are final column identifiers. References are connection-independent and have no public raw-name property. They provide SQL structure only and do not convert direct-SQL parameters.

The same immutable definition can be registered under several catalog keys. Each registration gets its own resolved reference. References can be composed across definitions and used on any suitable SQL connection. The database remains the authority for existence and permissions.

#### Cross-database resolution contract

The Drizzle compatibility authority for all three specializations is the latest state of the `main` branch. Only capabilities that a planned concrete adapter can preserve are public.

Every database resolution contains final physical facts. It does not retain whether a type came from portable metadata, database metadata, or Select reflection. A resolved direct type names the final database type and physical options; its synchronous `encode` and `decode` functions preserve the selected application contract. Concrete adapters map this plan into ORM or driver values without parsing type text.

Resolved generated-column data uses one adapter-facing shape:

```ts
export interface SqlResolvedGeneratedColumn {
  readonly expression: SqlStatement<never>;
  readonly mode: "virtual" | "stored";
}
```

PostgreSQL always resolves generated columns with `mode: "stored"`. MySQL and SQLite preserve their explicit virtual or stored mode.

All database resolvers use this issue-order skeleton:

1. contribution and override issues;
2. each table's qualifier, name, format, and portable primary-key structure;
3. each field's name, opaque identity, storage evidence, Select compatibility, type contract, default, nullability, generation or identity metadata, and cross-property checks;
4. table-wide primary-key resolution, database rules, and column collisions; and
5. catalog namespace or table collisions.

Database-specific checks stay in their related slot. Record and field declaration order control traversal. Primary-key field order controls its own checks. First use controls ties between owned assets, and the issue belongs to the later asset. A check with an invalid prerequisite is skipped; every independent check continues.

Resolution performs no database I/O and cannot prove a live engine, driver path, session setting, supplied-table primary key, host index, or host constraint. The concrete adapter binding stage must reject a live configuration that cannot preserve the complete resolved plan before it returns a Store.

### PostgreSQL Record specialization

The PostgreSQL specialization targets PostgreSQL 15 and later. It defines Drizzle-independent metadata and resolution assets. It does not create a PostgreSQL-named runtime Store interface.

#### Ownership and authoring

An integration adds PostgreSQL intent to its one lower-tier SQL Record:

```ts
const ScheduledJob = SqlRecord.define({
  table: sql.table({
    name: "scheduled_jobs",
    postgres: pg.table({
      schema: "jobs",
    }),
  }),
  fields: {
    id: {
      select: jobIdSchema,
      column: sql.column({
        type: sql.text(),
        postgres: pg.column({
          type: pg.uuid(),
          default: sql`gen_random_uuid()`,
          notNull: true,
        }),
      }),
    },
  },
});
```

`pg.table()` and `pg.column()` create only PostgreSQL refinements. They do not resolve a catalog or create adapter assets. Do not add `PostgresSql.define()`, `PostgresSqlStore.define()`, or another host-facing PostgreSQL definition factory. A host calls only its selected concrete adapter, such as the later `DrizzlePostgresStore.define()`.

`@commissary/store/sql/postgres/adapter` exposes the synchronous, I/O-free resolver used by concrete adapters:

```ts
export declare function resolvePostgresRecords<
  const Definitions extends RecordDefinitions,
  const Overrides extends RecordOverrides<Definitions> = {},
>(options: {
  readonly records: Definitions;
  readonly overrides?: Overrides;
}): PostgresRecordResolution<ApplyOverrides<Definitions, Overrides>>;

export interface PostgresRecordResolution<Definitions extends RecordDefinitions> {
  readonly records: SqlRecordReferences<Definitions>;
  readonly tables: PostgresResolvedTables<Definitions>;
  readonly enums: readonly PostgresResolvedEnum[];
}
```

The resolver applies contributions and overrides, activates `postgres` metadata, rebuilds inference, validates the effective catalog, and returns immutable resolved references and adapter assets. It contains no generated DDL, Drizzle values, indexes, relations, or migration data.

#### Public PostgreSQL metadata

The rough public types are:

```ts
export interface PostgresColumnType<in Value extends JsonValue> extends SqlColumnType<Value> {
  // Opaque package-owned PostgreSQL storage and conversion contract.
}

export interface PostgresTableDefinition {
  readonly schema?: string | null;
  readonly name?: string | null;
}

export interface PostgresColumnDefinition<Value extends JsonValue> {
  readonly name?: string | null;
  readonly type?: PostgresColumnType<Value> | null;
  readonly default?: SqlLiteral<Extract<Value, SqlLiteralValue>> | SqlStatement<never> | null;
  readonly notNull?: boolean | null;
  readonly identity?: PostgresIdentity | null;
  readonly generated?: SqlStatement<never> | null;
}

export interface PostgresQualifiedName {
  readonly schema?: string;
  readonly name: string;
}

export interface PostgresIdentitySequence {
  readonly name?: PostgresQualifiedName;
  readonly startWith?: number | bigint;
  readonly incrementBy?: number | bigint;
  readonly minValue?: number | bigint;
  readonly maxValue?: number | bigint;
  readonly cache?: number | bigint;
  readonly cycle?: boolean;
}

export interface PostgresIdentity {
  readonly mode: "always" | "by-default";
  readonly sequence?: PostgresIdentitySequence;
}

export interface PostgresNumericOptions {
  readonly precision?: number;
  readonly scale?: number;
}

export interface PostgresCharacterOptions {
  readonly length?: number;
}

export type PostgresTemporalPrecision = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface PostgresTemporalOptions {
  readonly precision?: PostgresTemporalPrecision;
  readonly withTimezone?: boolean;
}

export type PostgresIntervalFields =
  | "year"
  | "month"
  | "day"
  | "hour"
  | "minute"
  | "second"
  | "year to month"
  | "day to hour"
  | "day to minute"
  | "day to second"
  | "hour to minute"
  | "hour to second"
  | "minute to second";

export interface PostgresIntervalOptions {
  readonly fields?: PostgresIntervalFields;
  readonly precision?: PostgresTemporalPrecision;
}

export interface PostgresEnum<
  Values extends readonly [string, ...string[]],
> extends PostgresColumnType<Values[number]> {}

export interface PostgresCustomTypeOptions<Value extends JsonValue> {
  readonly type: PostgresQualifiedName & {
    readonly modifier?: SqlStatement<never>;
  };
  readonly encode: (value: Value) => SqlCustomEncodedValue;
  readonly decode: (value: unknown) => Value;
}

export declare const pg: {
  readonly table: <const Options extends PostgresTableDefinition>(
    options: Options,
  ) => Readonly<Options>;
  readonly column: <Value extends JsonValue, const Options extends PostgresColumnDefinition<Value>>(
    options: Options,
  ) => Readonly<Options>;

  readonly smallint: () => PostgresColumnType<number>;
  readonly integer: () => PostgresColumnType<number>;
  readonly bigint: () => PostgresColumnType<string>;
  readonly numeric: (options?: PostgresNumericOptions) => PostgresColumnType<string>;
  readonly real: () => PostgresColumnType<number>;
  readonly doublePrecision: () => PostgresColumnType<number>;

  readonly boolean: () => PostgresColumnType<boolean>;
  readonly char: (options?: PostgresCharacterOptions) => PostgresColumnType<string>;
  readonly varchar: (options?: PostgresCharacterOptions) => PostgresColumnType<string>;
  readonly text: () => PostgresColumnType<string>;
  readonly uuid: () => PostgresColumnType<string>;
  readonly json: () => PostgresColumnType<JsonValue>;
  readonly jsonb: () => PostgresColumnType<JsonValue>;
  readonly bytea: () => PostgresColumnType<string>;

  readonly date: () => PostgresColumnType<string>;
  readonly time: (options?: PostgresTemporalOptions) => PostgresColumnType<string>;
  readonly timestamp: (options?: PostgresTemporalOptions) => PostgresColumnType<string>;
  readonly interval: (options?: PostgresIntervalOptions) => PostgresColumnType<string>;

  readonly inet: () => PostgresColumnType<string>;
  readonly cidr: () => PostgresColumnType<string>;
  readonly macaddr: () => PostgresColumnType<string>;
  readonly macaddr8: () => PostgresColumnType<string>;
  readonly point: () => PostgresColumnType<{
    readonly x: number;
    readonly y: number;
  }>;
  readonly line: () => PostgresColumnType<{
    readonly a: number;
    readonly b: number;
    readonly c: number;
  }>;

  readonly enum: <const Values extends readonly [string, ...string[]]>(options: {
    readonly schema?: string;
    readonly name: string;
    readonly values: Values;
  }) => PostgresEnum<Values>;
  readonly array: <Value extends JsonValue>(
    element: PostgresColumnType<Value>,
  ) => PostgresColumnType<readonly Value[]>;
  readonly custom: <Value extends JsonValue>(
    options: PostgresCustomTypeOptions<Value>,
  ) => PostgresColumnType<Value>;
};
```

`PostgresColumnType<Value>` is contravariant. The resolver checks the defined Select output after removing `null` and `undefined`. This permits branded string refinements such as UUIDs. Helpers never replace Select, Create, or Update Schema inference.

#### Direct type behavior

Each direct helper has one driver-independent JSON-safe application value:

| PostgreSQL type                                   | Application value                                                |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `smallint`, `integer`, `real`, `double precision` | finite `number`                                                  |
| `bigint`, `numeric`                               | exact `string`                                                   |
| `boolean`                                         | `boolean`                                                        |
| `char`, `varchar`, `text`, `uuid`                 | `string`                                                         |
| `json`, `jsonb`                                   | `JsonValue`                                                      |
| `bytea`                                           | padded RFC 4648 base64 `string`                                  |
| `date`, `time`, `timestamp`, `interval`           | normalized ISO 8601 `string`                                     |
| `inet`, `cidr`, `macaddr`, `macaddr8`             | normalized `string`                                              |
| `point`                                           | `{ readonly x: number; readonly y: number }`                     |
| `line`                                            | `{ readonly a: number; readonly b: number; readonly c: number }` |
| enum                                              | its exact string literal union                                   |
| array                                             | readonly arrays of the element application value                 |

`numeric` preserves exact decimal text plus `NaN`, `Infinity`, and `-Infinity`. Timestamp with time zone normalizes to UTC with `Z`; timestamp without time zone has no offset. Temporal conversion preserves microseconds and expanded years. Interval uses ISO 8601 duration text. Non-finite `real`, `double precision`, point, and line numbers fail because they are not valid `JsonValue` numbers.

Supported type options are:

- `numeric`: precision 1 through 1000 and scale -1000 through 1000; scale requires precision;
- `char` and `varchar`: length 1 through 10,485,760; omitted `char` length means one and omitted `varchar` length means unlimited;
- `time` and `timestamp`: precision 0 through 6 and `withTimezone`;
- `interval`: the PostgreSQL field combinations and precision 0 through 6; a field-qualified precision requires seconds; and
- arrays: no declared size or dimension option because PostgreSQL does not enforce either.

Do not add aliases such as `int`, `decimal`, or `timestamptz`. Do not expose driver modes such as `Date`, JavaScript `bigint`, or `Buffer`.

PostgreSQL can apply its documented declared-type coercion, including `real` precision, `numeric(p,s)` rounding, `char(n)` padding, and temporal precision. The operation and Select Schema parsers validate field values first. The direct PostgreSQL column codec then validates only storage syntax, JSON safety, and type range before database work. It reports an invalid caller-supplied write value as `StoreValidationError`. The `pg.*` metadata constructors never inspect field values. Adapters decode the stored result instead of echoing an input that PostgreSQL can change. An invalid stored direct value uses `StoreAdapterContractViolation` with `"invalid-selected-record"`. `char` decoding removes storage padding, and application strings with trailing spaces fail during direct encoding.

A concrete PostgreSQL adapter must keep `date`, `time`, and `timestamp` values as strings at the resolved codec boundary. If its driver parses those OIDs into `Date` or other objects, the adapter must register text parsers or perform an equivalent lossless string conversion before calling the direct codec.

#### Arrays, enums, and custom types

`pg.array(element)` creates one application dimension. Nest it for more dimensions. Values must be rectangular. Selected PostgreSQL arrays must use one-based lower bounds because a plain JavaScript array cannot preserve another bound. SQL `NULL` elements are preserved and then checked by the Select Schema.

`pg.enum({ schema, name, values })` creates one reusable `PostgresEnum` column type and definition-owned asset. Value order is significant. Reuse the same opaque enum object across fields. Different enum objects with one qualified name conflict even when their values match. A custom type is only an external type reference and never becomes a definition-owned asset.

A custom type uses a separately quoted schema and name. Its optional modifier is a nonempty `SqlStatement<never>` placed inside parentheses, which supports specifications such as `vector(3)` and `geometry(Point, 4326)`. Definition checks that the modifier has no runtime parameters but does not parse it. PostGIS and pgvector types use this custom path.

Custom conversion is synchronous and driver-independent:

```txt
write: operation Schema -> Select Schema -> encode -> database
read:  database -> decode -> Select Schema -> Selected Record
```

SQL `NULL` bypasses conversion. The resolver snapshots function references but never invokes them. An encoder must return a `SqlCustomEncodedValue`; numbers must be finite. Other objects, arrays, Statements, Promises, `undefined`, and driver objects are invalid encoded values. Array conversion applies the scalar converter to each element.

#### Defaults, identity, and stored generation

PostgreSQL defaults and stored generated expressions accept `SqlStatement<never>`. Definition checks package origin, nonempty structure, and the actual absence of bound parameters. It does not parse SQL or validate functions, column references, subqueries, volatility, casts, or result types. PostgreSQL owns semantic expression validation, and `sql.raw()` remains trusted unchecked structure.

Identity supports `ALWAYS` and `BY DEFAULT` plus a qualified sequence name, `startWith`, `incrementBy`, `minValue`, `maxValue`, `cache`, and `cycle`. Integer controls accept a safe JavaScript integer or `bigint` and normalize to an exact integer. Definition rejects unsafe numbers, zero increments, cache below one, values outside the column type range, and inconsistent bounds.

Definition rejects:

- generated plus default;
- generated plus identity;
- identity plus an explicit default;
- identity when the final physical direct type is not `smallint`, `integer`, or `bigint`; portable `sql.integer()` maps to `bigint` and qualifies; and
- identity plus `notNull: false`.

Identity implies `NOT NULL`; explicit `notNull: true` is valid but redundant. A stored generated column can use a custom type and either nullability setting. An ordinary default can use a custom type.

Database metadata does not change `SelectedRecord`, `CreateInput`, or `UpdateInput`. Field Schemas remain their only source. Store write behavior is:

| Metadata              | Omitted create | Explicit create               | Explicit update             |
| --------------------- | -------------- | ----------------------------- | --------------------------- |
| ordinary default      | use default    | host value wins               | host value wins             |
| `BY DEFAULT` identity | generate       | host value wins               | host value wins             |
| `ALWAYS` identity     | generate       | use `OVERRIDING SYSTEM VALUE` | reject before database work |
| stored generated      | compute        | reject before database work   | reject before database work |

Prohibited writes use `StoreValidationError` with Collection, operation, phase, field, and a field-local issue. Omitted updates remain unchanged.

#### Names, precedence, and collisions

PostgreSQL schema and object names are separate values. Never split a dotted string. Adapters quote every part and preserve exact case. Names must be nonempty, NUL-free, and no longer than 63 UTF-8 bytes. Reject rather than accept PostgreSQL's silent truncation.

Active PostgreSQL metadata can override portable `name`, `type`, `default`, and `notNull`, and it can add `schema`, `identity`, and `generated`. Absence inherits. `null` removes one inherited optional setting. After overrides, the resolver rebuilds all reflection, names, types, and conflicts.

Columns conflict only inside their table. Definition-owned tables, explicit identity sequences, enums, and table row types use their applicable PostgreSQL namespaces. Equal unqualified names conflict. Equal names in one explicit schema conflict. An unqualified name and a qualified name do not conflict because definition has no `search_path`. External custom types are not owned assets. PostgreSQL remains responsible for conflicts with existing database objects.

#### Resolution assets and failures

The adapter resolution exposes tables by Record key, columns by field key, primary-key columns in declared order, and enums in first-use order. Each column includes its exact name and reference, resolved nullability, a final physical direct, array, enum, or custom type, its default or normalized `SqlResolvedGeneratedColumn`, identity metadata, and encode/decode functions. The plan carries no portable authoring-origin marker. Adapter authors switch exhaustively on the physical discriminant and do not parse SQL type text.

Metadata and type helper constructors preserve literal inference, snapshot options, and return immutable values. They throw `TypeError` immediately for malformed constructor arguments, invalid atomic option types or limits, invalid local names, and incompatible opaque formats. They never inspect Record field values. They do not check inherited metadata, precedence, cross-property conflicts, Schema compatibility, catalog collisions, or PostgreSQL namespaces.

Each runtime or definition failure has one owner:

- helper authoring failures use immediate `TypeError`;
- effective metadata and catalog failures use aggregated `SqlDefinitionError`;
- write-side operation and Select Schema failures are owned by the Record parser symbols and use `StoreValidationError`;
- direct PostgreSQL encoding syntax, JSON-safety, or range failures for caller-supplied values use `StoreValidationError`;
- custom encoder throws and invalid encoded scalars use `StoreAdapterContractViolation` with `"invalid-column-encoding"`; and
- direct or custom decode failures, non-JSON decoded values, and read-side Select Schema rejections use `StoreAdapterContractViolation` with `"invalid-selected-record"`.

`resolvePostgresRecords()` aggregates effective-catalog failures in one `SqlDefinitionError` and reuses the database-neutral issue codes:

- names use `invalid-name`;
- owned-asset collisions use `duplicate-name`;
- missing storage evidence uses `column-type-required`;
- invalid helper options, enum values, custom names, or converters use `invalid-column-type`;
- defaults use `invalid-column-default`;
- identity, generation, nullability, primary-key, and other PostgreSQL option conflicts use `invalid-database-options`; and
- composition uses the existing contribution and override codes.

PostgreSQL uses the shared issue-order skeleton. Its table slot checks schema, name, table format, and portable primary-key structure. Its field slot checks the direct, array, enum, or custom type contract before default, nullability, identity, generation, and cross-property compatibility. Its table-wide slot resolves primary-key columns and checks column collisions. Its final namespace slot checks tables and their row types, explicit identity sequences, and enums in first-use order.

Preserve the original converter failure as `cause` and include Collection, operation, and field. Converter failures are contract defects, not caller validation or database I/O errors.

PostgreSQL metadata, column types, enums, Statements, and resolutions use opaque format identity instead of module-local `instanceof`. Compatible `@commissary/store` package copies interoperate. Incompatible formats and caller-made lookalikes fail. Freeze package-owned objects, arrays, assets, and issue lists; keep Schema objects and converter functions by reference.

### MySQL Record specialization

The MySQL specialization targets MySQL 8.4 LTS and later. It defines Drizzle-independent metadata and resolution assets. It does not create a MySQL-named runtime Store interface. Definition performs no server-version check.

#### Ownership and authoring

Integrations author one `SqlRecord` with portable `sql.*` metadata and optional `mysql.*` refinements:

```ts
const Session = SqlRecord.define({
  table: sql.table({
    name: "sessions",
    mysql: mysql.table({
      database: "commissary",
    }),
  }),
  fields: {
    id: {
      select: sessionIdSchema,
      column: sql.column({
        type: sql.text(),
        mysql: mysql.column({
          type: mysql.serial(),
        }),
      }),
    },
  },
});
```

`mysql.table()` and `mysql.column()` create only MySQL refinements. They do not resolve a catalog or create adapter assets. Do not add `MysqlSql.define()`, `MysqlSqlStore.define()`, `MySqlRecord`, or another host-facing MySQL definition factory. A host calls only its selected concrete adapter.

`@commissary/store/sql/mysql/adapter` exposes the synchronous, I/O-free resolver used by concrete adapters:

```ts
export declare function resolveMysqlRecords<
  const Definitions extends RecordDefinitions,
  const Overrides extends RecordOverrides<Definitions> = {},
>(options: {
  readonly records: Definitions;
  readonly overrides?: Overrides;
}): MysqlRecordResolution<ApplyOverrides<Definitions, Overrides>>;

export interface MysqlRecordResolution<Definitions extends RecordDefinitions> {
  readonly records: SqlRecordReferences<Definitions>;
  readonly tables: MysqlResolvedTables<Definitions>;
}
```

The resolver applies contributions and overrides, activates `mysql` metadata, rebuilds inference, validates the effective catalog, and returns immutable resolved references and adapter assets. It contains no generated DDL, Drizzle values, explicit indexes, relations, or migration data.

#### Public MySQL metadata

The rough public types are:

```ts
export interface MysqlColumnType<in Value extends JsonValue> extends SqlColumnType<Value> {
  // Opaque package-owned MySQL storage and conversion contract.
}

export interface MysqlTableDefinition {
  readonly database?: string | null;
  readonly name?: string | null;
}

export interface MysqlGenerated {
  readonly expression: SqlStatement<never>;
  readonly mode: "virtual" | "stored";
}

export interface MysqlColumnDefinition<Value extends JsonValue> {
  readonly name?: string | null;
  readonly type?: MysqlColumnType<Value> | null;
  readonly default?: SqlLiteral<Extract<Value, SqlLiteralValue>> | SqlStatement<never> | null;
  readonly notNull?: boolean | null;
  readonly autoIncrement?: boolean | null;
  readonly generated?: MysqlGenerated | null;
  readonly onUpdate?: "current-timestamp" | null;
}

export interface MysqlIntegerOptions {
  readonly unsigned?: boolean;
}

export interface MysqlDecimalOptions {
  readonly precision?: number;
  readonly scale?: number;
  /** @deprecated MySQL 8.4 deprecates UNSIGNED on DECIMAL. */
  readonly unsigned?: boolean;
}

export interface MysqlFloatOptions {
  readonly precision?: number;
  /** @deprecated MySQL 8.4 deprecates FLOAT(M,D). Supplying scale selects this form. */
  readonly scale?: number;
  /** @deprecated MySQL 8.4 deprecates UNSIGNED on FLOAT. */
  readonly unsigned?: boolean;
}

export interface MysqlDoubleOptions {
  /** @deprecated MySQL 8.4 deprecates DOUBLE(M,D). */
  readonly precision?: number;
  /** @deprecated MySQL 8.4 deprecates DOUBLE(M,D). */
  readonly scale?: number;
  /** @deprecated MySQL 8.4 deprecates UNSIGNED on DOUBLE. */
  readonly unsigned?: boolean;
}

export interface MysqlRealOptions {
  /** @deprecated MySQL 8.4 deprecates REAL(M,D). */
  readonly precision?: number;
  /** @deprecated MySQL 8.4 deprecates REAL(M,D). */
  readonly scale?: number;
}

export interface MysqlOptionalLengthOptions {
  readonly length?: number;
}

export interface MysqlLengthOptions {
  readonly length: number;
}

export type MysqlFractionalSecondsPrecision = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface MysqlTemporalOptions {
  readonly fsp?: MysqlFractionalSecondsPrecision;
}

export interface MysqlEnum<Values extends readonly [string, ...string[]]> extends MysqlColumnType<
  Values[number]
> {}

export interface MysqlCustomTypeOptions<Value extends JsonValue> {
  readonly type: SqlStatement<never>;
  readonly encode: (value: Value) => SqlCustomEncodedValue;
  readonly decode: (value: unknown) => Value;
}

export declare const mysql: {
  readonly table: <const Options extends MysqlTableDefinition>(
    options: Options,
  ) => Readonly<Options>;
  readonly column: <Value extends JsonValue, const Options extends MysqlColumnDefinition<Value>>(
    options: Options,
  ) => Readonly<Options>;

  readonly tinyint: (options?: MysqlIntegerOptions) => MysqlColumnType<number>;
  readonly smallint: (options?: MysqlIntegerOptions) => MysqlColumnType<number>;
  readonly mediumint: (options?: MysqlIntegerOptions) => MysqlColumnType<number>;
  readonly int: (options?: MysqlIntegerOptions) => MysqlColumnType<number>;
  readonly bigint: (options?: MysqlIntegerOptions) => MysqlColumnType<string>;
  readonly decimal: (options?: MysqlDecimalOptions) => MysqlColumnType<string>;
  readonly float: (options?: MysqlFloatOptions) => MysqlColumnType<number>;
  readonly double: (options?: MysqlDoubleOptions) => MysqlColumnType<number>;
  readonly real: (options?: MysqlRealOptions) => MysqlColumnType<number>;

  readonly boolean: () => MysqlColumnType<boolean>;
  readonly char: (options?: MysqlOptionalLengthOptions) => MysqlColumnType<string>;
  readonly varchar: (options: MysqlLengthOptions) => MysqlColumnType<string>;
  readonly binary: (options?: MysqlOptionalLengthOptions) => MysqlColumnType<string>;
  readonly varbinary: (options: MysqlLengthOptions) => MysqlColumnType<string>;
  readonly text: () => MysqlColumnType<string>;
  readonly tinytext: () => MysqlColumnType<string>;
  readonly mediumtext: () => MysqlColumnType<string>;
  readonly longtext: () => MysqlColumnType<string>;
  readonly json: () => MysqlColumnType<JsonValue>;

  readonly date: () => MysqlColumnType<string>;
  readonly datetime: (options?: MysqlTemporalOptions) => MysqlColumnType<string>;
  readonly time: (options?: MysqlTemporalOptions) => MysqlColumnType<string>;
  readonly timestamp: (options?: MysqlTemporalOptions) => MysqlColumnType<string>;
  readonly year: () => MysqlColumnType<number>;

  readonly serial: () => MysqlColumnType<string>;
  readonly enum: <const Values extends readonly [string, ...string[]]>(options: {
    readonly values: Values;
  }) => MysqlEnum<Values>;
  readonly custom: <Value extends JsonValue>(
    options: MysqlCustomTypeOptions<Value>,
  ) => MysqlColumnType<Value>;
};
```

`MysqlColumnType<Value>` is contravariant. The resolver checks the defined Select output after removing `null` and `undefined`. This permits branded string refinements. Helpers never replace Select, Create, or Update Schema inference.

#### Direct type behavior

Each direct helper has one driver-independent application value:

| MySQL type                                                           | Application value               |
| -------------------------------------------------------------------- | ------------------------------- |
| `tinyint`, `smallint`, `mediumint`, `int`, `float`, `double`, `real` | finite `number`                 |
| `bigint`, `decimal`, `serial`                                        | exact `string`                  |
| `boolean`                                                            | `boolean`                       |
| `char`, `varchar`, `text`, `tinytext`, `mediumtext`, `longtext`      | `string`                        |
| `binary`, `varbinary`                                                | padded RFC 4648 base64 `string` |
| `json`                                                               | `JsonValue`                     |
| `date`, `datetime`, `time`, `timestamp`                              | normalized `string`             |
| `year`                                                               | finite integer `number`         |
| enum                                                                 | its exact string literal union  |

Signed direct integer ranges are:

- `tinyint`: -128 through 127;
- `smallint`: -32,768 through 32,767;
- `mediumint`: -8,388,608 through 8,388,607;
- `int`: -2,147,483,648 through 2,147,483,647; and
- `bigint`: -9,223,372,036,854,775,808 through 9,223,372,036,854,775,807.

Unsigned forms start at zero and end at 255, 65,535, 16,777,215, 4,294,967,295, and 18,446,744,073,709,551,615, respectively. `bigint` and `serial` use canonical base-10 text with no leading plus, redundant leading zero, whitespace, exponent, or negative zero. `serial` rejects zero on both write and read.

`decimal` accepts fixed-point text only. It does not accept an exponent or whitespace. Selected decimal text has no redundant integer zeros and contains exactly the effective scale digits. `float`, `double`, and `real` accept only finite numbers. Stored negative zero decodes as zero. `unsigned` decimal, float, and double values reject negative numbers without extending the corresponding signed upper range. MySQL can apply its documented decimal scale and approximate-number precision conversion. The adapter decodes the stored result rather than echoing the input.

Direct boolean writes encode `false` as zero and `true` as one. Reads accept a driver-independent boolean or numeric zero or one. Another stored value is an invalid selected Record, not implicit truthiness.

`char` and `varchar` length counts Unicode code points. Known overlength values fail before database work. Application `char` values with trailing spaces fail because MySQL cannot preserve them reliably. Selected `char` removes server padding. `varchar` and text values preserve trailing spaces. Effective byte and row-size limits remain MySQL and host character-set policy.

`binary` and `varbinary` lengths count decoded bytes. Known overlength values fail before database work. MySQL can add zero bytes to a shorter `binary` value. Selected `binary` base64 includes every pad byte; `varbinary` has no padding.

Temporal values use:

- `date`: `YYYY-MM-DD`, from `1000-01-01` through `9999-12-31`;
- `datetime`: `YYYY-MM-DDTHH:mm:ss[.ffffff]`, in the documented MySQL range and without a time-zone offset;
- `timestamp`: the documented MySQL range, normalized to UTC with `Z`;
- `time`: `[-]HHH:MM:SS[.ffffff]`, from `-838:59:59` through `838:59:59`; and
- `year`: an integer from 1901 through 2155.

Reject invalid calendar dates, partial and zero dates, abbreviated times, the zero-year sentinel, and noncanonical temporal text. Writes can contain up to six fractional digits. MySQL applies the declared fractional precision. Selected values contain exactly that number of fractional digits; omitted precision means none. A concrete adapter must document and enforce a UTC-safe timestamp contract. The Drizzle MySQL adapter requires the host to keep `@@session.time_zone` in UTC on every possible connection; it does not mutate or probe one session as proof for a pool.

Supported physical options are:

- `unsigned` on integer types and on `decimal`, `float`, and `double`;
- `decimal` precision 1 through 65 and scale 0 through 30, with scale no greater than precision and scale requiring precision;
- one-argument `float(p)` precision 0 through 53;
- `float`, `double`, and `real` total-digit precision 1 through 255 with scale 0 through 30, with scale no greater than precision and scale requiring precision;
- `char` and `binary` length 0 through 255, where omission means one;
- required `varchar` and `varbinary` length 0 through 65,535; and
- `datetime`, `time`, and `timestamp` fractional precision 0 through 6.

MySQL 8.4 deprecates `unsigned` on fixed- and floating-point types and the nonstandard floating-point precision-and-scale forms. Keep them for parity with the MySQL helper set on the authoritative Drizzle `main` branch, but mark them deprecated in API documentation. Do not expose integer display width, `ZEROFILL`, driver output modes, TypeScript-only text enum narrowing, or aliases outside the listed helper set. `real` remains a distinct resolved type and emits exact `REAL`; active SQL mode owns whether MySQL treats it as `FLOAT` or `DOUBLE`.

The operation and Select Schema parsers validate field values first. A direct MySQL codec then validates storage syntax, JSON safety, declared length, and type range before database work. Invalid caller-supplied values use `StoreValidationError`. An invalid stored direct value uses `StoreAdapterContractViolation` with `"invalid-selected-record"`.

#### Inline enums and custom types

`mysql.enum({ values })` creates one inline column type and no separate asset. Value order is significant. Values form one nonempty tuple. Definition rejects exact duplicates, empty values, trailing spaces, values over 255 Unicode code points, and more than 65,535 values. Host collation can impose further restrictions.

A custom type uses a nonempty `SqlStatement<never>` for exact type structure. Definition checks package origin, nonempty structure, and the actual absence of bound parameters. It does not parse the structure. This path supports `BIT`, `SET`, spatial types, BLOB variants, optional extensions, and vendor types. A custom type creates no owned asset.

Custom conversion is synchronous:

```txt
write: operation Schema -> Select Schema -> encode -> database
read:  database -> decode -> Select Schema -> Selected Record
```

SQL `NULL` bypasses conversion. The resolver snapshots function references but never invokes them. An encoder must return a `SqlCustomEncodedValue`; numbers must be finite. Statements, Promises, other objects, arrays, `undefined`, and driver objects are invalid encoded values. Custom encoder throws and invalid outputs are adapter contract violations, not caller validation. A custom decoder accepts `unknown`; its output must be a `JsonValue` before the Select Schema checks it.

Resolved direct codecs expose the same synchronous `encode(value)` and `decode(unknown)` shape but contain no driver-specific `Buffer`, `Date`, or JavaScript `bigint` values. A concrete adapter converts driver-specific output before direct decoding.

#### Defaults, automatic increment, generation, and automatic update

MySQL defaults and generated expressions accept parameter-free Statements. Definition checks package origin, nonempty structure, and the actual absence of bound parameters. It does not parse SQL or validate functions, column references, result types, or generated-column restrictions. MySQL owns semantic expression validation, and `sql.raw()` remains trusted unchecked structure.

`autoIncrement: true` is valid only when the final physical direct type is `tinyint`, `smallint`, `mediumint`, `int`, or `bigint`; portable `sql.integer()` maps to signed `bigint` and qualifies. `serial` supplies the same behavior intrinsically. Automatic increment:

- implies `NOT NULL`;
- is permitted on at most one column per table;
- conflicts with an explicit default, generated metadata, and automatic-update metadata;
- rejects `notNull: false`;
- generates an omitted create value;
- permits an explicit nonzero create or update value; and
- rejects explicit zero because its behavior depends on SQL mode.

MySQL requires an automatic-increment column to be indexed, but not necessarily uniquely. The resolver marks non-serial automatic increment as `{ key: "host-required" }`. The concrete adapter must prove that one host-owned index starts with that column. `serial` resolves as `{ key: "serial-unique" }` because exact MySQL `SERIAL` means `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE`. The resolver creates no separate index asset.

`serial()` takes no options and uses an exact base-10 string instead of Drizzle's unsafe number. It rejects `notNull: false`, `autoIncrement: false`, a default, generated metadata, and automatic-update metadata. Explicit `notNull: true` and `autoIncrement: true` are valid but redundant.

A generated column has a parameter-free expression and explicit `"virtual"` or `"stored"` mode. Direct and custom types can be generated. Generation conflicts with a default, automatic increment, and automatic update. MySQL validates the expression. An explicit create or update value fails before database work; omission lets MySQL compute the value.

`onUpdate: "current-timestamp"` is valid only on direct `datetime` and `timestamp` columns. It requires an explicit default so behavior does not depend on MySQL's implicit-default mode. It conflicts with automatic increment and generation. An explicit update value wins. When the field is omitted, MySQL owns whether the row change qualifies for automatic update.

Database metadata does not change `SelectedRecord`, `CreateInput`, or `UpdateInput`. Field Schemas remain their only source. Store write behavior is:

| Metadata                    | Omitted create       | Explicit create | Explicit update                          |
| --------------------------- | -------------------- | --------------- | ---------------------------------------- |
| ordinary default            | use default          | host value wins | host value wins                          |
| automatic increment         | generate             | permit nonzero  | permit nonzero                           |
| virtual or stored generated | compute              | reject          | reject                                   |
| automatic update            | use explicit default | host value wins | host value wins; omission lets MySQL act |

Prohibited writes and invalid direct values use `StoreValidationError` with Collection, operation, phase, field, and a field-local issue. Omitted updates otherwise remain unchanged. Adapters decode the stored result after writes because MySQL can round, pad, generate, and update values.

#### Names, precedence, and collisions

MySQL database, table, and column names are separate values. Never split a dotted string. Adapters quote every part and preserve exact text. Names must be nonempty, NUL-free, contain only Basic Multilingual Plane code points, not end with U+0020 SPACE, and contain no more than 64 Unicode code points. Reject rather than rely on host filesystem or `lower_case_table_names` behavior.

Collision checks use locale-independent Unicode default case folding without Unicode normalization. Within one effective catalog, an explicit database spelling must be stable: two spellings that differ but fold equally conflict. Columns conflict only inside their table. Equal unqualified table names conflict. Equal table names in one explicit database conflict. An unqualified table and an explicitly qualified table do not conflict because definition has no active database. Inline enum values and custom type Statements are not identifier assets.

Active MySQL metadata can override portable `name`, `type`, `default`, and `notNull`, and it can add `database`, `autoIncrement`, `generated`, and `onUpdate`. Absence inherits. `null` removes one inherited optional setting. `false` can disable inherited boolean metadata where no intrinsic type behavior prevents it. After overrides, the resolver rebuilds all reflection, names, types, and conflicts.

#### Resolution assets and failures

The adapter resolution exposes tables by Record key, columns by field key, and primary-key columns in declared order. Each column includes its exact name and reference, resolved nullability, a final physical direct, enum, or custom type discriminant, physical option snapshots, its default or normalized `SqlResolvedGeneratedColumn`, automatic increment and update data, and synchronous encode and decode functions. The plan carries no portable authoring-origin marker. Adapter authors switch exhaustively on physical direct names and do not parse generated SQL type text. Custom columns retain their type Statement.

Metadata and type helper constructors preserve literal inference, snapshot options, and return immutable values. They throw `TypeError` immediately only when malformed values are supplied as `mysql.*` helper invocation arguments, including invalid atomic option types or limits, invalid local names or enum values, parameterized custom type structure, and incompatible opaque formats. They never inspect Record field values. Plain structural metadata does not pass through constructor validation. The resolver checks its effective values together with inherited metadata, precedence, cross-property conflicts, Schema compatibility, catalog collisions, and MySQL namespaces.

Each runtime or definition failure has one owner:

- invalid `mysql.*` helper invocations use immediate `TypeError`;
- malformed plain structural metadata and all other effective metadata or catalog failures use aggregated `SqlDefinitionError`;
- write-side operation and Select Schema failures are owned by the Record parser symbols and use `StoreValidationError`;
- direct MySQL encoding syntax, JSON-safety, length, or range failures for caller-supplied values use `StoreValidationError`;
- custom encoder throws and invalid encoded values use `StoreAdapterContractViolation` with `"invalid-column-encoding"`; and
- direct or custom decode failures, non-JSON decoded values, and read-side Select Schema rejections use `StoreAdapterContractViolation` with `"invalid-selected-record"`.

`resolveMysqlRecords()` aggregates effective-catalog failures in one `SqlDefinitionError` and reuses the database-neutral issue codes:

- names use `invalid-name`;
- catalog collisions use `duplicate-name`;
- missing storage evidence uses `column-type-required`;
- invalid effective type options, enum values, custom structure, or converters use `invalid-column-type`;
- defaults use `invalid-column-default`;
- automatic increment, generation, automatic update, nullability, primary-key, and other MySQL option conflicts use `invalid-database-options`; and
- composition uses the existing contribution and override codes.

Issues point to the winning `records` or `overrides` source. A conflict points to the later or higher-precedence setting and names the other source in its message. A duplicate issue belongs to the later name. Composition and override issues precede effective-catalog checks. Effective checks then follow Record declaration and this fixed order:

1. table database, table name, table-format validity, and portable primary-key structure;
2. for each field in declaration order: column name, opaque type identity, storage evidence, Select compatibility, physical type options or enum or custom structure, default, nullability, automatic increment, generation, automatic update, and cross-property compatibility;
3. table-wide primary-key resolution, automatic-increment count and position, and column-name collisions; and
4. database-spelling and table-name collisions across Records.

When two owned names or references enter the same step, first use controls order and the issue belongs to the later one. Checks that depend on one invalid prerequisite are skipped; every independent check continues.

Preserve the original converter failure as `cause` and include Collection, operation, and field. Converter failures are contract defects, not caller validation or database I/O errors.

MySQL metadata, column types, Statements, and resolutions use opaque format identity instead of module-local `instanceof`. Compatible `@commissary/store` package copies interoperate. Incompatible formats and caller-made lookalikes fail. Freeze package-owned objects, arrays, resolutions, and issue lists; keep Schema objects and converter functions by reference.

### SQLite Record specialization

The SQLite specialization targets SQLite 3.45 and later. It defines Drizzle-independent metadata and resolution assets. It does not create a SQLite-named runtime Store interface. Definition is synchronous and performs no database or version check. A concrete adapter rejects an unsupported live engine or driver path during binding.

Do not expose `STRICT`, `WITHOUT ROWID`, attached-database qualification, SQLite JSONB, constraints other than the portable primary key, collations, conflict policies, other indexes, relations, or migration data. Generated columns and the integer-primary-key ROWID behavior are in scope because the adapter can preserve them.

#### Ownership and authoring

Integrations author one `SqlRecord` with portable `sql.*` metadata and optional `sqlite.*` refinements:

```ts
const LedgerEntry = SqlRecord.define({
  table: sql.table({
    name: "ledger_entries",
    sqlite: sqlite.table({
      name: "ledger_entry",
    }),
  }),
  fields: {
    details: {
      select: Schema.JsonValue,
      column: sql.column({
        type: sql.json(),
        sqlite: sqlite.column({
          type: sqlite.jsonBlob(),
        }),
      }),
    },
  },
});
```

`sqlite.table()` and `sqlite.column()` create only SQLite refinements. They do not resolve a catalog or create adapter assets. Do not add `SqliteSql.define()`, `SqliteStore.define()`, `SqliteRecord`, or another host-facing SQLite definition factory. A host calls only its selected concrete adapter.

`@commissary/store/sql/sqlite/adapter` exposes the synchronous, I/O-free resolver used by concrete adapters:

```ts
export declare function resolveSqliteRecords<
  const Definitions extends RecordDefinitions,
  const Overrides extends RecordOverrides<Definitions> = {},
>(options: {
  readonly records: Definitions;
  readonly overrides?: Overrides;
}): SqliteRecordResolution<ApplyOverrides<Definitions, Overrides>>;

export interface SqliteRecordResolution<Definitions extends RecordDefinitions> {
  readonly records: SqlRecordReferences<Definitions>;
  readonly tables: SqliteResolvedTables<Definitions>;
}
```

The resolver applies contributions and overrides, activates `sqlite` metadata, rebuilds inference, validates the effective catalog, and returns immutable resolved references and adapter assets. It contains no generated DDL, Drizzle values, indexes, relations, migration data, or driver registry.

#### Public SQLite metadata

The rough public types are:

```ts
export interface SqliteColumnType<in Value extends JsonValue> extends SqlColumnType<Value> {
  // Opaque package-owned SQLite storage and conversion contract.
}

export interface SqliteTableDefinition {
  readonly name?: string | null;
}

export interface SqliteRowid {
  readonly reuse?: "allowed" | "forbidden";
}

export interface SqliteGenerated {
  readonly expression: SqlStatement<never>;
  readonly mode: "virtual" | "stored";
}

export interface SqliteColumnDefinition<Value extends JsonValue> {
  readonly name?: string | null;
  readonly type?: SqliteColumnType<Value> | null;
  readonly default?: SqlLiteral<Extract<Value, SqlLiteralValue>> | SqlStatement<never> | null;
  readonly notNull?: boolean | null;
  readonly rowid?: SqliteRowid | null;
  readonly generated?: SqliteGenerated | null;
}

export interface SqliteCustomTypeOptions<Value extends JsonValue> {
  readonly type: SqlStatement<never>;
  readonly encode: (value: Value) => SqlCustomEncodedValue;
  readonly decode: (value: unknown) => Value;
}

export declare const sqlite: {
  readonly table: <const Options extends SqliteTableDefinition>(
    options: Options,
  ) => Readonly<Options>;
  readonly column: <Value extends JsonValue, const Options extends SqliteColumnDefinition<Value>>(
    options: Options,
  ) => Readonly<Options>;

  readonly integer: () => SqliteColumnType<number>;
  readonly boolean: () => SqliteColumnType<boolean>;
  readonly timestampSeconds: () => SqliteColumnType<string>;
  readonly timestampMilliseconds: () => SqliteColumnType<string>;
  readonly real: () => SqliteColumnType<number>;
  readonly text: () => SqliteColumnType<string>;
  readonly json: () => SqliteColumnType<JsonValue>;
  readonly blob: () => SqliteColumnType<string>;
  readonly jsonBlob: () => SqliteColumnType<JsonValue>;
  readonly bigintBlob: () => SqliteColumnType<string>;
  readonly numeric: () => SqliteColumnType<string>;
  readonly numericNumber: () => SqliteColumnType<number>;
  readonly custom: <Value extends JsonValue>(
    options: SqliteCustomTypeOptions<Value>,
  ) => SqliteColumnType<Value>;
};
```

Each named helper has one application value and one storage contract. Do not expose Drizzle-style `{ mode }` options, `int` or `customType` aliases, `defaultNow`, text length, TypeScript-only text enums, or a numeric bigint mode.

`SqliteColumnType<Value>` is contravariant. The resolver checks the defined Select output after removing `null` and `undefined`. This permits branded string refinements. Helpers never replace Select, Create, or Update Schema inference.

#### Direct type behavior

Direct helpers use these driver-independent contracts:

| SQLite helper           | SQLite storage | Application value                 |
| ----------------------- | -------------- | --------------------------------- |
| `integer`               | `INTEGER`      | safe integer `number`             |
| `boolean`               | `INTEGER`      | `boolean`                         |
| `timestampSeconds`      | `INTEGER`      | UTC whole-second `string`         |
| `timestampMilliseconds` | `INTEGER`      | UTC whole-millisecond `string`    |
| `real`                  | `REAL`         | finite `number`                   |
| `text`                  | `TEXT`         | NUL-free `string`                 |
| `json`                  | `TEXT`         | `JsonValue`                       |
| `blob`                  | `BLOB`         | padded RFC 4648 base64 `string`   |
| `jsonBlob`              | `BLOB`         | `JsonValue`                       |
| `bigintBlob`            | `BLOB`         | canonical signed decimal `string` |
| `numeric`               | `NUMERIC`      | canonical finite numeric `string` |
| `numericNumber`         | `NUMERIC`      | finite `number`                   |

`integer` accepts only JavaScript safe integers. SQLite has a wider signed 64-bit integer range, but this helper never implies unsafe number precision.

`boolean` writes zero or one. Reads accept only a normalized numeric zero or one. Another stored value is an invalid selected Record, not implicit truthiness.

`timestampSeconds` uses `YYYY-MM-DDTHH:mm:ssZ`. `timestampMilliseconds` uses `YYYY-MM-DDTHH:mm:ss.SSSZ`. Values use the proleptic Gregorian calendar, years `0000` through `9999`, a literal `Z`, valid calendar fields, and no leap-second value. They encode signed Unix epoch seconds or milliseconds as `INTEGER` and decode the stored integer to the same canonical UTC form.

`real` and `numericNumber` accept only finite numbers and normalize negative zero to zero. `numericNumber` keeps SQLite `NUMERIC` affinity instead of emitting `REAL`.

`text` preserves exact NUL-free Unicode text. It defines no length, collation, or Unicode-normalization policy.

`blob` decodes padded RFC 4648 base64 to exact bytes. `json` stores UTF-8 JSON text. `jsonBlob` stores the same UTF-8 JSON representation as bytes; it is not SQLite JSONB and makes no JSON1 processing guarantee. `bigintBlob` stores the UTF-8 bytes of canonical signed decimal text with no leading plus, whitespace, exponent, redundant leading zero, or negative zero.

`numeric` accepts an optional minus, a nonredundant decimal integer part, an optional fraction with no trailing zero, and an optional lowercase `e` exponent with no plus or redundant leading zero. Zero is exactly `"0"`. Whitespace, non-decimal forms, `NaN`, infinity, and negative zero are invalid. The represented value must be finite. SQLite `NUMERIC` affinity can convert the text to `INTEGER` or `REAL`, normalize it, and round precision. Selected values describe the stored result in the same canonical grammar; they do not preserve input spelling.

A concrete adapter must reject live binding when its driver path cannot preserve the required selected value or precision. Adapters decode the stored result after writes rather than echoing the input.

The operation and Select Schema parsers validate field values first. A direct SQLite codec then validates canonical syntax, JSON safety, and range before database work. Invalid caller values use `StoreValidationError`. An invalid stored direct value uses `StoreAdapterContractViolation` with `"invalid-selected-record"`.

SQL `NULL` bypasses every direct and custom codec. A required `Value | null` field selects SQL `NULL` as `null`. An optional `Value` field treats SQL `NULL` as missing. An optional `Value | null` field needs a custom representation because one SQL `NULL` cannot preserve both states.

#### Custom types

A custom type uses a nonempty `SqlStatement<never>` for exact declared type structure. Definition checks package origin, nonempty structure, and the actual absence of bound parameters. It does not parse the declared type or infer SQLite affinity. This path supports extensions and vendor types without adding package-owned helpers.

Custom conversion is synchronous:

```txt
write: operation Schema -> Select Schema -> encode -> database
read:  database -> decode -> Select Schema -> Selected Record
```

The resolver snapshots function references but never invokes them. An encoder must return a `SqlCustomEncodedValue`; numbers must be finite. Statements, Promises, other objects, arrays, `undefined`, and driver objects are invalid encoded values. A custom decoder accepts `unknown`; its output must be a `JsonValue` before the Select Schema checks it.

Custom encoder throws and invalid outputs use `StoreAdapterContractViolation` with `"invalid-column-encoding"`. Custom decode failures, non-JSON decoded values, and read-side Select Schema failures use `StoreAdapterContractViolation` with `"invalid-selected-record"`. Preserve the original converter failure as `cause` and include Collection, operation, and field.

Resolved direct codecs expose the same synchronous `encode(value)` and `decode(unknown)` shape. They contain no driver-specific `Buffer`, `Date`, or JavaScript `bigint` values. A concrete adapter converts driver-specific output before direct decoding.

#### Defaults, ROWID generation, and generated columns

SQLite defaults and generated expressions accept parameter-free Statements. Definition checks package origin, nonempty structure, and the actual absence of bound parameters. It does not parse SQL or validate functions, column references, subqueries, determinism, or result types. SQLite owns semantic expression validation, and `sql.raw()` remains trusted unchecked structure.

`rowid` is valid only when the final physical direct type is `INTEGER` with the safe-number contract; portable `sql.integer()` and direct `sqlite.integer()` both qualify. It describes SQLite's `INTEGER PRIMARY KEY` row identity and generation behavior:

- at most one column per table can have `rowid`;
- it implies `NOT NULL`, and explicit `notNull: false` conflicts;
- it conflicts with a default and generated metadata;
- omission during create lets SQLite generate the value;
- explicit create and update accept any safe integer, including zero and negative values; and
- omitted update leaves the value unchanged.

Omitted `reuse` means `"allowed"`. `"allowed"` uses ordinary `INTEGER PRIMARY KEY` behavior. `"forbidden"` emits `AUTOINCREMENT`; it prevents reuse of committed ROWIDs but does not promise consecutive values or prevent gaps.

Portable primary-key metadata is the general constraint owned by this tier. ROWID metadata adds SQLite physical identity and generation rules for one `INTEGER PRIMARY KEY` column. Unique constraints, checks, foreign keys, collations, conflict policies, other indexes, and relations remain host-owned. A concrete adapter rejects a supplied constraint that conflicts with the resolved primary-key or ROWID contract.

A generated column has a parameter-free expression and explicit `"virtual"` or `"stored"` mode. Direct and custom types can be generated. Generation conflicts with a default and ROWID metadata. SQLite validates the expression. At least one effective column in each table must be non-generated. Generated columns can be nullable.

Database metadata does not change `SelectedRecord`, `CreateInput`, or `UpdateInput`. Field Schemas remain their only source. Store write behavior is:

| Metadata                    | Omitted create | Explicit create         | Explicit update         |
| --------------------------- | -------------- | ----------------------- | ----------------------- |
| ordinary default            | use default    | host value wins         | host value wins         |
| ROWID                       | generate       | permit any safe integer | permit any safe integer |
| virtual or stored generated | compute        | reject                  | reject                  |

Prohibited generated writes and invalid direct values use `StoreValidationError` with Collection, operation, phase, field, and a field-local issue. Omitted updates otherwise remain unchanged. Adapters read and decode the stored result after writes so SQLite-owned defaults, ROWIDs, generation, affinity conversion, and rounding are visible.

#### Names, precedence, and collisions

SQLite table and column names are exact separately quoted values. Never split a dotted string. Names must be nonempty NUL-free Unicode text. There is no fixed package length limit and no Unicode normalization. Database and schema qualifiers are not represented.

Collision checks use SQLite ASCII case folding only: `A` through `Z` compare as `a` through `z`, and every other code point compares exactly. Columns conflict only inside their table. Effective table names conflict across the complete catalog. Reject effective table names beginning with `sqlite_` under the same ASCII-insensitive comparison because SQLite reserves that prefix.

Active SQLite metadata can override portable `name`, `type`, `default`, and `notNull`, and it can add `rowid` and `generated`. Type precedence is:

1. active SQLite type;
2. portable explicit SQL type; and
3. Select Schema reflection.

Portable types and Select reflection use the shared physical mappings above. SQLite database metadata does not retain or expose the lower-tier origin after it resolves the final physical type and codec.

Absence inherits. `null` removes one inherited optional setting. After contributions and overrides, the resolver rebuilds all reflection, names, types, defaults, nullability, ROWID and generated-column facts, codecs, and collisions.

#### Resolution assets and failures

The adapter resolution exposes tables by Record key and columns by field key. Each table contains its exact name, reference, primary-key columns in declared order, and columns. Each column contains its exact name and reference, resolved nullability, a final physical direct or custom type, its default, ROWID data, normalized `SqlResolvedGeneratedColumn`, and synchronous encode and decode functions. The plan carries no portable authoring-origin marker. Adapter authors switch exhaustively on named physical discriminants and do not parse generated SQL type text. Custom columns retain their type Statement.

Metadata and type helper constructors preserve literal inference, snapshot options, and return immutable values. They throw `TypeError` immediately only for malformed values supplied directly to `sqlite.*` helper invocations, including invalid atomic option values, local names, parameterized custom type structure, missing converter functions, and incompatible opaque formats. They never inspect Record field values, Schemas, inherited metadata, overrides, collisions, or cross-property constraints. Plain structural metadata does not pass through constructor validation.

The resolver checks effective values together with inherited metadata, precedence, Schema compatibility, cross-property conflicts, and catalog collisions. Each failure has one owner:

- malformed `sqlite.*` helper invocations use immediate `TypeError`;
- malformed plain structural metadata and all other effective metadata or catalog failures use aggregated `SqlDefinitionError`;
- write-side operation and Select Schema failures use `StoreValidationError`;
- direct SQLite encoding syntax, JSON-safety, or range failures for caller-supplied values use `StoreValidationError`;
- custom encoder throws and invalid encoded values use `StoreAdapterContractViolation` with `"invalid-column-encoding"`; and
- direct or custom decode failures, non-JSON decoded values, and read-side Select Schema rejections use `StoreAdapterContractViolation` with `"invalid-selected-record"`.

`resolveSqliteRecords()` reuses the database-neutral issue codes:

- names use `invalid-name`;
- catalog collisions use `duplicate-name`;
- missing storage evidence uses `column-type-required`;
- invalid effective direct contracts, custom structure, or converters use `invalid-column-type`;
- defaults use `invalid-column-default`;
- ROWID, generation, nullability, primary-key, and other SQLite option conflicts use `invalid-database-options`; and
- composition uses the existing contribution and override codes.

Issues point to the winning `records` or `overrides` source. A conflict points to the later or higher-precedence setting and names the other source in its message. A duplicate issue belongs to the later name. Composition and override issues precede effective-catalog checks. Effective checks then follow Record declaration and this fixed order:

1. table name, table-format validity, and portable primary-key structure;
2. for each field in declaration order: column name, opaque type identity, storage evidence, Select compatibility, direct or custom type contract, default, nullability, ROWID, generation, and cross-property compatibility;
3. table-wide primary-key resolution, ROWID count and agreement, the non-generated-column rule, and column-name collisions; and
4. table-name collisions across Records.

When two owned names or references enter the same step, first use controls order and the issue belongs to the later one. Checks that depend on one invalid prerequisite are skipped; every independent check continues.

SQLite metadata, column types, Statements, and resolutions use opaque format identity instead of module-local `instanceof`. Compatible `@commissary/store` package copies interoperate. Incompatible formats and caller-made lookalikes fail. Freeze package-owned objects, arrays, resolutions, references, and issue lists; keep Schema objects and converter functions by reference.

### SQL Statements

The `@commissary/store/sql` public types are:

```ts
export type SqlParameterValue = null | boolean | number | string;

export interface SqlStatement<out Parameter> {
  // Opaque package-owned data. Parameter has no default type argument.
}

export interface SqlCommandResult<out DriverResult = unknown> {
  readonly affectedRows: number | undefined;
  readonly driverResult: DriverResult;
}

export interface SqlStore<
  Definitions extends RecordDefinitions,
  Operators extends StoreOperatorTypes = BaseStoreOperatorTypes,
  out DriverResult = unknown,
  CreateInputs extends StoreCreateInputMap<Definitions> = DefaultStoreCreateInputs<Definitions>,
> extends Store<Definitions, Operators, CreateInputs> {
  readonly query: <Row = unknown>(
    statement: SqlStatement<SqlParameterValue>,
  ) => Promise<readonly Row[]>;
  readonly execute: (
    statement: SqlStatement<SqlParameterValue>,
  ) => Promise<SqlCommandResult<DriverResult>>;
}
```

`SqlStatement<never>` has no bound values. `SqlStatement<unknown>` has no known narrower requirement. The type is covariant. Primitive literals widen to `string`, `number`, and `boolean`. The `Row` selected by `query<Row>()` is unchecked and defaults to `unknown`. `DriverResult` is covariant and defaults to `unknown`, so a concrete Store can retain an exact public driver result while it remains assignable to generic `SqlStore`.

`CreateInputs` preserves the effective create-input map after hooks adjust it. A wider SQL transaction composition must pass the same `CreateInputs` to both primitive contracts and to the transaction view:

```ts
type SqlTransactionStore<
  Definitions extends RecordDefinitions,
  Operators extends StoreOperatorTypes,
  DriverResult,
  CreateInputs extends StoreCreateInputMap<Definitions>,
> = SqlStore<Definitions, Operators, DriverResult, CreateInputs> &
  TransactionStore<
    Definitions,
    Operators,
    Pick<SqlStore<Definitions, Operators, DriverResult, CreateInputs>, "query" | "execute">,
    CreateInputs
  >;
```

Definition and binder compile-time tests must prove that a hook-guaranteed field is optional through both the base binding and its transaction view, while an unrelated required field stays required.

The complete helper set is:

```ts
sql`SELECT ${value}`;
sql.raw(text);
sql.identifier(name);
sql.param(value);
sql.param(value, { encode });
sql.join(statements, separator?);
```

All helpers return `SqlStatement` except the SQL Column Type and SQL Literal constructors.

#### Helper behavior

- A nested Statement contributes structure and its parameter requirements.
- A plain interpolation contributes one bound parameter.
- `sql.raw()` inserts exact unchecked structure and never inspects placeholder-like text.
- `sql.identifier()` creates one quoted name part. It rejects a non-string, empty string, or NUL. It never splits on `.`.
- `sql.param(value)` creates one explicit bound parameter.
- `sql.param(value, { encode })` snapshots the function reference. The synchronous function runs once per occurrence on every operation after `query` or `execute` returns its Promise. Its output becomes the Statement requirement.
- An encoder output type cannot include `SqlStatement`. A runtime bypass rejects as `invalid-parameter` and never becomes SQL structure.
- `sql.join()` accepts only Statements, snapshots the input list, preserves order, adds the optional Statement separator only between items, and adds no parentheses.
- An empty join returns an empty `SqlStatement<never>`.
- Invalid helper structure throws `TypeError` immediately.

Qualification is explicit:

```ts
sql`${sql.identifier("public")}.${sql.identifier("users")}`;
```

### Adapter-facing Statement compiler

The official adapter interface is `@commissary/store/sql/adapter`:

```ts
export interface SqlStatementCompilerOptions<Parameter, DriverParameter> {
  readonly quoteIdentifier: (name: string) => string;
  readonly makePlaceholder: (position: number) => string;
  readonly isParameter: (value: unknown, position: number) => value is Parameter;
  readonly convertParameter: (value: Parameter, position: number) => DriverParameter;
}

export interface CompiledSqlStatement<DriverParameter> {
  readonly text: string;
  readonly parameters: DriverParameter[];
  readonly segments: readonly string[];
}

export declare function compileSqlStatement<Parameter, DriverParameter>(
  statement: SqlStatement<Parameter>,
  options: SqlStatementCompilerOptions<Parameter, DriverParameter>,
): CompiledSqlStatement<DriverParameter>;
```

The compiler:

1. checks origin and format compatibility;
2. composes text segments and quoted identifiers;
3. makes placeholders from zero-based parameter positions;
4. runs explicit encoders;
5. checks adapter support;
6. applies portable validation and negative-zero normalization;
7. converts values for the driver; and
8. returns final text, one fresh driver-owned parameter array in source order, and exact parameter segments.

`segments.length` is always `parameters.length + 1`. Interleaving each segment with its following parameter reconstructs Statement structure without parsing placeholders. The first and last segment can be empty. An empty Statement returns `segments: [""]`. Raw text that looks like a placeholder remains inside its original segment.

`isParameter()` returning false produces `unsupported-parameter`. A thrown encoder, support check, or conversion produces `invalid-parameter` with its position and cause. A non-finite number or a string that contains NUL produces `invalid-parameter` without a cause. A failed quote or placeholder callback, or a non-string callback result, produces `StoreAdapterContractError` with `invalid-sql-compilation`.

### Parameter rules

- `null` becomes SQL `NULL`.
- PostgreSQL keeps boolean values. MySQL and SQLite use `1` or `0`.
- Numbers accept every finite JavaScript binary64 value. Negative zero becomes zero.
- Strings pass unchanged except that NUL is invalid.
- `undefined` is unsupported.
- A wider Store can accept additional value types, but not `undefined`.
- A wider mutable parameter stays by reference and is read when execution starts. The caller must not change it while that execution remains active.

### `query` and `execute` behavior

Both methods:

- return a native Promise before Statement checks, parameter work, or driver work;
- send a genuine empty Statement to the driver;
- make at most one statement call; and
- perform no retry.

`query<Row>()` is for any statement that produces one row set, including DML with `RETURNING`. It returns the driver's row array directly without copying or freezing it. The caller-selected `Row` type is unchecked. The adapter rejects a successful non-array result and rejects multiple ordered result sets without choosing, joining, or dropping them.

`execute()` is for a statement that produces no row set. It returns one fresh `SqlCommandResult`. `driverResult` is the exact public driver result by reference. `affectedRows` is a nonnegative safe integer only when the adapter can verify the driver's documented direct-change count; otherwise it is `undefined`. The adapter does not issue another statement, derive a count from an inserted identifier, or invent unavailable metadata.

The adapter must not change a returned row container or driver result after fulfillment. A later driver mutation is an adapter defect, but an already fulfilled Promise cannot become rejected.

### SQL errors

Add `"query"` and `"execute"` to `StoreOperation`.

```ts
export type SqlOperation = "query" | "execute";

export type SqlStatementErrorOptions = {
  readonly operation: SqlOperation;
} & (
  | { readonly reason: "invalid-statement" }
  | {
      readonly reason: "unsupported-parameter";
      readonly parameterPosition: number;
    }
  | {
      readonly reason: "invalid-parameter";
      readonly parameterPosition: number;
      readonly cause?: unknown;
    }
);

export type SqlExecutionErrorOptions = {
  readonly operation: SqlOperation;
} & (
  | {
      readonly reason: "execution-failed";
      readonly executionMayHaveOccurred: boolean;
      readonly cause: unknown;
    }
  | {
      readonly reason: "multiple-results";
      readonly executionMayHaveOccurred: true;
    }
);

export declare class SqlStatementError extends StoreError {
  readonly name: "SqlStatementError";
  readonly operation: SqlOperation;
  readonly reason: SqlStatementErrorOptions["reason"];
  readonly parameterPosition?: number;
  readonly cause?: unknown;
  constructor(options: SqlStatementErrorOptions);
}

export declare class SqlExecutionError extends StoreError {
  readonly name: "SqlExecutionError";
  readonly operation: SqlOperation;
  readonly reason: SqlExecutionErrorOptions["reason"];
  readonly executionMayHaveOccurred: boolean;
  readonly cause?: unknown;
  constructor(options: SqlExecutionErrorOptions);
}
```

`SqlStatementError` and `SqlExecutionError` extend `StoreError` and retain the attempted `query` or `execute` operation. An `invalid-statement` error has no parameter position or cause. An `unsupported-parameter` error has its zero-based parameter position and no cause. An `invalid-parameter` error has its zero-based parameter position and has a cause only when parameter processing threw. Statement errors contain no SQL text or parameter value.

An `execution-failed` error has its cause and `executionMayHaveOccurred` flag. A `multiple-results` error has no cause, has `executionMayHaveOccurred` set to true, and contains no returned data. `executionMayHaveOccurred` is false only before the driver statement call starts. It is true after the call starts or when the outcome is uncertain.

An invalid successful query result rejects before fulfillment with:

```ts
new StoreAdapterContractError({
  operation: "query",
  violation: "invalid-sql-result",
});
```

A non-array query result is invalid. A failure thrown while checking a result can be its cause, but returned data cannot. Add `invalid-sql-compilation` and `invalid-sql-result` to `StoreAdapterContractViolation`.

## Transactions

A concrete Store with SQL and transactions exposes `query` and `execute` at its root and in its Transaction View. The View also exposes its Collections and each safe wider capability. It does not expose `transaction`.

Manual `BEGIN`, `COMMIT`, `ROLLBACK`, savepoints, and equivalent SQL through `query` or `execute` are unsupported. Adapters need not parse or detect them. Transaction guarantees apply only when callers do not submit them. Conformance tests never submit them.

### Shared callback runner

The official adapter helper is `@commissary/store/transaction-adapter`:

```ts
export type TrackTransactionOperation = <Value>(start: () => Promise<Value>) => Promise<Value>;

export declare function runTransactionCallback<View, Value>(
  makeView: (track: TrackTransactionOperation) => View,
  use: (view: View) => Promise<Value>,
): Promise<Value>;
```

Every Transaction View method wraps its complete operation with `track()`. The helper returns a native Promise before it creates the View or calls user code. It assigns operation order when `track` is called.

The helper:

- calls the public callback at most once;
- closes the View when that callback settles;
- rejects each later tracked call with `TransactionClosedError` before `start` runs;
- records every operation rejection, including one caught by callback code;
- detects work still active when a successful callback settles;
- drains all active work before it settles; and
- returns the callback value or rejects with the selected boundary failure.

It does not start, commit, roll back, or release a physical transaction. The adapter wraps its database transaction operation around this helper.

`TransactionClosedError` and `TransactionUnsettledOperationError` extend `StoreError`, accept no constructor options, and expose no operation input.

Failure priority is:

1. the callback's exact rejection value;
2. `TransactionUnsettledOperationError` when a successful callback leaves active work;
3. the first failed View operation in call order when the callback otherwise succeeds; and
4. commit when no failure exists.

A View operation rejection dooms the transaction even if the callback catches it. Recovery would require an unsupported savepoint or nested transaction. Several operation failures use call order, not completion order.

After the helper rejects, the adapter rolls back. Successful rollback preserves the selected value exactly. Failed rollback creates `TransactionRollbackError` with the selected value as `callbackFailure`, the physical failure as `rollbackFailure`, and `writesMayRemain: true`.

If active work never settles, the transaction remains pending. It never commits and never races rollback against active work. Base Store has no safe timeout or cancellation rule. Hosts must use backend-specific operation, transaction, session, and lock limits plus monitoring so active work settles before rollback starts.

Overlapping View calls are allowed. An adapter can serialize them. Store promises no order or parallel execution. Callers await operations in sequence when order matters.

## Shared Conformance Interface

Keep three shared groups:

1. SQL Statement;
2. SQL Store; and
3. combined SQL Transaction Store.

An adapter runs only the groups for the interfaces it implements. SQL Record definition behavior also has package-level runtime and compile-time tests; it does not add a fourth adapter suite.

A fixed conformance Record has portable `id`, `label`, and `rank` fields.

```ts
export interface SqlStoreConformanceProfile<DriverParameter> {
  readonly adapter: string;
  readonly expectedCompilation: {
    readonly text: string;
    readonly parameters: readonly DriverParameter[];
    readonly segments: readonly string[];
  };
}

export interface SqlStoreConformanceDriverCall<DriverParameter> {
  readonly operation: SqlOperation;
  readonly text: string;
  readonly parameters: readonly DriverParameter[];
}

export type SqlStoreConformanceOutcome<DriverResult> =
  | { readonly kind: "query"; readonly rows: readonly unknown[] }
  | {
      readonly kind: "command";
      readonly affectedRows: number | undefined;
      readonly driverResult: DriverResult;
    }
  | {
      readonly kind: "failure";
      readonly stage: "before-statement-call" | "statement-call";
      readonly cause: unknown;
    }
  | { readonly kind: "multiple-results" }
  | {
      readonly kind: "invalid-query-result";
      readonly shape: "non-array" | "result-check-failure";
      readonly cause?: unknown;
    };

export interface SqlStoreConformanceControls<DriverParameter, DriverResult> {
  readonly driverCalls: readonly SqlStoreConformanceDriverCall<DriverParameter>[];
  readonly enqueueOutcome: (outcome: SqlStoreConformanceOutcome<DriverResult>) => void;
}

export interface SqlStoreConformanceFixture<DriverParameter, DriverResult> {
  readonly store: SqlStore<
    typeof sqlStoreConformanceRecordDefinitions,
    BaseStoreOperatorTypes,
    DriverResult
  >;
  readonly controls: SqlStoreConformanceControls<DriverParameter, DriverResult>;
}

export interface SqlStoreConformanceAdapter<DriverParameter, DriverResult> {
  readonly profile: SqlStoreConformanceProfile<DriverParameter>;
  readonly makeFixture: () =>
    | SqlStoreConformanceFixture<DriverParameter, DriverResult>
    | Promise<SqlStoreConformanceFixture<DriverParameter, DriverResult>>;
}
```

Each scenario gets a new empty Store and new controls. There is no reset operation or shared call history. Queued outcomes are consumed in call order. With no queued outcome, the fixture uses its real test driver path. The profile supplies expected SQL text and driver parameters for one fixed Statement. Shared tests do not guess a dialect.

The combined fixture adds:

```ts
export interface SqlTransactionStoreConformanceStatements {
  readonly insertJob: (job: {
    readonly id: string;
    readonly label: string;
    readonly rank: number;
  }) => SqlStatement<SqlParameterValue>;
  readonly deleteJob: (id: string) => SqlStatement<SqlParameterValue>;
}

export interface HeldTransactionConformanceOperation {
  readonly started: Promise<void>;
  readonly release: () => void;
}

export interface TransactionConformanceControls {
  readonly beginCount: number;
  readonly commitCount: number;
  readonly rollbackCount: number;
  readonly holdNextOperation: () => HeldTransactionConformanceOperation;
  readonly failNextRollback: (cause: unknown) => void;
}
```

```ts
export type SqlTransactionStoreConformanceStore<DriverResult> = SqlStore<
  typeof sqlStoreConformanceRecordDefinitions,
  BaseStoreOperatorTypes,
  DriverResult
> &
  TransactionStore<
    typeof sqlStoreConformanceRecordDefinitions,
    BaseStoreOperatorTypes,
    Pick<
      SqlStore<typeof sqlStoreConformanceRecordDefinitions, BaseStoreOperatorTypes, DriverResult>,
      "query" | "execute"
    >
  >;

export interface SqlTransactionStoreConformanceFixture<DriverParameter, DriverResult> {
  readonly store: SqlTransactionStoreConformanceStore<DriverResult>;
  readonly sqlControls: SqlStoreConformanceControls<DriverParameter, DriverResult>;
  readonly transactionControls: TransactionConformanceControls;
  readonly statements: SqlTransactionStoreConformanceStatements;
}

export interface SqlTransactionStoreConformanceAdapter<DriverParameter, DriverResult> {
  readonly profile: SqlStoreConformanceProfile<DriverParameter>;
  readonly makeFixture: () =>
    | SqlTransactionStoreConformanceFixture<DriverParameter, DriverResult>
    | Promise<SqlTransactionStoreConformanceFixture<DriverParameter, DriverResult>>;
}
```

The Statement group is package-owned, runs once in `@commissary/store`, and has no adapter input interface. The SQL Store suite accepts `SqlStoreConformanceAdapter`. The combined SQL and transaction suite accepts `SqlTransactionStoreConformanceAdapter`. Every scenario gets a fresh fixture. The combined Store exposes `query` and `execute` at its root and through `TransactionCapabilities`; its Transaction View remains closed to nested transactions.

### Exact scenario areas

Package-level SQL Record tests cover:

- frozen definition structure without freezing schema objects;
- explicit portable types and defaults;
- Select output reflection and fallback targets;
- local references, cycles, clear unions and intersections, and unclear storage families;
- missing, selected null, and JSON null;
- contribution conflicts, deep overrides, null removal, and compatibility inference;
- final table and column conflicts; and
- immutable resolved references for base and SQL definitions.

PostgreSQL Record specialization tests cover:

- portable physical mappings, active PostgreSQL refinement, deep overrides, and null removal;
- every direct helper's value inference, physical discriminant, options, and canonical codec boundaries;
- rectangular arrays, one-based bounds, null elements, reusable enums, and first-use enum assets;
- custom qualified names, modifiers, shared encoded values, converter failures, and package compatibility;
- defaults, both identity modes, sequence controls, stored generation, write rules, and every conflict;
- exact names, 63-byte limits, PostgreSQL namespaces, stable issue order, and dependent-check skipping; and
- immutable table, column, enum, reference, codec, generated, and issue assets.

MySQL Record specialization tests cover:

- portable physical mappings, active MySQL refinement, deep overrides, and null removal;
- every direct helper's value inference, physical discriminant, options, and canonical codec boundaries;
- inline enums, custom type Statements, shared encoded values, converter failures, and package compatibility;
- `AUTO_INCREMENT`, `SERIAL`, host key requirements, generated modes, automatic updates, write rules, and every conflict;
- exact names, Unicode limits, case-folded catalog collisions, stable issue order, and dependent-check skipping; and
- immutable table, column, reference, codec, generated, and issue assets.

SQLite Record specialization tests cover:

- every named helper's value inference, storage discriminant, and direct codec boundaries;
- portable type mapping, active SQLite refinement, deep overrides, and null removal;
- custom type structure, encoded values, converter failures, and package compatibility;
- ordinary and `AUTOINCREMENT` ROWID generation, explicit safe integers, and every conflict;
- virtual and stored generation, write rejection, and the non-generated-column rule;
- exact names, reserved table names, ASCII-folded collisions, and no Unicode normalization;
- stable multi-issue order and dependent-check skipping; and
- immutable table, column, reference, codec, and issue assets.

Statement tests cover:

- immediate helper `TypeError` cases;
- frozen Statements and copied helper structure;
- nested composition, exact raw text, one-part identifiers, and empty joins;
- arrays as one parameter;
- literal widening, covariance, `never`, nested requirements, and rejected encoder Statement output;
- left-to-right order and first-failure stopping;
- encoder timing, occurrence count, option capture, and cause identity;
- fresh driver parameter arrays;
- compiler callback defects; and
- compatible package copies, incompatible formats, and counterfeit values.

SQL Store tests cover:

- native Promise timing and no synchronous throw;
- the fixed compiled call against the adapter profile;
- every portable and invalid portable value;
- exact zero-based parameter positions and zero driver calls after compilation failure;
- failures before and during each driver statement call;
- one call and no retry for `query` and `execute`;
- empty SQL reaching both driver paths;
- empty and nonempty unchecked query rows with caller-selected types;
- normalized defined and unavailable affected-row counts;
- exact driver-result identity;
- direct SQL bypassing Collection parsing;
- invalid query result shapes and result-check failures;
- multiple-result rejection; and
- safe errors with no SQL text or parameter value.

Combined transaction tests cover:

- SQL insert plus Collection read and Collection create plus SQL delete in one commit;
- the same mixed writes disappearing after rollback;
- one callback call and one physical begin;
- one commit or one rollback;
- `query` and `execute` in the View and no nested `transaction`;
- closed SQL and Collection methods;
- active-work draining before rollback;
- callback identity while work drains;
- caught operation failure;
- first failed operation in call order;
- callback, unsettled-work, and operation-failure priority;
- rollback failure preserving both failures; and
- adapters that serialize overlapping View calls.

Test controls never appear on production Store values.

## Data Flow

### SQL and database Record definition

```txt
Integration-authored lower-tier Records
  -> SqlRecord.define with sql.table/column and optional pg/mysql/sqlite refinements
  -> concrete host adapter calls the matching database resolver with records + overrides
  -> resolver composes one effective Record catalog
  -> resolver checks contributor compatibility
  -> resolver chooses the active database metadata
  -> resolver resolves names, types, generated behavior, assets, and conflicts
  -> freeze the database resolution assets + .records references
  -> concrete adapter maps the plan into its ORM or driver values
```

No database I/O occurs in this flow.

### Statement query and execution

```txt
query(Statement) or execute(Statement)
  -> return native Promise
  -> check Statement origin and format
  -> compile structure and identifiers
  -> encode, check, validate, and convert parameters in source order
  -> make at most one driver statement call
  -> query: recognize and return exactly one unchecked row array
  -> execute: return { affectedRows, driverResult }
  -> reject with one SQL error on failure
```

### Combined transaction

```txt
physical database transaction
  -> runTransactionCallback
  -> make one View bound to that physical transaction
  -> SQL and Collection calls enter track()
  -> callback settles and View closes
  -> active work drains
  -> select callback boundary result
     -> success: physical commit
     -> failure: physical rollback
  -> preserve selected failure or report rollback failure
```

## Approval Scenarios and Verdict

The approval prototype tested four awkward paths:

1. Ambiguous Select reflection stopped before database work. An explicit SQL Column Type then resolved the definition after the host table override.
2. A supported parameter followed by an unsupported `Date` failed at position `1` and made zero driver calls.
3. A successful callback with active Store work closed the View, waited for that work, and rolled back with `TransactionUnsettledOperationError`.
4. A caught transaction-view operation failure still caused rollback and preserved the first failure.

A strict TypeScript prototype also proved:

- nested Statement requirement inference;
- primitive literal widening and covariance;
- rejection of `Date` at generic `SqlStore`;
- wider Store substitution;
- SQL Column Type and default compatibility;
- resolved Record reference composition; and
- `query` and `execute` in a transaction view without nested `transaction`.

The SQLite logic prototype also proved:

- portable mapping and named SQLite refinement without a second Record;
- ordinary and `AUTOINCREMENT` ROWID ownership;
- generated-column omission and explicit-write rejection;
- reserved-name, cross-property, table-wide, and ASCII-collision issue order; and
- separation between synchronous definition resolution and live driver binding.

The Drizzle SQLite adapter prototype also proved:

- the common synchronous and asynchronous database shape;
- visible `query` and `execute` dispatch through `all` and `run`;
- generic unchecked rows, normalized affected counts, and exact driver-result identity;
- primary-key and unshadowed ROWID candidate identity;
- observed-value guards and stored-value readback;
- rejection of synchronous or early-closing asynchronous transaction paths; and
- structured SQLite `BUSY` recognition without message parsing.

The comparative database Record prototype also proved:
The committed draft asset is `packages/store/prototypes/database-record-specializations.prototype.html` on branch `prototype/database-record-specializations` at commit `1b96bfb`. From that branch, run `agent-browser open "file://$PWD/packages/store/prototypes/database-record-specializations.prototype.html"` to reproduce the free-play and guided cross-database plan, encoder, generated-column, and adapter-binding results.

- one lower-tier SQL Record resolves into complete PostgreSQL, MySQL, and SQLite plans;
- portable integer, number, boolean, text, and JSON mappings preserve one application contract across different physical types;
- custom encoders use one `SqlCustomEncodedValue` contract;
- generated columns normalize to one expression-and-mode asset while retaining database modes;
- final plans expose physical facts and codecs without authoring-history markers;
- every resolver follows the same failure ownership and issue-order skeleton; and
- live driver, engine, index, and constraint checks remain in concrete adapter binding.

**Verdict**: The portable SQL Store tier, the Drizzle-independent PostgreSQL, MySQL, and SQLite Record specializations, and the three concrete Drizzle binding designs are implementation-ready. Package exports and final cross-adapter integration remain in later gates.

## Files for Implementation

### Add

- `packages/store/src/sql/index.ts` — caller-facing SQL public entrypoint.
- `packages/store/src/sql/record.ts` — definitions, portable column types, literals, reflection, issues, and references.
- `packages/store/src/sql/postgres/index.ts` — caller-facing PostgreSQL metadata public entrypoint.
- `packages/store/src/sql/postgres/record.ts` — `pg` metadata and column type constructors.
- `packages/store/src/sql/postgres/adapter.ts` — PostgreSQL Record resolver and readonly adapter assets.
- PostgreSQL runtime and compile-time tests under `packages/store/test/sql/postgres`.
- `packages/store/src/sql/mysql/index.ts` — caller-facing MySQL metadata public entrypoint.
- `packages/store/src/sql/mysql/record.ts` — `mysql` metadata and column type constructors.
- `packages/store/src/sql/mysql/adapter.ts` — MySQL Record resolver and readonly adapter assets.
- MySQL runtime and compile-time tests under `packages/store/test/sql/mysql`.
- `packages/store/src/sql/sqlite/index.ts` — caller-facing SQLite metadata public entrypoint.
- `packages/store/src/sql/sqlite/record.ts` — `sqlite` metadata and named column type constructors.
- `packages/store/src/sql/sqlite/adapter.ts` — SQLite Record resolver and readonly adapter assets.
- SQLite runtime and compile-time tests under `packages/store/test/sql/sqlite`.
- `packages/store/src/sql/statement.ts` — opaque Statement values and `sql` helpers.
- `packages/store/src/sql/errors.ts` — shared SQL failure definitions re-exported by the SQL Store module.
- `packages/store/src/sql/store.ts` — `SqlStore`, adapter runtime, and result contracts.
- `packages/store/src/sql/adapter.ts` — Statement compiler.
- `packages/store/src/transaction-adapter.ts` — callback runner.
- `packages/store/src/sql/conformance.ts` — SQL Store conformance contracts and suites.
- SQL runtime and compile-time tests under `packages/store/test/sql`.

### Change

- `packages/store/package.json` — export `./sql`, `./sql/adapter`, `./sql/conformance`, the planned `./sql/postgres`, `./sql/postgres/adapter`, `./sql/mysql`, `./sql/mysql/adapter`, `./sql/sqlite`, and `./sql/sqlite/adapter`, plus `./transaction-adapter`.
- `packages/store/src/sql/index.ts` — export caller-facing portable SQL values and types.
- `packages/store/src/sql/postgres/index.ts`, `packages/store/src/sql/mysql/index.ts`, and `packages/store/src/sql/sqlite/index.ts` — export each database's metadata values and types.
- `packages/store/src/sql/conformance.ts` — export the three shared SQL groups.
- `packages/store/src/record.ts` — store effective Select outputs after create and update normalization.
- `packages/store/src/store.ts` — keep transaction capability typing and use the strengthened callback contract.
- `packages/store/src/store-errors.ts` — add SQL and transaction-view errors plus `invalid-column-encoding`.
- `packages/core` Record definitions — publish explicit portable and approved database-specific metadata without importing an ORM.
- Every concrete SQL adapter — run the applicable shared conformance groups and use the matching database Record resolver.

No implementation keeps the old create/update storage path, host-record merge alias, or weaker transaction callback behavior.

## Implementation Order

1. Cut create and update storage over to effective Select outputs.
2. Add Store-neutral contributions, overrides, and definition helpers.
3. Add SQL Record types, `sql.table()` / `sql.column()`, portable storage values, reflection, errors, and references.
4. Add the Statement algebra and compile-time inference tests.
5. Add the Statement compiler and SQL errors.
6. Add the transaction callback runner and transaction-view errors.
7. Add SQL Store and combined transaction conformance suites.
8. Add `pg` metadata, direct and custom column types, enum assets, and option validation.
9. Add the PostgreSQL adapter resolver, physical mappings, resolution assets, failure aggregation, and compile-time tests.
10. Add `mysql` metadata, direct and custom column types, inline enums, and option validation.
11. Add the MySQL adapter resolver, physical mappings, resolution assets, failure aggregation, and compile-time tests.
12. Add `sqlite` metadata, named direct and custom column types, and option validation.
13. Add the SQLite adapter resolver, physical mappings, resolution assets, failure aggregation, and compile-time tests.
14. Add explicit Core portable and approved PostgreSQL, MySQL, and SQLite metadata.

Each step must keep the package root plain JavaScript and native Promise based. Effect can remain an internal implementation tool.

## Deferred Capabilities

Do not define these capabilities in this tier:

- prepared execution;
- bounded row delivery;
- streaming;
- cancellation;
- physical-session scope;
- Batch Store;
- ordered multiple results;
- database-generated value recovery;
- indexes and relations; and
- migration execution or schema diffing.

Each needs a real caller and its own cleanup, failure, and conformance rules.

## Residual Risks

- Runtime Standard JSON Schema conversion can be absent or less precise than static schema types. Explicit column types remain required in unclear cases.
- A runtime schema refinement can reject values that static contributor compatibility accepts. The host owns this risk.
- Mutable wider parameter values can change during execution. The caller must keep them stable until settlement.
- A driver can mutate a returned row container or driver result after fulfillment. This is an adapter defect that cannot retroactively reject a Promise.
- A transaction operation that never settles keeps the transaction pending. Portable Store cannot cancel it safely.
- Manual transaction SQL can break transaction guarantees because adapters do not parse `query` or `execute` Statements.

## References

- [ADR 0019: Build Thread Store on generic Store primitives](../adr/0019-build-thread-store-on-generic-store-primitives.md)
- [Store Architecture Technical Specification](store.md)
- [Drizzle Store Technical Specification](drizzle-store.md)
- [Drizzle SQLite Store Adapter Technical Specification](drizzle-sqlite-store.md)
- [SQL Record definition resolution](https://github.com/spiritledsoftware/commissary/issues/9#issuecomment-5194052181)
- [SQL Store interface and transaction resolution](https://github.com/spiritledsoftware/commissary/issues/11#issuecomment-5198678963)
- [SQL Store caller use cases](https://github.com/spiritledsoftware/commissary/issues/13#issuecomment-5179152149)
- [Drizzle SQLite Store adapter decisions](https://github.com/spiritledsoftware/commissary/issues/18)
- [Standard JSON Schema V1 interface](https://github.com/standard-schema/standard-schema#what-schema-specifications-does-standard-schema-implement)
- [Drizzle SQL template](https://orm.drizzle.team/docs/sql)
- [Effect SQL client](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/sql/SqlClient.ts)
