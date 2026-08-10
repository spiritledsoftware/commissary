import type { FieldSchema } from "./record.js";
import { isJsonValue, type JsonValue } from "./json.js";
import { structuralJsonEqual } from "./store-expressions.js";
import type { TransactionStore } from "./store.js";
export * from "./sql-conformance.js";

/** Operator semantics that an adapter's own conformance suite must exercise. */
export type StoreOperatorSemantics = "javascript-fallback" | "adapter-defined";

/** Ordering behavior for Records that tie across every explicit order field. */
export type StoreEqualValueOrder = "stable" | "adapter-defined";

/** Test-only description of one adapter's documented Store behavior. */
export interface StoreAdapterConformanceProfile {
  /** Stable adapter name used in test output. */
  readonly adapter: string;
  /** Documented find limits and equal-value order. */
  readonly find: {
    /** Maximum accepted find limit, or null when no adapter maximum exists. */
    readonly limitMaximum: number | null;
    /** Order used when every explicit sort value is equal. */
    readonly equalValueOrder: StoreEqualValueOrder;
  };
  /** Documented query operator semantics and limits. */
  readonly query: {
    /** Native or shared JavaScript query behavior. */
    readonly semantics: StoreOperatorSemantics;
    /** Human-readable collation name used by the adapter README and tests. */
    readonly stringCollation: string;
    /** Maximum inArray candidate count, or null when no adapter maximum exists. */
    readonly inArrayCandidateMaximum: number | null;
  };
  /** Documented update operator semantics. */
  readonly update: {
    /** Native or shared JavaScript update behavior. */
    readonly semantics: StoreOperatorSemantics;
  };
}

type SchemaResult<Output> =
  | { readonly value: Output }
  | { readonly issues: readonly { readonly message: string }[] };

function conformanceFieldSchema<Input, Output extends JsonValue | undefined>(
  validate: (value: unknown) => SchemaResult<Output>,
): FieldSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-store-conformance",
      validate,
    },
  };
}

