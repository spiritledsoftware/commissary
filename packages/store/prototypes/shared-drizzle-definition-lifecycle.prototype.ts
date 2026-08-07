/*
 * Compile-tested public-interface prototype for issue #14.
 *
 * This file uses small local Drizzle and Standard Schema stand-ins so it can
 * test the proposed value flow without adding package dependencies.
 */

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

interface PrototypeSchema<in Input, out Output> {
  readonly "~standard": {
    readonly vendor: "prototype";
    readonly version: 1;
  };
  readonly parse: (input: Input) => Output;
}

function prototypeSchema<Input, Output>(
  parse: (input: Input) => Output,
): PrototypeSchema<Input, Output> {
  return {
    "~standard": {
      vendor: "prototype",
      version: 1,
    },
    parse,
  };
}

type SchemaInput<Schema> = Schema extends PrototypeSchema<infer Input, unknown> ? Input : never;
type SchemaOutput<Schema> = Schema extends PrototypeSchema<unknown, infer Output> ? Output : never;

type AnySelectSchema = PrototypeSchema<never, JsonValue>;
type AnyWriteSchema = PrototypeSchema<never, JsonValue | undefined>;

type FieldDefinition<
  Select extends AnySelectSchema,
  Create extends AnyWriteSchema = Select,
  Update extends AnyWriteSchema = Create,
> = {
  readonly select: Select;
  readonly create: Create;
  readonly update: Update;
};

type FieldDefinitions = Readonly<Record<string, FieldDefinition<AnySelectSchema, AnyWriteSchema>>>;

interface RecordDefinition<Fields extends FieldDefinitions = FieldDefinitions> {
  readonly fields: Fields;
}

interface PrototypeDrizzleColumn<
  out Select extends JsonValue,
  out Insert extends JsonValue | undefined,
  out Update extends JsonValue | undefined,
> {
  readonly kind: "column";
  readonly name: string;
  readonly notNull: boolean;
  readonly defaultValue?: Select;
  readonly type: {
    readonly select: Select;
    readonly insert: Insert;
    readonly update: Update;
  };
}

type AnyPrototypeDrizzleColumn = PrototypeDrizzleColumn<
  JsonValue,
  JsonValue | undefined,
  JsonValue | undefined
>;
type PrototypeDrizzleColumns = Readonly<Record<string, AnyPrototypeDrizzleColumn>>;

interface PrototypeDrizzleTable<
  Name extends string = string,
  Columns extends PrototypeDrizzleColumns = PrototypeDrizzleColumns,
> {
  readonly kind: "table";
  readonly name: Name;
  readonly columns: Columns;
}

type AnyPrototypeDrizzleTable = PrototypeDrizzleTable<string, PrototypeDrizzleColumns>;

function requiredTextColumn<Name extends string>(
  name: Name,
): PrototypeDrizzleColumn<string, string, string> {
  return {
    kind: "column",
    name,
    notNull: true,
    type: {
      select: "" as string,
      insert: "" as string,
      update: "" as string,
    },
  };
}

function defaultedBooleanColumn<Name extends string>(
  name: Name,
  defaultValue: boolean,
): PrototypeDrizzleColumn<boolean, boolean | undefined, boolean | undefined> {
  return {
    kind: "column",
    name,
    notNull: true,
    defaultValue,
    type: {
      select: false as boolean,
      insert: undefined as boolean | undefined,
      update: undefined as boolean | undefined,
    },
  };
}

function prototypeDrizzleTable<
  const Name extends string,
  const Columns extends PrototypeDrizzleColumns,
>(name: Name, columns: Columns): PrototypeDrizzleTable<Name, Columns> {
  return {
    kind: "table",
    name,
    columns,
  };
}

type SelectRecordFromTable<Table extends AnyPrototypeDrizzleTable> = {
  readonly [Name in keyof Table["columns"]]: Table["columns"][Name]["type"]["select"];
};

type InsertRecordFromTable<Table extends AnyPrototypeDrizzleTable> = {
  readonly [Name in keyof Table["columns"] as undefined extends Table["columns"][Name]["type"]["insert"]
    ? never
    : Name]: Table["columns"][Name]["type"]["insert"];
} & {
  readonly [Name in keyof Table["columns"] as undefined extends Table["columns"][Name]["type"]["insert"]
    ? Name
    : never]?: Exclude<Table["columns"][Name]["type"]["insert"], undefined>;
};

