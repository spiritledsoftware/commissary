import {
  StoreAdapterError,
  TransactionConflictError,
  TransactionRollbackError,
  type BaseStoreOperatorTypes,
  type RecordDefinitions,
  type StoreCreateInputMap,
  type TransactionStore,
} from "@commissary/store";
import type { SqlStore } from "@commissary/store/sql";
import {
  runTransactionCallback,
  type TrackTransactionOperation,
} from "@commissary/store/transaction-adapter";
import { is, sql as drizzleSql } from "drizzle-orm";
import type { TablesRelationalConfig } from "drizzle-orm/relations";
import { PgDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  createPostgresCollections,
  type PostgresCollectionDatabase,
  type PostgresCollectionDefinitionState,
} from "./postgres-collections.js";
import {
  DrizzlePostgresBindingError,
  type DrizzlePostgresBindingErrorReason,
} from "./postgres-binding-error.js";
import { drizzleDefinitionState, type ConcreteDrizzleDefinition } from "./definition-state.js";
import { createPostgresSqlStore, type PostgresExecutionDatabase } from "./postgres-sql.js";

type PostgresDefinition = {
  readonly records: Readonly<Record<string, object>>;
  readonly schema: Readonly<Record<string, object>>;
  readonly [drizzleDefinitionState]: {
    readonly dialect: "postgres";
    readonly kind: "store" | "thread-store";
    readonly definitions: RecordDefinitions;
    readonly tables: Readonly<Record<string, object>>;
    readonly hooks: unknown;
  };
};

type PostgresBoundStore<Definition, DriverResult> =
  Definition extends ConcreteDrizzleDefinition<
    "postgres",
    "store" | "thread-store",
    infer Definitions,
    infer _Records,
    infer _Tables,
    infer _Schema,
    infer _Hooks,
    infer CreateInputs
  >
    ? SqlStore<Definitions, BaseStoreOperatorTypes, DriverResult, CreateInputs>
    : never;

type PostgresTransactionBoundStore<Definition, DriverResult> =
  Definition extends ConcreteDrizzleDefinition<
    "postgres",
    "store" | "thread-store",
    infer Definitions,
    infer _Records,
    infer _Tables,
    infer _Schema,
    infer _Hooks,
    infer CreateInputs
  >
    ? SqlStore<Definitions, BaseStoreOperatorTypes, DriverResult, CreateInputs> &
        TransactionStore<
          Definitions,
          BaseStoreOperatorTypes,
          Pick<
            SqlStore<Definitions, BaseStoreOperatorTypes, DriverResult, CreateInputs>,
            "query" | "execute"
          >,
          CreateInputs
        >
    : never;

type RuntimePostgresStore = SqlStore<
  RecordDefinitions,
  BaseStoreOperatorTypes,
  unknown,
  StoreCreateInputMap<RecordDefinitions>
>;

interface RuntimePostgresDatabase
  extends PostgresExecutionDatabase<unknown>, PostgresCollectionDatabase {
  readonly transaction: <Value>(
    use: (transaction: RuntimePostgresDatabase) => Promise<Value>,
    config: {
      readonly isolationLevel: "serializable";
      readonly accessMode?: "read only";
    },
  ) => Promise<Value>;
}

function bindingError(
  reason: DrizzlePostgresBindingErrorReason,
  options?: { readonly cause?: unknown; readonly version?: number },
): DrizzlePostgresBindingError {
  return new DrizzlePostgresBindingError({ reason, ...options });
}

function isRuntimeRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPostgresRows(result: unknown): readonly unknown[] | undefined {
  if (Array.isArray(result)) return result;
  if (!isRuntimeRecord(result)) return undefined;
  const rows = Reflect.get(result, "rows");
  return Array.isArray(rows) ? rows : undefined;
}

