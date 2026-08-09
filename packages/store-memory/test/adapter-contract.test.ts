import {
  StoreAdapterContractError,
  StoreAdapterError,
  StoreError,
  StoreValidationError,
  TransactionConflictError,
  TransactionRollbackError,
  UnsupportedStoreOperationError,
  type BaseStoreOperators,
  type FieldSchema,
  type JsonValue,
  type Predicate,
  type Store,
  type TransactionStore,
  type UpdateSet,
  type ValueExpression,
} from "@commissary/store";
import { expect, it } from "vitest";

import { MemoryStore } from "../src/index.js";
import { memoryConformanceProfile } from "./conformance-profile.js";

type SchemaResult<Output> =
  | { readonly value: Output }
  | { readonly issues: readonly { readonly message: string }[] };

function fieldSchema<Input, Output extends JsonValue | undefined>(
  validate: (value: unknown) => SchemaResult<Output>,
): FieldSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-adapter-contract-test",
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

const stringArrayField = fieldSchema<readonly string[], readonly string[]>((value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? { value: value as readonly string[] }
    : { issues: [{ message: "Expected a string array" }] },
);

const records = {
  jobs: {
    fields: {
      id: stringField,
      tags: stringArrayField,
    },
  },
} as const;

type NumericRecord = {
  readonly fields: {
    readonly value: typeof numberField;
  };
};

type EqualityOnlyOperatorTypes = {
  readonly operators: Pick<BaseStoreOperators, "eq">;
  readonly predicate: Predicate;
  readonly order: never;
  readonly expressionOwner: "equality-only";
};

declare const foreignExpression: ValueExpression<number, "foreign">;
declare const customThenable: PromiseLike<number>;

it("classifies Store failures without copying sensitive causes into messages", () => {
  const cause = { secret: "do-not-log" };
  const unsupported = new UnsupportedStoreOperationError({
    collection: "jobs",
    operation: "find",
    feature: "find.limit",
  });
  const adapterFailure = new StoreAdapterError({
    collection: "jobs",
    operation: "update",
    cause,
  });
  const conflict = new TransactionConflictError(cause);
  const rollback = new TransactionRollbackError({
    callbackFailure: cause,
    rollbackFailure: "rollback-secret",
  });
  const defect = new StoreAdapterContractError({
    collection: "jobs",
    operation: "create",
    violation: "invalid-selected-record",
    field: "id",
    cause,
  });

  for (const error of [unsupported, adapterFailure, conflict, rollback]) {
    expect(error).toBeInstanceOf(StoreError);
    expect(error.message).not.toContain("do-not-log");
    expect(error.message).not.toContain("rollback-secret");
  }
  expect(unsupported).toMatchObject({
    collection: "jobs",
    operation: "find",
    feature: "find.limit",
  });
  expect(adapterFailure.cause).toBe(cause);
  expect(conflict.cause).toBe(cause);
  expect(rollback).toMatchObject({
    callbackFailure: cause,
    rollbackFailure: "rollback-secret",
    writesMayRemain: true,
  });
  expect(defect).toBeInstanceOf(Error);
  expect(defect).not.toBeInstanceOf(StoreError);
  expect(defect).toMatchObject({
    collection: "jobs",
    operation: "create",
    violation: "invalid-selected-record",
    field: "id",
    cause,
  });
  expect(defect.message).not.toContain("do-not-log");
});

it("rejects invalid create outputs before adapter storage", async () => {
  const invalid = MemoryStore.make({
    records: {
      invalid: {
        fields: {
          id: stringField,
          value: {
            select: stringField,
            // SAFETY: This intentional unsound cast simulates invalid configuration from untyped JavaScript.
            create: numberField as unknown as FieldSchema<number, string>,
          },
        },
      },
    },
  }).collections.invalid;

  const create = invalid.create({ id: "one", value: 1 });
  await expect(create).rejects.toBeInstanceOf(StoreValidationError);
  await expect(create).rejects.toMatchObject({
    collection: "invalid",
    operation: "create",
    phase: "create",
    field: "value",
  });
});

it("classifies invalid stored Records as adapter contract defects during find", async () => {
  let selectedValidationCount = 0;
  const invalidAfterCreateField = fieldSchema<string, string>((value) => {
    selectedValidationCount += 1;
    return selectedValidationCount <= 2 && typeof value === "string"
      ? { value }
      : { issues: [{ message: "Rejected stored value" }] };
  });
  const invalid = MemoryStore.make({
    records: {
      invalid: {
        fields: {
          id: stringField,
          value: invalidAfterCreateField,
        },
      },
    },
  }).collections.invalid;
  await invalid.create({ id: "one", value: "valid-on-create" });

  await expect(invalid.find()).rejects.toMatchObject({
    collection: "invalid",
    operation: "find",
    violation: "invalid-selected-record",
    field: "value",
    cause: expect.any(StoreValidationError),
  });
});

it("returns native Promises before builders run and preserves thrown values", async () => {
  const jobs = MemoryStore.make({ records }).collections.jobs;
  const callbackFailure = { type: "callback-failure" };
  const fail = () => {
    throw callbackFailure;
  };
  const operations = [
    () => jobs.find({ where: fail }),
    () => jobs.find({ orderBy: fail }),
    () => jobs.update({ set: fail }),
    () =>
      jobs.update({
        set: (fields, op) => ({
          tags: op.filter(fields.tags, fail),
        }),
      }),
    () => jobs.delete({ where: fail }),
    () => jobs.count({ where: fail }),
  ];

  for (const operation of operations) {
    let result: Promise<unknown> | undefined;
    expect(() => {
      result = operation();
    }).not.toThrow();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toBe(callbackFailure);
  }
});

it("keeps transaction capability in the static Store contract", () => {
  const baseStore: Store<typeof records> = MemoryStore.make({ records });
  const requireTransaction = (_store: TransactionStore<typeof records>): void => undefined;
  const rejectedBaseStore = () => {
    // @ts-expect-error a base Store has no transaction capability
    requireTransaction(baseStore);
  };

  expect(rejectedBaseStore).toBeTypeOf("function");
  expect(baseStore).not.toHaveProperty("supports");
});

it("keeps adapter profiles in test inputs and operator capabilities in types", () => {
  const staticContractChecks = () => {
    const localUpdate: UpdateSet<NumericRecord, "local"> = {
      // @ts-expect-error expressions from another operator set cannot be mixed
      value: foreignExpression,
    };
    const requireNativePromise = (_value: Promise<number>): void => undefined;
    // @ts-expect-error Store methods cannot return a custom thenable
    requireNativePromise(customThenable);
    const inspectEqualityOnlyStore = (
      store: Store<typeof records, EqualityOnlyOperatorTypes>,
    ): void => {
      void store.collections.jobs.find({
        where: (fields, operators) => {
          // @ts-expect-error permanently absent operators are absent from the adapter type
          operators.merge(fields.id, {});
          return operators.eq(fields.id, "one");
        },
      });
    };
    void localUpdate;
    void inspectEqualityOnlyStore;
  };

  expect(staticContractChecks).toBeTypeOf("function");
  expect(memoryConformanceProfile).toMatchObject({
    find: { equalValueOrder: "stable", limitMaximum: null },
    query: {
      semantics: "javascript-fallback",
      inArrayCandidateMaximum: null,
    },
    update: { semantics: "javascript-fallback" },
  });
});

it("reports the current operation for reused query expressions", async () => {
  const jobs = MemoryStore.make({ records }).collections.jobs;
  let escaped: Predicate | undefined;
  await jobs.find({
    where: (fields, operators) => {
      escaped = operators.eq(fields.id, "one");
      return escaped;
    },
  });

  const operations = [
    {
      operation: "update",
      run: () =>
        jobs.update({
          where: () => escaped!,
          set: { id: "changed" },
        }),
    },
    {
      operation: "delete",
      run: () => jobs.delete({ where: () => escaped! }),
    },
    {
      operation: "count",
      run: () => jobs.count({ where: () => escaped! }),
    },
  ] as const;
  for (const { operation, run } of operations) {
    await expect(run()).rejects.toMatchObject({
      name: "StoreValidationError",
      operation,
      phase: "query",
    });
  }
});
