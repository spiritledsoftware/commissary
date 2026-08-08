/*
 * Compile-tested final SQL and Drizzle Store specification prototype for issue #19.
 *
 * Small local Store, Core, Standard Schema, and Drizzle stand-ins test the complete
 * cross-adapter contract without adding production dependencies.
 */

type ApprovalDialect = "postgres" | "mysql" | "sqlite";
type ApprovalJson =
  | null
  | boolean
  | number
  | string
  | readonly ApprovalJson[]
  | {
      readonly [key: string]: ApprovalJson;
    };
type ApprovalFieldMap = Readonly<Record<string, ApprovalField<ApprovalJson, string, boolean>>>;

type ApprovalField<
  Value extends ApprovalJson,
  ColumnName extends string,
  HasDefault extends boolean,
> = {
  readonly columnName: ColumnName;
  readonly hasDefault: HasDefault;
  readonly selected: Value;
};

function approvalTextField<const ColumnName extends string>(
  columnName: ColumnName,
): ApprovalField<string, ColumnName, false>;
function approvalTextField<const ColumnName extends string>(
  columnName: ColumnName,
  hasDefault: true,
): ApprovalField<string, ColumnName, true>;
function approvalTextField(
  columnName: string,
  hasDefault = false,
): ApprovalField<string, string, boolean> {
  return { columnName, hasDefault, selected: "" };
}

function approvalNumberField<const ColumnName extends string>(
  columnName: ColumnName,
): ApprovalField<number, ColumnName, false> {
  return { columnName, hasDefault: false, selected: 0 };
}

type ApprovalRecordDefinition<
  TableName extends string,
  Fields extends ApprovalFieldMap,
  PrimaryKey extends readonly [keyof Fields & string, ...(keyof Fields & string)[]],
> = {
  readonly kind: "record";
  readonly tableName: TableName;
  readonly fields: Fields;
  readonly primaryKey: PrimaryKey;
};

function defineApprovalRecord<
  const TableName extends string,
  const Fields extends ApprovalFieldMap,
  const PrimaryKey extends readonly [keyof Fields & string, ...(keyof Fields & string)[]],
>(options: {
  readonly tableName: TableName;
  readonly fields: Fields;
  readonly primaryKey: PrimaryKey;
}): ApprovalRecordDefinition<TableName, Fields, PrimaryKey> {
  return { kind: "record", ...options };
}

type ApprovalTable<
  Dialect extends ApprovalDialect,
  Name extends string,
  Fields extends ApprovalFieldMap,
  PrimaryKey extends readonly string[],
> = {
  readonly kind: "table";
  readonly dialect: Dialect;
  readonly name: Name;
  readonly columns: Fields;
  readonly primaryKey: PrimaryKey;
};

function defineApprovalTable<
  const Dialect extends ApprovalDialect,
  const Name extends string,
  const Fields extends ApprovalFieldMap,
  const PrimaryKey extends readonly [keyof Fields & string, ...(keyof Fields & string)[]],
>(options: {
  readonly dialect: Dialect;
  readonly name: Name;
  readonly columns: Fields;
  readonly primaryKey: PrimaryKey;
}): ApprovalTable<Dialect, Name, Fields, PrimaryKey> {
  return { kind: "table", ...options };
}

const approvalCoreSqlCatalog = Object.freeze({
  thread: { table: "commissary_threads", primaryKey: ["id"] },
  branch: { table: "commissary_branches", primaryKey: ["id"] },
  message: { table: "commissary_messages", primaryKey: ["id"] },
  run: { table: "commissary_runs", primaryKey: ["id"] },
  toolCall: { table: "commissary_tool_calls", primaryKey: ["runId", "toolCallId"] },
  executionClaim: { table: "commissary_execution_claims", primaryKey: ["runId"] },
  executionFence: { table: "commissary_execution_fences", primaryKey: ["runId"] },
  pendingSteering: {
    table: "commissary_pending_steerings",
    primaryKey: ["runId", "sequence"],
  },
  pendingRedirect: {
    table: "commissary_pending_redirects",
    primaryKey: ["runId", "sequence"],
  },
  runCommandSequence: { table: "commissary_run_command_sequences", primaryKey: ["runId"] },
  toolCallSequence: { table: "commissary_tool_call_sequences", primaryKey: ["runId"] },
  runSubmission: { table: "commissary_run_submissions", primaryKey: ["runId"] },
  toolResumeRequest: {
    table: "commissary_tool_resume_requests",
    primaryKey: ["runId", "requestId"],
  },
  steeringRequest: {
    table: "commissary_steering_requests",
    primaryKey: ["runId", "requestId"],
  },
  redirectRequest: {
    table: "commissary_redirect_requests",
    primaryKey: ["runId", "requestId"],
  },
  commit: { table: "commissary_commits", primaryKey: ["commitId"] },
  finalizationOutcome: {
    table: "commissary_finalization_outcomes",
    primaryKey: ["commitId"],
  },
  modelCommitOutcome: {
    table: "commissary_model_commit_outcomes",
    primaryKey: ["commitId"],
  },
  settlementOutcome: {
    table: "commissary_settlement_outcomes",
    primaryKey: ["commitId"],
  },
} as const);

