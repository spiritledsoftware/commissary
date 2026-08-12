import { composeThreadStoreRecordDefinitions, coreRecordDefinitions } from "@commissary/core";
import {
  applyRecordOverrides,
  isJsonValue,
  structuralJsonEqual,
  type FieldDefinition,
  type FieldSchema,
  type JsonValue,
  type RecordDefinition,
  type RecordDefinitions,
  type RecordOverride,
  type RecordOverrides,
} from "@commissary/store";
import { sql, type SqlRecordReference } from "@commissary/store/sql";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ColumnBuilder, Relations, is, isTable } from "drizzle-orm";

import {
  DrizzleDefinitionError,
  drizzleDefinitionIssue,
  type DrizzleDefinitionIssue,
  type DrizzleSchemaGenerators,
} from "./definition-contracts.js";
import { drizzleDefinitionState } from "./definition-state.js";

type RuntimeMap = Readonly<Record<string, unknown>>;

/** Runtime output from one dialect's lower-tier table materializer. */
export interface GeneratedDrizzleTable {
  /** Ordinary final Drizzle table entity. */
  readonly table: object;
  /** Definition-owned entities, such as PostgreSQL enums, in first-use order. */
  readonly assets?: readonly (readonly [string, object])[];
}

/** Concrete mechanics supplied to the shared definition lifecycle by one dialect. */
export interface DrizzleDefinitionDialectAdapter {
  /** Stable database family used in diagnostics and hidden state. */
  readonly dialect: "postgres" | "mysql" | "sqlite";
  /** Human-readable database family used in messages. */
  readonly label: "PostgreSQL" | "MySQL" | "SQLite";
  /** Check an ordinary table entity from this exact dialect. */
  readonly isTable: (value: unknown) => boolean;
  /** Check a direct column builder from this exact dialect. */
  readonly isColumnBuilder: (value: unknown) => boolean;
  /** Read exact TypeScript column keys and public Column entities. */
  readonly getColumns: (table: object) => RuntimeMap;
  /** Build one table from a lower-tier Record resolution and direct builder overrides. */
  readonly generateTable: (
    recordName: string,
    definition: RecordDefinition,
    builders: RuntimeMap,
  ) => GeneratedDrizzleTable;
  /** Create one opaque SQL Record reference from the retained final table. */
  readonly createRecordReference: (
    table: object,
    definition: RecordDefinition,
  ) => SqlRecordReference<RecordDefinition>;
  /** Read one supplied table's declared logical primary-key field order. */
  readonly getPrimaryKeyFields: (table: object) => readonly string[];
  /** Read one table's physical qualifier and name without parsing a flat schema key. */
  readonly getTableIdentity: (table: object) => readonly string[];
  /** Validate and append dialect-owned entities after every table exists. */
  readonly finishAssets?: (
    tables: RuntimeMap,
    options: RuntimeMap,
    generatedAssets: readonly (readonly [string, object])[],
    issues: DrizzleDefinitionIssue[],
  ) => readonly (readonly [string, object])[];
}

interface GeneratedFieldSchemas {
  readonly select: FieldSchema;
  readonly create: FieldSchema;
  readonly update: FieldSchema;
}

const omittedGeneratedWriteSchema = Object.freeze({
  "~standard": Object.freeze({
    version: 1 as const,
    vendor: "@commissary/drizzle",
    validate(value: unknown) {
      return value === undefined
        ? { value: undefined }
        : { issues: [{ message: "Generated field must be omitted" }] };
    },
  }),
}) satisfies StandardSchemaV1<undefined, undefined>;

function isRecordContainer(value: unknown): value is RuntimeMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldSchema(value: unknown): value is FieldSchema {
  if (!isRecordContainer(value)) return false;
  const standard = Reflect.get(value, "~standard");
  return (
    isRecordContainer(standard) &&
    Reflect.get(standard, "version") === 1 &&
    typeof Reflect.get(standard, "validate") === "function"
  );
}

function isRecordDefinition(value: unknown): value is RecordDefinition {
  return isRecordContainer(value) && isRecordContainer(Reflect.get(value, "fields"));
}

function callbackMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "callback threw a non-Error value";
}

function absorbSqlDefinitionError(cause: unknown, issues: DrizzleDefinitionIssue[]): boolean {
  if (cause instanceof DrizzleDefinitionError) {
    issues.push(...cause.issues);
    return true;
  }
  if (
    !(cause instanceof Error) ||
    cause.name !== "SqlDefinitionError" ||
    !Array.isArray(Reflect.get(cause, "issues"))
  ) {
    return false;
  }
  const sqlIssues = Reflect.get(cause, "issues");
  if (!Array.isArray(sqlIssues)) return false;
  for (const value of sqlIssues) {
    if (!isRecordContainer(value)) continue;
    const code = Reflect.get(value, "code");
    const path = Reflect.get(value, "path");
    const message = Reflect.get(value, "message");
    if (typeof code !== "string" || !Array.isArray(path) || typeof message !== "string") continue;
    issues.push({
      // SAFETY: SqlDefinitionError owns codes included by DrizzleDefinitionIssueCode.
      code: code as DrizzleDefinitionIssue["code"],
      // SAFETY: SQL definition paths contain only string and number segments.
      path: path as readonly (string | number)[],
      message,
    });
  }
  return true;
}

function fieldOverrideBuilder(value: unknown, adapter: DrizzleDefinitionDialectAdapter): unknown {
  if (adapter.isColumnBuilder(value)) return value;
  if (isRecordContainer(value)) {
    const column = Reflect.get(value, "column");
    return adapter.isColumnBuilder(column) ? column : undefined;
  }
  return undefined;
}

function stripDrizzleFieldBuilder(
  value: unknown,
  adapter: DrizzleDefinitionDialectAdapter,
): unknown {
  if (adapter.isColumnBuilder(value)) return undefined;
  if (!isRecordContainer(value) || !adapter.isColumnBuilder(Reflect.get(value, "column"))) {
    return value;
  }
  return Object.freeze(
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== "column")),
  );
}

function readRecordOverride(
  value: unknown,
  adapter: DrizzleDefinitionDialectAdapter,
  path: readonly (string | number)[],
  issues: DrizzleDefinitionIssue[],
): {
  readonly table?: object;
  readonly builders: RuntimeMap;
  readonly staticOverride?: RecordOverride<RecordDefinition>;
} {
  if (value === undefined) return { builders: {} };
  if (adapter.isTable(value)) {
    // SAFETY: Every dialect table guard accepts only non-null Drizzle entity objects.
    return { table: value as object, builders: {} };
  }
  if (!isRecordContainer(value)) {
    issues.push(
      drizzleDefinitionIssue(
        "invalid-drizzle-override",
        path,
        `${adapter.label} Drizzle Record override must be a table or object`,
      ),
    );
    return { builders: {} };
  }

  const tableValue = Reflect.get(value, "table");
  let table: object | undefined;
  if (tableValue !== undefined && tableValue !== null) {
    if (adapter.isTable(tableValue)) {
      // SAFETY: Every dialect table guard accepts only non-null Drizzle entity objects.
      table = tableValue as object;
    } else if (isTable(tableValue)) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-drizzle-table",
          [...path, "table"],
          `${adapter.label} complete table override uses the wrong Drizzle dialect`,
        ),
      );
    } else {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-drizzle-table",
          [...path, "table"],
          `${adapter.label} complete table override has the wrong dialect or shape`,
        ),
      );
    }
  }

  const fieldsValue = Reflect.get(value, "fields");
  const builders: Record<string, unknown> = {};
  const staticFields: Record<string, unknown> = {};
  if (fieldsValue !== undefined) {
    if (!isRecordContainer(fieldsValue)) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-drizzle-override",
          [...path, "fields"],
          `${adapter.label} Drizzle field overrides must be an object`,
        ),
      );
    } else {
      for (const [fieldName, fieldOverride] of Object.entries(fieldsValue)) {
        const candidateBuilder = isRecordContainer(fieldOverride)
          ? Reflect.get(fieldOverride, "column")
          : fieldOverride;
        if (is(candidateBuilder, ColumnBuilder) && !adapter.isColumnBuilder(candidateBuilder)) {
          issues.push(
            drizzleDefinitionIssue(
              "invalid-drizzle-column",
              [...path, "fields", fieldName],
              `${adapter.label} Drizzle field '${fieldName}' uses the wrong column-builder dialect`,
            ),
          );
        }
        const builder = fieldOverrideBuilder(fieldOverride, adapter);
        if (builder !== undefined) builders[fieldName] = builder;
        const staticOverride = stripDrizzleFieldBuilder(fieldOverride, adapter);
        if (staticOverride !== undefined && isRecordContainer(staticOverride)) {
          if (Object.keys(staticOverride).length > 0) staticFields[fieldName] = staticOverride;
        } else if (staticOverride !== undefined) {
          staticFields[fieldName] = staticOverride;
        }
      }
    }
  }

  if (table !== undefined && Object.keys(builders).length > 0) {
    issues.push(
      drizzleDefinitionIssue(
        "invalid-drizzle-override",
        path,
        `${adapter.label} complete table override cannot be combined with column builders`,
      ),
    );
  }

  const otherEntries = Object.entries(value).filter(([key]) => key !== "fields" && key !== "table");
  const staticOverride = Object.freeze({
    ...Object.fromEntries(otherEntries),
    ...(Object.keys(staticFields).length === 0 ? {} : { fields: Object.freeze(staticFields) }),
  });
  return {
    ...(table === undefined ? {} : { table }),
    builders: Object.freeze(builders),
    ...(Object.keys(staticOverride).length === 0
      ? {}
      : {
          // SAFETY: Drizzle-only table and builder values were removed; the lower Store override validates the remaining structure.
          staticOverride: staticOverride as RecordOverride<RecordDefinition>,
        }),
  };
}

