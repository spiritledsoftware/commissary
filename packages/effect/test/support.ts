import type {
  AbortResult,
  AdmitResult,
  AdmitRunStoreInput,
  AppendMessagesInput,
  AttemptId,
  BranchId,
  BranchRecord,
  ClaimResult,
  CommitStepInput,
  ExecutionClaim,
  ExecutionClaimToken,
  ExecutionSnapshot,
  FinalizeRunStoreInput,
  GuardedStoreResult,
  Interruption,
  JsonValue,
  MessageEntry,
  MessageEntryId,
  ModelMessage,
  PendingSteering,
  ResumeResult,
  RunId,
  RunRecord,
  RunResult,
  SteeringResult,
  StoredToolSuspension,
  ThreadId,
  ThreadRecord,
  ThreadStore,
} from "@commissary/core";

export class MemoryThreadStore implements ThreadStore {
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
