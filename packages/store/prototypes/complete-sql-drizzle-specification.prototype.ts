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

type ApprovalCoreUnboundedTextField<ColumnName extends string> = ApprovalField<
  string,
  ColumnName,
  false
> & {
  readonly portable: "text";
};
type ApprovalCoreBoundedTextField<ColumnName extends string> =
  ApprovalCoreUnboundedTextField<ColumnName> & {
    readonly maxCodePoints: 95;
  };
type ApprovalCoreIntegerField<ColumnName extends string> = ApprovalField<
  number,
  ColumnName,
  false
> & {
  readonly portable: "integer";
  readonly minimum: 0;
  readonly maximum: 9_007_199_254_740_991;
};
type ApprovalCoreBooleanField<ColumnName extends string> = ApprovalField<
  boolean,
  ColumnName,
  false
> & {
  readonly portable: "boolean";
};
type ApprovalCoreJsonField<ColumnName extends string> = ApprovalField<
  ApprovalJson,
  ColumnName,
  false
> & {
  readonly portable: "json";
};
type ApprovalCoreField =
  | ApprovalCoreUnboundedTextField<string>
  | ApprovalCoreBoundedTextField<string>
  | ApprovalCoreIntegerField<string>
  | ApprovalCoreBooleanField<string>
  | ApprovalCoreJsonField<string>;

function approvalCoreTextField<const ColumnName extends string>(
  columnName: ColumnName,
): ApprovalCoreUnboundedTextField<ColumnName>;
function approvalCoreTextField<const ColumnName extends string>(
  columnName: ColumnName,
  maxCodePoints: 95,
): ApprovalCoreBoundedTextField<ColumnName>;
function approvalCoreTextField(
  columnName: string,
  maxCodePoints?: 95,
): ApprovalCoreUnboundedTextField<string> | ApprovalCoreBoundedTextField<string> {
  return maxCodePoints === undefined
    ? { columnName, hasDefault: false, selected: "", portable: "text" }
    : { columnName, hasDefault: false, selected: "", portable: "text", maxCodePoints };
}

function approvalCoreIntegerField<const ColumnName extends string>(
  columnName: ColumnName,
): ApprovalCoreIntegerField<ColumnName> {
  return {
    columnName,
    hasDefault: false,
    selected: 0,
    portable: "integer",
    minimum: 0,
    maximum: 9_007_199_254_740_991,
  };
}

function approvalCoreBooleanField<const ColumnName extends string>(
  columnName: ColumnName,
): ApprovalCoreBooleanField<ColumnName> {
  return { columnName, hasDefault: false, selected: false, portable: "boolean" };
}

function approvalCoreJsonField<const ColumnName extends string>(
  columnName: ColumnName,
): ApprovalCoreJsonField<ColumnName> {
  return { columnName, hasDefault: false, selected: null, portable: "json" };
}

