import type { CoreRecordDefinitions } from "@commissary/core";
import type { RecordDefinitions, StoreCreateInputMap } from "@commissary/store";
import type { SqlRecordReferences } from "@commissary/store/sql";
import type { Relations } from "drizzle-orm";
import type {
  AnySQLiteColumn,
  AnySQLiteTable,
  SQLiteColumnBuilderBase,
} from "drizzle-orm/sqlite-core";

import type { DrizzleSchemaGenerators, DrizzleStoreDefinition } from "./definition-contracts.js";
import { defineDrizzleDialectStore } from "./definition-runtime.js";
import type { ConcreteDrizzleDefinition } from "./definition-state.js";
import type {
  DrizzleBeforeCreateHooks,
  DrizzleHooksConfig,
  DrizzleOverrideFieldNames,
  DrizzleRecordOverride,
  DrizzleRecordInputs,
  DrizzleRecordOverrides,
  DrizzleSchemaGeneratorConfig,
  DrizzleThreadRecordDefinitions,
  EnsureDrizzleCoreDefinitions,
  FinalDrizzleTables,
  HookAdjustedCreateInputs,
  HostDrizzleRecordDefinitions,
  RequiredCoreOverrideHookNames,
} from "./definition-types.js";
import { sqliteDefinitionAdapter } from "./sqlite-definition.js";

type SqliteRelations = Readonly<Record<string, Relations>>;
type SqliteTable = AnySQLiteTable<{ dialect: "sqlite" }>;
type SqliteGenerators = DrizzleSchemaGenerators<SqliteTable>;
type SqliteInputs = DrizzleRecordInputs<SqliteTable>;
type SqliteOverrides<Inputs extends SqliteInputs> = DrizzleRecordOverrides<
  Inputs,
  SqliteTable,
  SQLiteColumnBuilderBase
>;
type SqliteThreadOverrides<Inputs extends SqliteInputs> = Partial<{
  readonly [Name in keyof Inputs | keyof CoreRecordDefinitions]: DrizzleRecordOverride<
    SqliteTable,
    SQLiteColumnBuilderBase
  >;
}>;
type SqliteTables<Inputs extends SqliteInputs, Overrides, Generators> = FinalDrizzleTables<
  Inputs,
  Overrides,
  Generators,
  SqliteTable
>;
type SqliteDefinitions<
  Inputs extends SqliteInputs,
  Overrides,
  Generators,
> = HostDrizzleRecordDefinitions<
  Inputs,
  Overrides,
  Generators,
  SqliteTables<Inputs, Overrides, Generators>
>;
type SqliteCoreTables<Overrides> = {
  readonly [Name in keyof CoreRecordDefinitions]: SqliteTable & {
    readonly [Field in
      | keyof CoreRecordDefinitions[Name]["fields"]
      | DrizzleOverrideFieldNames<
          Name extends keyof Overrides ? Overrides[Name] : never
        >]: AnySQLiteColumn;
  };
};
type SqliteCoreDefinitions<Overrides, Generators> = HostDrizzleRecordDefinitions<
  CoreRecordDefinitions,
  Overrides,
  Generators,
  SqliteCoreTables<Overrides>
>;
type EnsureSqliteCoreDefinitions<Overrides, Generators> = EnsureDrizzleCoreDefinitions<
  SqliteCoreDefinitions<Overrides, Generators>,
  CoreRecordDefinitions,
  Overrides
>;

/** Concrete SQLite generic Store definition returned by `DrizzleSqliteStore.define`. */
export interface DrizzleSqliteStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends Readonly<Record<string, object>>,
> extends DrizzleStoreDefinition<Records, Schema> {}

/** Concrete SQLite Thread Store definition containing the complete Core catalog. */
export interface DrizzleSqliteThreadStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends Readonly<Record<string, object>>,
> extends DrizzleStoreDefinition<Records, Schema> {}

