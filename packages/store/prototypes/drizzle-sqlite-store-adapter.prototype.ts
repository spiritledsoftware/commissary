/*
 * Compile-tested behavior prototype for issue #18.
 *
 * This file proves the Drizzle SQLite adapter design without adding a
 * production Drizzle dependency. Run it with Bun after strict typechecking.
 */

export {};

type PrototypeParameter = null | boolean | number | string;

type PrototypeResultKind = "sync" | "async";

interface PrototypeSqlStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly PrototypeParameter[];
}

interface PrototypeCompiledStatement {
  readonly text: string;
  readonly segments: readonly string[];
  readonly parameters: readonly (null | number | string)[];
}

function compileSqliteStatement(statement: PrototypeSqlStatement): PrototypeCompiledStatement {
  if (statement.segments.length !== statement.parameters.length + 1) {
    throw new PrototypeSqlStatementError("invalid-statement", "query");
  }

  const parameters: (null | number | string)[] = [];
  let text = "";

  for (const [index, segment] of statement.segments.entries()) {
    text += segment;
    if (index >= statement.parameters.length) continue;

    const parameter = statement.parameters[index];
    if (parameter === undefined) {
      throw new PrototypeSqlStatementError("invalid-parameter", "query");
    }
    if (typeof parameter === "number" && !Number.isFinite(parameter)) {
      throw new PrototypeSqlStatementError("invalid-parameter", "query");
    }
    if (typeof parameter === "string" && parameter.includes("\0")) {
      throw new PrototypeSqlStatementError("invalid-parameter", "query");
    }

    text += "?";
    parameters.push(
      typeof parameter === "boolean"
        ? parameter
          ? 1
          : 0
        : Object.is(parameter, -0)
          ? 0
          : parameter,
    );
  }

  return {
    text,
    segments: [...statement.segments],
    parameters,
  };
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

function renderDrizzleSql(query: PrototypeDrizzleSql): string {
  return query.chunks.map((chunk) => (chunk.kind === "raw" ? chunk.text : "?")).join("");
}

interface PrototypeDrizzleSqliteDatabase<RunResult> {
  readonly resultKind: PrototypeResultKind;
  readonly all: (query: PrototypeDrizzleSql) => readonly unknown[] | Promise<readonly unknown[]>;
  readonly run: (query: PrototypeDrizzleSql) => RunResult | Promise<RunResult>;
  readonly transaction: <Value>(
    use: (transaction: PrototypeDrizzleSqliteDatabase<RunResult>) => Value | Promise<Value>,
  ) => Value | Promise<Value>;
}

interface PrototypeSqlCommandResult<out DriverResult = unknown> {
  readonly affectedRows: number | undefined;
  readonly driverResult: DriverResult;
}

interface PrototypeSqlStore<out DriverResult = unknown> {
  readonly query: <Row = unknown>(statement: PrototypeSqlStatement) => Promise<readonly Row[]>;
  readonly execute: (
    statement: PrototypeSqlStatement,
  ) => Promise<PrototypeSqlCommandResult<DriverResult>>;
}

interface PrototypeTransactionStore<
  out DriverResult = unknown,
> extends PrototypeSqlStore<DriverResult> {
  readonly transaction: <Value>(
    use: (transaction: PrototypeSqlStore<DriverResult>) => Promise<Value>,
  ) => Promise<Value>;
}

type PrototypeSqlOperation = "query" | "execute";

class PrototypeSqlStatementError extends Error {
  readonly name = "PrototypeSqlStatementError";

  constructor(
    readonly reason: "invalid-statement" | "invalid-parameter",
    readonly operation: PrototypeSqlOperation,
  ) {
    super(`Prototype SQL ${operation} rejected a ${reason}`);
  }
}

class PrototypeInvalidSqlResultError extends Error {
  readonly name = "PrototypeInvalidSqlResultError";

  constructor(readonly operation: PrototypeSqlOperation) {
    super(`Prototype SQL ${operation} returned an invalid result`);
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function readProperty(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function readAffectedRows(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;

  const candidates: unknown[] = [];
  const changes = readProperty(value, "changes");
  if (changes !== undefined) candidates.push(changes);

  const rowsAffected = readProperty(value, "rowsAffected");
  if (rowsAffected !== undefined) candidates.push(rowsAffected);

  const meta = readProperty(value, "meta");
  if (isObject(meta)) {
    const metaChanges = readProperty(meta, "changes");
    if (metaChanges !== undefined) candidates.push(metaChanges);
  }

  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  return isAffectedRows(candidate) ? candidate : undefined;
}

function isAffectedRows(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

type PrototypeTrackTransactionOperation = <Value>(start: () => Promise<Value>) => Promise<Value>;

class PrototypeTransactionClosedError extends Error {
  readonly name = "PrototypeTransactionClosedError";
}

class PrototypeTransactionUnsettledOperationError extends Error {
  readonly name = "PrototypeTransactionUnsettledOperationError";
}

function runPrototypeStoreOperation<Value>(start: () => Promise<Value>): Promise<Value> {
  return Promise.resolve().then(start);
}

function runTransactionCallback<View, Value>(
  makeView: (track: PrototypeTrackTransactionOperation) => View,
  use: (view: View) => Promise<Value>,
): Promise<Value> {
  return Promise.resolve().then(async () => {
    let closed = false;
    let nextOperationOrder = 0;
    const activeOperations = new Set<Promise<void>>();
    const operationFailures: { readonly cause: unknown; readonly order: number }[] = [];

    const track: PrototypeTrackTransactionOperation = <OperationValue>(
      start: () => Promise<OperationValue>,
    ): Promise<OperationValue> => {
      if (closed) {
        return Promise.reject(new PrototypeTransactionClosedError());
      }

      const order = nextOperationOrder;
      nextOperationOrder += 1;
      const operation = Promise.resolve().then(start);
      let settlement: Promise<void>;
      settlement = operation.then(
        () => {
          activeOperations.delete(settlement);
        },
        (cause: unknown) => {
          operationFailures.push({ cause, order });
          activeOperations.delete(settlement);
        },
      );
      activeOperations.add(settlement);
      return operation;
    };

    const view = makeView(track);
    let callbackFailed = false;
    let callbackFailure: unknown;
    let callbackValue!: Value;
    try {
      callbackValue = await use(view);
    } catch (cause) {
      callbackFailed = true;
      callbackFailure = cause;
    }

    const hadUnsettledOperations = !callbackFailed && activeOperations.size > 0;
    closed = true;
    await Promise.all(activeOperations);

    if (callbackFailed) throw callbackFailure;
    if (hadUnsettledOperations) {
      throw new PrototypeTransactionUnsettledOperationError();
    }

    operationFailures.sort((left, right) => left.order - right.order);
    const firstOperationFailure = operationFailures[0];
    if (firstOperationFailure !== undefined) throw firstOperationFailure.cause;
    return callbackValue;
  });
}

function makeSqlStore<RunResult>(
  database: PrototypeDrizzleSqliteDatabase<RunResult>,
  track: PrototypeTrackTransactionOperation = runPrototypeStoreOperation,
): PrototypeSqlStore<RunResult> {
  return {
    query: <Row = unknown>(statement: PrototypeSqlStatement): Promise<readonly Row[]> =>
      track(async () => {
        let compiled: PrototypeCompiledStatement;
        try {
          compiled = compileSqliteStatement(statement);
        } catch (cause) {
          if (cause instanceof PrototypeSqlStatementError) {
            throw new PrototypeSqlStatementError(cause.reason, "query");
          }
          throw cause;
        }

        const rows = await database.all(toDrizzleSql(compiled));
        if (!Array.isArray(rows)) {
          throw new PrototypeInvalidSqlResultError("query");
        }

        // SqlStore.query intentionally gives the unchecked driver rows the caller-selected type.
        return rows as readonly Row[];
      }),

    execute: (statement): Promise<PrototypeSqlCommandResult<RunResult>> =>
      track(async () => {
        let compiled: PrototypeCompiledStatement;
        try {
          compiled = compileSqliteStatement(statement);
        } catch (cause) {
          if (cause instanceof PrototypeSqlStatementError) {
            throw new PrototypeSqlStatementError(cause.reason, "execute");
          }
          throw cause;
        }

        const driverResult = await database.run(toDrizzleSql(compiled));
        return {
          affectedRows: readAffectedRows(driverResult),
          driverResult,
        };
      }),
  };
}

type PrototypeBindingErrorReason =
  | "invalid-database"
  | "probe-failed"
  | "invalid-version-result"
  | "unsupported-sqlite-version"
  | "transaction-unavailable";

class PrototypeBindingError extends Error {
  readonly name = "PrototypeBindingError";

  constructor(
    readonly reason: PrototypeBindingErrorReason,
    readonly cause?: unknown,
  ) {
    super(`Prototype SQLite binding failed: ${reason}`, { cause });
  }
}

interface PrototypeBindOptions<RunResult> {
  readonly database: PrototypeDrizzleSqliteDatabase<RunResult>;
  readonly transaction?: false;
}

interface PrototypeTransactionBindOptions<RunResult> {
  readonly database: PrototypeDrizzleSqliteDatabase<RunResult>;
  readonly transaction: true;
}

const versionProbe = rawStatement("SELECT sqlite_version() AS sqlite_version");
const enableDeferredForeignKeys = rawStatement("PRAGMA defer_foreign_keys = ON");
const readDeferredForeignKeys = rawStatement("PRAGMA defer_foreign_keys");
const readUncommitted = rawStatement("PRAGMA read_uncommitted");
const readJournalMode = rawStatement("PRAGMA journal_mode");
const rollbackCapableJournalModes = new Set(["delete", "truncate", "persist", "memory", "wal"]);

function readSingleObjectRow(rows: readonly unknown[]): object {
  if (rows.length !== 1 || !isObject(rows[0])) {
    throw new PrototypeBindingError("invalid-version-result");
  }
  return rows[0];
}

function readSqliteVersion(rows: readonly unknown[]): readonly [number, number, number] {
  const row = readSingleObjectRow(rows);
  const version = readProperty(row, "sqlite_version");
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new PrototypeBindingError("invalid-version-result");
  }

  const parts = version.split(".").map(Number);
  const major = parts[0];
  const minor = parts[1];
  const patch = parts[2];
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch) ||
    major < 0 ||
    minor < 0 ||
    patch < 0
  ) {
    throw new PrototypeBindingError("invalid-version-result");
  }
  return [major, minor, patch];
}

function isSupportedSqliteVersion(version: readonly [number, number, number]): boolean {
  const [major, minor, patch] = version;
  return major > 3 || (major === 3 && (minor > 45 || (minor === 45 && patch >= 0)));
}

function requireSqliteDatabase<RunResult>(
  database: unknown,
): PrototypeDrizzleSqliteDatabase<RunResult> {
  try {
    if (
      !isObject(database) ||
      typeof readProperty(database, "all") !== "function" ||
      typeof readProperty(database, "run") !== "function" ||
      typeof readProperty(database, "transaction") !== "function"
    ) {
      throw new PrototypeBindingError("invalid-database");
    }
  } catch (cause) {
    if (cause instanceof PrototypeBindingError) throw cause;
    throw new PrototypeBindingError("invalid-database", cause);
  }

  return database as PrototypeDrizzleSqliteDatabase<RunResult>;
}

async function probeSqliteVersion<RunResult>(
  database: PrototypeDrizzleSqliteDatabase<RunResult>,
): Promise<readonly [number, number, number]> {
  let rows: unknown;
  try {
    rows = await database.all(toDrizzleSql(compileSqliteStatement(versionProbe)));
  } catch (cause) {
    throw new PrototypeBindingError("probe-failed", cause);
  }

  if (!Array.isArray(rows)) {
    throw new PrototypeBindingError("invalid-version-result");
  }

  try {
    return readSqliteVersion(rows);
  } catch (cause) {
    if (cause instanceof PrototypeBindingError) throw cause;
    throw new PrototypeBindingError("invalid-version-result", cause);
  }
}

function readSinglePragmaValue(rows: readonly unknown[], key: string): unknown {
  if (rows.length !== 1 || !isObject(rows[0])) {
    throw new PrototypeBindingError("transaction-unavailable");
  }
  return readProperty(rows[0], key);
}

async function requireTransactionCapability<RunResult>(
  database: PrototypeDrizzleSqliteDatabase<RunResult>,
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      await transaction.run(toDrizzleSql(compileSqliteStatement(enableDeferredForeignKeys)));
      await Promise.resolve();

      const deferredRows = await transaction.all(
        toDrizzleSql(compileSqliteStatement(readDeferredForeignKeys)),
      );
      const isolationRows = await transaction.all(
        toDrizzleSql(compileSqliteStatement(readUncommitted)),
      );
      const journalRows = await transaction.all(
        toDrizzleSql(compileSqliteStatement(readJournalMode)),
      );

      const deferred = readSinglePragmaValue(deferredRows, "defer_foreign_keys");
      const isolation = readSinglePragmaValue(isolationRows, "read_uncommitted");
      const journal = readSinglePragmaValue(journalRows, "journal_mode");

      const normalizedJournal = typeof journal === "string" ? journal.trim().toLowerCase() : "";
      if (
        deferred !== 1 ||
        isolation !== 0 ||
        !rollbackCapableJournalModes.has(normalizedJournal)
      ) {
        throw new PrototypeBindingError("transaction-unavailable");
      }
    });
  } catch (cause) {
    if (cause instanceof PrototypeBindingError) throw cause;
    throw new PrototypeBindingError("transaction-unavailable", cause);
  }
}

