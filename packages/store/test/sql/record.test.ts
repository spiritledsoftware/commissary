import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import {
  StoreRecord,
  isJsonValue,
  type CreateInput,
  type FieldSchema,
  type JsonValue,
  type SelectedRecord,
  type UpdateInput,
} from "@commissary/store";
import {
  SqlDefinitionError,
  SqlRecord,
  sql,
  type SqlColumnType,
  type SqlLiteral,
} from "@commissary/store/sql";
import { expect, expectTypeOf, it } from "vitest";

import { reflectSqlSelectStorage, resolvePortableSqlRecords } from "../../src/sql/record.js";

type SqlSchemaResult<Output> =
  | { readonly value: Output }
  | { readonly issues: readonly { readonly message: string }[] };

type SqlTestSchema<Input, Output extends JsonValue | undefined> = FieldSchema<Input, Output> &
  StandardJSONSchemaV1<Input, Output>;

function sqlTestSchema<Input, Output extends JsonValue | undefined>(
  validate: (value: unknown) => SqlSchemaResult<Output>,
  output: (target: StandardJSONSchemaV1.Target) => Record<string, unknown>,
): SqlTestSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-sql-record-test",
      validate,
      jsonSchema: {
        input: ({ target }) => output(target),
        output: ({ target }) => output(target),
      },
    },
  };
}

const stringField = sqlTestSchema<string, string>(
  (value) =>
    typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
  () => ({ type: "string" }),
);

const nullableStringField = sqlTestSchema<string | null, string | null>(
  (value) =>
    value === null || typeof value === "string"
      ? { value }
      : { issues: [{ message: "Expected a nullable string" }] },
  () => ({ type: ["string", "null"] }),
);

const integerField = sqlTestSchema<number, number>(
  (value) =>
    typeof value === "number" && Number.isSafeInteger(value)
      ? { value }
      : { issues: [{ message: "Expected a safe integer" }] },
  () => ({ type: "integer" }),
);

const jsonField = sqlTestSchema<JsonValue, JsonValue>(
  (value) => (isJsonValue(value) ? { value } : { issues: [{ message: "Expected a JSON value" }] }),
  () => ({ type: ["object", "array", "null"] }),
);

it("snapshots SQL Record containers without cloning or freezing Field Schemas", () => {
  const table = {
    name: "scheduled_jobs",
    primaryKey: ["id"] as ["id"],
    postgres: { schema: "jobs" },
  };
  const column = {
    name: "job_id",
    type: sql.text(),
    default: sql.literal("pending"),
    notNull: true,
  };
  const field = { select: stringField, column };
  const fields = { id: field };
  const source = { table, fields };
  const definition = SqlRecord.define(source);

  expect(definition).not.toBe(source);
  expect(definition.table).not.toBe(table);
  expect(definition.table?.primaryKey).not.toBe(table.primaryKey);
  expect(definition.fields).not.toBe(fields);
  expect(definition.fields.id).not.toBe(field);
  expect(definition.fields.id.column).not.toBe(column);
  expect(definition.fields.id.select).toBe(stringField);
  expect(Object.isFrozen(stringField)).toBe(false);
  expect(Object.isFrozen(definition)).toBe(true);
  expect(Object.isFrozen(definition.table)).toBe(true);
  expect(Object.isFrozen(definition.table?.primaryKey)).toBe(true);
  expect(Object.isFrozen(definition.table?.postgres)).toBe(true);
  expect(Object.isFrozen(definition.fields)).toBe(true);
  expect(Object.isFrozen(definition.fields.id)).toBe(true);
  expect(Object.isFrozen(definition.fields.id.column)).toBe(true);
  expect(Object.isFrozen(definition.fields.id.column?.type)).toBe(true);
  expect(Object.isFrozen(definition.fields.id.column?.default)).toBe(true);

  table.name = "mutated_jobs";
  table.primaryKey.push("id");
  column.name = "mutated_id";
  expect(definition.table?.name).toBe("scheduled_jobs");
  expect(definition.table?.primaryKey).toEqual(["id"]);
  expect(definition.fields.id.column?.name).toBe("job_id");
});