type ApprovalCoreSqlCatalog = typeof approvalCoreSqlCatalog;
type ApprovalCoreTables<Dialect extends ApprovalDialect> = {
  readonly [Name in keyof ApprovalCoreSqlCatalog]: ApprovalTable<
    Dialect,
    ApprovalCoreSqlCatalog[Name]["table"],
    ApprovalFieldMap,
    ApprovalCoreSqlCatalog[Name]["primaryKey"]
  >;
};

function makeApprovalCoreTables<Dialect extends ApprovalDialect>(
  dialect: Dialect,
): ApprovalCoreTables<Dialect> {
  const tables = Object.fromEntries(
    Object.entries(approvalCoreSqlCatalog).map(([key, catalog]) => [
      key,
      {
        kind: "table",
        dialect,
        name: catalog.table,
        columns: {},
        primaryKey: catalog.primaryKey,
      },
    ]),
  );

  // SAFETY: This function visits the complete closed catalog and copies each exact key,
  // table name, and primary-key tuple into the matching dialect table.
  return tables as ApprovalCoreTables<Dialect>;
}

type ApprovalStandardSchema<Value> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
  };
  readonly value: Value;
};

type ApprovalGeneratedFields<Fields extends ApprovalFieldMap> = {
  readonly [Name in keyof Fields]: ApprovalStandardSchema<Fields[Name]["selected"]>;
};

type ApprovalZodObjectSchema<Fields extends ApprovalFieldMap> = ApprovalStandardSchema<unknown> & {
  readonly family: "drizzle-zod@0.8.3";
  readonly shape: ApprovalGeneratedFields<Fields>;
};

type ApprovalValibotObjectSchema<Fields extends ApprovalFieldMap> =
  ApprovalStandardSchema<unknown> & {
    readonly family: "drizzle-valibot@0.4.2";
    readonly entries: ApprovalGeneratedFields<Fields>;
  };

type ApprovalGeneratedObjectSchema<Fields extends ApprovalFieldMap> =
  | ApprovalZodObjectSchema<Fields>
  | ApprovalValibotObjectSchema<Fields>;

type ApprovalSchemaGenerators<
  Table extends ApprovalTable<ApprovalDialect, string, ApprovalFieldMap, readonly string[]>,
> = {
  readonly select: (table: Table) => ApprovalGeneratedObjectSchema<Table["columns"]>;
  readonly insert: (table: Table) => ApprovalGeneratedObjectSchema<Table["columns"]>;
  readonly update: (table: Table) => ApprovalGeneratedObjectSchema<Table["columns"]>;
};

function makeApprovalGeneratedFields<Fields extends ApprovalFieldMap>(
  fields: Fields,
  vendor: string,
): ApprovalGeneratedFields<Fields> {
  const generated = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [
      key,
      { "~standard": { version: 1 as const, vendor }, value: field.selected },
    ]),
  );

  // SAFETY: The generated map copies every key from the closed input field map once.
  return generated as ApprovalGeneratedFields<Fields>;
}

function createApprovalZodSchema<
  Table extends ApprovalTable<ApprovalDialect, string, ApprovalFieldMap, readonly string[]>,
>(table: Table): ApprovalZodObjectSchema<Table["columns"]> {
  return {
    "~standard": { version: 1, vendor: "zod" },
    value: undefined,
    family: "drizzle-zod@0.8.3",
    shape: makeApprovalGeneratedFields(table.columns, "zod"),
  };
}

