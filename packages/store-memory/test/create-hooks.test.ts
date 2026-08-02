import {
  addThreadStoreCreateHooks,
  Agent,
  Content,
  ExecutionClaimToken,
  Model,
  commissary,
  ThreadId,
  type CoreRecordDefinitions,
} from "@commissary/core";
import {
  StoreHookError,
  StoreValidationError,
  type FieldSchema,
  type JsonValue,
  type BaseStoreOperatorTypes,
  type Store,
} from "@commissary/store";
import { expect, it } from "vitest";

import { MemoryThreadStore } from "../src/index.js";

type SchemaResult<Output> =
  | { readonly value: Output }
  | { readonly issues: readonly { readonly message: string }[] };

function fieldSchema<Input, Output extends JsonValue | undefined>(
  validate: (value: unknown) => SchemaResult<Output>,
): FieldSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-store-hook-test",
      validate,
    },
  };
}

const hookedStringField = fieldSchema<string, string>((value) =>
  value === "hooked" ? { value } : { issues: [{ message: "Expected the hook output" }] },
);

const optionalStringField = fieldSchema<string | undefined, string | undefined>((value) =>
  value === undefined || typeof value === "string"
    ? { value }
    : { issues: [{ message: "Expected an optional string" }] },
);

it("runs Core and Custom hooks before strict create validation", async () => {
  let threadDraftOwner: string | undefined;
  let jobDraftStatus: string | undefined;
  const store = MemoryThreadStore.make({
    records: {
      thread: { fields: { ownerId: hookedStringField } },
      scheduledJobs: {
        fields: {
          id: hookedStringField,
          status: hookedStringField,
        },
      },
    },
    hooks: {
      thread: {
        beforeCreate: ({ draft }) => {
          threadDraftOwner = draft.ownerId;
          return {
            ...draft,
            id: ThreadId.decode("hooked-thread"),
            ownerId: "hooked",
          };
        },
      },
      scheduledJobs: {
        beforeCreate: ({ draft }) => {
          jobDraftStatus = draft.status;
          return { ...draft, id: "hooked", status: "hooked" };
        },
      },
    },
  });

  const app = commissary({ threadStore: store });
  const thread = await app.createThread({
    id: ThreadId.decode("caller-thread"),
    fields: { ownerId: "caller-owner" },
  });
  const job = await store.collections.scheduledJobs.create({
    id: "caller-job",
    status: "caller-status",
  });

  expect(threadDraftOwner).toBe("caller-owner");
  expect(thread).toEqual({ id: "hooked-thread", ownerId: "hooked" });
  expect(jobDraftStatus).toBe("caller-status");
  expect(job).toEqual({ id: "hooked", status: "hooked" });
});

it("validates hook output before a Memory adapter write", async () => {
  const store = MemoryThreadStore.make({
    records: {},
    hooks: {
      thread: {
        beforeCreate: ({ draft }) => {
          const result = { ...draft };
          Reflect.set(result, "unknownField", true);
          return result;
        },
      },
    },
  });

  await expect(
    store.collections.thread.create({ id: ThreadId.decode("invalid-thread") }),
  ).rejects.toMatchObject({
    name: "StoreValidationError",
    collection: "thread",
    operation: "create",
    field: "unknownField",
  });
  await expect(store.collections.thread.find()).resolves.toEqual([]);

  const invalidFieldStore = MemoryThreadStore.make({
    records: {},
    hooks: {
      thread: {
        beforeCreate: ({ draft }) => {
          const result = { ...draft };
          Reflect.set(result, "id", 42);
          return result;
        },
      },
    },
  });
  await expect(
    invalidFieldStore.collections.thread.create({ id: ThreadId.decode("invalid-id") }),
  ).rejects.toBeInstanceOf(StoreValidationError);
  await expect(invalidFieldStore.collections.thread.find()).resolves.toEqual([]);
});

it("wraps a thrown hook value and permits optional custom create fields", async () => {
  const cause = { source: "host-hook" };
  const throwingStore = MemoryThreadStore.make({
    records: {},
    hooks: {
      thread: {
        beforeCreate: () => {
          throw cause;
        },
      },
    },
  });

  const failure = throwingStore.collections.thread.create({
    id: ThreadId.decode("throwing-thread"),
  });
  await expect(failure).rejects.toBeInstanceOf(StoreHookError);
  await expect(failure).rejects.toMatchObject({
    collection: "thread",
    hook: "beforeCreate",
    cause,
  });

  const optionalStore = MemoryThreadStore.make({
    records: {
      thread: { fields: { label: optionalStringField } },
    },
  });
  const optionalApp = commissary({ threadStore: optionalStore });
  await expect(optionalApp.createThread()).resolves.toEqual({ id: expect.any(String) });
});

it("preserves Collection methods implemented on a prototype", async () => {
  const base = MemoryThreadStore.make();
  const delegate = base.collections.thread;
  type ThreadCollection = typeof delegate;

  class PrototypeThreadCollection {
    constructor(readonly collection: ThreadCollection) {}

    find(...args: readonly unknown[]) {
      return Reflect.apply(this.collection.find, this.collection, args);
    }

    create(...args: readonly unknown[]) {
      return Reflect.apply(this.collection.create, this.collection, args);
    }

    update(...args: readonly unknown[]) {
      return Reflect.apply(this.collection.update, this.collection, args);
    }

    delete(...args: readonly unknown[]) {
      return Reflect.apply(this.collection.delete, this.collection, args);
    }

    count(...args: readonly unknown[]) {
      return Reflect.apply(this.collection.count, this.collection, args);
    }
  }

  // SAFETY: The prototype methods above forward every Collection operation to the typed delegate.
  const thread = new PrototypeThreadCollection(delegate) as unknown as ThreadCollection;
  const store: Store<CoreRecordDefinitions, BaseStoreOperatorTypes> = {
    collections: {
      ...base.collections,
      thread,
    },
  };
  const hooked = addThreadStoreCreateHooks(store, {
    thread: {
      beforeCreate: ({ draft }) => draft,
    },
  });

  await expect(hooked.collections.thread.find()).resolves.toEqual([]);
});

it("uses the selected Execution Claim returned after a hook replacement", async () => {
  const store = MemoryThreadStore.make({
    records: {},
    hooks: {
      executionClaim: {
        beforeCreate: ({ draft }) => ({
          ...draft,
          token: ExecutionClaimToken.decode("hooked-claim-token"),
        }),
      },
    },
  });
  const model = Model.define({
    id: "hooked-claim-model",
    async *invoke() {
      yield {
        type: "finish" as const,
        response: {
          message: { role: "assistant" as const, content: [Content.text("done")] },
          finishReason: "stop" as const,
        },
      };
    },
  });
  const app = commissary({ threadStore: store });
  const thread = await app.createThread();
  const branch = await app.createBranch({ threadId: thread.id, name: "main" });
  const client = app.agent(Agent.define({ id: "hooked-claim-agent", fragments: model }));
  const submission = await client.createRun({
    threadId: thread.id,
    branchId: branch.id,
    message: { role: "user", content: [Content.text("start")] },
  });
  if (submission.type !== "accepted") {
    throw new Error(`Unexpected Run submission '${submission.type}'`);
  }

  const execution = await client.execute(submission.runId);
  await expect(execution.result).resolves.toMatchObject({ type: "completed" });
});