function bindSqliteStore<RunResult>(
  options: PrototypeTransactionBindOptions<RunResult>,
): Promise<PrototypeTransactionStore<RunResult>>;
function bindSqliteStore<RunResult>(
  options: PrototypeBindOptions<RunResult>,
): Promise<PrototypeSqlStore<RunResult>>;
function bindSqliteStore<RunResult>(
  options: PrototypeBindOptions<RunResult> | PrototypeTransactionBindOptions<RunResult>,
): Promise<PrototypeSqlStore<RunResult> | PrototypeTransactionStore<RunResult>> {
  return Promise.resolve().then(async () => {
    const database = requireSqliteDatabase<RunResult>(options.database);
    const version = await probeSqliteVersion(database);
    if (!isSupportedSqliteVersion(version)) {
      throw new PrototypeBindingError("unsupported-sqlite-version");
    }

    const store = makeSqlStore(database);
    if (options.transaction !== true) return store;

    await requireTransactionCapability(database);

    return {
      ...store,
      transaction: async <Value>(
        use: (transaction: PrototypeSqlStore<RunResult>) => Promise<Value>,
      ): Promise<Value> =>
        await database.transaction(
          async (transaction) =>
            await runTransactionCallback((track) => makeSqlStore(transaction, track), use),
        ),
    };
  });
}

