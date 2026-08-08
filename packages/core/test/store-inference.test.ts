import { MemoryThreadStore } from "@commissary/store-memory";
import type { FieldSchema, TransactionStore } from "@commissary/store";
import { expect, expectTypeOf, it } from "vitest";

import {
  Agent,
  AgentRevision,
  RunId,
  Model,
  ThreadId,
  coreRecordDefinitions,
  composeThreadStoreRecordDefinitions,
  createThreadStore,
  commissary,
  type ExecutionClaimToken,
  type CoreCommandCreatedRecordName,
  type CoreInternallyCreatedRecordName,
  type CoreRecordDefinitions,
  type ExecutionId,
} from "@commissary/core";
import { numberSchema, stringSchema, testSchema } from "./support.js";

const activeRunStatusSchema = testSchema((value): value is "active" => value === "active", {
  const: "active",
});

type RunStatus = "active" | "suspended" | "completed" | "failed" | "aborted";

const activeRunCreateSchema: FieldSchema<RunStatus, "active"> = {
  "~standard": {
    version: 1,
    vendor: "commissary-store-inference-test",
    validate(value) {
      return value === "active" ||
        value === "suspended" ||
        value === "completed" ||
        value === "failed" ||
        value === "aborted"
        ? { value: "active" as const }
        : { issues: [{ message: "Expected a Run status" }] };
    },
  },
};

const inferenceModel = Model.define({
  id: "store-inference-model",
  async *invoke() {
    yield {
      type: "finish" as const,
      response: {
        message: { role: "assistant" as const, content: [] },
        finishReason: "stop" as const,
      },
    };
  },
});

it("adds the complete Core catalog and merges host fields", async () => {
  const defaultStore = MemoryThreadStore.make({ records: {} });
  expect(Object.keys(defaultStore.collections).sort()).toEqual(
    [
      "branch",
      "commit",
      "executionClaim",
      "executionFence",
      "finalizationOutcome",
      "message",
      "modelCommitOutcome",
      "pendingRedirect",
      "pendingSteering",
      "redirectRequest",
      "run",
      "runCommandSequence",
      "runSubmission",
      "settlementOutcome",
      "steeringRequest",
      "thread",
      "toolCall",
      "toolCallSequence",
      "toolResumeRequest",
    ].sort(),
  );

  const store = MemoryThreadStore.make({
    records: {},
    overrides: {
      branch: {
        fields: {
          tenantId: stringSchema,
        },
      },
      thread: {
        fields: {
          ownerId: stringSchema,
        },
      },
      executionClaim: {
        fields: {
          traceId: stringSchema,
        },
      },
      run: {
        fields: {
          status: {
            select: activeRunStatusSchema,
            create: activeRunCreateSchema,
          },
        },
      },
    },
    hooks: {
      executionClaim: {
        beforeCreate: ({ draft }) => ({
          ...draft,
          traceId: "trace",
        }),
      },
    },
  });

  const threads = await store.collections.thread.find();
  expectTypeOf(threads).toEqualTypeOf<
    readonly {
      readonly id: ThreadId;
      readonly ownerId: string;
    }[]
  >();

  const claims = await store.collections.executionClaim.find();
  expectTypeOf(claims).toEqualTypeOf<
    readonly {
      readonly runId: RunId;
      readonly executionId: ExecutionId;
      readonly token: ExecutionClaimToken;
      readonly fence: number;
      readonly expiresAt: number;
      readonly traceId: string;
    }[]
  >();

  const runs = await store.collections.run.find();
  expectTypeOf<(typeof runs)[number]["status"]>().toEqualTypeOf<"active">();
  type CommittedModelResult = Extract<
    Awaited<ReturnType<typeof store.commitModelInvocation>>,
    { readonly type: "committed" }
  >;
  expectTypeOf<CommittedModelResult["value"]["tenantId"]>().toEqualTypeOf<string>();
  const modelOutcomes = await store.collections.modelCommitOutcome.find();
  for (const record of modelOutcomes) {
    if (record.outcome.type === "committed") {
      expectTypeOf(record.outcome.value.tenantId).toEqualTypeOf<string>();
    }
  }
  const snapshot = await store.readRunSnapshot({
    agent: { id: "agent", revision: AgentRevision.decode("revision") },
    runId: RunId.decode("run"),
  });
  if (snapshot !== undefined) {
    expectTypeOf(snapshot.run.status).toEqualTypeOf<"active">();
  }
  const client = commissary({ threadStore: store }).agent(
    Agent.define({ id: "store-inference-agent", fragments: inferenceModel }),
  );
  const agentSnapshot = await client.readRunSnapshot(RunId.decode("run"));
  if (agentSnapshot !== undefined) {
    expectTypeOf(agentSnapshot.run.status).toEqualTypeOf<"active">();
  }
  expect(defaultStore.collections).not.toHaveProperty("controlWaiters");
  expect(defaultStore.collections).not.toHaveProperty("toolCallGraph");
});

