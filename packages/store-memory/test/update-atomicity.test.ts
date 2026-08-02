import { StoreValidationError, type FieldSchema, type JsonValue } from "@commissary/store";
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
      vendor: "commissary-atomic-update-test",
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

it("validates every final Record before any matching update commits", async () => {
  let rejectBadGuard = false;
  const guardSelectField = fieldSchema<string, string>((value) =>
    typeof value === "string" && (!rejectBadGuard || value !== "bad")
      ? { value }
      : { issues: [{ message: "Rejected guard" }] },
  );
  const store = MemoryStore.make({
    records: {
      jobs: {
        fields: {
          id: stringField,
          guard: { select: guardSelectField, create: stringField },
          attempts: numberField,
        },
      },
    },
  });
  const jobs = store.collections.jobs;
  await jobs.create({ id: "valid", guard: "good", attempts: 0 });
  await jobs.create({ id: "invalid", guard: "bad", attempts: 0 });
  rejectBadGuard = true;

  await expect(jobs.update({ set: { attempts: 1 } })).rejects.toBeInstanceOf(StoreValidationError);
  await expect(
    jobs.find({
      orderBy: (fields, op) => [op.asc(fields.id)],
      select: { id: true, attempts: true },
    }),
  ).resolves.toEqual([
    { id: "invalid", attempts: 0 },
    { id: "valid", attempts: 0 },
  ]);
});
