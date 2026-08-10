import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import {
  type FieldSchema,
  isJsonValue,
  type JsonValue,
  type SelectedRecord,
} from "@commissary/store";
import { compileSqlStatement } from "../../../src/sql/adapter.js";
import { SqlDefinitionError, SqlRecord, sql } from "../../../src/sql/index.js";
import { sqlite, type SqliteColumnType } from "../../../src/sql/sqlite/index.js";
import {
  resolveSqliteRecords,
  type SqliteResolvedColumnType,
} from "../../../src/sql/sqlite/adapter.js";
import { describe, expect, expectTypeOf, it } from "vitest";

const sqliteStatementCompiler = {
  quoteIdentifier: (name: string) => `"${name.replaceAll('"', '""')}"`,
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
      vendor: "commissary-sqlite-record-test",
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
  type: SqliteColumnType<Value>,
) {
  return SqlRecord.define({
    fields: {
      value: {
        select: schema,
        column: sql.column({ sqlite: sqlite.column({ type }) }),
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

function physicalType(type: SqliteResolvedColumnType): string {
  return type.kind === "direct" ? type.type : type.kind;
}

function compileTimeSqliteContracts(): void {
  type JobId = string & { readonly JobId: unique symbol };
  const broadStringType: SqliteColumnType<string> = sqlite.text();
  const brandedType: SqliteColumnType<JobId> = broadStringType;
  expectTypeOf(brandedType).toEqualTypeOf<SqliteColumnType<JobId>>();

  const narrowCustom = sqlite.custom<JobId>({
    type: sql.raw("JOB_ID"),
    encode: String,
    decode: (value) => String(value) as JobId,
  });
  // @ts-expect-error A branded-only codec cannot store every string.
  const invalidBroadType: SqliteColumnType<string> = narrowCustom;
  expectTypeOf(invalidBroadType).toEqualTypeOf<SqliteColumnType<string>>();

  const parameterized = sql`${1}`;
  // @ts-expect-error SQLite custom type structure must not require parameters.
  sqlite.custom<string>({ type: parameterized, encode: String, decode: String });
  // @ts-expect-error SQLite Statement defaults must not require parameters.
  sqlite.column({ type: sqlite.integer(), default: parameterized });
  sqlite.column({
    type: sqlite.integer(),
    // @ts-expect-error SQLite generated expressions must not require parameters.
    generated: { expression: parameterized, mode: "stored" },
  });
}

describe("SQLite metadata helpers", () => {
  it("snapshots and freezes metadata without changing Record inference", () => {
    const tableOptions = { name: "scheduled_jobs" };
    const rowid: { reuse: "allowed" | "forbidden" } = { reuse: "forbidden" };
    const generated: { expression: ReturnType<typeof sql.raw>; mode: "stored" | "virtual" } = {
      expression: sql.raw("upper(state)"),
      mode: "stored",
    };
    const columnOptions = { type: sqlite.integer(), rowid, generated };
    const table = sqlite.table(tableOptions);
    const column = sqlite.column(columnOptions);
    tableOptions.name = "changed";
    rowid.reuse = "allowed";
    generated.mode = "virtual";

    expect(table.name).toBe("scheduled_jobs");
    expect(column.rowid?.reuse).toBe("forbidden");
    expect(column.generated?.mode).toBe("stored");
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(column)).toBe(true);
    expect(Object.isFrozen(column.rowid)).toBe(true);
    expect(Object.isFrozen(column.generated)).toBe(true);

    const definition = SqlRecord.define({
      table: sql.table({ sqlite: table }),
      fields: {
        id: {
          select: integerField,
          column: sql.column({ sqlite: sqlite.column({ type: sqlite.integer() }) }),
        },
      },
    });
    expectTypeOf<SelectedRecord<typeof definition>>().toEqualTypeOf<{ readonly id: number }>();
  });

  it("rejects malformed helper arguments immediately", () => {
    expect(() => sqlite.table(null as never)).toThrow(TypeError);
    expect(() => sqlite.table({ unexpected: true } as never)).toThrow(TypeError);
    expect(() => sqlite.table({ name: "" })).toThrow(TypeError);
    expect(() => sqlite.table({ name: "bad\0name" })).toThrow(TypeError);
    expect(() => sqlite.table({ name: "\ud800" })).toThrow(TypeError);
    expect(() => sqlite.column({ unexpected: true } as never)).toThrow(TypeError);
    expect(() => sqlite.column({ type: sql.text() as never })).toThrow(TypeError);
    expect(() => sqlite.column({ notNull: "yes" as never })).toThrow(TypeError);
    expect(() => sqlite.column({ rowid: { reuse: "sometimes" as never } })).toThrow(TypeError);
    expect(() =>
      sqlite.column({
        generated: { expression: sql`${1}` as never, mode: "stored" },
      }),
    ).toThrow(TypeError);
    expect(() => sqlite.column({ default: sql`${1}` as never })).toThrow(TypeError);
    expect(() =>
      sqlite.custom({ type: sql`${1}` as never, encode: String, decode: String }),
    ).toThrow(TypeError);
    expect(() =>
      sqlite.custom({ type: sql.raw("VECTOR"), encode: undefined as never, decode: String }),
    ).toThrow(TypeError);
  });

  it("keeps exact helper value types and contravariance", () => {
    expectTypeOf(sqlite.integer()).toEqualTypeOf<SqliteColumnType<number>>();
    expectTypeOf(sqlite.boolean()).toEqualTypeOf<SqliteColumnType<boolean>>();
    expectTypeOf(sqlite.timestampSeconds()).toEqualTypeOf<SqliteColumnType<string>>();
    expectTypeOf(sqlite.timestampMilliseconds()).toEqualTypeOf<SqliteColumnType<string>>();
    expectTypeOf(sqlite.real()).toEqualTypeOf<SqliteColumnType<number>>();
    expectTypeOf(sqlite.text()).toEqualTypeOf<SqliteColumnType<string>>();
    expectTypeOf(sqlite.json()).toEqualTypeOf<SqliteColumnType<JsonValue>>();
    expectTypeOf(sqlite.blob()).toEqualTypeOf<SqliteColumnType<string>>();
    expectTypeOf(sqlite.jsonBlob()).toEqualTypeOf<SqliteColumnType<JsonValue>>();
    expectTypeOf(sqlite.bigintBlob()).toEqualTypeOf<SqliteColumnType<string>>();
    expectTypeOf(sqlite.numeric()).toEqualTypeOf<SqliteColumnType<string>>();
    expectTypeOf(sqlite.numericNumber()).toEqualTypeOf<SqliteColumnType<number>>();
    type JobId = string & { readonly JobId: unique symbol };
    expectTypeOf(sqlite.text()).toExtend<SqliteColumnType<JobId>>();

    // @ts-expect-error A string default cannot be used with an explicit numeric type.
    sqlite.column({ type: sqlite.integer(), default: sql.literal("invalid") });
    // @ts-expect-error A numeric type cannot satisfy a string storage contract.
    const invalidStringType: SqliteColumnType<string> = sqlite.integer();
    expectTypeOf(invalidStringType).toEqualTypeOf<SqliteColumnType<string>>();
  });

  it("checks contracts that are compile-time only", () => {
    expectTypeOf(compileTimeSqliteContracts).toBeFunction();
  });
});

describe("SQLite Record resolution", () => {
  it("maps portable storage and applies active SQLite overrides", () => {
    const records = {
      portable: SqlRecord.define({
        table: sql.table({ name: "portable_jobs", sqlite: sqlite.table({ name: "jobs" }) }),
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
              sqlite: sqlite.column({ name: "sqlite_name", type: sqlite.numeric() }),
            }),
          },
        },
      }),
    };
    const resolution = resolveSqliteRecords({ records });
    const table = resolution.tables.portable;

    expect(table.name).toBe("jobs");
    expect(
      Object.fromEntries(
        Object.entries(table.columns).map(([name, column]) => [name, physicalType(column.type)]),
      ),
    ).toEqual({
      text: "text",
      number: "real",
      integer: "integer",
      boolean: "boolean",
      json: "json",
      refined: "numeric",
    });
    expect(table.columns.refined.name).toBe("sqlite_name");
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution.records)).toBe(true);
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(table.columns)).toBe(true);

    const overridden = resolveSqliteRecords({
      records,
      overrides: {
        portable: {
          table: { sqlite: sqlite.table({ name: null }) },
          fields: {
            refined: {
              column: { sqlite: sqlite.column({ name: null, type: null }) },
            },
          },
        },
      },
    });
    expect(overridden.tables.portable.name).toBe("portable_jobs");
    expect(overridden.tables.portable.columns.refined.name).toBe("portable_name");
    expect(overridden.tables.portable.columns.refined.type).toMatchObject({
      kind: "direct",
      type: "text",
    });
  });

  it("resolves every direct helper and canonical codec boundary", () => {
    const direct = {
      integer: explicitRecord(integerField, sqlite.integer()),
      boolean: explicitRecord(booleanField, sqlite.boolean()),
      seconds: explicitRecord(stringField, sqlite.timestampSeconds()),
      milliseconds: explicitRecord(stringField, sqlite.timestampMilliseconds()),
      real: explicitRecord(numberField, sqlite.real()),
      text: explicitRecord(stringField, sqlite.text()),
      json: explicitRecord(jsonField, sqlite.json()),
      blob: explicitRecord(stringField, sqlite.blob()),
      jsonBlob: explicitRecord(jsonField, sqlite.jsonBlob()),
      bigintBlob: explicitRecord(stringField, sqlite.bigintBlob()),
      numeric: explicitRecord(stringField, sqlite.numeric()),
      numericNumber: explicitRecord(numberField, sqlite.numericNumber()),
    };
    const resolution = resolveSqliteRecords({ records: direct });
    const column = (
      name: keyof typeof direct,
    ): {
      readonly encode: (value: unknown) => unknown;
      readonly decode: (value: unknown) => unknown;
    } => {
      // SAFETY: Each selected test table has one resolved value column with an unknown-safe runtime codec.
      return resolution.tables[name].columns.value as {
        readonly encode: (value: unknown) => unknown;
        readonly decode: (value: unknown) => unknown;
      };
    };

    expect(column("integer").encode(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => column("integer").decode(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
    expect(column("boolean").encode(true)).toBe(1);
    expect(column("boolean").decode(0)).toBe(false);
    expect(() => column("boolean").decode(2)).toThrow(TypeError);
    expect(column("seconds").encode("1970-01-01T00:00:00Z")).toBe(0);
    expect(column("seconds").encode("0000-01-01T00:00:00Z")).toBe(-62_167_219_200);
    expect(column("seconds").decode(-62_167_219_200)).toBe("0000-01-01T00:00:00Z");
    expect(() => column("seconds").encode("2025-02-29T00:00:00Z")).toThrow(TypeError);
    expect(() => column("seconds").encode("2026-01-01T00:00:60Z")).toThrow(TypeError);
    expect(column("milliseconds").encode("1970-01-01T00:00:00.001Z")).toBe(1);
    expect(column("milliseconds").decode(1)).toBe("1970-01-01T00:00:00.001Z");
    expect(column("real").encode(-0)).toBe(0);
    expect(() => column("real").encode(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(column("text").decode("exact text")).toBe("exact text");
    expect(() => column("text").encode("bad\0text")).toThrow(TypeError);
    expect(column("json").encode({ state: "ready" })).toBe('{"state":"ready"}');
    expect(column("json").decode('[1,"two",null]')).toEqual([1, "two", null]);
    expect(() => column("json").decode("undefined")).toThrow(TypeError);
    expect(column("blob").encode("AQI=")).toEqual(new Uint8Array([1, 2]));
    expect(column("blob").decode(new Uint8Array([1, 2]))).toBe("AQI=");
    expect(() => column("blob").encode("AB==")).toThrow(TypeError);
    expect(column("jsonBlob").encode({ ok: true })).toEqual(
      new TextEncoder().encode('{"ok":true}'),
    );
    expect(column("jsonBlob").decode(new TextEncoder().encode("[1,2]"))).toEqual([1, 2]);
    expect(() => column("jsonBlob").decode(new Uint8Array([0xff]))).toThrow(TypeError);
    expect(column("bigintBlob").encode("-9223372036854775808")).toEqual(
      new TextEncoder().encode("-9223372036854775808"),
    );
    expect(column("bigintBlob").decode(new TextEncoder().encode("42"))).toBe("42");
    expect(() => column("bigintBlob").encode("+1")).toThrow(TypeError);
    expect(() => column("bigintBlob").encode("-0")).toThrow(TypeError);
    expect(column("numeric").encode("1.25e-3")).toBe("1.25e-3");
    expect(column("numeric").decode(1e21)).toBe("1e21");
    expect(column("numeric").decode(-0)).toBe("0");
    expect(() => column("numeric").encode("1.20")).toThrow(TypeError);
    expect(() => column("numeric").encode("1e+2")).toThrow(TypeError);
    expect(() => column("numeric").encode("1e309")).toThrow(TypeError);
    expect(column("numericNumber").decode(-0)).toBe(0);
  });

  it("resolves custom Statements, encoded values, and converter failures", () => {
    const encodeFailure = new Error("encode failed");
    const decodeFailure = new Error("decode failed");
    const custom = sqlite.custom<{ readonly x: number }>({
      type: sql.raw("VECTOR(3)"),
      encode: (value) => {
        if (value.x < 0) throw encodeFailure;
        return String(value.x);
      },
      decode: (value) => {
        if (value === "bad") throw decodeFailure;
        return { x: Number(value) };
      },
    });
    const invalidEncoder = sqlite.custom<{ readonly x: number }>({
      type: sql.raw("BAD_ENCODER"),
      encode: () => ({ bad: true }) as never,
      decode: () => ({ x: 1 }),
    });
    const invalidNumberEncoder = sqlite.custom<{ readonly x: number }>({
      type: sql.raw("BAD_NUMBER"),
      encode: () => Number.NaN,
      decode: () => ({ x: 1 }),
    });
    const invalidDecoder = sqlite.custom<{ readonly x: number }>({
      type: sql.raw("BAD_DECODER"),
      encode: () => "1",
      decode: () => undefined as never,
    });
    const records = {
      custom: explicitRecord(vectorField, custom),
      invalidEncoder: explicitRecord(vectorField, invalidEncoder),
      invalidNumberEncoder: explicitRecord(vectorField, invalidNumberEncoder),
      invalidDecoder: explicitRecord(vectorField, invalidDecoder),
    };
    const resolution = resolveSqliteRecords({ records });
    const value = resolution.tables.custom.columns.value;

    expect(value.type).toMatchObject({ kind: "custom" });
    expect(value.encode({ x: 2 })).toBe("2");
    expect(value.decode("3")).toEqual({ x: 3 });
    expect(() => value.encode({ x: -1 })).toThrow(encodeFailure);
    expect(() => value.decode("bad")).toThrow(decodeFailure);
    expect(() => resolution.tables.invalidEncoder.columns.value.encode({ x: 1 })).toThrow(
      "SQLite custom encoder output codec received an invalid value",
    );
    expect(() => resolution.tables.invalidNumberEncoder.columns.value.encode({ x: 1 })).toThrow(
      TypeError,
    );
    expect(() => resolution.tables.invalidDecoder.columns.value.decode("1")).toThrow(
      "SQLite custom decoder output codec received an invalid value",
    );
  });

  it("resolves defaults, ROWID generation, generated columns, and references", () => {
    const records = {
      ordinary: SqlRecord.define({
        table: sql.table({ name: "portable_jobs", sqlite: sqlite.table({ name: "jobs" }) }),
        fields: {
          id: {
            select: integerField,
            column: sql.column({
              type: sql.integer(),
              sqlite: sqlite.column({ rowid: {} }),
            }),
          },
          state: {
            select: stringField,
            column: sql.column({
              type: sql.text(),
              default: sql.literal("pending"),
              sqlite: sqlite.column({ default: sql.raw("'ready'") }),
            }),
          },
          virtualValue: {
            select: nullableStringField,
            column: sql.column({
              type: sql.text(),
              sqlite: sqlite.column({
                generated: { expression: sql.raw("upper(state)"), mode: "virtual" },
              }),
            }),
          },
          storedValue: {
            select: nullableStringField,
            column: sql.column({
              type: sql.text(),
              sqlite: sqlite.column({
                generated: { expression: sql.raw("lower(state)"), mode: "stored" },
              }),
            }),
          },
        },
      }),
      neverReuse: SqlRecord.define({
        table: sql.table({ primaryKey: ["id"] }),
        fields: {
          id: {
            select: integerField,
            column: sql.column({
              sqlite: sqlite.column({ type: sqlite.integer(), rowid: { reuse: "forbidden" } }),
            }),
          },
        },
      }),
    };
    const resolution = resolveSqliteRecords({ records });
    const ordinary = resolution.tables.ordinary;

    expect(ordinary.name).toBe("jobs");
    expect(ordinary.primaryKey.map((column) => column.name)).toEqual(["id"]);
    expect(ordinary.columns.id.rowid).toEqual({ reuse: "allowed" });
    expect(ordinary.columns.id.notNull).toBe(true);
    expect(ordinary.columns.id.encode(0)).toBe(0);
    expect(ordinary.columns.id.encode(-1)).toBe(-1);
    expect(resolution.tables.neverReuse.columns.id.rowid).toEqual({ reuse: "forbidden" });
    expect(ordinary.columns.virtualValue.generated).toMatchObject({ mode: "virtual" });
    expect(ordinary.columns.storedValue.generated).toMatchObject({ mode: "stored" });
    const stateDefault = ordinary.columns.state.default;
    expect(typeof stateDefault).toBe("object");
    if (typeof stateDefault !== "object" || stateDefault === null) {
      throw new TypeError("Expected SQLite Statement default");
    }
    expect(compileSqlStatement(stateDefault, sqliteStatementCompiler)).toEqual({
      text: "'ready'",
      segments: ["'ready'"],
      parameters: [],
    });
    const referenceStatement = sql`${resolution.records.ordinary.fields.state} FROM ${resolution.records.ordinary}`;
    expect(compileSqlStatement(referenceStatement, sqliteStatementCompiler)).toEqual({
      text: '"state" FROM "jobs"',
      segments: ['"state" FROM "jobs"'],
      parameters: [],
    });
    expect(Object.isFrozen(ordinary.primaryKey)).toBe(true);
    expect(Object.isFrozen(ordinary.columns.id.rowid)).toBe(true);
    expect(Object.isFrozen(ordinary.columns.virtualValue.generated)).toBe(true);
    expect(Object.isFrozen(resolution.records.ordinary.fields)).toBe(true);

    const overridden = resolveSqliteRecords({
      records,
      overrides: {
        ordinary: {
          table: { sqlite: sqlite.table({ name: null }) },
          fields: {
            state: { column: { sqlite: sqlite.column({ default: null }) } },
          },
        },
      },
    });
    expect(overridden.tables.ordinary.name).toBe("portable_jobs");
    expect(overridden.tables.ordinary.columns.state.default).toBe("pending");
  });

  it("aggregates ROWID, generation, nullability, and table-wide conflicts", () => {
    const records = {
      invalid: SqlRecord.define({
        table: sql.table({ primaryKey: ["other"] }),
        fields: {
          rowid: {
            select: nullableIntegerField,
            column: sql.column({
              default: sql.literal(1),
              sqlite: sqlite.column({
                type: sqlite.integer(),
                notNull: false,
                rowid: {},
                generated: { expression: sql.raw("1"), mode: "stored" },
              }),
            }),
          },
          other: {
            select: integerField,
            column: sql.column({
              sqlite: sqlite.column({ type: sqlite.integer(), rowid: { reuse: "forbidden" } }),
            }),
          },
          wrongType: {
            select: stringField,
            column: sql.column({
              sqlite: sqlite.column({ type: sqlite.text(), rowid: {} as never }),
            }),
          },
        },
      }),
      nullableRowid: SqlRecord.define({
        fields: {
          id: {
            select: nullableIntegerField,
            column: sql.column({
              sqlite: sqlite.column({ type: sqlite.integer(), rowid: {} }),
            }),
          },
        },
      }),
      mismatchedRowid: SqlRecord.define({
        table: sql.table({ primaryKey: ["other"] }),
        fields: {
          id: {
            select: integerField,
            column: sql.column({
              sqlite: sqlite.column({ type: sqlite.integer(), rowid: {} }),
            }),
          },
          other: {
            select: integerField,
            column: sql.column({ type: sql.integer() }),
          },
        },
      }),
      generatedOnly: SqlRecord.define({
        fields: {
          first: {
            select: stringField,
            column: sql.column({
              sqlite: sqlite.column({
                type: sqlite.text(),
                generated: { expression: sql.raw("'a'"), mode: "virtual" },
              }),
            }),
          },
          second: {
            select: stringField,
            column: sql.column({
              sqlite: sqlite.column({
                type: sqlite.text(),
                generated: { expression: sql.raw("'b'"), mode: "stored" },
              }),
            }),
          },
        },
      }),
    };
    const failure = failureOf(() => resolveSqliteRecords({ records }));

    expect(failure.issues.map(({ code }) => code)).toEqual([
      "invalid-database-options",
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
      ["records", "invalid", "fields", "rowid", "column", "sqlite", "rowid"],
      ["records", "invalid", "fields", "rowid", "column", "sqlite", "rowid"],
      ["records", "invalid", "fields", "rowid", "column", "sqlite", "generated"],
      ["records", "invalid", "fields", "rowid", "column", "sqlite", "generated"],
      ["records", "invalid", "fields", "wrongType", "column", "sqlite", "rowid"],
      ["records", "invalid", "fields", "other", "column", "sqlite", "rowid"],
      ["records", "nullableRowid", "fields", "id", "column", "sqlite", "rowid"],
      ["records", "mismatchedRowid", "fields", "id", "column", "sqlite", "rowid"],
      ["records", "generatedOnly", "fields", "second", "column", "sqlite", "generated"],
    ]);
    expect(Object.isFrozen(failure.issues)).toBe(true);
    expect(failure.issues.every((entry) => Object.isFrozen(entry.path))).toBe(true);
  });

  it("uses exact names, ASCII folding, reserved prefixes, and no Unicode normalization", () => {
    const distinctUnicode = {
      composed: SqlRecord.define({
        table: sql.table({ sqlite: sqlite.table({ name: "é" }) }),
        fields: { value: stringField },
      }),
      decomposed: SqlRecord.define({
        table: sql.table({ sqlite: sqlite.table({ name: "e\u0301" }) }),
        fields: { value: stringField },
      }),
    };
    expect(() => resolveSqliteRecords({ records: distinctUnicode })).not.toThrow();

    const records = {
      reserved: SqlRecord.define({
        table: sql.table({ sqlite: sqlite.table({ name: "SQLITE_internal" }) }),
        fields: { value: stringField },
      }),
      columns: SqlRecord.define({
        fields: {
          first: {
            select: stringField,
            column: sql.column({ sqlite: sqlite.column({ name: "State" }) }),
          },
          second: {
            select: stringField,
            column: sql.column({ sqlite: sqlite.column({ name: "state" }) }),
          },
        },
      }),
      firstTable: SqlRecord.define({
        table: sql.table({ sqlite: sqlite.table({ name: "Jobs" }) }),
        fields: { value: stringField },
      }),
      secondTable: SqlRecord.define({
        table: sql.table({ sqlite: sqlite.table({ name: "jobs" }) }),
        fields: { value: stringField },
      }),
    };
    const failure = failureOf(() => resolveSqliteRecords({ records }));

    expect(failure.issues).toMatchObject([
      {
        code: "invalid-name",
        path: ["records", "reserved", "table", "sqlite", "name"],
      },
      {
        code: "duplicate-name",
        path: ["records", "columns", "fields", "second", "column", "sqlite", "name"],
      },
      {
        code: "duplicate-name",
        path: ["records", "secondTable", "table", "sqlite", "name"],
      },
    ]);
  });

  it("accepts compatible opaque copies and rejects incompatible or caller-made values", () => {
    const formatKey = Symbol.for("@commissary/store/sql-opaque-format");
    const realType = sqlite.text();
    const realMetadata = sqlite.column({ type: realType });
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
          column: sql.column({ sqlite: compatibleMetadata as never }),
        },
      },
    });
    expect(() => resolveSqliteRecords({ records: { compatible } })).not.toThrow();

    const incompatibleType = Object.freeze({
      ...realType,
      [formatKey]: Object.freeze({
        ...Reflect.get(realType as object, formatKey),
        format: "commissary-sql-opaque@2",
      }),
    });
    const invalidTypeMetadata = Object.freeze({ ...realMetadata, type: incompatibleType });
    const incompatible = SqlRecord.define({
      fields: {
        value: {
          select: stringField,
          column: sql.column({ sqlite: invalidTypeMetadata as never }),
        },
      },
    });
    expect(
      failureOf(() => resolveSqliteRecords({ records: { incompatible } })).issues,
    ).toMatchObject([{ code: "invalid-column-type" }]);

    const identifiedType = Object.freeze({
      ...realType,
      [formatKey]: Object.freeze({
        ...Reflect.get(realType as object, formatKey),
        identity: Symbol("counterfeit"),
      }),
    });
    const identified = explicitRecord(stringField, identifiedType as never);
    expect(failureOf(() => resolveSqliteRecords({ records: { identified } })).issues).toMatchObject(
      [{ code: "invalid-column-type" }],
    );

    const incompatibleMetadata = Object.freeze({
      ...realMetadata,
      [formatKey]: Object.freeze({
        ...Reflect.get(realMetadata as object, formatKey),
        format: "commissary-sqlite-metadata@2",
      }),
    });
    const counterfeit = SqlRecord.define({
      fields: {
        value: {
          select: stringField,
          column: Object.freeze({ sqlite: incompatibleMetadata }) as never,
        },
      },
    });
    expect(
      failureOf(() => resolveSqliteRecords({ records: { counterfeit } })).issues,
    ).toMatchObject([{ code: "invalid-database-options" }]);

    const lookalike = {
      fields: {
        value: {
          select: stringField,
          column: { sqlite: { type: realType } },
        },
      },
    } as never;
    expect(failureOf(() => resolveSqliteRecords({ records: { lookalike } })).issues).toMatchObject([
      { code: "invalid-database-options" },
    ]);
  });

  it("preserves override failures as aggregate causes", () => {
    const records = { value: explicitRecord(stringField, sqlite.text()) };
    const overrides = Object.create(null) as never;
    Object.defineProperty(overrides, "value", {
      get: () => {
        throw new Error("override failed");
      },
    });
    const failure = failureOf(() => resolveSqliteRecords({ records, overrides }));
    expect(failure.issues).toMatchObject([{ code: "invalid-override", path: ["overrides"] }]);
    expect(failure.cause).toBeInstanceOf(Error);
  });
});