function callSchemaGenerator(
  operation: "select" | "insert" | "update",
  callback: (table: object) => StandardSchemaV1,
  table: object,
  path: readonly (string | number)[],
  issues: DrizzleDefinitionIssue[],
): unknown {
  try {
    return callback(table);
  } catch (cause) {
    issues.push(
      drizzleDefinitionIssue(
        "invalid-schema-generator",
        [...path, operation],
        `Drizzle ${operation} schema generator failed: ${callbackMessage(cause)}`,
        { cause },
      ),
    );
    return undefined;
  }
}

function generatedSchemaFamily(value: unknown): "zod" | "valibot" | undefined {
  if (!isRecordContainer(value)) return undefined;
  if (isRecordContainer(Reflect.get(value, "shape"))) return "zod";
  if (isRecordContainer(Reflect.get(value, "entries"))) return "valibot";
  return undefined;
}

function generatedSchemaFields(value: unknown, family: "zod" | "valibot"): RuntimeMap | undefined {
  if (!isRecordContainer(value)) return undefined;
  const fields = Reflect.get(value, family === "zod" ? "shape" : "entries");
  return isRecordContainer(fields) ? fields : undefined;
}

function writableColumnNames(columns: RuntimeMap): readonly string[] {
  return Object.entries(columns).flatMap(([name, value]) => {
    if (!isRecordContainer(value)) return [];
    const generatedIdentity = Reflect.get(value, "generatedIdentity");
    const generated = Reflect.get(value, "generated");
    const identityAlways =
      isRecordContainer(generatedIdentity) && Reflect.get(generatedIdentity, "type") === "always";
    const generatedAlways =
      isRecordContainer(generated) && Reflect.get(generated, "type") !== "byDefault";
    return identityAlways || generatedAlways ? [] : [name];
  });
}

function sameKeys(actual: RuntimeMap, expected: readonly string[]): boolean {
  const actualKeys = Object.keys(actual);
  return (
    actualKeys.length === expected.length && expected.every((name) => Object.hasOwn(actual, name))
  );
}

function collectJsonSchemaTypes(value: unknown): ReadonlySet<string> | undefined {
  if (typeof value === "boolean") return value ? undefined : new Set();
  if (!isRecordContainer(value)) return undefined;
  const types = new Set<string>();
  const type = Reflect.get(value, "type");
  const typeValues = Array.isArray(type) ? type : type === undefined ? [] : [type];
  for (const candidate of typeValues) {
    if (typeof candidate === "string") types.add(candidate);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const members = Reflect.get(value, keyword);
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      const memberTypes = collectJsonSchemaTypes(member);
      if (memberTypes !== undefined) {
        for (const memberType of memberTypes) types.add(memberType);
      }
    }
  }
  const constant = Reflect.get(value, "const");
  if (constant !== undefined) {
    types.add(
      constant === null
        ? "null"
        : Array.isArray(constant)
          ? "array"
          : typeof constant === "object"
            ? "object"
            : typeof constant,
    );
  }
  return types.size === 0 ? undefined : types;
}

function standardJsonSchemaTypes(
  schema: FieldSchema,
  direction: "input" | "output",
): { readonly valid: boolean; readonly types?: ReadonlySet<string> } {
  const jsonSchema = Reflect.get(schema["~standard"], "jsonSchema");
  if (!isRecordContainer(jsonSchema)) return { valid: true };
  const convert = Reflect.get(jsonSchema, direction);
  if (typeof convert !== "function") return { valid: true };
  try {
    const converted = Reflect.apply(convert, jsonSchema, [{ target: "draft-07" }]);
    const types = collectJsonSchemaTypes(converted);
    return { valid: true, ...(types === undefined ? {} : { types }) };
  } catch {
    return { valid: false };
  }
}

type JsonSchemaRepresentative =
  | { readonly found: false }
  | { readonly found: true; readonly value: unknown };

function jsonSchemaRepresentative(value: unknown): JsonSchemaRepresentative {
  if (!isRecordContainer(value)) return { found: false };
  if (Object.hasOwn(value, "const")) {
    return { found: true, value: Reflect.get(value, "const") };
  }
  const enumeration = Reflect.get(value, "enum");
  if (Array.isArray(enumeration) && enumeration.length > 0) {
    return { found: true, value: enumeration[0] };
  }
  if (Object.hasOwn(value, "default")) {
    return { found: true, value: Reflect.get(value, "default") };
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const members = Reflect.get(value, keyword);
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      const representative = jsonSchemaRepresentative(member);
      if (representative.found) return representative;
    }
  }
  const type = Reflect.get(value, "type");
  const selectedType = Array.isArray(type) ? type[0] : type;
  switch (selectedType) {
    case "array": {
      const items = Reflect.get(value, "items");
      const prefixItems = Reflect.get(value, "prefixItems");
      const tupleItems = Array.isArray(prefixItems)
        ? prefixItems
        : Array.isArray(items)
          ? items
          : undefined;
      if (tupleItems !== undefined) {
        const tuple: unknown[] = [];
        for (const item of tupleItems) {
          const representative = jsonSchemaRepresentative(item);
          if (!representative.found) return { found: false };
          tuple.push(representative.value);
        }
        return { found: true, value: tuple };
      }
      return { found: true, value: [] };
    }
    case "boolean":
      return { found: true, value: true };
    case "integer":
    case "number": {
      const minimum = Reflect.get(value, "minimum");
      return { found: true, value: typeof minimum === "number" ? minimum : 0 };
    }
    case "null":
      return { found: true, value: null };
    case "object": {
      const properties = Reflect.get(value, "properties");
      const required = Reflect.get(value, "required");
      if (!isRecordContainer(properties) || !Array.isArray(required)) {
        return { found: true, value: {} };
      }
      const object: Record<string, unknown> = {};
      for (const key of required) {
        if (typeof key !== "string") continue;
        const representative = jsonSchemaRepresentative(Reflect.get(properties, key));
        if (!representative.found) return { found: false };
        object[key] = representative.value;
      }
      return { found: true, value: object };
    }
    case "string": {
      const minimumLength = Reflect.get(value, "minLength");
      const length = typeof minimumLength === "number" ? Math.max(1, minimumLength) : 1;
      return { found: true, value: "x".repeat(length) };
    }
    default:
      return { found: false };
  }
}

