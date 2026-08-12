import type { CoreRecordDefinitions } from "@commissary/core";
import type { RecordDefinitions, StoreCreateInputMap } from "@commissary/store";
import type { SqlRecordReferences } from "@commissary/store/sql";
import type { Relations } from "drizzle-orm";
import type { AnyMySqlColumn, AnyMySqlTable, MySqlColumnBuilderBase } from "drizzle-orm/mysql-core";

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
import { mysqlDefinitionAdapter } from "./mysql-definition.js";

type MysqlRelations = Readonly<Record<string, Relations>>;
type MysqlTable = AnyMySqlTable<{ dialect: "mysql" }>;
type MysqlGenerators = DrizzleSchemaGenerators<MysqlTable>;
type MysqlInputs = DrizzleRecordInputs<MysqlTable>;
type MysqlOverrides<Inputs extends MysqlInputs> = DrizzleRecordOverrides<
  Inputs,
  MysqlTable,
  MySqlColumnBuilderBase
>;
type MysqlThreadOverrides<Inputs extends MysqlInputs> = Partial<{
  readonly [Name in keyof Inputs | keyof CoreRecordDefinitions]: DrizzleRecordOverride<
    MysqlTable,
    MySqlColumnBuilderBase
  >;
}>;
type MysqlTables<Inputs extends MysqlInputs, Overrides, Generators> = FinalDrizzleTables<
  Inputs,
  Overrides,
  Generators,
  MysqlTable
>;
type MysqlDefinitions<
  Inputs extends MysqlInputs,
  Overrides,
  Generators,
> = HostDrizzleRecordDefinitions<
  Inputs,
  Overrides,
  Generators,
  MysqlTables<Inputs, Overrides, Generators>
>;
type MysqlCoreTables<Overrides> = {
  readonly [Name in keyof CoreRecordDefinitions]: MysqlTable & {
    readonly [Field in
      | keyof CoreRecordDefinitions[Name]["fields"]
      | DrizzleOverrideFieldNames<
          Name extends keyof Overrides ? Overrides[Name] : never
        >]: AnyMySqlColumn;
  };
};
type MysqlCoreDefinitions<Overrides, Generators> = HostDrizzleRecordDefinitions<
  CoreRecordDefinitions,
  Overrides,
  Generators,
  MysqlCoreTables<Overrides>
>;
type EnsureMysqlCoreDefinitions<Overrides, Generators> = EnsureDrizzleCoreDefinitions<
  MysqlCoreDefinitions<Overrides, Generators>,
  CoreRecordDefinitions,
  Overrides
>;

/** Concrete MySQL generic Store definition returned by `DrizzleMysqlStore.define`. */
export interface DrizzleMysqlStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends Readonly<Record<string, object>>,
> extends DrizzleStoreDefinition<Records, Schema> {}

/** Concrete MySQL Thread Store definition containing the complete Core catalog. */
export interface DrizzleMysqlThreadStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends Readonly<Record<string, object>>,
> extends DrizzleStoreDefinition<Records, Schema> {}

interface DrizzleMysqlStoreFactory {
  /** Define a connection-free MySQL Store from lower-tier Records or direct tables. */
  define<
    const Inputs extends MysqlInputs,
    const Overrides extends MysqlOverrides<Inputs> = {},
    const Generators extends MysqlGenerators = MysqlGenerators,
    const RelationsMap extends MysqlRelations = {},
    const Definitions extends RecordDefinitions = MysqlDefinitions<Inputs, Overrides, Generators>,
    const Hooks extends DrizzleBeforeCreateHooks<Definitions> = {},
    const Tables extends MysqlTables<Inputs, Overrides, Generators> = MysqlTables<
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
  ): DrizzleMysqlStoreDefinition<Records, Schema> &
    ConcreteDrizzleDefinition<
      "mysql",
      "store",
      Definitions,
      Records,
      Tables,
      Schema,
      Hooks,
      CreateInputs
    >;
}

interface DrizzleMysqlThreadStoreFactory {
  /** Define a connection-free MySQL Thread Store with every Core Record. */
  define<
    const Inputs extends MysqlInputs,
    const Overrides extends MysqlThreadOverrides<Inputs> = {},
    const Generators extends MysqlGenerators = MysqlGenerators,
    const RelationsMap extends MysqlRelations = {},
    const HostDefinitions extends RecordDefinitions = MysqlDefinitions<
      Inputs,
      Overrides,
      Generators
    >,
    const Definitions extends RecordDefinitions = DrizzleThreadRecordDefinitions<
      HostDefinitions,
      EnsureMysqlCoreDefinitions<Overrides, Generators>
    >,
    const HostTables extends MysqlTables<Inputs, Overrides, Generators> = MysqlTables<
      Inputs,
      Overrides,
      Generators
    >,
    const Tables extends Readonly<MysqlCoreTables<Overrides> & HostTables> = Readonly<
      MysqlCoreTables<Overrides> & HostTables
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
  ): DrizzleMysqlThreadStoreDefinition<Records, Schema> &
    ConcreteDrizzleDefinition<
      "mysql",
      "thread-store",
      Definitions,
      Records,
      Tables,
      Schema,
      Hooks,
      CreateInputs
    >;
}

/** Synchronous connection-free MySQL generic Store definition factory. */
export const DrizzleMysqlStore = {
  define: (options: unknown): object =>
    defineDrizzleDialectStore(options, mysqlDefinitionAdapter, "store"),
  // SAFETY: The shared lifecycle preserves every input key and the MySQL adapter creates every declared output entity.
} as unknown as DrizzleMysqlStoreFactory;

/** Synchronous connection-free MySQL Thread Store definition factory. */
export const DrizzleMysqlThreadStore = {
  define: (options: unknown): object =>
    defineDrizzleDialectStore(options, mysqlDefinitionAdapter, "thread-store"),
  // SAFETY: Core composition and the MySQL lifecycle preserve the complete Thread catalog and exact host keys.
} as unknown as DrizzleMysqlThreadStoreFactory;
