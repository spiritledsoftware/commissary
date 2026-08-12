import type { CoreRecordDefinitions } from "@commissary/core";
import type { RecordDefinitions, StoreCreateInputMap } from "@commissary/store";
import type { SqlRecordReferences } from "@commissary/store/sql";
import type { Relations } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable, PgColumnBuilderBase, PgEnum } from "drizzle-orm/pg-core";

import type { DrizzleSchemaGenerators, DrizzleStoreDefinition } from "./definition-contracts.js";
import { defineDrizzleDialectStore } from "./definition-runtime.js";
import type { ConcreteDrizzleDefinition } from "./definition-state.js";
import type {
  DrizzleBeforeCreateHooks,
  DrizzleHooksConfig,
  DrizzleOverrideFields,
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
import { postgresDefinitionAdapter } from "./postgres-definition.js";

type PostgresRelations = Readonly<Record<string, Relations>>;
type PostgresEnums = Readonly<
  Record<
    string,
    {
      readonly enumName: string;
      readonly enumValues: readonly string[];
      readonly schema: string | undefined;
    }
  >
>;
type PostgresTable = AnyPgTable<{ dialect: "pg" }>;
type PostgresGenerators = DrizzleSchemaGenerators<PostgresTable>;
type PostgresInputs = DrizzleRecordInputs<PostgresTable>;
type PostgresEnumTypeFromField<Field> = Field extends {
  readonly column: infer Column;
}
  ? Column extends { readonly postgres: infer Concrete }
    ? Concrete extends { readonly type: infer Type }
      ? Type
      : never
    : Column extends { readonly type: infer Type }
      ? Type
      : never
  : never;
type PostgresEnumKey<Type> = Type extends object
  ? "~commissary/postgres-enum" extends keyof Type
    ? NonNullable<Type["~commissary/postgres-enum"]> extends () => infer Facts
      ? Facts extends {
          readonly name: infer Name extends string;
          readonly schema: infer Schema;
        }
        ? Schema extends string
          ? `${Schema}.${Name}`
          : Name
        : never
      : never
    : never
  : never;
type PostgresGeneratedEnumEntry<Type> = Type extends object
  ? "~commissary/postgres-enum" extends keyof Type
    ? NonNullable<Type["~commissary/postgres-enum"]> extends () => infer Facts
      ? Facts extends {
          readonly values: infer Values extends readonly [string, ...string[]];
        }
        ? Readonly<Record<PostgresEnumKey<Type>, PgEnum<[...Values]>>>
        : never
      : never
    : never
  : never;
type PostgresGeneratedEnumEntriesFromFields<Fields> =
  Fields extends Readonly<Record<PropertyKey, unknown>>
    ? {
        readonly [FieldName in keyof Fields]: PostgresGeneratedEnumEntry<
          PostgresEnumTypeFromField<Fields[FieldName]>
        >;
      }[keyof Fields]
    : never;
type PostgresGeneratedEnumEntries<Inputs extends PostgresInputs, Overrides> =
  | {
      readonly [RecordName in keyof Inputs]: Inputs[RecordName] extends import("@commissary/store").RecordDefinition
        ? PostgresGeneratedEnumEntriesFromFields<Inputs[RecordName]["fields"]>
        : never;
    }[keyof Inputs]
  | {
      readonly [RecordName in keyof Overrides]: PostgresGeneratedEnumEntriesFromFields<
        DrizzleOverrideFields<Overrides[RecordName]>
      >;
    }[keyof Overrides];
type UnionToIntersection<Value> = (Value extends unknown ? (value: Value) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;
type PostgresGeneratedEnums<Inputs extends PostgresInputs, Overrides> = Readonly<
  [PostgresGeneratedEnumEntries<Inputs, Overrides>] extends [never]
    ? {}
    : UnionToIntersection<PostgresGeneratedEnumEntries<Inputs, Overrides>>
>;
type PostgresOverrides<Inputs extends PostgresInputs> = DrizzleRecordOverrides<
  Inputs,
  PostgresTable,
  PgColumnBuilderBase
>;
type PostgresThreadOverrides<Inputs extends PostgresInputs> = Partial<{
  readonly [Name in keyof Inputs | keyof CoreRecordDefinitions]: DrizzleRecordOverride<
    PostgresTable,
    PgColumnBuilderBase
  >;
}>;
type PostgresTables<Inputs extends PostgresInputs, Overrides, Generators> = FinalDrizzleTables<
  Inputs,
  Overrides,
  Generators,
  PostgresTable
>;
type PostgresDefinitions<
  Inputs extends PostgresInputs,
  Overrides,
  Generators,
> = HostDrizzleRecordDefinitions<
  Inputs,
  Overrides,
  Generators,
  PostgresTables<Inputs, Overrides, Generators>
>;
type PostgresCoreTables<Overrides> = {
  readonly [Name in keyof CoreRecordDefinitions]: PostgresTable & {
    readonly [Field in
      | keyof CoreRecordDefinitions[Name]["fields"]
      | DrizzleOverrideFieldNames<
          Name extends keyof Overrides ? Overrides[Name] : never
        >]: AnyPgColumn;
  };
};
type PostgresCoreDefinitions<Overrides, Generators> = HostDrizzleRecordDefinitions<
  CoreRecordDefinitions,
  Overrides,
  Generators,
  PostgresCoreTables<Overrides>
>;
type EnsurePostgresCoreDefinitions<Overrides, Generators> = EnsureDrizzleCoreDefinitions<
  PostgresCoreDefinitions<Overrides, Generators>,
  CoreRecordDefinitions,
  Overrides
>;

/** Concrete PostgreSQL generic Store definition returned by `DrizzlePostgresStore.define`. */
export interface DrizzlePostgresStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends Readonly<Record<string, object>>,
> extends DrizzleStoreDefinition<Records, Schema> {}

/** Concrete PostgreSQL Thread Store definition containing the complete Core catalog. */
export interface DrizzlePostgresThreadStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends Readonly<Record<string, object>>,
> extends DrizzleStoreDefinition<Records, Schema> {}

interface DrizzlePostgresStoreFactory {
  /** Define a connection-free PostgreSQL Store from lower-tier Records or direct tables. */
  define<
    const Inputs extends PostgresInputs,
    const Overrides extends PostgresOverrides<Inputs> = {},
    const Generators extends PostgresGenerators = PostgresGenerators,
    const Enums extends PostgresEnums = {},
    const RelationsMap extends PostgresRelations = {},
    const Definitions extends RecordDefinitions = PostgresDefinitions<
      Inputs,
      Overrides,
      Generators
    >,
    const Hooks extends DrizzleBeforeCreateHooks<Definitions> = {},
    const Tables extends PostgresTables<Inputs, Overrides, Generators> = PostgresTables<
      Inputs,
      Overrides,
      Generators
    >,
    const Schema extends Readonly<
      Tables & Enums & PostgresGeneratedEnums<Inputs, Overrides> & RelationsMap
    > = Readonly<Tables & Enums & PostgresGeneratedEnums<Inputs, Overrides> & RelationsMap>,
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
        readonly enums?: Enums;
        readonly relations?: (tables: Tables) => RelationsMap;
      },
  ): DrizzlePostgresStoreDefinition<Records, Schema> &
    ConcreteDrizzleDefinition<
      "postgres",
      "store",
      Definitions,
      Records,
      Tables,
      Schema,
      Hooks,
      CreateInputs
    >;
}

