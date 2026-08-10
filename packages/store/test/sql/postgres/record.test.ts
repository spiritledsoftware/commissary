import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import {
  type FieldSchema,
  isJsonValue,
  type JsonValue,
  type SelectedRecord,
} from "@commissary/store";
import { SqlDefinitionError, SqlRecord, sql } from "../../../src/sql/index.js";
import { pg, type PostgresColumnType, type PostgresEnum } from "../../../src/sql/postgres/index.js";
import {
  resolvePostgresRecords,
  type PostgresResolvedColumnType,
} from "../../../src/sql/postgres/adapter.js";
import { describe, expect, expectTypeOf, it } from "vitest";

type SchemaResult<Output> =
  | { readonly value: Output }
  | { readonly issues: readonly { readonly message: string }[] };

type TestSchema<Input, Output extends JsonValue | undefined> = FieldSchema<Input, Output> &
  StandardJSONSchemaV1<Input, Output>;

function testSchema<Input, Output extends JsonValue | undefined>(
  validate: (value: unknown) => SchemaResult<Output>,
  output: Record<string, unknown>,
): TestSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-postgres-record-test",
      validate,
      jsonSchema: {
        input: () => output,
        output: () => output,
      },
    },
  };
}

const stringField = testSchema<string, string>(
  (value) => (typeof value === "string" ? { value } : { issues: [{ message: "Expected string" }] }),
  { type: "string" },
);
const nullableStringField = testSchema<string | null, string | null>(
  (value) =>
    value === null || typeof value === "string"
      ? { value }
      : { issues: [{ message: "Expected nullable string" }] },
  { type: ["string", "null"] },
);
const numberField = testSchema<number, number>(
  (value) =>
    typeof value === "number" && Number.isFinite(value)
      ? { value }
      : { issues: [{ message: "Expected number" }] },
  { type: "number" },
);
const integerField = testSchema<number, number>(
  (value) =>
    typeof value === "number" && Number.isSafeInteger(value)
      ? { value }
      : { issues: [{ message: "Expected integer" }] },
  { type: "integer" },
);
const booleanField = testSchema<boolean, boolean>(
  (value) =>
    typeof value === "boolean" ? { value } : { issues: [{ message: "Expected boolean" }] },
  { type: "boolean" },
);
const jsonField = testSchema<JsonValue, JsonValue>(
  (value) => (isJsonValue(value) ? { value } : { issues: [{ message: "Expected JSON" }] }),
  { type: ["object", "array", "null"] },
);

function typedJsonField<Value extends JsonValue>(
  output: Record<string, unknown>,
): TestSchema<Value, Value> {
  return testSchema<Value, Value>(
    (value) =>
      isJsonValue(value)
        ? { value: value as Value }
        : { issues: [{ message: "Expected JSON value" }] },
    output,
  );
}

const pointField = typedJsonField<{ readonly x: number; readonly y: number }>({
  type: "object",
});
const lineField = typedJsonField<{
  readonly a: number;
  readonly b: number;
  readonly c: number;
}>({ type: "object" });
const vectorField = typedJsonField<{ readonly x: number }>({ type: "object" });
const statesField = typedJsonField<"pending" | "ready">({
  type: "string",
  enum: ["pending", "ready"],
});
const nestedStatesField = typedJsonField<readonly (readonly ("pending" | "ready")[])[]>({
  type: "array",
});

function explicitRecord<Value extends JsonValue>(
  schema: FieldSchema<Value, Value>,
  type: PostgresColumnType<Value>,
) {
  return SqlRecord.define({
    fields: {
      value: {
        select: schema,
        column: sql.column({ postgres: pg.column({ type }) }),
      },
    },
  });
}

function failureOf(run: () => unknown): SqlDefinitionError {
  try {
    run();
  } catch (cause) {
    expect(cause).toBeInstanceOf(SqlDefinitionError);
    return cause as SqlDefinitionError;
  }
  throw new Error("Expected SQL definition failure");
}

function physicalType(type: PostgresResolvedColumnType): string {
  if (type.kind === "direct") return type.type;
  return type.kind;
}

