import type { StandardSchemaV1 } from "@standard-schema/spec";

import { isJsonValue, type JsonObject, type JsonValue } from "./json.js";
import {
  StoreValidationError,
  type StoreValidationIssue,
  type StoreValidationPhase,
} from "./store-errors.js";

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

type DeepRecordOverride<Value> = Value extends FieldSchema
  ? Value
  : Value extends (...arguments_: never[]) => unknown
    ? Value
    : Value extends readonly unknown[]
      ? Value
      : Value extends object
        ? {
            readonly [Key in keyof Value]?: DeepRecordOverride<Value[Key]> | null;
          }
        : Value extends string
          ? string
          : Value extends number
            ? number
            : Value extends boolean
              ? boolean
              : Value;

type ExistingFieldOverride<Field extends FieldDefinition> =
  | FieldDefinition
  | (Field extends FieldSchema
      ? {
          readonly select?: FieldSchema;
          readonly create?: FieldSchema | null;
          readonly update?: FieldSchema | null;
          readonly [key: string]: unknown;
        }
      : {
          readonly [Key in keyof Field]?: Key extends "select"
            ? FieldSchema
            : Key extends "create" | "update"
              ? FieldSchema | null
              : DeepRecordOverride<Field[Key]> | null;
        });

type RecordFieldOverrides<Fields extends FieldDefinitions> = {
  readonly [Name in keyof Fields]?: ExistingFieldOverride<Fields[Name]>;
} & Readonly<Record<string, FieldDefinition | Readonly<Record<string, unknown>>>>;

/** A typed deep patch for one contributed Record Definition. */
export type RecordOverride<Definition extends RecordDefinition> = {
  readonly [Key in keyof Definition as Key extends "fields" ? never : Key]?: DeepRecordOverride<
    Definition[Key]
  > | null;
} & {
  /** Existing fields accept patches. New fields must be complete Field Definitions. */
  readonly fields?: RecordFieldOverrides<Definition["fields"]>;
};

/** Typed deep patches keyed by existing Record contribution names. */
export type RecordOverrides<Definitions extends RecordDefinitions> = Partial<{
  readonly [Name in keyof Definitions]: RecordOverride<Definitions[Name]>;
}>;

type ApplyDeepRecordOverride<Base, Override> = Override extends null
  ? never
  : Override extends FieldSchema
    ? Override
    : Base extends FieldSchema
      ? Override extends object
        ? ApplyDeepRecordOverride<{ readonly select: Base }, Override>
        : Override
      : Base extends (...arguments_: never[]) => unknown
        ? Override
        : Base extends readonly unknown[]
          ? Override
          : Base extends object
            ? Override extends object
              ? {
                  readonly [Key in keyof Base | keyof Override as Key extends keyof Override
                    ? Override[Key] extends null
                      ? never
                      : Key
                    : Key]: Key extends keyof Override
                    ? Key extends keyof Base
                      ? ApplyDeepRecordOverride<Base[Key], Override[Key]>
                      : Exclude<Override[Key], null>
                    : Key extends keyof Base
                      ? Base[Key]
                      : never;
                }
              : Override
            : Override;

/** Apply typed deep Record patches without removing Record or Field keys. */
export type ApplyOverrides<
  Definitions extends RecordDefinitions,
  Overrides extends RecordOverrides<Definitions>,
> = {
  readonly [Name in keyof Definitions]: Name extends keyof Overrides
    ? ApplyDeepRecordOverride<Definitions[Name], Overrides[Name]> extends infer Effective
      ? Effective extends RecordDefinition
        ? Effective
        : never
      : never
    : Definitions[Name];
};

type CompatibleFieldOverride<
  Contributor extends FieldDefinition,
  Effective extends FieldDefinition,
> =
  FieldOutput<SelectFieldSchema<Effective>> extends FieldOutput<SelectFieldSchema<Contributor>>
    ? FieldInput<CreateFieldSchema<Contributor>> extends FieldInput<CreateFieldSchema<Effective>>
      ? FieldInput<UpdateFieldSchema<Contributor>> extends FieldInput<UpdateFieldSchema<Effective>>
        ? true
        : false
      : false
    : false;

type IncompatibleOverriddenFieldName<
  Contributor extends RecordDefinition,
  Effective extends RecordDefinition,
  SharedName extends keyof Contributor["fields"] & keyof Effective["fields"] =
    keyof Contributor["fields"] & keyof Effective["fields"],
