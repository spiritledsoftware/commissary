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
  readonly fields: Readonly<Record<string, AnyWriteSchema>>;
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

type PrototypeSchemaOperation = "select" | "insert" | "update";

function prototypeColumnSchema(
  column: AnyPrototypeDrizzleColumn,
  operation: PrototypeSchemaOperation,
): AnyWriteSchema {
  const acceptsUndefined =
    operation === "update" || (operation === "insert" && column.defaultValue !== undefined);
  return prototypeSchema((input: never) => {
    const value: unknown = input;
    if (value === undefined) {
      if (acceptsUndefined) {
        return undefined;
      }
      throw new TypeError(`${column.name} is required for ${operation}`);
    }
    if (typeof value !== typeof column.type.select) {
      throw new TypeError(`${column.name} has an invalid ${operation} value`);
    }
    return value as JsonValue;
  });
}

function prototypeObjectSchema<Input, Output>(
  table: AnyPrototypeDrizzleTable,
  operation: PrototypeSchemaOperation,
): PrototypeObjectSchema<Input, Output> {
  const fields = Object.fromEntries(
    Object.entries(table.columns).map(([name, column]) => [
      name,
      prototypeColumnSchema(column, operation),
    ]),
  );
  return {
    "~standard": {
      vendor: "prototype",
      version: 1,
    },
    fields,
    parse: (input) => input as unknown as Output,
  };
}

function createSelectSchema<Table extends AnyPrototypeDrizzleTable>(
  table: Table,
): PrototypeObjectSchema<unknown, SelectRecordFromTable<Table>> {
  return prototypeObjectSchema(table, "select");
}

function createInsertSchema<Table extends AnyPrototypeDrizzleTable>(
  table: Table,
): PrototypeObjectSchema<InsertRecordFromTable<Table>, InsertRecordFromTable<Table>> {
  return prototypeObjectSchema(table, "insert");
}

function createUpdateSchema<Table extends AnyPrototypeDrizzleTable>(
  table: Table,
): PrototypeObjectSchema<UpdateRecordFromTable<Table>, UpdateRecordFromTable<Table>> {
  return prototypeObjectSchema(table, "update");
}

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

type CompleteStaticFieldNames<Override> = Override extends {
  readonly fields: infer Fields extends Readonly<Record<string, StaticFieldSchemaOverride>>;
}
  ? {
      [Name in keyof Fields]: Fields[Name] extends AnyWriteSchema
        ? Name
        : Fields[Name] extends { readonly select: AnySelectSchema }
          ? Name
          : never;
    }[keyof Fields]
  : never;

type MissingSchemaGeneratorRecordNames<
  Inputs extends DrizzleRecordInputs,
  Overrides extends DrizzleRecordOverrides<Inputs>,
> = {
  [Name in TableInputNames<Inputs>]: Exclude<
    keyof Extract<Inputs[Name], AnyPrototypeDrizzleTable>["columns"],
    CompleteStaticFieldNames<Name extends keyof Overrides ? Overrides[Name] : never>
  > extends never
    ? never
    : Name;
}[TableInputNames<Inputs>];

type SchemaGeneratorConfig<
  Inputs extends DrizzleRecordInputs,
  Overrides extends DrizzleRecordOverrides<Inputs>,
> = [MissingSchemaGeneratorRecordNames<Inputs, Overrides>] extends [never]
  ? { readonly schemaGenerators?: DrizzleSchemaGenerators }
  : { readonly schemaGenerators: DrizzleSchemaGenerators };

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
  Overrides extends DrizzleRecordOverrides<Inputs>,
  Hooks extends BeforeCreateHooks<EffectiveRecordDefinitions<Inputs>>,
  Relations extends PrototypeDrizzleRelationMap,
> = SchemaGeneratorConfig<Inputs, Overrides> & {
  readonly records: Inputs;
  readonly overrides?: Overrides;
  readonly hooks?: Hooks;
  readonly relations?: (tables: TableMap<Inputs>) => Relations;
};