function standardJsonSchemaInputRepresentative(schema: FieldSchema): JsonSchemaRepresentative {
  const jsonSchema = Reflect.get(schema["~standard"], "jsonSchema");
  if (!isRecordContainer(jsonSchema)) return { found: false };
  const convert = Reflect.get(jsonSchema, "input");
  if (typeof convert !== "function") return { found: false };
  try {
    return jsonSchemaRepresentative(Reflect.apply(convert, jsonSchema, [{ target: "draft-07" }]));
  } catch {
    return { found: false };
  }
}

// These fallbacks intentionally couple to Zod 4.4 `def`, Zod 3.25 `_def`, and Valibot 1.4
// `literal`/`options`/`pipe` structures. Keep their version-specific lifecycle tests current.
function structuralSchemaInputRepresentative(
  schema: unknown,
  active = new Set<object>(),
): JsonSchemaRepresentative {
  if (!isRecordContainer(schema) || active.has(schema)) return { found: false };
  active.add(schema);
  try {
    if (Object.hasOwn(schema, "literal")) {
      return { found: true, value: Reflect.get(schema, "literal") };
    }
    const options = Reflect.get(schema, "options");
    if (Array.isArray(options) && options.length > 0) {
      return { found: true, value: options[0] };
    }
    for (const key of ["def", "_def"] as const) {
      const definition = Reflect.get(schema, key);
      if (!isRecordContainer(definition)) continue;
      if (Object.hasOwn(definition, "value")) {
        return { found: true, value: Reflect.get(definition, "value") };
      }
      const values = Reflect.get(definition, "values");
      if (Array.isArray(values) && values.length > 0) {
        return { found: true, value: values[0] };
      }
      for (const inputKey of ["in", "schema", "innerType"] as const) {
        const representative = structuralSchemaInputRepresentative(
          Reflect.get(definition, inputKey),
          active,
        );
        if (representative.found) return representative;
      }
    }
    const pipe = Reflect.get(schema, "pipe");
    if (Array.isArray(pipe) && pipe.length > 0) {
      return structuralSchemaInputRepresentative(pipe[0], active);
    }
    return { found: false };
  } finally {
    active.delete(schema);
  }
}

function validateGeneratedFieldRoundTrip(
  fieldName: string,
  select: FieldSchema,
  create: FieldSchema,
  update: FieldSchema,
  issues: DrizzleDefinitionIssue[],
): void {
  const selectInput = standardJsonSchemaTypes(select, "input");
  const selectOutput = standardJsonSchemaTypes(select, "output");
  const createOutput = standardJsonSchemaTypes(create, "output");
  const updateOutput = standardJsonSchemaTypes(update, "output");
  for (const [operation, result] of [
    ["select", selectOutput],
    ["insert", createOutput],
    ["update", updateOutput],
  ] as const) {
    if (!result.valid) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-generated-schema",
          ["schemas", operation, fieldName],
          `Drizzle generated ${operation} field '${fieldName}' has no JSON-compatible output schema`,
        ),
      );
    }
  }
  if (!selectInput.valid || selectInput.types === undefined) return;
  for (const [operation, result] of [
    ["insert", createOutput],
    ["update", updateOutput],
  ] as const) {
    if (
      result.types !== undefined &&
      [...result.types].some((type) => !selectInput.types?.has(type))
    ) {
      issues.push(
        drizzleDefinitionIssue(
          "incompatible-generated-schema",
          ["schemas", operation, fieldName],
          `Drizzle generated ${operation} field '${fieldName}' cannot round-trip through its select schema`,
        ),
      );
    }
  }
}

function columnNeedsStaticJsonSchema(value: unknown): boolean {
  if (!isRecordContainer(value)) return false;
  const dataType = Reflect.get(value, "dataType");
  if (
    dataType === "date" ||
    dataType === "bigint" ||
    dataType === "buffer" ||
    dataType === "custom"
  ) {
    return true;
  }
  return dataType === "array" && columnNeedsStaticJsonSchema(Reflect.get(value, "baseColumn"));
}

function generateFieldSchemas(
  table: object,
  columns: RuntimeMap,
  generators: DrizzleSchemaGenerators<object> | undefined,
  issues: DrizzleDefinitionIssue[],
): Readonly<Record<string, GeneratedFieldSchemas>> {
  if (generators === undefined) return {};
  const schemaPath = ["schemas"] as const;
  for (const operation of ["select", "insert", "update"] as const) {
    if (typeof generators[operation] !== "function") {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-schema-generator",
          [...schemaPath, operation],
          `Drizzle ${operation} schema generator must be a function`,
        ),
      );
    }
  }
  if (
    typeof generators.select !== "function" ||
    typeof generators.insert !== "function" ||
    typeof generators.update !== "function"
  ) {
    return {};
  }

  const callbackIssueCount = issues.length;
  const values = {
    select: callSchemaGenerator("select", generators.select, table, schemaPath, issues),
    insert: callSchemaGenerator("insert", generators.insert, table, schemaPath, issues),
    update: callSchemaGenerator("update", generators.update, table, schemaPath, issues),
  };
  if (issues.length > callbackIssueCount) return {};
  const families = Object.values(values).map(generatedSchemaFamily);
  if (families.some((family) => family === undefined)) {
    issues.push(
      drizzleDefinitionIssue(
        "unsupported-schema-family",
        schemaPath,
        "Drizzle schema generators must return supported Zod or Valibot object schemas",
      ),
    );
    return {};
  }
  const family = families[0];
  if (family === undefined || families.some((candidate) => candidate !== family)) {
    issues.push(
      drizzleDefinitionIssue(
        "unsupported-schema-family",
        schemaPath,
        "Drizzle select, insert, and update schemas must use one supported family",
      ),
    );
    return {};
  }
  for (const [operation, value] of Object.entries(values)) {
    if (!isFieldSchema(value)) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-generated-schema",
          [...schemaPath, operation],
          `Drizzle generated ${operation} object is not a Standard Schema V1 value`,
        ),
      );
    }
  }

  const maps = {
    select: generatedSchemaFields(values.select, family),
    insert: generatedSchemaFields(values.insert, family),
    update: generatedSchemaFields(values.update, family),
  };
  if (maps.select === undefined || maps.insert === undefined || maps.update === undefined) {
    issues.push(
      drizzleDefinitionIssue(
        "invalid-generated-schema",
        schemaPath,
        "Drizzle schema generators returned malformed object field maps",
      ),
    );
    return {};
  }

  const allNames = Object.keys(columns);
  const writableNames = writableColumnNames(columns);
  const mapEntries: readonly (readonly ["select" | "insert" | "update", RuntimeMap])[] = [
    ["select", maps.select],
    ["insert", maps.insert],
    ["update", maps.update],
  ];
  for (const [operation, map] of mapEntries) {
    const expected = operation === "select" ? allNames : writableNames;
    if (!sameKeys(map, expected)) {
      issues.push(
        drizzleDefinitionIssue(
          "incompatible-generated-schema",
          [...schemaPath, operation],
          `Drizzle generated ${operation} schema fields do not match the final table`,
        ),
      );
    }
    for (const [fieldName, schema] of Object.entries(map)) {
      if (!isFieldSchema(schema)) {
        issues.push(
          drizzleDefinitionIssue(
            "invalid-generated-schema",
            [...schemaPath, operation, fieldName],
            `Drizzle generated ${operation} field '${fieldName}' is not a Standard Schema V1 value`,
          ),
        );
      }
    }
  }

  const generated: Record<string, GeneratedFieldSchemas> = {};
  for (const name of allNames) {
    const select = Reflect.get(maps.select, name);
    const create = Reflect.get(maps.insert, name) ?? omittedGeneratedWriteSchema;
    const update = Reflect.get(maps.update, name) ?? omittedGeneratedWriteSchema;
    if (isFieldSchema(select) && isFieldSchema(create) && isFieldSchema(update)) {
      generated[name] = Object.freeze({ select, create, update });
    }
  }
  return Object.freeze(generated);
}