function readPostgresServerVersion(result: unknown): number {
  const rows = readPostgresRows(result);
  const row = rows?.length === 1 ? rows[0] : undefined;
  if (!isRuntimeRecord(row)) throw bindingError("invalid-version-result");
  const value = Reflect.get(row, "server_version_num");
  const version =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw bindingError("invalid-version-result");
  }
  return version;
}

function requirePostgresTransactionSettings(result: unknown): void {
  const rows = readPostgresRows(result);
  const row = rows?.length === 1 ? rows[0] : undefined;
  if (
    !isRuntimeRecord(row) ||
    Reflect.get(row, "transaction_isolation") !== "serializable" ||
    Reflect.get(row, "transaction_read_only") !== "on"
  ) {
    throw bindingError("transaction-unavailable");
  }
}

async function probePostgresVersion(database: RuntimePostgresDatabase): Promise<void> {
  let result: unknown;
  try {
    result = await database.execute(drizzleSql`SHOW server_version_num`);
  } catch (cause) {
    throw bindingError("probe-failed", { cause });
  }
  const version = readPostgresServerVersion(result);
  if (version < 150_000) {
    throw bindingError("unsupported-postgres-version", { version });
  }
}

async function probePostgresTransaction(database: RuntimePostgresDatabase): Promise<void> {
  try {
    await database.transaction(
      async (transaction) => {
        const result = await transaction.execute(drizzleSql`
          SELECT
            current_setting('transaction_isolation') AS transaction_isolation,
            current_setting('transaction_read_only') AS transaction_read_only
        `);
        requirePostgresTransactionSettings(result);
      },
      { isolationLevel: "serializable", accessMode: "read only" },
    );
  } catch (cause) {
    throw bindingError("transaction-unavailable", { cause });
  }
}

function createRuntimePostgresStore(
  database: RuntimePostgresDatabase,
  state: PostgresCollectionDefinitionState,
  track?: TrackTransactionOperation,
): RuntimePostgresStore {
  const collections = createPostgresCollections(database, state, track);
  const sqlStore = createPostgresSqlStore(database, collections);
  if (track === undefined) return sqlStore;
  const query: RuntimePostgresStore["query"] = (statement) =>
    track(() => sqlStore.query(statement));
  const execute: RuntimePostgresStore["execute"] = (statement) =>
    track(() => sqlStore.execute(statement));
  return Object.freeze({ collections, query, execute });
}

function postgresSqlState(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const code = Reflect.get(current, "code");
    if (typeof code === "string") return code;
    current = Reflect.get(current, "cause");
  }
  return undefined;
}

function isPostgresTransactionConflict(error: unknown): boolean {
  const code = postgresSqlState(error);
  return code === "40001" || code === "40P01";
}

function runPostgresTransaction<Value>(options: {
  readonly database: RuntimePostgresDatabase;
  readonly state: PostgresCollectionDefinitionState;
  readonly use: (transaction: RuntimePostgresStore) => Promise<Value>;
}): Promise<Value> {
  return Promise.resolve().then(async () => {
    let callbackStarted = false;
    let callbackCompleted = false;
    let callbackFailure: unknown;
    let callbackFailed = false;
    try {
      return await options.database.transaction(
        async (transaction) => {
          callbackStarted = true;
          try {
            const value = await runTransactionCallback(
              (track) => createRuntimePostgresStore(transaction, options.state, track),
              options.use,
            );
            callbackCompleted = true;
            return value;
          } catch (cause) {
            callbackFailed = true;
            callbackFailure = cause;
            throw cause;
          }
        },
        { isolationLevel: "serializable" },
      );
    } catch (cause) {
      if (callbackFailed) {
        if (cause === callbackFailure) {
          if (isPostgresTransactionConflict(cause)) {
            throw new TransactionConflictError(cause);
          }
          throw cause;
        }
        throw new TransactionRollbackError({ callbackFailure, rollbackFailure: cause });
      }
      if (isPostgresTransactionConflict(cause)) {
        throw new TransactionConflictError(cause);
      }
      throw new StoreAdapterError({
        operation: "transaction",
        cause,
        writesMayRemain: callbackStarted && callbackCompleted,
      });
    }
  });
}

