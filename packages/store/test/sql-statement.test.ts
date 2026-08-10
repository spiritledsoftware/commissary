import {
  SqlStatementError,
  sql,
  type SqlParameterValue,
  type SqlStatement,
} from "@commissary/store";
import {
  compileSqlStatement,
  type SqlStatementCompilerOptions,
} from "@commissary/store/sql-adapter";
import { expect, expectTypeOf, it } from "vitest";

const portableCompiler = {
  quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
  makePlaceholder: (position) => `$${position + 1}`,
  isParameter: (value, _position): value is SqlParameterValue =>
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string",
  convertParameter: (value) => value,
} satisfies SqlStatementCompilerOptions<SqlParameterValue, SqlParameterValue>;

function captureFailure(run: () => unknown): unknown {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected operation to fail");
}

function throwValue(value: unknown): never {
  throw value;
}

function expectOwnUndefinedCause(failure: unknown): void {
  if (!(failure instanceof Error)) {
    throw new TypeError("Expected an Error failure");
  }
  expect(Object.hasOwn(failure, "cause")).toBe(true);
  expect(failure.cause).toBeUndefined();
}

it("rejects malformed SQL helper structure immediately", () => {
  expect(() => sql.raw(1 as never)).toThrow(TypeError);
  expect(() => sql.identifier(1 as never)).toThrow(TypeError);
  expect(() => sql.identifier("")).toThrow(TypeError);
  expect(() => sql.identifier("bad\0name")).toThrow(TypeError);
  expect(() => sql.param("value", {} as never)).toThrow(TypeError);
  expect(() => sql.param("value", { encode: 1 } as never)).toThrow(TypeError);
  expect(() => sql.join("not-an-array" as never)).toThrow(TypeError);
  expect(() => sql.join([{} as never])).toThrow(TypeError);
  expect(() => sql.join([], {} as never)).toThrow(TypeError);

  const malformedTag = sql as unknown as (
    strings: readonly string[],
    ...values: readonly unknown[]
  ) => SqlStatement<unknown>;
  expect(() => malformedTag(["SELECT ", ""], 1)).toThrow(TypeError);
});

it("creates frozen Statements with copied helper structure", () => {
  const formatKey = Symbol.for("@commissary/store/sql-opaque-format");
  const source = [sql`a = ${1}`, sql`b = ${2}`];
  const separatorOptions = { text: " AND " };
  const separator = sql.raw(separatorOptions.text);
  const statement = sql.join(source, separator);

  source.splice(0, source.length, sql.raw("mutated"));
  separatorOptions.text = " OR ";

  const format = Reflect.get(statement, formatKey) as Readonly<Record<string, unknown>>;
  const fragments = Reflect.get(format, "fragments") as readonly object[];
  expect(Object.isFrozen(statement)).toBe(true);
  expect(Object.isFrozen(format)).toBe(true);
  expect(Object.isFrozen(fragments)).toBe(true);
  expect(fragments.every(Object.isFrozen)).toBe(true);
  expect(compileSqlStatement(statement, portableCompiler)).toEqual({
    text: "a = $1 AND b = $2",
    parameters: [1, 2],
    segments: ["a = ", " AND b = ", ""],
  });
});

it("composes nested Statements, raw text, and one-part identifiers", () => {
  const statement = sql`${sql.raw("SELECT $99, ? FROM ")}${sql.identifier(
    "public.users",
  )}${sql.raw(" WHERE ")}${sql.identifier('display"name')} = ${"Ada"}`;

  const compiled = compileSqlStatement(statement, portableCompiler);
  expect(compiled).toEqual({
    text: 'SELECT $99, ? FROM "public.users" WHERE "display""name" = $1',
    parameters: ["Ada"],
    segments: ['SELECT $99, ? FROM "public.users" WHERE "display""name" = ', ""],
  });
  expect(Object.isFrozen(compiled.segments)).toBe(true);
});

it("keeps an array interpolation as one parameter", () => {
  const values = [1, 2, 3];
  const statement = sql`SELECT ${values}`;
  const compiler = {
    ...portableCompiler,
    isParameter: (value: unknown): value is SqlParameterValue | number[] =>
      Array.isArray(value) || portableCompiler.isParameter(value, 0),
    convertParameter: (value: SqlParameterValue | number[]) => value,
  } satisfies SqlStatementCompilerOptions<
    SqlParameterValue | number[],
    SqlParameterValue | number[]
  >;

  const compiled = compileSqlStatement(statement, compiler);
  expect(compiled.parameters).toEqual([values]);
  expect(compiled.parameters[0]).toBe(values);
  expect(compiled.segments).toEqual(["SELECT ", ""]);
});