type PrototypeCandidateIdentity =
  | {
      readonly kind: "primary-key";
      readonly fields: readonly [string, ...string[]];
    }
  | {
      readonly kind: "rowid";
      readonly alias: "rowid" | "_rowid_" | "oid";
    };

function resolveCandidateIdentity(options: {
  readonly primaryKey: readonly string[];
  readonly physicalColumns: readonly string[];
}): PrototypeCandidateIdentity {
  if (options.primaryKey.length > 0) {
    const [first, ...rest] = options.primaryKey;
    if (first === undefined) throw new Error("Prototype primary key resolution failed");
    return { kind: "primary-key", fields: [first, ...rest] };
  }

  const physicalColumns = new Set(options.physicalColumns);
  for (const alias of ["rowid", "_rowid_", "oid"] as const) {
    if (!physicalColumns.has(alias)) return { kind: "rowid", alias };
  }

  throw new Error("Prototype SQLite identity is unavailable");
}

interface PrototypeCandidate<Identity> {
  readonly identity: Identity;
  readonly observedRawValues: Readonly<Record<string, unknown>>;
}

function hasObservedRawValues(
  current: object,
  observed: Readonly<Record<string, unknown>>,
): boolean {
  for (const [field, value] of Object.entries(observed)) {
    if (!Object.is(readProperty(current, field), value)) return false;
  }
  return true;
}

