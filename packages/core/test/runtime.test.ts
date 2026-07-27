import { describe, expect, it } from "vitest";
import {
  Agent,
  Codec,
  Content,
  Hook,
  Model,
  Signal,
  SignalAlreadyConsumedError,
  Tool,
  commissary,
  type AbortResult,
  type AttemptId,
  type AdmitResult,
  type AdmitRunStoreInput,
  type AppendMessagesInput,
  type ArtifactStore,
  type BranchId,
  type BranchRecord,
  type ClaimResult,
  type CommitStepInput,
  type ExecutionClaim,
  type ExecutionClaimToken,
  type ExecutionSnapshot,
  type FinalizeRunStoreInput,
  type GuardedStoreResult,
  type JsonValue,
  type Interruption,
  type MessageEntry,
  type MessageEntryId,
  type ModelMessage,
  type PendingSteering,
  type ResumeResult,
  type RunId,
  type RunRecord,
  type RunResult,
  type SteeringResult,
  type StoredToolSuspension,
  type ThreadId,
  type ThreadRecord,
  type ToolCallId,
  type ThreadStore,
} from "../src/index.js";
import { numberSchema, stringSchema } from "./support.js";

class MemoryThreadStore implements ThreadStore {
  readonly threads = new Map<ThreadId, ThreadRecord>();
  readonly branches = new Map<BranchId, BranchRecord>();
  readonly entries = new Map<MessageEntryId, MessageEntry>();
  readonly runs = new Map<RunId, RunRecord>();
  readonly results = new Map<RunId, RunResult>();
  readonly pending = new Map<RunId, PendingSteering[]>();
  readonly suspensions = new Map<RunId, StoredToolSuspension>();
  readonly claims = new Map<RunId, ExecutionClaim>();

  createThread(record: ThreadRecord): PromiseLike<ThreadRecord> {
    this.threads.set(record.id, record);
    return Promise.resolve(record);
  }

  createBranch(input: {
    readonly branch: BranchRecord;
    readonly from?: MessageEntryId;
  }): PromiseLike<BranchRecord> {
    this.branches.set(input.branch.id, input.branch);
    return Promise.resolve(input.branch);
  }

