/*
 * Compile-tested behavior prototype for issue #24.
 *
 * The file uses local Store and Drizzle stand-ins. It proves the approved
 * MySQL adapter seams without adding a production Drizzle dependency.
 */

export {};

type PrototypeParameter = null | boolean | number | string;

interface PrototypeSqlStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly PrototypeParameter[];
}

interface PrototypeCompiledStatement {
  readonly text: string;
  readonly parameters: readonly (null | number | string)[];
  readonly segments: readonly string[];
}

function compileMysqlStatement(statement: PrototypeSqlStatement): PrototypeCompiledStatement {
  if (statement.segments.length !== statement.parameters.length + 1) {
    throw new TypeError("SQL segment count does not match parameter count");
  }

  const segments = Object.freeze([...statement.segments]);
  const parameters = statement.parameters.map((parameter) => {
    if (typeof parameter === "boolean") {
      return parameter ? 1 : 0;
    }
    if (typeof parameter === "number") {
      if (!Number.isFinite(parameter)) {
        throw new TypeError("MySQL parameter must be finite");
      }
      return Object.is(parameter, -0) ? 0 : parameter;
    }
    if (typeof parameter === "string" && parameter.includes("\0")) {
      throw new TypeError("MySQL parameter must not contain NUL");
    }
    return parameter;
  });

  let text = segments[0] ?? "";
  for (const [index] of parameters.entries()) {
    text += `?${segments[index + 1] ?? ""}`;
  }

  return { text, parameters, segments };
}

type PrototypeDrizzleSqlChunk =
  | { readonly kind: "raw"; readonly text: string }
  | { readonly kind: "parameter"; readonly value: unknown };

interface PrototypeDrizzleSql {
  readonly chunks: readonly PrototypeDrizzleSqlChunk[];
}

function toDrizzleSql(compiled: PrototypeCompiledStatement): PrototypeDrizzleSql {
  const chunks: PrototypeDrizzleSqlChunk[] = [];
  for (const [index, segment] of compiled.segments.entries()) {
    chunks.push({ kind: "raw", text: segment });
    if (index < compiled.parameters.length) {
      chunks.push({ kind: "parameter", value: compiled.parameters[index] });
    }
  }
  return { chunks };
}

function rawStatement(text: string): PrototypeSqlStatement {
  return { segments: [text], parameters: [] };
}

interface PrototypeExecutionResult {
  readonly rows: readonly unknown[];
  readonly affectedRows?: number;
}

class PrototypeMultipleResultsError extends Error {
  readonly name = "PrototypeMultipleResultsError";
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function readProperty(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function isResultHeader(value: unknown): value is object {
  return (
    isObject(value) &&
    (readProperty(value, "affectedRows") !== undefined ||
      readProperty(value, "rowsAffected") !== undefined ||
      readProperty(value, "insertId") !== undefined)
  );
}

function readRowCount(result: object): number | undefined {
  const raw = readProperty(result, "affectedRows") ?? readProperty(result, "rowsAffected");
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
}

function normalizeMysqlExecutionResult(result: unknown): PrototypeExecutionResult {
  let rows: readonly unknown[];
  let metadata: object | undefined;

  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[1])) {
    const data = result[0];
    if (Array.isArray(data)) {
      if (data.some((item) => Array.isArray(item) || isResultHeader(item))) {
        throw new PrototypeMultipleResultsError();
      }
      rows = data;
    } else if (isResultHeader(data)) {
      rows = [];
      metadata = data;
    } else {
      throw new TypeError("Invalid mysql2 execution result");
    }
  } else if (isObject(result) && Array.isArray(readProperty(result, "rows"))) {
    const resultRows = readProperty(result, "rows");
    if (!Array.isArray(resultRows)) {
      throw new TypeError("Invalid MySQL execution result");
    }
    if (resultRows.some((item) => Array.isArray(item) || isResultHeader(item))) {
      throw new PrototypeMultipleResultsError();
    }
    rows = resultRows;
    metadata = result;
  } else {
    throw new TypeError("Invalid MySQL execution result");
  }

