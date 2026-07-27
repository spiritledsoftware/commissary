import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import type { JsonValue } from "./types.js";

export type StandardSchema<Output = unknown> = StandardSchemaV1<unknown, Output>;

export type ModelSchema<Output = unknown> = StandardSchema<Output> &
  StandardJSONSchemaV1<unknown, Output>;

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

export function schemaJson(schema: ModelSchema): JsonValue {
  const converter = schema["~standard"].jsonSchema;
  if (converter === undefined) {
    throw new TypeError(
      `Standard Schema vendor '${schema["~standard"].vendor}' does not provide JSON Schema`,
    );
  }
  return converter.input({ target: "draft-07" }) as JsonValue;
}
