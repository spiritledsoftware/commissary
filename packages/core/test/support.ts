import type { JsonValue, ModelSchema } from "@commissary/core";

export function testSchema<Output extends JsonValue>(
  guard: (value: unknown) => value is Output,
  jsonSchema: Record<string, unknown>,
): ModelSchema<Output, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-test",
      validate(value) {
        return guard(value) ? { value } : { issues: [{ message: "invalid test value" }] };
      },
      jsonSchema: {
        input() {
          return jsonSchema;
        },
        output() {
          return jsonSchema;
        },
      },
    },
  };
}

export const stringSchema = testSchema((value): value is string => typeof value === "string", {
  type: "string",
});

export const numberSchema = testSchema((value): value is number => typeof value === "number", {
  type: "number",
});
