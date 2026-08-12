import type {
  BeforeCreateDraft,
  CommitModelInvocationStoreResult,
  ContinueSettlementStoreResult,
  CoreInternallyCreatedRecordName,
  CoreRecordDefinitions,
  FinalizeRunStoreResult,
  RequiredBeforeCreateHookNames,
  ThreadRecordDefinitions,
} from "@commissary/core";
import type {
  ApplyOverrides,
  CreateFieldSchema,
  CreateInput,
  FieldDefinition,
  FieldInput,
  FieldOutput,
  FieldSchema,
  JsonValue,
  RecordDefinition,
  RecordDefinitions,
  RecordOverrides,
  SelectFieldSchema,
  StoreCreateInputMap,
  UpdateFieldSchema,
} from "@commissary/store";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AnyColumn,
  BuildColumn,
  ColumnBuilderBase,
  Dialect,
  GetColumnData,
  Table,
} from "drizzle-orm";

import type { DrizzleSchemaGenerators } from "./definition-contracts.js";

/** Runtime-compatible Drizzle table accepted by shared type operations. */
export type DrizzleTable = Table & { readonly _: { readonly columns: Record<string, AnyColumn> } };

/** Exact logical column map carried by one Drizzle table. */
export type DrizzleTableColumns<TableValue extends DrizzleTable> = TableValue["_"]["columns"];

/** A lower-tier Record or already-built table under one catalog key. */
export type DrizzleRecordInputs<TableValue extends DrizzleTable> = Readonly<
  Record<string, RecordDefinition | TableValue>
>;

/** A static Field override, direct builder, or their concrete-column combination. */
export type DrizzleFieldOverride<ColumnBuilder> =
  | FieldDefinition
  | ColumnBuilder
  | {
      readonly select?: FieldSchema;
      readonly create?: FieldSchema | null;
      readonly update?: FieldSchema | null;
      readonly column?: ColumnBuilder | Readonly<Record<string, unknown>> | null;
      readonly [key: string]: unknown;
    };

/** One concrete Record override including optional complete table replacement. */
export type DrizzleRecordOverride<TableValue extends DrizzleTable, ColumnBuilder> =
  | TableValue
  | {
      readonly table?: TableValue | null;
      readonly fields?: Readonly<Record<string, DrizzleFieldOverride<ColumnBuilder>>>;
      readonly [key: string]: unknown;
    };

/** Concrete overrides keyed by supplied Record input names. */
export type DrizzleRecordOverrides<
  Inputs extends Readonly<Record<string, unknown>>,
  TableValue extends DrizzleTable,
  ColumnBuilder,
> = Partial<{
  readonly [Name in keyof Inputs]: DrizzleRecordOverride<TableValue, ColumnBuilder>;
}>;

type CompleteStaticFieldNames<Override> = Override extends {
  readonly fields: infer Fields extends Readonly<Record<string, unknown>>;
}
  ? {
      readonly [Name in keyof Fields]: Fields[Name] extends FieldSchema
        ? Name
        : Fields[Name] extends { readonly select: FieldSchema }
          ? Name
          : never;
    }[keyof Fields]
  : never;

type MissingGeneratorRecordNames<Inputs extends Readonly<Record<string, unknown>>, Overrides> = {
  readonly [Name in keyof Inputs]: Exclude<
    Inputs[Name] extends DrizzleTable
      ? keyof DrizzleTableColumns<Inputs[Name]>
      : Inputs[Name] extends RecordDefinition
        ?
            | Exclude<
                DrizzleOverrideFieldNames<Name extends keyof Overrides ? Overrides[Name] : never>,
                keyof Inputs[Name]["fields"]
              >
            | ([
                FinalSuppliedTable<
                  Inputs[Name],
                  Name extends keyof Overrides ? Overrides[Name] : never
                >,
              ] extends [never]
                ? never
                : FinalSuppliedTable<
                      Inputs[Name],
                      Name extends keyof Overrides ? Overrides[Name] : never
                    > extends infer Supplied extends DrizzleTable
                  ? Exclude<keyof DrizzleTableColumns<Supplied>, keyof Inputs[Name]["fields"]>
                  : never)
        : never,
    CompleteStaticFieldNames<Name extends keyof Overrides ? Overrides[Name] : never>
  > extends never
    ? never
    : Name;
}[keyof Inputs];

