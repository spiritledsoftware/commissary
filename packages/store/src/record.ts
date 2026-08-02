import type { StandardSchemaV1 } from "@standard-schema/spec";

import { isJsonValue, type JsonObject, type JsonValue } from "./json.js";
import { StoreValidationError, type StoreValidationIssue } from "./store-errors.js";

/** A Standard Schema for one JSON-compatible Record Field. */
export type FieldSchema<
  Input = unknown,
  Output extends JsonValue | undefined = JsonValue | undefined,
> = StandardSchemaV1<Input, Output>;

/** The external input accepted by one Field Schema. */
export type FieldInput<Schema extends FieldSchema> = StandardSchemaV1.InferInput<Schema>;

/** The selected output produced by one Field Schema. */
export type FieldOutput<Schema extends FieldSchema> = StandardSchemaV1.InferOutput<Schema>;

/** A shorthand Field Schema or operation-specific Field Schemas. */
export type FieldDefinition =
  | FieldSchema
  | {
      /** Schema used to parse stored values returned by selection. */
      readonly select: FieldSchema;
      /** Optional schema used to parse caller create input. */
      readonly create?: FieldSchema;
      /** Optional schema used to parse caller update input. */
      readonly update?: FieldSchema;
    };

/** The Field Definition map for one Record. */
export type FieldDefinitions = Readonly<Record<string, FieldDefinition>>;

/** A Record Definition with independently validated top-level fields. */
export interface RecordDefinition<Fields extends FieldDefinitions = FieldDefinitions> {
  /** Independently validated top-level Field Definitions. */
  readonly fields: Fields;
}

/** A complete named Record catalog. */
export type RecordDefinitions = Readonly<Record<string, RecordDefinition>>;

/** The effective Select Field Schema for one Field Definition. */
export type SelectFieldSchema<Field extends FieldDefinition> = Field extends FieldSchema
  ? Field
  : Field extends { readonly select: infer Schema extends FieldSchema }
    ? Schema
    : never;

/** The effective Create Field Schema for one Field Definition. */
export type CreateFieldSchema<Field extends FieldDefinition> = Field extends FieldSchema
  ? Field
  : Field extends { readonly create: infer Schema extends FieldSchema }
    ? Schema
    : SelectFieldSchema<Field>;

/** The effective Update Field Schema for one Field Definition. */
export type UpdateFieldSchema<Field extends FieldDefinition> = Field extends FieldSchema
  ? Field
  : Field extends { readonly update: infer Schema extends FieldSchema }
    ? Schema
    : CreateFieldSchema<Field>;

type DefinedFieldOutput<Schema extends FieldSchema> = Exclude<FieldOutput<Schema>, undefined>;

/** Field Definition whose selected and written values can re-enter its Select Schema. */
export type RoundTripFieldDefinition<Field extends FieldDefinition> =
  DefinedFieldOutput<SelectFieldSchema<Field>> extends FieldInput<SelectFieldSchema<Field>>
    ? DefinedFieldOutput<CreateFieldSchema<Field>> extends FieldInput<SelectFieldSchema<Field>>
      ? DefinedFieldOutput<UpdateFieldSchema<Field>> extends FieldInput<SelectFieldSchema<Field>>
        ? Field
        : never
      : never
    : never;

/** Field map whose effective Select, Create, and Update outputs are storage-compatible. */
export type RoundTripFieldDefinitions<Fields extends FieldDefinitions> = {
  readonly [Key in keyof Fields]: RoundTripFieldDefinition<Fields[Key]>;
};

/** Record catalog whose every Field Definition is storage-compatible. */
export type RoundTripRecordDefinitions<Definitions extends RecordDefinitions> = {
  readonly [Name in keyof Definitions]: {
    readonly fields: RoundTripFieldDefinitions<Definitions[Name]["fields"]>;
  };
};

type Simplify<Value> = { readonly [Key in keyof Value]: Value[Key] };

type OptionalSchemaKeys<Schemas extends Readonly<Record<string, FieldSchema>>> = {
  readonly [Key in keyof Schemas]-?: undefined extends FieldOutput<Schemas[Key]> ? Key : never;
}[keyof Schemas];

type RequiredSchemaKeys<Schemas extends Readonly<Record<string, FieldSchema>>> = Exclude<
  keyof Schemas,
  OptionalSchemaKeys<Schemas>