function validateFinalDefinitionSchemas(
  definition: RecordDefinition,
  columns: RuntimeMap,
  dialect: DrizzleDefinitionDialectAdapter["dialect"],
  recordName: string,
  issues: DrizzleDefinitionIssue[],
): void {
  for (const [fieldName, field] of Object.entries(definition.fields)) {
    const select = isFieldSchema(field) ? field : field.select;
    const create = isFieldSchema(field) ? field : (field.create ?? field.select);
    const update = isFieldSchema(field) ? field : (field.update ?? field.create ?? field.select);
    validateGeneratedFieldRoundTrip(fieldName, select, create, update, issues);
    const asyncOperations = new Set<"select" | "insert" | "update">();
    for (const [operation, schema] of [
      ["select", select],
      ["insert", create],
      ["update", update],
    ] as const) {
      try {
        const validation = schema["~standard"].validate(undefined);
        if (validation instanceof Promise) {
          void validation.catch(() => undefined);
          asyncOperations.add(operation);
          issues.push(
            drizzleDefinitionIssue(
              "invalid-generated-schema",
              ["records", recordName, "fields", fieldName, operation],
              `Drizzle ${operation} Field Schema '${recordName}.${fieldName}' must validate synchronously during definition`,
            ),
          );
        }
      } catch {
        // Invalid representative inputs are handled only when a synchronous validator accepts a usable value.
      }
    }
    validateRepresentativeFieldValues(
      recordName,
      fieldName,
      Reflect.get(columns, fieldName),
      dialect,
      select,
      create,
      update,
      asyncOperations,
      issues,
    );
  }
}

function representativeDriverValue(
  column: unknown,
  dialect: DrizzleDefinitionDialectAdapter["dialect"],
): unknown {
  if (!isRecordContainer(column)) return undefined;
  const enumValues = Reflect.get(column, "enumValues");
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];
  switch (Reflect.get(column, "dataType")) {
    case "array":
      return "{}";
    case "bigint":
      return "1";
    case "boolean":
      return dialect === "postgres" ? true : 1;
    case "buffer":
      return new Uint8Array();
    case "date":
      return dialect === "sqlite" ? 0 : "2020-01-02 03:04:05.000";
    case "custom":
      return "sample";
    case "json":
      return "{}";
    case "number":
      return dialect === "sqlite" ? 1 : "1";
    case "string":
      return "sample";
    default:
      return undefined;
  }
}

type SynchronousSchemaResult =
  | { readonly kind: "async" }
  | { readonly kind: "failure" }
  | { readonly kind: "success"; readonly value: unknown };

function synchronousSchemaResult(schema: FieldSchema, input: unknown): SynchronousSchemaResult {
  try {
    const result = schema["~standard"].validate(input);
    if (result instanceof Promise) {
      void result.catch(() => undefined);
      return { kind: "async" };
    }
    if (!isRecordContainer(result) || "issues" in result) return { kind: "failure" };
    return { kind: "success", value: Reflect.get(result, "value") };
  } catch {
    return { kind: "failure" };
  }
}

function jsonValueType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function validateRepresentativeFieldValues(
  recordName: string,
  fieldName: string,
  column: unknown,
  dialect: DrizzleDefinitionDialectAdapter["dialect"],
  select: FieldSchema,
  create: FieldSchema,
  update: FieldSchema,
  knownAsyncOperations: ReadonlySet<"select" | "insert" | "update">,
  issues: DrizzleDefinitionIssue[],
): void {
  const driverValue = representativeDriverValue(column, dialect);
  if (driverValue === undefined || !isRecordContainer(column)) return;
  const mapFromDriverValue = Reflect.get(column, "mapFromDriverValue");
  if (typeof mapFromDriverValue !== "function") return;
  let mappedValue: unknown;
  try {
    mappedValue = Reflect.apply(mapFromDriverValue, column, [driverValue]);
  } catch {
    return;
  }
  const selectedInput = synchronousSchemaResult(select, mappedValue);
  if (selectedInput.kind === "failure") {
    const selectInputTypes = standardJsonSchemaTypes(select, "input").types;
    if (
      !isJsonValue(mappedValue) ||
      (selectInputTypes !== undefined && !selectInputTypes.has(jsonValueType(mappedValue)))
    ) {
      issues.push(
        drizzleDefinitionIssue(
          "incompatible-drizzle-column",
          ["records", recordName, "fields", fieldName, "column"],
          `Drizzle column '${recordName}.${fieldName}' returns values incompatible with its Select Field Schema`,
        ),
      );
    }
  }
  for (const [operation, schema] of [
    ["select", select],
    ["insert", create],
    ["update", update],
  ] as const) {
    if (schema === omittedGeneratedWriteSchema) continue;
    let schemaInput = mappedValue;
    let firstResult = synchronousSchemaResult(schema, schemaInput);
    let hasSchemaRepresentative = false;
    if (firstResult.kind === "failure" && operation !== "select") {
      const jsonSchemaCandidate = standardJsonSchemaInputRepresentative(schema);
      const structuralCandidate = structuralSchemaInputRepresentative(schema);
      hasSchemaRepresentative = jsonSchemaCandidate.found || structuralCandidate.found;
      const candidates: readonly unknown[] = [
        ...(jsonSchemaCandidate.found ? [jsonSchemaCandidate.value] : []),
        ...(structuralCandidate.found ? [structuralCandidate.value] : []),
        "sample",
        1,
        true,
        null,
        {},
        [],
        undefined,
      ];
      for (const candidate of candidates) {
        if (Object.is(candidate, mappedValue)) continue;
        const candidateResult = synchronousSchemaResult(schema, candidate);
        if (candidateResult.kind !== "failure") {
          schemaInput = candidate;
          firstResult = candidateResult;
          break;
        }
      }
    }
    if (firstResult.kind === "async") {
      if (!knownAsyncOperations.has(operation)) {
        issues.push(
          drizzleDefinitionIssue(
            "invalid-generated-schema",
            ["records", recordName, "fields", fieldName, operation],
            `Drizzle ${operation} Field Schema '${recordName}.${fieldName}' must validate synchronously during definition`,
          ),
        );
      }
      continue;
    }
    if (firstResult.kind === "failure") {
      if (hasSchemaRepresentative) {
        issues.push(
          drizzleDefinitionIssue(
            "incompatible-generated-schema",
            ["records", recordName, "fields", fieldName, operation],
            `Drizzle ${operation} Field Schema '${recordName}.${fieldName}' has no verifiable constrained input`,
          ),
        );
      }
      continue;
    }
    const secondResult = synchronousSchemaResult(schema, schemaInput);
    if (secondResult.kind === "async") {
      if (!knownAsyncOperations.has(operation)) {
        issues.push(
          drizzleDefinitionIssue(
            "invalid-generated-schema",
            ["records", recordName, "fields", fieldName, operation],
            `Drizzle ${operation} Field Schema '${recordName}.${fieldName}' must validate synchronously during definition`,
          ),
        );
      }
      continue;
    }
    if (secondResult.kind === "failure") continue;
    const first = firstResult.value;
    const second = secondResult.value;
    if (!isJsonValue(first) || !isJsonValue(second)) {
      issues.push(
        drizzleDefinitionIssue(
          "incompatible-generated-schema",
          ["records", recordName, "fields", fieldName, operation],
          `Drizzle ${operation} Field Schema '${recordName}.${fieldName}' must produce a JSON value`,
        ),
      );
      continue;
    }
    if (!structuralJsonEqual(first, second)) {
      issues.push(
        drizzleDefinitionIssue(
          "incompatible-generated-schema",
          ["records", recordName, "fields", fieldName, operation],
          `Drizzle ${operation} Field Schema '${recordName}.${fieldName}' must produce a stable JSON value`,
        ),
      );
      continue;
    }
    const selected = synchronousSchemaResult(select, first);
    if (selected.kind === "async") {
      if (!knownAsyncOperations.has("select")) {
        issues.push(
          drizzleDefinitionIssue(
            "invalid-generated-schema",
            ["records", recordName, "fields", fieldName, operation],
            `Drizzle Select Field Schema '${recordName}.${fieldName}' must validate synchronously during round-trip checks`,
          ),
        );
      }
    } else if (selected.kind === "failure") {
      issues.push(
        drizzleDefinitionIssue(
          "incompatible-generated-schema",
          ["records", recordName, "fields", fieldName, operation],
          `Drizzle ${operation} Field Schema '${recordName}.${fieldName}' cannot round-trip through select`,
        ),
      );
    } else if (!isJsonValue(selected.value)) {
      issues.push(
        drizzleDefinitionIssue(
          "incompatible-generated-schema",
          ["records", recordName, "fields", fieldName, operation],
          `Drizzle ${operation} Field Schema '${recordName}.${fieldName}' cannot round-trip through select`,
        ),
      );
    } else if (operation !== "select") {
      const mapToDriverValue = Reflect.get(column, "mapToDriverValue");
      if (typeof mapToDriverValue !== "function") continue;
      try {
        const encoded = Reflect.apply(mapToDriverValue, column, [first]);
        const decoded = Reflect.apply(mapFromDriverValue, column, [encoded]);
        const selectedRoundTrip = synchronousSchemaResult(select, decoded);
        if (
          selectedRoundTrip.kind !== "success" ||
          !isJsonValue(selectedRoundTrip.value) ||
          !structuralJsonEqual(selected.value, selectedRoundTrip.value)
        ) {
          issues.push(
            drizzleDefinitionIssue(
              "incompatible-drizzle-column",
              ["records", recordName, "fields", fieldName, "column", operation],
              `Drizzle column '${recordName}.${fieldName}' cannot round-trip its ${operation} Field Schema output`,
            ),
          );
        }
      } catch (cause) {
        issues.push(
          drizzleDefinitionIssue(
            "incompatible-drizzle-column",
            ["records", recordName, "fields", fieldName, "column", operation],
            `Drizzle column '${recordName}.${fieldName}' cannot encode its ${operation} Field Schema output: ${callbackMessage(cause)}`,
            { cause },
          ),
        );
      }
    }
  }
}