/** Require generators only when a direct table has a Field without a complete static schema. */
export type DrizzleSchemaGeneratorConfig<
  Inputs extends Readonly<Record<string, unknown>>,
  Overrides,
  Generators,
> = [MissingGeneratorRecordNames<Inputs, Overrides>] extends [never]
  ? { readonly schemaGenerators?: Generators }
  : { readonly schemaGenerators: Generators };

type GeneratorResult<
  Generators,
  Operation extends "select" | "insert" | "update",
> = Generators extends DrizzleSchemaGenerators ? ReturnType<Generators[Operation]> : never;

type GeneratedObjectFields<Value> = Value extends { readonly shape: infer Fields }
  ? Fields
  : Value extends { readonly entries: infer Fields }
    ? Fields
    : never;

type GeneratedFieldSchema<
  Generators,
  Operation extends "select" | "insert" | "update",
  Name extends PropertyKey,
  Fallback extends FieldSchema,
> = [GeneratedObjectFields<GeneratorResult<Generators, Operation>>] extends [never]
  ? Fallback
  : Name extends keyof GeneratedObjectFields<GeneratorResult<Generators, Operation>>
    ? GeneratedObjectFields<GeneratorResult<Generators, Operation>>[Name] extends infer Schema
      ? Schema extends FieldSchema
        ? Schema
        : Fallback
      : Fallback
    : Fallback;

type ColumnSelectedValue<Column extends AnyColumn> = [
  Extract<GetColumnData<Column>, JsonValue>,
] extends [never]
  ? JsonValue
  : Extract<GetColumnData<Column>, JsonValue>;
type ColumnSelectFallback<Column extends AnyColumn> = StandardSchemaV1<
  unknown,
  ColumnSelectedValue<Column>
>;
type OmittedWriteSchema = StandardSchemaV1<undefined, undefined>;

type ColumnIsWritable<Column extends AnyColumn> = [Column["_"]["identity"]] extends [never]
  ? true
  : Column["_"]["identity"] extends "always"
    ? false
    : [Column["_"]["generated"]] extends [never]
      ? true
      : Column["_"]["generated"] extends undefined
        ? true
        : Column["_"]["generated"] extends { readonly type: "byDefault" }
          ? true
          : false;

type GeneratedColumnField<Generators, Name extends PropertyKey, Column extends AnyColumn> = {
  readonly select: GeneratedFieldSchema<Generators, "select", Name, ColumnSelectFallback<Column>>;
  readonly create: ColumnIsWritable<Column> extends true
    ? GeneratedFieldSchema<Generators, "insert", Name, ColumnSelectFallback<Column>>
    : OmittedWriteSchema;
  readonly update: ColumnIsWritable<Column> extends true
    ? GeneratedFieldSchema<Generators, "update", Name, ColumnSelectFallback<Column>>
    : OmittedWriteSchema;
};

type StaticSelectSchema<Baseline extends FieldDefinition, Value> = Value extends {
  readonly select: infer Schema extends FieldSchema;
}
  ? Schema
  : SelectFieldSchema<Baseline>;
type StaticCreateSchema<Baseline extends FieldDefinition, Value> = Value extends {
  readonly create: null;
}
  ? StaticSelectSchema<Baseline, Value>
  : Value extends { readonly create: infer Schema extends FieldSchema }
    ? Schema
    : CreateFieldSchema<Baseline>;
type StaticUpdateSchema<Baseline extends FieldDefinition, Value> = Value extends {
  readonly update: null;
}
  ? StaticCreateSchema<Baseline, Value>
  : Value extends { readonly update: infer Schema extends FieldSchema }
    ? Schema
    : UpdateFieldSchema<Baseline>;

type StaticSchemaOverride<Baseline extends FieldDefinition, Value> = Value extends FieldSchema
  ? Value
  : Value extends object
    ? Value extends
        | { readonly select: FieldSchema }
        | { readonly create: FieldSchema | null }
        | { readonly update: FieldSchema | null }
      ? {
          readonly select: StaticSelectSchema<Baseline, Value>;
          readonly create: StaticCreateSchema<Baseline, Value>;
          readonly update: StaticUpdateSchema<Baseline, Value>;
        }
      : never
    : never;