  const affectedRows = metadata === undefined ? undefined : readRowCount(metadata);
  return {
    rows,
    ...(affectedRows === undefined ? {} : { affectedRows }),
  };
}

interface PrototypeTransactionConfig {
  readonly isolationLevel: "serializable";
  readonly accessMode?: "read only";
}

interface PrototypeMysqlDatabase {
  readonly execute: (statement: PrototypeDrizzleSql) => Promise<unknown>;
  readonly transaction?: <Value>(
    use: (transaction: PrototypeMysqlDatabase) => Promise<Value>,
    config: PrototypeTransactionConfig,
  ) => Promise<Value>;
}

interface PrototypeSqlCommandResult {
  readonly affectedRows: number | undefined;
  readonly driverResult: unknown;
}

interface PrototypeSqlStore {
  readonly query: <Row = unknown>(statement: PrototypeSqlStatement) => Promise<readonly Row[]>;
  readonly execute: (statement: PrototypeSqlStatement) => Promise<PrototypeSqlCommandResult>;
  readonly runRootMutationPrototype: <Value>(
    use: (view: PrototypeSqlStore) => Promise<Value>,
  ) => Promise<Value>;
}

interface PrototypeTransactionStore extends PrototypeSqlStore {
  readonly transaction: <Value>(
    use: (transaction: PrototypeSqlStore) => Promise<Value>,
  ) => Promise<Value>;
}

class PrototypeBindingError extends Error {
  readonly name = "PrototypeBindingError";

  constructor(
    readonly reason:
      | "invalid-version-result"
      | "unsupported-mysql-version"
      | "unsupported-mysql-engine"
      | "current-database-required"
      | "transaction-unavailable"
      | "invalid-transaction-result"
      | "invalid-table-result"
      | "table-unavailable"
      | "unsupported-storage-engine",
  ) {
    super(reason);
  }
}

interface PrototypeTablePlan {
  readonly database?: string;
  readonly name: string;
}

const serverProbeSql =
  "SELECT VERSION() AS version, @@version_comment AS version_comment, DATABASE() AS current_database";
const transactionProbeSql =
  "SELECT STATE AS state, ACCESS_MODE AS access_mode, ISOLATION_LEVEL AS isolation_level, AUTOCOMMIT AS autocommit FROM performance_schema.events_transactions_current WHERE THREAD_ID = PS_CURRENT_THREAD_ID() AND END_EVENT_ID IS NULL";
const tableProbeSelectSql =
  "SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type, ENGINE AS engine FROM information_schema.TABLES";

function resolveTableDatabase(table: PrototypeTablePlan, currentDatabase: string | null): string {
  const database = table.database ?? currentDatabase;
  if (database === null) {
    throw new PrototypeBindingError("current-database-required");
  }
  return database;
}

function makeTableProbeStatement(
  tables: readonly PrototypeTablePlan[],
  currentDatabase: string | null,
): PrototypeSqlStatement {
  if (tables.length === 0) {
    return rawStatement(`${tableProbeSelectSql} WHERE FALSE`);
  }

  const segments = [`${tableProbeSelectSql} WHERE `];
  const parameters: string[] = [];
  for (const [index, table] of tables.entries()) {
    segments[segments.length - 1] += `${index === 0 ? "(" : " OR ("}TABLE_SCHEMA = `;
    parameters.push(resolveTableDatabase(table, currentDatabase));
    segments.push(" AND TABLE_NAME = ");
    parameters.push(table.name);
    segments.push(")");
  }
  return { segments, parameters };
}

function readSingleObjectRow(
  rows: readonly unknown[],
  reason: PrototypeBindingError["reason"],
): object {
  if (rows.length !== 1 || !isObject(rows[0])) {
    throw new PrototypeBindingError(reason);
  }
  return rows[0];
}

