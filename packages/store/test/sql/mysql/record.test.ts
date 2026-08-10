import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import {
  type FieldSchema,
  isJsonValue,
  type JsonValue,
  type SelectedRecord,
} from "@commissary/store";
import { compileSqlStatement } from "../../../src/sql/adapter.js";
import { SqlDefinitionError, SqlRecord, sql } from "../../../src/sql/index.js";
import { mysql, type MysqlColumnType, type MysqlEnum } from "../../../src/sql/mysql/index.js";
import {
  resolveMysqlRecords,
  type MysqlResolvedColumnType,
} from "../../../src/sql/mysql/adapter.js";
import { describe, expect, expectTypeOf, it } from "vitest";

const mysqlStatementCompiler = {
  quoteIdentifier: (name: string) => `\`${name.replaceAll("`", "``")}\``,
  makePlaceholder: () => "?",
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
      vendor: "commissary-mysql-record-test",
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
const enumField = testSchema<"pending" | "ready", "pending" | "ready">(
  (value) =>
    value === "pending" || value === "ready"
      ? { value }
      : { issues: [{ message: "Expected state" }] },
  { type: "string", enum: ["pending", "ready"] },
);
const vectorField = testSchema<{ readonly x: number }, { readonly x: number }>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, "x") === "number"
      ? { value: { x: Reflect.get(value, "x") } }
      : { issues: [{ message: "Expected vector" }] },
  { type: "object" },
);
function explicitRecord<Value extends JsonValue>(
  schema: FieldSchema<Value, Value>,
  type: MysqlColumnType<Value>,
) {
  return SqlRecord.define({
    fields: {
      value: {
        select: schema,
        column: sql.column({ mysql: mysql.column({ type }) }),
      },
    },
  });
}

function failureOf(run: () => unknown): SqlDefinitionError {
  try {
    run();
  } catch (cause) {
    expect(cause).toBeInstanceOf(SqlDefinitionError);
    // SAFETY: The preceding runtime assertion established the caught aggregate error class.
    return cause as SqlDefinitionError;
  }
  throw new Error("Expected SQL definition failure");
}

function physicalType(type: MysqlResolvedColumnType): string {
  return type.kind === "direct" ? type.type : type.kind;
}

function compileTimeMysqlContracts(): void {
  type JobId = string & { readonly JobId: unique symbol };
  const broadStringType: MysqlColumnType<string> = mysql.text();
  const brandedType: MysqlColumnType<JobId> = broadStringType;
  expectTypeOf(brandedType).toEqualTypeOf<MysqlColumnType<JobId>>();

  const narrowCustom = mysql.custom<JobId>({
    type: sql.raw("job_id"),
    encode: String,
    decode: (value) => String(value) as JobId,
  });
  // @ts-expect-error A branded-only codec cannot store every string.
  const invalidBroadType: MysqlColumnType<string> = narrowCustom;
  expectTypeOf(invalidBroadType).toEqualTypeOf<MysqlColumnType<string>>();

  const parameterized = sql`${1}`;
  // @ts-expect-error MySQL custom type structure must not require parameters.
  mysql.custom<string>({ type: parameterized, encode: String, decode: String });
  // @ts-expect-error MySQL Statement defaults must not require parameters.
  mysql.column({ type: mysql.int(), default: parameterized });
  mysql.column({
    type: mysql.int(),
    // @ts-expect-error MySQL generated expressions must not require parameters.
    generated: { expression: parameterized, mode: "stored" },
  });

  const state = mysql.enum({ values: ["pending", "ready"] as const });
  expectTypeOf(state).toEqualTypeOf<MysqlEnum<readonly ["pending", "ready"]>>();
}