type OverlayGeneratedField<Baseline extends FieldDefinition, Override> =
  StaticSchemaOverride<Baseline, Override> extends infer Static
    ? [Static] extends [never]
      ? Baseline
      : Extract<Static, FieldDefinition>
    : Baseline;

/** Static and direct-column field entries carried by one concrete Record override. */
export type DrizzleOverrideFields<Override> = Override extends { readonly fields: infer Fields }
  ? Fields
  : {};
/** Exact field names from one concrete override, with `never` treated as no override. */
export type DrizzleOverrideFieldNames<Override> = [Override] extends [never]
  ? never
  : keyof DrizzleOverrideFields<Override>;
type DrizzleOverrideFieldValue<Override, Name extends PropertyKey> = [Override] extends [never]
  ? never
  : Name extends keyof DrizzleOverrideFields<Override>
    ? DrizzleOverrideFields<Override>[Name]
    : never;

type OverrideCreateSchema<Value> = Value extends FieldSchema
  ? Value
  : Value extends { readonly create: infer Schema extends FieldSchema }
    ? Schema
    : Value extends { readonly select: infer Schema extends FieldSchema }
      ? Schema
      : never;

type OverrideColumn<Value> = Value extends { readonly column: infer Column } ? Column : Value;

type DrizzleColumnRequiresCreateValue<Value> =
  OverrideColumn<Value> extends {
    readonly _: infer Column;
  }
    ? Column extends { readonly hasDefault: true }
      ? false
      : Column extends { readonly notNull: true }
        ? true
        : false
    : false;

type OverrideFieldRequiresCreateValue<Value> =
  OverrideCreateSchema<Value> extends infer Schema
    ? Schema extends FieldSchema
      ? undefined extends FieldInput<Schema>
        ? false
        : true
      : DrizzleColumnRequiresCreateValue<Value>
    : DrizzleColumnRequiresCreateValue<Value>;

type RequiredNewCoreOverrideFieldNames<Name extends keyof CoreRecordDefinitions, Override> = {
  readonly [Field in Exclude<
    DrizzleOverrideFieldNames<Override>,
    keyof CoreRecordDefinitions[Name]["fields"]
  >]: OverrideFieldRequiresCreateValue<DrizzleOverrideFieldValue<Override, Field>> extends true
    ? Field
    : never;
}[Exclude<DrizzleOverrideFieldNames<Override>, keyof CoreRecordDefinitions[Name]["fields"]>];

type OverrideTable<Override> = Override extends DrizzleTable
  ? Override
  : Override extends { readonly table: infer TableValue extends DrizzleTable }
    ? TableValue
    : never;

type RequiredNewCoreOverrideColumnNames<
  Name extends keyof CoreRecordDefinitions,
  Override,
  TableValue = OverrideTable<Override>,
> = TableValue extends DrizzleTable
  ? {
      readonly [Field in Exclude<
        keyof DrizzleTableColumns<TableValue>,
        keyof CoreRecordDefinitions[Name]["fields"]
      >]: DrizzleColumnRequiresCreateValue<DrizzleTableColumns<TableValue>[Field]> extends true
        ? Field
        : never;
    }[Exclude<keyof DrizzleTableColumns<TableValue>, keyof CoreRecordDefinitions[Name]["fields"]>]
  : never;

/** Required custom create fields contributed by one internal Core Record override. */
export type RequiredCoreOverrideFieldNames<
  Overrides,
  Name extends PropertyKey,
> = Name extends CoreInternallyCreatedRecordName & keyof CoreRecordDefinitions & keyof Overrides
  ?
      | RequiredNewCoreOverrideFieldNames<Name, Overrides[Name]>
      | RequiredNewCoreOverrideColumnNames<Name, Overrides[Name]>
  : never;

/** Internal Core Records whose direct overrides add a required custom create field. */
export type RequiredCoreOverrideHookNames<Overrides> = {
  readonly [Name in CoreInternallyCreatedRecordName &
    keyof Overrides]: Name extends keyof CoreRecordDefinitions
    ? [RequiredCoreOverrideFieldNames<Overrides, Name>] extends [never]
      ? never
      : Name
    : never;
}[CoreInternallyCreatedRecordName & keyof Overrides];