function createApprovalValibotSchema<
  Table extends ApprovalTable<ApprovalDialect, string, ApprovalFieldMap, readonly string[]>,
>(table: Table): ApprovalValibotObjectSchema<Table["columns"]> {
  return {
    "~standard": { version: 1, vendor: "valibot" },
    value: undefined,
    family: "drizzle-valibot@0.4.2",
    entries: makeApprovalGeneratedFields(table.columns, "valibot"),
  };
}

const approvalZodGenerators = {
  select: createApprovalZodSchema,
  insert: createApprovalZodSchema,
  update: createApprovalZodSchema,
};
const approvalValibotGenerators = {
  select: createApprovalValibotSchema,
  insert: createApprovalValibotSchema,
  update: createApprovalValibotSchema,
};

const ScheduledJob = defineApprovalRecord({
  tableName: "scheduled_jobs",
  fields: {
    id: approvalTextField("id"),
    tenantId: approvalTextField("tenant_id"),
    queue: approvalTextField("queue"),
    runAt: approvalNumberField("run_at"),
    state: approvalTextField("state", true),
  },
  primaryKey: ["id"],
});

type ApprovalInput<Dialect extends ApprovalDialect> =
  | ApprovalRecordDefinition<string, ApprovalFieldMap, readonly [string, ...string[]]>
  | ApprovalTable<Dialect, string, ApprovalFieldMap, readonly string[]>;
type ApprovalInputs<Dialect extends ApprovalDialect> = Readonly<
  Record<string, ApprovalInput<Dialect>>
>;

type ApprovalInputFields<Input> =
  Input extends ApprovalRecordDefinition<string, infer Fields, readonly [string, ...string[]]>
    ? Fields
    : Input extends ApprovalTable<ApprovalDialect, string, infer Fields, readonly string[]>
      ? Fields
      : never;
type ApprovalInputTable<Dialect extends ApprovalDialect, Input> =
  Input extends ApprovalRecordDefinition<infer TableName, infer Fields, infer PrimaryKey>
    ? ApprovalTable<Dialect, TableName, Fields, PrimaryKey>
    : Input extends ApprovalTable<Dialect, string, ApprovalFieldMap, readonly string[]>
      ? Input
      : never;
type ApprovalTables<Dialect extends ApprovalDialect, Inputs extends ApprovalInputs<Dialect>> = {
  readonly [Name in keyof Inputs]: ApprovalInputTable<Dialect, Inputs[Name]>;
};

type ApprovalSelectedRow<Fields extends ApprovalFieldMap> = {
  readonly [Name in keyof Fields]: Fields[Name]["selected"];
};
type ApprovalDefaultKeys<Fields extends ApprovalFieldMap> = {
  readonly [Name in keyof Fields]: Fields[Name]["hasDefault"] extends true ? Name : never;
}[keyof Fields];
type ApprovalHooks<Inputs extends ApprovalInputs<ApprovalDialect>> = Partial<{
  readonly [Name in keyof Inputs]: {
    readonly beforeCreate: () => Partial<ApprovalSelectedRow<ApprovalInputFields<Inputs[Name]>>>;
  };
}>;
type ApprovalHookKeys<Hooks, Name> = Name extends keyof Hooks
  ? Hooks[Name] extends { readonly beforeCreate: (...arguments_: never[]) => infer Patch }
    ? keyof Patch
    : never
  : never;
type ApprovalSimplify<Value> = { readonly [Name in keyof Value]: Value[Name] };
type ApprovalAdjustedCreateInput<Fields extends ApprovalFieldMap, HookKeys> = ApprovalSimplify<
  {
    readonly [Name in keyof Fields as Name extends ApprovalDefaultKeys<Fields> | HookKeys
      ? never
      : Name]: Fields[Name]["selected"];
  } & {
    readonly [Name in keyof Fields as Name extends ApprovalDefaultKeys<Fields> | HookKeys
      ? Name
      : never]?: Fields[Name]["selected"];
  }
>;
type ApprovalCreateInputs<Inputs extends ApprovalInputs<ApprovalDialect>, Hooks> = {
  readonly [Name in keyof Inputs]: ApprovalAdjustedCreateInput<
    ApprovalInputFields<Inputs[Name]>,
    ApprovalHookKeys<Hooks, Name>
  >;
};