describe("PostgreSQL metadata helpers", () => {
  it("snapshots and freezes metadata without changing Record inference", () => {
    const tableOptions = { schema: "jobs", name: "scheduled_jobs" };
    const identity = {
      mode: "by-default" as const,
      sequence: { name: { schema: "jobs", name: "scheduled_jobs_id_seq" }, startWith: 2n },
    };
    expect(() => pg.table({ unexpected: true } as never)).toThrow(TypeError);
    const columnOptions = { type: pg.uuid(), notNull: true, identity };
    const table = pg.table(tableOptions);
    const column = pg.column(columnOptions);
    expect(() => pg.column({ unexpected: true } as never)).toThrow(TypeError);
    tableOptions.name = "changed";
    identity.sequence.startWith = 3n;

    expect(() => pg.numeric({ precision: 2, unexpected: true } as never)).toThrow(TypeError);
    expect(table).toMatchObject({ schema: "jobs", name: "scheduled_jobs" });
    expect(column.identity?.sequence?.startWith).toBe(2n);
    expect(Object.isFrozen(table)).toBe(true);
    expect(() =>
      pg.column({
        type: pg.integer(),
        identity: { mode: "always", sequence: { incrementBy: 0 } },
      }),
    ).toThrow(TypeError);
    expect(() =>
      pg.column({
        type: pg.integer(),
        identity: { mode: "always", sequence: { cache: 0n } },
      }),
    ).toThrow(TypeError);
    expect(Object.isFrozen(column)).toBe(true);
    expect(Object.isFrozen(column.identity)).toBe(true);

    const definition = SqlRecord.define({
      table: sql.table({ postgres: table }),
      fields: {
        id: {
          select: stringField,
          column: sql.column({ postgres: pg.column({ type: pg.uuid() }) }),
        },
      },
    });
    expectTypeOf<SelectedRecord<typeof definition>>().toEqualTypeOf<{ readonly id: string }>();
  });

  it("rejects malformed helper arguments immediately", () => {
    expect(() => pg.table(null as never)).toThrow(TypeError);
    expect(() => pg.table({ name: "" })).toThrow(TypeError);
    expect(() => pg.table({ name: "x".repeat(64) })).toThrow(TypeError);
    expect(() => pg.column({ notNull: "yes" as never })).toThrow(TypeError);
    expect(() => pg.column({ type: sql.text() as never })).toThrow(TypeError);
    expect(() => pg.numeric({ scale: 2 })).toThrow(TypeError);
    expect(() => pg.numeric({ precision: 0 })).toThrow(TypeError);
    expect(() => pg.varchar({ length: 10_485_761 })).toThrow(TypeError);
    expect(() => pg.timestamp({ precision: 7 as never })).toThrow(TypeError);
    expect(() => pg.interval({ fields: "year", precision: 2 })).toThrow(TypeError);
    expect(() => pg.enum({ name: "state", values: ["ready", "ready"] })).toThrow(TypeError);
    expect(() => pg.array(sql.text() as never)).toThrow(TypeError);
    expect(() =>
      pg.custom({
        type: { name: "vector", modifier: sql`${1}` as never },
        encode: String,
        decode: String,
      }),
    ).not.toThrow();
  });

  it("keeps exact helper value types and contravariance", () => {
    expectTypeOf(pg.smallint()).toEqualTypeOf<PostgresColumnType<number>>();
    expectTypeOf(pg.integer()).toEqualTypeOf<PostgresColumnType<number>>();
    expectTypeOf(pg.bigint()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.numeric()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.real()).toEqualTypeOf<PostgresColumnType<number>>();
    expectTypeOf(pg.doublePrecision()).toEqualTypeOf<PostgresColumnType<number>>();
    expectTypeOf(pg.boolean()).toEqualTypeOf<PostgresColumnType<boolean>>();
    expectTypeOf(pg.char()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.varchar()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.text()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.uuid()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.json()).toEqualTypeOf<PostgresColumnType<JsonValue>>();
    expectTypeOf(pg.jsonb()).toEqualTypeOf<PostgresColumnType<JsonValue>>();
    expectTypeOf(pg.bytea()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.date()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.time()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.timestamp()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.interval()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.inet()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.cidr()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.macaddr()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.macaddr8()).toEqualTypeOf<PostgresColumnType<string>>();
    expectTypeOf(pg.point()).toEqualTypeOf<
      PostgresColumnType<{ readonly x: number; readonly y: number }>
    >();
    expectTypeOf(pg.line()).toEqualTypeOf<
      PostgresColumnType<{ readonly a: number; readonly b: number; readonly c: number }>
    >();
    const state = pg.enum({ name: "job_state", values: ["pending", "running"] as const });
    expectTypeOf(state).toMatchTypeOf<PostgresEnum<readonly ["pending", "running"]>>();
    expectTypeOf(pg.array(state)).toEqualTypeOf<
      PostgresColumnType<readonly ("pending" | "running")[]>
    >();
    const branded = pg.uuid();
    type JobId = string & { readonly JobId: unique symbol };
    expectTypeOf(branded).toMatchTypeOf<PostgresColumnType<JobId>>();

    // @ts-expect-error A string default cannot be used with an explicit numeric type.
    pg.column({ type: pg.integer(), default: sql.literal("invalid") });
    // @ts-expect-error A numeric type cannot satisfy a string storage contract.
    const invalidStringType: PostgresColumnType<string> = pg.integer();
    expectTypeOf(invalidStringType).toEqualTypeOf<PostgresColumnType<string>>();
  });
});