function readServerProbe(rows: readonly unknown[]): string | null {
  const row = readSingleObjectRow(rows, "invalid-version-result");
  const rawVersion = readProperty(row, "version");
  const rawComment = readProperty(row, "version_comment");
  const currentDatabase = readProperty(row, "current_database");
  if (
    typeof rawVersion !== "string" ||
    typeof rawComment !== "string" ||
    (currentDatabase !== null && typeof currentDatabase !== "string")
  ) {
    throw new PrototypeBindingError("invalid-version-result");
  }

  const engineMarker = `${rawVersion} ${rawComment}`;
  if (/mariadb|tidb|vitess|planetscale|percona/i.test(engineMarker)) {
    throw new PrototypeBindingError("unsupported-mysql-engine");
  }
  if (!/mysql|source distribution/i.test(rawComment)) {
    throw new PrototypeBindingError("unsupported-mysql-engine");
  }

  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(rawVersion);
  if (match === null) {
    throw new PrototypeBindingError("invalid-version-result");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new PrototypeBindingError("invalid-version-result");
  }
  if (major < 8 || (major === 8 && minor < 4)) {
    throw new PrototypeBindingError("unsupported-mysql-version");
  }
  return currentDatabase;
}

function requireTransactionProbe(rows: readonly unknown[]): void {
  const row = readSingleObjectRow(rows, "invalid-transaction-result");
  if (
    readProperty(row, "state") !== "ACTIVE" ||
    readProperty(row, "access_mode") !== "READ ONLY" ||
    readProperty(row, "isolation_level") !== "SERIALIZABLE" ||
    readProperty(row, "autocommit") !== "NO"
  ) {
    throw new PrototypeBindingError("transaction-unavailable");
  }
}

function requireInnoDbTables(
  rows: readonly unknown[],
  tables: readonly PrototypeTablePlan[],
  currentDatabase: string | null,
): void {
  const expected = new Set(
    tables.map((table) => `${resolveTableDatabase(table, currentDatabase)}\0${table.name}`),
  );

  for (const row of rows) {
    if (!isObject(row)) {
      throw new PrototypeBindingError("invalid-table-result");
    }
    const database = readProperty(row, "table_schema");
    const name = readProperty(row, "table_name");
    const type = readProperty(row, "table_type");
    const engine = readProperty(row, "engine");
    if (
      typeof database !== "string" ||
      typeof name !== "string" ||
      typeof type !== "string" ||
      typeof engine !== "string"
    ) {
      throw new PrototypeBindingError("invalid-table-result");
    }
    const key = `${database}\0${name}`;
    if (!expected.delete(key)) {
      throw new PrototypeBindingError("invalid-table-result");
    }
    if (type !== "BASE TABLE") {
      throw new PrototypeBindingError("table-unavailable");
    }
    if (engine !== "InnoDB") {
      throw new PrototypeBindingError("unsupported-storage-engine");
    }
  }

  if (expected.size !== 0) {
    throw new PrototypeBindingError("table-unavailable");
  }
}

type PrototypeRunTransaction = <Value>(
  use: (transaction: PrototypeMysqlDatabase) => Promise<Value>,
  config: PrototypeTransactionConfig,
) => Promise<Value>;

function makeSqlStore(
  database: PrototypeMysqlDatabase,
  runRootTransaction?: PrototypeRunTransaction,
): PrototypeSqlStore {
  const store: PrototypeSqlStore = {
    query: async <Row = unknown>(statement: PrototypeSqlStatement) => {
      const compiled = compileMysqlStatement(statement);
      const result = normalizeMysqlExecutionResult(await database.execute(toDrizzleSql(compiled)));
      return result.rows as readonly Row[];
    },
    execute: async (statement) => {
      const compiled = compileMysqlStatement(statement);
      const driverResult = await database.execute(toDrizzleSql(compiled));
      const result = normalizeMysqlExecutionResult(driverResult);
      return {
        affectedRows: result.affectedRows,
        driverResult,
      };
    },
    runRootMutationPrototype: async (use) => {
      if (runRootTransaction === undefined) {
        return use(store);
      }
      return runRootTransaction(async (transaction) => use(makeSqlStore(transaction)), {
        isolationLevel: "serializable",
      });
    },
  };
  return store;
}

interface PrototypeBindOptions {
  readonly database: PrototypeMysqlDatabase;
  readonly tables: readonly PrototypeTablePlan[];
  readonly transaction?: false;
}