type ApprovalSqlReference<Table> = {
  readonly table: Table;
  readonly sql: (field?: string) => string;
};
type ApprovalSqlReferences<Tables extends Readonly<Record<string, object>>> = {
  readonly [Name in keyof Tables]: ApprovalSqlReference<Tables[Name]>;
};

const ApprovalDefinitionState: unique symbol = Symbol("ApprovalDefinitionState");

type ApprovalDefinitionKind = "store" | "thread-store";
interface ApprovalDefinitionBase<Dialect extends ApprovalDialect> {
  readonly dialect: Dialect;
  readonly kind: ApprovalDefinitionKind;
  readonly records: Readonly<Record<string, ApprovalSqlReference<object>>>;
  readonly schema: Readonly<Record<string, object>>;
  readonly inputKinds: readonly ("lower-tier-record" | "direct-table")[];
  readonly [ApprovalDefinitionState]: {
    readonly createInputs: Readonly<Record<string, object>>;
  };
}

type ApprovalDefinition<
  Dialect extends ApprovalDialect,
  Inputs extends ApprovalInputs<Dialect>,
  Hooks,
  Relations extends Readonly<Record<string, object>>,
> = ApprovalDefinitionBase<Dialect> & {
  readonly kind: "thread-store";
  readonly records: ApprovalSqlReferences<
    ApprovalCoreTables<Dialect> & ApprovalTables<Dialect, Inputs>
  >;
  readonly schema: ApprovalCoreTables<Dialect> & ApprovalTables<Dialect, Inputs> & Relations;
  readonly [ApprovalDefinitionState]: {
    readonly createInputs: ApprovalCreateInputs<Inputs, Hooks>;
  };
};

function materializeApprovalInputs<
  Dialect extends ApprovalDialect,
  Inputs extends ApprovalInputs<Dialect>,
>(dialect: Dialect, inputs: Inputs): ApprovalTables<Dialect, Inputs> {
  const tables = Object.fromEntries(
    Object.entries(inputs).map(([key, input]) => [
      key,
      input.kind === "table"
        ? input
        : {
            kind: "table",
            dialect,
            name: input.tableName,
            columns: input.fields,
            primaryKey: input.primaryKey,
          },
    ]),
  );

  // SAFETY: Direct tables are retained. Lower-tier Records copy every field and
  // primary-key member into one table of the requested dialect.
  return tables as ApprovalTables<Dialect, Inputs>;
}

function defineApprovalThreadStore<
  const Dialect extends ApprovalDialect,
  const Inputs extends ApprovalInputs<Dialect>,
  const Hooks extends ApprovalHooks<Inputs>,
  const Relations extends Readonly<Record<string, object>>,
>(options: {
  readonly dialect: Dialect;
  readonly schemas: ApprovalSchemaGenerators<ApprovalInputTable<Dialect, Inputs[keyof Inputs]>>;
  readonly records: Inputs;
  readonly hooks: Hooks;
  readonly relations: (
    tables: ApprovalCoreTables<Dialect> & ApprovalTables<Dialect, Inputs>,
  ) => Relations;
}): ApprovalDefinition<Dialect, Inputs, Hooks, Relations> {
  const coreTables = makeApprovalCoreTables(options.dialect);
  const inputTables = materializeApprovalInputs(options.dialect, options.records);
  const tables = { ...coreTables, ...inputTables };
  const relations = options.relations(tables);
  const references = Object.fromEntries(
    Object.entries(tables).map(([key, table]) => [
      key,
      {
        table,
        sql: (field?: string) => (field === undefined ? key : `${key}.${field}`),
      },
    ]),
  );

  // SAFETY: The returned maps come from the exact Core and input keys. Relations
  // receive that complete table map, and hidden create inputs are type-only state.
  return {
    dialect: options.dialect,
    kind: "thread-store",
    records: references,
    schema: { ...tables, ...relations },
    inputKinds: Object.values(options.records).map((input) =>
      input.kind === "table" ? "direct-table" : "lower-tier-record",
    ),
    [ApprovalDefinitionState]: { createInputs: {} },
  } as unknown as ApprovalDefinition<Dialect, Inputs, Hooks, Relations>;
}

function makeApprovalAuditTable<Dialect extends ApprovalDialect>(dialect: Dialect) {
  return defineApprovalTable({
    dialect,
    name: "audit_logs",
    columns: {
      id: approvalTextField("id"),
      actorId: approvalTextField("actor_id"),
      action: approvalTextField("action"),
    },
    primaryKey: ["id"],
  });
}