describe("MySQL metadata helpers", () => {
  it("snapshots and freezes metadata without changing Record inference", () => {
    const tableOptions = { database: "jobs", name: "scheduled_jobs" };
    const generated: { expression: ReturnType<typeof sql.raw>; mode: "stored" | "virtual" } = {
      expression: sql.raw("upper(state)"),
      mode: "stored",
    };
    const columnOptions = { type: mysql.varchar({ length: 32 }), generated };
    const table = mysql.table(tableOptions);
    const column = mysql.column(columnOptions);
    tableOptions.name = "changed";
    generated.mode = "virtual";

    expect(table).toMatchObject({ database: "jobs", name: "scheduled_jobs" });
    expect(column.generated?.mode).toBe("stored");
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(column)).toBe(true);
    expect(Object.isFrozen(column.generated)).toBe(true);

    const definition = SqlRecord.define({
      table: sql.table({ mysql: table }),
      fields: {
        id: {
          select: stringField,
          column: sql.column({ mysql: mysql.column({ type: mysql.bigint() }) }),
        },
      },
    });
    expectTypeOf<SelectedRecord<typeof definition>>().toEqualTypeOf<{ readonly id: string }>();
  });

  it("rejects malformed helper arguments immediately", () => {
    expect(() => mysql.table({ database: "bad\0name" })).toThrow(TypeError);
    expect(() => mysql.table({ name: "x".repeat(65) })).toThrow(TypeError);
    expect(() => mysql.column({ unexpected: true } as never)).toThrow(TypeError);
    expect(() => mysql.column({ type: sql.text() as never })).toThrow(TypeError);
    expect(() => mysql.decimal({ precision: 2, scale: 3 })).toThrow(TypeError);
    expect(() => mysql.float({ precision: 54 })).toThrow(TypeError);
    expect(() => mysql.double({ scale: 2 })).toThrow(TypeError);
    expect(() => mysql.varchar({ length: 65_536 })).toThrow(TypeError);
    expect(() => mysql.timestamp({ fsp: 7 as never })).toThrow(TypeError);
    expect(() => mysql.enum({ values: ["ready", "ready"] })).toThrow(TypeError);
    expect(() => mysql.enum({ values: ["ready "] })).toThrow(TypeError);
    expect(() =>
      mysql.custom({
        type: sql`${1}` as never,
        encode: String,
        decode: String,
      }),
    ).toThrow(TypeError);
    expect(() =>
      mysql.column({
        type: mysql.int(),
        generated: { expression: sql`${1}` as never, mode: "stored" },
      }),
    ).toThrow(TypeError);
  });

  it("keeps exact helper value types and contravariance", () => {
    expectTypeOf(mysql.tinyint()).toEqualTypeOf<MysqlColumnType<number>>();
    expectTypeOf(mysql.smallint()).toEqualTypeOf<MysqlColumnType<number>>();
    expectTypeOf(mysql.mediumint()).toEqualTypeOf<MysqlColumnType<number>>();
    expectTypeOf(mysql.int()).toEqualTypeOf<MysqlColumnType<number>>();
    expectTypeOf(mysql.bigint()).toEqualTypeOf<MysqlColumnType<string>>();
    expectTypeOf(mysql.decimal()).toEqualTypeOf<MysqlColumnType<string>>();
    expectTypeOf(mysql.float()).toEqualTypeOf<MysqlColumnType<number>>();
    expectTypeOf(mysql.double()).toEqualTypeOf<MysqlColumnType<number>>();
    expectTypeOf(mysql.real()).toEqualTypeOf<MysqlColumnType<number>>();
    expectTypeOf(mysql.boolean()).toEqualTypeOf<MysqlColumnType<boolean>>();
    expectTypeOf(mysql.char()).toEqualTypeOf<MysqlColumnType<string>>();
    expectTypeOf(mysql.varchar({ length: 2 })).toEqualTypeOf<MysqlColumnType<string>>();
    expectTypeOf(mysql.binary()).toEqualTypeOf<MysqlColumnType<string>>();
    expectTypeOf(mysql.varbinary({ length: 2 })).toEqualTypeOf<MysqlColumnType<string>>();
    expectTypeOf(mysql.text()).toEqualTypeOf<MysqlColumnType<string>>();
    expectTypeOf(mysql.json()).toEqualTypeOf<MysqlColumnType<JsonValue>>();
    expectTypeOf(mysql.date()).toEqualTypeOf<MysqlColumnType<string>>();
    expectTypeOf(mysql.datetime()).toEqualTypeOf<MysqlColumnType<string>>();
    expectTypeOf(mysql.time()).toEqualTypeOf<MysqlColumnType<string>>();
    expectTypeOf(mysql.timestamp()).toEqualTypeOf<MysqlColumnType<string>>();
    expectTypeOf(mysql.year()).toEqualTypeOf<MysqlColumnType<number>>();
    expectTypeOf(mysql.serial()).toEqualTypeOf<MysqlColumnType<string>>();
    const state = mysql.enum({ values: ["pending", "ready"] as const });
    expectTypeOf(state).toExtend<MysqlEnum<readonly ["pending", "ready"]>>();
    type JobId = string & { readonly JobId: unique symbol };
    expectTypeOf(mysql.bigint()).toExtend<MysqlColumnType<JobId>>();

    // @ts-expect-error A string default cannot be used with an explicit numeric type.
    mysql.column({ type: mysql.int(), default: sql.literal("invalid") });
    // @ts-expect-error A numeric type cannot satisfy a string storage contract.
    const invalidStringType: MysqlColumnType<string> = mysql.int();
    expectTypeOf(invalidStringType).toEqualTypeOf<MysqlColumnType<string>>();
  });

  it("checks contracts that are compile-time only", () => {
    expectTypeOf(compileTimeMysqlContracts).toBeFunction();
  });
});