const approvalCoreSqlCatalog = Object.freeze({
  thread: {
    table: "commissary_threads",
    fields: {
      id: approvalCoreTextField("id", 95),
    },
    primaryKey: ["id"],
  },
  branch: {
    table: "commissary_branches",
    fields: {
      id: approvalCoreTextField("id", 95),
      threadId: approvalCoreTextField("thread_id"),
      name: approvalCoreTextField("name"),
      head: approvalCoreTextField("head"),
    },
    primaryKey: ["id"],
  },
  message: {
    table: "commissary_messages",
    fields: {
      id: approvalCoreTextField("id", 95),
      threadId: approvalCoreTextField("thread_id"),
      parent: approvalCoreTextField("parent"),
      message: approvalCoreJsonField("message"),
    },
    primaryKey: ["id"],
  },
  run: {
    table: "commissary_runs",
    fields: {
      id: approvalCoreTextField("id", 95),
      threadId: approvalCoreTextField("thread_id"),
      branchId: approvalCoreTextField("branch_id"),
      agent: approvalCoreJsonField("agent"),
      admittedHead: approvalCoreTextField("admitted_head"),
      status: approvalCoreTextField("status"),
      abortRequested: approvalCoreBooleanField("abort_requested"),
      settlementContinuations: approvalCoreIntegerField("settlement_continuations"),
      usage: approvalCoreJsonField("usage"),
      abortReason: approvalCoreJsonField("abort_reason"),
      result: approvalCoreJsonField("result"),
    },
    primaryKey: ["id"],
  },
  toolCall: {
    table: "commissary_tool_calls",
    fields: {
      toolCallId: approvalCoreTextField("tool_call_id", 95),
      runId: approvalCoreTextField("run_id", 95),
      sequence: approvalCoreIntegerField("sequence"),
      toolName: approvalCoreTextField("tool_name"),
      parentToolCallId: approvalCoreTextField("parent_tool_call_id"),
      providerId: approvalCoreTextField("provider_id"),
      delegationKey: approvalCoreTextField("delegation_key"),
      requestedInput: approvalCoreJsonField("requested_input"),
      effectiveInput: approvalCoreJsonField("effective_input"),
      status: approvalCoreTextField("status"),
      result: approvalCoreJsonField("result"),
      suspension: approvalCoreJsonField("suspension"),
      providerData: approvalCoreJsonField("provider_data"),
      historyCommitted: approvalCoreBooleanField("history_committed"),
    },
    primaryKey: ["runId", "toolCallId"],
  },
  executionClaim: {
    table: "commissary_execution_claims",
    fields: {
      runId: approvalCoreTextField("run_id", 95),
      executionId: approvalCoreTextField("execution_id"),
      token: approvalCoreTextField("token"),
      fence: approvalCoreIntegerField("fence"),
      expiresAt: approvalCoreIntegerField("expires_at"),
    },
    primaryKey: ["runId"],
  },
  executionFence: {
    table: "commissary_execution_fences",
    fields: {
      runId: approvalCoreTextField("run_id", 95),
      fence: approvalCoreIntegerField("fence"),
    },
    primaryKey: ["runId"],
  },
  pendingSteering: {
    table: "commissary_pending_steerings",
    fields: {
      runId: approvalCoreTextField("run_id", 95),
      sequence: approvalCoreIntegerField("sequence"),
      message: approvalCoreJsonField("message"),
    },
    primaryKey: ["runId", "sequence"],
  },
  pendingRedirect: {
    table: "commissary_pending_redirects",
    fields: {
      runId: approvalCoreTextField("run_id", 95),
      sequence: approvalCoreIntegerField("sequence"),
      message: approvalCoreJsonField("message"),
    },
    primaryKey: ["runId", "sequence"],
  },
  runCommandSequence: {
    table: "commissary_run_command_sequences",
    fields: {
      runId: approvalCoreTextField("run_id", 95),
      sequence: approvalCoreIntegerField("sequence"),
    },
    primaryKey: ["runId"],
  },
  toolCallSequence: {
    table: "commissary_tool_call_sequences",
    fields: {
      runId: approvalCoreTextField("run_id", 95),
      sequence: approvalCoreIntegerField("sequence"),
    },
    primaryKey: ["runId"],
  },
  runSubmission: {
    table: "commissary_run_submissions",
    fields: {
      runId: approvalCoreTextField("run_id", 95),
      fingerprint: approvalCoreTextField("fingerprint"),
      result: approvalCoreJsonField("result"),
    },
    primaryKey: ["runId"],
  },
  toolResumeRequest: {
    table: "commissary_tool_resume_requests",
    fields: {
      runId: approvalCoreTextField("run_id", 95),
      requestId: approvalCoreTextField("request_id", 95),
      fingerprint: approvalCoreTextField("fingerprint"),
      result: approvalCoreJsonField("result"),
    },
    primaryKey: ["runId", "requestId"],
  },
  steeringRequest: {
    table: "commissary_steering_requests",
    fields: {
      runId: approvalCoreTextField("run_id", 95),
      requestId: approvalCoreTextField("request_id", 95),
      fingerprint: approvalCoreTextField("fingerprint"),
      result: approvalCoreJsonField("result"),
    },
    primaryKey: ["runId", "requestId"],
  },
  redirectRequest: {
    table: "commissary_redirect_requests",
    fields: {
      runId: approvalCoreTextField("run_id", 95),
      requestId: approvalCoreTextField("request_id", 95),
      fingerprint: approvalCoreTextField("fingerprint"),
      result: approvalCoreJsonField("result"),
    },
    primaryKey: ["runId", "requestId"],
  },
  commit: {
    table: "commissary_commits",
    fields: {
      commitId: approvalCoreTextField("commit_id", 95),
      fingerprint: approvalCoreTextField("fingerprint"),
    },
    primaryKey: ["commitId"],
  },
  finalizationOutcome: {
    table: "commissary_finalization_outcomes",
    fields: {
      commitId: approvalCoreTextField("commit_id", 95),
      outcome: approvalCoreJsonField("outcome"),
    },
    primaryKey: ["commitId"],
  },
  modelCommitOutcome: {
    table: "commissary_model_commit_outcomes",
    fields: {
      commitId: approvalCoreTextField("commit_id", 95),
      outcome: approvalCoreJsonField("outcome"),
    },
    primaryKey: ["commitId"],
  },
  settlementOutcome: {
    table: "commissary_settlement_outcomes",
    fields: {
      commitId: approvalCoreTextField("commit_id", 95),
      outcome: approvalCoreJsonField("outcome"),
    },
    primaryKey: ["commitId"],
  },
} as const);

