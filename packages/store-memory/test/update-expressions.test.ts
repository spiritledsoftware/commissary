import {
  StoreValidationError,
  type BaseStoreOperatorSetId,
  type FieldSchema,
  type JsonValue,
  type ValueExpression,
} from "@commissary/store";
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
      vendor: "commissary-update-expression-test",
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

const optionalStringField = fieldSchema<string | undefined, string | undefined>((value) =>
  value === undefined || typeof value === "string"
    ? { value }
    : { issues: [{ message: "Expected an optional string" }] },
);
const stringArrayField = fieldSchema<readonly string[], readonly string[]>((value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? { value: value as readonly string[] }
    : { issues: [{ message: "Expected a string array" }] },
);

const nullableNumberField = fieldSchema<number | null | undefined, number | null | undefined>(
  (value) =>
    value === undefined || value === null || (typeof value === "number" && Number.isFinite(value))
      ? { value }
      : { issues: [{ message: "Expected a nullable number" }] },
);

type JobDetails = {
  readonly marker: string | null;
  readonly nested: { readonly attempt: number };
  readonly note?: string;
  readonly state: string;
  readonly tags: readonly string[];
};

const jobDetailsField = fieldSchema<JobDetails, JobDetails>((value) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? { value: value as JobDetails }
    : { issues: [{ message: "Expected job details" }] },
);

type QueueJob = {
  readonly id: string;
  readonly meta: { readonly priority: number };
  readonly status?: string | null;
  readonly steps: readonly string[];
};

const queueJobsField = fieldSchema<readonly QueueJob[], readonly QueueJob[]>((value) =>
  Array.isArray(value)
    ? { value: value as readonly QueueJob[] }
    : { issues: [{ message: "Expected queue jobs" }] },
);

it("adds selected numeric values in one atomic update", async () => {
  const store = MemoryStore.make({
    records: {
      counters: {
        fields: {
          id: stringField,
          value: numberField,
        },
      },
    },
  });
  const counters = store.collections.counters;
  await counters.create({ id: "one", value: 1 });
  await counters.create({ id: "two", value: 4 });

  await expect(
    counters.update({
      set: (fields, op) => ({ value: op.add(fields.value, 2) }),
    }),
  ).resolves.toBe(2);
  await expect(
    counters.find({
      orderBy: (fields, op) => [op.asc(fields.id)],
    }),
  ).resolves.toEqual([
    { id: "one", value: 3 },
    { id: "two", value: 6 },
  ]);
});

it("subtracts selected numeric values", async () => {
  const counters = MemoryStore.make({
    records: {
      counters: { fields: { id: stringField, value: numberField } },
    },
  }).collections.counters;
  await counters.create({ id: "one", value: 10 });

  await expect(
    counters.update({
      set: (fields, op) => ({ value: op.subtract(fields.value, 3) }),
    }),
  ).resolves.toBe(1);
  await expect(counters.find()).resolves.toEqual([{ id: "one", value: 7 }]);
});

it("multiplies selected numeric values", async () => {
  const counters = MemoryStore.make({
    records: {
      counters: { fields: { id: stringField, value: numberField } },
    },
  }).collections.counters;
  await counters.create({ id: "one", value: 6 });

  await counters.update({
    set: (fields, op) => ({ value: op.multiply(fields.value, 4) }),
  });
  await expect(counters.find()).resolves.toEqual([{ id: "one", value: 24 }]);
});

it("divides selected numeric values", async () => {
  const counters = MemoryStore.make({
    records: {
      counters: { fields: { id: stringField, value: numberField } },
    },
  }).collections.counters;
  await counters.create({ id: "one", value: 20 });

  await counters.update({
    set: (fields, op) => ({ value: op.divide(fields.value, 4) }),
  });
  await expect(counters.find()).resolves.toEqual([{ id: "one", value: 5 }]);
});

it("uses JavaScript remainder for modulo", async () => {
  const counters = MemoryStore.make({
    records: {
      counters: { fields: { id: stringField, value: numberField } },
    },
  }).collections.counters;
  await counters.create({ id: "one", value: -7 });

  await counters.update({
    set: (fields, op) => ({ value: op.modulo(fields.value, 4) }),
  });
  await expect(counters.find()).resolves.toEqual([{ id: "one", value: -3 }]);
});

it("concatenates strings and readonly arrays without coercion", async () => {
  const jobs = MemoryStore.make({
    records: {
      jobs: {
        fields: {
          id: stringField,
          label: stringField,
          tags: stringArrayField,
        },
      },
    },
  }).collections.jobs;
  await jobs.create({ id: "one", label: "run", tags: ["a", "a"] });

  await jobs.update({
    set: (fields, op) => {
      const inferred = op.concat(["a"] as const, [1] as const);
      expectTypeOf(inferred).toEqualTypeOf<
        ValueExpression<readonly ("a" | 1)[], BaseStoreOperatorSetId>
      >();
      return {
        label: op.concat(fields.label, "-next"),
        tags: op.concat(fields.tags, ["b"]),
      };
    },
  });
  await expect(jobs.find()).resolves.toEqual([
    { id: "one", label: "run-next", tags: ["a", "a", "b"] },
  ]);
});

it("coalesces only null or missing values and evaluates fallback lazily", async () => {
  const values = MemoryStore.make({
    records: {
      values: {
        fields: {
          id: stringField,
          current: nullableNumberField,
        },
      },
    },
  }).collections.values;
  await values.create({ id: "missing" });
  await values.create({ id: "null", current: null });
  await values.create({ id: "zero", current: 0 });

  await values.update({
    where: (fields, op) => op.eq(fields.id, "zero"),
    set: (fields, op) => ({
      current: op.coalesce(fields.current, op.divide(1, 0)),
    }),
  });
  await values.update({
    set: (fields, op) => ({
      current: op.coalesce(fields.current, 5),
    }),
  });

  await expect(values.find({ orderBy: (fields, op) => [op.asc(fields.id)] })).resolves.toEqual([
    { id: "missing", current: 5 },
    { id: "null", current: 5 },
    { id: "zero", current: 0 },
  ]);
});

it("evaluates only the selected ifElse value branch", async () => {
  const jobs = MemoryStore.make({
    records: {
      jobs: {
        fields: {
          id: stringField,
          status: stringField,
          value: numberField,
        },
      },
    },
  }).collections.jobs;
  await jobs.create({ id: "one", status: "ready", value: 2 });

  await jobs.update({
    set: (fields, op) => ({
      value: op.ifElse(
        op.eq(fields.status, "ready"),
        op.multiply(fields.value, 3),
        op.divide(1, 0),
      ),
    }),
  });
  await expect(jobs.find()).resolves.toEqual([{ id: "one", status: "ready", value: 6 }]);
});

it("unsets only optional selected fields", async () => {
  const jobs = MemoryStore.make({
    records: {
      jobs: {
        fields: {
          id: stringField,
          note: optionalStringField,
        },
      },
    },
  }).collections.jobs;
  await jobs.create({ id: "one", note: "remove-me" });

  await jobs.update({
    set: (_fields, op) => ({ note: op.unset() }),
  });
  await expect(jobs.find()).resolves.toEqual([{ id: "one" }]);

  const unsetRequiredField = () =>
    jobs.update({
      // @ts-expect-error unset is available only for optional selected fields
      set: (_fields, op) => ({
        id: op.unset(),
      }),
    });
  expect(unsetRequiredField).toBeTypeOf("function");
});

it("shallow-merges objects and unsets optional keys", async () => {
  const jobs = MemoryStore.make({
    records: {
      jobs: {
        fields: {
          id: stringField,
          details: jobDetailsField,
        },
      },
    },
  }).collections.jobs;
  await jobs.create({
    id: "one",
    details: {
      marker: "old",
      nested: { attempt: 1 },
      note: "remove-me",
      state: "queued",
      tags: ["a"],
    },
  });

  await jobs.update({
    set: (fields, op) => ({
      details: op.merge(fields.details, {
        marker: null,
        nested: { attempt: 2 },
        note: op.unset(),
        state: "ready",
        tags: ["b", "b"],
      }),
    }),
  });

  await expect(jobs.find()).resolves.toEqual([
    {
      id: "one",
      details: {
        marker: null,
        nested: { attempt: 2 },
        state: "ready",
        tags: ["b", "b"],
      },
    },
  ]);
});

it("filters array elements with a nested query scope", async () => {
  const queues = MemoryStore.make({
    records: {
      queues: {
        fields: {
          id: stringField,
          jobs: queueJobsField,
        },
      },
    },
  }).collections.queues;
  const duplicate: QueueJob = {
    id: "duplicate",
    meta: { priority: 3 },
    status: "ready",
    steps: ["run"],
  };
  await queues.create({
    id: "one",
    jobs: [
      duplicate,
      duplicate,
      { id: "null", meta: { priority: 2 }, status: null, steps: [] },
      { id: "missing", meta: { priority: 2 }, steps: [] },
      { id: "low", meta: { priority: 1 }, status: "ready", steps: [] },
      { id: "blocked", meta: { priority: 3 }, status: "blocked", steps: [] },
    ],
  });

  await queues.update({
    set: (fields, op) => ({
      jobs: op.filter(fields.jobs, (job, query) =>
        query.and(
          query.gte(job.meta.priority, 2),
          query.or(query.eq(job.status, "ready"), query.isNull(job.status)),
        ),
      ),
    }),
  });

  await expect(queues.find()).resolves.toEqual([
    {
      id: "one",
      jobs: [
        duplicate,
        duplicate,
        { id: "null", meta: { priority: 2 }, status: null, steps: [] },
        { id: "missing", meta: { priority: 2 }, steps: [] },
      ],
    },
  ]);

  const indexedFilter = () =>
    queues.update({
      set: (fields, op) => ({
        jobs: op.filter(fields.jobs, (job, query) => {
          // @ts-expect-error array-valued fields expose no index path
          return query.eq(job.steps[0], "run");
        }),
      }),
    });
  expect(indexedFilter).toBeTypeOf("function");
});

it("rejects a non-finite arithmetic result before any update commits", async () => {
  const counters = MemoryStore.make({
    records: {
      counters: {
        fields: {
          divisor: numberField,
          id: stringField,
          value: numberField,
        },
      },
    },
  }).collections.counters;
  await counters.create({ divisor: 2, id: "safe", value: 8 });
  await counters.create({ divisor: 0, id: "zero", value: 8 });

  const update = counters.update({
    set: (fields, op) => ({
      value: op.divide(fields.value, fields.divisor),
    }),
  });
  await expect(update).rejects.toBeInstanceOf(StoreValidationError);
  await expect(update).rejects.toMatchObject({
    operation: "update",
    phase: "update",
  });
  await expect(counters.find({ orderBy: (fields, op) => [op.asc(fields.id)] })).resolves.toEqual([
    { divisor: 2, id: "safe", value: 8 },
    { divisor: 0, id: "zero", value: 8 },
  ]);
});

it("parses callback literals and evaluates expressions from pre-update values", async () => {
  let leftUpdateParses = 0;
  let rightUpdateParses = 0;
  const leftUpdateField = fieldSchema<string, number>((value) => {
    leftUpdateParses += 1;
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? { value: parsed }
      : { issues: [{ message: "Expected numeric text" }] };
  });
  const rightUpdateField = fieldSchema<string, number>((value) => {
    rightUpdateParses += 1;
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? { value: parsed }
      : { issues: [{ message: "Expected numeric text" }] };
  });
  const expressionOnlyUpdateField = fieldSchema<never, number>(() => ({
    issues: [{ message: "Raw total updates are not allowed" }],
  }));
  const values = MemoryStore.make({
    records: {
      values: {
        fields: {
          id: stringField,
          left: {
            select: numberField,
            create: numberField,
            update: leftUpdateField,
          },
          right: {
            select: numberField,
            create: numberField,
            update: rightUpdateField,
          },
          total: {
            select: numberField,
            create: numberField,
            update: expressionOnlyUpdateField,
          },
        },
      },
    },
  }).collections.values;
  await values.create({ id: "one", left: 1, right: 2, total: 0 });

  await values.update({
    set: (fields, op) => ({
      left: "10",
      right: "20",
      total: op.add(fields.left, fields.right),
    }),
  });

  expect(leftUpdateParses).toBe(1);
  expect(rightUpdateParses).toBe(1);
  await expect(values.find()).resolves.toEqual([{ id: "one", left: 10, right: 20, total: 3 }]);
});

it("rejects a reused expression in an unselected lazy branch before Record reads", async () => {
  let selectReads = 0;
  const selectedNumberField = fieldSchema<number, number>((value) => {
    selectReads += 1;
    return typeof value === "number" && Number.isFinite(value)
      ? { value }
      : { issues: [{ message: "Expected a finite number" }] };
  });
  const counters = MemoryStore.make({
    records: {
      counters: {
        fields: {
          id: stringField,
          value: {
            select: selectedNumberField,
            create: numberField,
          },
        },
      },
    },
  }).collections.counters;
  let escaped: ValueExpression<number, BaseStoreOperatorSetId> | undefined;
  await counters.update({
    set: (fields, op) => {
      escaped = op.divide(fields.value, 2);
      return { value: op.add(fields.value, 1) };
    },
  });
  await counters.create({ id: "one", value: 4 });
  selectReads = 0;

  const update = counters.update({
    set: (fields, op) => ({
      value: op.ifElse(op.eq(fields.id, "one"), fields.value, escaped!),
    }),
  });

  await expect(update).rejects.toBeInstanceOf(StoreValidationError);
  await expect(update).rejects.toMatchObject({ phase: "update" });
  expect(selectReads).toBe(0);
});

it("rejects a parent Record field in a nested filter scope", async () => {
  const queues = MemoryStore.make({
    records: {
      queues: {
        fields: {
          id: stringField,
          jobs: queueJobsField,
        },
      },
    },
  }).collections.queues;
  await queues.create({ id: "one", jobs: [] });

  const update = queues.update({
    set: (fields, op) => ({
      jobs: op.filter(fields.jobs, (job, query) => query.eq(job.id, fields.id)),
    }),
  });

  await expect(update).rejects.toBeInstanceOf(StoreValidationError);
  await expect(update).rejects.toMatchObject({ phase: "update" });
});
