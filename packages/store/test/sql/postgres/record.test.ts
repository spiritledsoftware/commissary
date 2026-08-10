import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import {
  type FieldSchema,
  isJsonValue,
  type JsonValue,
  type SelectedRecord,
} from "@commissary/store";
import { compileSqlStatement } from "../../../src/sql/adapter.js";
import { SqlDefinitionError, SqlRecord, sql } from "../../../src/sql/index.js";
import { pg, type PostgresColumnType, type PostgresEnum } from "../../../src/sql/postgres/index.js";
import {
  resolvePostgresRecords,
  type PostgresResolvedColumnType,
} from "../../../src/sql/postgres/adapter.js";
import { describe, expect, expectTypeOf, it } from "vitest";

const postgresStatementCompiler = {
  quoteIdentifier: (name: string) => `"${name.replaceAll('"', '""')}"`,
  makePlaceholder: (position: number) => `$${position + 1}`,
  isParameter: (_value: unknown): _value is JsonValue => false,
  convertParameter: (value: JsonValue) => value,
};

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
const nullableIntegerField = testSchema<number | null, number | null>(
  (value) =>
    value === null || (typeof value === "number" && Number.isSafeInteger(value))
      ? { value }
      : { issues: [{ message: "Expected nullable integer" }] },
  { type: ["integer", "null"] },
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
    const columnOptions = { type: pg.uuid(), notNull: true, identity };
    const table = pg.table(tableOptions);
    const column = pg.column(columnOptions);
    tableOptions.name = "changed";
    identity.sequence.startWith = 3n;

    expect(table).toMatchObject({ schema: "jobs", name: "scheduled_jobs" });
    expect(column.identity?.sequence?.startWith).toBe(2n);
    expect(Object.isFrozen(table)).toBe(true);
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

  it("snapshots nested values inside frozen metadata options", () => {
    const sequence = { startWith: 2n };
    const column = pg.column(
      Object.freeze({
        type: pg.integer(),
        identity: { mode: "always" as const, sequence },
      }),
    );

    sequence.startWith = 3n;

    expect(column.identity?.sequence?.startWith).toBe(2n);
    expect(Object.isFrozen(column.identity?.sequence)).toBe(true);
  });

  it("rejects malformed helper arguments immediately", () => {
    expect(() => pg.table({ unexpected: true } as never)).toThrow(TypeError);
    expect(() => pg.column({ unexpected: true } as never)).toThrow(TypeError);
    expect(() => pg.table(null as never)).toThrow(TypeError);
    expect(() => pg.table({ name: "" })).toThrow(TypeError);
    expect(() => pg.table({ name: "x".repeat(64) })).toThrow(TypeError);
    expect(() => pg.column({ notNull: "yes" as never })).toThrow(TypeError);
    expect(() => pg.column({ type: sql.text() as never })).toThrow(TypeError);
    expect(() => pg.numeric({ scale: 2 })).toThrow(TypeError);
    expect(() => pg.numeric({ precision: 0 })).toThrow(TypeError);
    expect(() => pg.numeric({ precision: 2, unexpected: true } as never)).toThrow(TypeError);
    expect(() => pg.varchar({ length: 10_485_761 })).toThrow(TypeError);
    expect(() => pg.timestamp({ precision: 7 as never })).toThrow(TypeError);
    expect(() => pg.interval({ fields: "year", precision: 2 })).toThrow(TypeError);
    expect(() => pg.enum({ name: "state", values: ["ready", "ready"] })).toThrow(TypeError);
    expect(() => pg.enum({ name: "state", values: ["x".repeat(64)] })).toThrow(TypeError);
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
  it("rejects parameterized custom type modifiers during resolution", () => {
    const custom = pg.custom<{ readonly x: number }>({
      type: { name: "vector", modifier: sql`${1}` as never },
      encode: (value) => String(value.x),
      decode: (value) => ({ x: Number(value) }),
    });

    const failure = failureOf(() =>
      resolvePostgresRecords({
        records: { custom: explicitRecord(vectorField, custom) },
      }),
    );

    expect(failure.issues).toMatchObject([{ code: "invalid-database-options" }]);
    expect(failure.issues[0]?.path).toEqual([
      "records",
      "custom",
      "fields",
      "value",
      "column",
      "type",
      "type",
      "modifier",
    ]);
  });

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
    expect(
      resolution.tables.uuid.columns.value.encode("00000000-0000-0000-0000-000000000000"),
    ).toBe("00000000-0000-0000-0000-000000000000");
    expect(
      resolution.tables.uuid.columns.value.decode("ffffffff-ffff-ffff-ffff-ffffffffffff"),
    ).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(resolution.tables.bytea.columns.value.decode(new Uint8Array([0, 1, 2]))).toBe("AAEC");
    expect(resolution.tables.bytea.columns.value.encode("AAEC")).toEqual(new Uint8Array([0, 1, 2]));
    expect(resolution.tables.bytea.columns.value.encode("QQ==")).toEqual(new Uint8Array([0x41]));
    expect(resolution.tables.bytea.columns.value.encode("QUI=")).toEqual(
      new Uint8Array([0x41, 0x42]),
    );
    expect(() => resolution.tables.bytea.columns.value.encode("QQ=")).toThrow(TypeError);
    expect(resolution.tables.date.columns.value.encode("2024-02-29")).toBe("2024-02-29");
    expect(() => resolution.tables.date.columns.value.encode("2023-02-29")).toThrow(TypeError);
    expect(resolution.tables.date.columns.value.encode("0000-01-01")).toBe("0000-01-01");
    expect(resolution.tables.date.columns.value.encode("-4712-01-01")).toBe("-4712-01-01");
    expect(resolution.tables.date.columns.value.encode("5874897-12-31")).toBe("5874897-12-31");
    expect(() => resolution.tables.date.columns.value.encode("-4713-12-31")).toThrow(TypeError);
    expect(() => resolution.tables.date.columns.value.encode("5874898-01-01")).toThrow(TypeError);
    expect(resolution.tables.timestamp.columns.value.encode("294276-12-31T23:59:59.999999")).toBe(
      "294276-12-31T23:59:59.999999",
    );
    expect(() => resolution.tables.timestamp.columns.value.encode("294277-01-01T00:00:00")).toThrow(
      TypeError,
    );
    expect(() =>
      resolution.tables.date.columns.value.decode(Object.create(Date.prototype) as Date),
    ).toThrow(TypeError);
    expect(resolution.tables.timestampTz.columns.value.encode("2026-08-10T12:34:56.123456Z")).toBe(
      "2026-08-10T12:34:56.123456Z",
    );
    expect(resolution.tables.timestamp.columns.value.decode("2026-08-10 12:34:56.123456")).toBe(
      "2026-08-10T12:34:56.123456",
    );
    expect(
      resolution.tables.timestampTz.columns.value.decode("2026-08-10 00:30:00.123456+02"),
    ).toBe("2026-08-09T22:30:00.123456Z");
    expect(resolution.tables.timeTz.columns.value.decode("00:30:00+02:00")).toBe("22:30:00Z");
    expect(() => resolution.tables.timestamp.columns.value.encode("2026-08-10T12:34:56Z")).toThrow(
      TypeError,
    );
    expect(resolution.tables.interval.columns.value.encode("P1DT2H3M4.5S")).toBe("P1DT2H3M4.5S");
    expect(resolution.tables.interval.columns.value.decode("P1DT2H3M4.5S")).toBe("P1DT2H3M4.5S");
    expect(() => resolution.tables.interval.columns.value.decode("1 day 02:03:04")).toThrow(
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
    const badDecoder = pg.custom<{ readonly x: number }>({
      type: { name: "bad_decoder" },
      encode: (value) => String(value.x),
      decode: () => undefined as never,
    });
    const badEncoder = pg.custom<{ readonly x: number }>({
      type: { name: "bad_encoder" },
      encode: () => ({ invalid: true }) as never,
      decode: (value) => ({ x: Number(value) }),
    });
    const records = {
      first: explicitRecord(nestedStatesField, pg.array(pg.array(state))),
      second: explicitRecord(statesField, state),
      custom: explicitRecord(vectorField, custom),
      badDecoder: explicitRecord(vectorField, badDecoder),
      badEncoder: explicitRecord(vectorField, badEncoder),
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
    expect(() => array.decode({ values: [["pending"]] })).toThrow(TypeError);
    expect(resolution.tables.custom.columns.value.encode({ x: 2 })).toBe("2");
    expect(resolution.tables.custom.columns.value.decode("3")).toEqual({ x: 3 });
    expect(() => resolution.tables.custom.columns.value.encode({ x: -1 })).toThrow(encoderFailure);
    expect(array.decode({ values: [[null]], lowerBounds: [1, 1] })).toEqual([[null]]);
    expect(() => resolution.tables.custom.columns.value.decode(Symbol("invalid"))).toThrow(
      TypeError,
    );
    expect(() => resolution.tables.badDecoder.columns.value.decode("1")).toThrow(
      "PostgreSQL custom decoder returned an invalid value",
    );
    expect(() => resolution.tables.badEncoder.columns.value.encode({ x: 1 })).toThrow(
      "PostgreSQL custom encoder returned an invalid value",
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
    const stateDefault = table.columns.state.default;
    expect(typeof stateDefault).toBe("object");
    if (typeof stateDefault !== "object" || stateDefault === null) {
      throw new TypeError("Expected PostgreSQL Statement default");
    }
    expect(compileSqlStatement(stateDefault, postgresStatementCompiler)).toEqual({
      text: "'ready'",
      segments: ["'ready'"],
      parameters: [],
    });
    expect(table.columns.derived.generated).toMatchObject({ mode: "stored" });
    const referenceStatement = sql`${resolution.records.jobs.fields.state} FROM ${resolution.records.jobs}`;
    expect(compileSqlStatement(referenceStatement, postgresStatementCompiler)).toEqual({
      text: '"state" FROM "jobs"."scheduled_jobs"',
      segments: ['"state" FROM "jobs"."scheduled_jobs"'],
      parameters: [],
    });
    expect(Object.isFrozen(resolution.records.jobs)).toBe(true);
    expect(Object.isFrozen(resolution.records.jobs.fields)).toBe(true);
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
    expect(
      failure.issues.find(({ path }) => path.includes("generatedParameter"))?.message,
    ).toContain("must not contain SQL parameters");
  });

  it("applies identity nullability and excludes top-level SQL NULL from column codecs", () => {
    const nullable = SqlRecord.define({
      fields: {
        value: {
          select: nullableIntegerField,
          column: sql.column({
            postgres: pg.column({ type: pg.integer() as never }),
          }),
        },
      },
    });
    const resolution = resolvePostgresRecords({ records: { nullable } });
    expectTypeOf(resolution.tables.nullable.columns.value.encode)
      .parameter(0)
      .toEqualTypeOf<number>();

    const identity = SqlRecord.define({
      fields: {
        value: {
          select: nullableIntegerField,
          column: sql.column({
            postgres: pg.column({
              type: pg.integer() as never,
              identity: { mode: "always" },
            }),
          }),
        },
      },
    });
    const failure = failureOf(() => resolvePostgresRecords({ records: { identity } }));
    expect(failure.issues).toMatchObject([
      {
        code: "invalid-database-options",
        path: ["records", "identity", "fields", "value", "column", "notNull"],
      },
    ]);
  });

  it("clears inherited PostgreSQL nullability with a null override", () => {
    const records = {
      nullable: SqlRecord.define({
        fields: {
          value: {
            select: nullableStringField,
            column: sql.column({
              postgres: pg.column({ type: pg.text(), notNull: true }),
            }),
          },
        },
      }),
    };
    const resolution = resolvePostgresRecords({
      records,
      overrides: {
        nullable: {
          fields: {
            value: { column: { postgres: pg.column({ notNull: null }) } },
          },
        },
      },
    });

    expect(resolution.tables.nullable.columns.value.notNull).toBe(false);
  });

  it("rejects unsupported and invalid PostgreSQL identity sequence options", () => {
    const validMetadata = pg.column({
      type: pg.smallint(),
      identity: { mode: "always", sequence: { cache: 1 } },
    });
    const recordForSequence = (sequence: Readonly<Record<string, unknown>>) =>
      SqlRecord.define({
        fields: {
          id: {
            select: integerField,
            column: sql.column({
              postgres: Object.freeze({
                ...validMetadata,
                identity: Object.freeze({
                  mode: "always" as const,
                  sequence: Object.freeze(sequence),
                }),
              }),
            }),
          },
        },
      });

    const unsupported = failureOf(() =>
      resolvePostgresRecords({
        records: { unsupported: recordForSequence({ cache: 1, unexpected: true }) },
      }),
    );
    expect(unsupported.issues).toMatchObject([
      {
        code: "invalid-database-options",
        path: [
          "records",
          "unsupported",
          "fields",
          "id",
          "column",
          "postgres",
          "identity",
          "sequence",
          "unexpected",
        ],
      },
    ]);

    const invalidInteger = failureOf(() =>
      resolvePostgresRecords({
        records: { invalidInteger: recordForSequence({ cache: "1" }) },
      }),
    );
    expect(invalidInteger.issues[0]?.message).toContain("must be an exact integer");

    const outOfRange = failureOf(() =>
      resolvePostgresRecords({
        records: { outOfRange: recordForSequence({ cache: 40_000 }) },
      }),
    );
    expect(outOfRange.issues[0]?.message).toContain("outside the column range");
  });

  it("reports each invalid effective PostgreSQL name once", () => {
    const validTable = pg.table({ name: "valid_table" });
    const validColumn = pg.column({ name: "valid_column", type: pg.text() });
    const malformed = SqlRecord.define({
      table: sql.table({ postgres: Object.freeze({ ...validTable, name: "" }) }),
      fields: {
        value: {
          select: stringField,
          column: sql.column({ postgres: Object.freeze({ ...validColumn, name: "" }) }),
        },
      },
    });
    const failure = failureOf(() => resolvePostgresRecords({ records: { malformed } }));

    expect(failure.issues).toMatchObject([
      {
        code: "invalid-name",
        path: ["records", "malformed", "table", "name"],
      },
      {
        code: "invalid-name",
        path: ["records", "malformed", "fields", "value", "column", "name"],
      },
    ]);
  });

  it("reports malformed primary keys once", () => {
    const recordWithPrimaryKey = (primaryKey: unknown) =>
      SqlRecord.define({
        table: Object.freeze({ ...sql.table({}), primaryKey }) as never,
        fields: {
          id: {
            select: stringField,
            column: sql.column({
              postgres: pg.column({ type: pg.text(), notNull: true }),
            }),
          },
        },
      });

    for (const primaryKey of [[], "id"]) {
      const failure = failureOf(() => recordWithPrimaryKey(primaryKey));
      expect(failure.issues).toEqual([
        {
          code: "invalid-primary-key",
          path: ["table", "primaryKey"],
          message: "SQL Record primary key must be a nonempty field-name tuple",
        },
      ]);
    }
  });

  it("enforces the six-dimensional PostgreSQL array limit without recursive crashes", () => {
    const arrayField = typedJsonField<readonly JsonValue[]>({ type: "array" });
    const sixDimensions = pg.array(pg.array(pg.array(pg.array(pg.array(pg.array(pg.text()))))));
    expect(() =>
      resolvePostgresRecords({
        records: {
          accepted: explicitRecord(arrayField, sixDimensions as never),
        },
      }),
    ).not.toThrow();

    const sevenDimensions = pg.array(sixDimensions);
    const depthFailure = failureOf(() =>
      resolvePostgresRecords({
        records: {
          rejected: explicitRecord(arrayField, sevenDimensions as never),
        },
      }),
    );
    expect(depthFailure.issues).toMatchObject([
      {
        code: "invalid-column-type",
        message: "PostgreSQL array type exceeds the six-dimensional limit",
      },
    ]);

    const formatKey = Symbol.for("@commissary/store/sql-opaque-format");
    const cyclicType: Record<PropertyKey, unknown> = {};
    const cyclicOptions: Record<PropertyKey, unknown> = {};
    const cyclicFormat: Record<PropertyKey, unknown> = {
      format: "commissary-sql-opaque@1",
      kind: "column-type",
      dialect: "postgres",
      type: "array",
      options: cyclicOptions,
    };
    cyclicType[formatKey] = cyclicFormat;
    cyclicOptions.element = cyclicType;
    Object.freeze(cyclicOptions);
    Object.freeze(cyclicFormat);
    Object.freeze(cyclicType);
    const cycleFailure = failureOf(() =>
      resolvePostgresRecords({
        records: {
          cycle: explicitRecord(
            arrayField,
            cyclicType as unknown as PostgresColumnType<readonly JsonValue[]>,
          ),
        },
      }),
    );
    expect(cycleFailure.issues).toMatchObject([{ code: "invalid-column-type" }]);
  });

  it("preserves override failures as the SQL definition cause", () => {
    const overrideCause = new Error("override getter failed");
    const overrides = Object.defineProperty({}, "valid", {
      enumerable: true,
      get: () => {
        throw overrideCause;
      },
    });
    const failure = failureOf(() =>
      resolvePostgresRecords({
        records: { valid: explicitRecord(stringField, pg.text()) },
        overrides: overrides as never,
      }),
    );

    expect(failure).toMatchObject({
      cause: overrideCause,
      issues: [{ code: "invalid-override", path: ["overrides"] }],
    });
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
    const mutableCopy = { ...real } as PostgresColumnType<string>;
    expect(() => pg.column({ type: mutableCopy })).toThrow(TypeError);

    const symbol = Reflect.ownKeys(real).find((key) => typeof key === "symbol");
    expect(symbol).toBeTypeOf("symbol");
    const numeric = pg.numeric({ precision: 8, scale: 2 });
    const numericFormat = Reflect.get(numeric, symbol as symbol) as Readonly<
      Record<PropertyKey, unknown>
    >;
    const mutableOptionsType = Object.freeze({
      [symbol as symbol]: Object.freeze({
        ...numericFormat,
        options: { precision: 8, scale: 2 },
      }),
    }) as PostgresColumnType<string>;
    expect(() => pg.column({ type: mutableOptionsType })).toThrow(TypeError);

    const realEnum = pg.enum({ name: "valid_enum", values: ["valid"] });
    const enumFormat = Reflect.get(realEnum, symbol as symbol) as Readonly<
      Record<PropertyKey, unknown>
    >;
    const enumOptions = Reflect.get(enumFormat, "options") as Readonly<
      Record<PropertyKey, unknown>
    >;
    const oversizedEnum = Object.freeze({
      [symbol as symbol]: Object.freeze({
        ...enumFormat,
        options: Object.freeze({
          ...enumOptions,
          values: Object.freeze(["x".repeat(64)]),
        }),
      }),
    }) as PostgresColumnType<string>;
    const oversizedEnumFailure = failureOf(() =>
      resolvePostgresRecords({
        records: { oversized: explicitRecord(stringField, oversizedEnum) },
      }),
    );
    expect(oversizedEnumFailure.issues).toMatchObject([{ code: "invalid-column-type" }]);

    const unfrozenLiteral = { ...sql.literal("fallback") };
    expect(() => sql.column({ default: unfrozenLiteral as never })).toThrow(TypeError);
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