function isPrototypeDrizzleTable(
  value: DrizzleRecordInput | DrizzleRecordOverride,
): value is AnyPrototypeDrizzleTable {
  return "kind" in value && value.kind === "table";
}

function isPrototypeSchema(value: unknown): value is PrototypeSchema<never, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "~standard" in value &&
    "parse" in value &&
    typeof value.parse === "function"
  );
}

function parsePrototypeSchema(schema: PrototypeSchema<never, unknown>, input: unknown): unknown {
  return (schema.parse as (value: unknown) => unknown)(input);
}

function generatedFieldDefinitions(
  table: AnyPrototypeDrizzleTable,
  schemaGenerators: DrizzleSchemaGenerators | undefined,
): Readonly<Record<string, FieldDefinition<AnySelectSchema, AnyWriteSchema>>> {
  if (schemaGenerators === undefined) {
    return {};
  }

  const generatedSchemas = {
    select: schemaGenerators.select(table),
    create: schemaGenerators.insert(table),
    update: schemaGenerators.update(table),
  };
  const tableFieldNames = Object.keys(table.columns);
  for (const [operation, schema] of Object.entries(generatedSchemas)) {
    const schemaFieldNames = Object.keys(schema.fields);
    const invalidFieldName =
      tableFieldNames.find((name) => !schemaFieldNames.includes(name)) ??
      schemaFieldNames.find((name) => !(name in table.columns));
    if (invalidFieldName !== undefined) {
      throw new TypeError(
        `${table.name} has an invalid generated ${operation} field: ${invalidFieldName}`,
      );
    }
    for (const [name, fieldSchema] of Object.entries(schema.fields)) {
      if (!isPrototypeSchema(fieldSchema)) {
        throw new TypeError(`${table.name}.${name} has an invalid generated ${operation} schema`);
      }
    }
  }

  return Object.fromEntries(
    tableFieldNames.map((name) => [
      name,
      {
        select: generatedSchemas.select.fields[name] as AnySelectSchema,
        create: generatedSchemas.create.fields[name],
        update: generatedSchemas.update.fields[name],
      },
    ]),
  );
}

function applyStaticFieldOverride(
  baseline: FieldDefinition<AnySelectSchema, AnyWriteSchema> | undefined,
  fieldOverride: StaticFieldSchemaOverride | undefined,
): FieldDefinition<AnySelectSchema, AnyWriteSchema> | undefined {
  if (fieldOverride === undefined) {
    return baseline;
  }
  if (isPrototypeSchema(fieldOverride)) {
    return {
      select: fieldOverride as AnySelectSchema,
      create: fieldOverride as AnyWriteSchema,
      update: fieldOverride as AnyWriteSchema,
    };
  }

  for (const [operation, schema] of Object.entries(fieldOverride)) {
    if (!isPrototypeSchema(schema)) {
      throw new TypeError(`Static ${operation} schema is invalid`);
    }
  }
  const select = fieldOverride.select ?? baseline?.select;
  const create = fieldOverride.create ?? baseline?.create ?? fieldOverride.select;
  const update =
    fieldOverride.update ?? baseline?.update ?? fieldOverride.create ?? fieldOverride.select;
  if (select === undefined || create === undefined || update === undefined) {
    throw new TypeError("Static field schema is incomplete");
  }
  return { select, create, update };
}

