/*
 * Compile-tested package-interface prototype for issue #15.
 *
 * Small local Drizzle and Store stand-ins test package entry points, definition
 * inference, common database types, driver results, and transaction narrowing
 * without adding a production Drizzle dependency.
 */

type PrototypeDialect = "postgres" | "mysql" | "sqlite";
type PrototypeResultKind = "sync" | "async";
type PrototypeRow = Readonly<Record<string, unknown>>;
type PrototypeSchemaMap = Readonly<Record<string, object>>;

type PrototypeTable<
  Dialect extends PrototypeDialect,
  Name extends string,
  Row extends PrototypeRow,
> = {
  readonly dialect: Dialect;
  readonly name: Name;
  readonly selectedRow: Row;
};

type PrototypeRelation<Table extends object> = {
  readonly table: Table;
  readonly relationNames: readonly string[];
};

type PrototypeRecordReference<Table extends object> = {
  readonly table: Table;
};

type PrototypeRecordReferences<Tables extends PrototypeSchemaMap> = {
  readonly [Name in keyof Tables]: PrototypeRecordReference<Tables[Name]>;
};

interface PrototypeStandardSchema<Input, Output> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
  };
  readonly input: Input;
  readonly output: Output;
}

interface DrizzleSchemaGenerators<
  Table,
  SelectSchema extends PrototypeStandardSchema<unknown, unknown>,
  InsertSchema extends PrototypeStandardSchema<unknown, unknown>,
  UpdateSchema extends PrototypeStandardSchema<unknown, unknown>,
> {
  readonly select: (table: Table) => SelectSchema;
  readonly insert: (table: Table) => InsertSchema;
  readonly update: (table: Table) => UpdateSchema;
}

const DrizzleStoreDefinitionState: unique symbol = Symbol("DrizzleStoreDefinitionState");

interface DrizzleStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends PrototypeSchemaMap,
> {
  readonly records: Records;
  readonly schema: Schema;
  readonly [DrizzleStoreDefinitionState]: unknown;
}

interface DrizzlePostgresStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends PrototypeSchemaMap,
> extends DrizzleStoreDefinition<Records, Schema> {
  readonly [DrizzleStoreDefinitionState]: {
    readonly dialect: "postgres";
    readonly kind: "store";
  };
}

interface DrizzlePostgresThreadStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends PrototypeSchemaMap,
> extends DrizzleStoreDefinition<Records, Schema> {
  readonly [DrizzleStoreDefinitionState]: {
    readonly dialect: "postgres";
    readonly kind: "thread-store";
  };
}

interface DrizzleMysqlStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends PrototypeSchemaMap,
> extends DrizzleStoreDefinition<Records, Schema> {
  readonly [DrizzleStoreDefinitionState]: {
    readonly dialect: "mysql";
    readonly kind: "store";
  };
}

interface DrizzleMysqlThreadStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends PrototypeSchemaMap,
> extends DrizzleStoreDefinition<Records, Schema> {
  readonly [DrizzleStoreDefinitionState]: {
    readonly dialect: "mysql";
    readonly kind: "thread-store";
  };
}

interface DrizzleSqliteStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends PrototypeSchemaMap,
> extends DrizzleStoreDefinition<Records, Schema> {
  readonly [DrizzleStoreDefinitionState]: {
    readonly dialect: "sqlite";
    readonly kind: "store";
  };
}

interface DrizzleSqliteThreadStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends PrototypeSchemaMap,
> extends DrizzleStoreDefinition<Records, Schema> {
  readonly [DrizzleStoreDefinitionState]: {
    readonly dialect: "sqlite";
    readonly kind: "thread-store";
  };
}

type PrototypeDialectTable<Dialect extends PrototypeDialect> = PrototypeTable<
  Dialect,
  string,
  PrototypeRow
>;

type PrototypeDialectTables<Dialect extends PrototypeDialect> = Readonly<
  Record<string, PrototypeDialectTable<Dialect>>
>;

type PrototypeRelations = Readonly<Record<string, PrototypeRelation<object>>>;

type PrototypeDefinitionSchema<
  Tables extends PrototypeSchemaMap,
  Relations extends PrototypeRelations,
> = Readonly<Tables & Relations>;

interface PrototypeDefineOptions<
  Tables extends PrototypeSchemaMap,
  Relations extends PrototypeRelations,