/** Record Definition inferred from one final table and host generator result types. */
export type RecordDefinitionFromDrizzleTable<
  TableValue extends DrizzleTable,
  Generators,
  Override = {},
> = RecordDefinition<{
  readonly [Name in keyof DrizzleTableColumns<TableValue>]: OverlayGeneratedField<
    GeneratedColumnField<
      Generators,
      Name,
      Extract<DrizzleTableColumns<TableValue>[Name], AnyColumn>
    >,
    DrizzleOverrideFieldValue<Override, Name>
  >;
}>;

type InputDefinition<
  Input,
  FinalTable extends DrizzleTable,
  Generators,
  Override,
  Supplied = FinalSuppliedTable<Input, Override>,
> = Input extends RecordDefinition
  ? Omit<Input, "fields"> &
      RecordDefinition<{
        readonly [Name in
          | keyof Input["fields"]
          | DrizzleOverrideFieldNames<Override>
          | ([Supplied] extends [never]
              ? never
              : Supplied extends DrizzleTable
                ? keyof DrizzleTableColumns<Supplied>
                : never)]: Name extends keyof Input["fields"]
          ? OverlayGeneratedField<Input["fields"][Name], DrizzleOverrideFieldValue<Override, Name>>
          : OverlayGeneratedField<
              GeneratedColumnField<
                Generators,
                Name,
                Supplied extends DrizzleTable
                  ? Extract<
                      Name extends keyof DrizzleTableColumns<Supplied>
                        ? DrizzleTableColumns<Supplied>[Name]
                        : AnyColumn,
                      AnyColumn
                    >
                  : Extract<
                      Name extends keyof DrizzleTableColumns<FinalTable>
                        ? DrizzleTableColumns<FinalTable>[Name]
                        : AnyColumn,
                      AnyColumn
                    >
              >,
              DrizzleOverrideFieldValue<Override, Name>
            >;
      }>
  : RecordDefinitionFromDrizzleTable<FinalTable, Generators, Override>;

/** Select the final supplied table before lower-tier table generation. */
export type FinalSuppliedTable<Input, Override> = Override extends DrizzleTable
  ? Override
  : Override extends { readonly table: infer TableValue extends DrizzleTable }
    ? TableValue
    : Input extends DrizzleTable
      ? Input
      : never;

type DrizzleOverrideColumnBuilder<Override, Field extends PropertyKey> = Override extends {
  readonly fields: infer Fields;
}
  ? Field extends keyof Fields
    ? Fields[Field] extends infer Value
      ? Value extends ColumnBuilderBase
        ? Value
        : Value extends { readonly column: infer Builder extends ColumnBuilderBase }
          ? Builder
          : never
      : never
    : never
  : never;

type GeneratedDrizzleColumn<
  TableValue extends DrizzleTable,
  Override,
  Field extends PropertyKey,
  Builder = DrizzleOverrideColumnBuilder<Override, Field>,
> = [Builder] extends [never]
  ? AnyColumn
  : Builder extends ColumnBuilderBase
    ? BuildColumn<
        TableValue["_"]["name"],
        Builder,
        Extract<TableValue["_"]["config"]["dialect"], Dialect>
      >
    : AnyColumn;

/** Exact final table map, preserving supplied values and generated table column keys. */
export type FinalDrizzleTables<
  Inputs extends Readonly<Record<string, RecordDefinition | DrizzleTable>>,
  Overrides,
  _Generators,
  GeneratedTable extends DrizzleTable,