  renameBranch(input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
    readonly name: string;
  }): PromiseLike<BranchRecord> {
    const current = this.branch(input.branchId);
    const renamed = { ...current, name: input.name };
    this.branches.set(input.branchId, renamed);
    return Promise.resolve(renamed);
  }

  readBranchPath(input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }): PromiseLike<readonly MessageEntry[]> {
    const path: MessageEntry[] = [];
    let entryId = this.branch(input.branchId).head;
    while (entryId !== undefined) {
      const entry = this.entries.get(entryId);
      if (entry === undefined) {
        throw new Error(`Missing entry '${entryId}'`);
      }
      path.push(entry);
      entryId = entry.parent;
    }
    return Promise.resolve(path.reverse());
  }

  appendMessages(input: AppendMessagesInput): PromiseLike<BranchRecord> {
    return Promise.resolve(this.append(input.branchId, input.expectedHead, input.entries));
  }

  admitRun(input: AdmitRunStoreInput): PromiseLike<AdmitResult> {
    const branch = this.branch(input.branchId);
    if (branch.head !== input.expectedHead) {
      return Promise.resolve({
        type: "branch-conflict",
        expectedHead: input.expectedHead,
        actualHead: branch.head,
      });
    }
    const updated = this.append(input.branchId, input.expectedHead, [
      { id: input.entryId, message: input.message },
    ]);
    const run: RunRecord = {
      id: input.runId,
      threadId: input.threadId,
      branchId: input.branchId,
      agent: input.agent,
      admittedHead: input.entryId,
      status: "active",
    };
    this.runs.set(input.runId, run);
    return Promise.resolve({
      runId: input.runId,
      threadId: input.threadId,
      branchId: input.branchId,
      head: updated.head!,
      agent: input.agent,
      admitted: true,
    });
  }

  admitToolResume(input: {
    readonly runId: RunId;
    readonly toolName: string;
    readonly encodedInput: JsonValue;
    readonly toolResumeRequestId?: string;
  }): PromiseLike<ResumeResult> {
    const suspension = this.suspensions.get(input.runId);
    if (suspension === undefined || suspension.toolName !== input.toolName) {
      return Promise.resolve({ type: "not-suspended", runId: input.runId });
    }
    this.suspensions.set(input.runId, {
      ...suspension,
      resumeInput: input.encodedInput,
    });
    const run = this.run(input.runId);
    this.runs.set(input.runId, { ...run, status: "active" });
    return Promise.resolve({ type: "accepted", runId: input.runId, admitted: true });
  }

  readToolSuspension(runId: RunId): PromiseLike<StoredToolSuspension | undefined> {
    return Promise.resolve(this.suspensions.get(runId));
  }

  acceptSteering(input: {
    readonly runId: RunId;
    readonly message: ModelMessage;
    readonly steeringRequestId?: string;
  }): PromiseLike<SteeringResult> {
    const values = this.pending.get(input.runId) ?? [];
    const sequence = values.length + 1;
    values.push({ sequence, message: input.message });
    this.pending.set(input.runId, values);
    return Promise.resolve({
      type: "accepted",
      runId: input.runId,
      sequence,
      admitted: true,
    });
  }

  requestAbort(input: {
    readonly runId: RunId;
    readonly reason?: JsonValue;
  }): PromiseLike<AbortResult> {
    const prior = this.results.get(input.runId);
    if (prior !== undefined) {
      return Promise.resolve({ type: "already-resolved", result: prior });
    }
    return Promise.resolve({ type: "accepted", runId: input.runId });
  }

  readRunResult(runId: RunId): PromiseLike<RunResult | undefined> {
    return Promise.resolve(this.results.get(runId));
  }

  acquireExecutionClaim(input: {
    readonly runId: RunId;
    readonly attemptId: AttemptId;
    readonly expiresAt: number;
  }): PromiseLike<ClaimResult> {
    if (this.claims.has(input.runId)) {
      return Promise.resolve({
        type: "already-claimed",
        expiresAt: this.claims.get(input.runId)!.expiresAt,
      });
    }
    const result = this.results.get(input.runId);
    if (result !== undefined && result.type !== "suspended") {
      return Promise.resolve({ type: "not-executable", result });
    }
    const claim: ExecutionClaim = {
      runId: input.runId,
      attemptId: input.attemptId,
      token: globalThis.crypto.randomUUID() as ExecutionClaimToken,
      fence: 1,
      expiresAt: input.expiresAt,
    };
    this.claims.set(input.runId, claim);
    return Promise.resolve({ type: "acquired", claim });
  }

  renewExecutionClaim(input: {
    readonly claim: ExecutionClaim;
    readonly expiresAt: number;
  }): PromiseLike<ExecutionClaim | undefined> {
    if (!this.validClaim(input.claim)) {
      return Promise.resolve(undefined);
    }
    const renewed = { ...input.claim, expiresAt: input.expiresAt };
    this.claims.set(input.claim.runId, renewed);
    return Promise.resolve(renewed);
  }

  releaseExecutionClaim(claim: ExecutionClaim): PromiseLike<boolean> {
    if (!this.validClaim(claim)) {
      return Promise.resolve(false);
    }
    this.claims.delete(claim.runId);
    return Promise.resolve(true);
  }

  async loadExecution(claim: ExecutionClaim): Promise<ExecutionSnapshot | undefined> {
    if (!this.validClaim(claim)) {
      return undefined;
    }
    const run = this.run(claim.runId);
    const branch = this.branch(run.branchId);
    const path = await this.readBranchPath({
      threadId: run.threadId,
      branchId: run.branchId,
    });
    return {
      run,
      branch,
      transcript: path.map((entry) => entry.message),
      head: branch.head!,
      pendingSteering: this.pending.get(run.id) ?? [],
      ...(this.suspensions.get(run.id) === undefined
        ? {}
        : { suspension: this.suspensions.get(run.id)! }),
    };
  }

  commitStep(input: CommitStepInput): PromiseLike<GuardedStoreResult<BranchRecord>> {
    if (!this.validClaim(input.claim)) {
      return Promise.resolve({ type: "claim-lost" });
    }
    const run = this.run(input.claim.runId);
    const branch = this.append(run.branchId, input.expectedHead, input.entries);
    if (input.consumedSteeringThrough !== undefined) {
      this.pending.set(
        run.id,
        (this.pending.get(run.id) ?? []).filter(
          (item) => item.sequence > input.consumedSteeringThrough!,
        ),
      );
    }
    return Promise.resolve({ type: "committed", value: branch });
  }

  finalizeRun(input: FinalizeRunStoreInput): PromiseLike<GuardedStoreResult<RunResult>> {
    if (!this.validClaim(input.claim)) {
      return Promise.resolve({ type: "claim-lost" });
    }
    const run = this.run(input.claim.runId);
    this.append(run.branchId, input.expectedHead, input.entries);
    this.results.set(run.id, input.result);
    this.runs.set(run.id, { ...run, status: input.result.type });
    if (input.suspension === undefined) {
      this.suspensions.delete(run.id);
    } else {
      this.suspensions.set(run.id, input.suspension);
    }
    this.claims.delete(run.id);
    return Promise.resolve({ type: "committed", value: input.result });
  }

  recordInterruption(input: {
    readonly claim: ExecutionClaim;
    readonly interruption: Interruption;
  }): PromiseLike<GuardedStoreResult<Interruption>> {
    if (!this.validClaim(input.claim)) {
      return Promise.resolve({ type: "claim-lost" });
    }
    this.claims.delete(input.claim.runId);
    return Promise.resolve({ type: "committed", value: input.interruption });
  }

  private append(
    branchId: BranchId,
    expectedHead: MessageEntryId | undefined,
    entries: readonly {
      readonly id: MessageEntryId;
      readonly message: ModelMessage;
    }[],
  ): BranchRecord {
    let branch = this.branch(branchId);
    if (branch.head !== expectedHead) {
      throw new Error("Branch head changed");
    }
    let parent = expectedHead;
    for (const entry of entries) {
      this.entries.set(entry.id, {
        id: entry.id,
        threadId: branch.threadId,
        ...(parent === undefined ? {} : { parent }),
        message: entry.message,
      });
      parent = entry.id;
    }
    branch = {
      ...branch,
      ...(parent === undefined ? {} : { head: parent }),
    };
    this.branches.set(branchId, branch);
    return branch;
  }

  private branch(id: BranchId): BranchRecord {
    const branch = this.branches.get(id);
    if (branch === undefined) {
      throw new Error(`Unknown Branch '${id}'`);
    }
    return branch;
  }

  private run(id: RunId): RunRecord {
    const run = this.runs.get(id);
    if (run === undefined) {
      throw new Error(`Unknown Run '${id}'`);
    }
    return run;
  }

  private validClaim(claim: ExecutionClaim): boolean {
    const current = this.claims.get(claim.runId);
    return current?.token === claim.token && current.expiresAt > Date.now();
  }
}

