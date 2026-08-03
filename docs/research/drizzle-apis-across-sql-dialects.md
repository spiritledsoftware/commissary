# Drizzle APIs across PostgreSQL, MySQL, and SQLite

**Snapshot:** 2026-08-03. Source findings are pinned to official Drizzle commit [`b7862528`](https://github.com/drizzle-team/drizzle-orm/commit/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10), whose `drizzle-orm` manifest reports `0.45.3` ([manifest](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/package.json#L1-L4)). Live docs can describe newer providers than that release, so core claims use pinned source while the driver inventory also links the current connection index.

## Answer in brief

Drizzle has parallel-looking but nominally distinct dialect cores. PostgreSQL, MySQL, and SQLite all provide runtime table objects, chained column builders, table indexes and constraints, shared relation metadata, typed CRUD/query builders, raw SQL integration, and callback transactions. That conceptual overlap is not one concrete TypeScript interface: table, column, index, database, query-result, raw-result, and transaction types retain dialect and often driver parameters.

The stable common surface is semantic: exported schema entities; inferred select/insert rows; `select`/`insert`/`update`/`delete`; the shared `sql` wrapper; and callback-scoped transactions. PostgreSQL schemas, RLS, index methods and `DISTINCT ON`; MySQL index administration and `$returningId`; and SQLite's storage modes, four raw execution modes, and sync/async result kind are dialect-specific. Interactive transactions, batching, native result envelopes, prepared-query types, and scheduling are driver-specific.

Drizzle Kit does not consume TypeScript types or a database instance. It expands configured schema paths, executes schema modules, enumerates direct runtime exports, classifies recognized Drizzle entities, and serializes them to a dialect snapshot. Migration DDL comes from table constraints, not `relations()` metadata.

## Tables, columns, indexes, and relations

### Tables

| Property | PostgreSQL | MySQL | SQLite |
| --- | --- | --- | --- |
| Constructor | `pgTable(name, columns, extraConfig?)` | `mysqlTable(name, columns, extraConfig?)` | `sqliteTable(name, columns, extraConfig?)` |
| Runtime type | `PgTable` plus columns | `MySqlTable` plus columns | `SQLiteTable` plus columns |
| Extra config | indexes, checks, foreign/primary/unique keys, `PgPolicy` | indexes, checks, foreign/primary/unique keys | indexes, checks, foreign/primary/unique keys |
| Namespace feature | `pgSchema(...)`; RLS/policies | `mysqlSchema(...)` for a named schema/database | no corresponding public SQLite schema namespace |

All constructors accept a column map or callback and attach built columns to the returned runtime table. Their signatures are structurally parallel but require dialect column builders and return separate nominal types ([PostgreSQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/pg-core/table.ts#L71-L87), [MySQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-core/table.ts#L61-L79), [SQLite](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/sqlite-core/table.ts#L162-L180)). The official schema guide likewise uses exported runtime model objects and dialect-specific imports ([schema declaration](https://orm.drizzle.team/docs/sql-schema-declaration)). PostgreSQL alone includes policies and an RLS flag in table config ([source](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/pg-core/table.ts#L13-L31), [RLS docs](https://orm.drizzle.team/docs/rls)).

### Columns

Each dialect column builder extends shared `ColumnBuilder`, giving common semantics for `.$type<T>()`, `.notNull()`, `.default(...)`, runtime-only `.$defaultFn(...)`/`.$onUpdateFn(...)`, `.primaryKey()`, and generated columns ([base builder](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/column-builder.ts#L184-L310)). Each dialect adds `.unique(...)` with a different signature; PostgreSQL alone accepts `nulls: 'distinct' | 'not distinct'` ([PostgreSQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/pg-core/columns/common.ts#L75-L95), [MySQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-core/columns/common.ts#L58-L78), [SQLite](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/sqlite-core/columns/common.ts#L57-L79)).

Concrete catalogs are not portable:

- PostgreSQL includes arrays, native enums, `jsonb`, UUID, network/geometric types, intervals, serial/identity families, extensions, and stored generated columns ([catalog](https://orm.drizzle.team/docs/column-types), [source](https://github.com/drizzle-team/drizzle-orm/tree/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/pg-core/columns)).
- MySQL includes signed/unsigned numeric variants, enum/year, binary and blob/text families, `autoIncrement`, and virtual or stored generated columns ([catalog](https://orm.drizzle.team/docs/mysql/column-types), [source](https://github.com/drizzle-team/drizzle-orm/tree/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-core/columns)).
- SQLite maps storage classes through `integer`, `real`, `text`, `blob`, `numeric`, and custom builders; modes change TypeScript representations, and integer primary keys own SQLite autoincrement behavior ([catalog](https://orm.drizzle.team/docs/sqlite/column-types), [source](https://github.com/drizzle-team/drizzle-orm/tree/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/sqlite-core/columns)).

Runtime defaults/update hooks explicitly do not affect Drizzle Kit ([source](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/column-builder.ts#L252-L283)); they are ORM behavior, not DDL defaults.

### Indexes

The common concept is `index(name)` or `uniqueIndex(name)`, then `.on(columnOrExpression, ...)` in table extra config ([official guide](https://orm.drizzle.team/docs/indexes-constraints)). Concrete builders diverge:

| Dialect | Pinned-source index surface |
| --- | --- |
| PostgreSQL | optional generated name; `.on`, `.onOnly`, or `.using`; per-column order/null placement/operator class; `.where`, `.concurrently`, `.with`; btree/hash/GiST/SP-GiST/GIN/BRIN/vector/custom methods |
| MySQL | explicit name; `.on`, then `.using('btree' \| 'hash')`, `.algorithm(...)`, and `.lock(...)` |
| SQLite | explicit name; `.on(columnOrSQL, ...)` and `.where(...)` for a partial index |

Sources: [PostgreSQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/pg-core/indexes.ts#L8-L46), [MySQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-core/indexes.ts#L6-L30), [SQLite](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/sqlite-core/indexes.ts#L6-L50). The common opening call does not make index declarations interchangeable.

### Relations

`relations(table, ({ one, many }) => ...)`, `Relations`, `One`, and `Many` live in a shared module ([implementation](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/relations.ts#L33-L122), [factory](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/relations.ts#L502-L519)). All cores expose `db.query.<table>` only with a full runtime schema and derive it from shared relation config ([PostgreSQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/pg-core/db.ts#L36-L58), [MySQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-core/db.ts#L34-L56), [SQLite](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/sqlite-core/db.ts#L32-L54)). Relations describe application/query joins and do **not** create foreign-key DDL; official docs distinguish the two ([relations](https://orm.drizzle.team/docs/relations), [declaration](https://orm.drizzle.team/docs/relations-schema-declaration)).

## Database instances

The core classes share `$with`/`with`, `$count`, `select`, `selectDistinct`, `insert`, `update`, `delete`, schema-backed `query`, `transaction`, and replica routing. PostgreSQL adds `selectDistinctOn` and `refreshMaterializedView` ([methods](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/pg-core/db.ts#L434-L641)). PostgreSQL and SQLite CRUD builders expose `.returning(...)`; MySQL insert exposes narrower `$returningId()` rather than SQL `RETURNING` ([PostgreSQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/pg-core/query-builders/insert.ts#L280-L300), [SQLite](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/sqlite-core/query-builders/insert.ts#L264-L284), [MySQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-core/query-builders/insert.ts#L268-L303)).

Types retain native variation:

- `PgDatabase<TQueryResultHKT, ...>` preserves the driver result envelope ([source](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/pg-core/db.ts#L36-L40)).
- `MySqlDatabase<TQueryResultHKT, TPreparedQueryHKT, ...>` also preserves prepared-query shape ([source](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-core/db.ts#L34-L39)). `mysql2` has `default` versus `planetscale` relational-query mode ([driver](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql2/driver.ts#L50-L73)).
- `BaseSQLiteDatabase<TResultKind extends 'sync' | 'async', TRunResult, ...>` makes scheduling and native run result part of its type ([source](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/sqlite-core/db.ts#L32-L37)).

### Pinned-source driver variants

The live [connection index](https://orm.drizzle.team/docs/connect-overview) is the public inventory. The pinned first-party source contains:

| Dialect | Adapter entry points | Principal variation |
| --- | --- | --- |
| PostgreSQL | `node-postgres`, `postgres-js`, `neon-serverless`, `neon-http`, `vercel-postgres`, `pglite`, `aws-data-api/pg`, `bun-sql`, `netlify-db`, `xata-http`, `pg-proxy`, `prisma/pg` | pool/socket/client vs HTTP; native result; batch; interactive transactions |
| MySQL | `mysql2`, `planetscale-serverless`, `tidb-serverless`, `mysql-proxy`, `prisma/mysql` | result tuple/header; prepared mode; provider transaction API; proxy limits |
| SQLite | `better-sqlite3`, `bun-sqlite`, `sql-js`, `expo-sqlite`, `durable-sqlite`, `d1`, `libsql` transports, `op-sqlite`, `sqlite-proxy`, `prisma/sqlite` | sync/async core; run result; batch/transaction mechanism; runtime availability |

This comes from the first-party [entry-point tree](https://github.com/drizzle-team/drizzle-orm/tree/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src). Current docs may list providers that reuse an adapter or target a newer release; a provider name is not itself a new database-instance contract.

## Raw statements

The common parameter-aware primitive is `sql\`...\``; `sql.raw(string)` injects literal SQL without escaping and is not parameter binding ([official SQL API](https://orm.drizzle.team/docs/sql)). Core methods differ:

| Dialect | Raw methods | Return contract |
| --- | --- | --- |
| PostgreSQL | `execute(SQLWrapper \| string)` | `PgRaw<PgQueryResultKind<...>>`, driver-result-aware wrapper |
| MySQL | `execute(SQLWrapper \| string)` | `Promise<MySqlQueryResultKind<...>>`, default `ResultSetHeader` |
| SQLite | `run`, `all`, `get`, `values` | `DBResult<TResultKind, ...>`: direct for sync or promise/wrapper for async |

Definitions: [PostgreSQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/pg-core/db.ts#L614-L635), [MySQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-core/db.ts#L473-L487), [SQLite](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/sqlite-core/db.ts#L533-L593). There is no universal `execute(): Row[]` contract.

## Transactions and driver limits

All cores expose callback transactions and transaction objects with `rollback()` via `TransactionRollbackError`. Many concrete sessions implement nested `tx.transaction(...)` with savepoints, but the abstract core does not guarantee every adapter can open an interactive transaction ([official guide](https://orm.drizzle.team/docs/transactions)).

| Dialect | Callback/result | Config |
| --- | --- | --- |
| PostgreSQL | async; `Promise<T>` | isolation, access mode, `deferrable` |
| MySQL | async; `Promise<T>` | consistent snapshot, access mode, isolation |
| SQLite | sync or async follows `TResultKind` | deferred/immediate/exclusive behavior |

Config sources: [PostgreSQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/pg-core/session.ts#L162-L166), [MySQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-core/session.ts#L164-L168), [SQLite](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/sqlite-core/session.ts#L205-L208). Concrete limits:

- Neon HTTP has native batch grouping but interactive `transaction` throws; Neon WebSocket/serverless implements callbacks and savepoints ([HTTP batch](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/neon-http/session.ts#L198-L218), [limit](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/neon-http/session.ts#L247-L265), [WebSocket](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/neon-serverless/session.ts#L259-L300)).
- `xata-http` and `pg-proxy` reject callback transactions ([Xata](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/xata-http/session.ts#L166-L186), [proxy](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/pg-proxy/session.ts#L69-L88)).
- `mysql2` accepts full MySQL config and nested savepoints; PlanetScale/TiDB use provider-native transactions without the full base config parameter ([mysql2](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql2/session.ts#L280-L348), [PlanetScale](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/planetscale-serverless/session.ts#L197-L245), [TiDB](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/tidb-serverless/session.ts#L172-L227)). `mysql-proxy` rejects transactions ([source](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/mysql-proxy/session.ts#L84-L103)).
- Local SQLite adapters such as `better-sqlite3` are synchronous; D1/libSQL/proxy are asynchronous. D1 and libSQL add batch APIs and provider-specific envelopes ([better-sqlite3](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/better-sqlite3/session.ts#L74-L102), [D1](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/d1/driver.ts#L25-L37), [libSQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/libsql/driver-core.ts#L18-L30)).
- Prisma PG, MySQL, and SQLite sessions in this snapshot throw `Method not implemented` for `transaction` despite inheriting the core surface ([PG example](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-orm/src/prisma/pg/session.ts#L60-L73)).

Batch is a driver addition, not a core dialect method. Inherited method presence is not proof of equivalent runtime support.

## How Drizzle Kit consumes runtime schema exports

Public configuration supplies `schema` as a path, directory, glob, or array; models Kit should see must be exported ([config](https://orm.drizzle.team/docs/drizzle-config-file), [organization](https://orm.drizzle.team/docs/sql-schema-declaration#organize-your-schema-files)). `generate`, `push`, and `export` serialize configured TypeScript schema files; `export` prints dialect SQL DDL, not JavaScript schema ([Kit overview](https://orm.drizzle.team/docs/kit-overview), [`export`](https://orm.drizzle.team/docs/drizzle-kit-export)).

Pinned implementation flow:

1. `prepareFilenames` applies globs and accepts `.ts`, `.js`, `.cjs`, `.mjs`, `.mts`, and `.cts`. A matched directory enumerates immediate files; nested directories need a matching glob ([source](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-kit/src/serializer/index.ts#L73-L129)).
2. Kit registers `tsx` under Node, then `require(...)`s each module under a mutex ([loader](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-kit/src/cli/commands/utils.ts#L77-L100), [PG importer](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-kit/src/serializer/pgImports.ts#L69-L97)). This loader is internal, not a promised API.
3. It enumerates `Object.values(moduleExports)` and recognizes runtime entities by predicates/classes. It cannot inspect erased types, unexported locals, arbitrary plain objects, or a `db` instance. PostgreSQL recognizes tables, enums, schemas, sequences, views/materialized views, roles, policies, and relations; MySQL/SQLite schema serialization recognizes tables and views ([PostgreSQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-kit/src/serializer/pgImports.ts#L16-L67), [MySQL](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-kit/src/serializer/mysqlImports.ts#L6-L21), [SQLite](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-kit/src/serializer/sqliteImports.ts#L6-L21)). A barrel `export *` creates direct exports; an exported nested plain object is not recursively traversed.
4. Serializers create snapshots. PostgreSQL's importer collects `Relations`, but `serializePg` does not pass them to `generatePgSnapshot`; MySQL/SQLite do not collect them ([dispatch](https://github.com/drizzle-team/drizzle-orm/blob/b7862528fd8fc39bc2653a6c18dad7c1f4e68d10/drizzle-kit/src/serializer/index.ts#L12-L54)). `relations()` is therefore not migration DDL; SQL foreign keys/constraints must be present on exported tables.

Application runtime use is separate: passing the schema namespace to `drizzle(..., { schema })` enables `db.query` and relation typing. Kit consumes the same entities through configured file paths, not through that database object.

## Later-decision implications

**Common semantics:** exported runtime tables/inferred rows; null/default/key/generated column semantics; table indexes/constraints; relation metadata; typed CTE/count/CRUD builders; `SQL`/`SQLWrapper`; callback transaction and explicit rollback.

**Dialect-qualified:** concrete table/column/index types and SQL options; namespaces/RLS/sequences/views; identity/autoincrement; index controls; `DISTINCT ON`, `RETURNING`, `$returningId`, upsert; raw method names; transaction config.

**Driver-qualified:** database alias/native `$client`; query/prepared/result types; sync/async execution; raw envelope; batch; interactive/nested transactions; whether inherited methods function.

“Same dialect” or “extends the same core class” is not a sufficient capability claim. Later tickets must name dialect and driver for execution behavior, treat Kit's contract as exported runtime entities rather than inferred types, and derive migration constraints from table definitions rather than relation metadata. This note deliberately does not select or design the Commissary adapter.