function normalizeDirectTableDefinition(
  recordName: string,
  columns: RuntimeMap,
  generated: Readonly<Record<string, GeneratedFieldSchemas>>,
  staticOverride: RecordOverride<RecordDefinition> | undefined,
  suppressMissingSchemaIssues: boolean,
  issues: DrizzleDefinitionIssue[],
): RecordDefinition | undefined {
  const fields: Record<string, FieldDefinition> = {};
  const staticFields = isRecordContainer(staticOverride?.fields) ? staticOverride.fields : {};
  for (const fieldName of Object.keys(staticFields)) {
    if (!Object.hasOwn(columns, fieldName)) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-drizzle-override",
          ["overrides", recordName, "fields", fieldName],
          `Static Field override '${recordName}.${fieldName}' has no final table column`,
        ),
      );
    }
  }
  for (const fieldName of Object.keys(columns)) {
    const generatedField = generated[fieldName];
    const staticField = Reflect.get(staticFields, fieldName);
    if (staticField === undefined) {
      if (generatedField === undefined) {
        if (!suppressMissingSchemaIssues) {
          issues.push(
            drizzleDefinitionIssue(
              "schema-generators-required",
              ["records", recordName, "fields", fieldName],
              `Drizzle table field '${recordName}.${fieldName}' requires static schemas or schema generators`,
            ),
          );
        }
      } else if (columnNeedsStaticJsonSchema(Reflect.get(columns, fieldName))) {
        issues.push(
          drizzleDefinitionIssue(
            "incompatible-generated-schema",
            ["records", recordName, "fields", fieldName],
            `Drizzle generated field '${recordName}.${fieldName}' selects a non-JSON value and requires a static schema`,
          ),
        );
      } else {
        fields[fieldName] = generatedField;
      }
      continue;
    }
    if (isFieldSchema(staticField)) {
      fields[fieldName] = staticField;
      continue;
    }
    if (!isRecordContainer(staticField)) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-drizzle-override",
          ["overrides", recordName, "fields", fieldName],
          `Static Field override '${recordName}.${fieldName}' is invalid`,
        ),
      );
      continue;
    }
    const select = Reflect.get(staticField, "select") ?? generatedField?.select;
    const createValue = Reflect.get(staticField, "create");
    const create =
      createValue === null ? select : (createValue ?? generatedField?.create ?? select);
    const updateValue = Reflect.get(staticField, "update");
    const update =
      updateValue === null ? create : (updateValue ?? generatedField?.update ?? create);
    if (!isFieldSchema(select) || !isFieldSchema(create) || !isFieldSchema(update)) {
      issues.push(
        drizzleDefinitionIssue(
          "schema-generators-required",
          ["overrides", recordName, "fields", fieldName],
          `Static Field override '${recordName}.${fieldName}' does not provide a complete schema contract`,
        ),
      );
      continue;
    }
    fields[fieldName] = Object.freeze({ select, create, update });
  }
  return Object.keys(fields).length === Object.keys(columns).length
    ? Object.freeze({ fields: Object.freeze(fields) })
    : undefined;
}

function addGeneratedMissingFields(
  definition: RecordDefinition,
  columns: RuntimeMap,
  generated: Readonly<Record<string, GeneratedFieldSchemas>>,
  recordName: string,
  suppressMissingSchemaIssues: boolean,
  issues: DrizzleDefinitionIssue[],
): RecordDefinition | undefined {
  const fieldNames = Object.keys(definition.fields);
  const columnNames = Object.keys(columns);
  for (const fieldName of fieldNames) {
    if (!Object.hasOwn(columns, fieldName)) {
      issues.push(
        drizzleDefinitionIssue(
          "incompatible-drizzle-table",
          ["records", recordName, "fields", fieldName],
          `Drizzle table omits effective Record field '${recordName}.${fieldName}'`,
        ),
      );
    }
  }
  const fields: Record<string, FieldDefinition> = { ...definition.fields };
  for (const columnName of columnNames) {
    if (Object.hasOwn(fields, columnName)) continue;
    const field = generated[columnName];
    if (field === undefined) {
      if (!suppressMissingSchemaIssues) {
        issues.push(
          drizzleDefinitionIssue(
            "schema-generators-required",
            ["records", recordName, "fields", columnName],
            `Drizzle column '${recordName}.${columnName}' requires schema generators`,
          ),
        );
      }
    } else if (columnNeedsStaticJsonSchema(Reflect.get(columns, columnName))) {
      issues.push(
        drizzleDefinitionIssue(
          "incompatible-generated-schema",
          ["records", recordName, "fields", columnName],
          `Drizzle generated field '${recordName}.${columnName}' selects a non-JSON value and requires a static schema`,
        ),
      );
    } else {
      fields[columnName] = field;
    }
  }
  return fieldNames.every((name) => Object.hasOwn(columns, name)) &&
    Object.keys(fields).length === columnNames.length
    ? Object.freeze({ ...definition, fields: Object.freeze(fields) })
    : undefined;
}

function lowerPrimaryKeyFields(definition: RecordDefinition): readonly string[] | undefined {
  const table = Reflect.get(definition, "table");
  if (!isRecordContainer(table)) return undefined;
  const value = Reflect.get(table, "primaryKey");
  return Array.isArray(value) && value.every((field) => typeof field === "string")
    ? value
    : undefined;
}

function explicitMetadataContainer(
  definition: RecordDefinition,
  fieldName: string,
  dialect: "postgres" | "mysql" | "sqlite",
):
  | {
      readonly portable: RuntimeMap;
      readonly concrete: RuntimeMap;
    }
  | undefined {
  const field = Reflect.get(definition.fields, fieldName);
  if (!isRecordContainer(field)) return undefined;
  const portable = Reflect.get(field, "column");
  if (!isRecordContainer(portable)) return undefined;
  const concrete = Reflect.get(portable, dialect);
  return {
    portable,
    concrete: isRecordContainer(concrete) ? concrete : {},
  };
}

function hasExplicitMetadataProperty(
  metadata: ReturnType<typeof explicitMetadataContainer>,
  property: string,
): boolean {
  if (metadata === undefined) return false;
  if (Object.hasOwn(metadata.concrete, property)) {
    return Reflect.get(metadata.concrete, property) !== null;
  }
  return (
    Object.hasOwn(metadata.portable, property) && Reflect.get(metadata.portable, property) !== null
  );
}