class ShortLeaseThreadStore extends MemoryThreadStore {
  readonly renewed: Promise<ExecutionClaim | undefined>;
  renewalCount = 0;
  #resolveRenewed!: (claim: ExecutionClaim | undefined) => void;

  constructor(readonly allowRenewal: boolean) {
    super();
    this.renewed = new Promise((resolve) => {
      this.#resolveRenewed = resolve;
    });
  }

  override async acquireExecutionClaim(
    input: Parameters<MemoryThreadStore["acquireExecutionClaim"]>[0],
  ): Promise<ClaimResult> {
    const result = await super.acquireExecutionClaim(input);
    if (result.type !== "acquired") {
      return result;
    }
    const claim = { ...result.claim, expiresAt: Date.now() + 40 };
    this.claims.set(claim.runId, claim);
    return { type: "acquired", claim };
  }

  override async renewExecutionClaim(
    input: Parameters<MemoryThreadStore["renewExecutionClaim"]>[0],
  ): Promise<ExecutionClaim | undefined> {
    this.renewalCount += 1;
    if (!this.allowRenewal) {
      this.claims.delete(input.claim.runId);
      this.#resolveRenewed(undefined);
      return undefined;
    }
    const renewed = await super.renewExecutionClaim(input);
    this.#resolveRenewed(renewed);
    return renewed;
  }
}

