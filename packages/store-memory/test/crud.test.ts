import { type FieldSchema, type JsonValue } from "@commissary/store";
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
      vendor: "commissary-crud-test",
      validate,
    },
  };
}

const stringField = fieldSchema<string, string>((value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
);

const numberField = fieldSchema<number, number>((value) =>
  typeof value === "number" && Number.isFinite(value)
    ? { value }
    : { issues: [{ message: "Expected a finite number" }] },
);

it("returns one created Record and affected mutation counts", async () => {
  const store = MemoryStore.make({
    records: {
      jobs: {
        fields: {
          id: stringField,
          status: stringField,
          attempts: numberField,
        },
      },
    },
  });
  const jobs = store.collections.jobs;

  await expect(jobs.create({ id: "one", status: "queued", attempts: 0 })).resolves.toEqual({
    id: "one",
    status: "queued",
    attempts: 0,
  });
  await jobs.create({ id: "two", status: "queued", attempts: 0 });

  await expect(
    jobs.update({
      where: (fields, op) => op.eq(fields.id, "one"),
      set: { status: "running", attempts: 1 },
    }),
  ).resolves.toBe(1);
  await expect(
    jobs.count({ where: (fields, op) => op.eq(fields.status, "running") }),
  ).resolves.toBe(1);

  await expect(jobs.update({ set: { attempts: 2 } })).resolves.toBe(2);
  await expect(jobs.count()).resolves.toBe(2);
  await expect(jobs.delete({ where: (fields, op) => op.eq(fields.id, "one") })).resolves.toBe(1);
  await expect(jobs.delete()).resolves.toBe(1);
  await expect(jobs.count()).resolves.toBe(0);
});

it("does not add cancellation to base Collection methods", () => {
  const jobs = MemoryStore.make({
    records: {
      jobs: { fields: { id: stringField } },
    },
  }).collections.jobs;
  const signal = new AbortController().signal;

  const invalidCalls = () => {
    // @ts-expect-error base find has no cancellation option
    void jobs.find({ signal });
    // @ts-expect-error base update has no cancellation option
    void jobs.update({ set: { id: "next" }, signal });
    // @ts-expect-error base delete has no cancellation option
    void jobs.delete({ signal });
    // @ts-expect-error base count has no cancellation option
    void jobs.count({ signal });
  };
  expect(invalidCalls).toBeTypeOf("function");
});
