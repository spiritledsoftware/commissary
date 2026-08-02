import { type FieldSchema, type JsonValue } from "@commissary/store";
import { expect, expectTypeOf, it } from "vitest";

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
      vendor: "commissary-projection-test",
      validate,
    },
  };
}

const stringField = fieldSchema<string, string>((value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
);

it("parses only projected and expression-referenced fields once", async () => {
  let statusSelects = 0;
  let unrelatedSelects = 0;
  const statusSelectField = fieldSchema<string, string>((value) => {
    statusSelects += 1;
    return typeof value === "string"
      ? { value: value.toUpperCase() }
      : { issues: [{ message: "Expected a string" }] };
  });
  const unrelatedSelectField = fieldSchema<string, string>((value) => {
    unrelatedSelects += 1;
    return typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] };
  });
  const store = MemoryStore.make({
    records: {
      jobs: {
        fields: {
          id: stringField,
          status: { select: statusSelectField, create: stringField },
          unrelated: { select: unrelatedSelectField, create: stringField },
        },
      },
    },
  });
  const jobs = store.collections.jobs;
  await jobs.create({ id: "one", status: "queued", unrelated: "hidden-one" });
  await jobs.create({ id: "two", status: "done", unrelated: "hidden-two" });
  statusSelects = 0;
  unrelatedSelects = 0;

  const selected = await jobs.find({
    where: (fields, op) => op.eq(fields.status, "QUEUED"),
    orderBy: (fields, op) => [op.asc(fields.status)],
    select: { id: true, status: true },
  });

  expectTypeOf(selected).toEqualTypeOf<
    readonly {
      readonly id: string;
      readonly status: string;
    }[]
  >();
  expect(selected).toEqual([{ id: "one", status: "QUEUED" }]);
  expect(statusSelects).toBe(2);
  expect(unrelatedSelects).toBe(0);

  await jobs.find();
  expect(unrelatedSelects).toBe(2);
});
