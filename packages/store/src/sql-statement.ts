import { sqlRecordHelpers } from "./sql-record.js";
import { StoreError } from "./store-errors.js";

/** A portable scalar SQL parameter accepted by every SQL Store Adapter. */
export type SqlParameterValue = null | boolean | number | string;

/** The direct SQL operation that owns one Statement or execution failure. */
export type SqlOperation = "query" | "execute";

/** Configuration for one caller-facing SQL Statement failure. */
export type SqlStatementErrorOptions = {
  readonly operation: SqlOperation;
} & (
  | { readonly reason: "invalid-statement" }
  | {
      readonly reason: "unsupported-parameter";
      readonly parameterPosition: number;
    }
  | {
      readonly reason: "invalid-parameter";
      readonly parameterPosition: number;
      readonly cause?: unknown;
    }
);

/** Expected failure while checking or compiling one SQL Statement. */
export class SqlStatementError extends StoreError {
  /** Stable error class name. */
  override readonly name = "SqlStatementError";
  /** Direct SQL operation that rejected the Statement. */
  readonly operation: SqlOperation;
  /** Stable Statement failure classification. */
  readonly reason: SqlStatementErrorOptions["reason"];
  /** Zero-based parameter position, when one parameter caused the failure. */
  declare readonly parameterPosition?: number;
  /** Original parameter-processing failure, when one callback threw. */
  declare readonly cause?: unknown;

