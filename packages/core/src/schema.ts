import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import type { JsonValue } from "./types.js";

export type StandardSchema<Output = unknown> = StandardSchemaV1<unknown, Output>;

export type ModelSchema<Output = unknown> = StandardSchema<Output> &
  StandardJSONSchemaV1<unknown, Output>;

// The process-local cache does not own Schema lifetimes and records only successful conversions.
const schemaJsonCache = new WeakMap<ModelSchema, JsonValue>();

export type SchemaOutput<Schema> =
  Schema extends StandardSchemaV1<unknown, infer Output> ? Output : never;

export class SchemaValidationError extends Error {
  constructor(
    readonly value: unknown,
    readonly issues: readonly StandardSchemaV1.Issue[],
  ) {
    super("Value does not satisfy its Standard Schema");
    this.name = "SchemaValidationError";
  }
}

export async function validateSchema<Schema extends StandardSchema>(
  schema: Schema,
  value: unknown,
): Promise<SchemaOutput<Schema>> {
  const result = await schema["~standard"].validate(value);
  if ("value" in result) {
    return result.value as SchemaOutput<Schema>;
  }
  throw new SchemaValidationError(value, result.issues ?? []);
}

function canonicalJson(value: unknown, active = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "object" || active.has(value)) {
    throw new TypeError("JSON Schema contains a non-JSON value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("JSON Schema contains a non-JSON object");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => canonicalJson(item, active)));
    }
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = canonicalJson(item, active);
    }
    return Object.freeze(result);
  } finally {
    active.delete(value);
  }
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalJsonObject(value: unknown): { readonly [key: string]: JsonValue } {
  const canonical = canonicalJson(value);
  if (!isJsonObject(canonical)) {
    throw new TypeError("Tool input JSON Schema must be an object");
  }
  return canonical;
}

export function schemaJson(schema: ModelSchema): JsonValue {
  const cached = schemaJsonCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const converter = schema["~standard"].jsonSchema;
  if (converter === undefined) {
    throw new TypeError(
      `Standard Schema vendor '${schema["~standard"].vendor}' does not provide JSON Schema`,
    );
  }
  const converted = canonicalJsonObject(converter.input({ target: "draft-07" }));
  schemaJsonCache.set(schema, converted);
  return converted;
}
