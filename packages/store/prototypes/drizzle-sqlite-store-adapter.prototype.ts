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

  const changes = readProperty(value, "changes");
  if (isAffectedRows(changes)) return changes;

  const rowsAffected = readProperty(value, "rowsAffected");
  if (isAffectedRows(rowsAffected)) return rowsAffected;

  const meta = readProperty(value, "meta");
  if (!isObject(meta)) return undefined;

  const metaChanges = readProperty(meta, "changes");
  return isAffectedRows(metaChanges) ? metaChanges : undefined;
}

function isAffectedRows(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function makeSqlStore<RunResult>(
  database: PrototypeDrizzleSqliteDatabase<RunResult>,
): PrototypeSqlStore<RunResult> {
  return {
    query: <Row = unknown>(statement: PrototypeSqlStatement): Promise<readonly Row[]> =>
      Promise.resolve().then(async () => {
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
      Promise.resolve().then(async () => {
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
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new PrototypeBindingError("invalid-version-result");
  }
  return [major, minor, patch];
}

function isSupportedSqliteVersion(version: readonly [number, number, number]): boolean {
  const [major, minor, patch] = version;
  return major > 3 || (major === 3 && (minor > 45 || (minor === 45 && patch >= 0)));
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

      if (deferred !== 1 || isolation !== 0 || typeof journal !== "string" || journal === "off") {
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
    const versionRows = await options.database.all(
      toDrizzleSql(compileSqliteStatement(versionProbe)),
    );
    const version = readSqliteVersion(versionRows);
    if (!isSupportedSqliteVersion(version)) {
      throw new PrototypeBindingError("unsupported-sqlite-version");
    }

    const store = makeSqlStore(options.database);
    if (options.transaction !== true) return store;

    await requireTransactionCapability(options.database);

    return {
      ...store,
      transaction: async <Value>(
        use: (transaction: PrototypeSqlStore<RunResult>) => Promise<Value>,
      ): Promise<Value> =>
        await options.database.transaction(
          async (transaction) => await use(makeSqlStore(transaction)),
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

const sqliteBusyCodes = new Set([5, 261, 517, 773]);
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
      (typeof code === "number" && sqliteBusyCodes.has(code)) ||
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
  readonly sqliteVersion?: string;
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
        rows = [{ sqlite_version: options.sqliteVersion ?? "3.45.0" }];
      } else if (text === "PRAGMA defer_foreign_keys") {
        rows = [{ defer_foreign_keys: transactionOpen ? deferredForeignKeys : 0 }];
      } else if (text === "PRAGMA read_uncommitted") {
        rows = [{ read_uncommitted: options.readUncommitted ?? 0 }];
      } else if (text === "PRAGMA journal_mode") {
        rows = [{ journal_mode: options.journalMode ?? "wal" }];
      } else {
        rows = options.queryRows ?? [];
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

  assert(
    readAffectedRows({ rowsAffected: 4 }) === 4 &&
      readAffectedRows({ meta: { changes: 5 } }) === 5 &&
      readAffectedRows({ changes: -1 }) === undefined &&
      readAffectedRows(undefined) === undefined,
    "affected-row normalization is conservative",
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
      isSqliteBusyCause({ code: "SQLITE_BUSY_TIMEOUT" }) &&
      !isSqliteBusyCause({ code: "SQLITE_LOCKED" }) &&
      !isSqliteBusyCause(new Error("SQLITE_BUSY")),
    "only structured BUSY codes map to transaction conflict",
  );
}

await runPrototype();
