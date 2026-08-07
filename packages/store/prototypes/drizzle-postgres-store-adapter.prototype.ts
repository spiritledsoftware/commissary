/*
 * Compile-tested behavior prototype for issue #20.
 *
 * The file uses local Store and Drizzle stand-ins. It proves the approved
 * PostgreSQL adapter seams without adding a production Drizzle dependency.
 */

export {};

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

type NonEmptyTuple<Value> = readonly [Value, ...Value[]];

interface PrototypeFieldDefinition {
  readonly nullable: boolean;
}

type PrototypeFieldDefinitions = Readonly<Record<string, PrototypeFieldDefinition>>;

interface PrototypeSqlTableDefinition<FieldName extends string = string> {
  readonly name: string;
  readonly primaryKey?: NonEmptyTuple<FieldName>;
}

interface PrototypeSqlRecordDefinition<Fields extends PrototypeFieldDefinitions> {
  readonly table: PrototypeSqlTableDefinition<Extract<keyof Fields, string>>;
  readonly fields: Fields;
}

function snapshotNonEmptyTuple<Value>(value: NonEmptyTuple<Value>): NonEmptyTuple<Value> {
  const snapshot: [Value, ...Value[]] = [value[0], ...value.slice(1)];
  return Object.freeze(snapshot);
}

function defineSqlRecord<const Fields extends PrototypeFieldDefinitions>(
  definition: PrototypeSqlRecordDefinition<Fields>,
): PrototypeSqlRecordDefinition<Fields> {
  const primaryKey = definition.table.primaryKey;
  if (primaryKey !== undefined) {
    const names = new Set<string>();
    for (const fieldName of primaryKey) {
      if (names.has(fieldName)) {
        throw new TypeError(`Duplicate primary-key field '${fieldName}'`);
      }
      names.add(fieldName);
      const field = definition.fields[fieldName];
      if (field === undefined) {
        throw new TypeError(`Unknown primary-key field '${fieldName}'`);
      }
      if (field.nullable) {
        throw new TypeError(`Nullable primary-key field '${fieldName}'`);
      }
    }
  }
  const table =
    primaryKey === undefined
      ? Object.freeze({ ...definition.table })
      : Object.freeze({
          ...definition.table,
          primaryKey: snapshotNonEmptyTuple(primaryKey),
        });
  return Object.freeze({
    table,
    fields: Object.freeze({ ...definition.fields }),
  });
}

interface PrototypeDrizzleTable<FieldName extends string = string> {
  readonly name: string;
  readonly primaryKey?: NonEmptyTuple<FieldName>;
}

function resolvePrimaryKey<const Fields extends PrototypeFieldDefinitions>(
  record: PrototypeSqlRecordDefinition<Fields>,
  table: PrototypeDrizzleTable<Extract<keyof Fields, string>>,
): readonly string[] | undefined {
  const recordKey = record.table.primaryKey;
  const tableKey = table.primaryKey;
  if (recordKey !== undefined && tableKey !== undefined) {
    if (recordKey.length !== tableKey.length) {
      throw new TypeError("SQL and Drizzle primary keys differ");
    }
    for (const [index, fieldName] of recordKey.entries()) {
      if (fieldName !== tableKey[index]) {
        throw new TypeError("SQL and Drizzle primary keys differ");
      }
    }
  }
  return recordKey ?? tableKey;
}

interface PrototypeSqlStatement<Parameter> {
  readonly segments: readonly string[];
  readonly parameters: readonly Parameter[];
}

interface CompiledSqlStatement<Parameter> {
  readonly text: string;
  readonly parameters: Parameter[];
  readonly segments: readonly string[];
}

function compilePostgresStatement<Parameter>(
  statement: PrototypeSqlStatement<Parameter>,
): CompiledSqlStatement<Parameter> {
  if (statement.segments.length !== statement.parameters.length + 1) {
    throw new TypeError("SQL segment count does not match parameter count");
  }

  const parameters = [...statement.parameters];
  const segments = Object.freeze([...statement.segments]);
  let text = segments[0] ?? "";
  for (const [index, parameter] of parameters.entries()) {
    void parameter;
    text += `$${index + 1}${segments[index + 1] ?? ""}`;
  }
  return { text, parameters, segments };
}

type PrototypeDrizzleSqlChunk =
  | { readonly kind: "raw"; readonly text: string }
  | { readonly kind: "parameter"; readonly value: unknown };