> {
  readonly schemas?: DrizzleSchemaGenerators<
    Tables[keyof Tables],
    PrototypeStandardSchema<unknown, unknown>,
    PrototypeStandardSchema<unknown, unknown>,
    PrototypeStandardSchema<unknown, unknown>
  >;
  readonly records: Tables;
  readonly relations?: (tables: Tables) => Relations;
}

type PrototypeCoreTables<Dialect extends PrototypeDialect> = {
  readonly thread: PrototypeTable<Dialect, "commissary_threads", { readonly id: string }>;
  readonly run: PrototypeTable<
    Dialect,
    "commissary_runs",
    { readonly id: string; readonly threadId: string }
  >;
};
type PrototypeThreadDefineOptions<
  Dialect extends PrototypeDialect,
  Tables extends PrototypeDialectTables<Dialect>,
  Relations extends PrototypeRelations,
> = Omit<PrototypeDefineOptions<Tables, Relations>, "relations"> & {
  readonly relations?: (tables: PrototypeCoreTables<Dialect> & Tables) => Relations;
};

interface DrizzlePostgresStoreFactory {
  readonly define: <
    const Tables extends PrototypeDialectTables<"postgres">,
    const Relations extends PrototypeRelations = {},
  >(
    options: PrototypeDefineOptions<Tables, Relations>,
  ) => DrizzlePostgresStoreDefinition<
    PrototypeRecordReferences<Tables>,
    PrototypeDefinitionSchema<Tables, Relations>
  >;
}

interface DrizzlePostgresThreadStoreFactory {
  readonly define: <
    const Tables extends PrototypeDialectTables<"postgres">,
    const Relations extends PrototypeRelations = {},
  >(
    options: PrototypeThreadDefineOptions<"postgres", Tables, Relations>,
  ) => DrizzlePostgresThreadStoreDefinition<
    PrototypeRecordReferences<PrototypeCoreTables<"postgres"> & Tables>,
    PrototypeDefinitionSchema<PrototypeCoreTables<"postgres"> & Tables, Relations>
  >;
}

interface DrizzleMysqlStoreFactory {
  readonly define: <
    const Tables extends PrototypeDialectTables<"mysql">,
    const Relations extends PrototypeRelations = {},
  >(
    options: PrototypeDefineOptions<Tables, Relations>,
  ) => DrizzleMysqlStoreDefinition<
    PrototypeRecordReferences<Tables>,
    PrototypeDefinitionSchema<Tables, Relations>
  >;
}

interface DrizzleMysqlThreadStoreFactory {
  readonly define: <
    const Tables extends PrototypeDialectTables<"mysql">,
    const Relations extends PrototypeRelations = {},
  >(
    options: PrototypeThreadDefineOptions<"mysql", Tables, Relations>,
  ) => DrizzleMysqlThreadStoreDefinition<
    PrototypeRecordReferences<PrototypeCoreTables<"mysql"> & Tables>,
    PrototypeDefinitionSchema<PrototypeCoreTables<"mysql"> & Tables, Relations>
  >;
}

interface DrizzleSqliteStoreFactory {
  readonly define: <
    const Tables extends PrototypeDialectTables<"sqlite">,
    const Relations extends PrototypeRelations = {},
  >(
    options: PrototypeDefineOptions<Tables, Relations>,
  ) => DrizzleSqliteStoreDefinition<
    PrototypeRecordReferences<Tables>,
    PrototypeDefinitionSchema<Tables, Relations>
  >;
}

interface DrizzleSqliteThreadStoreFactory {
  readonly define: <
    const Tables extends PrototypeDialectTables<"sqlite">,
    const Relations extends PrototypeRelations = {},
  >(
    options: PrototypeThreadDefineOptions<"sqlite", Tables, Relations>,
  ) => DrizzleSqliteThreadStoreDefinition<
    PrototypeRecordReferences<PrototypeCoreTables<"sqlite"> & Tables>,
    PrototypeDefinitionSchema<PrototypeCoreTables<"sqlite"> & Tables, Relations>
  >;
}

declare const DrizzlePostgresStore: DrizzlePostgresStoreFactory;
declare const DrizzlePostgresThreadStore: DrizzlePostgresThreadStoreFactory;
declare const DrizzleMysqlStore: DrizzleMysqlStoreFactory;
declare const DrizzleMysqlThreadStore: DrizzleMysqlThreadStoreFactory;
declare const DrizzleSqliteStore: DrizzleSqliteStoreFactory;
declare const DrizzleSqliteThreadStore: DrizzleSqliteThreadStoreFactory;
declare const PrototypeDatabaseKind: unique symbol;