>;

/** Build a Record type from Field Schema output types and omission rules. */
export type RecordFromFieldOutputs<Schemas extends Readonly<Record<string, FieldSchema>>> =
  Simplify<
    {
      readonly [Key in RequiredSchemaKeys<Schemas>]: FieldOutput<Schemas[Key]>;
    } & {
      readonly [Key in OptionalSchemaKeys<Schemas>]?: Exclude<FieldOutput<Schemas[Key]>, undefined>;
    }
  >;

type OptionalInputSchemaKeys<Schemas extends Readonly<Record<string, FieldSchema>>> = {
  readonly [Key in keyof Schemas]-?: undefined extends FieldInput<Schemas[Key]> ? Key : never;
}[keyof Schemas];

type RequiredInputSchemaKeys<Schemas extends Readonly<Record<string, FieldSchema>>> = Exclude<
  keyof Schemas,
  OptionalInputSchemaKeys<Schemas>
>;

/** Build a Record type from Field Schema input types and omission rules. */
export type RecordFromFieldInputs<Schemas extends Readonly<Record<string, FieldSchema>>> = Simplify<
  {
    readonly [Key in RequiredInputSchemaKeys<Schemas>]: FieldInput<Schemas[Key]>;
  } & {
    readonly [Key in OptionalInputSchemaKeys<Schemas>]?: Exclude<
      FieldInput<Schemas[Key]>,
      undefined
    >;
  }
>;

type SelectFieldSchemas<Fields extends FieldDefinitions> = {
  readonly [Key in keyof Fields]: SelectFieldSchema<Fields[Key]>;
};

type CreateFieldSchemas<Fields extends FieldDefinitions> = {
  readonly [Key in keyof Fields]: CreateFieldSchema<Fields[Key]>;
};

type UpdateFieldSchemas<Fields extends FieldDefinitions> = {
  readonly [Key in keyof Fields]: UpdateFieldSchema<Fields[Key]>;
};

/** The complete selected Record produced by a Record Definition. */
export type SelectedRecord<Definition extends RecordDefinition> = RecordFromFieldOutputs<
  SelectFieldSchemas<Definition["fields"]>
>;

/** The strict caller input accepted when one Record is created. */
export type CreateInput<Definition extends RecordDefinition> = RecordFromFieldInputs<
  CreateFieldSchemas<Definition["fields"]>
>;

/** Literal field inputs accepted when one Record is updated. */
export type UpdateInput<Definition extends RecordDefinition> = Partial<
  RecordFromFieldInputs<UpdateFieldSchemas<Definition["fields"]>>
>;

/** Canonical literal update values plus every explicitly supplied field name. */
export interface ParsedStoreUpdate {
  /** Every field explicitly supplied by the update operation. */
  readonly fields: readonly string[];
  /** Canonical parsed literal values for supplied fields that remain present. */
  readonly values: JsonObject;
}

function isFieldSchema(definition: FieldDefinition): definition is FieldSchema {
  return "~standard" in definition;
}

function selectFieldSchema(definition: FieldDefinition): FieldSchema {
  return isFieldSchema(definition) ? definition : definition.select;
}

function createFieldSchema(definition: FieldDefinition): FieldSchema {
  if (isFieldSchema(definition)) {
    return definition;
  }
  return definition.create ?? definition.select;
}

function updateFieldSchema(definition: FieldDefinition): FieldSchema {
  if (isFieldSchema(definition)) {
    return definition;
  }
  return definition.update ?? definition.create ?? definition.select;
}

function normalizeSchemaIssues(
  issues: readonly StandardSchemaV1.Issue[],
): readonly StoreValidationIssue[] {
  return issues.map((issue) => ({
    message: issue.message,
    path:
      issue.path?.map((segment) => {
        const key = typeof segment === "object" ? segment.key : segment;
        return typeof key === "symbol" ? String(key) : key;
      }) ?? [],
  }));
}