type UpdateRecordFromTable<Table extends AnyPrototypeDrizzleTable> = Partial<{
  readonly [Name in keyof Table["columns"]]: Exclude<
    Table["columns"][Name]["type"]["update"],
    undefined
  >;
}>;

interface PrototypeObjectSchema<in Input, out Output> extends PrototypeSchema<Input, Output> {
  readonly fields: Readonly<Record<string, PrototypeSchema<never, unknown>>>;
}

interface DrizzleSchemaGenerators {
  readonly select: <Table extends AnyPrototypeDrizzleTable>(
    table: Table,
  ) => PrototypeObjectSchema<unknown, SelectRecordFromTable<Table>>;
  readonly insert: <Table extends AnyPrototypeDrizzleTable>(
    table: Table,
  ) => PrototypeObjectSchema<InsertRecordFromTable<Table>, InsertRecordFromTable<Table>>;
  readonly update: <Table extends AnyPrototypeDrizzleTable>(
    table: Table,
  ) => PrototypeObjectSchema<UpdateRecordFromTable<Table>, UpdateRecordFromTable<Table>>;
}

function prototypeObjectSchema<Input, Output>(): PrototypeObjectSchema<Input, Output> {
  return {
    "~standard": {
      vendor: "prototype",
      version: 1,
    },
    fields: {},
    parse: (input) => input as unknown as Output,
  };
}

const createSelectSchema: DrizzleSchemaGenerators["select"] = () => prototypeObjectSchema();
const createInsertSchema: DrizzleSchemaGenerators["insert"] = () => prototypeObjectSchema();
const createUpdateSchema: DrizzleSchemaGenerators["update"] = () => prototypeObjectSchema();

type RecordDefinitionFromTable<Table extends AnyPrototypeDrizzleTable> = RecordDefinition<{
  readonly [Name in keyof Table["columns"]]: FieldDefinition<
    PrototypeSchema<unknown, Table["columns"][Name]["type"]["select"]>,
    PrototypeSchema<
      Table["columns"][Name]["type"]["insert"],
      Table["columns"][Name]["type"]["select"] | undefined
    >,
    PrototypeSchema<
      Table["columns"][Name]["type"]["update"],
      Table["columns"][Name]["type"]["select"] | undefined
    >
  >;
}>;

type DrizzleRecordInput = RecordDefinition | AnyPrototypeDrizzleTable;
type DrizzleRecordInputs = Readonly<Record<string, DrizzleRecordInput>>;

type EffectiveRecordDefinitions<Inputs extends DrizzleRecordInputs> = {
  readonly [Name in keyof Inputs]: Inputs[Name] extends AnyPrototypeDrizzleTable
    ? RecordDefinitionFromTable<Inputs[Name]>
    : Extract<Inputs[Name], RecordDefinition>;
};

type SelectedRecord<Definition extends RecordDefinition> = {
  readonly [Name in keyof Definition["fields"]]: SchemaOutput<Definition["fields"][Name]["select"]>;
};

type CreateInput<Definition extends RecordDefinition> = {
  readonly [Name in keyof Definition["fields"] as undefined extends SchemaInput<
    Definition["fields"][Name]["create"]
  >
    ? never
    : Name]: SchemaInput<Definition["fields"][Name]["create"]>;
} & {
  readonly [Name in keyof Definition["fields"] as undefined extends SchemaInput<
    Definition["fields"][Name]["create"]
  >
    ? Name
    : never]?: Exclude<SchemaInput<Definition["fields"][Name]["create"]>, undefined>;
};

type StaticFieldSchemaOverride =
  | AnyWriteSchema
  | {
      readonly select?: AnySelectSchema;
      readonly create?: AnyWriteSchema;
      readonly update?: AnyWriteSchema;
    };

type DrizzleRecordOverride =
  | AnyPrototypeDrizzleTable
  | {
      readonly table?: AnyPrototypeDrizzleTable;
      readonly fields?: Readonly<Record<string, StaticFieldSchemaOverride>>;
    };

type DrizzleRecordOverrides<Inputs extends DrizzleRecordInputs> = Partial<
  Readonly<Record<keyof Inputs, DrizzleRecordOverride>>
>;

interface PrototypeDrizzleRelations<
  Table extends AnyPrototypeDrizzleTable = AnyPrototypeDrizzleTable,
> {
  readonly kind: "relations";
  readonly table: Table;
  readonly names: readonly string[];
}

type PrototypeDrizzleRelationMap = Readonly<Record<string, PrototypeDrizzleRelations>>;