function drizzleColumnFact(column: unknown, property: string): unknown {
  if (!isRecordContainer(column)) return undefined;
  if (property === "type") {
    const getSqlType = Reflect.get(column, "getSQLType");
    return typeof getSqlType === "function" ? Reflect.apply(getSqlType, column, []) : undefined;
  }
  if (property === "identity") return Reflect.get(column, "generatedIdentity");
  if (property === "autoIncrement") return Reflect.get(column, "autoIncrement");
  if (property === "onUpdate") return Reflect.get(column, "hasOnUpdateNow");
  if (property === "rowid") {
    return Object.freeze({
      primary: Reflect.get(column, "primary"),
      autoIncrement: Reflect.get(column, "autoIncrement"),
    });
  }
  if (property === "default") {
    return Object.freeze({
      hasDefault: Reflect.get(column, "hasDefault"),
      value: Reflect.get(column, "default"),
    });
  }
  return Reflect.get(column, property);
}

function equalDrizzleFact(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!isRecordContainer(left) || !isRecordContainer(right)) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => equalDrizzleFact(value, Reflect.get(right, key)))
  );
}

function validateExplicitLowerTierCompatibility(
  recordName: string,
  definition: RecordDefinition,
  expectedTable: object,
  finalTable: object,
  adapter: DrizzleDefinitionDialectAdapter,
  builderOverrides: RuntimeMap,
  overridden: boolean,
  issues: DrizzleDefinitionIssue[],
): void {
  const expectedColumns = adapter.getColumns(expectedTable);
  const finalColumns = adapter.getColumns(finalTable);
  const properties = [
    "name",
    "type",
    "notNull",
    "default",
    "generated",
    ...(adapter.dialect === "postgres" ? ["identity"] : []),
    ...(adapter.dialect === "mysql" ? ["autoIncrement", "onUpdate"] : []),
    ...(adapter.dialect === "sqlite" ? ["rowid"] : []),
  ];
  for (const fieldName of Object.keys(definition.fields)) {
    const metadata = explicitMetadataContainer(definition, fieldName, adapter.dialect);
    for (const property of properties) {
      if (!hasExplicitMetadataProperty(metadata, property)) continue;
      const expected = drizzleColumnFact(Reflect.get(expectedColumns, fieldName), property);
      const actual = drizzleColumnFact(Reflect.get(finalColumns, fieldName), property);
      if (!equalDrizzleFact(expected, actual)) {
        issues.push(
          drizzleDefinitionIssue(
            "incompatible-drizzle-column",
            [
              overridden ? "overrides" : "records",
              recordName,
              "fields",
              fieldName,
              "column",
              ...(Object.hasOwn(builderOverrides, fieldName) ? [] : [adapter.dialect]),
              property,
            ],
            `${adapter.label} Drizzle column '${recordName}.${fieldName}' conflicts with explicit lower-tier ${property} metadata`,
          ),
        );
      }
    }
  }

  const table = Reflect.get(definition, "table");
  const concreteTable = isRecordContainer(table) ? Reflect.get(table, adapter.dialect) : undefined;
  const hasExplicitTableIdentity =
    isRecordContainer(table) &&
    (Object.hasOwn(table, "name") ||
      (isRecordContainer(concreteTable) &&
        ["name", "schema", "database"].some(
          (property) =>
            Object.hasOwn(concreteTable, property) && Reflect.get(concreteTable, property) !== null,
        )));
  if (
    hasExplicitTableIdentity &&
    !equalDrizzleFact(
      Object.freeze(Object.fromEntries(adapter.getTableIdentity(expectedTable).entries())),
      Object.freeze(Object.fromEntries(adapter.getTableIdentity(finalTable).entries())),
    )
  ) {
    issues.push(
      drizzleDefinitionIssue(
        "incompatible-drizzle-table",
        [overridden ? "overrides" : "records", recordName, "table"],
        `${adapter.label} Drizzle table '${recordName}' conflicts with explicit lower-tier physical identity`,
      ),
    );
  }
}

function applyOneStaticOverride(
  recordName: string,
  definition: RecordDefinition,
  staticOverride: RecordOverride<RecordDefinition> | undefined,
  issues: DrizzleDefinitionIssue[],
): RecordDefinition | undefined {
  if (staticOverride === undefined) return definition;
  try {
    const records: RecordDefinitions = { [recordName]: definition };
    const overrides: RecordOverrides<RecordDefinitions> = { [recordName]: staticOverride };
    const applyRuntimeOverrides = applyRecordOverrides as unknown as (
      definitions: RecordDefinitions,
      recordOverrides: RecordOverrides<RecordDefinitions>,
    ) => RecordDefinitions;
    // SAFETY: Runtime Store validation owns compatibility; this call preserves the one known key.
    return Reflect.get(applyRuntimeOverrides(records, overrides), recordName) as RecordDefinition;
  } catch (cause) {
    issues.push(
      drizzleDefinitionIssue(
        "invalid-drizzle-override",
        ["overrides", recordName],
        `Drizzle Record override is invalid: ${callbackMessage(cause)}`,
        { cause },
      ),
    );
    return undefined;
  }
}

function validateHooks(
  hooks: unknown,
  definitions: RecordDefinitions,
  tables: RuntimeMap,
  adapter: DrizzleDefinitionDialectAdapter,
  kind: "store" | "thread-store",
  issues: DrizzleDefinitionIssue[],
): RuntimeMap {
  const hookMap = isRecordContainer(hooks) ? hooks : {};
  if (kind === "thread-store") {
    for (const [recordName, definition] of Object.entries(definitions)) {
      if (
        recordName === "thread" ||
        recordName === "branch" ||
        recordName === "run" ||
        !Object.hasOwn(coreRecordDefinitions, recordName)
      ) {
        continue;
      }
      const coreDefinition = Reflect.get(coreRecordDefinitions, recordName);
      if (!isRecordDefinition(coreDefinition)) continue;
      const table = Reflect.get(tables, recordName);
      const columns = isRecordContainer(table) ? adapter.getColumns(table) : {};
      const needsHook = Object.entries(definition.fields).some(([fieldName, field]) => {
        if (Object.hasOwn(coreDefinition.fields, fieldName)) return false;
        const column = Reflect.get(columns, fieldName);
        if (
          isRecordContainer(column) &&
          (Reflect.get(column, "hasDefault") === true ||
            Reflect.get(column, "generated") !== undefined ||
            Reflect.get(column, "generatedIdentity") !== undefined ||
            Reflect.get(column, "autoIncrement") === true)
        ) {
          return false;
        }
        const create = isFieldSchema(field) ? field : (field.create ?? field.select);
        try {
          const result = create["~standard"].validate(undefined);
          if (result instanceof Promise) {
            void result.catch(() => undefined);
            return true;
          }
          return !isRecordContainer(result) || "issues" in result;
        } catch {
          return true;
        }
      });
      if (needsHook && !Object.hasOwn(hookMap, recordName)) {
        issues.push(
          drizzleDefinitionIssue(
            "invalid-before-create-hook",
            ["hooks", recordName],
            `Drizzle Before Create Hook '${recordName}' is required for custom Core create fields`,
          ),
        );
      }
    }
  }
  if (hooks === undefined) return Object.freeze({});
  if (!isRecordContainer(hooks)) {
    issues.push(
      drizzleDefinitionIssue(
        "invalid-before-create-hook",
        ["hooks"],
        "Drizzle Before Create Hooks must be an object",
      ),
    );
    return Object.freeze({});
  }
  for (const [recordName, hook] of Object.entries(hooks)) {
    if (!Object.hasOwn(definitions, recordName)) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-before-create-hook",
          ["hooks", recordName],
          `Drizzle Before Create Hook '${recordName}' has no Record`,
        ),
      );
      continue;
    }
    if (!isRecordContainer(hook) || typeof Reflect.get(hook, "beforeCreate") !== "function") {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-before-create-hook",
          ["hooks", recordName],
          `Drizzle Before Create Hook '${recordName}' must define beforeCreate`,
        ),
      );
    }
  }
  return Object.freeze({ ...hooks });
}