interface DrizzlePostgresThreadStoreFactory {
  /** Define a connection-free PostgreSQL Thread Store with every Core Record. */
  define<
    const Inputs extends PostgresInputs,
    const Overrides extends PostgresThreadOverrides<Inputs> = {},
    const Generators extends PostgresGenerators = PostgresGenerators,
    const Enums extends PostgresEnums = {},
    const RelationsMap extends PostgresRelations = {},
    const HostDefinitions extends RecordDefinitions = PostgresDefinitions<
      Inputs,
      Overrides,
      Generators
    >,
    const Definitions extends RecordDefinitions = DrizzleThreadRecordDefinitions<
      HostDefinitions,
      EnsurePostgresCoreDefinitions<Overrides, Generators>
    >,
    const Hooks extends DrizzleBeforeCreateHooks<Definitions> = {},
    const HostTables extends PostgresTables<Inputs, Overrides, Generators> = PostgresTables<
      Inputs,
      Overrides,
      Generators
    >,
    const Tables extends Readonly<PostgresCoreTables<Overrides> & HostTables> = Readonly<
      PostgresCoreTables<Overrides> & HostTables
    >,
    const Schema extends Readonly<
      Tables & Enums & PostgresGeneratedEnums<Inputs, Overrides> & RelationsMap
    > = Readonly<Tables & Enums & PostgresGeneratedEnums<Inputs, Overrides> & RelationsMap>,
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
        readonly enums?: Enums;
        readonly relations?: (tables: Tables) => RelationsMap;
      },
  ): DrizzlePostgresThreadStoreDefinition<Records, Schema> &
    ConcreteDrizzleDefinition<
      "postgres",
      "thread-store",
      Definitions,
      Records,
      Tables,
      Schema,
      Hooks,
      CreateInputs
    >;
}

/** Synchronous connection-free PostgreSQL generic Store definition factory. */
export const DrizzlePostgresStore = {
  define: (options: unknown): object =>
    defineDrizzleDialectStore(options, postgresDefinitionAdapter, "store"),
  // SAFETY: The shared lifecycle preserves every input key and the PostgreSQL adapter creates every declared output entity.
} as unknown as DrizzlePostgresStoreFactory;

/** Synchronous connection-free PostgreSQL Thread Store definition factory. */
export const DrizzlePostgresThreadStore = {
  define: (options: unknown): object =>
    defineDrizzleDialectStore(options, postgresDefinitionAdapter, "thread-store"),
  // SAFETY: Core composition and the PostgreSQL lifecycle preserve the complete Thread catalog and exact host keys.
} as unknown as DrizzlePostgresThreadStoreFactory;