> = {
  readonly [Name in keyof Inputs]: [
    FinalSuppliedTable<Inputs[Name], Name extends keyof Overrides ? Overrides[Name] : never>,
  ] extends [never]
    ? GeneratedTable & {
        readonly [Field in
          | keyof Extract<Inputs[Name], RecordDefinition>["fields"]
          | DrizzleOverrideFieldNames<
              Name extends keyof Overrides ? Overrides[Name] : never
            >]: GeneratedDrizzleColumn<
          GeneratedTable,
          Name extends keyof Overrides ? Overrides[Name] : never,
          Field
        >;
      } & {
        readonly _: GeneratedTable["_"] & {
          readonly columns: {
            readonly [Field in
              | keyof Extract<Inputs[Name], RecordDefinition>["fields"]
              | DrizzleOverrideFieldNames<
                  Name extends keyof Overrides ? Overrides[Name] : never
                >]: GeneratedDrizzleColumn<
              GeneratedTable,
              Name extends keyof Overrides ? Overrides[Name] : never,
              Field
            >;
          };
        };
      }
    : Extract<
        FinalSuppliedTable<Inputs[Name], Name extends keyof Overrides ? Overrides[Name] : never>,
        DrizzleTable
      >;
};

/** Generic effective host Record catalog before optional Core composition. */
export type HostDrizzleRecordDefinitions<
  Inputs extends Readonly<Record<string, RecordDefinition | DrizzleTable>>,
  Overrides,
  Generators,
  Tables extends Readonly<Record<keyof Inputs, DrizzleTable>>,
> = {
  readonly [Name in keyof Inputs]: InputDefinition<
    Inputs[Name],
    Tables[Name],
    Generators,
    Name extends keyof Overrides ? Overrides[Name] : never
  >;
};

type NormalizedDrizzleField<Generated, Fallback> = [Extract<Generated, FieldDefinition>] extends [
  never,
]
  ? Fallback
  : Extract<Generated, FieldDefinition> & FieldDefinition;

/** Replace Core definitions with generated definitions while retaining a valid Record fallback. */
export type EnsureDrizzleCoreDefinitions<
  Generated,
  Baseline extends RecordDefinitions,
  Overrides,
> = {
  readonly [Name in keyof Baseline]: Name extends keyof Generated
    ? Generated[Name] extends { readonly fields: infer Fields }
      ? Omit<Generated[Name], "fields"> & {
          readonly fields: {
            readonly [Field in keyof Fields]: Field extends keyof Baseline[Name]["fields"]
              ? Name extends keyof Overrides
                ? Field extends DrizzleOverrideFieldNames<Overrides[Name]>
                  ? NormalizedDrizzleField<Fields[Field], Baseline[Name]["fields"][Field]>
                  : Baseline[Name]["fields"][Field]
                : Baseline[Name]["fields"][Field]
              : Extract<Fields[Field], FieldDefinition> & FieldDefinition;
          };
        }
      : Baseline[Name]
    : Baseline[Name];
};

type CoreOutcomeRecordName = "finalizationOutcome" | "modelCommitOutcome" | "settlementOutcome";

type RewriteDrizzleOutcomeRecord<Definition extends RecordDefinition, Outcome> = Omit<
  Definition,
  "fields"
> & {
  readonly fields: Omit<Definition["fields"], "outcome"> & {
    readonly outcome: FieldSchema<Outcome, Outcome & JsonValue>;
  };
};

/** Effective Thread catalog after Core overrides and Core-owned outcome specialization. */
export type DrizzleThreadRecordDefinitions<
  HostDefinitions extends RecordDefinitions,
  CoreDefinitions extends ThreadRecordDefinitions,
  Definitions extends ThreadRecordDefinitions = CoreDefinitions & HostDefinitions,
> = Omit<Definitions, CoreOutcomeRecordName> & {
  readonly finalizationOutcome: RewriteDrizzleOutcomeRecord<
    CoreDefinitions["finalizationOutcome"],
    FinalizeRunStoreResult<Definitions>
  >;
  readonly modelCommitOutcome: RewriteDrizzleOutcomeRecord<
    CoreDefinitions["modelCommitOutcome"],
    CommitModelInvocationStoreResult<Definitions>
  >;
  readonly settlementOutcome: RewriteDrizzleOutcomeRecord<
    CoreDefinitions["settlementOutcome"],
    ContinueSettlementStoreResult<Definitions>
  >;
};

/** Per-Collection patch-returning Before Create Hooks captured by a definition. */
export type DrizzleBeforeCreateHooks<Definitions extends RecordDefinitions> = Partial<{
  readonly [Name in keyof Definitions]: {
    readonly beforeCreate: (input: {
      readonly draft: BeforeCreateDraft<Name, Definitions>;
    }) => Partial<CreateInput<Definitions[Name]>>;
  };
}>;