it("validates helper-owned names, metadata, opaque formats, and literal values", () => {
  const validLiterals = [
    "",
    "queued",
    -1.5,
    -0,
    0,
    1,
    Number.MAX_SAFE_INTEGER,
    true,
    false,
  ] as const;
  for (const value of validLiterals) {
    const literal = sql.literal(value);
    expect(Object.isFrozen(literal)).toBe(true);
    expectTypeOf(literal).toEqualTypeOf<SqlLiteral<typeof value>>();
  }

  for (const value of ["nul\0value", Number.NaN, Number.POSITIVE_INFINITY, 9_007_199_254_740_992]) {
    expect(() => sql.literal(value)).toThrow(TypeError);
  }
  for (const name of ["jobs", "Jobs", " jobs ", "é", "x".repeat(256)]) {
    expect(sql.table({ name }).name).toBe(name);
    expect(sql.column({ name }).name).toBe(name);
  }
  for (const name of ["", "bad\0name"]) {
    expect(() => sql.table({ name })).toThrow(TypeError);
    expect(() => sql.column({ name })).toThrow(TypeError);
  }

  const formatKey = Symbol.for("@commissary/store/sql-opaque-format");
  const format = Reflect.get(sql.text(), formatKey);
  const compatibleCopy = Object.freeze({
    [formatKey]: Object.freeze({ ...(format as Readonly<Record<string, unknown>>) }),
  });
  expect(
    sql.column({ type: compatibleCopy as SqlColumnType<string>, notNull: true }).type,
  ).not.toBe(compatibleCopy);

  const incompatibleCopy = Object.freeze({
    [formatKey]: Object.freeze({
      ...(format as Readonly<Record<string, unknown>>),
      format: "commissary-sql-opaque@2",
    }),
  });
  expect(() => sql.column({ type: incompatibleCopy as never })).toThrow(
    "SQL column helper option 'type' has an incompatible opaque format",
  );
  expect(() => sql.column({ type: {} as never })).toThrow(
    "SQL column helper option 'type' has an incompatible opaque format",
  );
  expect(() => sql.table({ primaryKey: [] as never })).toThrow(TypeError);
  expect(() => sql.table({ primaryKey: ["id", "id"] })).toThrow(TypeError);
  expect(() => sql.column({ notNull: "yes" as never })).toThrow(TypeError);
});

it("aggregates local SQL definition structure and primary-key issues", () => {
  let failure: unknown;
  try {
    SqlRecord.define({
      table: {
        name: "bad\0table",
        primaryKey: ["id", "id", "missing"],
      },
      fields: {
        id: {
          select: stringField,
          column: {
            name: "same",
            type: sql.text(),
            notNull: false,
          },
        },
        duplicate: {
          select: stringField,
          column: {
            name: "same",
            type: {},
            default: {},
            notNull: "yes",
          },
        },
      },
    } as never);
  } catch (cause) {
    failure = cause;
  }

  expect(failure).toBeInstanceOf(SqlDefinitionError);
  const error = failure as SqlDefinitionError;
  expect(error.issues.map(({ code }) => code)).toEqual([
    "invalid-name",
    "duplicate-name",
    "invalid-column-type",
    "invalid-column-default",
    "invalid-database-options",
    "invalid-primary-key",
    "invalid-primary-key",
    "invalid-primary-key",
  ]);
  expect(error.issues.map(({ path }) => path)).toEqual([
    ["table", "name"],
    ["fields", "duplicate", "column", "name"],
    ["fields", "duplicate", "column", "type"],
    ["fields", "duplicate", "column", "default"],
    ["fields", "duplicate", "column", "notNull"],
    ["table", "primaryKey", 0],
    ["table", "primaryKey", 1],
    ["table", "primaryKey", 2],
  ]);
  expect(Object.isFrozen(error.issues)).toBe(true);
  expect(Object.isFrozen(error.issues[0]?.path)).toBe(true);
});