interface PgDatabase<DriverResult> {
  readonly [PrototypeDatabaseKind]: "postgres";
  readonly execute: (statement: object) => PromiseLike<DriverResult>;
  readonly transaction: <Value>(
    use: (transaction: PgDatabase<DriverResult>) => Promise<Value>,
  ) => Promise<Value>;
}

interface MySqlDatabase<DriverResult> {
  readonly [PrototypeDatabaseKind]: "mysql";
  readonly execute: (statement: object) => Promise<DriverResult>;
  readonly transaction: <Value>(
    use: (transaction: MySqlDatabase<DriverResult>) => Promise<Value>,
  ) => Promise<Value>;
}

interface BaseSQLiteDatabase<
  ResultKind extends PrototypeResultKind,
  RunResult,
  FullSchema extends PrototypeSchemaMap,
> {
  readonly [PrototypeDatabaseKind]: "sqlite";
  readonly resultKind: ResultKind;
  readonly schema: FullSchema;
  readonly all: <Row extends PrototypeRow>(
    statement: object,
  ) => ResultKind extends "sync" ? readonly Row[] : Promise<readonly Row[]>;
  readonly run: (statement: object) => ResultKind extends "sync" ? RunResult : Promise<RunResult>;
  readonly transaction: <Value>(
    use: (
      transaction: BaseSQLiteDatabase<ResultKind, RunResult, FullSchema>,
    ) => Value | Promise<Value>,
  ) => ResultKind extends "sync" ? Value : Promise<Value>;
}

type AnyDrizzleStoreDefinition = DrizzleStoreDefinition<
  Readonly<Record<string, object>>,
  PrototypeSchemaMap
>;

declare const PrototypeBoundDefinition: unique symbol;

type PrototypeDefinitionRecords<Definition extends AnyDrizzleStoreDefinition> =
  Definition["records"];

type PrototypeDefinitionSchemaValue<Definition extends AnyDrizzleStoreDefinition> =
  Definition["schema"];

interface PrototypeSqlCommandResult<out DriverResult> {
  readonly affectedRows: number | undefined;
  readonly driverResult: DriverResult;
}

interface PrototypeSqlStore<Definition extends AnyDrizzleStoreDefinition, DriverResult> {
  readonly collections: {
    readonly [Name in keyof PrototypeDefinitionRecords<Definition>]: {
      readonly count: () => Promise<number>;
    };
  };
  readonly query: <Row = unknown>(statement: object) => Promise<readonly Row[]>;
  readonly execute: (statement: object) => Promise<PrototypeSqlCommandResult<DriverResult>>;
  readonly schema: PrototypeDefinitionSchemaValue<Definition>;
  readonly [PrototypeBoundDefinition]: Definition;
}

type PrototypeTransactionStore<
  Definition extends AnyDrizzleStoreDefinition,
  DriverResult,
> = PrototypeSqlStore<Definition, DriverResult> & {
  readonly transaction: <Value>(
    use: (transaction: PrototypeSqlStore<Definition, DriverResult>) => Promise<Value>,
  ) => Promise<Value>;
};

type PrototypePossibleTransactionStore<
  Definition extends AnyDrizzleStoreDefinition,
  DriverResult,
> =
  | PrototypeSqlStore<Definition, DriverResult>
  | PrototypeTransactionStore<Definition, DriverResult>;

type AnyPostgresDefinition =
  | DrizzlePostgresStoreDefinition<Readonly<Record<string, object>>, PrototypeSchemaMap>
  | DrizzlePostgresThreadStoreDefinition<Readonly<Record<string, object>>, PrototypeSchemaMap>;

type AnyMysqlDefinition =
  | DrizzleMysqlStoreDefinition<Readonly<Record<string, object>>, PrototypeSchemaMap>
  | DrizzleMysqlThreadStoreDefinition<Readonly<Record<string, object>>, PrototypeSchemaMap>;

type AnySqliteDefinition =
  | DrizzleSqliteStoreDefinition<Readonly<Record<string, object>>, PrototypeSchemaMap>
  | DrizzleSqliteThreadStoreDefinition<Readonly<Record<string, object>>, PrototypeSchemaMap>;

type PrototypePostgresDriverResult<Database extends PgDatabase<unknown>> = Awaited<
  ReturnType<Database["execute"]>
>;

type PrototypeMysqlDriverResult<Database extends MySqlDatabase<unknown>> = Awaited<
  ReturnType<Database["execute"]>