interface PrototypeDrizzleSql {
  readonly chunks: readonly PrototypeDrizzleSqlChunk[];
}

function toDrizzleSql(compiled: CompiledSqlStatement<unknown>): PrototypeDrizzleSql {
  const chunks: PrototypeDrizzleSqlChunk[] = [];
  for (const [index, segment] of compiled.segments.entries()) {
    chunks.push({ kind: "raw", text: segment });
    if (index < compiled.parameters.length) {
      chunks.push({ kind: "parameter", value: compiled.parameters[index] });
    }
  }
  return { chunks };
}

interface PrototypeExecutionResult {
  readonly rows: readonly unknown[];
  readonly rowCount?: number;
  readonly command?: string;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function readOptionalProperty(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function normalizeExecutionResult(result: unknown): PrototypeExecutionResult {
  const rows = Array.isArray(result)
    ? result
    : isObject(result) && Array.isArray(readOptionalProperty(result, "rows"))
      ? readOptionalProperty(result, "rows")
      : undefined;

  if (!Array.isArray(rows)) {
    throw new TypeError("Invalid PostgreSQL execution result");
  }

  const rowCount = isObject(result) ? readOptionalProperty(result, "rowCount") : undefined;
  const command = isObject(result) ? readOptionalProperty(result, "command") : undefined;

  return {
    rows,
    ...(typeof rowCount === "number" && Number.isSafeInteger(rowCount) && rowCount >= 0
      ? { rowCount }
      : {}),
    ...(typeof command === "string" ? { command } : {}),
  };
}

interface PrototypeTransactionConfig {
  readonly isolationLevel: "serializable";
  readonly accessMode?: "read only";
}

interface PrototypePgDatabase {
  readonly execute: (statement: PrototypeDrizzleSql) => Promise<unknown>;
  readonly transaction?: <Value>(
    use: (transaction: PrototypePgDatabase) => Promise<Value>,
    config: PrototypeTransactionConfig,
  ) => Promise<Value>;
}

interface PrototypeSqlStore {
  readonly execute: (
    statement: PrototypeSqlStatement<null | boolean | number | string>,
  ) => Promise<PrototypeExecutionResult>;
}

interface PrototypeTransactionStore extends PrototypeSqlStore {
  readonly transaction: <Value>(
    use: (transaction: PrototypeSqlStore) => Promise<Value>,
  ) => Promise<Value>;
}

class PrototypeBindingError extends Error {
  readonly name = "PrototypeBindingError";

  constructor(
    readonly reason: "invalid-version-result" | "unsupported-version" | "transaction-unavailable",
  ) {
    super(reason);
  }
}

function rawStatement(text: string): PrototypeSqlStatement<never> {
  return { segments: [text], parameters: [] };
}

function makeSqlStore(database: PrototypePgDatabase): PrototypeSqlStore {
  return {
    execute: async (statement) => {
      const compiled = compilePostgresStatement(statement);
      return normalizeExecutionResult(await database.execute(toDrizzleSql(compiled)));
    },
  };
}

function readServerVersion(result: PrototypeExecutionResult): number {
  if (result.rows.length !== 1 || !isObject(result.rows[0])) {
    throw new PrototypeBindingError("invalid-version-result");
  }
  const rawVersion = readOptionalProperty(result.rows[0], "server_version_num");
  const version = typeof rawVersion === "string" ? Number(rawVersion) : rawVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw new PrototypeBindingError("invalid-version-result");
  }
  return version;
}

interface PrototypeBindOptions {
  readonly database: PrototypePgDatabase;
  readonly transaction?: false;
}

interface PrototypeTransactionBindOptions {
  readonly database: PrototypePgDatabase;
  readonly transaction: true;
}

function bindPostgresStore(
  options: PrototypeTransactionBindOptions,
): Promise<PrototypeTransactionStore>;
function bindPostgresStore(options: PrototypeBindOptions): Promise<PrototypeSqlStore>;
async function bindPostgresStore(
  options: PrototypeBindOptions | PrototypeTransactionBindOptions,
): Promise<PrototypeSqlStore | PrototypeTransactionStore> {
  const store = makeSqlStore(options.database);
  const version = readServerVersion(await store.execute(rawStatement("SHOW server_version_num")));
  if (version < 150_000) {
    throw new PrototypeBindingError("unsupported-version");
  }

  if (options.transaction !== true) {
    return store;
  }

  const runTransaction = options.database.transaction;
  if (runTransaction === undefined) {
    throw new PrototypeBindingError("transaction-unavailable");
  }

  try {
    await runTransaction(
      async (transaction) => {
        await makeSqlStore(transaction).execute(rawStatement("SELECT 1"));
      },
      { isolationLevel: "serializable", accessMode: "read only" },
    );
  } catch {
    throw new PrototypeBindingError("transaction-unavailable");
  }

  return {
    ...store,
    transaction: async (use) =>
      runTransaction(async (transaction) => use(makeSqlStore(transaction)), {
        isolationLevel: "serializable",
      }),
  };
}

type PrototypeCandidateIdentity =
  | {
      readonly kind: "primary-key";
      readonly values: readonly JsonValue[];
      readonly xmin: string;
    }
  | {
      readonly kind: "physical-row";
      readonly tableOid: string;
      readonly tupleId: string;
      readonly xmin: string;
    };

interface PrototypeCandidate<RecordValue> {
  readonly record: RecordValue;
  readonly identity: PrototypeCandidateIdentity;
}

class PrototypeStoreAdapterError extends Error {
  readonly name = "PrototypeStoreAdapterError";