/** Execute the shared connection-free definition lifecycle for one concrete dialect. */
export function defineDrizzleDialectStore(
  options: unknown,
  adapter: DrizzleDefinitionDialectAdapter,
  kind: "store" | "thread-store",
): object {
  const issues: DrizzleDefinitionIssue[] = [];
  if (!isRecordContainer(options)) {
    throw new DrizzleDefinitionError([
      drizzleDefinitionIssue(
        "invalid-drizzle-override",
        [],
        "Drizzle definition options must be an object",
      ),
    ]);
  }
  const inputsValue = Reflect.get(options, "records");
  if (!isRecordContainer(inputsValue)) {
    throw new DrizzleDefinitionError([
      drizzleDefinitionIssue(
        "invalid-drizzle-table",
        ["records"],
        "Drizzle records must be an object",
      ),
    ]);
  }
  const overridesValue = Reflect.get(options, "overrides");
  const overrides = isRecordContainer(overridesValue) ? overridesValue : {};
  if (overridesValue !== undefined && !isRecordContainer(overridesValue)) {
    issues.push(
      drizzleDefinitionIssue(
        "invalid-drizzle-override",
        ["overrides"],
        "Drizzle overrides must be an object",
      ),
    );
  }
  const allowedOverrideNames = new Set(Object.keys(inputsValue));
  if (kind === "thread-store") {
    for (const recordName of Object.keys(coreRecordDefinitions)) {
      allowedOverrideNames.add(recordName);
    }
  }
  for (const recordName of Object.keys(overrides)) {
    if (!allowedOverrideNames.has(recordName)) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-drizzle-override",
          ["overrides", recordName],
          `Drizzle Record override '${recordName}' has no contribution`,
        ),
      );
    }
  }
  const generatorsValue = Reflect.get(options, "schemas");
  const generators = isRecordContainer(generatorsValue)
    ? // SAFETY: generateFieldSchemas validates all three callback members before invocation.
      (generatorsValue as unknown as DrizzleSchemaGenerators<object>)
    : undefined;
  if (generatorsValue !== undefined && generators === undefined) {
    issues.push(
      drizzleDefinitionIssue(
        "invalid-schema-generator",
        ["schemas"],
        "Drizzle schemas must be an object",
      ),
    );
  }

  const definitions = new Map<string, RecordDefinition>();
  const tables = new Map<string, object>();
  const recordReferences = new Map<string, SqlRecordReference<RecordDefinition>>();
  const generatedAssets: Array<readonly [string, object]> = [];

  for (const [recordName, input] of Object.entries(inputsValue)) {
    const recordIssuesBefore = issues.length;
    const override = readRecordOverride(
      Reflect.get(overrides, recordName),
      adapter,
      ["overrides", recordName],
      issues,
    );
    const inputIsTable = adapter.isTable(input);
    if (!inputIsTable && !isRecordDefinition(input)) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-drizzle-table",
          ["records", recordName],
          `${adapter.label} Drizzle Record input must be a lower-tier Record or matching table`,
        ),
      );
      continue;
    }
    // SAFETY: inputIsTable is the concrete adapter's runtime table guard.
    const suppliedTable = override.table ?? (inputIsTable ? (input as object) : undefined);
    if (inputIsTable) {
      if (Object.keys(override.builders).length > 0) {
        issues.push(
          drizzleDefinitionIssue(
            "invalid-drizzle-override",
            ["overrides", recordName, "fields"],
            `${adapter.label} complete table input cannot be combined with column builders`,
          ),
        );
      }
      for (const key of Object.keys(override.staticOverride ?? {}).filter(
        (candidate) => candidate !== "fields",
      )) {
        issues.push(
          drizzleDefinitionIssue(
            "invalid-drizzle-override",
            ["overrides", recordName, key],
            `${adapter.label} direct-table override property '${key}' is not supported`,
          ),
        );
      }
    }
    let lowerDefinition: RecordDefinition | undefined;
    let generatedTable: GeneratedDrizzleTable | undefined;
    let baselineGeneratedTable: GeneratedDrizzleTable | undefined;
    if (!inputIsTable) {
      lowerDefinition = applyOneStaticOverride(
        recordName,
        // SAFETY: inputIsTable false and the input validation above prove this is a Record Definition.
        input as RecordDefinition,
        override.staticOverride,
        issues,
      );
      if (lowerDefinition !== undefined) {
        try {
          baselineGeneratedTable = adapter.generateTable(recordName, lowerDefinition, {});
          generatedTable =
            Object.keys(override.builders).length === 0
              ? baselineGeneratedTable
              : adapter.generateTable(recordName, lowerDefinition, override.builders);
          if (generatedTable.assets !== undefined) generatedAssets.push(...generatedTable.assets);
        } catch (cause) {
          if (!absorbSqlDefinitionError(cause, issues)) {
            issues.push(
              drizzleDefinitionIssue(
                "invalid-drizzle-table",
                ["records", recordName],
                `${adapter.label} table generation failed: ${callbackMessage(cause)}`,
                { cause },
              ),
            );
          }
        }
      }
    }
    const table = suppliedTable ?? generatedTable?.table;
    if (table === undefined || !adapter.isTable(table)) {
      if (issues.length === recordIssuesBefore) {
        issues.push(
          drizzleDefinitionIssue(
            "invalid-drizzle-table",
            ["records", recordName],
            `${adapter.label} final table could not be materialized`,
          ),
        );
      }
      continue;
    }
    const columns = adapter.getColumns(table);
    if (
      lowerDefinition !== undefined &&
      baselineGeneratedTable !== undefined &&
      (suppliedTable !== undefined || Object.keys(override.builders).length > 0)
    ) {
      validateExplicitLowerTierCompatibility(
        recordName,
        lowerDefinition,
        baselineGeneratedTable.table,
        table,
        adapter,
        override.builders,
        true,
        issues,
      );
    }
    if (!inputIsTable && suppliedTable !== undefined && lowerDefinition !== undefined) {
      const expectedPrimaryKey = lowerPrimaryKeyFields(lowerDefinition);
      const suppliedPrimaryKey = adapter.getPrimaryKeyFields(table);
      if (
        expectedPrimaryKey !== undefined &&
        (expectedPrimaryKey.length !== suppliedPrimaryKey.length ||
          expectedPrimaryKey.some((field, index) => suppliedPrimaryKey[index] !== field))
      ) {
        issues.push(
          drizzleDefinitionIssue(
            "incompatible-drizzle-table",
            ["overrides", recordName, "table"],
            `Drizzle table primary key does not match lower-tier Record '${recordName}'`,
          ),
        );
      }
    }
    const generatorIssueCount = issues.length;
    const generatedFields = generateFieldSchemas(table, columns, generators, issues);
    const suppressMissingSchemaIssues =
      generators !== undefined && issues.length > generatorIssueCount;
    const definition = inputIsTable
      ? normalizeDirectTableDefinition(
          recordName,
          columns,
          generatedFields,
          override.staticOverride,
          suppressMissingSchemaIssues,
          issues,
        )
      : lowerDefinition === undefined
        ? undefined
        : addGeneratedMissingFields(
            lowerDefinition,
            columns,
            generatedFields,
            recordName,
            suppressMissingSchemaIssues,
            issues,
          );
    if (definition === undefined) continue;
    validateFinalDefinitionSchemas(definition, columns, adapter.dialect, recordName, issues);
    definitions.set(recordName, definition);
    tables.set(recordName, table);
    recordReferences.set(recordName, adapter.createRecordReference(table, definition));
  }

  let effectiveDefinitions = Object.freeze(Object.fromEntries(definitions));
  if (kind === "thread-store") {
    const coreOverrides = new Map<string, ReturnType<typeof readRecordOverride>>();
    const coreStaticOverrides: Record<string, RecordOverride<RecordDefinition>> = {};
    for (const recordName of Object.keys(coreRecordDefinitions)) {
      const parsed = readRecordOverride(
        Reflect.get(overrides, recordName),
        adapter,
        ["overrides", recordName],
        issues,
      );
      coreOverrides.set(recordName, parsed);
      if (parsed.staticOverride !== undefined) {
        coreStaticOverrides[recordName] = parsed.staticOverride;
      }
    }
    try {
      // SAFETY: Host inputs have already been normalized to complete Record Definitions and duplicate Core names are checked by Core.
      effectiveDefinitions = composeThreadStoreRecordDefinitions({
        records: effectiveDefinitions,
        ...(Object.keys(coreStaticOverrides).length === 0
          ? {}
          : { overrides: coreStaticOverrides }),
      } as never);
      const finalDefinitions: Record<string, RecordDefinition> = {
        ...effectiveDefinitions,
      };
      for (const [recordName, definition] of Object.entries(effectiveDefinitions)) {
        if (tables.has(recordName)) continue;
        const parsedOverride = coreOverrides.get(recordName) ?? { builders: {} };
        try {
          const baselineGenerated = adapter.generateTable(recordName, definition, {});
          const generated =
            Object.keys(parsedOverride.builders).length === 0
              ? baselineGenerated
              : adapter.generateTable(recordName, definition, parsedOverride.builders);
          const table = parsedOverride.table ?? generated.table;
          if (
            parsedOverride.table !== undefined ||
            Object.keys(parsedOverride.builders).length > 0
          ) {
            validateExplicitLowerTierCompatibility(
              recordName,
              definition,
              baselineGenerated.table,
              table,
              adapter,
              parsedOverride.builders,
              true,
              issues,
            );
          }
          if (parsedOverride.table !== undefined) {
            const expectedPrimaryKey = lowerPrimaryKeyFields(definition);
            const suppliedPrimaryKey = adapter.getPrimaryKeyFields(table);
            if (
              expectedPrimaryKey !== undefined &&
              (expectedPrimaryKey.length !== suppliedPrimaryKey.length ||
                expectedPrimaryKey.some((field, index) => suppliedPrimaryKey[index] !== field))
            ) {
              issues.push(
                drizzleDefinitionIssue(
                  "incompatible-drizzle-table",
                  ["overrides", recordName, "table"],
                  `Drizzle table primary key does not match Core Record '${recordName}'`,
                ),
              );
            }
          }
          const columns = adapter.getColumns(table);
          const generatorIssueCount = issues.length;
          const generatedFields = generateFieldSchemas(table, columns, generators, issues);
          const finalDefinition = addGeneratedMissingFields(
            definition,
            columns,
            generatedFields,
            recordName,
            generators !== undefined && issues.length > generatorIssueCount,
            issues,
          );
          if (finalDefinition === undefined) continue;
          validateFinalDefinitionSchemas(
            finalDefinition,
            columns,
            adapter.dialect,
            recordName,
            issues,
          );
          finalDefinitions[recordName] = finalDefinition;
          tables.set(recordName, table);
          recordReferences.set(recordName, adapter.createRecordReference(table, finalDefinition));
          if (generated.assets !== undefined) generatedAssets.push(...generated.assets);
        } catch (cause) {
          if (!absorbSqlDefinitionError(cause, issues)) {
            issues.push(
              drizzleDefinitionIssue(
                "invalid-drizzle-table",
                ["records", recordName],
                `${adapter.label} Core table generation failed: ${callbackMessage(cause)}`,
                { cause },
              ),
            );
          }
        }
      }
      effectiveDefinitions = Object.freeze(finalDefinitions);
    } catch (cause) {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-drizzle-override",
          ["records"],
          `Thread Record composition failed: ${callbackMessage(cause)}`,
          { cause },
        ),
      );
    }
  }

  if (kind === "thread-store") {
    const orderedTables = Object.keys(effectiveDefinitions).flatMap((recordName) => {
      const table = tables.get(recordName);
      return table === undefined ? [] : ([[recordName, table]] as const);
    });
    const orderedReferences = Object.keys(effectiveDefinitions).flatMap((recordName) => {
      const reference = recordReferences.get(recordName);
      return reference === undefined ? [] : ([[recordName, reference]] as const);
    });
    tables.clear();
    recordReferences.clear();
    for (const [recordName, table] of orderedTables) tables.set(recordName, table);
    for (const [recordName, reference] of orderedReferences) {
      recordReferences.set(recordName, reference);
    }
  }

  const tableMap = Object.freeze(Object.fromEntries(tables));
  const hooks = validateHooks(
    Reflect.get(options, "hooks"),
    effectiveDefinitions,
    tableMap,
    adapter,
    kind,
    issues,
  );
  const assetEntries =
    adapter.finishAssets?.(tableMap, options, generatedAssets, issues) ?? generatedAssets;

  let relations: RuntimeMap = {};
  const relationsCallback = Reflect.get(options, "relations");
  if (relationsCallback !== undefined) {
    if (typeof relationsCallback !== "function") {
      issues.push(
        drizzleDefinitionIssue(
          "invalid-drizzle-relations",
          ["relations"],
          "Drizzle relations must be a callback",
        ),
      );
    } else if (tables.size === Object.keys(effectiveDefinitions).length) {
      try {
        const value = relationsCallback(tableMap);
        if (!isRecordContainer(value)) {
          issues.push(
            drizzleDefinitionIssue(
              "invalid-drizzle-relations",
              ["relations"],
              "Drizzle relations callback must return an object",
            ),
          );
        } else {
          relations = value;
          for (const [name, relation] of Object.entries(value)) {
            if (!is(relation, Relations)) {
              issues.push(
                drizzleDefinitionIssue(
                  "invalid-drizzle-relations",
                  ["relations", name],
                  `Drizzle relation '${name}' is not a Relations entity`,
                ),
              );
            }
          }
        }
      } catch (cause) {
        issues.push(
          drizzleDefinitionIssue(
            "invalid-drizzle-relations",
            ["relations"],
            `Drizzle relations callback failed: ${callbackMessage(cause)}`,
            { cause },
          ),
        );
      }
    }
  }

  const schemaEntries: Array<readonly [string, object]> = [...tables];
  const schemaKeys = new Set(schemaEntries.map(([key]) => key));
  // SAFETY: Dialect assets and validated relation-map values are runtime entities before success can return.
  for (const [key, value] of [...assetEntries, ...Object.entries(relations)] as readonly (readonly [
    string,
    object,
  ])[]) {
    if (schemaKeys.has(key)) {
      issues.push(
        drizzleDefinitionIssue(
          "duplicate-schema-key",
          ["schema", key],
          `Drizzle flat schema key '${key}' is duplicated`,
        ),
      );
    } else {
      schemaKeys.add(key);
      schemaEntries.push([key, value]);
    }
  }

  if (issues.length > 0) throw new DrizzleDefinitionError(issues);
  const records = Object.freeze(Object.fromEntries(recordReferences));
  const schema = Object.freeze(Object.fromEntries(schemaEntries));
  const state = Object.freeze({
    dialect: adapter.dialect,
    kind,
    definitions: effectiveDefinitions,
    tables: tableMap,
    hooks,
  });
  return Object.freeze({ records, schema, [drizzleDefinitionState]: state });
}