> = {
  readonly [Name in SharedName]: CompatibleFieldOverride<
    Contributor["fields"][Name],
    Effective["fields"][Name]
  > extends true
    ? never
    : Name;
}[SharedName];

type CompatibleRecordOverride<
  Contributor extends RecordDefinition,
  Effective extends RecordDefinition,
> = [IncompatibleOverriddenFieldName<Contributor, Effective>] extends [never]
  ? Effective["fields"] extends RoundTripFieldDefinitions<Effective["fields"]>
    ? true
    : false
  : false;

/** Constraint for overrides that preserve contributor reads and accepted writes. */
export type CompatibleRecordOverrides<
  Definitions extends RecordDefinitions,
  Overrides extends RecordOverrides<Definitions>,
  Effective extends RecordDefinitions = ApplyOverrides<Definitions, Overrides>,
> = {
  readonly [Name in keyof Overrides]: Name extends keyof Definitions & keyof Effective
    ? CompatibleRecordOverride<Definitions[Name], Effective[Name]> extends true
      ? Overrides[Name]
      : never
    : never;
};

function isRecordContainer(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldSchemaValue(value: unknown): value is FieldSchema {
  if (!isRecordContainer(value) || !Object.hasOwn(value, "~standard")) {
    return false;
  }
  const standard = Reflect.get(value, "~standard");
  return (
    isRecordContainer(standard) &&
    Reflect.get(standard, "version") === 1 &&
    typeof Reflect.get(standard, "validate") === "function"
  );
}

function snapshotRecordContainer(
  value: Readonly<Record<PropertyKey, unknown>>,
): Readonly<Record<PropertyKey, unknown>> {
  return Object.freeze(Object.fromEntries(Reflect.ownKeys(value).map((key) => [key, value[key]])));
}

function snapshotFieldDefinition(value: unknown, field: PropertyKey): FieldDefinition {
  if (isFieldSchemaValue(value)) {
    return value;
  }
  if (!isRecordContainer(value) || !isFieldSchemaValue(Reflect.get(value, "select"))) {
    throw new TypeError(`Record Field '${String(field)}' must define a Select Field Schema`);
  }
  for (const operation of ["create", "update"] as const) {
    if (Object.hasOwn(value, operation) && !isFieldSchemaValue(Reflect.get(value, operation))) {
      throw new TypeError(
        `Record Field '${String(field)}' ${operation} value must be a Field Schema`,
      );
    }
  }
  return snapshotRecordContainer(value) as FieldDefinition;
}

function defineStoreRecord<Definition extends RecordDefinition>(
  definition: Definition,
): Definition {
  if (!isRecordContainer(definition) || !isRecordContainer(definition.fields)) {
    throw new TypeError("Record Definition must contain a fields object");
  }
  const fields = Object.freeze(
    Object.fromEntries(
      Reflect.ownKeys(definition.fields).map((field) => [
        field,
        snapshotFieldDefinition(Reflect.get(definition.fields, field), field),
      ]),
    ),
  );
  return Object.freeze({
    ...definition,
    fields,
  }) as Definition;
}

/** Constructor for immutable, unbound Store Record Definitions. */
export const StoreRecord = {
  /** Snapshot package-owned containers without cloning or freezing Field Schemas. */
  define<const Definition extends RecordDefinition>(
    definition: Definition & {
      readonly fields: RoundTripFieldDefinitions<Definition["fields"]>;
    },
  ): Definition {
    return defineStoreRecord(definition);
  },
};

function snapshotOverrideValue(value: unknown): unknown {
  if (isFieldSchemaValue(value) || !isRecordContainer(value)) {
    if (Array.isArray(value)) {
      return Object.freeze(value.map(snapshotOverrideValue));
    }
    return value;
  }
  const entries = Reflect.ownKeys(value).map((key) => [
    key,
    snapshotOverrideValue(Reflect.get(value, key)),
  ]);
  return Object.freeze(Object.fromEntries(entries));
}

function applyDeepRecordOverride(base: unknown, override: unknown): unknown {
  if (isFieldSchemaValue(override) || !isRecordContainer(base) || !isRecordContainer(override)) {
    return snapshotOverrideValue(override);
  }
  const entries = new Map<PropertyKey, unknown>(
    Reflect.ownKeys(base).map((key) => [key, Reflect.get(base, key)]),
  );
  for (const key of Reflect.ownKeys(override)) {
    const value = Reflect.get(override, key);
    if (value === null) {
      entries.delete(key);
    } else {
      entries.set(
        key,
        entries.has(key)
          ? applyDeepRecordOverride(entries.get(key), value)
          : snapshotOverrideValue(value),
      );
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

function applyFieldOverride(
  field: PropertyKey,
  contributor: FieldDefinition,
  override: unknown,
): FieldDefinition {
  if (override === null) {
    throw new TypeError(`Record override cannot remove Field '${String(field)}'`);
  }
  if (isFieldSchemaValue(override)) {
    return override;
  }
  if (!isRecordContainer(override)) {
    throw new TypeError(`Record override for Field '${String(field)}' must be an object`);
  }
  const base = isFieldSchemaValue(contributor)
    ? Object.freeze({ select: contributor })
    : contributor;
  return snapshotFieldDefinition(applyDeepRecordOverride(base, override), field);
}

/** Apply Store-neutral typed overrides and return one immutable effective catalog. */
export function applyRecordOverrides<
  const Definitions extends RecordDefinitions,
  const Overrides extends RecordOverrides<Definitions>,
>(
  definitions: Definitions & RoundTripRecordDefinitions<Definitions>,
  overrides: Overrides & CompatibleRecordOverrides<Definitions, Overrides>,
): ApplyOverrides<Definitions, Overrides> {
  const effective = new Map<PropertyKey, RecordDefinition>(
    Reflect.ownKeys(definitions).map((name) => [
      name,
      defineStoreRecord(Reflect.get(definitions, name) as RecordDefinition),
    ]),
  );
  for (const name of Reflect.ownKeys(overrides)) {
    const contributor = effective.get(name);
    if (contributor === undefined) {
      throw new TypeError(`Record override '${String(name)}' has no contribution`);
    }
    const override = Reflect.get(overrides, name);
    if (!isRecordContainer(override)) {
      throw new TypeError(`Record override '${String(name)}' must be an object`);
    }
    const fields = new Map<PropertyKey, FieldDefinition>(
      Reflect.ownKeys(contributor.fields).map((field) => [
        field,
        Reflect.get(contributor.fields, field) as FieldDefinition,
      ]),
    );
    if (Object.hasOwn(override, "fields")) {
      const fieldOverrides = Reflect.get(override, "fields");
      if (!isRecordContainer(fieldOverrides)) {
        throw new TypeError(`Record override '${String(name)}' fields must be an object`);
      }
      for (const field of Reflect.ownKeys(fieldOverrides)) {
        const fieldOverride = Reflect.get(fieldOverrides, field);
        const contributedField = fields.get(field);
        fields.set(
          field,
          contributedField === undefined
            ? snapshotFieldDefinition(fieldOverride, field)
            : applyFieldOverride(field, contributedField, fieldOverride),
        );
      }
    }
    const recordOverride = Object.fromEntries(
      Reflect.ownKeys(override)
        .filter((key) => key !== "fields")
        .map((key) => [key, Reflect.get(override, key)]),
    );
    const merged = applyDeepRecordOverride(contributor, recordOverride);
    if (!isRecordContainer(merged)) {
      throw new TypeError(`Record override '${String(name)}' produced an invalid definition`);
    }
    effective.set(
      name,
      defineStoreRecord({
        ...merged,
        fields: Object.freeze(Object.fromEntries(fields)),
      } as RecordDefinition),
    );
  }
  return Object.freeze(Object.fromEntries(effective)) as ApplyOverrides<Definitions, Overrides>;
}

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

interface ParseRecordFieldsOptions {
  readonly fieldNames?: readonly string[];
  readonly allowedInputFields?: ReadonlySet<string>;
  readonly fieldOperation?: "select" | "create" | "update";
}

async function parseRecordFields(
  definition: RecordDefinition,
  collection: string,
  operation: "find" | "create" | "update",
  input: unknown,
  options: ParseRecordFieldsOptions = {},
): Promise<JsonObject> {
  const phase: StoreValidationPhase = operation === "find" ? "query" : operation;
  const fieldNames = options.fieldNames ?? Object.keys(definition.fields);
  const fieldOperation = options.fieldOperation ?? (operation === "find" ? "select" : operation);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new StoreValidationError({
      collection,
      operation,
      phase,
      issues: [{ message: "Expected a Record object", path: [] }],
    });
  }

  for (const key of Object.keys(input)) {
    const allowed =
      options.allowedInputFields === undefined
        ? Object.hasOwn(definition.fields, key)
        : options.allowedInputFields.has(key);
    if (!allowed) {
      throw new StoreValidationError({
        collection,
        operation,
        phase,
        field: key,
        issues: [{ message: `Unknown Record field '${key}'`, path: [key] }],
      });
    }
  }

  for (const field of fieldNames) {
    if (!Object.hasOwn(definition.fields, field)) {
      throw new StoreValidationError({
        collection,
        operation,
        phase,
        field,
        issues: [{ message: `Unknown Record field '${field}'`, path: [field] }],
      });
    }
  }

  const validateField = async (
    field: string,
  ): Promise<{
    readonly field: string;
    readonly value?: JsonValue;
    readonly error?: StoreValidationError;
  }> => {
    // SAFETY: The preceding Object.hasOwn pass proves this key exists in the Field Definition map.
    const fieldDefinition = Reflect.get(definition.fields, field) as FieldDefinition;
    const schema =
      fieldOperation === "create"
        ? createFieldSchema(fieldDefinition)
        : fieldOperation === "update"
          ? updateFieldSchema(fieldDefinition)
          : selectFieldSchema(fieldDefinition);
    const fieldResult = await schema["~standard"].validate(Reflect.get(input, field));
    if (fieldResult.issues !== undefined) {
      return {
        field,
        error: new StoreValidationError({
          collection,
          operation,
          phase,
          field,
          issues: normalizeSchemaIssues(fieldResult.issues),
        }),
      };
    }
    if (fieldResult.value === undefined) {
      return { field };
    }
    if (!isJsonValue(fieldResult.value)) {
      return {
        field,
        error: new StoreValidationError({
          collection,
          operation,
          phase,
          field,
          issues: [{ message: "Field Schema produced a non-JSON value", path: [] }],
        }),
      };
    }
    return { field, value: fieldResult.value };
  };

  const parsed: Record<string, JsonValue> = {};
  const applyResult = (result: Awaited<ReturnType<typeof validateField>>): void => {
    if (result.error !== undefined) {
      throw result.error;
    }
    if (result.value !== undefined) {
      parsed[result.field] = result.value;
    }
  };
  if (operation === "find") {
    const results = await Promise.all(fieldNames.map(validateField));
    for (const result of results) {
      applyResult(result);
    }
  } else {
    for (const field of fieldNames) {
      applyResult(await validateField(field));
    }
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
  const values = await parseRecordFields(definition, collection, "update", input, {
    fieldNames: fields,
  });
  return Object.freeze({ fields, values });
}

/** Parse a complete created candidate through Select Field Schemas for storage. */
export async function parseStoreCreatedRecord<Definition extends RecordDefinition>(
  definition: Definition,
  collection: string,
  input: unknown,
): Promise<SelectedRecord<Definition>> {
  const parsed = await parseRecordFields(definition, collection, "create", input, {
    fieldNames: Object.keys(definition.fields),
    fieldOperation: "select",
  });
  // SAFETY: Every effective Select Field Schema parsed the complete candidate.
  return parsed as SelectedRecord<Definition>;
}

/** Parse a complete updated candidate through Select Field Schemas for storage. */
export async function parseStoreUpdatedRecord<Definition extends RecordDefinition>(
  definition: Definition,
  collection: string,
  input: unknown,
): Promise<SelectedRecord<Definition>> {
  const parsed = await parseRecordFields(definition, collection, "update", input, {
    fieldNames: Object.keys(definition.fields),
    fieldOperation: "select",
  });
  // SAFETY: Every effective Select Field Schema parsed the complete candidate.
  return parsed as SelectedRecord<Definition>;
}

/** Parse only requested stored fields through their effective Select Field Schemas. */
export async function parseStoreSelectedFields(
  definition: RecordDefinition,
  collection: string,
  input: unknown,
  fields: readonly string[],
): Promise<JsonObject> {
  const selectedFields = Object.freeze([...new Set(fields)]);
  return parseRecordFields(definition, collection, "find", input, {
    fieldNames: selectedFields,
    allowedInputFields: new Set(selectedFields),
  });
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