>;

declare function bindPostgresStore<
  const Definition extends AnyPostgresDefinition,
  const Database extends PgDatabase<unknown>,
>(options: {
  readonly definition: Definition;
  readonly database: Database;
  readonly transaction: true;
}): Promise<PrototypeTransactionStore<Definition, PrototypePostgresDriverResult<Database>>>;

declare function bindPostgresStore<
  const Definition extends AnyPostgresDefinition,
  const Database extends PgDatabase<unknown>,
>(options: {
  readonly definition: Definition;
  readonly database: Database;
  readonly transaction?: false;
}): Promise<PrototypeSqlStore<Definition, PrototypePostgresDriverResult<Database>>>;

declare function bindPostgresStore<
  const Definition extends AnyPostgresDefinition,
  const Database extends PgDatabase<unknown>,
>(options: {
  readonly definition: Definition;
  readonly database: Database;
  readonly transaction: boolean;
}): Promise<PrototypePossibleTransactionStore<Definition, PrototypePostgresDriverResult<Database>>>;

declare function bindMysqlStore<
  const Definition extends AnyMysqlDefinition,
  const Database extends MySqlDatabase<unknown>,
>(options: {
  readonly definition: Definition;
  readonly database: Database;
  readonly transaction: true;
}): Promise<PrototypeTransactionStore<Definition, PrototypeMysqlDriverResult<Database>>>;

declare function bindMysqlStore<
  const Definition extends AnyMysqlDefinition,
  const Database extends MySqlDatabase<unknown>,
>(options: {
  readonly definition: Definition;
  readonly database: Database;
  readonly transaction?: false;
}): Promise<PrototypeSqlStore<Definition, PrototypeMysqlDriverResult<Database>>>;

declare function bindMysqlStore<
  const Definition extends AnyMysqlDefinition,
  const Database extends MySqlDatabase<unknown>,
>(options: {
  readonly definition: Definition;
  readonly database: Database;
  readonly transaction: boolean;
}): Promise<PrototypePossibleTransactionStore<Definition, PrototypeMysqlDriverResult<Database>>>;

declare function bindSqliteStore<
  const Definition extends AnySqliteDefinition,
  ResultKind extends PrototypeResultKind,
  RunResult,
  FullSchema extends PrototypeSchemaMap,
>(options: {
  readonly definition: Definition;
  readonly database: BaseSQLiteDatabase<ResultKind, RunResult, FullSchema>;
  readonly transaction: true;
}): Promise<PrototypeTransactionStore<Definition, RunResult>>;

declare function bindSqliteStore<
  const Definition extends AnySqliteDefinition,
  ResultKind extends PrototypeResultKind,
  RunResult,
  FullSchema extends PrototypeSchemaMap,
>(options: {
  readonly definition: Definition;
  readonly database: BaseSQLiteDatabase<ResultKind, RunResult, FullSchema>;
  readonly transaction?: false;
}): Promise<PrototypeSqlStore<Definition, RunResult>>;

declare function bindSqliteStore<
  const Definition extends AnySqliteDefinition,
  ResultKind extends PrototypeResultKind,
  RunResult,
  FullSchema extends PrototypeSchemaMap,
>(options: {
  readonly definition: Definition;
  readonly database: BaseSQLiteDatabase<ResultKind, RunResult, FullSchema>;
  readonly transaction: boolean;
}): Promise<PrototypePossibleTransactionStore<Definition, RunResult>>;

type AnyThreadDefinition =
  | DrizzlePostgresThreadStoreDefinition<Readonly<Record<string, object>>, PrototypeSchemaMap>
  | DrizzleMysqlThreadStoreDefinition<Readonly<Record<string, object>>, PrototypeSchemaMap>
  | DrizzleSqliteThreadStoreDefinition<Readonly<Record<string, object>>, PrototypeSchemaMap>;

interface PrototypeThreadStore<Definition extends AnyThreadDefinition> {
  readonly schema: PrototypeDefinitionSchemaValue<Definition>;
  readonly createThread: () => Promise<{ readonly id: string }>;
}

declare function createThreadStore<
  const Definition extends AnyThreadDefinition,
  DriverResult,
>(options: {
  readonly backend:
    | PrototypeSqlStore<Definition, DriverResult>
    | PrototypeTransactionStore<Definition, DriverResult>;
}): PrototypeThreadStore<Definition>;

declare const postgresJobTable: PrototypeTable<
  "postgres",
  "jobs",
  { readonly id: string; readonly state: "ready" | "done" }
