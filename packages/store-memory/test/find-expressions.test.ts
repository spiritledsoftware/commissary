import { type FieldSchema, type JsonObject, type JsonValue } from "@commissary/store";
import { expect, it } from "vitest";

import { MemoryStore } from "../src/index.js";

type SchemaResult<Output> =
  | { readonly value: Output }
  | { readonly issues: readonly { readonly message: string }[] };

function fieldSchema<Input, Output extends JsonValue | undefined>(
  validate: (value: unknown) => SchemaResult<Output>,
): FieldSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-find-test",
      validate,
    },
  };
}

const stringField = fieldSchema<string, string>((value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
);

const nullableStringField = fieldSchema<string | null | undefined, string | null | undefined>(
  (value) =>
    value === undefined || value === null || typeof value === "string"
      ? { value }
      : { issues: [{ message: "Expected a nullable string" }] },
);

const defaultedSelectField = fieldSchema<string | undefined, string>((value) =>
  value === undefined
    ? { value: "default" }
    : typeof value === "string"
      ? { value }
      : { issues: [{ message: "Expected a string" }] },
);

const omittedCreateField = fieldSchema<string | undefined, string | undefined>((value) =>
  value === undefined || typeof value === "string"
    ? { value }
    : { issues: [{ message: "Expected an optional string" }] },
);

const jsonObjectField = fieldSchema<JsonObject, JsonObject>((value) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? { value: value as JsonObject }
    : { issues: [{ message: "Expected an object" }] },
);

const jsonArrayField = fieldSchema<readonly JsonValue[], readonly JsonValue[]>((value) =>
  Array.isArray(value)
    ? { value: value as readonly JsonValue[] }
    : { issues: [{ message: "Expected an array" }] },
);

it("evaluates eq, and, and isNull against selected field values", async () => {
  const store = MemoryStore.make({
    records: {
      items: {
        fields: {
          id: stringField,
          note: nullableStringField,
          label: {
            select: defaultedSelectField,
            create: omittedCreateField,
          },
          metadata: jsonObjectField,
          steps: jsonArrayField,
        },
      },
    },
  });
  const items = store.collections.items;
  await items.create({ id: "missing", metadata: { a: 1, b: 2 }, steps: [1, 2] });
  await items.create({
    id: "null",
    note: null,
    metadata: { b: 2, a: 1 },
    steps: [1, 2],
  });
  await items.create({
    id: "defined",
    note: "value",
    label: "explicit",
    metadata: { a: 1, b: 2 },
    steps: [2, 1],
  });

  const nullish = await items.find({
    where: (fields, op) =>
      op.and(op.isNull(fields.note), op.eq(fields.label, "default"), undefined),
  });
  expect(nullish.map((item) => item.id)).toEqual(["missing", "null"]);

  const structurallyEqual = await items.find({
    where: (fields, op) =>
      op.and(op.eq(fields.metadata, { b: 2, a: 1 }), op.eq(fields.steps, [1, 2])),
  });
  expect(structurallyEqual.map((item) => item.id)).toEqual(["missing", "null"]);

  await expect(items.find({ where: (_fields, op) => op.or() })).resolves.toEqual([]);
  await expect(items.find({ where: (_fields, op) => op.and() })).resolves.toHaveLength(3);
});