/** Create one opaque SQL Record reference from public table and column names. */
export function createDrizzleRecordReference(
  tableParts: readonly string[],
  columns: RuntimeMap,
): SqlRecordReference<RecordDefinition> {
  if (
    (tableParts.length !== 1 && tableParts.length !== 2) ||
    tableParts.some((part) => part.length === 0)
  ) {
    throw new TypeError("Drizzle Record reference requires one or two non-empty table parts");
  }
  const tableStatement =
    tableParts.length === 1
      ? sql.identifier(tableParts[0] ?? "")
      : sql`${sql.identifier(tableParts[0] ?? "")}.${sql.identifier(tableParts[1] ?? "")}`;
  const fields = Object.freeze(
    Object.fromEntries(
      Object.entries(columns).map(([fieldName, column]) => {
        const physicalName = isRecordContainer(column) ? Reflect.get(column, "name") : undefined;
        return [
          fieldName,
          sql.identifier(typeof physicalName === "string" ? physicalName : fieldName),
        ];
      }),
    ),
  );
  // SAFETY: This follows the public opaque SQL Record reference contract: one genuine Statement plus a frozen Field Statement map.
  // SAFETY: The table and every field reference were built through the public parameter-free SQL helper.
  return Object.freeze({ ...tableStatement, fields }) as SqlRecordReference<RecordDefinition>;
}