  constructor(
    readonly writesMayRemain: boolean,
    readonly cause: unknown,
  ) {
    super("PostgreSQL Store mutation failed");
  }
}

async function updateCandidates<RecordValue>(options: {
  readonly candidates: readonly PrototypeCandidate<RecordValue>[];
  readonly validate: (record: RecordValue) => RecordValue;
  readonly guardedWrite: (
    identity: PrototypeCandidateIdentity,
    record: RecordValue,
  ) => Promise<boolean>;
}): Promise<number> {
  let completedWrites = 0;
  for (const candidate of options.candidates) {
    let record: RecordValue;
    try {
      record = options.validate(candidate.record);
      const changed = await options.guardedWrite(candidate.identity, record);
      if (!changed) {
        throw new Error("concurrent-change");
      }
    } catch (cause) {
      throw new PrototypeStoreAdapterError(completedWrites > 0, cause);
    }
    completedWrites += 1;
  }
  return completedWrites;
}

function isTransactionStore(store: PrototypeSqlStore): store is PrototypeTransactionStore {
  return typeof Reflect.get(store, "transaction") === "function";
}

class PrototypeCoreThreadStore {
  #queue: Promise<void> = Promise.resolve();

  constructor(readonly backend: PrototypeSqlStore) {}

  run<Value>(operation: (store: PrototypeSqlStore) => Promise<Value>): Promise<Value> {
    if (isTransactionStore(this.backend)) {
      return this.backend.transaction(operation);
    }

    const result = this.#queue.then(
      () => operation(this.backend),
      () => operation(this.backend),
    );
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function makePrototypeDatabase(options: {
  readonly transaction: boolean;
  readonly version?: number;
}): PrototypePgDatabase & {
  readonly calls: PrototypeDrizzleSql[];
  readonly transactionCalls: { readonly config: PrototypeTransactionConfig }[];
} {
  const calls: PrototypeDrizzleSql[] = [];
  const transactionCalls: { readonly config: PrototypeTransactionConfig }[] = [];
  const execute = async (statement: PrototypeDrizzleSql): Promise<unknown> => {
    calls.push(statement);
    const text = statement.chunks
      .filter(
        (chunk): chunk is Extract<PrototypeDrizzleSqlChunk, { kind: "raw" }> =>
          chunk.kind === "raw",
      )
      .map((chunk) => chunk.text)
      .join("");
    if (text === "SHOW server_version_num") {
      return { rows: [{ server_version_num: String(options.version ?? 150_000) }] };
    }
    if (text === "SELECT 1") {
      return [{ value: 1 }];
    }
    return { rows: [{ ok: true }], rowCount: 1, command: "SELECT" };
  };

  if (!options.transaction) {
    return { execute, calls, transactionCalls };
  }

  const transaction = async <Value>(
    use: (transaction: PrototypePgDatabase) => Promise<Value>,
    config: PrototypeTransactionConfig,
  ): Promise<Value> => {
    transactionCalls.push({ config });
    return use(database);
  };
  const database: PrototypePgDatabase & {
    readonly calls: PrototypeDrizzleSql[];
    readonly transactionCalls: { readonly config: PrototypeTransactionConfig }[];
  } = { execute, calls, transactionCalls, transaction };
  return database;
}

async function runPrototype(): Promise<void> {
  const keyedRecord = defineSqlRecord({
    table: { name: "jobs", primaryKey: ["tenantId", "id"] },
    fields: {
      tenantId: { nullable: false },
      id: { nullable: false },
      status: { nullable: false },
    },
  });
  const unkeyedRecord = defineSqlRecord({
    table: { name: "audit_events" },
    fields: { payload: { nullable: false } },
  });
  assert(
    resolvePrimaryKey(keyedRecord, {
      name: "jobs",
      primaryKey: ["tenantId", "id"],
    })?.join(",") === "tenantId,id",
    "composite primary key was not preserved",
  );
  assert(
    resolvePrimaryKey(unkeyedRecord, { name: "audit_events" }) === undefined,
    "unkeyed SQL table became keyed",
  );

  const compiled = compilePostgresStatement({
    segments: ["SELECT '$1' AS raw_value, ", " AS bound_value"],
    parameters: [42],
  });
  assert(
    compiled.text === "SELECT '$1' AS raw_value, $1 AS bound_value",
    "PostgreSQL text compilation changed raw placeholder-like text",
  );
  const drizzleStatement = toDrizzleSql(compiled);
  assert(
    drizzleStatement.chunks[0]?.kind === "raw" && drizzleStatement.chunks[0].text.includes("'$1'"),
    "raw placeholder-like text was parsed",
  );
  assert(
    drizzleStatement.chunks[1]?.kind === "parameter" && drizzleStatement.chunks[1].value === 42,
    "bound value did not remain a parameter",
  );

  const baseDatabase = makePrototypeDatabase({ transaction: false });
  const baseStore = await bindPostgresStore({ database: baseDatabase });
  assert(!isTransactionStore(baseStore), "base binder exposed a transaction method");
  const execution = await baseStore.execute({
    segments: ["SELECT ", " AS value"],
    parameters: [1],
  });
  assert(execution.rowCount === 1, "rowCount metadata was lost");
  assert(execution.command === "SELECT", "command metadata was lost");
  assert(baseDatabase.transactionCalls.length === 0, "base binding probed transactions");

  const transactionDatabase = makePrototypeDatabase({ transaction: true });
  const transactionStore = await bindPostgresStore({
    database: transactionDatabase,
    transaction: true,
  });
  assert(isTransactionStore(transactionStore), "transaction binding lost its capability");
  await transactionStore.transaction(async (transaction) => {
    await transaction.execute(rawStatement("SELECT 1"));
  });
  assert(
    transactionDatabase.transactionCalls[0]?.config.accessMode === "read only",
    "binding did not use a read-only transaction probe",
  );
  assert(
    transactionDatabase.transactionCalls[1]?.config.isolationLevel === "serializable",
    "Store transaction was not serializable",
  );

  const primaryIdentity: PrototypeCandidateIdentity = {
    kind: "primary-key",
    values: ["tenant-1", "job-1"],
    xmin: "10",
  };
  const physicalIdentity: PrototypeCandidateIdentity = {
    kind: "physical-row",
    tableOid: "16384",
    tupleId: "(0,2)",
    xmin: "11",
  };
  const writes: PrototypeCandidateIdentity[] = [];
  let partialFailure: PrototypeStoreAdapterError | undefined;
  try {
    await updateCandidates({
      candidates: [
        { record: { status: "ready" }, identity: primaryIdentity },
        { record: { status: "ready" }, identity: physicalIdentity },
      ],
      validate: (record) => record,
      guardedWrite: async (identity) => {
        writes.push(identity);
        return identity.kind === "primary-key";
      },
    });
  } catch (cause) {
    if (cause instanceof PrototypeStoreAdapterError) {
      partialFailure = cause;
    } else {
      throw cause;
    }
  }
  assert(writes.length === 2, "guarded writes did not run sequentially");
  assert(partialFailure?.writesMayRemain === true, "partial mutation was not reported");

  const coreOrder: string[] = [];
  const core = new PrototypeCoreThreadStore(baseStore);
  const first = core.run(async () => {
    coreOrder.push("first-start");
    await Promise.resolve();
    coreOrder.push("first-end");
  });
  const second = core.run(async () => {
    coreOrder.push("second");
  });
  await Promise.all([first, second]);
  assert(
    coreOrder.join(",") === "first-start,first-end,second",
    "plain Core operations were not serialized within one instance",
  );
}

await runPrototype();