function makeApprovalDefinition<Dialect extends ApprovalDialect>(
  dialect: Dialect,
  schemas: typeof approvalZodGenerators | typeof approvalValibotGenerators,
) {
  const auditLog = makeApprovalAuditTable(dialect);
  return defineApprovalThreadStore({
    dialect,
    schemas,
    records: { scheduledJob: ScheduledJob, auditLog },
    hooks: {
      scheduledJob: {
        beforeCreate: () => ({ tenantId: "tenant-from-hook" }),
      },
    },
    relations: (tables) => ({
      scheduledJobRelations: {
        source: tables.scheduledJob,
        target: tables.thread,
      },
    }),
  });
}

const approvalPostgresDefinition = makeApprovalDefinition("postgres", approvalZodGenerators);
const approvalMysqlDefinition = makeApprovalDefinition("mysql", approvalValibotGenerators);
const approvalSqliteDefinition = makeApprovalDefinition("sqlite", approvalZodGenerators);

export const {
  thread: approvalPostgresThread,
  scheduledJob: approvalPostgresScheduledJob,
  auditLog: approvalPostgresAuditLog,
  scheduledJobRelations: approvalPostgresScheduledJobRelations,
} = approvalPostgresDefinition.schema;
export const {
  thread: approvalMysqlThread,
  scheduledJob: approvalMysqlScheduledJob,
  auditLog: approvalMysqlAuditLog,
  scheduledJobRelations: approvalMysqlScheduledJobRelations,
} = approvalMysqlDefinition.schema;
export const {
  thread: approvalSqliteThread,
  scheduledJob: approvalSqliteScheduledJob,
  auditLog: approvalSqliteAuditLog,
  scheduledJobRelations: approvalSqliteScheduledJobRelations,
} = approvalSqliteDefinition.schema;

type ApprovalDefinitionCreateInputs<Definition extends ApprovalDefinitionBase<ApprovalDialect>> =
  Definition[typeof ApprovalDefinitionState]["createInputs"];
type ApprovalDefinitionDialect<Definition extends ApprovalDefinitionBase<ApprovalDialect>> =
  Definition["dialect"];

interface ApprovalSqlCommandResult<out DriverResult> {
  readonly affectedRows: number | undefined;
  readonly driverResult: DriverResult;
}

type ApprovalSqlStore<Definition extends ApprovalDefinitionBase<ApprovalDialect>, DriverResult> = {
  readonly collections: {
    readonly [Name in keyof ApprovalDefinitionCreateInputs<Definition>]: {
      readonly create: (
        input: ApprovalDefinitionCreateInputs<Definition>[Name],
      ) => Promise<Readonly<Record<string, ApprovalJson>>>;
    };
  };
  readonly query: <Row = unknown>(statement: object) => Promise<readonly Row[]>;
  readonly execute: (statement: object) => Promise<ApprovalSqlCommandResult<DriverResult>>;
  readonly records: Definition["records"];
  readonly schema: Definition["schema"];
};

type ApprovalTransactionStore<
  Definition extends ApprovalDefinitionBase<ApprovalDialect>,
  DriverResult,
> = ApprovalSqlStore<Definition, DriverResult> & {
  readonly transaction: <Value>(
    use: (transaction: ApprovalSqlStore<Definition, DriverResult>) => Promise<Value>,
  ) => Promise<Value>;
};

interface ApprovalDatabase<Dialect extends ApprovalDialect, DriverResult> {
  readonly dialect: Dialect;
  readonly execute: (statement: object) => Promise<DriverResult>;
}

type ApprovalPostgresResult = { readonly rowCount: number; readonly command: string };
type ApprovalMysqlResult = readonly [{ readonly affectedRows: number }, readonly object[]];
type ApprovalSqliteResult = { readonly changes: number; readonly lastInsertRowid: bigint };

declare const approvalPostgresDatabase: ApprovalDatabase<"postgres", ApprovalPostgresResult>;
declare const approvalMysqlDatabase: ApprovalDatabase<"mysql", ApprovalMysqlResult>;
declare const approvalSqliteDatabase: ApprovalDatabase<"sqlite", ApprovalSqliteResult>;