function readPostgresDefinitionState(definition: unknown): PostgresCollectionDefinitionState {
  if (!isRuntimeRecord(definition)) throw bindingError("invalid-database");
  const state = Reflect.get(definition, drizzleDefinitionState);
  if (
    !isRuntimeRecord(state) ||
    state.dialect !== "postgres" ||
    !isRuntimeRecord(state.definitions) ||
    !isRuntimeRecord(state.tables) ||
    !isRuntimeRecord(state.hooks)
  ) {
    throw bindingError("invalid-database");
  }
  for (const table of Object.values(state.tables)) {
    if (typeof table !== "object" || table === null) throw bindingError("invalid-database");
  }
  // SAFETY: Only the inaccessible PostgreSQL definition state symbol can provide this catalog, and the checks above establish its runtime maps.
  return state as unknown as PostgresCollectionDefinitionState;
}

function readPostgresDatabase(database: unknown): RuntimePostgresDatabase {
  if (!is(database, PgDatabase)) throw bindingError("invalid-database");
  // SAFETY: PgDatabase publicly provides execute, Collection query builders, and transaction; binding probes verify the live execution paths.
  return database as unknown as RuntimePostgresDatabase;
}

/** Bind a definition with a verified serializable PostgreSQL Transaction Store capability. */
export function bindPostgresStore<
  const Definition extends PostgresDefinition,
  QueryResult extends PgQueryResultHKT,
  FullSchema extends Record<string, unknown>,
  RelationalSchema extends TablesRelationalConfig,
  const Database extends PgDatabase<QueryResult, FullSchema, RelationalSchema>,
>(options: {
  readonly definition: Definition;
  readonly database: Database;
  readonly transaction: true;
}): Promise<PostgresTransactionBoundStore<Definition, Awaited<ReturnType<Database["execute"]>>>>;

/** Bind a definition with base PostgreSQL Collection and direct SQL capabilities only. */
export function bindPostgresStore<
  const Definition extends PostgresDefinition,
  QueryResult extends PgQueryResultHKT,
  FullSchema extends Record<string, unknown>,
  RelationalSchema extends TablesRelationalConfig,
  const Database extends PgDatabase<QueryResult, FullSchema, RelationalSchema>,
>(options: {
  readonly definition: Definition;
  readonly database: Database;
  readonly transaction?: false;
}): Promise<PostgresBoundStore<Definition, Awaited<ReturnType<Database["execute"]>>>>;

/** Bind a definition with a runtime-selected optional PostgreSQL transaction capability. */
export function bindPostgresStore<
  const Definition extends PostgresDefinition,
  QueryResult extends PgQueryResultHKT,
  FullSchema extends Record<string, unknown>,
  RelationalSchema extends TablesRelationalConfig,
  const Database extends PgDatabase<QueryResult, FullSchema, RelationalSchema>,
>(options: {
  readonly definition: Definition;
  readonly database: Database;
  readonly transaction: boolean;
}): Promise<
  | PostgresBoundStore<Definition, Awaited<ReturnType<Database["execute"]>>>
  | PostgresTransactionBoundStore<Definition, Awaited<ReturnType<Database["execute"]>>>
>;

export function bindPostgresStore(options: unknown): Promise<unknown> {
  return Promise.resolve().then(async () => {
    if (!isRuntimeRecord(options)) throw bindingError("invalid-database");
    const state = readPostgresDefinitionState(options.definition);
    const database = readPostgresDatabase(options.database);
    await probePostgresVersion(database);
    const root = createRuntimePostgresStore(database, state);
    if (options.transaction !== true) return root;
    await probePostgresTransaction(database);
    const transaction = <Value>(
      use: (transaction: RuntimePostgresStore) => Promise<Value>,
    ): Promise<Value> => runPostgresTransaction({ database, state, use });
    return Object.freeze({ ...root, transaction });
  });
}