it("rejects an incompatible Core field replacement", () => {
  MemoryThreadStore.make({
    records: {},
    overrides: {
      // @ts-expect-error Core Run status cannot be replaced with a number output
      run: {
        fields: {
          status: numberSchema,
        },
      },
    },
  });
});

expectTypeOf<CoreCommandCreatedRecordName>().toEqualTypeOf<"thread" | "branch" | "run">();
expectTypeOf<CoreInternallyCreatedRecordName>().toEqualTypeOf<
  Exclude<keyof CoreRecordDefinitions, "thread" | "branch" | "run">
>();

it("requires command fields and internal before-create hooks", async () => {
  const store = MemoryThreadStore.make({
    records: {},
    overrides: {
      thread: {
        fields: {
          ownerId: stringSchema,
        },
      },
      executionClaim: {
        fields: {
          traceId: stringSchema,
        },
      },
    },
    hooks: {
      executionClaim: {
        beforeCreate: ({ draft }) => ({
          ...draft,
          traceId: "trace-1",
        }),
      },
    },
  });
  const app = commissary({ threadStore: store });

  const thread = await app.createThread({
    id: ThreadId.decode("thread-with-owner"),
    fields: { ownerId: "owner-1" },
  });
  expectTypeOf(thread.ownerId).toEqualTypeOf<string>();
  expect(thread.ownerId).toBe("owner-1");

  const createThreadWithoutOwner = () =>
    // @ts-expect-error a required Thread custom field belongs in command fields
    app.createThread({ id: ThreadId.decode("missing-owner") });
  void createThreadWithoutOwner;

  MemoryThreadStore.make({
    records: {},
    overrides: {
      executionClaim: {
        fields: {
          traceId: stringSchema,
        },
      },
    },
    // @ts-expect-error an internal create path with a required custom field needs a hook
    hooks: {},
  });

  MemoryThreadStore.make({
    records: {},
    overrides: {
      executionClaim: {
        fields: {
          traceId: stringSchema,
        },
      },
    },
    hooks: {
      executionClaim: {
        // @ts-expect-error a hook must return the complete effective create input
        beforeCreate: () => ({ traceId: "trace-only" }),
      },
    },
  });
});

it("rejects Thread Store backends without Core query operators", () => {
  type IncompleteCoreOperatorTypes = {
    readonly operators: {
      readonly eq: (...args: never[]) => unknown;
    };
    readonly predicate: unknown;
    readonly order: unknown;
    readonly expressionOwner: "incomplete-core-operators";
  };
  const inspect = (
    backend: TransactionStore<CoreRecordDefinitions, IncompleteCoreOperatorTypes>,
  ): void => {
    // @ts-expect-error Core requires eq, and, and or query operators.
    createThreadStore({ backend });
  };

  expect(inspect).toBeTypeOf("function");
  expect(coreRecordDefinitions).toHaveProperty("executionClaim");
});

it("rejects host Record contributions that conflict with Core", () => {
  expect(() =>
    composeThreadStoreRecordDefinitions({
      records: {
        thread: coreRecordDefinitions.thread,
      },
    } as never),
  ).toThrow("Duplicate Record contribution 'thread'");
});