>;
declare const postgresJobRelations: PrototypeRelation<typeof postgresJobTable>;
declare const mysqlJobTable: PrototypeTable<
  "mysql",
  "jobs",
  { readonly id: string; readonly state: "ready" | "done" }
>;
declare const sqliteJobTable: PrototypeTable<
  "sqlite",
  "jobs",
  { readonly id: string; readonly state: "ready" | "done" }
>;

type PrototypePostgresResult = {
  readonly rowCount: number;
  readonly command: string;
};
type PrototypeMysqlResult = readonly [
  {
    readonly affectedRows: number;
  },
  readonly object[],
];
type PrototypeSqliteRunResult = {
  readonly changes: number;
  readonly lastInsertRowid: bigint;
};

declare const postgresDatabase: PgDatabase<PrototypePostgresResult>;
declare const mysqlDatabase: MySqlDatabase<PrototypeMysqlResult>;
declare const sqliteDatabase: BaseSQLiteDatabase<
  "async",
  PrototypeSqliteRunResult,
  { readonly job: typeof sqliteJobTable }
>;

type PrototypeExact<Expected, Actual> =
  (<Probe>() => Probe extends Expected ? 1 : 2) extends <Probe>() => Probe extends Actual ? 1 : 2
    ? (<Probe>() => Probe extends Actual ? 1 : 2) extends <Probe>() => Probe extends Expected
        ? 1
        : 2
      ? true
      : false
    : false;

declare function expectExactType<Expected>(): <Actual>(
  value: Actual & (PrototypeExact<Expected, Actual> extends true ? unknown : never),
) => void;