const stringField = conformanceFieldSchema<string, string>((value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
);

const numberField = conformanceFieldSchema<number, number>((value) =>
  typeof value === "number" && Number.isFinite(value)
    ? { value }
    : { issues: [{ message: "Expected a finite number" }] },
);

const optionalNumberField = conformanceFieldSchema<
  number | null | undefined,
  number | null | undefined
>((value) =>
  value === undefined || value === null || (typeof value === "number" && Number.isFinite(value))
    ? { value }
    : { issues: [{ message: "Expected an optional finite number" }] },
);

const stringArrayField = conformanceFieldSchema<readonly string[], readonly string[]>((value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? // SAFETY: The array check above proves that every element is a string.
      { value: value as readonly string[] }
    : { issues: [{ message: "Expected a string array" }] },
);

/** Record catalog used by the reusable Store adapter conformance suite. */
export const storeConformanceRecordDefinitions = {
  jobs: {
    fields: {
      id: stringField,
      label: stringField,
      rank: numberField,
      score: optionalNumberField,
      tags: stringArrayField,
    },
  },
} as const;

/** One adapter factory and its documented behavior. */
export interface StoreConformanceAdapter {
  /** Documented adapter behavior that controls optional semantic checks. */
  readonly profile: StoreAdapterConformanceProfile;
  /** Make a new, empty Store for one isolated conformance scenario. */
  readonly makeStore: () =>
    | TransactionStore<typeof storeConformanceRecordDefinitions>
    | Promise<TransactionStore<typeof storeConformanceRecordDefinitions>>;
}

/** One independently executable Store conformance scenario. */
export interface StoreConformanceScenario {
  /** Stable scenario name for the host test runner. */
  readonly name: string;
  /** Run the scenario against a new adapter instance. */
  readonly run: () => Promise<void>;
}

function assertConformance(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Store conformance failure: ${message}`);
  }
}

function assertConformanceEqual(actual: unknown, expected: unknown, message: string): void {
  assertConformance(
    isJsonValue(actual) && isJsonValue(expected) && structuralJsonEqual(actual, expected),
    `${message}; expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

async function makeJobs(adapter: StoreConformanceAdapter) {
  const store = await adapter.makeStore();
  return { store, jobs: store.collections.jobs };
}

/** Build the shared scenarios that every Transaction Store adapter must run. */
export function createStoreAdapterConformanceSuite(
  adapter: StoreConformanceAdapter,
): readonly StoreConformanceScenario[] {
  const scenarios: StoreConformanceScenario[] = [
    {
      name: "implements create, query, ordering, projection, count, and delete",
      async run() {
        const { jobs } = await makeJobs(adapter);
        const firstCreate = jobs.create({
          id: "one",
          label: "first",
          rank: 1,
          tags: ["a"],
        });
        assertConformance(firstCreate instanceof Promise, "create must return a native Promise");
        await firstCreate;
        await jobs.create({ id: "two", label: "second", rank: 3, tags: ["b"] });

        const found = await jobs.find({
          where: (fields, operators) => operators.gte(fields.rank, 2),
          orderBy: (fields, operators) => [operators.desc(fields.rank)],
          select: { id: true, rank: true },
        });
        assertConformanceEqual(found, [{ rank: 3, id: "two" }], "find result differs");
        assertConformanceEqual(await jobs.count(), 2, "count result differs");
        assertConformanceEqual(
          await jobs.delete({
            where: (fields, operators) => operators.eq(fields.id, "one"),
          }),
          1,
          "delete count differs",
        );
        assertConformanceEqual(await jobs.count(), 1, "delete did not remove one Record");
      },
    },
    {
      name: "implements shared update expression behavior",
      async run() {
        const { jobs } = await makeJobs(adapter);
        await jobs.create({
          id: "one",
          label: "job",
          rank: 2,
          score: 1,
          tags: ["a"],
        });
        const updated = await jobs.update({
          where: (fields, operators) => operators.eq(fields.id, "one"),
          set: (fields, operators) => ({
            label: operators.concat(fields.label, "-next"),
            rank: operators.add(fields.rank, 3),
            tags: operators.concat(fields.tags, ["b"]),
          }),
        });
        assertConformanceEqual(updated, 1, "update count differs");
        assertConformanceEqual(
          await jobs.find({ select: { id: true, label: true, rank: true, tags: true } }),
          [{ id: "one", label: "job-next", rank: 5, tags: ["a", "b"] }],
          "updated Record differs",
        );
      },
    },
    {
      name: "returns native Promises and preserves builder failures",
      async run() {
        const { jobs } = await makeJobs(adapter);
        const failure = Object.freeze({ type: "store-conformance-builder-failure" });
        let result: Promise<unknown>;
        try {
          result = jobs.find({
            where() {
              throw failure;
            },
          });
        } catch {
          throw new Error("Store conformance failure: find threw before returning a Promise");
        }
        assertConformance(result instanceof Promise, "find must return a native Promise");
        let received: unknown;
        try {
          await result;
        } catch (cause) {
          received = cause;
        }
        assertConformance(received === failure, "find did not preserve the exact builder failure");
      },
    },
    {
      name: "rolls back failed transactions and preserves callback failures",
      async run() {
        const { store } = await makeJobs(adapter);
        const failure = Object.freeze({ type: "store-conformance-transaction-failure" });
        let received: unknown;
        try {
          await store.transaction(async (transaction) => {
            assertConformance(
              !("transaction" in transaction),
              "the transaction callback Store must not expose transaction",
            );
            await transaction.collections.jobs.create({
              id: "rolled-back",
              label: "temporary",
              rank: 1,
              tags: [],
            });
            throw failure;
          });
        } catch (cause) {
          received = cause;
        }
        assertConformance(received === failure, "transaction did not preserve callback failure");
        assertConformanceEqual(
          await store.collections.jobs.find({
            where: (fields, operators) => operators.eq(fields.id, "rolled-back"),
          }),
          [],
          "failed transaction left a write",
        );
      },
    },
  ];

  if (
    adapter.profile.query.semantics === "javascript-fallback" &&
    adapter.profile.update.semantics === "javascript-fallback"
  ) {
    scenarios.push({
      name: "implements JavaScript fallback arithmetic and lazy expressions",
      async run() {
        const { jobs } = await makeJobs(adapter);
        await jobs.create({
          id: "negative",
          label: "fallback",
          rank: -7,
          score: 1,
          tags: [],
        });
        await jobs.update({
          set: (fields, operators) => ({
            rank: operators.modulo(fields.rank, 4),
            score: operators.coalesce(fields.score, operators.divide(1, 0)),
          }),
        });
        assertConformanceEqual(
          await jobs.find({ select: { rank: true, score: true } }),
          [{ rank: -3, score: 1 }],
          "JavaScript fallback result differs",
        );

        let failure: unknown;
        try {
          await jobs.update({
            set: (_fields, operators) => ({ rank: operators.divide(1, 0) }),
          });
        } catch (cause) {
          failure = cause;
        }
        assertConformance(
          failure instanceof Error && failure.name === "StoreValidationError",
          "non-finite fallback arithmetic must reject with StoreValidationError",
        );
      },
    });
  }

  return Object.freeze(scenarios);
}