const completingModel = Model.define({
  id: "completing-model",
  async *invoke() {
    yield { type: "text-delta" as const, delta: "hello" };
    yield {
      type: "finish" as const,
      response: {
        message: {
          role: "assistant" as const,
          content: [Content.text("hello")],
        },
        finishReason: "stop" as const,
      },
    };
  },
});

describe("default Machine", () => {
  it("admits, streams, finalizes, and persists a Run", async () => {
    let settled: unknown;
    const settlement = Hook.onSettlement((event) => {
      settled = event.outcome;
      return undefined;
    });
    const store = new MemoryThreadStore();
    const agent = Agent.define({
      id: "assistant",
      fragments: Agent.combine(completingModel, settlement),
    });
    const app = commissary({ threadStore: store, agents: [agent] });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const client = app.agent(agent);

    const streamed = await client.stream({
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("Hi")] },
    });
    if ("type" in streamed) {
      throw new Error(`Unexpected admission failure: ${streamed.type}`);
    }

    const text = (async () => {
      const chunks: string[] = [];
      for await (const chunk of Signal.text(streamed.signals)) {
        chunks.push(chunk);
      }
      return chunks;
    })();
    const outcome = await streamed.outcome;

    expect(await text).toEqual(["hello"]);
    expect(outcome.type).toBe("completed");
    await expect(client.readResult(streamed.runId)).resolves.toEqual(outcome);
    expect(settled).toEqual(outcome);
    await expect(async () => {
      for await (const _signal of streamed.signals) {
        // The iterator must reject before yielding.
      }
    }).rejects.toBeInstanceOf(SignalAlreadyConsumedError);
  });

  it("continues the same Run after a provider-requested pause", async () => {
    let invocations = 0;
    const pausingModel = Model.define({
      id: "pausing-model",
      async *invoke() {
        invocations += 1;
        const paused = invocations === 1;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text(paused ? "working" : "done")],
            },
            finishReason: paused ? ("pause" as const) : ("stop" as const),
          },
        };
      },
    });
    const store = new MemoryThreadStore();
    const agent = Agent.define({ id: "pausing-agent", fragments: pausingModel });
    const app = commissary({ threadStore: store, agents: [agent] });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });

    const outcome = await app.agent(agent).run({
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("start")] },
    });

    expect(outcome.type).toBe("completed");
    expect(invocations).toBe(2);
    await expect(
      store.readBranchPath({ threadId: thread.id, branchId: branch.id }),
    ).resolves.toEqual([
      expect.objectContaining({ message: { role: "user", content: [Content.text("start")] } }),
      expect.objectContaining({
        message: { role: "assistant", content: [Content.text("working")] },
      }),
      expect.objectContaining({
        message: { role: "assistant", content: [Content.text("done")] },
      }),
    ]);
  });

  it("renews an active Execution Claim before its lease expires", async () => {
    const store = new ShortLeaseThreadStore(true);
    const waitingModel = Model.define({
      id: "renewing-model",
      async *invoke() {
        await store.renewed;
        yield {
          type: "finish" as const,
          response: {
            message: { role: "assistant" as const, content: [Content.text("done")] },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const agent = Agent.define({ id: "renewing-agent", fragments: waitingModel });
    const app = commissary({ threadStore: store, agents: [agent] });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });

    const outcome = await app.agent(agent).run({
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("start")] },
    });

    expect(outcome.type).toBe("completed");
    expect(store.renewalCount).toBeGreaterThanOrEqual(1);
  });

  it("aborts active work immediately when its Execution Claim is lost", async () => {
    const store = new ShortLeaseThreadStore(false);
    const waitingModel = Model.define({
      id: "claim-loss-model",
      async *invoke(_request, context) {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) {
            resolve();
          } else {
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          }
        });
        yield { type: "text-delta" as const, delta: "stale" };
      },
    });
    const agent = Agent.define({ id: "claim-loss-agent", fragments: waitingModel });
    const app = commissary({ threadStore: store, agents: [agent] });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });

    await expect(
      app.agent(agent).run({
        threadId: thread.id,
        branchId: branch.id,
        message: { role: "user", content: [Content.text("start")] },
      }),
    ).rejects.toThrow("Execution Claim");
    expect(store.renewalCount).toBe(1);
  });

  it("rejects executing a Run through a different Agent", async () => {
    const store = new MemoryThreadStore();
    const first = Agent.define({ id: "first-agent", fragments: completingModel });
    const second = Agent.define({ id: "second-agent", fragments: completingModel });
    const app = commissary({ threadStore: store, agents: [first, second] as const });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const admission = await app.agent(first).admit({
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("start")] },
    });
    if ("type" in admission) {
      throw new Error(`Unexpected admission failure: ${admission.type}`);
    }

    const attempt = await app.agent(second).execute(admission.runId);
    await expect(attempt.outcome).rejects.toThrow("Run belongs to Agent 'first-agent'");
  });

  it("rejects resumable Tool batches before any Tool side effects", async () => {
    let ordinaryExecutions = 0;
    let resumableExecutions = 0;
    const resumeInput = Codec.define({
      encode: (value: boolean) => value,
      decode(value) {
        if (typeof value !== "boolean") {
          throw new TypeError("Expected boolean");
        }
        return value;
      },
    });
    const continuation = Codec.define({
      encode: (value: number) => value,
      decode(value) {
        if (typeof value !== "number") {
          throw new TypeError("Expected number");
        }
        return value;
      },
    });
    const ordinary = Tool.define({
      name: "ordinary",
      input: stringSchema,
      output: stringSchema,
      handler(input) {
        ordinaryExecutions += 1;
        return input;
      },
    });
    const resumable = Tool.define({
      name: "resumable",
      input: stringSchema,
      output: numberSchema,
      handler() {
        resumableExecutions += 1;
        return Tool.suspend(1);
      },
      suspension: {
        resumeInput,
        continuation,
        resume({ continuation: value }) {
          return value;
        },
      },
    });
    const batchingModel = Model.define({
      id: "batching-model",
      async *invoke() {
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [
                {
                  type: "tool-call" as const,
                  toolCallId: "ordinary-call" as ToolCallId,
                  toolName: "ordinary",
                  input: "first",
                },
                {
                  type: "tool-call" as const,
                  toolCallId: "resumable-call" as ToolCallId,
                  toolName: "resumable",
                  input: "second",
                },
              ],
            },
            finishReason: "tool-calls" as const,
          },
        };
      },
    });
    const agent = Agent.define({
      id: "batching-agent",
      fragments: Agent.combine(batchingModel, ordinary, resumable),
    });
    const app = commissary({ threadStore: new MemoryThreadStore(), agents: [agent] });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });

    await expect(
      app.agent(agent).run({
        threadId: thread.id,
        branchId: branch.id,
        message: { role: "user", content: [Content.text("start")] },
      }),
    ).rejects.toThrow("cannot batch a resumable Tool Call");
    expect({ ordinaryExecutions, resumableExecutions }).toEqual({
      ordinaryExecutions: 0,
      resumableExecutions: 0,
    });
  });

  it("does not create Tool Attempts for provider-executed Tool Calls", async () => {
    let invocations = 0;
    const providerModel = Model.define({
      id: "provider-tool-model",
      async *invoke() {
        invocations += 1;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content:
                invocations === 1
                  ? [
                      {
                        type: "tool-call" as const,
                        toolCallId: "provider-call" as ToolCallId,
                        toolName: "provider-search",
                        input: "query",
                        providerExecuted: true,
                      },
                    ]
                  : [Content.text("unexpected second invocation")],
            },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const providerTool = Tool.provider({
      name: "provider-search",
      provider: {
        namespace: "example",
        id: "example.search",
        args: { depth: 1 },
      },
      input: stringSchema,
      output: stringSchema,
    });
    const store = new MemoryThreadStore();
    const agent = Agent.define({
      id: "provider-tool-agent",
      fragments: Agent.combine(providerModel, providerTool),
    });
    const app = commissary({ threadStore: store, agents: [agent] });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });

    const outcome = await app.agent(agent).run({
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("search")] },
    });

    expect(outcome.type).toBe("completed");
    expect(invocations).toBe(1);
  });

  it("acquires and releases one Model session per Execution Attempt", async () => {
    let acquisitions = 0;
    let invocations = 0;
    let releases = 0;
    let receivedArtifactStore = false;
    const artifactStore = {} as ArtifactStore;
    const scopedModel = Model.define({
      id: "scoped-model",
      invoke() {
        throw new Error("Attempt-scoped session was not acquired");
      },
      acquire(context) {
        acquisitions += 1;
        receivedArtifactStore = context.artifactStore === artifactStore;
        return {
          async *invoke() {
            invocations += 1;
            const paused = invocations === 1;
            yield {
              type: "finish" as const,
              response: {
                message: {
                  role: "assistant" as const,
                  content: [Content.text(paused ? "working" : "done")],
                },
                finishReason: paused ? ("pause" as const) : ("stop" as const),
              },
            };
          },
          close() {
            releases += 1;
          },
        };
      },
    });
    const store = new MemoryThreadStore();
    const agent = Agent.define({ id: "scoped-agent", fragments: scopedModel });
    const app = commissary({ threadStore: store, artifactStore, agents: [agent] });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });

    const outcome = await app.agent(agent).run({
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("start")] },
    });

    expect(outcome.type).toBe("completed");
    expect({ acquisitions, invocations, releases, receivedArtifactStore }).toEqual({
      acquisitions: 1,
      invocations: 2,
      releases: 1,
      receivedArtifactStore: true,
    });
  });

  it("records retryable provider conditions as nonterminal Interruptions", async () => {
    const unavailableModel = Model.define({
      id: "unavailable-model",
      async *invoke() {
        yield {
          type: "interruption" as const,
          interruption: {
            type: "provider-unavailable" as const,
            provider: "example",
            reason: "rate-limit" as const,
            retryAfterMs: 1_000,
          },
        };
      },
    });
    const store = new MemoryThreadStore();
    const agent = Agent.define({ id: "unavailable-agent", fragments: unavailableModel });
    const app = commissary({ threadStore: store, agents: [agent] });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const client = app.agent(agent);

    const outcome = await client.run({
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("start")] },
    });

    expect(outcome).toMatchObject({
      type: "interrupted",
      interruption: {
        type: "provider-unavailable",
        provider: "example",
        reason: "rate-limit",
        retryAfterMs: 1_000,
      },
    });
    if (outcome.type !== "interrupted") {
      throw new Error(`Expected interruption, received ${outcome.type}`);
    }
    await expect(client.readResult(outcome.runId)).resolves.toBeUndefined();
  });

  it("commits pre-response provider rejections as terminal Model Failures", async () => {
    const rejectingModel = Model.define({
      id: "rejecting-model",
      async *invoke() {
        yield {
          type: "failure" as const,
          failure: {
            type: "model-failure" as const,
            reason: "content-policy" as const,
            provider: "example",
            message: "request rejected",
          },
        };
      },
    });
    const store = new MemoryThreadStore();
    const agent = Agent.define({ id: "rejecting-agent", fragments: rejectingModel });
    const app = commissary({ threadStore: store, agents: [agent] });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const client = app.agent(agent);

    const outcome = await client.run({
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("blocked")] },
    });

    expect(outcome).toMatchObject({
      type: "failed",
      failure: {
        type: "model-failure",
        reason: "content-policy",
        provider: "example",
        message: "request rejected",
      },
    });
    if (outcome.type !== "failed") {
      throw new Error(`Expected failure, received ${outcome.type}`);
    }
    await expect(client.readResult(outcome.runId)).resolves.toEqual(outcome);
  });

  it("commits typed Hook blocks as Run Failures", async () => {
    const store = new MemoryThreadStore();
    const blocked = Hook.beforeModelRequest(() => Hook.block({ code: "denied" }));
    const agent = Agent.define({
      id: "blocked-agent",
      fragments: Agent.combine(completingModel, blocked),
    });
    const app = commissary({ threadStore: store, agents: [agent] });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });

    const outcome = await app.agent(agent).run({
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("Blocked")] },
    });

    expect(outcome).toMatchObject({
      type: "failed",
      failure: {
        type: "hook-blocked",
        point: "beforeModelRequest",
        failure: { code: "denied" },
      },
    });
  });

  it("transforms and executes static Tool calls between model invocations", async () => {
    let observedToolOutput: JsonValue | undefined;
    let observedProviderData:
      | readonly { readonly namespace: string; readonly version: number }[]
      | undefined;
    const toolCallId = globalThis.crypto.randomUUID() as ToolCallId;
    const model = Model.define({
      id: "tool-model",
      async *invoke(request) {
        const toolResult = request.messages
          .flatMap((message) => message.content)
          .find((part) => part.type === "tool-result");
        if (toolResult === undefined) {
          yield {
            type: "finish" as const,
            response: {
              message: {
                role: "assistant" as const,
                content: [
                  {
                    ...Content.toolCall(toolCallId, "length", "x"),
                    providerData: [
                      { namespace: "example-callback", version: 1, value: { id: "callback" } },
                    ],
                  },
                ],
              },
              finishReason: "tool-calls" as const,
            },
          };
          return;
        }
        observedToolOutput = toolResult.output;
        observedProviderData = toolResult.providerData;
        yield {
          type: "finish" as const,
          response: {
            message: {
              role: "assistant" as const,
              content: [Content.text("done")],
            },
            finishReason: "stop" as const,
          },
        };
      },
    });
    const length = Tool.define({
      name: "length",
      input: stringSchema,
      output: numberSchema,
      handler: (input) => input.length,
    });
    const transform = Hook.beforeToolExecution(({ input }) => ({
      input: typeof input === "string" ? `${input}!` : input,
    }));
    const agent = Agent.define({
      id: "tool-agent",
      fragments: Agent.combine(model, length, transform),
    });
    const store = new MemoryThreadStore();
    const app = commissary({ threadStore: store, agents: [agent] });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });

    const outcome = await app.agent(agent).run({
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("Measure")] },
    });

    expect(outcome.type).toBe("completed");
    expect(observedToolOutput).toBe(2);
    expect(observedProviderData).toEqual([
      { namespace: "example-callback", version: 1, value: { id: "callback" } },
    ]);
  });

  it("commits abort when an Attempt is cancelled", async () => {
    const store = new MemoryThreadStore();
    const agent = Agent.define({ id: "assistant", fragments: completingModel });
    const app = commissary({ threadStore: store, agents: [agent] });
    const thread = await app.createThread();
    const branch = await app.createBranch({ threadId: thread.id, name: "main" });
    const streamed = await app.agent(agent).stream({
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("Stop")] },
    });
    if ("type" in streamed) {
      throw new Error(`Unexpected admission failure: ${streamed.type}`);
    }

    streamed.abort("cancelled");
    await expect(streamed.outcome).resolves.toMatchObject({
      type: "aborted",
      reason: "cancelled",
    });
  });
});