class PrototypeCandidateConflictError extends Error {
  readonly name = "PrototypeCandidateConflictError";

  constructor(readonly writesMayRemain: boolean) {
    super("Prototype SQLite candidate changed before its write");
  }
}

async function updateCandidates<Identity, StoredValue>(options: {
  readonly candidates: readonly PrototypeCandidate<Identity>[];
  readonly write: (candidate: PrototypeCandidate<Identity>) => Promise<Identity | undefined>;
  readonly readStored: (identity: Identity) => Promise<StoredValue | undefined>;
  readonly validateStored: (value: StoredValue) => void;
}): Promise<number> {
  let completed = 0;

  for (const candidate of options.candidates) {
    const identity = await options.write(candidate);
    if (identity === undefined) {
      throw new PrototypeCandidateConflictError(completed > 0);
    }

    const stored = await options.readStored(identity);
    if (stored === undefined) {
      throw new PrototypeCandidateConflictError(true);
    }
    options.validateStored(stored);
    completed += 1;
  }

  return completed;
}

async function createAndReadStored<Identity, StoredValue>(options: {
  readonly write: () => Promise<Identity>;
  readonly readStored: (identity: Identity) => Promise<StoredValue | undefined>;
}): Promise<StoredValue> {
  const identity = await options.write();
  const stored = await options.readStored(identity);
  if (stored === undefined) {
    throw new PrototypeCandidateConflictError(true);
  }
  return stored;
}

