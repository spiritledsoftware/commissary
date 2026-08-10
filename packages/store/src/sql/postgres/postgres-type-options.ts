/** Supported PostgreSQL interval field ranges in declaration order. */
export const postgresIntervalFieldValues = Object.freeze([
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "year to month",
  "day to hour",
  "day to minute",
  "day to second",
  "hour to minute",
  "hour to second",
  "minute to second",
] as const);

/** One supported PostgreSQL interval field range. */
export type PostgresIntervalField = (typeof postgresIntervalFieldValues)[number];

const postgresIntervalFieldSet: ReadonlySet<unknown> = new Set(postgresIntervalFieldValues);

function isOptionalIntegerInRange(value: unknown, minimum: number, maximum: number): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum)
  );
}

/** Test one optional PostgreSQL NUMERIC precision value. */
export function isPostgresNumericPrecisionOption(value: unknown): boolean {
  return isOptionalIntegerInRange(value, 1, 1000);
}

/** Test one optional PostgreSQL NUMERIC scale value. */
export function isPostgresNumericScaleOption(value: unknown): boolean {
  return isOptionalIntegerInRange(value, -1000, 1000);
}

/** Test whether PostgreSQL NUMERIC scale has its required precision. */
export function isPostgresNumericScaleCompatible(precision: unknown, scale: unknown): boolean {
  return scale === undefined || precision !== undefined;
}

/** Test one optional PostgreSQL CHAR or VARCHAR length value. */
export function isPostgresCharacterLengthOption(value: unknown): boolean {
  return isOptionalIntegerInRange(value, 1, 10_485_760);
}

/** Test one optional PostgreSQL temporal fractional-second precision value. */
export function isPostgresTemporalPrecisionOption(value: unknown): boolean {
  return isOptionalIntegerInRange(value, 0, 6);
}

/** Test one optional PostgreSQL time-zone mode value. */
export function isPostgresTimeZoneOption(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

/** Test one optional PostgreSQL interval field range. */
export function isPostgresIntervalFieldOption(
  value: unknown,
): value is PostgresIntervalField | undefined {
  return value === undefined || postgresIntervalFieldSet.has(value);
}

/** Test whether PostgreSQL interval precision applies to seconds. */
export function isPostgresIntervalPrecisionCompatible(
  fields: unknown,
  precision: unknown,
): boolean {
  return (
    precision === undefined ||
    fields === undefined ||
    (typeof fields === "string" && fields.includes("second"))
  );
}