async function parseRecordFields(
  definition: RecordDefinition,
  collection: string,
  operation: "find" | "create" | "update",
  input: unknown,
  fieldNames: readonly string[] = Object.keys(definition.fields),
  allowedInputFields?: ReadonlySet<string>,
  fieldOperation: "select" | "create" | "update" = operation === "find" ? "select" : operation,
): Promise<JsonObject> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new StoreValidationError({
      collection,
      operation,
      phase: operation === "find" ? "query" : operation,
      issues: [{ message: "Expected a Record object", path: [] }],
    });
  }

  for (const key of Object.keys(input)) {
    const allowed =
      allowedInputFields === undefined
        ? Object.hasOwn(definition.fields, key)
        : allowedInputFields.has(key);
    if (!allowed) {
      throw new StoreValidationError({
        collection,
        operation,
        phase: operation === "find" ? "query" : operation,
        field: key,
        issues: [{ message: `Unknown Record field '${key}'`, path: [key] }],
      });
    }
  }

  const parsed: Record<string, JsonValue> = {};
  for (const field of fieldNames) {
    if (!Object.hasOwn(definition.fields, field)) {
      throw new StoreValidationError({
        collection,
        operation,
        phase: operation === "find" ? "query" : operation,
        field,
        issues: [{ message: `Unknown Record field '${field}'`, path: [field] }],
      });
    }
    // SAFETY: The preceding Object.hasOwn check proves this key exists in the Field Definition map.
    const fieldDefinition = Reflect.get(definition.fields, field) as FieldDefinition;
    const schema =
      fieldOperation === "create"
        ? createFieldSchema(fieldDefinition)
        : fieldOperation === "update"
          ? updateFieldSchema(fieldDefinition)
          : selectFieldSchema(fieldDefinition);
    const fieldResult = await schema["~standard"].validate(Reflect.get(input, field));
    if (fieldResult.issues !== undefined) {
      throw new StoreValidationError({
        collection,
        operation,
        phase: operation === "find" ? "query" : operation,
        field,
        issues: normalizeSchemaIssues(fieldResult.issues),
      });
    }
    if (fieldResult.value === undefined) {
      continue;
    }
    if (!isJsonValue(fieldResult.value)) {
      throw new StoreValidationError({
        collection,
        operation,
        phase: operation === "find" ? "query" : operation,
        field,
        issues: [{ message: "Field Schema produced a non-JSON value", path: [] }],
      });
    }
    parsed[field] = fieldResult.value;
  }
  return parsed;
}

/** Parse strict create input into canonical values that an adapter can store. */
export function parseStoreCreateInput(
  definition: RecordDefinition,
  collection: string,
  input: unknown,
): Promise<JsonObject> {
  return parseRecordFields(definition, collection, "create", input);
}

/** Parse only explicitly supplied literal update fields through Update Field Schemas. */
export async function parseStoreUpdateInput(
  definition: RecordDefinition,
  collection: string,
  input: unknown,
): Promise<ParsedStoreUpdate> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new StoreValidationError({
      collection,
      operation: "update",
      phase: "update",
      issues: [{ message: "Expected a Record object", path: [] }],
    });
  }
  const fields = Object.freeze(Object.keys(input));
  const values = await parseRecordFields(definition, collection, "update", input, fields);
  return Object.freeze({ fields, values });
}

/** Validate a complete update candidate through Select Field Schemas without transforming storage. */
export async function validateStoreUpdatedRecord(
  definition: RecordDefinition,
  collection: string,
  input: unknown,
): Promise<void> {
  await parseRecordFields(
    definition,
    collection,
    "update",
    input,
    Object.keys(definition.fields),
    undefined,
    "select",
  );
}

/** Parse only requested stored fields through their effective Select Field Schemas. */
export function parseStoreSelectedFields(
  definition: RecordDefinition,
  collection: string,
  input: unknown,
  fields: readonly string[],
): Promise<JsonObject> {
  const selectedFields = Object.freeze([...new Set(fields)]);
  return parseRecordFields(
    definition,
    collection,
    "find",
    input,
    selectedFields,
    new Set(selectedFields),
  );
}

/** Parse one stored Record through every effective Select Field Schema. */
export async function parseStoreSelectedRecord<Definition extends RecordDefinition>(
  definition: Definition,
  collection: string,
  input: unknown,
): Promise<SelectedRecord<Definition>> {
  const parsed = await parseRecordFields(definition, collection, "find", input);
  // SAFETY: parseRecordFields parsed every effective Select Field Schema and omitted only outputs that include undefined.
  return parsed as SelectedRecord<Definition>;
}