const sqliteBusyNames = new Set([
  "SQLITE_BUSY",
  "SQLITE_BUSY_RECOVERY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_BUSY_TIMEOUT",
]);

function isSqliteBusyCause(cause: unknown): boolean {
  const seen = new Set<object>();
  let current = cause;

  while (isObject(current) && !seen.has(current)) {
    seen.add(current);
    const code = readProperty(current, "code");
    if (
      (typeof code === "number" &&
        Number.isSafeInteger(code) &&
        code >= 0 &&
        (code & 0xff) === 5) ||
      (typeof code === "string" && sqliteBusyNames.has(code))
    ) {
      return true;
    }
    current = readProperty(current, "cause");
  }

  return false;
}

interface PrototypeDatabaseCall {
  readonly method: "all" | "run";
  readonly text: string;
}

interface PrototypeDatabaseControls {
  readonly calls: readonly PrototypeDatabaseCall[];
  readonly transactionCount: number;
}

type PrototypeTransactionMode = "async" | "sync" | "early-commit" | "unavailable";

function makePrototypeDatabase<RunResult>(options: {
  readonly resultKind: PrototypeResultKind;
  readonly transactionMode: PrototypeTransactionMode;
  readonly runResult: RunResult;
  readonly queryRows?: readonly unknown[];
  readonly queryBarrier?: Promise<void>;
  readonly onQuerySettled?: () => void;
  readonly sqliteVersion?: string;
  readonly versionProbeCause?: unknown;
  readonly readUncommitted?: 0 | 1;
  readonly journalMode?: string;
}): PrototypeDrizzleSqliteDatabase<RunResult> & {
  readonly controls: PrototypeDatabaseControls;
} {
  const calls: PrototypeDatabaseCall[] = [];
  let transactionCount = 0;
  let transactionOpen = false;
  let deferredForeignKeys = 0;

  const database: PrototypeDrizzleSqliteDatabase<RunResult> = {
    resultKind: options.resultKind,

    all: (query) => {
      const text = renderDrizzleSql(query);
      calls.push({ method: "all", text });

      let rows: readonly unknown[];
      if (text === "SELECT sqlite_version() AS sqlite_version") {
        if (options.versionProbeCause !== undefined) throw options.versionProbeCause;
        rows = [{ sqlite_version: options.sqliteVersion ?? "3.45.0" }];
      } else if (text === "PRAGMA defer_foreign_keys") {
        rows = [{ defer_foreign_keys: transactionOpen ? deferredForeignKeys : 0 }];
      } else if (text === "PRAGMA read_uncommitted") {
        rows = [{ read_uncommitted: options.readUncommitted ?? 0 }];
      } else if (text === "PRAGMA journal_mode") {
        rows = [{ journal_mode: options.journalMode ?? "wal" }];
      } else {
        rows = options.queryRows ?? [];
        if (options.queryBarrier !== undefined) {
          return options.queryBarrier.then(() => {
            options.onQuerySettled?.();
            return rows;
          });
        }
      }

      return options.resultKind === "async" ? Promise.resolve(rows) : rows;
    },

    run: (query) => {
      const text = renderDrizzleSql(query);
      calls.push({ method: "run", text });
      if (text === "PRAGMA defer_foreign_keys = ON" && transactionOpen) {
        deferredForeignKeys = 1;
      }
      return options.resultKind === "async"
        ? Promise.resolve(options.runResult)
        : options.runResult;
    },

    transaction: <Value>(
      use: (transaction: PrototypeDrizzleSqliteDatabase<RunResult>) => Value | Promise<Value>,
    ): Value | Promise<Value> => {
      transactionCount += 1;
      if (options.transactionMode === "unavailable") {
        throw new Error("Prototype transaction unavailable");
      }

      transactionOpen = true;
      deferredForeignKeys = 0;

      if (options.transactionMode === "async") {
        return Promise.resolve(use(database)).finally(() => {
          transactionOpen = false;
          deferredForeignKeys = 0;
        });
      }

      const result = use(database);
      transactionOpen = false;
      deferredForeignKeys = 0;
      return options.transactionMode === "early-commit" ? Promise.resolve(result) : result;
    },
  };

  return {
    ...database,
    get controls() {
      return { calls, transactionCount };
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Drizzle SQLite prototype failed: ${message}`);
}

interface PrototypeStoredJob {
  readonly id: number;
  readonly label: string;
  readonly generatedLabel: string;
}

async function runPrototype(): Promise<void> {
  const syncRunResult = { changes: 2, lastInsertRowid: 10 };
  const syncDatabase = makePrototypeDatabase({
    resultKind: "sync",
    transactionMode: "sync",
    runResult: syncRunResult,
    queryRows: [{ id: 1, label: "ready" }],
  });

  const baseStore = await bindSqliteStore({ database: syncDatabase });
  const typedRows = await baseStore.query<{ readonly id: number; readonly label: string }>(
    rawStatement("SELECT id, label FROM jobs"),
  );
  assert(typedRows[0]?.id === 1, "query preserves the caller-selected row type");

  const command = await baseStore.execute({
    segments: ["UPDATE jobs SET ready = ", ""],
    parameters: [true],
  });
  assert(command.affectedRows === 2, "execute normalizes top-level changes");
  assert(command.driverResult === syncRunResult, "execute preserves driver result identity");
  assert(
    syncDatabase.controls.calls.some(
      (call) => call.method === "all" && call.text === "SELECT id, label FROM jobs",
    ),
    "query uses all",
  );
  assert(
    syncDatabase.controls.calls.some(
      (call) => call.method === "run" && call.text === "UPDATE jobs SET ready = ?",
    ),
    "execute uses run",
  );
  assert(!("transaction" in baseStore), "base binding exposes no transaction method");

  const promiseBeforeValidation = baseStore.query({ segments: [], parameters: [] });
  assert(
    promiseBeforeValidation instanceof Promise,
    "query returns a native Promise before validation",
  );
  await promiseBeforeValidation.then(
    () => {
      throw new Error("invalid Statement unexpectedly succeeded");
    },
    (cause: unknown) => {
      assert(
        cause instanceof PrototypeSqlStatementError && cause.operation === "query",
        "query reports its operation on Statement failure",
      );
    },
  );

  await bindSqliteStore({
    database: {} as PrototypeDrizzleSqliteDatabase<undefined>,
  }).then(
    () => {
      throw new Error("invalid database unexpectedly bound");
    },
    (cause: unknown) => {
      assert(
        cause instanceof PrototypeBindingError && cause.reason === "invalid-database",
        "invalid database shape uses the binding error",
      );
    },
  );

  const versionProbeCause = new Error("version probe failed");
  const failedVersionProbeDatabase = makePrototypeDatabase({
    resultKind: "async",
    transactionMode: "async",
    runResult: undefined,
    versionProbeCause,
  });
  await bindSqliteStore({ database: failedVersionProbeDatabase }).then(
    () => {
      throw new Error("failed version probe unexpectedly bound");
    },
    (cause: unknown) => {
      assert(
        cause instanceof PrototypeBindingError &&
          cause.reason === "probe-failed" &&
          cause.cause === versionProbeCause,
        "version probe failure uses the binding error",
      );
    },
  );

  const oversizedVersionDatabase = makePrototypeDatabase({
    resultKind: "async",
    transactionMode: "async",
    runResult: undefined,
    sqliteVersion: "9007199254740992.0.0",
  });
  await bindSqliteStore({ database: oversizedVersionDatabase }).then(
    () => {
      throw new Error("oversized SQLite version unexpectedly bound");
    },
    (cause: unknown) => {
      assert(
        cause instanceof PrototypeBindingError && cause.reason === "invalid-version-result",
        "version components must be nonnegative safe integers",
      );
    },
  );

  await bindSqliteStore({ database: syncDatabase, transaction: true }).then(
    () => {
      throw new Error("sync transaction unexpectedly bound");
    },
    (cause: unknown) => {
      assert(
        cause instanceof PrototypeBindingError && cause.reason === "transaction-unavailable",
        "sync transaction commits before the asynchronous continuation",
      );
    },
  );

  const asyncDatabase = makePrototypeDatabase({
    resultKind: "async",
    transactionMode: "async",
    runResult: { meta: { changes: 3 } },
  });
  const transactionStore = await bindSqliteStore({
    database: asyncDatabase,
    transaction: true,
  });
  const transactionValue = await transactionStore.transaction(async (transaction) => {
    const result = await transaction.execute(rawStatement("DELETE FROM jobs"));
    assert(result.affectedRows === 3, "transaction View preserves normalized metadata");
    return "committed" as const;
  });
  assert(transactionValue === "committed", "async transaction callback completes once");
  assert(
    asyncDatabase.controls.transactionCount === 2,
    "binding probe and public transaction each run once",
  );

  let retainedTransactionView:
    | PrototypeSqlStore<{ readonly meta: { readonly changes: number } }>
    | undefined;
  await transactionStore.transaction(async (transaction) => {
    retainedTransactionView = transaction;
  });
  assert(retainedTransactionView !== undefined, "transaction did not provide its View");
  const callsBeforeClosedView = asyncDatabase.controls.calls.length;
  await retainedTransactionView.query(rawStatement("SELECT after_close")).then(
    () => {
      throw new Error("closed transaction View unexpectedly ran SQL");
    },
    (cause: unknown) => {
      assert(
        cause instanceof PrototypeTransactionClosedError,
        "closed transaction View uses the shared runner error",
      );
    },
  );
  assert(
    asyncDatabase.controls.calls.length === callsBeforeClosedView,
    "closed transaction View started driver work",
  );

  let releaseHeldQuery!: () => void;
  const queryBarrier = new Promise<void>((resolve) => {
    releaseHeldQuery = resolve;
  });
  let heldQueryFinished = false;
  const heldDatabase = makePrototypeDatabase({
    resultKind: "async",
    transactionMode: "async",
    runResult: undefined,
    queryBarrier,
    onQuerySettled: () => {
      heldQueryFinished = true;
    },
  });
  const heldTransactionStore = await bindSqliteStore({
    database: heldDatabase,
    transaction: true,
  });
  const heldTransaction = heldTransactionStore.transaction(async (transaction) => {
    void transaction.query(rawStatement("SELECT held"));
    return "must-roll-back" as const;
  });
  let heldTransactionSettled = false;
  void heldTransaction.then(
    () => {
      heldTransactionSettled = true;
    },
    () => {
      heldTransactionSettled = true;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert(!heldTransactionSettled, "transaction completed before active Store work drained");
  releaseHeldQuery();
  await heldTransaction.then(
    () => {
      throw new Error("transaction with unsettled work unexpectedly committed");
    },
    (cause: unknown) => {
      assert(
        cause instanceof PrototypeTransactionUnsettledOperationError && heldQueryFinished,
        "shared runner drains active work before rejecting",
      );
    },
  );

  const offJournalDatabase = makePrototypeDatabase({
    resultKind: "async",
    transactionMode: "async",
    runResult: undefined,
    journalMode: "off",
  });
  await bindSqliteStore({ database: offJournalDatabase, transaction: true }).then(
    () => {
      throw new Error("journal_mode=off unexpectedly bound");
    },
    (cause: unknown) => {
      assert(
        cause instanceof PrototypeBindingError && cause.reason === "transaction-unavailable",
        "transaction probe rejects journal_mode=off",
      );
    },
  );

  const unknownJournalDatabase = makePrototypeDatabase({
    resultKind: "async",
    transactionMode: "async",
    runResult: undefined,
    journalMode: "unknown",
  });
  await bindSqliteStore({ database: unknownJournalDatabase, transaction: true }).then(
    () => {
      throw new Error("unknown journal mode unexpectedly bound");
    },
    (cause: unknown) => {
      assert(
        cause instanceof PrototypeBindingError && cause.reason === "transaction-unavailable",
        "transaction probe rejects unknown journal modes",
      );
    },
  );

  assert(
    readAffectedRows({ rowsAffected: 4 }) === 4 &&
      readAffectedRows({ meta: { changes: 5 } }) === 5 &&
      readAffectedRows({ changes: 1, rowsAffected: 2 }) === undefined &&
      readAffectedRows({ changes: 1, meta: { changes: 1 } }) === undefined &&
      readAffectedRows({ changes: -1 }) === undefined &&
      readAffectedRows(undefined) === undefined,
    "affected-row normalization is conservative and unambiguous",
  );

  const primaryIdentity = resolveCandidateIdentity({
    primaryKey: ["tenantId", "jobId"],
    physicalColumns: ["tenant_id", "job_id"],
  });
  assert(primaryIdentity.kind === "primary-key", "declared primary key wins");

  const rowIdIdentity = resolveCandidateIdentity({
    primaryKey: [],
    physicalColumns: ["rowid", "_rowid_"],
  });
  assert(
    rowIdIdentity.kind === "rowid" && rowIdIdentity.alias === "oid",
    "first unshadowed ROWID alias is selected",
  );

  let identityRejected = false;
  try {
    resolveCandidateIdentity({
      primaryKey: [],
      physicalColumns: ["rowid", "_rowid_", "oid"],
    });
  } catch {
    identityRejected = true;
  }
  assert(identityRejected, "a table without an accessible identity rejects");

  const storedJobs = new Map<number, PrototypeStoredJob>([
    [1, { id: 1, label: "first", generatedLabel: "FIRST" }],
    [2, { id: 2, label: "second", generatedLabel: "SECOND" }],
  ]);
  const candidates: readonly PrototypeCandidate<number>[] = [
    { identity: 1, observedRawValues: { id: 1, label: "first", generatedLabel: "FIRST" } },
    { identity: 2, observedRawValues: { id: 2, label: "second", generatedLabel: "SECOND" } },
  ];
  const validatedStoredLabels: string[] = [];

  await updateCandidates({
    candidates,
    write: async (candidate) => {
      if (candidate.identity === 2) {
        storedJobs.set(2, { id: 2, label: "concurrent", generatedLabel: "CONCURRENT" });
      }
      const current = storedJobs.get(candidate.identity);
      if (current === undefined || !hasObservedRawValues(current, candidate.observedRawValues)) {
        return undefined;
      }
      const updated = {
        ...current,
        label: `${current.label}-updated`,
        generatedLabel: `${current.label.toUpperCase()}-UPDATED`,
      };
      storedJobs.set(candidate.identity, updated);
      return candidate.identity;
    },
    readStored: async (identity) => storedJobs.get(identity),
    validateStored: (stored) => {
      validatedStoredLabels.push(stored.generatedLabel);
    },
  }).then(
    () => {
      throw new Error("candidate conflict unexpectedly succeeded");
    },
    (cause: unknown) => {
      assert(
        cause instanceof PrototypeCandidateConflictError && cause.writesMayRemain,
        "later candidate conflict reports an earlier write",
      );
    },
  );
  assert(
    validatedStoredLabels[0] === "FIRST-UPDATED",
    "update validates the stored post-trigger value",
  );

  const createdJobs = new Map<number, PrototypeStoredJob>();
  const created = await createAndReadStored({
    write: async () => {
      createdJobs.set(3, { id: 3, label: "created", generatedLabel: "CREATED-BY-TRIGGER" });
      return 3;
    },
    readStored: async (identity) => createdJobs.get(identity),
  });
  assert(created.generatedLabel === "CREATED-BY-TRIGGER", "create returns stored trigger output");

  assert(
    isSqliteBusyCause({ cause: { code: 517 } }) &&
      isSqliteBusyCause({ code: 10_757 }) &&
      isSqliteBusyCause({ code: "SQLITE_BUSY_TIMEOUT" }) &&
      !isSqliteBusyCause({ code: "SQLITE_LOCKED" }) &&
      !isSqliteBusyCause(new Error("SQLITE_BUSY")),
    "only structured BUSY codes map to transaction conflict",
  );
}

await runPrototype();