interface DrizzleSqliteStoreFactory {
  /** Define a connection-free SQLite Store from lower-tier Records or direct tables. */
  define<
    const Inputs extends SqliteInputs,
    const Overrides extends SqliteOverrides<Inputs> = {},
    const Generators extends SqliteGenerators = SqliteGenerators,
    const RelationsMap extends SqliteRelations = {},
    const Definitions extends RecordDefinitions = SqliteDefinitions<Inputs, Overrides, Generators>,
    const Hooks extends DrizzleBeforeCreateHooks<Definitions> = {},
    const Tables extends SqliteTables<Inputs, Overrides, Generators> = SqliteTables<
      Inputs,
      Overrides,
      Generators
    >,
    const Schema extends Readonly<Tables & RelationsMap> = Readonly<Tables & RelationsMap>,
    const Records extends SqlRecordReferences<Definitions> = SqlRecordReferences<Definitions>,
    const CreateInputs extends StoreCreateInputMap<Definitions> = HookAdjustedCreateInputs<
      Definitions,
      Hooks
    >,
  >(
    options: DrizzleSchemaGeneratorConfig<Inputs, Overrides, Generators> &
      DrizzleHooksConfig<NoInfer<Definitions>, Hooks, false> & {
        readonly records: Inputs;
        readonly overrides?: Overrides;
        readonly relations?: (tables: Tables) => RelationsMap;
      },
  ): DrizzleSqliteStoreDefinition<Records, Schema> &
    ConcreteDrizzleDefinition<
      "sqlite",
      "store",
      Definitions,
      Records,
      Tables,
      Schema,
      Hooks,
      CreateInputs
    >;
}

interface DrizzleSqliteThreadStoreFactory {
  /** Define a connection-free SQLite Thread Store with every Core Record. */
  define<
    const Inputs extends SqliteInputs,
    const Overrides extends SqliteThreadOverrides<Inputs> = {},
    const Generators extends SqliteGenerators = SqliteGenerators,
    const RelationsMap extends SqliteRelations = {},
    const HostDefinitions extends RecordDefinitions = SqliteDefinitions<
      Inputs,
      Overrides,
      Generators
    >,
    const Definitions extends RecordDefinitions = DrizzleThreadRecordDefinitions<
      HostDefinitions,
      EnsureSqliteCoreDefinitions<Overrides, Generators>
    >,
    const HostTables extends SqliteTables<Inputs, Overrides, Generators> = SqliteTables<
      Inputs,
      Overrides,
      Generators
    >,
    const Tables extends Readonly<SqliteCoreTables<Overrides> & HostTables> = Readonly<
      SqliteCoreTables<Overrides> & HostTables
    >,
    const Hooks extends DrizzleBeforeCreateHooks<Definitions> = {},
    const Schema extends Readonly<Tables & RelationsMap> = Readonly<Tables & RelationsMap>,
    const Records extends SqlRecordReferences<Definitions> = SqlRecordReferences<Definitions>,
    const CreateInputs extends StoreCreateInputMap<Definitions> = HookAdjustedCreateInputs<
      Definitions,
      Hooks
    >,
  >(
    options: DrizzleSchemaGeneratorConfig<Inputs, Overrides, Generators> &
      DrizzleHooksConfig<
        NoInfer<Definitions>,
        Hooks,
        true,
        RequiredCoreOverrideHookNames<Overrides>,
        Overrides
      > & {
        readonly records: Inputs;
        readonly overrides?: Overrides;
        readonly relations?: (tables: Tables) => RelationsMap;
      },
  ): DrizzleSqliteThreadStoreDefinition<Records, Schema> &
    ConcreteDrizzleDefinition<
      "sqlite",
      "thread-store",
      Definitions,
      Records,
      Tables,
      Schema,
      Hooks,
      CreateInputs
    >;
}

/** Synchronous connection-free SQLite generic Store definition factory. */
export const DrizzleSqliteStore = {
  define: (options: unknown): object =>
    defineDrizzleDialectStore(options, sqliteDefinitionAdapter, "store"),
  // SAFETY: The shared lifecycle preserves every input key and the SQLite adapter creates every declared output entity.
} as unknown as DrizzleSqliteStoreFactory;

/** Synchronous connection-free SQLite Thread Store definition factory. */
export const DrizzleSqliteThreadStore = {
  define: (options: unknown): object =>
    defineDrizzleDialectStore(options, sqliteDefinitionAdapter, "thread-store"),
  // SAFETY: Core composition and the SQLite lifecycle preserve the complete Thread catalog and exact host keys.
} as unknown as DrizzleSqliteThreadStoreFactory;
