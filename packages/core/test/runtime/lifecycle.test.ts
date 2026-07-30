import { MemoryThreadStore } from "@commissary/store-memory";
import { describe, expect, it } from "vitest";
import {
  Agent,
  Content,
  ExecutionClaimLostError,
  ExecutionUnavailableError,
  Hook,
  HookPoints,
  RunId,
  ThreadStoreError,
  Model,
  UnexpectedExecutionError,
  commissary,
  type ClaimRenewalResult,
  type ExecutionClaim,
} from "@commissary/core";
import { completingModel, fixture, submitStart } from "./support.js";

describe("Runtime lifecycle", () => {
  it("submits, executes, observes, snapshots, and reads one completed Run", async () => {
    const settled: unknown[] = [];
    const agent = Agent.define({
      id: "assistant",
      fragments: Agent.combine(
        completingModel,
        Hook.onSettlement(({ result }) => {
          settled.push(result);
          return undefined;
        }),
      ),
    });
    const { branch, client } = await fixture(agent);
    const events: unknown[] = [];
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      events.push(event);
      return undefined;
    });

    const submission = await submitStart(client, branch, "Hi");
    const execution = await client.execute(submission.runId);
    const result = await execution.result;

    expect(execution.id).toBeTypeOf("string");
    expect(result).toMatchObject({ type: "completed", runId: submission.runId });
    expect(events).toContainEqual({
      type: "model-event",
      event: { type: "text-delta", delta: "hello" },
    });
    await expect(client.readResult(submission.runId)).resolves.toEqual(result);
    await expect(client.readRunSnapshot(submission.runId)).resolves.toMatchObject({
      status: "completed",
      result,
      toolCalls: [],
      suspensions: [],
    });
    expect(settled).toEqual([result]);
  });

  it("uses the injected generator for core-owned IDs", async () => {
    let sequence = 0;
    const app = commissary({
      threadStore: new MemoryThreadStore(),
      generateId: () => `generated-${++sequence}`,
    });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({ id: "generated-id-agent", fragments: completingModel });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);

    expect(thread.id).toBe("generated-1");
    expect(branch.id).toBe("generated-2");
    expect(submission.runId).toBe("generated-3");
    expect(execution.id).toBe("generated-6");
    await expect(execution.result).resolves.toMatchObject({ type: "completed" });
  });

  it("rejects an invalid generated Execution ID", async () => {
    let sequence = 0;
    const app = commissary({
      threadStore: new MemoryThreadStore(),
      generateId: () => (++sequence === 6 ? "" : `generated-${sequence}`),
    });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({ id: "invalid-generated-id-agent", fragments: completingModel });
    const client = app.agent(agent);
    const submission = await submitStart(client, branch);

    await expect(client.execute(submission.runId)).rejects.toThrow(
      "ExecutionId must be a non-empty string",
    );
  });

  it("uses a caller Run ID as an idempotent start key", async () => {
    const agent = Agent.define({ id: "idempotent-agent", fragments: completingModel });
    const { branch, client } = await fixture(agent);
    const runId = RunId.decode("run-fixed");
    const input = {
      runId,
      threadId: branch.threadId,
      branchId: branch.id,
      message: { role: "user" as const, content: [Content.text("same")] },
    };

    await expect(client.createRun(input)).resolves.toMatchObject({
      type: "accepted",
      admitted: true,
      runId,
    });
    await expect(client.createRun(input)).resolves.toMatchObject({
      type: "accepted",
      admitted: false,
      runId,
    });
    await expect(
      client.createRun({
        ...input,
        message: { role: "user", content: [Content.text("different")] },
      }),
    ).resolves.toEqual({ type: "run-conflict", runId });
  });

  it("keeps colon-delimited command request identities separate", async () => {
    const agent = Agent.define({ id: "request-key-agent", fragments: completingModel });
    const { app, thread, branch, client } = await fixture(agent);
    const secondBranch = await app.createBranch({
      threadId: thread.id,
      name: "second",
    });
    await client.createRun({
      runId: RunId.decode("run:one"),
      threadId: branch.threadId,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("first")] },
    });
    await client.createRun({
      runId: RunId.decode("run"),
      threadId: secondBranch.threadId,
      branchId: secondBranch.id,
      message: { role: "user", content: [Content.text("second")] },
    });

    await expect(
      client.redirect({
        runId: RunId.decode("run:one"),
        redirectRequestId: "redirect",
        message: { role: "user", content: [Content.text("first redirect")] },
      }),
    ).resolves.toMatchObject({ type: "accepted", admitted: true });
    await expect(
      client.redirect({
        runId: RunId.decode("run"),
        redirectRequestId: "one:redirect",
        message: { role: "user", content: [Content.text("second redirect")] },
      }),
    ).resolves.toMatchObject({ type: "accepted", admitted: true });
  });

  it("continues from steering accepted during terminal Model finalization", async () => {
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invocations = 0;
    const model = Model.define({
      id: "steering-race-model",
      async *invoke() {
        invocations += 1;
        if (invocations === 1) {
          started();
          await gate;
        }
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text(invocations === 1 ? "first" : "second")],
            },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({ id: "steering-race-agent", fragments: model });
    const { app, branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);
    await modelStarted;

    const steering = {
      runId: submission.runId,
      steeringRequestId: "during-finalization",
      message: { role: "user" as const, content: [Content.text("steer")] },
    };
    await expect(client.steer(steering)).resolves.toMatchObject({
      type: "accepted",
      admitted: true,
    });
    release();

    await expect(execution.result).resolves.toMatchObject({
      type: "completed",
      response: { message: { content: [Content.text("second")] } },
    });
    expect(invocations).toBe(2);
    await expect(client.steer(steering)).resolves.toMatchObject({
      type: "accepted",
      admitted: false,
    });
    const history = await app.readBranchHistory({
      threadId: branch.threadId,
      branchId: branch.id,
    });
    expect(history.map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("continues from steering accepted before a terminal Model Failure", async () => {
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invocations = 0;
    const model = Model.define({
      id: "steering-failure-race-model",
      async *invoke() {
        invocations += 1;
        if (invocations === 1) {
          started();
          await gate;
          yield {
            type: "failure" as const,
            failure: {
              type: "model-failure" as const,
              reason: "content-policy" as const,
              provider: "test",
              message: "blocked",
            },
          };
          return;
        }
        yield {
          type: "finish" as const,
          response: {
            message: { role: "assistant" as const, content: [Content.text("recovered")] },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({ id: "steering-failure-race-agent", fragments: model });
    const { branch, client } = await fixture(agent);
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);
    await modelStarted;

    await expect(
      client.steer({
        runId: submission.runId,
        message: { role: "user", content: [Content.text("recover")] },
      }),
    ).resolves.toMatchObject({ type: "accepted" });
    release();

    await expect(execution.result).resolves.toMatchObject({
      type: "completed",
      response: { message: { content: [Content.text("recovered")] } },
    });
    expect(invocations).toBe(2);
  });

  it("checks unbound Run IDs against the stored Agent atomically", async () => {
    const firstAgent = Agent.define({ id: "authority-first", fragments: completingModel });
    const secondAgent = Agent.define({ id: "authority-second", fragments: completingModel });
    const store = new MemoryThreadStore();
    const app = commissary({ threadStore: store });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const firstClient = app.agent(firstAgent);
    const secondClient = app.agent(secondAgent);
    const accepted = await submitStart(firstClient, branch);
    const runId = RunId.decode(accepted.runId);

    await expect(secondClient.readRunSnapshot(runId)).resolves.toBeUndefined();
    await expect(secondClient.readResult(runId)).resolves.toBeUndefined();
    await expect(
      secondClient.steer({
        runId,
        message: { role: "user", content: [Content.text("wrong steer")] },
      }),
    ).resolves.toEqual({ type: "not-active", runId });
    await expect(
      secondClient.redirect({
        runId,
        message: { role: "user", content: [Content.text("wrong redirect")] },
      }),
    ).resolves.toEqual({ type: "not-active", runId });
    await expect(secondClient.abort(runId)).resolves.toEqual({ type: "not-active", runId });
    await expect(secondClient.execute(runId)).rejects.toEqual(
      new ExecutionUnavailableError(runId, "wrong-agent"),
    );

    await expect(firstClient.readRunSnapshot(runId)).resolves.toMatchObject({
      runId,
      status: "active",
    });
    await expect(
      firstClient.steer({
        runId,
        message: { role: "user", content: [Content.text("correct steer")] },
      }),
    ).resolves.toMatchObject({ type: "accepted", admitted: true });
    await expect(
      firstClient.redirect({
        runId,
        message: { role: "user", content: [Content.text("correct redirect")] },
      }),
    ).resolves.toMatchObject({ type: "accepted", admitted: true });
    await expect((await firstClient.execute(runId)).result).resolves.toMatchObject({
      type: "completed",
    });
    await expect(firstClient.readResult(runId)).resolves.toMatchObject({ type: "completed" });

    const abortBranch = await app.createBranch({ threadId: thread.id, name: "abort" });
    const abortRun = await submitStart(firstClient, abortBranch);
    const decodedAbortRunId = RunId.decode(abortRun.runId);
    await expect(firstClient.abort(decodedAbortRunId, "stop")).resolves.toEqual({
      type: "accepted",
      runId: decodedAbortRunId,
    });
    await expect((await firstClient.execute(decodedAbortRunId)).result).resolves.toMatchObject({
      type: "aborted",
      reason: "stop",
    });
  });

  it("rejects the Execution result with the same reported Claim loss error", async () => {
    class LosingStore extends MemoryThreadStore {
      override renewExecutionClaim(): PromiseLike<ClaimRenewalResult> {
        return Promise.resolve({ type: "claim-lost" });
      }
    }
    const store = new LosingStore();
    const waitingModel = Model.define({
      id: "waiting-model",
      async *invoke(_request, context) {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
        });
        yield { type: "text-delta" as const, delta: "unreachable" };
      },
    });
    const agent = Agent.define({ id: "claim-agent", fragments: waitingModel });
    const app = commissary({
      threadStore: store,
      executionClaims: { leaseDurationMs: 10 },
    });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const client = app.agent(agent);
    let reported: unknown;
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      if (event.type === "error") {
        reported = event.error;
      }
      return undefined;
    });
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);

    await expect(execution.result).rejects.toBeInstanceOf(ExecutionClaimLostError);
    expect(reported).toBeInstanceOf(ExecutionClaimLostError);
  });

  it("emits a specific Error Event when Claim release fails", async () => {
    class FailingReleaseStore extends MemoryThreadStore {
      override releaseExecutionClaim(_claim: ExecutionClaim): PromiseLike<boolean> {
        return Promise.reject(new Error("release failed"));
      }
    }

    const store = new FailingReleaseStore();
    const app = commissary({ threadStore: store });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const agent = Agent.define({ id: "release-failure-agent", fragments: completingModel });
    const client = app.agent(agent);
    const events: unknown[] = [];
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      events.push(event);
      return undefined;
    });
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);

    const error = await execution.result.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ThreadStoreError);
    expect(events).toContainEqual({ type: "error", error });
  });

  it("wraps undeclared exceptions and emits the same terminal Error Event", async () => {
    const model = Model.define({
      id: "defect-model",
      invoke() {
        throw new Error("broken provider");
      },
    });
    const agent = Agent.define({ id: "defect-agent", fragments: model });
    const { branch, client } = await fixture(agent);
    let reported: unknown;
    client.on(HookPoints.onExecutionEvent, ({ event }) => {
      if (event.type === "error") {
        reported = event.error;
      }
      return undefined;
    });
    const submission = await submitStart(client, branch);
    const execution = await client.execute(submission.runId);

    await expect(execution.result).rejects.toMatchObject({
      name: "UnexpectedExecutionError",
      phase: "model",
    });
    expect(reported).toBeInstanceOf(UnexpectedExecutionError);
  });
});