it("reflects clear Select output storage and retries the required fallback target", () => {
  const targets: StandardJSONSchemaV1.Target[] = [];
  const fallbackField = sqlTestSchema<string, string>(
    (value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
    (target) => {
      targets.push(target);
      return target === "draft-2020-12" ? {} : { type: "string" };
    },
  );
  const localReferenceField = sqlTestSchema<string, string>(
    (value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
    () => ({
      $defs: { identifier: { type: "string" } },
      $ref: "#/$defs/identifier",
    }),
  );
  const cyclicReferenceField = sqlTestSchema<string, string>(
    (value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
    () => ({
      $defs: { cycle: { $ref: "#/$defs/cycle" } },
      $ref: "#/$defs/cycle",
    }),
  );
  const numberUnionField = sqlTestSchema<number, number>(
    (value) =>
      typeof value === "number" ? { value } : { issues: [{ message: "Expected a number" }] },
    () => ({ anyOf: [{ type: "integer" }, { type: "number" }] }),
  );
  const integerIntersectionField = sqlTestSchema<number, number>(
    (value) =>
      typeof value === "number" ? { value } : { issues: [{ message: "Expected a number" }] },
    () => ({ allOf: [{ type: "number" }, { type: "integer" }] }),
  );
  const jsonUnionField = sqlTestSchema<JsonValue, JsonValue>(
    (value) => (isJsonValue(value) ? { value } : { issues: [{ message: "Expected JSON" }] }),
    () => ({ oneOf: [{ type: "object" }, { type: "array" }] }),
  );
  const unclearField = sqlTestSchema<string | number, string | number>(
    (value) =>
      typeof value === "string" || typeof value === "number"
        ? { value }
        : { issues: [{ message: "Expected text or number" }] },
    () => ({ anyOf: [{ type: "string" }, { type: "number" }] }),
  );

  expect(reflectSqlSelectStorage(fallbackField)).toEqual({
    type: "text",
    selectedNull: false,
    presence: "required",
  });
  expect(targets).toEqual(["draft-2020-12", "draft-07"]);
  expect(reflectSqlSelectStorage(localReferenceField)?.type).toBe("text");
  expect(reflectSqlSelectStorage(nullableStringField)).toEqual({
    type: "text",
    selectedNull: true,
    presence: "required",
  });
  expect(reflectSqlSelectStorage(numberUnionField)?.type).toBe("number");
  expect(reflectSqlSelectStorage(integerIntersectionField)?.type).toBe("integer");
  expect(reflectSqlSelectStorage(jsonUnionField)?.type).toBe("json");
  expect(reflectSqlSelectStorage(cyclicReferenceField)).toBeUndefined();
  expect(reflectSqlSelectStorage(unclearField)).toBeUndefined();
});

it("resolves base and SQL definitions into immutable portable adapter facts", () => {
  const jobs = SqlRecord.define({
    table: sql.table({ name: "scheduled_jobs", primaryKey: ["id"] }),
    fields: {
      id: {
        select: stringField,
        column: sql.column({
          name: "job_id",
          type: sql.text(),
          default: sql.literal("pending"),
          notNull: true,
        }),
      },
      attempts: integerField,
      description: { select: stringField },
      payload: jsonField,
    },
  });
  const audit = StoreRecord.define({
    fields: {
      message: stringField,
    },
  });
  const resolution = resolvePortableSqlRecords({ records: { jobs, audit } });

  expect(resolution.records.jobs.name).toBe("scheduled_jobs");
  expect(resolution.records.jobs.primaryKey).toEqual(["id"]);
  expect(resolution.records.jobs.fields.id).toMatchObject({
    name: "job_id",
    portableType: "text",
    notNull: true,
    selectedPresence: "required",
  });
  expect(resolution.records.jobs.fields.attempts).toMatchObject({
    name: "attempts",
    portableType: "integer",
    notNull: true,
    selectedPresence: "required",
  });
  expect(resolution.records.jobs.fields.description).toMatchObject({
    name: "description",
    portableType: "text",
    selectedPresence: "required",
  });
  expect(resolution.records.jobs.fields.payload).toMatchObject({
    portableType: "json",
    notNull: true,
    selectedNull: true,
  });
  expect(resolution.records.audit).toMatchObject({
    name: "audit",
    primaryKey: [],
  });
  expect(resolution.records.audit.fields.message.portableType).toBe("text");
  expect(resolution.records.jobs.definition).toBe(resolution.definitions.jobs);
  expect(Object.isFrozen(resolution)).toBe(true);
  expect(Object.isFrozen(resolution.definitions)).toBe(true);
  expect(Object.isFrozen(resolution.records)).toBe(true);
  expect(Object.isFrozen(resolution.records.jobs)).toBe(true);
  expect(Object.isFrozen(resolution.records.jobs.fields)).toBe(true);
  expect(Object.isFrozen(resolution.records.jobs.fields.id)).toBe(true);
  expect(Object.isFrozen(resolution.records.jobs.primaryKey)).toBe(true);
});

it("rebuilds portable facts after deep overrides and exact null removal", () => {
  const jobs = SqlRecord.define({
    table: sql.table({ name: "scheduled_jobs", primaryKey: ["id"] }),
    fields: {
      id: {
        select: stringField,
        column: sql.column({ type: sql.text(), notNull: true }),
      },
      status: {
        select: stringField,
        column: sql.column({
          name: "job_status",
          type: sql.text(),
          default: sql.literal("pending"),
          notNull: true,
        }),
      },
    },
  });
  const resolution = resolvePortableSqlRecords({
    records: { jobs },
    overrides: {
      jobs: {
        table: { name: "host_jobs" },
        fields: {
          status: {
            column: {
              name: "state",
              default: null,
            },
          },
        },
      },
    },
  });

  expect(resolution.records.jobs.name).toBe("host_jobs");
  expect(resolution.records.jobs.fields.status.name).toBe("state");
  expect(resolution.records.jobs.fields.status).not.toHaveProperty("default");
  expect(resolution.definitions.jobs.fields.status.column).not.toHaveProperty("default");
  expect(resolution.records.jobs.fields.status.portableType).toBe("text");
});

it("reports reflection, nullability, default, and physical-name failures in stable order", () => {
  const mixedField = sqlTestSchema<string | number, string | number>(
    (value) =>
      typeof value === "string" || typeof value === "number"
        ? { value }
        : { issues: [{ message: "Expected text or number" }] },
    () => ({ anyOf: [{ type: "string" }, { type: "number" }] }),
  );
  const invalidDefaultField = {
    select: stringField,
    column: {
      type: sql.text(),
      default: sql.literal(1),
      notNull: true,
    },
  } as never;
  let failure: unknown;
  try {
    resolvePortableSqlRecords({
      records: {
        first: {
          table: { name: "shared_table" },
          fields: {
            mixed: mixedField,
            nullable: {
              select: nullableStringField,
              column: { notNull: true },
            },
            explicitNullable: {
              select: nullableStringField,
              column: { type: sql.text(), notNull: true },
            },
            invalidDefault: invalidDefaultField,
            one: {
              select: stringField,
              column: { name: "duplicate", type: sql.text(), notNull: true },
            },
            two: {
              select: stringField,
              column: { name: "duplicate", type: sql.text(), notNull: true },
            },
            aliasesPlainField: {
              select: stringField,
              column: { name: "plainField", type: sql.text(), notNull: true },
            },
            plainField: stringField,
          },
        },
        second: {
          table: { name: "shared_table" },
          fields: { id: stringField },
        },
      },
    });
  } catch (cause) {
    failure = cause;
  }

  expect(failure).toBeInstanceOf(SqlDefinitionError);
  const issues = (failure as SqlDefinitionError).issues;
  expect(issues.map(({ code }) => code)).toEqual([
    "duplicate-name",
    "duplicate-name",
    "column-type-required",
    "invalid-database-options",
    "invalid-database-options",
    "invalid-column-default",
    "duplicate-name",
  ]);
  expect(issues[1]?.path).toEqual(["records", "first", "fields", "plainField", "column", "name"]);
});

type InputJobStatus = "queued" | "pending";
type StoredJobStatus = "pending" | "done";

const selectedJobStatusField = sqlTestSchema<StoredJobStatus, StoredJobStatus>(
  (value) =>
    value === "pending" || value === "done"
      ? { value }
      : { issues: [{ message: "Expected a stored job status" }] },
  () => ({ enum: ["pending", "done"] }),
);

const writtenJobStatusField = sqlTestSchema<InputJobStatus, StoredJobStatus>(
  (value) =>
    value === "queued" || value === "pending"
      ? { value: "pending" }
      : { issues: [{ message: "Expected an input job status" }] },
  () => ({ enum: ["pending", "done"] }),
);

const inferredJob = SqlRecord.define({
  table: sql.table({
    primaryKey: ["id"],
    postgres: { schema: "jobs" as const },
  }),
  fields: {
    id: {
      select: stringField,
      column: sql.column({ type: sql.text(), notNull: true }),
    },
    status: {
      select: selectedJobStatusField,
      create: writtenJobStatusField,
      update: writtenJobStatusField,
      column: sql.column({
        type: sql.text(),
        default: sql.literal("pending"),
        notNull: true,
      }),
    },
  },
});

type InferredJobSelected = SelectedRecord<typeof inferredJob>;
type InferredJobCreate = CreateInput<typeof inferredJob>;
type InferredJobUpdate = UpdateInput<typeof inferredJob>;

expectTypeOf<InferredJobSelected>().toEqualTypeOf<{
  readonly id: string;
  readonly status: StoredJobStatus;
}>();
expectTypeOf<InferredJobCreate>().toEqualTypeOf<{
  readonly id: string;
  readonly status: InputJobStatus;
}>();
expectTypeOf<InferredJobUpdate>().toEqualTypeOf<{
  readonly id?: string;
  readonly status?: InputJobStatus;
}>();
expectTypeOf(inferredJob.table?.primaryKey?.[0]).toEqualTypeOf<"id">();
expectTypeOf(inferredJob.table?.primaryKey?.length).toEqualTypeOf<1>();
expectTypeOf(inferredJob.table?.postgres?.schema).toEqualTypeOf<"jobs">();

function sqlRecordCompileTimeContracts(): void {
  SqlRecord.define({
    // @ts-expect-error SQL primary-key names must be logical Record field names.
    table: sql.table({ primaryKey: ["missing"] }),
    fields: { id: stringField },
  });

  SqlRecord.define({
    fields: {
      value: {
        select: stringField,
        // @ts-expect-error A number column cannot preserve selected string values.
        column: sql.column({ type: sql.number() }),
      },
    },
  });

  // @ts-expect-error A numeric literal is not a default for a text column.
  sql.column({
    type: sql.text(),
    default: sql.literal(1),
  });
}

void sqlRecordCompileTimeContracts;
