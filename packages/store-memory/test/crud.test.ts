import { isJsonValue, type FieldSchema, type JsonObject, type JsonValue } from "@commissary/store";
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

const stringArrayField = fieldSchema<string[], string[]>((value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? { value: value as string[] }
    : { issues: [{ message: "Expected a string array" }] },
);

const jsonObjectField = fieldSchema<JsonObject, JsonObject>((value) =>
  isJsonValue(value) && value !== null && typeof value === "object" && !Array.isArray(value)
    ? { value: value as JsonObject }
    : { issues: [{ message: "Expected a JSON object" }] },
);

function setNestedLabel(metadata: JsonObject, label: string): void {
  const state = Reflect.get(metadata, "state");
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Expected nested metadata state");
  }
  Reflect.set(state, "label", label);
}

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

it("detaches nested values from inputs and returned Records", async () => {
  const jobs = MemoryStore.make({
    records: {
      jobs: {
        fields: {
          id: stringField,
          tags: stringArrayField,
          metadata: jsonObjectField,
        },
      },
    },
  }).collections.jobs;
  const tags = ["a"];
  const state = { label: "original" };
  const metadata = { state };
  const created = await jobs.create({ id: "one", tags, metadata });

  tags.push("input-mutation");
  state.label = "input-mutation";
  created.tags.push("created-output-mutation");
  setNestedLabel(created.metadata, "created-output-mutation");
  const firstRead = await jobs.find();
  expect(firstRead).toEqual([
    { id: "one", tags: ["a"], metadata: { state: { label: "original" } } },
  ]);

  const firstRecord = firstRead[0];
  if (firstRecord === undefined) {
    throw new Error("Expected one stored Record");
  }
  firstRecord.tags.push("find-output-mutation");
  setNestedLabel(firstRecord.metadata, "find-output-mutation");
  await expect(jobs.find()).resolves.toEqual([
    { id: "one", tags: ["a"], metadata: { state: { label: "original" } } },
  ]);
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