describe("PostgreSQL Record resolution", () => {
  it("maps portable storage and applies active PostgreSQL overrides", () => {
    const records = {
      portable: SqlRecord.define({
        table: sql.table({ name: "portable_jobs", postgres: pg.table({ schema: "jobs" }) }),
        fields: {
          text: { select: stringField, column: sql.column({ type: sql.text() }) },
          number: { select: numberField, column: sql.column({ type: sql.number() }) },
          integer: { select: integerField, column: sql.column({ type: sql.integer() }) },
          boolean: { select: booleanField, column: sql.column({ type: sql.boolean() }) },
          json: { select: jsonField, column: sql.column({ type: sql.json() }) },
          refined: {
            select: stringField,
            column: sql.column({
              name: "portable_name",
              type: sql.text(),
              postgres: pg.column({ name: "pg_name", type: pg.uuid(), notNull: true }),
            }),
          },
        },
      }),
    };
    const resolution = resolvePostgresRecords({ records });
    const table = resolution.tables.portable;

    expect(table.schema).toBe("jobs");
    expect(table.name).toBe("portable_jobs");
    expect(
      Object.fromEntries(
        Object.entries(table.columns).map(([name, column]) => [name, physicalType(column.type)]),
      ),
    ).toEqual({
      text: "text",
      number: "double-precision",
      integer: "bigint",
      boolean: "boolean",
      json: "json",
      refined: "uuid",
    });
    expect(table.columns.refined.name).toBe("pg_name");
    expect(table.columns.integer.encode(42)).toBe("42");
    expect(table.columns.integer.decode("42")).toBe(42);
    expect(() => table.columns.integer.decode("9007199254740992")).toThrow(TypeError);
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(table.columns)).toBe(true);
  });

  it("resolves every direct helper and canonical codec boundary", () => {
    const direct = {
      smallint: explicitRecord(integerField, pg.smallint()),
      integer: explicitRecord(integerField, pg.integer()),
      bigint: explicitRecord(stringField, pg.bigint()),
      numeric: explicitRecord(stringField, pg.numeric({ precision: 8, scale: 2 })),
      real: explicitRecord(numberField, pg.real()),
      double: explicitRecord(numberField, pg.doublePrecision()),
      boolean: explicitRecord(booleanField, pg.boolean()),
      char: explicitRecord(stringField, pg.char({ length: 8 })),
      varchar: explicitRecord(stringField, pg.varchar({ length: 20 })),
      text: explicitRecord(stringField, pg.text()),
      uuid: explicitRecord(stringField, pg.uuid()),
      json: explicitRecord(jsonField, pg.json()),
      jsonb: explicitRecord(jsonField, pg.jsonb()),
      bytea: explicitRecord(stringField, pg.bytea()),
      date: explicitRecord(stringField, pg.date()),
      time: explicitRecord(stringField, pg.time({ precision: 6 })),
      timeTz: explicitRecord(stringField, pg.time({ withTimezone: true })),
      timestamp: explicitRecord(stringField, pg.timestamp()),
      timestampTz: explicitRecord(stringField, pg.timestamp({ withTimezone: true })),
      interval: explicitRecord(stringField, pg.interval({ fields: "day to second", precision: 6 })),
      inet: explicitRecord(stringField, pg.inet()),
      cidr: explicitRecord(stringField, pg.cidr()),
      macaddr: explicitRecord(stringField, pg.macaddr()),
      macaddr8: explicitRecord(stringField, pg.macaddr8()),
      point: explicitRecord(pointField, pg.point()),
      line: explicitRecord(lineField, pg.line()),
    };
    const resolution = resolvePostgresRecords({ records: direct });

    expect(resolution.tables.smallint.columns.value.encode(32_767)).toBe(32_767);
    expect(() => resolution.tables.smallint.columns.value.encode(32_768)).toThrow(TypeError);
    expect(resolution.tables.bigint.columns.value.encode("9223372036854775807")).toBe(
      "9223372036854775807",
    );
    expect(resolution.tables.numeric.columns.value.type).toEqual({
      kind: "direct",
      type: "numeric",
      options: { precision: 8, scale: 2 },
    });
    expect(resolution.tables.timeTz.columns.value.type).toEqual({
      kind: "direct",
      type: "time",
      options: { withTimezone: true },
    });
    expect(() => resolution.tables.bigint.columns.value.encode("01")).toThrow(TypeError);
    expect(resolution.tables.numeric.columns.value.decode("1234.50")).toBe("1234.50");
    expect(() => resolution.tables.numeric.columns.value.encode("1234567.89")).toThrow(TypeError);
    expect(() => resolution.tables.double.columns.value.encode(Number.POSITIVE_INFINITY)).toThrow(
      TypeError,
    );
    expect(() => resolution.tables.char.columns.value.encode("trailing ")).toThrow(TypeError);
    expect(resolution.tables.char.columns.value.decode("padded   ")).toBe("padded");
    expect(
      resolution.tables.uuid.columns.value.encode("123e4567-e89b-42d3-a456-426614174000"),
    ).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(() => resolution.tables.uuid.columns.value.encode("not-a-uuid")).toThrow(TypeError);
    expect(resolution.tables.bytea.columns.value.decode(new Uint8Array([0, 1, 2]))).toBe("AAEC");
    expect(resolution.tables.date.columns.value.encode("2024-02-29")).toBe("2024-02-29");
    expect(() => resolution.tables.date.columns.value.encode("2023-02-29")).toThrow(TypeError);
    expect(resolution.tables.timestampTz.columns.value.encode("2026-08-10T12:34:56.123456Z")).toBe(
      "2026-08-10T12:34:56.123456Z",
    );
    expect(() => resolution.tables.timestamp.columns.value.encode("2026-08-10T12:34:56Z")).toThrow(
      TypeError,
    );
    expect(resolution.tables.macaddr.columns.value.encode("08:00:2b:01:02:03")).toBe(
      "08:00:2b:01:02:03",
    );
    expect(resolution.tables.point.columns.value.decode({ x: -0, y: 2 })).toEqual({ x: 0, y: 2 });
    expect(resolution.tables.line.columns.value.encode({ a: 1, b: 2, c: 3 })).toEqual({
      a: 1,
      b: 2,
      c: 3,
    });
  });

  it("resolves arrays, reusable enums, and custom types", () => {
    const state = pg.enum({ schema: "jobs", name: "job_state", values: ["pending", "ready"] });
    const encoderFailure = new Error("encode failed");
    const custom = pg.custom<{ readonly x: number }>({
      type: { schema: "public", name: "vector", modifier: sql.raw("3") },
      encode: (value) => {
        if (value.x < 0) throw encoderFailure;
        return String(value.x);
      },
      decode: (value) => ({ x: Number(value) }),
    });
    const records = {
      first: explicitRecord(nestedStatesField, pg.array(pg.array(state))),
      second: explicitRecord(statesField, state),
      custom: explicitRecord(vectorField, custom),
    };
    const resolution = resolvePostgresRecords({ records });
    const array = resolution.tables.first.columns.value;

    expect(resolution.enums).toHaveLength(1);
    expect(resolution.enums[0]).toMatchObject({
      schema: "jobs",
      name: "job_state",
      values: ["pending", "ready"],
    });
    expect(array.encode([["pending"], ["ready"]])).toEqual([["pending"], ["ready"]]);
    expect(() => array.encode([["pending"], ["ready", "pending"]])).toThrow(TypeError);
    expect(() => array.decode({ values: [["pending"]], lowerBounds: [0, 1] })).toThrow(TypeError);
    expect(array.decode({ values: [["pending"]], lowerBounds: [1, 1] })).toEqual([["pending"]]);
    expect(resolution.tables.custom.columns.value.encode({ x: 2 })).toBe("2");
    expect(resolution.tables.custom.columns.value.decode("3")).toEqual({ x: 3 });
    expect(() => resolution.tables.custom.columns.value.encode({ x: -1 })).toThrow(encoderFailure);
    expect(array.decode({ values: [[null]], lowerBounds: [1, 1] })).toEqual([[null]]);
    expect(() => resolution.tables.custom.columns.value.decode(Symbol("invalid"))).toThrow(
      TypeError,
    );
  });

  it("resolves defaults, identity, generation, references, and null removal", () => {
    const records = {
      jobs: SqlRecord.define({
        table: sql.table({
          name: "portable_jobs",
          primaryKey: ["id"],
          postgres: pg.table({ schema: "jobs", name: "scheduled_jobs" }),
        }),
        fields: {
          id: {
            select: stringField,
            column: sql.column({
              type: sql.text(),
              postgres: pg.column({
                type: pg.bigint(),
                notNull: true,
                identity: {
                  mode: "always",
                  sequence: {
                    name: { schema: "jobs", name: "scheduled_jobs_id_seq" },
                    startWith: 10,
                    incrementBy: 2n,
                    minValue: 1,
                    maxValue: 100,
                    cache: 4,
                    cycle: false,
                  },
                },
              }),
            }),
          },
          state: {
            select: stringField,
            column: sql.column({
              default: sql.literal("pending"),
              postgres: pg.column({ default: sql.raw("'ready'") }),
            }),
          },
          derived: {
            select: nullableStringField,
            column: sql.column({
              type: sql.text(),
              postgres: pg.column({ generated: sql.raw("state || '-derived'") }),
            }),
          },
        },
      }),
    };
    const resolution = resolvePostgresRecords({ records });
    const table = resolution.tables.jobs;

    expect(table).toMatchObject({ schema: "jobs", name: "scheduled_jobs" });
    expect(table.primaryKey.map((column) => column.name)).toEqual(["id"]);
    expect(table.columns.id.identity).toEqual({
      mode: "always",
      sequence: {
        name: { schema: "jobs", name: "scheduled_jobs_id_seq" },
        reference: expect.any(Object),
        startWith: "10",
        incrementBy: "2",
        minValue: "1",
        maxValue: "100",
        cache: "4",
        cycle: false,
      },
    });
    expect(table.columns.id.identity?.mode).toBe("always");
    expect(table.columns.state.default).toBeDefined();
    expect(table.columns.derived.generated).toMatchObject({ mode: "stored" });
    expect(
      sql`${resolution.records.jobs.fields.state} FROM ${resolution.records.jobs}`,
    ).toBeDefined();
    const byDefault = resolvePostgresRecords({
      records: {
        generated: SqlRecord.define({
          fields: {
            id: {
              select: integerField,
              column: sql.column({
                postgres: pg.column({
                  type: pg.integer(),
                  identity: { mode: "by-default" },
                }),
              }),
            },
          },
        }),
      },
    });
    expect(byDefault.tables.generated.columns.id.identity).toEqual({ mode: "by-default" });

    const overridden = resolvePostgresRecords({
      records,
      overrides: {
        jobs: {
          table: { postgres: pg.table({ schema: null, name: null }) },
          fields: {
            state: { column: { postgres: pg.column({ default: null }) } },
          },
        },
      },
    });
    expect(overridden.tables.jobs.schema).toBeUndefined();
    expect(overridden.tables.jobs.name).toBe("portable_jobs");
    expect(overridden.tables.jobs.columns.state.default).toBe("pending");
  });

  it("rejects identity and generated-column conflicts without dependent output", () => {
    const parameterized = sql`${1}`;
    const records = {
      invalid: SqlRecord.define({
        fields: {
          wrongType: {
            select: stringField,
            column: sql.column({
              postgres: pg.column({
                type: pg.text(),
                identity: { mode: "always" },
              }),
            }),
          },
          defaultedIdentity: {
            select: integerField,
            column: sql.column({
              default: sql.literal(1),
              postgres: pg.column({
                type: pg.integer(),
                identity: { mode: "by-default" },
                notNull: false,
              }),
            }),
          },
          generatedDefault: {
            select: stringField,
            column: sql.column({
              default: sql.literal("fallback"),
              postgres: pg.column({ generated: sql.raw("upper(value)") }),
            }),
          },
          generatedParameter: {
            select: stringField,
            column: sql.column({
              postgres: pg.column({ generated: parameterized as never }),
            }),
          },
        },
      }),
    };
    const failure = failureOf(() => resolvePostgresRecords({ records }));
    expect(failure.issues.map(({ code }) => code)).toEqual([
      "invalid-database-options",
      "invalid-database-options",
      "invalid-database-options",
      "invalid-database-options",
      "invalid-database-options",
    ]);
    expect(failure.issues.map(({ path }) => path)).toEqual([
      ["records", "invalid", "fields", "wrongType", "column", "postgres", "identity"],
      ["records", "invalid", "fields", "defaultedIdentity", "column", "postgres", "identity"],
      ["records", "invalid", "fields", "defaultedIdentity", "column", "postgres", "identity"],
      ["records", "invalid", "fields", "generatedDefault", "column", "postgres", "generated"],
      ["records", "invalid", "fields", "generatedParameter", "column", "postgres", "generated"],
    ]);
  });

  it("aggregates conflicts in stable declaration order and skips dependent checks", () => {
    const sharedNameOne = pg.enum({ name: "shared", values: ["one"] });
    const sharedNameTwo = pg.enum({ name: "shared", values: ["two"] });
    const records = {
      first: SqlRecord.define({
        table: sql.table({ name: "first", postgres: pg.table({ name: "same" }) }),
        fields: {
          one: {
            select: stringField,
            column: sql.column({
              name: "one",
              postgres: pg.column({ name: "same", type: sharedNameOne }),
            }),
          },
          two: {
            select: stringField,
            column: sql.column({
              name: "two",
              postgres: pg.column({ name: "same", type: sharedNameTwo }),
            }),
          },
        },
      }),
      second: SqlRecord.define({
        table: sql.table({ postgres: pg.table({ name: "same" }) }),
        fields: {
          broken: {
            select: stringField,
            column: sql.column({ postgres: pg.column({ type: pg.integer() as never }) }),
          },
        },
      }),
    };
    const failure = failureOf(() => resolvePostgresRecords({ records }));

    expect(failure.issues.map(({ code }) => code)).toEqual([
      "duplicate-name",
      "invalid-column-type",
      "duplicate-name",
      "duplicate-name",
      "duplicate-name",
    ]);
    expect(failure.issues.map(({ path }) => path)).toEqual([
      ["records", "first", "fields", "two", "column", "name"],
      ["records", "second", "fields", "broken", "column", "type"],
      ["records", "second", "table", "name"],
      ["records", "second", "table", "name"],
      ["records", "first", "fields", "two", "column", "type"],
    ]);
    expect(Object.isFrozen(failure.issues)).toBe(true);
    expect(Object.isFrozen(failure.issues[0]?.path)).toBe(true);
  });

  it("rejects incompatible and counterfeit opaque values", () => {
    const real = pg.text();
    const compatibleCopy = Object.freeze({ ...real }) as PostgresColumnType<string>;
    expect(() =>
      resolvePostgresRecords({ records: { copy: explicitRecord(stringField, compatibleCopy) } }),
    ).not.toThrow();

    const symbol = Reflect.ownKeys(real).find((key) => typeof key === "symbol");
    expect(symbol).toBeTypeOf("symbol");
    const counterfeit = Object.freeze({
      [symbol as symbol]: Object.freeze({
        format: "commissary-sql-opaque@2",
        kind: "column-type",
        dialect: "postgres",
        type: "text",
      }),
    }) as PostgresColumnType<string>;
    const validMetadata = pg.column({ type: pg.text() });
    const counterfeitMetadata = Object.freeze({
      ...validMetadata,
      type: counterfeit,
    });
    const counterfeitRecord = SqlRecord.define({
      fields: {
        value: {
          select: stringField,
          column: sql.column({ postgres: counterfeitMetadata }),
        },
      },
    });
    const failure = failureOf(() =>
      resolvePostgresRecords({ records: { counterfeit: counterfeitRecord } }),
    );
    expect(failure.issues).toMatchObject([{ code: "invalid-column-type" }]);
  });
});