declare function bindApprovalPostgresStore<
  const Definition extends ApprovalDefinitionBase<"postgres">,
  DriverResult,
>(options: {
  readonly definition: Definition;
  readonly database: ApprovalDatabase<"postgres", DriverResult>;
  readonly transaction: true;
}): Promise<ApprovalTransactionStore<Definition, DriverResult>>;
declare function bindApprovalPostgresStore<
  const Definition extends ApprovalDefinitionBase<"postgres">,
  DriverResult,
>(options: {
  readonly definition: Definition;
  readonly database: ApprovalDatabase<"postgres", DriverResult>;
  readonly transaction?: false;
}): Promise<ApprovalSqlStore<Definition, DriverResult>>;

declare function bindApprovalMysqlStore<
  const Definition extends ApprovalDefinitionBase<"mysql">,
  DriverResult,
>(options: {
  readonly definition: Definition;
  readonly database: ApprovalDatabase<"mysql", DriverResult>;
  readonly transaction: true;
}): Promise<ApprovalTransactionStore<Definition, DriverResult>>;
declare function bindApprovalMysqlStore<
  const Definition extends ApprovalDefinitionBase<"mysql">,
  DriverResult,
>(options: {
  readonly definition: Definition;
  readonly database: ApprovalDatabase<"mysql", DriverResult>;
  readonly transaction?: false;
}): Promise<ApprovalSqlStore<Definition, DriverResult>>;

declare function bindApprovalSqliteStore<
  const Definition extends ApprovalDefinitionBase<"sqlite">,
  DriverResult,
>(options: {
  readonly definition: Definition;
  readonly database: ApprovalDatabase<"sqlite", DriverResult>;
  readonly transaction: true;
}): Promise<ApprovalTransactionStore<Definition, DriverResult>>;
declare function bindApprovalSqliteStore<
  const Definition extends ApprovalDefinitionBase<"sqlite">,
  DriverResult,
>(options: {
  readonly definition: Definition;
  readonly database: ApprovalDatabase<"sqlite", DriverResult>;
  readonly transaction?: false;
}): Promise<ApprovalSqlStore<Definition, DriverResult>>;

declare function createApprovalThreadStore<
  const Definition extends ApprovalDefinitionBase<ApprovalDialect> & {
    readonly kind: "thread-store";
  },
  DriverResult,
>(options: {
  readonly backend:
    | ApprovalSqlStore<Definition, DriverResult>
    | ApprovalTransactionStore<Definition, DriverResult>;
}): {
  readonly createThread: () => Promise<{ readonly id: string }>;
  readonly schema: Definition["schema"];
};

type ApprovalExact<Expected, Actual> =
  (<Probe>() => Probe extends Expected ? 1 : 2) extends <Probe>() => Probe extends Actual ? 1 : 2
    ? (<Probe>() => Probe extends Actual ? 1 : 2) extends <Probe>() => Probe extends Expected
        ? 1
        : 2
      ? true
      : false
    : false;

declare function expectApprovalExactType<Expected>(): <Actual>(
  value: Actual & (ApprovalExact<Expected, Actual> extends true ? unknown : never),
) => void;