interface PrototypeTransactionBindOptions {
  readonly database: PrototypeMysqlDatabase;
  readonly tables: readonly PrototypeTablePlan[];
  readonly transaction: true;
}

function bindMysqlStore(
  options: PrototypeTransactionBindOptions,
): Promise<PrototypeTransactionStore>;
function bindMysqlStore(options: PrototypeBindOptions): Promise<PrototypeSqlStore>;
async function bindMysqlStore(
  options: PrototypeBindOptions | PrototypeTransactionBindOptions,
): Promise<PrototypeSqlStore | PrototypeTransactionStore> {
  if (options.database.transaction === undefined) {
    throw new PrototypeBindingError("transaction-unavailable");
  }
  const runTransaction: PrototypeRunTransaction = <Value>(
    use: (transaction: PrototypeMysqlDatabase) => Promise<Value>,
    config: PrototypeTransactionConfig,
  ): Promise<Value> => options.database.transaction!(use, config);
  const store = makeSqlStore(options.database, runTransaction);

  const currentDatabase = readServerProbe(await store.query(rawStatement(serverProbeSql)));
  try {
    await runTransaction(
      async (transaction) => {
        const rows = await makeSqlStore(transaction).query(rawStatement(transactionProbeSql));
        requireTransactionProbe(rows);
      },
      { isolationLevel: "serializable", accessMode: "read only" },
    );
  } catch (cause) {
    if (cause instanceof PrototypeBindingError) {
      throw cause;
    }
    throw new PrototypeBindingError("transaction-unavailable");
  }

  const tableProbe = makeTableProbeStatement(options.tables, currentDatabase);
  requireInnoDbTables(await store.query(tableProbe), options.tables, currentDatabase);

  if (options.transaction !== true) {
    return store;
  }

  return {
    ...store,
    transaction: (use) =>
      runTransaction(async (transaction) => use(makeSqlStore(transaction)), {
        isolationLevel: "serializable",
      }),
  };
}

interface PrototypeColumnPlan {
  readonly field: string;
  readonly nonNull: boolean;
  readonly serial?: boolean;
  readonly autoIncrement?: boolean;
}

interface PrototypeIndexColumn {
  readonly field: string;
  readonly complete: boolean;
  readonly expression?: boolean;
}

interface PrototypeIndexPlan {
  readonly unique: boolean;
  readonly columns: readonly [PrototypeIndexColumn, ...PrototypeIndexColumn[]];
}

interface PrototypeIdentityTablePlan {
  readonly columns: readonly PrototypeColumnPlan[];
  readonly primaryKey?: readonly [string, ...string[]];
  readonly indexes: readonly PrototypeIndexPlan[];
}

interface PrototypeCandidateKey {
  readonly source: "primary-key" | "serial" | "unique-index";
  readonly fields: readonly [string, ...string[]];
}

function resolveCandidateKey(table: PrototypeIdentityTablePlan): PrototypeCandidateKey | undefined {
  if (table.primaryKey !== undefined) {
    return { source: "primary-key", fields: table.primaryKey };
  }

  const serial = table.columns.find((column) => column.serial === true);
  if (serial !== undefined) {
    return { source: "serial", fields: [serial.field] };
  }

  const columnsByField = new Map(table.columns.map((column) => [column.field, column]));
  for (const index of table.indexes) {
    if (!index.unique) {
      continue;
    }
    const safe = index.columns.every((column) => {
      const field = columnsByField.get(column.field);
      return column.complete && column.expression !== true && field !== undefined && field.nonNull;
    });
    if (safe) {
      return {
        source: "unique-index",
        fields: index.columns.map((column) => column.field) as [string, ...string[]],
      };
    }
  }
  return undefined;
}

function hasRequiredAutoIncrementIndex(table: PrototypeIdentityTablePlan): boolean {
  const automatic = table.columns.find(
    (column) => column.autoIncrement === true && column.serial !== true,
  );
  if (automatic === undefined) {
    return true;
  }
  if (table.primaryKey?.[0] === automatic.field) {
    return true;
  }
  return table.indexes.some((index) => index.columns[0].field === automatic.field);
}