  /** Create one Statement failure without retaining SQL text or parameter values. */
  constructor(options: SqlStatementErrorOptions) {
    super(
      `SQL Statement failed during ${options.operation}: ${options.reason}`,
      ...(options.reason === "invalid-parameter" && options.cause !== undefined
        ? [{ cause: options.cause }]
        : []),
    );
    this.operation = options.operation;
    this.reason = options.reason;
    if (options.reason !== "invalid-statement") {
      this.parameterPosition = options.parameterPosition;
    }
    if (options.reason === "invalid-parameter" && options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

declare const sqlStatementParameter: unique symbol;

/** Opaque immutable SQL structure with a covariant parameter requirement. */
export interface SqlStatement<out Parameter> {
  readonly [sqlStatementParameter]: () => Parameter;
}

const sqlOpaqueFormatSymbol = Symbol.for("@commissary/store/sql-opaque-format");
const sqlOpaqueFormat = "commissary-sql-opaque@1";

interface SqlRawFragment {
  readonly kind: "raw";
  readonly text: string;
}

interface SqlIdentifierFragment {
  readonly kind: "identifier";
  readonly name: string;
}

type SqlParameterEncoder = (value: unknown) => unknown;

interface SqlParameterFragment {
  readonly kind: "parameter";
  readonly value: unknown;
  readonly encode?: SqlParameterEncoder;
}

/** One validated internal Statement fragment used by the adapter-facing compiler. */
export type SqlStatementFragment = SqlRawFragment | SqlIdentifierFragment | SqlParameterFragment;

interface SqlStatementFormat {
  readonly format: typeof sqlOpaqueFormat;
  readonly kind: "statement";
  readonly fragments: readonly SqlStatementFragment[];
}

function isRecordContainer(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSqlParameterEncoder(value: unknown): value is SqlParameterEncoder {
  return typeof value === "function";
}

function isSqlStatementFragment(value: unknown): value is SqlStatementFragment {
  if (!isRecordContainer(value) || !Object.isFrozen(value)) {
    return false;
  }
  const kind = Reflect.get(value, "kind");
  if (kind === "raw") {
    return typeof Reflect.get(value, "text") === "string";
  }
  if (kind === "identifier") {
    const name = Reflect.get(value, "name");
    return typeof name === "string" && name.length > 0 && !name.includes("\0");
  }
  if (kind !== "parameter" || !Object.hasOwn(value, "value")) {
    return false;
  }
  return !Object.hasOwn(value, "encode") || isSqlParameterEncoder(Reflect.get(value, "encode"));
}

function readSqlStatementFormat(value: unknown): SqlStatementFormat | undefined {
  if (!isRecordContainer(value) || !Object.isFrozen(value)) {
    return undefined;
  }
  const format = Reflect.get(value, sqlOpaqueFormatSymbol);
  if (
    !isRecordContainer(format) ||
    !Object.isFrozen(format) ||
    Reflect.get(format, "format") !== sqlOpaqueFormat ||
    Reflect.get(format, "kind") !== "statement"
  ) {
    return undefined;
  }
  const fragments = Reflect.get(format, "fragments");
  if (
    !Array.isArray(fragments) ||
    !Object.isFrozen(fragments) ||
    !fragments.every(isSqlStatementFragment)
  ) {
    return undefined;
  }
  // SAFETY: Every public field and nested fragment was checked above.
  return format as unknown as SqlStatementFormat;
}

/** Read validated package-compatible Statement fragments without exposing them at the root API. */
export function readSqlStatementFragments(
  value: unknown,
): readonly SqlStatementFragment[] | undefined {
  return readSqlStatementFormat(value)?.fragments;
}

/** Test whether a value claims any package SQL Statement opaque format version. */
export function isSqlStatementOpaqueValue(value: unknown): boolean {
  if (!isRecordContainer(value)) {
    return false;
  }
  const format = Reflect.get(value, sqlOpaqueFormatSymbol);
  return isRecordContainer(format) && Reflect.get(format, "kind") === "statement";
}

function createSqlStatement<Parameter>(
  fragments: readonly SqlStatementFragment[],
): SqlStatement<Parameter> {
  const snapshot = Object.freeze(
    fragments.map((fragment) =>
      Object.freeze(
        fragment.kind === "parameter" && fragment.encode !== undefined
          ? {
              kind: fragment.kind,
              value: fragment.value,
              encode: fragment.encode,
            }
          : { ...fragment },
      ),
    ),
  );
  const format: SqlStatementFormat = Object.freeze({
    format: sqlOpaqueFormat,
    kind: "statement",
    fragments: snapshot,
  });
  // SAFETY: This private constructor creates the required opaque runtime representation.
  return Object.freeze({ [sqlOpaqueFormatSymbol]: format }) as unknown as SqlStatement<Parameter>;
}

function appendNestedStatement(
  target: SqlStatementFragment[],
  value: unknown,
  helper: string,
): boolean {
  const fragments = readSqlStatementFragments(value);
  if (fragments !== undefined) {
    target.push(...fragments);
    return true;
  }
  if (isSqlStatementOpaqueValue(value)) {
    throw new TypeError(`${helper} requires a compatible SQL Statement`);
  }
  return false;
}

function isTemplateStringsArray(value: unknown, valueCount: number): value is TemplateStringsArray {
  if (!Array.isArray(value) || value.length !== valueCount + 1) {
    return false;
  }
  const raw = Reflect.get(value, "raw");
  return (
    Array.isArray(raw) &&
    raw.length === value.length &&
    value.every((part) => typeof part === "string") &&
    raw.every((part) => typeof part === "string")
  );
}

type WidenSqlPrimitive<Value> = Value extends string
  ? string
  : Value extends number
    ? number
    : Value extends boolean
      ? boolean
      : Value;

type SqlInterpolationParameter<Value> =
  Value extends SqlStatement<infer Parameter> ? Parameter : WidenSqlPrimitive<Value>;

type SqlTemplateParameter<Values extends readonly unknown[]> = SqlInterpolationParameter<
  Values[number]
>;

type SqlStatementParameter<Value> = Value extends SqlStatement<infer Parameter> ? Parameter : never;

type SqlParameterEncoderOptions<Input, Output> = {
  readonly encode: (value: Input) => Output;
} & ([Extract<Output, SqlStatement<unknown>>] extends [never]
  ? unknown
  : {
      readonly "SQL Statement encoder output must not contain SqlStatement": never;
    });

function defineSqlTemplate<const Values extends readonly unknown[]>(
  strings: TemplateStringsArray,
  ...values: Values
): SqlStatement<SqlTemplateParameter<Values>> {
  if (!isTemplateStringsArray(strings, values.length)) {
    throw new TypeError("SQL template helper requires a valid template string array");
  }
  const fragments: SqlStatementFragment[] = [];
  strings.forEach((text, index) => {
    fragments.push({ kind: "raw", text });
    if (index < values.length) {
      const value = values[index];
      if (!appendNestedStatement(fragments, value, "SQL template helper")) {
        fragments.push({ kind: "parameter", value });
      }
    }
  });
  return createSqlStatement(fragments);
}

function defineSqlRaw(text: string): SqlStatement<never> {
  if (typeof text !== "string") {
    throw new TypeError("SQL raw helper requires a string");
  }
  return createSqlStatement([{ kind: "raw", text }]);
}

function defineSqlIdentifier(name: string): SqlStatement<never> {
  if (typeof name !== "string" || name.length === 0 || name.includes("\0")) {
    throw new TypeError("SQL identifier helper requires a nonempty NUL-free string");
  }
  return createSqlStatement([{ kind: "identifier", name }]);
}

function defineSqlParameter<const Value>(value: Value): SqlStatement<WidenSqlPrimitive<Value>>;
function defineSqlParameter<const Value, Output>(
  value: Value,
  options: SqlParameterEncoderOptions<Value, Output>,
): SqlStatement<WidenSqlPrimitive<Output>>;
function defineSqlParameter(
  value: unknown,
  options?: Readonly<{ encode?: unknown }>,
): SqlStatement<unknown> {
  if (options === undefined) {
    return createSqlStatement([{ kind: "parameter", value }]);
  }
  if (!isRecordContainer(options) || !Object.hasOwn(options, "encode")) {
    throw new TypeError("SQL parameter helper options require an encode function");
  }
  const encode = Reflect.get(options, "encode");
  if (!isSqlParameterEncoder(encode)) {
    throw new TypeError("SQL parameter helper options require an encode function");
  }
  return createSqlStatement([{ kind: "parameter", value, encode }]);
}

function defineSqlJoin<
  const Statements extends readonly SqlStatement<unknown>[],
  const Separator extends SqlStatement<unknown> | undefined = undefined,
>(
  statements: Statements,
  separator?: Separator,
): SqlStatement<
  SqlStatementParameter<Statements[number]> | SqlStatementParameter<Exclude<Separator, undefined>>
> {
  if (!Array.isArray(statements)) {
    throw new TypeError("SQL join helper requires an array of SQL Statements");
  }
  const snapshot = [...statements];
  const separatorFragments = separator === undefined ? [] : readSqlStatementFragments(separator);
  if (separator !== undefined && separatorFragments === undefined) {
    throw new TypeError("SQL join helper separator requires a compatible SQL Statement");
  }
  const fragments: SqlStatementFragment[] = [];
  snapshot.forEach((statement, index) => {
    const statementFragments = readSqlStatementFragments(statement);
    if (statementFragments === undefined) {
      throw new TypeError("SQL join helper requires only compatible SQL Statements");
    }
    if (index > 0 && separatorFragments !== undefined) {
      fragments.push(...separatorFragments);
    }
    fragments.push(...statementFragments);
  });
  return createSqlStatement(fragments);
}

/** SQL Statement, metadata, column type, and literal constructors. */
export const sql = Object.freeze(
  Object.assign(
    defineSqlTemplate,
    sqlRecordHelpers,
    Object.freeze({
      raw: defineSqlRaw,
      identifier: defineSqlIdentifier,
      param: defineSqlParameter,
      join: defineSqlJoin,
    }),
  ),
);