type HookPatch<Hooks, Name extends PropertyKey> = Name extends keyof Hooks
  ? Hooks[Name] extends { readonly beforeCreate: (...arguments_: never[]) => infer Patch }
    ? Patch
    : {}
  : {};

type RequiredKeys<Value> = {
  readonly [Key in keyof Value]-?: {} extends Pick<Value, Key> ? never : Key;
}[keyof Value];

type HookAdjustedCreateInput<Create, Patch> = Omit<Create, RequiredKeys<Patch> & keyof Create> &
  Partial<Pick<Create, RequiredKeys<Patch> & keyof Create>>;

/** Create-input catalog after required hook patch properties become caller-optional. */
export type HookAdjustedCreateInputs<
  Definitions extends RecordDefinitions,
  Hooks,
> = StoreCreateInputMap<Definitions> & {
  readonly [Name in keyof Definitions]: HookAdjustedCreateInput<
    CreateInput<Definitions[Name]>,
    HookPatch<Hooks, Name>
  >;
};

type RequiredCreateInputKeys<Definition extends RecordDefinition> = {
  readonly [Key in keyof CreateInput<Definition>]-?: {} extends Pick<CreateInput<Definition>, Key>
    ? never
    : Key;
}[keyof CreateInput<Definition>];

type RequiredCustomCoreCreateKeys<
  Definitions extends RecordDefinitions,
  Name extends keyof Definitions,
> = Name extends keyof CoreRecordDefinitions
  ? Exclude<RequiredCreateInputKeys<Definitions[Name]>, keyof CoreRecordDefinitions[Name]["fields"]>
  : never;

type RequiredDrizzleBeforeCreateHooks<
  Definitions extends RecordDefinitions,
  Names extends keyof Definitions,
  CoreOverrides,
> = {
  readonly [Name in Names]-?: {
    readonly beforeCreate: (input: {
      readonly draft: BeforeCreateDraft<Name, Definitions>;
    }) => Partial<CreateInput<Definitions[Name]>> &
      Required<
        Pick<
          CreateInput<Definitions[Name]>,
          | Extract<
              RequiredCustomCoreCreateKeys<Definitions, Name>,
              keyof CreateInput<Definitions[Name]>
            >
          | Extract<
              RequiredCoreOverrideFieldNames<CoreOverrides, Name>,
              keyof CreateInput<Definitions[Name]>
            >
        >
      >;
  };
};

/** Hook option whose presence is required for Core internal create guarantees. */
export type DrizzleHooksConfig<
  Definitions extends RecordDefinitions,
  Hooks extends DrizzleBeforeCreateHooks<Definitions>,
  Thread extends boolean,
  AdditionalRequiredNames extends PropertyKey = never,
  CoreOverrides = {},
> = Thread extends true
  ? [
      | RequiredBeforeCreateHookNames<Definitions & ThreadRecordDefinitions>
      | AdditionalRequiredNames,
    ] extends [never]
    ? { readonly hooks?: Hooks }
    : {
        readonly hooks: Hooks &
          RequiredDrizzleBeforeCreateHooks<
            Definitions,
            Extract<
              | RequiredBeforeCreateHookNames<Definitions & ThreadRecordDefinitions>
              | AdditionalRequiredNames,
              keyof Definitions
            >,
            CoreOverrides
          >;
      }
  : { readonly hooks?: Hooks };

/** Extract selected Field Schema output for generated table type channels. */
export type SelectedFieldValue<Field extends FieldDefinition> = Exclude<
  FieldOutput<SelectFieldSchema<Field>>,
  undefined
>;

/** Extract caller create input for generated table type channels. */
export type CreatedFieldValue<Field extends FieldDefinition> = FieldInput<CreateFieldSchema<Field>>;

/** Extract caller update input for generated table type channels. */
export type UpdatedFieldValue<Field extends FieldDefinition> = FieldInput<UpdateFieldSchema<Field>>;

/** Apply ordinary Store overrides when a concrete adapter has extracted them. */
export type ApplyStaticDrizzleOverrides<
  Definitions extends RecordDefinitions,
  Overrides extends RecordOverrides<Definitions>,
> = ApplyOverrides<Definitions, Overrides>;
