/** A scalar value that can be stored in JSON. */
export type JsonPrimitive = string | number | boolean | null;

/** A readonly JSON array. */
export type JsonArray = readonly JsonValue[];

/** A readonly JSON object with string keys. */
export type JsonObject = {
  readonly [key: string]: JsonValue;
};

/** A value that can cross a Store persistence boundary. */
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

function isJsonPrimitiveValue(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isJsonValueWithActive(value: unknown, active: Set<object>): value is JsonValue {
  if (isJsonPrimitiveValue(value)) {
    return true;
  }
  if (typeof value !== "object" || active.has(value)) {
    return false;
  }
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
  }

  active.add(value);
  try {
    return Array.isArray(value)
      ? value.every((item) => isJsonValueWithActive(item, active))
      : Object.values(value).every((item) => isJsonValueWithActive(item, active));
  } finally {
    active.delete(value);
  }
}

/** Return true when a value is finite, acyclic JSON data. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (isJsonPrimitiveValue(value)) {
    return true;
  }
  if (typeof value !== "object") {
    return false;
  }
  return isJsonValueWithActive(value, new Set());
}