type TableMap<Inputs extends DrizzleRecordInputs> = {
  readonly [Name in keyof Inputs]: Inputs[Name] extends AnyPrototypeDrizzleTable
    ? Inputs[Name]
    : AnyPrototypeDrizzleTable;
};

function prototypeRelations<
  const Table extends AnyPrototypeDrizzleTable,
  const Names extends readonly string[],
>(table: Table, ...names: Names): PrototypeDrizzleRelations<Table> {
  return {
    kind: "relations",
    table,
    names,
  };
}

type BeforeCreateHooks<Definitions extends Readonly<Record<string, RecordDefinition>>> = Partial<{
  readonly [Name in keyof Definitions]: {
    readonly beforeCreate: (input: {
      readonly draft: Partial<CreateInput<Definitions[Name]>>;
    }) => Partial<CreateInput<Definitions[Name]>>;
  };
}>;

type HookPatch<Hooks, Name extends PropertyKey> = Name extends keyof Hooks
  ? Hooks[Name] extends { readonly beforeCreate: (...arguments_: never[]) => infer Patch }
    ? Patch
    : {}
  : {};

type RequiredKeys<Value> = {
  [Key in keyof Value]-?: {} extends Pick<Value, Key> ? never : Key;
}[keyof Value];

type CreateInputWithHook<Create, Patch> = Omit<Create, RequiredKeys<Patch> & keyof Create> &
  Partial<Pick<Create, RequiredKeys<Patch> & keyof Create>>;

type TableInputNames<Inputs extends DrizzleRecordInputs> = {
  [Name in keyof Inputs]: Inputs[Name] extends AnyPrototypeDrizzleTable ? Name : never;
}[keyof Inputs];

type SchemaGeneratorConfig<Inputs extends DrizzleRecordInputs> = [TableInputNames<Inputs>] extends [
  never,
]
  ? { readonly schemas?: DrizzleSchemaGenerators }
  : { readonly schemas: DrizzleSchemaGenerators };

const DrizzleStoreDefinitionState: unique symbol = Symbol("DrizzleStoreDefinitionState");

interface DrizzleStoreDefinition<
  Definitions extends Readonly<Record<string, RecordDefinition>>,
  Schema extends Readonly<Record<string, AnyPrototypeDrizzleTable | PrototypeDrizzleRelations>>,
  Hooks,
> {
  readonly records: {
    readonly [Name in keyof Definitions]: {
      readonly kind: "record-reference";
      readonly name: Name;
    };
  };
  readonly schema: Schema;
  readonly [DrizzleStoreDefinitionState]: {
    readonly definitions: Definitions;
    readonly hooks: Hooks;
    readonly tables: Readonly<Record<keyof Definitions, AnyPrototypeDrizzleTable>>;
  };
}

type DrizzleStoreDefinitionOptions<
  Inputs extends DrizzleRecordInputs,
  Hooks extends BeforeCreateHooks<EffectiveRecordDefinitions<Inputs>>,
  Relations extends PrototypeDrizzleRelationMap,
> = SchemaGeneratorConfig<Inputs> & {
  readonly records: Inputs;
  readonly overrides?: DrizzleRecordOverrides<Inputs>;
  readonly hooks?: Hooks;
  readonly relations?: (tables: TableMap<Inputs>) => Relations;
};

function defineDrizzleStore<
  const Inputs extends DrizzleRecordInputs,
  const Hooks extends BeforeCreateHooks<EffectiveRecordDefinitions<Inputs>> = {},
  const Relations extends PrototypeDrizzleRelationMap = {},
>(
  options: DrizzleStoreDefinitionOptions<Inputs, Hooks, Relations>,
): DrizzleStoreDefinition<
  EffectiveRecordDefinitions<Inputs>,
  Readonly<TableMap<Inputs> & Relations>,
  Hooks
> {
  const tables = Object.fromEntries(
    Object.entries(options.records).map(([name, input]) => {
      if ("kind" in input && input.kind === "table") {
        options.schemas?.select(input);
        options.schemas?.insert(input);
        options.schemas?.update(input);
        return [name, input];
      }
      return [name, prototypeDrizzleTable(name, {})];
    }),
  ) as TableMap<Inputs>;

  const relationValues = options.relations?.(tables) ?? ({} as Relations);
  const duplicateSchemaKey = Object.keys(relationValues).find((name) => name in tables);
  if (duplicateSchemaKey !== undefined) {
    throw new Error(`Duplicate schema key: ${duplicateSchemaKey}`);
  }

  const records = Object.fromEntries(
    Object.keys(options.records).map((name) => [
      name,
      {
        kind: "record-reference" as const,
        name,
      },
    ]),
  ) as DrizzleStoreDefinition<
    EffectiveRecordDefinitions<Inputs>,
    TableMap<Inputs>,
    Hooks
  >["records"];

  return Object.freeze({
    records: Object.freeze(records),
    schema: Object.freeze({ ...tables, ...relationValues }),
    [DrizzleStoreDefinitionState]: {
      definitions: {} as EffectiveRecordDefinitions<Inputs>,
      hooks: options.hooks ?? ({} as Hooks),
      tables,
    },
  });
}

