import { StoreAdapterContractError } from "./store-errors.js";
import { SqlStatementError } from "./sql-errors.js";
import {
  isSqlStatementOpaqueValue,
  readSqlStatementFragments,
  type SqlStatement,
  type SqlStatementFragment,
} from "./sql-statement.js";

/** Adapter callbacks that compile and convert one parameter-safe SQL Statement. */
export interface SqlStatementCompilerOptions<Parameter, DriverParameter> {
  /** Quote one complete database identifier part. */
  readonly quoteIdentifier: (name: string) => string;
  /** Make one placeholder for a zero-based parameter position. */
  readonly makePlaceholder: (position: number) => string;
  /** Test whether the adapter accepts one encoded parameter. */
  readonly isParameter: (value: unknown, position: number) => value is Parameter;
  /** Convert one accepted parameter to its direct driver representation. */
  readonly convertParameter: (value: Parameter, position: number) => DriverParameter;
}

/** Driver-ready SQL text, values, and exact structure around each value. */
export interface CompiledSqlStatement<DriverParameter> {
  /** Final SQL text with adapter placeholders. */
  readonly text: string;
  /** Fresh mutable driver-owned parameter array in source order. */
  readonly parameters: DriverParameter[];
  /** Frozen exact SQL structure before, between, and after parameters. */
  readonly segments: readonly string[];
}

function invalidSqlCompilation(options?: { readonly cause: unknown }): StoreAdapterContractError {
  return new StoreAdapterContractError({
    operation: "execute",
    violation: "invalid-sql-compilation",
    writesMayRemain: false,
    ...(options === undefined ? {} : { cause: options.cause }),
  });
}

function callSqlStructureCallback(callback: () => unknown): string {
  let result: unknown;
  try {
    result = callback();
  } catch (cause) {
    throw invalidSqlCompilation({ cause });
  }
  if (typeof result !== "string") {
    throw invalidSqlCompilation();
  }
  return result;
}

function appendSqlStructure(
  segments: string[],
  fragment: SqlStatementFragment,
  options: SqlStatementCompilerOptions<unknown, unknown>,
): void {
  const segmentIndex = segments.length - 1;
  const segment = segments[segmentIndex];
  if (segment === undefined) {
    throw invalidSqlCompilation();
  }
  if (fragment.kind === "raw") {
    segments[segmentIndex] = segment + fragment.text;
    return;
  }
  if (fragment.kind === "identifier") {
    const identifier = callSqlStructureCallback(() => options.quoteIdentifier(fragment.name));
    segments[segmentIndex] = segment + identifier;
    return;
  }
  segments.push("");
}

function normalizePortableParameter<Parameter>(value: Parameter, position: number): Parameter {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SqlStatementError({
        operation: "execute",
        reason: "invalid-parameter",
        parameterPosition: position,
      });
    }
    if (Object.is(value, -0)) {
      // SAFETY: JavaScript negative zero and zero share the same number type.
      return 0 as Parameter;
    }
  }
  if (typeof value === "string" && value.includes("\0")) {
    throw new SqlStatementError({
      operation: "execute",
      reason: "invalid-parameter",
      parameterPosition: position,
    });
  }
  return value;
}

function compileSqlParameter<Parameter, DriverParameter>(
  fragment: Extract<SqlStatementFragment, { readonly kind: "parameter" }>,
  position: number,
  options: SqlStatementCompilerOptions<Parameter, DriverParameter>,
): DriverParameter {
  let value = fragment.value;
  if (fragment.encode !== undefined) {
    try {
      value = fragment.encode(value);
    } catch (cause) {
      throw new SqlStatementError({
        operation: "execute",
        reason: "invalid-parameter",
        parameterPosition: position,
        cause,
      });
    }
    if (isSqlStatementOpaqueValue(value)) {
      throw new SqlStatementError({
        operation: "execute",
        reason: "invalid-parameter",
        parameterPosition: position,
      });
    }
  }

  let supported: boolean;
  try {
    supported = options.isParameter(value, position);
  } catch (cause) {
    throw new SqlStatementError({
      operation: "execute",
      reason: "invalid-parameter",
      parameterPosition: position,
      cause,
    });
  }
  if (!supported || value === undefined) {
    throw new SqlStatementError({
      operation: "execute",
      reason: "unsupported-parameter",
      parameterPosition: position,
    });
  }

  // SAFETY: The adapter type predicate accepted this exact value by reference.
  const parameter = normalizePortableParameter(value as Parameter, position);
  try {
    return options.convertParameter(parameter, position);
  } catch (cause) {
    throw new SqlStatementError({
      operation: "execute",
      reason: "invalid-parameter",
      parameterPosition: position,
      cause,
    });
  }
}

/** Compile one opaque SQL Statement without parsing SQL text or calling a driver. */
export function compileSqlStatement<Parameter, DriverParameter>(
  statement: SqlStatement<Parameter>,
  options: SqlStatementCompilerOptions<Parameter, DriverParameter>,
): CompiledSqlStatement<DriverParameter> {
  let fragments: readonly SqlStatementFragment[] | undefined;
  try {
    fragments = readSqlStatementFragments(statement);
  } catch {
    fragments = undefined;
  }
  if (fragments === undefined) {
    throw new SqlStatementError({
      operation: "execute",
      reason: "invalid-statement",
    });
  }

  const segments = [""];
  for (const fragment of fragments) {
    appendSqlStructure(
      segments,
      fragment,
      // SAFETY: Structure callbacks do not use either generic parameter type.
      options as SqlStatementCompilerOptions<unknown, unknown>,
    );
  }

  const parameterCount = segments.length - 1;
  const placeholders: string[] = [];
  for (let position = 0; position < parameterCount; position += 1) {
    placeholders.push(callSqlStructureCallback(() => options.makePlaceholder(position)));
  }

  const parameters: DriverParameter[] = [];
  let position = 0;
  for (const fragment of fragments) {
    if (fragment.kind !== "parameter") {
      continue;
    }
    parameters.push(compileSqlParameter(fragment, position, options));
    position += 1;
  }

  let text = segments[0] ?? "";
  placeholders.forEach((placeholder, placeholderPosition) => {
    text += placeholder;
    text += segments[placeholderPosition + 1] ?? "";
  });

  return {
    text,
    parameters,
    segments: Object.freeze([...segments]),
  };
}
