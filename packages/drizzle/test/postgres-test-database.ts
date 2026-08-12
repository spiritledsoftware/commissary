import type { Query } from "drizzle-orm/sql";
import {
  PgDatabase,
  PgDialect,
  PgPreparedQuery,
  PgSession,
  type PgQueryResultHKT,
  type PgTransaction,
  type PgTransactionConfig,
  type PreparedQueryConfig,
} from "drizzle-orm/pg-core";
import type { SelectedFieldsOrdered } from "drizzle-orm/pg-core/query-builders/select.types";

export interface TestPostgresDriverResult<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount?: number;
  readonly command?: string;
}

interface TestPostgresQueryResultHKT extends PgQueryResultHKT {
  readonly type: TestPostgresDriverResult<Extract<this["row"], Record<string, unknown>>>;
}

export interface TestPostgresCall {
  readonly params: readonly unknown[];
  readonly sql: string;
  readonly transaction: boolean;
}

export interface TestPostgresDatabaseControls {
  readonly calls: readonly TestPostgresCall[];
  readonly transactionConfigs: readonly (PgTransactionConfig | undefined)[];
  readonly database: PgDatabase<TestPostgresQueryResultHKT>;
}

interface MutableTestPostgresControls {
  readonly calls: TestPostgresCall[];
  readonly transactionConfigs: Array<PgTransactionConfig | undefined>;
  activeTransactionConfig: PgTransactionConfig | undefined;
  transactionDepth: number;
}

class TestPostgresPreparedQuery<T extends PreparedQueryConfig> extends PgPreparedQuery<T> {
  readonly #executeQuery: (query: Query) => Promise<unknown>;

  constructor(query: Query, executeQuery: (query: Query) => Promise<unknown>) {
    super(query, undefined, undefined);
    this.#executeQuery = executeQuery;
  }

  override async execute(): Promise<T["execute"]> {
    const result = await this.#executeQuery(this.getQuery());
    // SAFETY: Each test script returns the public result shape expected by the Drizzle operation it receives.
    return result as T["execute"];
  }
}

class TestPostgresSession extends PgSession<TestPostgresQueryResultHKT> {
  readonly #controls: MutableTestPostgresControls;
  readonly #script: (call: TestPostgresCall, config: PgTransactionConfig | undefined) => unknown;
  database!: PgDatabase<TestPostgresQueryResultHKT>;
  transactionUnavailable = false;
  ignoreTransactionOptions = false;

  constructor(
    dialect: PgDialect,
    controls: MutableTestPostgresControls,
    script: (call: TestPostgresCall, config: PgTransactionConfig | undefined) => unknown,
  ) {
    super(dialect);
    this.#controls = controls;
    this.#script = script;
  }

  override prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    _fields: SelectedFieldsOrdered | undefined,
    _name: string | undefined,
    _isResponseInArrayMode: boolean,
  ): PgPreparedQuery<T> {
    return new TestPostgresPreparedQuery<T>(query, async (prepared) => {
      const call = Object.freeze({
        sql: prepared.sql,
        params: Object.freeze([...prepared.params]),
        transaction: this.#controls.transactionDepth > 0,
      });
      this.#controls.calls.push(call);
      return await this.#script(call, this.#controls.activeTransactionConfig);
    });
  }

  override async transaction<Value>(
    use: (
      transaction: PgTransaction<
        TestPostgresQueryResultHKT,
        Record<string, never>,
        Record<string, never>
      >,
    ) => Promise<Value>,
    config?: PgTransactionConfig,
  ): Promise<Value> {
    this.#controls.transactionConfigs.push(config);
    if (this.transactionUnavailable) throw new Error("Test PostgreSQL transactions unavailable");
    const previousConfig = this.#controls.activeTransactionConfig;
    this.#controls.activeTransactionConfig = this.ignoreTransactionOptions ? undefined : config;
    this.#controls.transactionDepth += 1;
    try {
      // SAFETY: PgTransaction extends PgDatabase and the binder uses only their common public operations inside this test transaction.
      return await use(this.database as unknown as PgTransaction<TestPostgresQueryResultHKT>);
    } finally {
      this.#controls.transactionDepth -= 1;
      this.#controls.activeTransactionConfig = previousConfig;
    }
  }
}

/** Create one public PgDatabase with a deterministic in-memory session for adapter tests. */
export function createTestPostgresDatabase(options?: {
  readonly version?: number;
  readonly versionFailure?: unknown;
  readonly versionResult?: unknown;
  readonly script?: (call: TestPostgresCall, config: PgTransactionConfig | undefined) => unknown;
  readonly transactionUnavailable?: boolean;
  readonly ignoreTransactionOptions?: boolean;
}): TestPostgresDatabaseControls {
  const dialect = new PgDialect();
  const controls: MutableTestPostgresControls = {
    calls: [],
    transactionConfigs: [],
    activeTransactionConfig: undefined,
    transactionDepth: 0,
  };
  const script = async (
    call: TestPostgresCall,
    config: PgTransactionConfig | undefined,
  ): Promise<unknown> => {
    if (call.sql === "SHOW server_version_num") {
      if (options !== undefined && Object.hasOwn(options, "versionFailure")) {
        throw options.versionFailure;
      }
      if (options !== undefined && Object.hasOwn(options, "versionResult")) {
        return options.versionResult;
      }
      return { rows: [{ server_version_num: String(options?.version ?? 150_000) }] };
    }
    if (call.sql.includes("current_setting('transaction_isolation')")) {
      return {
        rows: [
          {
            transaction_isolation: config?.isolationLevel ?? "read committed",
            transaction_read_only: config?.accessMode === "read only" ? "on" : "off",
          },
        ],
      };
    }
    if (options?.script !== undefined) return await options.script(call, config);
    return { rows: [], rowCount: 0 };
  };
  const session = new TestPostgresSession(dialect, controls, script);
  session.transactionUnavailable = options?.transactionUnavailable ?? false;
  session.ignoreTransactionOptions = options?.ignoreTransactionOptions ?? false;
  const database = new PgDatabase<TestPostgresQueryResultHKT>(dialect, session, undefined);
  session.database = database;
  return {
    database,
    calls: controls.calls,
    transactionConfigs: controls.transactionConfigs,
  };
}
