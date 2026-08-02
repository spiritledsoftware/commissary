import { StoreValidationError, type FieldSchema, type JsonValue } from "@commissary/store";
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
      vendor: "commissary-order-test",
      validate,
    },
  };
}

const stringField = fieldSchema<string, string>((value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
);

const numberField = fieldSchema<number, number>((value) =>
  typeof value === "number" ? { value } : { issues: [{ message: "Expected a number" }] },
);

it("orders by multiple fields before offset, limit, and projection", async () => {
  const store = MemoryStore.make({
    records: {
      jobs: {
        fields: {
          id: stringField,
          queue: stringField,
          priority: numberField,
        },
      },
    },
  });
  const jobs = store.collections.jobs;
  await jobs.create({ id: "b-low", queue: "b", priority: 1 });
  await jobs.create({ id: "a-low", queue: "a", priority: 1 });
  await jobs.create({ id: "a-high-first", queue: "a", priority: 3 });
  await jobs.create({ id: "a-high-second", queue: "a", priority: 3 });
  await jobs.create({ id: "b-high", queue: "b", priority: 2 });

  const page = await jobs.find({
    orderBy: (fields, op) => [op.asc(fields.queue), op.desc(fields.priority)],
    offset: 1,
    limit: 3,
    select: { id: true, priority: true },
  });

  expectTypeOf(page).toEqualTypeOf<
    readonly {
      readonly id: string;
      readonly priority: number;
    }[]
  >();
  expect(page).toEqual([
    { id: "a-high-second", priority: 3 },
    { id: "a-low", priority: 1 },
    { id: "b-high", priority: 2 },
  ]);

  const descendingNames = await jobs.find({
    orderBy: (fields, op) => [op.desc(fields.id)],
    select: { id: true },
  });
  expect(descendingNames.map((job) => job.id)).toEqual([
    "b-low",
    "b-high",
    "a-low",
    "a-high-second",
    "a-high-first",
  ]);
});

it("rejects invalid paging and comparison operands", async () => {
  const store = MemoryStore.make({
    records: {
      jobs: {
        fields: {
          id: stringField,
          priority: numberField,
        },
      },
    },
  });
  const jobs = store.collections.jobs;
  await jobs.create({ id: "job", priority: 1 });

  for (const [field, options] of [
    ["limit", { limit: -1 }],
    ["limit", { limit: 1.5 }],
    ["offset", { offset: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const) {
    await expect(jobs.find(options)).rejects.toMatchObject({
      name: "StoreValidationError",
      collection: "jobs",
      operation: "find",
      phase: "query",
      field,
    });
  }

  await expect(
    jobs.find({ where: (fields, op) => op.lt(fields.priority, Number.POSITIVE_INFINITY) }),
  ).rejects.toBeInstanceOf(StoreValidationError);

  await expect(
    jobs.find({
      where: (fields, op) => Reflect.apply(op.lt, undefined, [fields.priority, "cross-type"]),
    }),
  ).rejects.toBeInstanceOf(StoreValidationError);
});
