/** Test one optional MySQL UNSIGNED option. */
export function isMysqlUnsignedOption(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

/** Test one MySQL DECIMAL precision. */
export function isMysqlDecimalPrecisionOption(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65)
  );
}

/** Test one MySQL fixed-point scale. */
export function isMysqlDecimalScaleOption(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 30)
  );
}

/** Test whether MySQL DECIMAL precision and scale options can be combined. */
export function isMysqlDecimalScaleCompatible(precision: unknown, scale: unknown): boolean {
  return (
    scale === undefined ||
    (typeof precision === "number" && typeof scale === "number" && scale <= precision)
  );
}

/** Test one MySQL floating-point precision, including legacy scale forms. */
export function isMysqlFloatPrecisionOption(
  type: "float" | "double" | "real",
  precision: unknown,
  scale: unknown,
): boolean {
  if (precision === undefined) return true;
  if (typeof precision !== "number" || !Number.isInteger(precision)) return false;
  if (type === "float" && scale === undefined) return precision >= 0 && precision <= 53;
  return precision >= 1 && precision <= 255;
}

/** Test one MySQL legacy floating-point scale. */
export function isMysqlFloatScaleOption(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 30)
  );
}

/** Test whether MySQL floating-point precision and scale options can be combined. */
export function isMysqlFloatScaleCompatible(precision: unknown, scale: unknown): boolean {
  return (
    scale === undefined ||
    (typeof precision === "number" && typeof scale === "number" && scale <= precision)
  );
}

/** Test one optional MySQL CHAR or BINARY length. */
export function isMysqlOptionalLengthOption(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255)
  );
}

/** Test one required MySQL VARCHAR or VARBINARY length. */
export function isMysqlRequiredLengthOption(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= 65_535;
}

/** Test one optional MySQL fractional-seconds precision. */
export function isMysqlFractionalSecondsOption(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6)
  );
}