async function completeSpecificationContractChecks(): Promise<void> {
  expectApprovalExactType<"commissary_threads">()(approvalPostgresDefinition.schema.thread.name);
  expectApprovalExactType<readonly ["runId", "toolCallId"]>()(
    approvalPostgresDefinition.schema.toolCall.primaryKey,
  );
  expectApprovalExactType<typeof ScheduledJob.fields>()(
    approvalPostgresDefinition.schema.scheduledJob.columns,
  );
  expectApprovalExactType<typeof approvalPostgresDefinition.schema.auditLog>()(
    approvalPostgresAuditLog,
  );

  const postgresStore = await bindApprovalPostgresStore({
    definition: approvalPostgresDefinition,
    database: approvalPostgresDatabase,
  });
  await postgresStore.collections.scheduledJob.create({
    id: "job-1",
    queue: "default",
    runAt: 1,
  });
  // @ts-expect-error The hook does not make the unrelated queue field optional.
  await postgresStore.collections.scheduledJob.create({ id: "job-1", runAt: 1 });
  expectApprovalExactType<ApprovalPostgresResult>()(
    (await postgresStore.execute(approvalPostgresDefinition.records.scheduledJob)).driverResult,
  );
  await postgresStore.query(approvalPostgresDefinition.records.scheduledJob);
  createApprovalThreadStore({ backend: postgresStore });

  const postgresTransactionStore = await bindApprovalPostgresStore({
    definition: approvalPostgresDefinition,
    database: approvalPostgresDatabase,
    transaction: true,
  });
  await postgresTransactionStore.transaction(async (transaction) => {
    await transaction.collections.scheduledJob.create({
      id: "job-2",
      queue: "default",
      runAt: 2,
    });
    // @ts-expect-error Transaction binding keeps unrelated required fields required.
    await transaction.collections.scheduledJob.create({ id: "job-2", runAt: 2 });
  });
  createApprovalThreadStore({ backend: postgresTransactionStore });

  const mysqlStore = await bindApprovalMysqlStore({
    definition: approvalMysqlDefinition,
    database: approvalMysqlDatabase,
  });
  expectApprovalExactType<ApprovalMysqlResult>()(
    (await mysqlStore.execute(approvalMysqlDefinition.records.scheduledJob)).driverResult,
  );
  createApprovalThreadStore({ backend: mysqlStore });
  const mysqlTransactionStore = await bindApprovalMysqlStore({
    definition: approvalMysqlDefinition,
    database: approvalMysqlDatabase,
    transaction: true,
  });
  createApprovalThreadStore({ backend: mysqlTransactionStore });

  const sqliteStore = await bindApprovalSqliteStore({
    definition: approvalSqliteDefinition,
    database: approvalSqliteDatabase,
  });
  expectApprovalExactType<ApprovalSqliteResult>()(
    (await sqliteStore.execute(approvalSqliteDefinition.records.scheduledJob)).driverResult,
  );
  createApprovalThreadStore({ backend: sqliteStore });
  const sqliteTransactionStore = await bindApprovalSqliteStore({
    definition: approvalSqliteDefinition,
    database: approvalSqliteDatabase,
    transaction: true,
  });
  createApprovalThreadStore({ backend: sqliteTransactionStore });

  expectApprovalExactType<"postgres">()(
    null as unknown as ApprovalDefinitionDialect<typeof approvalPostgresDefinition>,
  );
}

void completeSpecificationContractChecks;

function generatedSchemaKeys(
  table: ApprovalTable<ApprovalDialect, string, ApprovalFieldMap, readonly string[]>,
  schema: ApprovalGeneratedObjectSchema<ApprovalFieldMap>,
): readonly string[] {
  const entries = "shape" in schema ? schema.shape : schema.entries;
  const tableKeys = Object.keys(table.columns).sort();
  const schemaKeys = Object.keys(entries).sort();
  if (JSON.stringify(tableKeys) !== JSON.stringify(schemaKeys)) {
    throw new Error("Generated schema keys do not match table keys");
  }
  return schemaKeys;
}

const generatorChecks = [
  generatedSchemaKeys(
    approvalPostgresDefinition.schema.auditLog,
    approvalZodGenerators.select(approvalPostgresDefinition.schema.auditLog),
  ),
  generatedSchemaKeys(
    approvalMysqlDefinition.schema.auditLog,
    approvalValibotGenerators.select(approvalMysqlDefinition.schema.auditLog),
  ),
  generatedSchemaKeys(
    approvalSqliteDefinition.schema.auditLog,
    approvalZodGenerators.select(approvalSqliteDefinition.schema.auditLog),
  ),
];

console.log(
  JSON.stringify({
    coreTables: Object.keys(approvalCoreSqlCatalog).length,
    dialects: [
      approvalPostgresDefinition.dialect,
      approvalMysqlDefinition.dialect,
      approvalSqliteDefinition.dialect,
    ],
    inputKinds: [...new Set(approvalPostgresDefinition.inputKinds)].sort(),
    generatorFamilies: ["drizzle-zod@0.8.3", "drizzle-valibot@0.4.2"],
    generatedFieldCounts: generatorChecks.map((keys) => keys.length),
    directExports: [
      approvalPostgresThread.name,
      approvalMysqlThread.name,
      approvalSqliteThread.name,
    ],
    bindings: ["plain", "transaction"],
    scenarios: [
      "core-thread-store",
      "scheduled-jobs",
      "lower-tier-record-composition",
      "user-authored-drizzle-table",
      "drizzle-kit-direct-exports",
    ],
  }),
);
