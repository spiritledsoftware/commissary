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
      vendor: "commissary-store-test",
      validate,
    },
  };
}

const stringField = fieldSchema<string, string>((value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
);

const optionalStringField = fieldSchema<string | undefined, string | undefined>((value) =>
  value === undefined || typeof value === "string"
    ? { value }
    : { issues: [{ message: "Expected an optional string" }] },
);

const numberFromStringField = fieldSchema<string, number>((value) =>
  typeof value === "string"
    ? { value: value.length }
    : { issues: [{ message: "Expected a string" }] },
);

const numberField = fieldSchema<number, number>((value) =>
  typeof value === "number" ? { value } : { issues: [{ message: "Expected a number" }] },
);

it("rejects Field Definitions whose outputs cannot re-enter Select", () => {
  MemoryStore.make({
    records: {
      incompatibleSelect: {
        fields: {
          // @ts-expect-error Select output number cannot re-enter Select input string.
          value: numberFromStringField,
        },
      },
    },
  });

  MemoryStore.make({
    records: {
      incompatibleCreate: {
        fields: {
          // @ts-expect-error Create output number cannot re-enter Select input string.
          value: {
            select: stringField,
            create: numberField,
          },
        },
      },
    },
  });

  MemoryStore.make({
    records: {
      incompatibleUpdate: {
        fields: {
          // @ts-expect-error Update output number cannot re-enter Select input string.
          value: {
            select: stringField,
            update: numberField,
          },
        },
      },
    },
  });
});

type JobStatus = "pending" | "running" | "done";
type StoredJobStatus = JobStatus | Uppercase<JobStatus>;

const jobStatusValidationInputs: unknown[] = [];

const jobStatusField = fieldSchema<StoredJobStatus, JobStatus>((value) => {
  jobStatusValidationInputs.push(value);
  if (typeof value !== "string") {
    return { issues: [{ message: "Expected a job status" }] };
  }
  const normalized = value.toLowerCase();
  return normalized === "pending" || normalized === "running" || normalized === "done"
    ? { value: normalized }
    : { issues: [{ message: "Expected a job status" }] };
});

const createJobStatusField = fieldSchema<"queued" | JobStatus, StoredJobStatus>((value) =>
  value === "queued"
    ? { value: "PENDING" }
    : value === "pending" || value === "running" || value === "done"
      ? { value }
      : { issues: [{ message: "Expected a create job status" }] },
);

const updateJobStatusField = fieldSchema<"finished" | JobStatus, StoredJobStatus>((value) =>
  value === "finished"
    ? { value: "DONE" }
    : value === "pending" || value === "running" || value === "done"
      ? { value }
      : { issues: [{ message: "Expected an update job status" }] },
);

it("creates and finds a Custom Record through its Collection", async () => {
  const store = MemoryStore.make({
    records: {
      scheduledJobs: {
        fields: {
          id: stringField,
          status: {
            select: jobStatusField,
            create: createJobStatusField,
            update: updateJobStatusField,
          },
          note: optionalStringField,
        },
      },
    },
  });

  const created = await store.collections.scheduledJobs.create({
    id: "job-1",
    status: "queued",
  });

  expectTypeOf(created).toEqualTypeOf<{
    readonly id: string;
    readonly status: JobStatus;
    readonly note?: string;
  }>();
  expect(created).toEqual({ id: "job-1", status: "pending" });

  const found = await store.collections.scheduledJobs.find();
  expectTypeOf(found).toEqualTypeOf<
    readonly {
      readonly id: string;
      readonly status: JobStatus;
      readonly note?: string;
    }[]
  >();
  expect(found).toEqual([{ id: "job-1", status: "pending" }]);

  await expect(
    store.collections.scheduledJobs.update({
      where: (fields, operators) => operators.eq(fields.id, "job-1"),
      set: { status: "finished" },
    }),
  ).resolves.toBe(1);
  jobStatusValidationInputs.length = 0;
  const updated = await store.collections.scheduledJobs.find();
  expect(updated).toEqual([{ id: "job-1", status: "done" }]);
  expect(jobStatusValidationInputs).toEqual(["done"]);
});

it("rejects invalid and unknown create fields before storage", async () => {
  const store = MemoryStore.make({
    records: {
      scheduledJobs: {
        fields: {
          id: stringField,
          status: {
            select: jobStatusField,
            create: createJobStatusField,
          },
        },
      },
    },
  });
  const collection = store.collections.scheduledJobs;

  await expect(
    Reflect.apply(collection.create, undefined, [{ id: 42, status: "queued" }]),
  ).rejects.toMatchObject({
    name: "StoreValidationError",
    collection: "scheduledJobs",
    operation: "create",
    phase: "create",
    field: "id",
  });
  const queued = "queued" as const;

  const inputWithUnknownKey = {
    id: "job-1",
    status: queued,
    secret: "not-defined",
  };
  const unknownKeyFailure = collection.create(inputWithUnknownKey);
  await expect(unknownKeyFailure).rejects.toBeInstanceOf(StoreValidationError);
  await expect(unknownKeyFailure).rejects.toMatchObject({ field: "secret" });
  await expect(collection.find()).resolves.toEqual([]);
});