type BoundStore<
  Definition extends DrizzleStoreDefinition<
    Readonly<Record<string, RecordDefinition>>,
    Readonly<Record<string, AnyPrototypeDrizzleTable | PrototypeDrizzleRelations>>,
    unknown
  >,
> =
  Definition extends DrizzleStoreDefinition<
    infer Definitions,
    Readonly<Record<string, AnyPrototypeDrizzleTable | PrototypeDrizzleRelations>>,
    infer Hooks
  >
    ? {
        readonly collections: {
          readonly [Name in keyof Definitions]: {
            readonly create: (
              input: CreateInputWithHook<CreateInput<Definitions[Name]>, HookPatch<Hooks, Name>>,
            ) => Promise<SelectedRecord<Definitions[Name]>>;
          };
        };
      }
    : never;

function bindDrizzleStore<
  const Definition extends DrizzleStoreDefinition<
    Readonly<Record<string, RecordDefinition>>,
    Readonly<Record<string, AnyPrototypeDrizzleTable | PrototypeDrizzleRelations>>,
    unknown
  >,
>(definition: Definition): BoundStore<Definition> {
  const state = definition[DrizzleStoreDefinitionState];
  const collections = Object.fromEntries(
    Object.entries(state.tables).map(([name, table]) => [
      name,
      {
        create: async (input: Readonly<Record<string, JsonValue>>) => {
          const hook = (
            state.hooks as Record<
              string,
              | {
                  readonly beforeCreate: (input: {
                    readonly draft: Readonly<Record<string, JsonValue>>;
                  }) => Readonly<Record<string, JsonValue>>;
                }
              | undefined
            >
          )[name];
          const patch = hook?.beforeCreate({ draft: input }) ?? {};
          const created: Record<string, JsonValue> = {
            ...input,
            ...patch,
          };
          for (const [fieldName, column] of Object.entries(table.columns)) {
            if (!(fieldName in created) && column.defaultValue !== undefined) {
              created[fieldName] = column.defaultValue;
            }
          }
          return created;
        },
      },
    ]),
  );
  return { collections } as unknown as BoundStore<Definition>;
}

const tenantIdSchema = prototypeSchema((input: unknown) => {
  if (typeof input !== "string" || input.length === 0) {
    throw new TypeError("tenantId must be a nonempty string");
  }
  return input;
});

const someRecordTable = prototypeDrizzleTable("some_records", {
  id: requiredTextColumn("id"),
  tenantId: requiredTextColumn("tenant_id"),
  archived: defaultedBooleanColumn("archived", false),
});

const definition = defineDrizzleStore({
  schemas: {
    select: createSelectSchema,
    insert: createInsertSchema,
    update: createUpdateSchema,
  },
  records: {
    someRecord: someRecordTable,
  },
  overrides: {
    someRecord: {
      fields: {
        tenantId: tenantIdSchema,
      },
    },
  },
  relations: (tables) => ({
    someRecordRelations: prototypeRelations(tables.someRecord, "owner"),
  }),
  hooks: {
    someRecord: {
      beforeCreate: () => ({
        tenantId: "tenant-from-hook",
      }),
    },
  },
});

const store = bindDrizzleStore(definition);
const created = await store.collections.someRecord.create({
  id: "record-1",
});

// Direct, flat runtime values for application code and Drizzle Kit exports.
export const directRuntimeEntities = {
  record: definition.records.someRecord,
  table: definition.schema.someRecord,
  relations: definition.schema.someRecordRelations,
};

export async function compileTimeContractChecks(): Promise<void> {
  await store.collections.someRecord.create({
    id: "record-2",
    tenantId: "explicit-tenant",
    archived: true,
  });

  // @ts-expect-error The hook supplies tenantId, but id remains required.
  await store.collections.someRecord.create({});
}

console.log(
  JSON.stringify({
    schemaKeys: Object.keys(definition.schema),
    created,
  }),
);