async function packageInterfaceContractChecks(runtimeBoolean: boolean): Promise<void> {
  const postgresDefinition = DrizzlePostgresStore.define({
    records: {
      job: postgresJobTable,
    },
    relations: () => ({
      jobRelations: postgresJobRelations,
    }),
  });

  expectExactType<typeof postgresJobTable>()(postgresDefinition.schema.job);
  expectExactType<typeof postgresJobRelations>()(postgresDefinition.schema.jobRelations);
  expectExactType<PrototypeRecordReference<typeof postgresJobTable>>()(
    postgresDefinition.records.job,
  );

  const postgresStore = await bindPostgresStore({
    definition: postgresDefinition,
    database: postgresDatabase,
  });
  const postgresResult = await postgresStore.execute({});
  expectExactType<PrototypePostgresResult>()(postgresResult.driverResult);

  // @ts-expect-error Omitted transaction binding returns no transaction method.
  await postgresStore.transaction(async () => undefined);

  const postgresTransactionStore = await bindPostgresStore({
    definition: postgresDefinition,
    database: postgresDatabase,
    transaction: true,
  });
  await postgresTransactionStore.transaction(async (transaction) => {
    expectExactType<PrototypePostgresResult>()((await transaction.execute({})).driverResult);
  });

  const possiblePostgresTransactionStore = await bindPostgresStore({
    definition: postgresDefinition,
    database: postgresDatabase,
    transaction: runtimeBoolean,
  });
  // @ts-expect-error A non-literal Boolean requires capability narrowing.
  await possiblePostgresTransactionStore.transaction(async () => undefined);
  if ("transaction" in possiblePostgresTransactionStore) {
    await possiblePostgresTransactionStore.transaction(async () => undefined);
  }

  const mysqlDefinition = DrizzleMysqlStore.define({
    records: {
      job: mysqlJobTable,
    },
  });
  const mysqlStore = await bindMysqlStore({
    definition: mysqlDefinition,
    database: mysqlDatabase,
  });
  expectExactType<PrototypeMysqlResult>()((await mysqlStore.execute({})).driverResult);

  const mysqlTransactionStore = await bindMysqlStore({
    definition: mysqlDefinition,
    database: mysqlDatabase,
    transaction: true,
  });
  await mysqlTransactionStore.transaction(async (transaction) => {
    expectExactType<PrototypeMysqlResult>()((await transaction.execute({})).driverResult);
  });

  const possibleMysqlTransactionStore = await bindMysqlStore({
    definition: mysqlDefinition,
    database: mysqlDatabase,
    transaction: runtimeBoolean,
  });
  // @ts-expect-error A non-literal Boolean requires capability narrowing.
  await possibleMysqlTransactionStore.transaction(async () => undefined);
  if ("transaction" in possibleMysqlTransactionStore) {
    await possibleMysqlTransactionStore.transaction(async () => undefined);
  }

  const sqliteDefinition = DrizzleSqliteStore.define({
    records: {
      job: sqliteJobTable,
    },
  });
  const sqliteStore = await bindSqliteStore({
    definition: sqliteDefinition,
    database: sqliteDatabase,
  });
  expectExactType<PrototypeSqliteRunResult>()((await sqliteStore.execute({})).driverResult);

  const sqliteTransactionStore = await bindSqliteStore({
    definition: sqliteDefinition,
    database: sqliteDatabase,
    transaction: true,
  });
  await sqliteTransactionStore.transaction(async (transaction) => {
    expectExactType<PrototypeSqliteRunResult>()((await transaction.execute({})).driverResult);
  });

  const possibleSqliteTransactionStore = await bindSqliteStore({
    definition: sqliteDefinition,
    database: sqliteDatabase,
    transaction: runtimeBoolean,
  });
  // @ts-expect-error A non-literal Boolean requires capability narrowing.
  await possibleSqliteTransactionStore.transaction(async () => undefined);
  if ("transaction" in possibleSqliteTransactionStore) {
    await possibleSqliteTransactionStore.transaction(async () => undefined);
  }

  const postgresThreadDefinition = DrizzlePostgresThreadStore.define({
    records: {
      job: postgresJobTable,
    },
    relations: (tables) => ({
      threadRelations: {
        table: tables.thread,
        relationNames: ["job"],
      },
    }),
  });
  expectExactType<PrototypeTable<"postgres", "commissary_threads", { readonly id: string }>>()(
    postgresThreadDefinition.schema.thread,
  );
  expectExactType<PrototypeCoreTables<"postgres">["thread"]>()(
    postgresThreadDefinition.schema.threadRelations.table,
  );
  const postgresThreadBackend = await bindPostgresStore({
    definition: postgresThreadDefinition,
    database: postgresDatabase,
    transaction: true,
  });
  const postgresThreadStore = createThreadStore({ backend: postgresThreadBackend });
  expectExactType<typeof postgresJobTable>()(postgresThreadStore.schema.job);

  const mysqlThreadDefinition = DrizzleMysqlThreadStore.define({
    records: {
      job: mysqlJobTable,
    },
  });
  expectExactType<PrototypeTable<"mysql", "commissary_threads", { readonly id: string }>>()(
    mysqlThreadDefinition.schema.thread,
  );
  const mysqlThreadBackend = await bindMysqlStore({
    definition: mysqlThreadDefinition,
    database: mysqlDatabase,
    transaction: true,
  });
  const mysqlThreadStore = createThreadStore({ backend: mysqlThreadBackend });
  expectExactType<typeof mysqlJobTable>()(mysqlThreadStore.schema.job);

  const sqliteThreadDefinition = DrizzleSqliteThreadStore.define({
    records: {
      job: sqliteJobTable,
    },
  });
  expectExactType<PrototypeTable<"sqlite", "commissary_threads", { readonly id: string }>>()(
    sqliteThreadDefinition.schema.thread,
  );
  const sqliteThreadBackend = await bindSqliteStore({
    definition: sqliteThreadDefinition,
    database: sqliteDatabase,
    transaction: true,
  });
  const sqliteThreadStore = createThreadStore({ backend: sqliteThreadBackend });
  expectExactType<typeof sqliteJobTable>()(sqliteThreadStore.schema.job);

  // @ts-expect-error A PostgreSQL binder rejects a MySQL definition.
  await bindPostgresStore({ definition: mysqlDefinition, database: postgresDatabase });

  // @ts-expect-error A PostgreSQL binder rejects a MySQL common database type.
  await bindPostgresStore({ definition: postgresDefinition, database: mysqlDatabase });

  // @ts-expect-error Generic definitions cannot compose as Thread Stores.
  createThreadStore({ backend: postgresStore });
}

void packageInterfaceContractChecks;

const approvedPackageInterface = Object.freeze({
  root: [
    "DrizzleDefinitionError",
    "DrizzleDefinitionIssue",
    "DrizzleDefinitionIssueCode",
    "DrizzleSchemaGenerators",
    "DrizzleStoreDefinition",
  ],
  subpaths: ["postgres", "mysql", "sqlite"],
  transactionModes: ["base", "transaction", "runtime-union"],
  generatedValues: ["records", "schema"],
  drizzlePeer: "^0.45.2",
});

console.log(JSON.stringify(approvedPackageInterface));