function isMysqlTransactionConflict(cause: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = cause;
  while (isObject(current) && !seen.has(current)) {
    seen.add(current);
    const errorNumber = readProperty(current, "errno");
    const sqlState = readProperty(current, "sqlState");
    if (errorNumber === 1213 || errorNumber === 1205 || sqlState === "40001") {
      return true;
    }
    current = readProperty(current, "cause");
  }
  return false;
}

function isTransactionStore(store: PrototypeSqlStore): store is PrototypeTransactionStore {
  return "transaction" in store && typeof Reflect.get(store, "transaction") === "function";
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

interface PrototypeDatabaseCall {
  readonly text: string;
  readonly parameters: readonly unknown[];
  readonly inTransaction: boolean;
}

function makePrototypeDatabase(options?: {
  readonly version?: string;
  readonly versionComment?: string;
  readonly currentDatabase?: string | null;
  readonly transaction?: boolean;
  readonly applyTransactionOptions?: boolean;
  readonly engines?: Readonly<Record<string, string>>;
}): PrototypeMysqlDatabase & {
  readonly calls: PrototypeDatabaseCall[];
  readonly transactionCalls: { readonly config: PrototypeTransactionConfig }[];
} {
  const calls: PrototypeDatabaseCall[] = [];
  const transactionCalls: { readonly config: PrototypeTransactionConfig }[] = [];
  let activeTransactionConfig: PrototypeTransactionConfig | undefined;

  const execute = async (statement: PrototypeDrizzleSql): Promise<unknown> => {
    let text = "";
    const parameters: unknown[] = [];
    for (const chunk of statement.chunks) {
      if (chunk.kind === "raw") {
        text += chunk.text;
      } else {
        text += "?";
        parameters.push(chunk.value);
      }
    }
    calls.push({ text, parameters, inTransaction: activeTransactionConfig !== undefined });

    if (text === serverProbeSql) {
      return [
        [
          {
            version: options?.version ?? "8.4.0",
            version_comment: options?.versionComment ?? "MySQL Community Server - GPL",
            current_database:
              options !== undefined && "currentDatabase" in options
                ? options.currentDatabase
                : "commissary",
          },
        ],
        [],
      ];
    }
    if (text === transactionProbeSql) {
      const applied = options?.applyTransactionOptions !== false;
      return {
        rows: [
          {
            state: "ACTIVE",
            access_mode:
              applied && activeTransactionConfig?.accessMode === "read only"
                ? "READ ONLY"
                : "READ WRITE",
            isolation_level:
              applied && activeTransactionConfig?.isolationLevel === "serializable"
                ? "SERIALIZABLE"
                : "REPEATABLE READ",
            autocommit: "NO",
          },
        ],
      };
    }
    if (text.startsWith(`${tableProbeSelectSql} WHERE `)) {
      const requested = new Set<string>();
      for (let index = 0; index < parameters.length; index += 2) {
        requested.add(`${String(parameters[index])}\0${String(parameters[index + 1])}`);
      }
      const currentDatabase = options?.currentDatabase ?? "commissary";
      const engines = options?.engines ?? {
        [`${currentDatabase}.jobs`]: "InnoDB",
        "audit.events": "InnoDB",
      };
      return {
        rows: Object.entries(engines).flatMap(([qualifiedName, engine]) => {
          const separator = qualifiedName.indexOf(".");
          const database = qualifiedName.slice(0, separator);
          const name = qualifiedName.slice(separator + 1);
          if (!requested.has(`${database}\0${name}`)) {
            return [];
          }
          return [
            {
              table_schema: database,
              table_name: name,
              table_type: "BASE TABLE",
              engine,
            },
          ];
        }),
      };
    }
    if (text.startsWith("SELECT")) {
      return [[{ value: 1 }], []];
    }
    return [{ affectedRows: 2, insertId: "9007199254740993" }, []];
  };

  if (options?.transaction === false) {
    return { execute, calls, transactionCalls };
  }

  let database: PrototypeMysqlDatabase & {
    readonly calls: PrototypeDatabaseCall[];
    readonly transactionCalls: { readonly config: PrototypeTransactionConfig }[];
  };
  const transaction = async <Value>(
    use: (transactionDatabase: PrototypeMysqlDatabase) => Promise<Value>,
    config: PrototypeTransactionConfig,
  ): Promise<Value> => {
    transactionCalls.push({ config });
    const previous = activeTransactionConfig;
    activeTransactionConfig = config;
    try {
      return await use(database);
    } finally {
      activeTransactionConfig = previous;
    }
  };
  database = { execute, calls, transactionCalls, transaction };
  return database;
}

async function runPrototype(): Promise<void> {
  const tables: readonly PrototypeTablePlan[] = [
    { name: "jobs" },
    { database: "audit", name: "events" },
  ];

  const compiled = compileMysqlStatement({
    segments: ["SELECT '?' AS raw_value, ", " AS bound_value"],
    parameters: [true],
  });
  assert(
    compiled.text === "SELECT '?' AS raw_value, ? AS bound_value",
    "MySQL compilation changed placeholder-like raw text",
  );
  assert(compiled.parameters[0] === 1, "MySQL boolean parameter was not normalized");
  const drizzleStatement = toDrizzleSql(compiled);
  assert(
    drizzleStatement.chunks[0]?.kind === "raw" && drizzleStatement.chunks[0].text.includes("'?'"),
    "raw placeholder-like text was parsed",
  );
  assert(
    drizzleStatement.chunks[1]?.kind === "parameter" && drizzleStatement.chunks[1].value === 1,
    "bound value did not remain a parameter",
  );

  const baseDatabase = makePrototypeDatabase({
    engines: {
      "commissary.jobs": "InnoDB",
      "audit.events": "InnoDB",
      "commissary.unrelated": "MyISAM",
    },
  });
  const baseStore = await bindMysqlStore({ database: baseDatabase, tables });
  assert(!isTransactionStore(baseStore), "base binder exposed a transaction method");
  assert(
    baseDatabase.transactionCalls[0]?.config.accessMode === "read only",
    "base binding did not run the transaction probe",
  );
  const tableProbeCall = baseDatabase.calls.find((call) =>
    call.text.startsWith(`${tableProbeSelectSql} WHERE `),
  );
  assert(
    tableProbeCall?.parameters.length === 4 &&
      tableProbeCall.parameters[0] === "commissary" &&
      tableProbeCall.parameters[1] === "jobs" &&
      tableProbeCall.parameters[2] === "audit" &&
      tableProbeCall.parameters[3] === "events",
    "table probe did not bind only the resolved Store table pairs",
  );

  const transactionsBeforeMutation = baseDatabase.transactionCalls.length;
  await baseStore.runRootMutationPrototype(async (view) => {
    await view.execute(rawStatement("UPDATE jobs SET status = 'done'"));
    await view.query(rawStatement("SELECT * FROM jobs"));
  });
  assert(
    baseDatabase.transactionCalls.length === transactionsBeforeMutation + 1,
    "root mutation did not use exactly one private transaction",
  );

  const writeResult = await baseStore.execute(rawStatement("UPDATE jobs SET status = 'done'"));
  assert(writeResult.affectedRows === 2, "MySQL affected-row count was lost");
  assert(
    Array.isArray(writeResult.driverResult) &&
      isObject(writeResult.driverResult[0]) &&
      readProperty(writeResult.driverResult[0], "insertId") === "9007199254740993",
    "exact public driver result was lost",
  );

  const transactionDatabase = makePrototypeDatabase();
  const transactionStore = await bindMysqlStore({
    database: transactionDatabase,
    tables,
    transaction: true,
  });
  assert(isTransactionStore(transactionStore), "transaction capability was not exposed");
  await transactionStore.transaction(async (view) => {
    assert(!isTransactionStore(view), "transaction view exposed nested transactions");
    await view.query(rawStatement("SELECT 1"));
    await view.runRootMutationPrototype(async (sameView) => {
      await sameView.execute(rawStatement("UPDATE jobs SET status = 'done'"));
    });
  });
  const transactionSelect = transactionDatabase.calls.find(
    (call) => call.text === "SELECT 1" && call.inTransaction,
  );
  assert(transactionSelect !== undefined, "execute escaped the physical transaction");

  const primaryKey = resolveCandidateKey({
    columns: [
      { field: "id", nonNull: true },
      { field: "email", nonNull: true },
    ],
    primaryKey: ["id"],
    indexes: [{ unique: true, columns: [{ field: "email", complete: true }] }],
  });
  assert(primaryKey?.source === "primary-key", "primary key did not win candidate identity");

  const serialKey = resolveCandidateKey({
    columns: [{ field: "sequence", nonNull: true, serial: true, autoIncrement: true }],
    indexes: [],
  });
  assert(serialKey?.source === "serial", "SERIAL did not supply candidate identity");

  const uniqueKey = resolveCandidateKey({
    columns: [
      { field: "tenant", nonNull: true },
      { field: "externalId", nonNull: true },
    ],
    indexes: [
      {
        unique: true,
        columns: [
          { field: "tenant", complete: true },
          { field: "externalId", complete: true },
        ],
      },
    ],
  });
  assert(
    uniqueKey?.source === "unique-index" && uniqueKey.fields.length === 2,
    "safe composite unique key was not selected",
  );

  const unsafeKey = resolveCandidateKey({
    columns: [{ field: "optionalCode", nonNull: false }],
    indexes: [{ unique: true, columns: [{ field: "optionalCode", complete: true }] }],
  });
  assert(unsafeKey === undefined, "nullable unique key became candidate identity");

  assert(
    hasRequiredAutoIncrementIndex({
      columns: [{ field: "id", nonNull: true, autoIncrement: true }],
      primaryKey: ["id"],
      indexes: [],
    }),
    "primary key did not prove the automatic-increment index",
  );
  assert(
    !hasRequiredAutoIncrementIndex({
      columns: [{ field: "id", nonNull: true, autoIncrement: true }],
      indexes: [],
    }),
    "missing host automatic-increment index was accepted",
  );

  const nestedConflict = {
    cause: { errno: 1205, sqlState: "HY000" },
  };
  assert(isMysqlTransactionConflict(nestedConflict), "lock timeout was not mapped as conflict");
  assert(
    isMysqlTransactionConflict({ errno: 1213, sqlState: "40001" }),
    "deadlock was not mapped as conflict",
  );

  let ignoredSettingsFailure: PrototypeBindingError | undefined;
  try {
    await bindMysqlStore({
      database: makePrototypeDatabase({ applyTransactionOptions: false }),
      tables,
    });
  } catch (cause) {
    if (cause instanceof PrototypeBindingError) {
      ignoredSettingsFailure = cause;
    } else {
      throw cause;
    }
  }
  assert(
    ignoredSettingsFailure?.reason === "transaction-unavailable",
    "binding accepted ignored transaction options",
  );

  let storageEngineFailure: PrototypeBindingError | undefined;
  try {
    await bindMysqlStore({
      database: makePrototypeDatabase({
        engines: { "commissary.jobs": "MyISAM", "audit.events": "InnoDB" },
      }),
      tables,
    });
  } catch (cause) {
    if (cause instanceof PrototypeBindingError) {
      storageEngineFailure = cause;
    } else {
      throw cause;
    }
  }
  assert(
    storageEngineFailure?.reason === "unsupported-storage-engine",
    "binding accepted a non-InnoDB Store table",
  );

  let compatibleEngineFailure: PrototypeBindingError | undefined;
  try {
    await bindMysqlStore({
      database: makePrototypeDatabase({
        version: "8.4.0-TiDB",
        versionComment: "TiDB Server",
      }),
      tables,
    });
  } catch (cause) {
    if (cause instanceof PrototypeBindingError) {
      compatibleEngineFailure = cause;
    } else {
      throw cause;
    }
  }
  assert(
    compatibleEngineFailure?.reason === "unsupported-mysql-engine",
    "binding accepted a MySQL-compatible non-Oracle engine",
  );
}

await runPrototype();