it("defers failed opaque probes to wider adapter parameter support", () => {
  const formatKey = Symbol.for("@commissary/store/sql-opaque-format");
  let opaqueProbeCount = 0;
  const parameter = new Proxy(
    { id: 1 },
    {
      get: (target, property, receiver) => {
        if (property === formatKey) {
          opaqueProbeCount += 1;
          return throwValue(undefined);
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );

  const statement = sql`SELECT ${parameter}`;
  expect(opaqueProbeCount).toBe(1);

  const compiled = compileSqlStatement(statement, {
    ...portableCompiler,
    isParameter: (value): value is typeof parameter => value === parameter,
    convertParameter: (value) => value,
  });
  expect(compiled.parameters[0]).toBe(parameter);
  expect(compiled.segments).toEqual(["SELECT ", ""]);
});

it("returns a genuine empty Statement and fresh parameter arrays", () => {
  const empty = sql.join([]);
  expectTypeOf(empty).toEqualTypeOf<SqlStatement<never>>();

  const first = compileSqlStatement(empty, portableCompiler);
  const second = compileSqlStatement(empty, portableCompiler);
  expect(first).toEqual({ text: "", parameters: [], segments: [""] });
  expect(first.parameters).not.toBe(second.parameters);
  first.parameters.push("mutation");
  expect(second.parameters).toEqual([]);
});

it("infers widened, covariant, and nested parameter requirements", () => {
  const literalStatement = sql`${"text" as const}${1 as const}${true as const}`;
  const nested = sql`${sql`a = ${1}`}${sql.raw(" AND ")}${sql`b = ${"two"}`}`;
  const encoded = sql.param("12", { encode: Number });
  const wider: SqlStatement<unknown> = nested;

  expectTypeOf(literalStatement).toEqualTypeOf<SqlStatement<string | number | boolean>>();
  expectTypeOf(nested).toEqualTypeOf<SqlStatement<number | string>>();
  expectTypeOf(encoded).toEqualTypeOf<SqlStatement<number>>();
  expectTypeOf(wider).toEqualTypeOf<SqlStatement<unknown>>();

  function sqlStatementCompileTimeContracts(): void {
    // @ts-expect-error A narrower requirement cannot accept a wider Statement.
    const narrower: SqlStatement<number> = wider;
    void narrower;

    // @ts-expect-error An encoder output type cannot contain an SQL Statement.
    sql.param("unsafe", { encode: () => sql.raw("SELECT 1") });

    // @ts-expect-error A union encoder output cannot contain an SQL Statement.
    sql.param("unsafe", {
      encode: (value): string | SqlStatement<never> =>
        value.length > 0 ? value : sql.raw("SELECT 1"),
    });
  }
  void sqlStatementCompileTimeContracts;
});

it("runs captured encoders once per occurrence and compilation", () => {
  const calls: string[] = [];
  const options = {
    encode: (value: number) => {
      calls.push(`original:${value}`);
      return String(value);
    },
  };
  const parameter = sql.param(7, options);
  options.encode = (value) => {
    calls.push(`mutated:${value}`);
    return String(value + 1);
  };
  const statement = sql`${parameter}, ${parameter}`;

  expect(calls).toEqual([]);
  expect(compileSqlStatement(statement, portableCompiler).parameters).toEqual(["7", "7"]);
  expect(calls).toEqual(["original:7", "original:7"]);
  expect(compileSqlStatement(statement, portableCompiler).parameters).toEqual(["7", "7"]);
  expect(calls).toEqual(["original:7", "original:7", "original:7", "original:7"]);
});

it("processes parameters left to right and stops at the first failure", () => {
  const order: string[] = [];
  const expectedCause = new Error("encode failed");
  const first = sql.param("first", {
    encode: (value) => {
      order.push(`encode:${value}`);
      return value;
    },
  });
  const second = sql.param("second", {
    encode: () => {
      order.push("encode:second");
      throw expectedCause;
    },
  });
  const third = sql.param("third", {
    encode: (value) => {
      order.push(`encode:${value}`);
      return value;
    },
  });
  const compiler = {
    ...portableCompiler,
    isParameter: (value: unknown, position: number): value is SqlParameterValue => {
      order.push(`support:${position}`);
      return portableCompiler.isParameter(value, position);
    },
    convertParameter: (value: SqlParameterValue, position: number) => {
      order.push(`convert:${position}`);
      return value;
    },
  } satisfies SqlStatementCompilerOptions<SqlParameterValue, SqlParameterValue>;

  const failure = captureFailure(() =>
    compileSqlStatement(sql`${first}${second}${third}`, compiler),
  );
  expect(failure).toBeInstanceOf(SqlStatementError);
  expect(failure).toMatchObject({
    operation: "execute",
    reason: "invalid-parameter",
    parameterPosition: 1,
    cause: expectedCause,
  });
  expect((failure as Error).cause).toBe(expectedCause);
  expect(order).toEqual(["encode:first", "support:0", "convert:0", "encode:second"]);
});

it("classifies support, portable validation, and conversion failures", () => {
  const supportFailure = captureFailure(() =>
    compileSqlStatement(sql`SELECT ${undefined}` as unknown as SqlStatement<SqlParameterValue>, {
      ...portableCompiler,
      isParameter: (_value): _value is SqlParameterValue => true,
    }),
  );
  expect(supportFailure).toMatchObject({
    reason: "unsupported-parameter",
    parameterPosition: 0,
  });
  expect(supportFailure).not.toHaveProperty("cause");

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "bad\0value"]) {
    const failure = captureFailure(() =>
      compileSqlStatement(sql`SELECT ${value}`, portableCompiler),
    );
    expect(failure).toMatchObject({ reason: "invalid-parameter", parameterPosition: 0 });
    expect(failure).not.toHaveProperty("cause");
  }

  const converted: number[] = [];
  compileSqlStatement(sql`SELECT ${-0}`, {
    ...portableCompiler,
    convertParameter: (value) => {
      if (typeof value === "number") {
        converted.push(value);
      }
      return value;
    },
  });
  expect(Object.is(converted[0], 0)).toBe(true);
  expect(Object.is(converted[0], -0)).toBe(false);

  const conversionCause = new Error("conversion failed");
  const conversionFailure = captureFailure(() =>
    compileSqlStatement(sql`SELECT ${1}`, {
      ...portableCompiler,
      convertParameter: () => {
        throw conversionCause;
      },
    }),
  );
  expect(conversionFailure).toMatchObject({
    reason: "invalid-parameter",
    parameterPosition: 0,
    cause: conversionCause,
  });
});

it("rejects an encoder-produced Statement before adapter parameter checks", () => {
  let supportCalls = 0;
  const statement = sql.param("unsafe", {
    encode: (() => sql.raw("injected")) as never,
  });
  const failure = captureFailure(() =>
    compileSqlStatement(statement as unknown as SqlStatement<SqlParameterValue>, {
      ...portableCompiler,
      isParameter: (value): value is SqlParameterValue => {
        supportCalls += 1;
        return portableCompiler.isParameter(value, 0);
      },
    }),
  );

  expect(failure).toMatchObject({ reason: "invalid-parameter", parameterPosition: 0 });
  expect(failure).not.toHaveProperty("cause");
  expect(supportCalls).toBe(0);
});

it("turns quote and placeholder callback defects into adapter contract errors", () => {
  const quoteCause = new Error("quote failed");
  const quoteFailure = captureFailure(() =>
    compileSqlStatement(sql`${sql.identifier("users")}`, {
      ...portableCompiler,
      quoteIdentifier: () => {
        throw quoteCause;
      },
    }),
  );
  expect(quoteFailure).toMatchObject({
    name: "StoreAdapterContractError",
    operation: "execute",
    violation: "invalid-sql-compilation",
    cause: quoteCause,
  });

  const invalidQuote = captureFailure(() =>
    compileSqlStatement(sql`${sql.identifier("users")}`, {
      ...portableCompiler,
      quoteIdentifier: (() => 1) as never,
    }),
  );
  expect(invalidQuote).toMatchObject({
    operation: "execute",
    violation: "invalid-sql-compilation",
  });
  expect(invalidQuote).not.toHaveProperty("cause");

  const placeholderCause = new Error("placeholder failed");
  const placeholderFailure = captureFailure(() =>
    compileSqlStatement(sql`SELECT ${1}`, {
      ...portableCompiler,
      makePlaceholder: () => {
        throw placeholderCause;
      },
    }),
  );
  expect(placeholderFailure).toMatchObject({
    operation: "execute",
    violation: "invalid-sql-compilation",
    cause: placeholderCause,
  });

  const invalidPlaceholder = captureFailure(() =>
    compileSqlStatement(sql`SELECT ${1}`, {
      ...portableCompiler,
      makePlaceholder: (() => null) as never,
    }),
  );
  expect(invalidPlaceholder).toMatchObject({
    operation: "execute",
    violation: "invalid-sql-compilation",
  });
  expect(invalidPlaceholder).not.toHaveProperty("cause");
});

it("preserves an own cause when a compiler callback throws undefined", () => {
  const encoderFailure = captureFailure(() =>
    compileSqlStatement(
      sql`${sql.param("encoded", { encode: () => throwValue(undefined) })}`,
      portableCompiler,
    ),
  );
  expect(encoderFailure).toMatchObject({
    reason: "invalid-parameter",
    parameterPosition: 0,
  });
  expectOwnUndefinedCause(encoderFailure);

  const supportFailure = captureFailure(() =>
    compileSqlStatement(sql`${1}`, {
      ...portableCompiler,
      isParameter: (_value): _value is SqlParameterValue => throwValue(undefined),
    }),
  );
  expect(supportFailure).toMatchObject({
    reason: "invalid-parameter",
    parameterPosition: 0,
  });
  expectOwnUndefinedCause(supportFailure);

  const conversionFailure = captureFailure(() =>
    compileSqlStatement(sql`${1}`, {
      ...portableCompiler,
      convertParameter: () => throwValue(undefined),
    }),
  );
  expect(conversionFailure).toMatchObject({
    reason: "invalid-parameter",
    parameterPosition: 0,
  });
  expectOwnUndefinedCause(conversionFailure);

  const quoteFailure = captureFailure(() =>
    compileSqlStatement(sql`${sql.identifier("users")}`, {
      ...portableCompiler,
      quoteIdentifier: () => throwValue(undefined),
    }),
  );
  expect(quoteFailure).toMatchObject({ violation: "invalid-sql-compilation" });
  expectOwnUndefinedCause(quoteFailure);

  const placeholderFailure = captureFailure(() =>
    compileSqlStatement(sql`${1}`, {
      ...portableCompiler,
      makePlaceholder: () => throwValue(undefined),
    }),
  );
  expect(placeholderFailure).toMatchObject({ violation: "invalid-sql-compilation" });
  expectOwnUndefinedCause(placeholderFailure);
});

it("accepts compatible package copies and rejects incompatible or counterfeit Statements", () => {
  const formatKey = Symbol.for("@commissary/store/sql-opaque-format");
  const original = sql`SELECT ${1}`;
  const originalFormat = Reflect.get(original, formatKey) as Readonly<Record<string, unknown>>;
  const originalFragments = Reflect.get(originalFormat, "fragments") as readonly object[];
  const copiedFragments = Object.freeze(
    originalFragments.map((fragment) => Object.freeze({ ...fragment })),
  );
  const compatible = Object.freeze({
    [formatKey]: Object.freeze({ ...originalFormat, fragments: copiedFragments }),
  });
  const incompatible = Object.freeze({
    [formatKey]: Object.freeze({
      ...originalFormat,
      format: "commissary-sql-opaque@2",
      fragments: copiedFragments,
    }),
  });

  expect(
    compileSqlStatement(compatible as unknown as SqlStatement<number>, portableCompiler),
  ).toEqual({ text: "SELECT $1", parameters: [1], segments: ["SELECT ", ""] });
  expect(
    compileSqlStatement(sql`(${compatible as unknown as SqlStatement<number>})`, portableCompiler),
  ).toEqual({ text: "(SELECT $1)", parameters: [1], segments: ["(SELECT ", ")"] });

  for (const statement of [incompatible, {}]) {
    const failure = captureFailure(() =>
      compileSqlStatement(statement as unknown as SqlStatement<never>, portableCompiler),
    );
    expect(failure).toMatchObject({
      name: "SqlStatementError",
      operation: "execute",
      reason: "invalid-statement",
    });
    expect(failure).not.toHaveProperty("parameterPosition");
    expect(failure).not.toHaveProperty("cause");
  }
});