function normalizeRecordDefinition(
  name: string,
  input: DrizzleRecordInput,
  table: AnyPrototypeDrizzleTable,
  recordOverride: DrizzleRecordOverride | undefined,
  schemaGenerators: DrizzleSchemaGenerators | undefined,
): RecordDefinition {
  const generatedFields = generatedFieldDefinitions(table, schemaGenerators);
  const inputFields = isPrototypeDrizzleTable(input) ? {} : input.fields;
  const staticFields =
    recordOverride === undefined || isPrototypeDrizzleTable(recordOverride)
      ? {}
      : (recordOverride.fields ?? {});
  const fieldNames = new Set([
    ...Object.keys(table.columns),
    ...Object.keys(inputFields),
    ...Object.keys(staticFields),
  ]);
  const fields = Object.fromEntries(
    [...fieldNames].map((fieldName) => {
      const baseline = inputFields[fieldName] ?? generatedFields[fieldName];
      const field = applyStaticFieldOverride(baseline, staticFields[fieldName]);
      if (field === undefined) {
        throw new TypeError(`${name}.${fieldName} has no complete schema`);
      }
      return [fieldName, field];
    }),
  );
  return { fields };
}

function defineDrizzleStore<
  const Inputs extends DrizzleRecordInputs,
  const Overrides extends DrizzleRecordOverrides<Inputs> = {},
  const Hooks extends BeforeCreateHooks<EffectiveRecordDefinitions<Inputs>> = {},
  const Relations extends PrototypeDrizzleRelationMap = {},
>(
  options: DrizzleStoreDefinitionOptions<Inputs, Overrides, Hooks, Relations>,
): DrizzleStoreDefinition<
  EffectiveRecordDefinitions<Inputs>,
  Readonly<TableMap<Inputs> & Relations>,
  Hooks
> {
  const overrides = (options.overrides ?? {}) as Readonly<
    Record<string, DrizzleRecordOverride | undefined>
  >;
  const normalizedEntries = Object.entries(options.records).map(([name, input]) => {
    const recordOverride = overrides[name];
    const overrideTable =
      recordOverride === undefined
        ? undefined
        : isPrototypeDrizzleTable(recordOverride)
          ? recordOverride
          : recordOverride.table;
    const table =
      overrideTable ?? (isPrototypeDrizzleTable(input) ? input : prototypeDrizzleTable(name, {}));
    return {
      name,
      table,
      definition: normalizeRecordDefinition(
        name,
        input,
        table,
        recordOverride,
        options.schemaGenerators,
      ),
    };
  });
  const tables = Object.fromEntries(
    normalizedEntries.map(({ name, table }) => [name, table]),
  ) as TableMap<Inputs>;
  const definitions = Object.fromEntries(
    normalizedEntries.map(({ name, definition }) => [name, definition]),
  ) as EffectiveRecordDefinitions<Inputs>;

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
      definitions,
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
          const recordDefinition = state.definitions[name];
          for (const [fieldName, field] of Object.entries(recordDefinition.fields)) {
            const value = parsePrototypeSchema(field.create, created[fieldName]);
            if (value === undefined) {
              delete created[fieldName];
            } else {
              created[fieldName] = value as JsonValue;
            }
          }
          for (const [fieldName, column] of Object.entries(table.columns)) {
            if (!(fieldName in created) && column.defaultValue !== undefined) {
              created[fieldName] = column.defaultValue;
            }
          }
          for (const [fieldName, field] of Object.entries(recordDefinition.fields)) {
            created[fieldName] = parsePrototypeSchema(
              field.select,
              created[fieldName],
            ) as JsonValue;
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

const staticOnlyTable = prototypeDrizzleTable("static_only_records", {
  tenantId: requiredTextColumn("tenant_id"),
});

const staticOnlyDefinition = defineDrizzleStore({
  records: {
    staticOnly: staticOnlyTable,
  },
  overrides: {
    staticOnly: {
      fields: {
        tenantId: tenantIdSchema,
      },
    },
  },
});

const someRecordTable = prototypeDrizzleTable("some_records", {
  id: requiredTextColumn("id"),
  tenantId: requiredTextColumn("tenant_id"),
  archived: defaultedBooleanColumn("archived", false),
});

const definition = defineDrizzleStore({
  schemaGenerators: {
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
export const someRecord = definition.schema.someRecord;
export const someRecordRelations = definition.schema.someRecordRelations;
export const staticOnlyRecord = staticOnlyDefinition.schema.staticOnly;

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