describe("MySQL Record resolution", () => {
  it("maps portable storage and applies active MySQL overrides", () => {
    const records = {
      portable: SqlRecord.define({
        table: sql.table({ name: "portable_jobs", mysql: mysql.table({ database: "jobs" }) }),
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
              mysql: mysql.column({ name: "mysql_name", type: mysql.bigint(), notNull: true }),
            }),
          },
        },
      }),
    };
    const resolution = resolveMysqlRecords({ records });
    const table = resolution.tables.portable;

    expect(table.database).toBe("jobs");
    expect(table.name).toBe("portable_jobs");
    expect(
      Object.fromEntries(
        Object.entries(table.columns).map(([name, column]) => [name, physicalType(column.type)]),
      ),
    ).toEqual({
      text: "text",
      number: "double",
      integer: "bigint",
      boolean: "boolean",
      json: "json",
      refined: "bigint",
    });
    expect(table.columns.refined.name).toBe("mysql_name");
    expect(table.columns.integer.encode(42)).toBe(42);
    expect(table.columns.integer.decode(42)).toBe(42);
    expect(() => table.columns.integer.decode("42")).toThrow(TypeError);
    expect(table.columns.integer.encode(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(table.columns.integer.decode(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => table.columns.integer.encode(Number.MAX_SAFE_INTEGER + 2)).toThrow(TypeError);
    expect(() => table.columns.integer.decode(Number.MAX_SAFE_INTEGER + 2)).toThrow(TypeError);
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(table.columns)).toBe(true);
  });

  it("resolves every direct helper and canonical codec boundary", () => {
    const direct = {
      tinyint: explicitRecord(integerField, mysql.tinyint()),
      unsignedTinyint: explicitRecord(integerField, mysql.tinyint({ unsigned: true })),
      smallint: explicitRecord(integerField, mysql.smallint()),
      mediumint: explicitRecord(integerField, mysql.mediumint()),
      int: explicitRecord(integerField, mysql.int()),
      bigint: explicitRecord(stringField, mysql.bigint()),
      unsignedBigint: explicitRecord(stringField, mysql.bigint({ unsigned: true })),
      decimal: explicitRecord(stringField, mysql.decimal({ precision: 8, scale: 2 })),
      unsignedDecimal: explicitRecord(
        stringField,
        mysql.decimal({ precision: 8, scale: 2, unsigned: true }),
      ),
      float: explicitRecord(numberField, mysql.float()),
      double: explicitRecord(numberField, mysql.double()),
      real: explicitRecord(numberField, mysql.real()),
      boolean: explicitRecord(booleanField, mysql.boolean()),
      char: explicitRecord(stringField, mysql.char({ length: 8 })),
      varchar: explicitRecord(stringField, mysql.varchar({ length: 8 })),
      binary: explicitRecord(stringField, mysql.binary({ length: 4 })),
      varbinary: explicitRecord(stringField, mysql.varbinary({ length: 4 })),
      text: explicitRecord(stringField, mysql.text()),
      tinytext: explicitRecord(stringField, mysql.tinytext()),
      mediumtext: explicitRecord(stringField, mysql.mediumtext()),
      longtext: explicitRecord(stringField, mysql.longtext()),
      json: explicitRecord(jsonField, mysql.json()),
      date: explicitRecord(stringField, mysql.date()),
      datetime: explicitRecord(stringField, mysql.datetime({ fsp: 3 })),
      time: explicitRecord(stringField, mysql.time({ fsp: 2 })),
      timestamp: explicitRecord(stringField, mysql.timestamp({ fsp: 6 })),
      year: explicitRecord(integerField, mysql.year()),
      serial: explicitRecord(stringField, mysql.serial()),
    };
    const resolution = resolveMysqlRecords({ records: direct });

    expect(resolution.tables.tinyint.columns.value.encode(127)).toBe(127);
    expect(() => resolution.tables.tinyint.columns.value.encode(128)).toThrow(TypeError);
    expect(resolution.tables.unsignedTinyint.columns.value.encode(255)).toBe(255);
    expect(() => resolution.tables.unsignedTinyint.columns.value.encode(-1)).toThrow(TypeError);
    expect(resolution.tables.smallint.columns.value.encode(32_767)).toBe(32_767);
    expect(() => resolution.tables.smallint.columns.value.encode(32_768)).toThrow(TypeError);
    expect(resolution.tables.mediumint.columns.value.encode(8_388_607)).toBe(8_388_607);
    expect(() => resolution.tables.mediumint.columns.value.encode(8_388_608)).toThrow(TypeError);
    expect(resolution.tables.bigint.columns.value.encode("9223372036854775807")).toBe(
      "9223372036854775807",
    );
    expect(resolution.tables.unsignedBigint.columns.value.encode("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    expect(() => resolution.tables.bigint.columns.value.encode("01")).toThrow(TypeError);
    expect(() => resolution.tables.bigint.columns.value.encode("-0")).toThrow(TypeError);
    expect(resolution.tables.decimal.columns.value.type).toEqual({
      kind: "direct",
      type: "decimal",
      options: { precision: 8, scale: 2 },
    });
    expect(resolution.tables.decimal.columns.value.encode("123456.789")).toBe("123456.789");
    expect(resolution.tables.decimal.columns.value.decode("001.20")).toBe("1.20");
    expect(() => resolution.tables.decimal.columns.value.decode("1.2")).toThrow(TypeError);
    expect(() => resolution.tables.decimal.columns.value.encode("1234567.89")).toThrow(TypeError);
    expect(() => resolution.tables.unsignedDecimal.columns.value.encode("-1.00")).toThrow(
      TypeError,
    );
    expect(() => resolution.tables.double.columns.value.encode(Number.POSITIVE_INFINITY)).toThrow(
      TypeError,
    );
    expect(resolution.tables.double.columns.value.decode(-0)).toBe(0);
    expect(resolution.tables.boolean.columns.value.encode(false)).toBe(0);
    expect(resolution.tables.boolean.columns.value.decode(1)).toBe(true);
    expect(() => resolution.tables.boolean.columns.value.decode(2)).toThrow(TypeError);
    expect(() => resolution.tables.char.columns.value.encode("trailing ")).toThrow(TypeError);
    expect(resolution.tables.char.columns.value.decode("padded  ")).toBe("padded");
    expect(() => resolution.tables.char.columns.value.decode("12345678 ")).toThrow(TypeError);
    expect(() => resolution.tables.varchar.columns.value.encode("123456789")).toThrow(TypeError);
    expect(resolution.tables.binary.columns.value.encode("AAEC")).toEqual(
      new Uint8Array([0, 1, 2]),
    );
    expect(resolution.tables.binary.columns.value.decode(new Uint8Array([0, 1, 2, 0]))).toBe(
      "AAECAA==",
    );
    expect(() => resolution.tables.varbinary.columns.value.encode("QQ=")).toThrow(TypeError);
    expect(resolution.tables.date.columns.value.encode("2024-02-29")).toBe("2024-02-29");
    expect(() => resolution.tables.date.columns.value.encode("2023-02-29")).toThrow(TypeError);
    expect(resolution.tables.datetime.columns.value.decode("2026-08-10T12:34:56")).toBe(
      "2026-08-10T12:34:56.000",
    );
    expect(resolution.tables.time.columns.value.decode("-838:59:59.10")).toBe("-838:59:59.10");
    expect(() => resolution.tables.time.columns.value.encode("839:00:00")).toThrow(TypeError);
    expect(resolution.tables.timestamp.columns.value.decode("2026-08-10T12:34:56.123456Z")).toBe(
      "2026-08-10T12:34:56.123456Z",
    );
    expect(() =>
      resolution.tables.timestamp.columns.value.encode("2026-08-10T12:34:56+02:00"),
    ).toThrow(TypeError);
    expect(resolution.tables.year.columns.value.encode(2155)).toBe(2155);
    expect(() => resolution.tables.year.columns.value.encode(2156)).toThrow(TypeError);
    expect(resolution.tables.serial.columns.value.autoIncrement).toEqual({ key: "serial-unique" });
    expect(() => resolution.tables.serial.columns.value.encode("0")).toThrow(TypeError);
  });

  it("resolves inline enums and custom codecs without calling converters", () => {
    let calls = 0;
    const custom = mysql.custom<{ readonly x: number }>({
      type: sql.raw("vector(3)"),
      encode: (value) => {
        calls += 1;
        if (value.x < 0) throw new Error("encode failed");
        return String(value.x);
      },
      decode: (value) => {
        calls += 1;
        return { x: Number(value) };
      },
    });
    const badDecoder = mysql.custom<{ readonly x: number }>({
      type: sql.raw("bad_decoder"),
      encode: (value) => String(value.x),
      decode: () => undefined as never,
    });
    const badEncoder = mysql.custom<{ readonly x: number }>({
      type: sql.raw("bad_encoder"),
      encode: () => ({ invalid: true }) as never,
      decode: (value) => ({ x: Number(value) }),
    });
    const records = {
      state: explicitRecord(enumField, mysql.enum({ values: ["pending", "ready"] })),
      custom: explicitRecord(vectorField, custom),
      badDecoder: explicitRecord(vectorField, badDecoder),
      badEncoder: explicitRecord(vectorField, badEncoder),
    };
    const resolution = resolveMysqlRecords({ records });
    expect(calls).toBe(0);
    expect(resolution.tables.state.columns.value.type).toEqual({
      kind: "enum",
      values: ["pending", "ready"],
    });
    expect(resolution.tables.state.columns.value.encode("ready")).toBe("ready");
    expect(() => resolution.tables.state.columns.value.decode("other")).toThrow(TypeError);
    expect(resolution.tables.custom.columns.value.type).toMatchObject({ kind: "custom" });
    expect(resolution.tables.custom.columns.value.encode({ x: 2 })).toBe("2");
    expect(resolution.tables.custom.columns.value.decode("3")).toEqual({ x: 3 });
    expect(() => resolution.tables.custom.columns.value.encode({ x: -1 })).toThrow("encode failed");
    expect(calls).toBe(3);
    expect(() => resolution.tables.badDecoder.columns.value.decode("1")).toThrow(TypeError);
    expect(() => resolution.tables.badEncoder.columns.value.encode({ x: 1 })).toThrow(TypeError);
  });

  it("resolves defaults, automatic behavior, generation, references, and null removal", () => {
    const records = {
      jobs: SqlRecord.define({
        table: sql.table({
          name: "portable_jobs",
          primaryKey: ["id"],
          mysql: mysql.table({ database: "jobs", name: "scheduled_jobs" }),
        }),
        fields: {
          id: {
            select: integerField,
            column: sql.column({
              type: sql.integer(),
              mysql: mysql.column({ autoIncrement: true }),
            }),
          },
          state: {
            select: stringField,
            column: sql.column({
              type: sql.text(),
              default: sql.literal("pending"),
              mysql: mysql.column({ default: sql.raw("'ready'") }),
            }),
          },
          updatedAt: {
            select: stringField,
            column: sql.column({
              mysql: mysql.column({
                type: mysql.timestamp({ fsp: 3 }),
                default: sql.raw("CURRENT_TIMESTAMP(3)"),
                onUpdate: "current-timestamp",
              }),
            }),
          },
          derived: {
            select: nullableStringField,
            column: sql.column({
              type: sql.text(),
              mysql: mysql.column({
                generated: { expression: sql.raw("upper(state)"), mode: "virtual" },
              }),
            }),
          },
        },
      }),
    };
    const resolution = resolveMysqlRecords({ records });
    const table = resolution.tables.jobs;

    expect(table).toMatchObject({ database: "jobs", name: "scheduled_jobs" });
    expect(table.primaryKey.map((column) => column.name)).toEqual(["id"]);
    expect(table.columns.id.autoIncrement).toEqual({ key: "host-required" });
    expect(table.columns.id.notNull).toBe(true);
    expect(() => table.columns.id.encode(0)).toThrow(TypeError);
    expect(table.columns.id.encode(4)).toBe(4);
    expect(table.columns.updatedAt.onUpdate).toBe("current-timestamp");
    expect(table.columns.derived.generated).toMatchObject({ mode: "virtual" });
    const stateDefault = table.columns.state.default;
    expect(typeof stateDefault).toBe("object");
    if (typeof stateDefault !== "object" || stateDefault === null) {
      throw new TypeError("Expected MySQL Statement default");
    }
    expect(compileSqlStatement(stateDefault, mysqlStatementCompiler)).toEqual({
      text: "'ready'",
      segments: ["'ready'"],
      parameters: [],
    });
    const referenceStatement = sql`${resolution.records.jobs.fields.state} FROM ${resolution.records.jobs}`;
    expect(compileSqlStatement(referenceStatement, mysqlStatementCompiler)).toEqual({
      text: "`state` FROM `jobs`.`scheduled_jobs`",
      segments: ["`state` FROM `jobs`.`scheduled_jobs`"],
      parameters: [],
    });
    expect(Object.isFrozen(resolution.records.jobs)).toBe(true);
    expect(Object.isFrozen(resolution.records.jobs.fields)).toBe(true);

    const overridden = resolveMysqlRecords({
      records,
      overrides: {
        jobs: {
          table: { mysql: mysql.table({ database: null, name: null }) },
          fields: {
            state: { column: { mysql: mysql.column({ default: null }) } },
          },
        },
      },
    });
    expect(overridden.tables.jobs.database).toBeUndefined();
    expect(overridden.tables.jobs.name).toBe("portable_jobs");
    expect(overridden.tables.jobs.columns.state.default).toBe("pending");
  });

  it("aggregates automatic, generated, update, and nullability conflicts", () => {
    const parameterized = sql`${1}`;
    const records = {
      invalid: SqlRecord.define({
        fields: {
          wrongAutoType: {
            select: stringField,
            column: sql.column({
              mysql: mysql.column({ type: mysql.text(), autoIncrement: true as never }),
            }),
          },
          autoDefault: {
            select: integerField,
            column: sql.column({
              default: sql.literal(1),
              mysql: mysql.column({ type: mysql.int(), autoIncrement: true, notNull: false }),
            }),
          },
          generatedDefault: {
            select: stringField,
            column: sql.column({
              default: sql.literal("fallback"),
              mysql: mysql.column({
                generated: { expression: sql.raw("upper(value)"), mode: "stored" },
              }),
            }),
          },
          generatedParameter: {
            select: stringField,
            column: {
              mysql: Object.freeze({
                ...mysql.column({ type: mysql.text() }),
                generated: { expression: parameterized, mode: "virtual" },
              }),
            } as never,
          },
          updateWithoutDefault: {
            select: stringField,
            column: sql.column({
              mysql: mysql.column({ type: mysql.datetime(), onUpdate: "current-timestamp" }),
            }),
          },
          nullableSerial: {
            select: nullableStringField,
            column: sql.column({ mysql: mysql.column({ type: mysql.serial() as never }) }),
          },
        },
      }),
    };
    const failure = failureOf(() => resolveMysqlRecords({ records }));
    expect(failure.issues.map(({ code }) => code)).toEqual([
      "invalid-database-options",
      "invalid-database-options",
      "invalid-database-options",
      "invalid-database-options",
      "invalid-database-options",
      "invalid-database-options",
      "invalid-database-options",
      "invalid-database-options",
    ]);
    expect(failure.issues.map(({ path }) => path)).toEqual([
      ["records", "invalid", "fields", "wrongAutoType", "column", "mysql", "autoIncrement"],
      ["records", "invalid", "fields", "autoDefault", "column", "mysql", "autoIncrement"],
      ["records", "invalid", "fields", "autoDefault", "column", "mysql", "autoIncrement"],
      ["records", "invalid", "fields", "generatedDefault", "column", "mysql", "generated"],
      [
        "records",
        "invalid",
        "fields",
        "generatedParameter",
        "column",
        "mysql",
        "generated",
        "expression",
      ],
      ["records", "invalid", "fields", "updateWithoutDefault", "column", "mysql", "onUpdate"],
      ["records", "invalid", "fields", "nullableSerial", "column", "notNull"],
      ["records", "invalid", "fields", "nullableSerial", "column", "mysql", "type"],
    ]);
    const autoDefaultMessages = failure.issues
      .filter(({ path }) => path[3] === "autoDefault")
      .map(({ message }) => message);
    expect(autoDefaultMessages).toEqual([
      expect.stringContaining("notNull false"),
      expect.stringContaining("automatic increment conflicts with"),
    ]);
  });

  it("reports winning override paths and stable table-wide collisions", () => {
    const records = {
      first: SqlRecord.define({
        table: sql.table({ mysql: mysql.table({ database: "Jobs", name: "jobs" }) }),
        fields: {
          one: { select: stringField, column: sql.column({ type: sql.text(), name: "one" }) },
          two: { select: stringField, column: sql.column({ type: sql.text(), name: "two" }) },
        },
      }),
      second: SqlRecord.define({
        table: sql.table({ mysql: mysql.table({ database: "jobs", name: "jobs" }) }),
        fields: {
          value: { select: stringField, column: sql.column({ type: sql.text() }) },
        },
      }),
    };
    const failure = failureOf(() =>
      resolveMysqlRecords({
        records,
        overrides: {
          first: {
            fields: {
              two: { column: { mysql: mysql.column({ name: "one" }) } },
            },
          },
        },
      }),
    );
    expect(failure.issues).toMatchObject([
      {
        code: "duplicate-name",
        path: ["overrides", "first", "fields", "two", "column", "mysql", "name"],
      },
      {
        code: "duplicate-name",
        path: ["records", "second", "table", "mysql", "database"],
      },
      {
        code: "duplicate-name",
        path: ["records", "second", "table", "mysql", "name"],
      },
    ]);
  });

  it("uses full Unicode case folding without normalization for database and table collisions", () => {
    const record = (database: string, name: string) =>
      SqlRecord.define({
        table: sql.table({ mysql: mysql.table({ database, name }) }),
        fields: {
          value: { select: stringField, column: sql.column({ type: sql.text() }) },
        },
      });
    const failure = failureOf(() =>
      resolveMysqlRecords({
        records: {
          sharpS: record("Straße", "sharp_s"),
          expanded: record("STRASSE", "expanded"),
          dotless: record("ı", "dotless"),
          dotted: record("i", "dotted"),
          decomposed: record("e\u0301", "decomposed"),
          composed: record("\u00e9", "composed"),
          tableSharpS: record("table_case", "Straße"),
          tableExpanded: record("table_case", "STRASSE"),
        },
      }),
    );
    expect(failure.issues).toMatchObject([
      {
        code: "duplicate-name",
        path: ["records", "expanded", "table", "mysql", "database"],
      },
      {
        code: "duplicate-name",
        path: ["records", "tableExpanded", "table", "mysql", "name"],
      },
    ]);
  });

  it("accepts compatible opaque copies and rejects incompatible or mutable values", () => {
    const formatKey = Symbol.for("@commissary/store/sql-opaque-format");
    const realType = mysql.text();
    const realMetadata = mysql.column({ type: realType });
    const compatibleType = Object.freeze({
      ...realType,
      [formatKey]: Object.freeze({ ...Reflect.get(realType as object, formatKey) }),
    });
    const compatibleMetadata = Object.freeze({
      ...realMetadata,
      type: compatibleType,
      [formatKey]: Object.freeze({ ...Reflect.get(realMetadata as object, formatKey) }),
    });
    const compatible = SqlRecord.define({
      fields: {
        value: {
          select: stringField,
          column: sql.column({ mysql: compatibleMetadata as never }),
        },
      },
    });
    expect(() => resolveMysqlRecords({ records: { compatible } })).not.toThrow();

    const incompatibleType = Object.freeze({
      ...realType,
      [formatKey]: Object.freeze({
        ...Reflect.get(realType as object, formatKey),
        format: "commissary-sql-opaque@2",
      }),
    });
    const invalidTypeMetadata = Object.freeze({
      ...realMetadata,
      type: incompatibleType,
    });
    const incompatible = SqlRecord.define({
      fields: {
        value: {
          select: stringField,
          column: sql.column({ mysql: invalidTypeMetadata as never }),
        },
      },
    });
    expect(
      failureOf(() => resolveMysqlRecords({ records: { incompatible } })).issues,
    ).toMatchObject([{ code: "invalid-column-type" }]);

    const identifiedType = Object.freeze({
      ...realType,
      [formatKey]: Object.freeze({
        ...Reflect.get(realType as object, formatKey),
        identity: Symbol("counterfeit"),
      }),
    });
    const identified = explicitRecord(stringField, identifiedType as never);
    expect(failureOf(() => resolveMysqlRecords({ records: { identified } })).issues).toMatchObject([
      { code: "invalid-column-type" },
    ]);

    const incompatibleMetadata = Object.freeze({
      ...realMetadata,
      [formatKey]: Object.freeze({
        ...Reflect.get(realMetadata as object, formatKey),
        format: "commissary-mysql-metadata@2",
      }),
    });
    const counterfeit = SqlRecord.define({
      fields: {
        value: {
          select: stringField,
          column: Object.freeze({ mysql: incompatibleMetadata }) as never,
        },
      },
    });
    expect(failureOf(() => resolveMysqlRecords({ records: { counterfeit } })).issues).toMatchObject(
      [{ code: "invalid-database-options" }],
    );

    const unknownMetadata = Object.freeze({
      ...realMetadata,
      unexpected: true,
    });
    const unknown = SqlRecord.define({
      fields: {
        value: {
          select: stringField,
          column: Object.freeze({ mysql: unknownMetadata }) as never,
        },
      },
    });
    expect(failureOf(() => resolveMysqlRecords({ records: { unknown } })).issues).toMatchObject([
      { code: "invalid-database-options" },
    ]);
  });

  it("preserves override failures as aggregate causes", () => {
    const records = { value: explicitRecord(stringField, mysql.text()) };
    const failure = failureOf(() =>
      resolveMysqlRecords({ records, overrides: { missing: {} } as never }),
    );
    expect(failure.issues).toMatchObject([{ code: "invalid-override", path: ["overrides"] }]);
    expect(failure.cause).toBeInstanceOf(TypeError);
  });

  it("excludes top-level SQL NULL from resolved codec types", () => {
    const nullable = SqlRecord.define({
      fields: {
        value: {
          select: nullableIntegerField,
          column: sql.column({ mysql: mysql.column({ type: mysql.int() as never }) }),
        },
      },
    });
    const resolution = resolveMysqlRecords({ records: { nullable } });
    expectTypeOf(resolution.tables.nullable.columns.value.encode)
      .parameter(0)
      .toEqualTypeOf<number>();
    expect(resolution.tables.nullable.columns.value.notNull).toBe(false);
  });
});