type ApprovalCoreSqlCatalog = typeof approvalCoreSqlCatalog;
type ApprovalCoreTables<Dialect extends ApprovalDialect> = {
  readonly [Name in keyof ApprovalCoreSqlCatalog]: ApprovalTable<
    Dialect,
    ApprovalCoreSqlCatalog[Name]["table"],
    ApprovalCoreSqlCatalog[Name]["fields"],
    ApprovalCoreSqlCatalog[Name]["primaryKey"]
  >;
};

function makeApprovalCoreTable<
  const Dialect extends ApprovalDialect,
  const TableName extends string,
  const Fields extends ApprovalFieldMap,
  const PrimaryKey extends readonly [keyof Fields & string, ...(keyof Fields & string)[]],
>(
  dialect: Dialect,
  catalog: {
    readonly table: TableName;
    readonly fields: Fields;
    readonly primaryKey: PrimaryKey;
  },
): ApprovalTable<Dialect, TableName, Fields, PrimaryKey> {
  return defineApprovalTable({
    dialect,
    name: catalog.table,
    columns: catalog.fields,
    primaryKey: catalog.primaryKey,
  });
}

function makeApprovalCoreTables<Dialect extends ApprovalDialect>(
  dialect: Dialect,
): ApprovalCoreTables<Dialect> {
  return {
    thread: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.thread),
    branch: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.branch),
    message: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.message),
    run: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.run),
    toolCall: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.toolCall),
    executionClaim: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.executionClaim),
    executionFence: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.executionFence),
    pendingSteering: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.pendingSteering),
    pendingRedirect: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.pendingRedirect),
    runCommandSequence: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.runCommandSequence),
    toolCallSequence: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.toolCallSequence),
    runSubmission: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.runSubmission),
    toolResumeRequest: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.toolResumeRequest),
    steeringRequest: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.steeringRequest),
    redirectRequest: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.redirectRequest),
    commit: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.commit),
    finalizationOutcome: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.finalizationOutcome),
    modelCommitOutcome: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.modelCommitOutcome),
    settlementOutcome: makeApprovalCoreTable(dialect, approvalCoreSqlCatalog.settlementOutcome),
  };
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
  readonly schemaGenerators: ApprovalSchemaGenerators<
    ApprovalInputTable<Dialect, Inputs[keyof Inputs]>
  >;
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
  schemaGenerators: typeof approvalZodGenerators | typeof approvalValibotGenerators,
) {
  const auditLog = makeApprovalAuditTable(dialect);
  return defineApprovalThreadStore({
    dialect,
    schemaGenerators,
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

declare function expectApprovalCoreTables<Dialect extends ApprovalDialect>(
  tables: ApprovalCoreTables<Dialect>,
): void;

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
  expectApprovalCoreTables(approvalPostgresDefinition.schema);
  expectApprovalCoreTables(approvalMysqlDefinition.schema);
  expectApprovalCoreTables(approvalSqliteDefinition.schema);
  expectApprovalExactType<typeof approvalCoreSqlCatalog.toolCall.fields>()(
    approvalPostgresDefinition.schema.toolCall.columns,
  );
  expectApprovalExactType<95>()(
    approvalMysqlDefinition.schema.toolCall.columns.runId.maxCodePoints,
  );
  expectApprovalExactType<"integer">()(
    approvalSqliteDefinition.schema.pendingSteering.columns.sequence.portable,
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

const approvalExpectedCoreCatalogSignatures = [
  "thread|commissary_threads|id|id=id:text:max95",
  "branch|commissary_branches|id|id=id:text:max95,threadId=thread_id:text,name=name:text,head=head:text",
  "message|commissary_messages|id|id=id:text:max95,threadId=thread_id:text,parent=parent:text,message=message:json",
  "run|commissary_runs|id|id=id:text:max95,threadId=thread_id:text,branchId=branch_id:text,agent=agent:json,admittedHead=admitted_head:text,status=status:text,abortRequested=abort_requested:boolean,settlementContinuations=settlement_continuations:integer:safe-nonnegative,usage=usage:json,abortReason=abort_reason:json,result=result:json",
  "toolCall|commissary_tool_calls|runId,toolCallId|toolCallId=tool_call_id:text:max95,runId=run_id:text:max95,sequence=sequence:integer:safe-nonnegative,toolName=tool_name:text,parentToolCallId=parent_tool_call_id:text,providerId=provider_id:text,delegationKey=delegation_key:text,requestedInput=requested_input:json,effectiveInput=effective_input:json,status=status:text,result=result:json,suspension=suspension:json,providerData=provider_data:json,historyCommitted=history_committed:boolean",
  "executionClaim|commissary_execution_claims|runId|runId=run_id:text:max95,executionId=execution_id:text,token=token:text,fence=fence:integer:safe-nonnegative,expiresAt=expires_at:integer:safe-nonnegative",
  "executionFence|commissary_execution_fences|runId|runId=run_id:text:max95,fence=fence:integer:safe-nonnegative",
  "pendingSteering|commissary_pending_steerings|runId,sequence|runId=run_id:text:max95,sequence=sequence:integer:safe-nonnegative,message=message:json",
  "pendingRedirect|commissary_pending_redirects|runId,sequence|runId=run_id:text:max95,sequence=sequence:integer:safe-nonnegative,message=message:json",
  "runCommandSequence|commissary_run_command_sequences|runId|runId=run_id:text:max95,sequence=sequence:integer:safe-nonnegative",
  "toolCallSequence|commissary_tool_call_sequences|runId|runId=run_id:text:max95,sequence=sequence:integer:safe-nonnegative",
  "runSubmission|commissary_run_submissions|runId|runId=run_id:text:max95,fingerprint=fingerprint:text,result=result:json",
  "toolResumeRequest|commissary_tool_resume_requests|runId,requestId|runId=run_id:text:max95,requestId=request_id:text:max95,fingerprint=fingerprint:text,result=result:json",
  "steeringRequest|commissary_steering_requests|runId,requestId|runId=run_id:text:max95,requestId=request_id:text:max95,fingerprint=fingerprint:text,result=result:json",
  "redirectRequest|commissary_redirect_requests|runId,requestId|runId=run_id:text:max95,requestId=request_id:text:max95,fingerprint=fingerprint:text,result=result:json",
  "commit|commissary_commits|commitId|commitId=commit_id:text:max95,fingerprint=fingerprint:text",
  "finalizationOutcome|commissary_finalization_outcomes|commitId|commitId=commit_id:text:max95,outcome=outcome:json",
  "modelCommitOutcome|commissary_model_commit_outcomes|commitId|commitId=commit_id:text:max95,outcome=outcome:json",
  "settlementOutcome|commissary_settlement_outcomes|commitId|commitId=commit_id:text:max95,outcome=outcome:json",
] as const;

function approvalCoreFieldSignature(field: ApprovalCoreField): string {
  if (field.portable === "integer") {
    if (
      field.minimum !== 0 ||
      field.maximum !== Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(field.maximum)
    ) {
      throw new Error("Core integer field does not use the nonnegative safe-integer contract");
    }
    return `${field.columnName}:integer:safe-nonnegative`;
  }

  if (field.portable === "text" && "maxCodePoints" in field) {
    if (field.maxCodePoints !== 95) {
      throw new Error("Core bounded text field does not use the 95-code-point limit");
    }
    return `${field.columnName}:text:max95`;
  }

  return `${field.columnName}:${field.portable}`;
}

function approvalCoreRecordSignature(
  recordName: string,
  catalog: {
    readonly table: string;
    readonly fields: Readonly<Record<string, ApprovalCoreField>>;
    readonly primaryKey: readonly string[];
  },
): { readonly fieldCount: number; readonly signature: string } {
  const fieldEntries = Object.entries(catalog.fields);
  const physicalNames = new Set(fieldEntries.map(([, field]) => field.columnName));
  if (physicalNames.size !== fieldEntries.length) {
    throw new Error("Core Record has duplicate physical column names");
  }

  if (catalog.primaryKey.length === 0) {
    throw new Error("Core Record has an empty primary key");
  }
  for (const key of catalog.primaryKey) {
    if (!Object.hasOwn(catalog.fields, key)) {
      throw new Error("Core primary key names an unknown field");
    }
    const field = catalog.fields[key];
    if (field === undefined) {
      throw new Error("Core primary-key field is missing");
    }
    if (field.portable === "text" && !("maxCodePoints" in field)) {
      throw new Error("Core string primary-key field has no code-point limit");
    }
    if (field.portable !== "text" && field.portable !== "integer") {
      throw new Error("Core primary-key field does not use a portable key type");
    }
  }

  const fields = fieldEntries
    .map(([fieldName, field]) => `${fieldName}=${approvalCoreFieldSignature(field)}`)
    .join(",");
  return {
    fieldCount: fieldEntries.length,
    signature: `${recordName}|${catalog.table}|${catalog.primaryKey.join(",")}|${fields}`,
  };
}

function validateApprovalCoreSqlCatalog(): {
  readonly fieldCount: number;
  readonly portableMappings: readonly string[];
  readonly recordCount: number;
  readonly stringKeyMaxCodePoints: 95;
} {
  let fieldCount = 0;
  const signatures = Object.entries(approvalCoreSqlCatalog).map(([recordName, catalog]) => {
    const result = approvalCoreRecordSignature(recordName, catalog);
    fieldCount += result.fieldCount;
    return result.signature;
  });

  if (JSON.stringify(signatures) !== JSON.stringify(approvalExpectedCoreCatalogSignatures)) {
    throw new Error("Core SQL catalog does not match the complete approved catalog");
  }
  if (fieldCount !== 74) {
    throw new Error("Core SQL catalog does not contain all 74 fields");
  }

  return {
    fieldCount,
    portableMappings: ["text", "integer", "boolean", "json"],
    recordCount: signatures.length,
    stringKeyMaxCodePoints: 95,
  };
}

const approvalCoreCatalogCheck = validateApprovalCoreSqlCatalog();

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
    coreTables: approvalCoreCatalogCheck.recordCount,
    coreFields: approvalCoreCatalogCheck.fieldCount,
    coreStringKeyMaxCodePoints: approvalCoreCatalogCheck.stringKeyMaxCodePoints,
    corePortableMappings: approvalCoreCatalogCheck.portableMappings,
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
