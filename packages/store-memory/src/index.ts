import { ExecutionClaimToken } from "@commissary/core";
import type {
  AgentReference,
  AcceptedRun,
  AbortResult,
  AppendMessagesInput,
  BranchConflict,
  BranchId,
  BranchRecord,
  ClaimRenewalResult,
  ClaimResult,
  Clock,
  CommitId,
  CommitModelInvocationInput,
  CommitModelInvocationStoreResult,
  CommitStepInput,
  CommitToolResultsInput,
  CompleteToolCallInput,
  ContinueSettlementInput,
  ContinueSettlementStoreResult,
  ExecutionClaim,
  ExecutionControl,
  ExecutionSnapshot,
  FinalizeRunStoreInput,
  FinalizeRunStoreResult,
  GuardedStoreResult,
  Interruption,
  JsonValue,
  MessageEntry,
  ModelUsage,
  ModelRunUsage,
  MessageEntryId,
  PendingRedirect,
  PendingSteering,
  RecordDelegatedToolCallInput,
  RecordModelCallInput,
  RecordToolInputInput,
  RedirectRequestId,
  RedirectResult,
  RunConflict,
  RunId,
  RunRecord,
  RunResult,
  RunSnapshot,
  RunUsage,
  RunResultRecord,
  SteeringRequestId,
  SteeringResult,
  StoredToolCall,
  SubmitRunStoreInput,
  SuspendRunStoreResult,
  SuspendToolCallInput,
  ThreadId,
  ThreadRecord,
  ThreadStore,
  ToolCallId,
  ToolResumeConflict,
  ToolResumeRequestConflict,
  ToolResumeContext,
} from "@commissary/core";

interface ControlWaiter {
  readonly token: ExecutionClaimToken;
  readonly resolve: (control: ExecutionControl) => void;
  readonly reject: (cause: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

interface ResumeRequestRecord {
  readonly fingerprint: string;
  readonly result: AcceptedRun;
}

interface ToolCallGraph {
  readonly calls: Map<ToolCallId, StoredToolCall>;
  readonly order: ToolCallId[];
  readonly delegated: Map<ToolCallId, Map<string, ToolCallId>>;
  readonly resumable: Set<ToolCallId>;
  nextSequence: number;
}

interface SteeringRequestRecord {
  readonly fingerprint: string;
  readonly result: SteeringResult;
}

interface RedirectRequestRecord {
  readonly fingerprint: string;
  readonly result: RedirectResult;
}

/** Configuration for one process-local Thread Store. */
export interface MemoryThreadStoreOptions {
  readonly clock?: Pick<Clock, "now">;
}

function canonical(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function requestKey(runId: RunId, requestId: string): string {
  return canonical([runId, requestId]);
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function terminal(status: RunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

function addTokenCount(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function emptyModelUsage(): ModelUsage {
  return Object.freeze({
    input: Object.freeze({}),
    output: Object.freeze({}),
  });
}

function addUsage(current: ModelUsage | undefined, delta: ModelUsage): ModelUsage {
  const inputTotal = addTokenCount(current?.input.total, delta.input.total);
  const inputUncached = addTokenCount(current?.input.uncached, delta.input.uncached);
  const cacheRead = addTokenCount(current?.input.cacheRead, delta.input.cacheRead);
  const cacheWrite = addTokenCount(current?.input.cacheWrite, delta.input.cacheWrite);
  const outputTotal = addTokenCount(current?.output.total, delta.output.total);
  const outputText = addTokenCount(current?.output.text, delta.output.text);
  const outputReasoning = addTokenCount(current?.output.reasoning, delta.output.reasoning);
  const totalTokens = addTokenCount(current?.totalTokens, delta.totalTokens);
  return Object.freeze({
    input: Object.freeze({
      ...(inputTotal === undefined ? {} : { total: inputTotal }),
      ...(inputUncached === undefined ? {} : { uncached: inputUncached }),
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
    }),
    output: Object.freeze({
      ...(outputTotal === undefined ? {} : { total: outputTotal }),
      ...(outputText === undefined ? {} : { text: outputText }),
      ...(outputReasoning === undefined ? {} : { reasoning: outputReasoning }),
    }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  });
}

function emptyRunUsage(): RunUsage {
  return Object.freeze({
    total: emptyModelUsage(),
    models: Object.freeze([]),
  });
}

/**
 * Process-local Thread Store for development, tests, and single-process hosts.
 *
 * State is not durable across process restarts. It still implements the complete
 * atomic and fenced Thread Store contract.
 */
export class MemoryThreadStore implements ThreadStore {
  /** Create an empty process-local Thread Store. */
  static make(options: MemoryThreadStoreOptions = {}): MemoryThreadStore {
    return new MemoryThreadStore(options);
  }

  readonly #now: () => number;
  readonly #threads = new Map<ThreadId, ThreadRecord>();
  readonly #branches = new Map<BranchId, BranchRecord>();
  readonly #entries = new Map<MessageEntryId, MessageEntry>();
  readonly #runs = new Map<RunId, RunRecord>();
  readonly #claims = new Map<RunId, ExecutionClaim>();
  readonly #fences = new Map<RunId, number>();
  readonly #pendingSteering = new Map<RunId, PendingSteering[]>();
  readonly #pendingRedirects = new Map<RunId, PendingRedirect[]>();
  readonly #commandSequences = new Map<RunId, number>();
  readonly #toolCalls = new Map<RunId, ToolCallGraph>();
  readonly #startFingerprints = new Map<RunId, string>();
  readonly #startSubmissions = new Map<RunId, AcceptedRun>();
  readonly #resumeRequests = new Map<string, ResumeRequestRecord>();
  readonly #steeringRequests = new Map<string, SteeringRequestRecord>();
  readonly #redirectRequests = new Map<string, RedirectRequestRecord>();
  readonly #commits = new Map<string, string>();
  readonly #finalizationOutcomes = new Map<CommitId, FinalizeRunStoreResult>();
  readonly #modelCommitOutcomes = new Map<CommitId, CommitModelInvocationStoreResult>();
  readonly #settlementOutcomes = new Map<CommitId, ContinueSettlementStoreResult>();
  readonly #controlWaiters = new Map<RunId, Set<ControlWaiter>>();
  constructor(options: MemoryThreadStoreOptions = {}) {
    this.#now = options.clock?.now ?? Date.now;
  }
  createThread(record: ThreadRecord): PromiseLike<ThreadRecord> {
    const current = this.#threads.get(record.id);
    if (current !== undefined) {
      return Promise.resolve(current);
    }
    const stored = Object.freeze({ ...record });
    this.#threads.set(record.id, stored);
    return Promise.resolve(stored);
  }

  readThread(threadId: ThreadId): PromiseLike<ThreadRecord | undefined> {
    return Promise.resolve(this.#threads.get(threadId));
  }

  createBranch(input: {
    readonly branch: BranchRecord;
    readonly from?: MessageEntryId;
  }): PromiseLike<BranchRecord> {
    if (!this.#threads.has(input.branch.threadId)) {
      throw new Error(`Unknown Thread '${input.branch.threadId}'`);
    }
    const current = this.#branches.get(input.branch.id);
    if (current !== undefined) {
      if (!same(current, input.branch)) {
        throw new Error(`Branch '${input.branch.id}' already exists with different data`);
      }
      return Promise.resolve(current);
    }
    if (input.from !== undefined) {
      const entry = this.#entries.get(input.from);
      if (entry === undefined || entry.threadId !== input.branch.threadId) {
        throw new Error(`Unknown source Message '${input.from}'`);
      }
    }
    const branch = Object.freeze({
      ...input.branch,
      ...(input.from === undefined ? {} : { head: input.from }),
    });
    this.#branches.set(branch.id, branch);
    return Promise.resolve(branch);
  }

  readBranch(input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }): PromiseLike<BranchRecord | undefined> {
    const branch = this.#branches.get(input.branchId);
    return Promise.resolve(branch?.threadId === input.threadId ? branch : undefined);
  }

  renameBranch(input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
    readonly name: string;
  }): PromiseLike<BranchRecord> {
    const current = this.#branch(input.threadId, input.branchId);
    const branch = Object.freeze({ ...current, name: input.name });
    this.#branches.set(branch.id, branch);
    return Promise.resolve(branch);
  }

  readBranchHistory(input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }): PromiseLike<readonly MessageEntry[]> {
    const branch = this.#branch(input.threadId, input.branchId);
    const path: MessageEntry[] = [];
    let entryId = branch.head;
    while (entryId !== undefined) {
      const entry = this.#entries.get(entryId);
      if (entry === undefined || entry.threadId !== input.threadId) {
        throw new Error(`Broken Message path at '${entryId}'`);
      }
      path.push(entry);
      entryId = entry.parent;
    }
    return Promise.resolve(Object.freeze(path.reverse()));
  }

  appendMessages(input: AppendMessagesInput): PromiseLike<BranchRecord> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      return Promise.resolve(this.#branch(input.threadId, input.branchId));
    }
    const branch = this.#branch(input.threadId, input.branchId);
    const expectedHead = input.expectedHead ?? branch.head;
    const updated = this.#append(input.threadId, input.branchId, expectedHead, input.entries);
    this.#commits.set(input.commitId, fingerprint);
    return Promise.resolve(updated);
  }

  submitRun(input: SubmitRunStoreInput): PromiseLike<AcceptedRun | BranchConflict | RunConflict> {
    const fingerprint = canonical({
      agent: input.agent,
      threadId: input.threadId,
      branchId: input.branchId,
      message: input.message,
      expectedHead: input.expectedHead,
    });
    const current = this.#runs.get(input.runId);
    if (current !== undefined) {
      if (this.#startFingerprints.get(input.runId) !== fingerprint) {
        return Promise.resolve({ type: "run-conflict", runId: input.runId });
      }
      const prior = this.#startSubmissions.get(input.runId)!;
      return Promise.resolve(Object.freeze({ ...prior, admitted: false }));
    }

    const branch = this.#branch(input.threadId, input.branchId);
    if (input.expectedHead !== undefined && branch.head !== input.expectedHead) {
      return Promise.resolve({
        type: "branch-conflict",
        expectedHead: input.expectedHead,
        ...(branch.head === undefined ? {} : { actualHead: branch.head }),
      });
    }
    const expectedHead = input.expectedHead ?? branch.head;
    const updated = this.#append(input.threadId, input.branchId, expectedHead, [
      { id: input.entryId, message: input.message },
    ]);
    const run: RunRecord = Object.freeze({
      id: input.runId,
      threadId: input.threadId,
      branchId: input.branchId,
      agent: input.agent,
      admittedHead: input.entryId,
      status: "active",
      abortRequested: false,
      settlementContinuations: 0,
    });
    this.#runs.set(run.id, run);
    this.#toolCalls.set(run.id, {
      calls: new Map(),
      order: [],
      delegated: new Map(),
      resumable: new Set(),
      nextSequence: 0,
    });
    const submission: AcceptedRun = Object.freeze({
      type: "accepted",
      runId: run.id,
      threadId: run.threadId,
      branchId: run.branchId,
      head: updated.head!,
      agent: run.agent,
      admitted: true,
    });
    this.#startFingerprints.set(run.id, fingerprint);
    this.#startSubmissions.set(run.id, submission);
    this.#commits.set(input.commitId, canonical(input));
    return Promise.resolve(submission);
  }

  submitToolResumes(input: {
    readonly runId: RunId;
    readonly agent: AgentReference;
    readonly expectedHead: MessageEntryId;
    readonly items: readonly {
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly input: JsonValue;
    }[];
    readonly toolResumeRequestId?: string;
  }): PromiseLike<AcceptedRun | ToolResumeConflict | ToolResumeRequestConflict> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || !same(run.agent, input.agent)) {
      return Promise.resolve({
        type: "tool-resume-conflict",
        runId: input.runId,
        toolCallIds: input.items.map((item) => item.toolCallId),
      });
    }
    const fingerprint = canonical({ agent: input.agent, items: input.items });
    if (input.toolResumeRequestId !== undefined) {
      const key = requestKey(input.runId, input.toolResumeRequestId);
      const prior = this.#resumeRequests.get(key);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          return Promise.resolve({
            type: "tool-resume-request-conflict",
            runId: input.runId,
            toolResumeRequestId: input.toolResumeRequestId,
          });
        }
        return Promise.resolve(Object.freeze({ ...prior.result, admitted: false }));
      }
    }
    const currentBranch = this.#branch(run.threadId, run.branchId);
    if (currentBranch.head !== input.expectedHead) {
      return Promise.resolve({
        type: "tool-resume-conflict",
        runId: input.runId,
        toolCallIds: input.items.map((item) => item.toolCallId),
      });
    }

    const graph = this.#graph(input.runId);
    const calls = graph.calls;
    const conflicts: ToolCallId[] = [];
    for (const item of input.items) {
      const call = calls.get(item.toolCallId);
      if (
        call === undefined ||
        call.toolName !== item.toolName ||
        call.status !== "suspended" ||
        call.suspension === undefined ||
        (call.suspension.resumeInput !== undefined &&
          !same(call.suspension.resumeInput, item.input))
      ) {
        conflicts.push(item.toolCallId);
      }
    }
    if (conflicts.length > 0 || terminal(run.status)) {
      return Promise.resolve({
        type: "tool-resume-conflict",
        runId: input.runId,
        toolCallIds: conflicts.length > 0 ? conflicts : input.items.map((item) => item.toolCallId),
      });
    }

    let admitted = false;
    for (const item of input.items) {
      const call = calls.get(item.toolCallId)!;
      if (call.suspension!.resumeInput === undefined) {
        admitted = true;
        this.#setCall(
          graph,
          Object.freeze({
            ...call,
            suspension: Object.freeze({
              ...call.suspension!,
              resumeInput: item.input,
            }),
          }),
        );
      }
    }
    this.#runs.set(run.id, Object.freeze({ ...run, status: "active" }));
    const branch = this.#branch(run.threadId, run.branchId);
    const result: AcceptedRun = Object.freeze({
      type: "accepted",
      runId: run.id,
      threadId: run.threadId,
      branchId: run.branchId,
      head: branch.head!,
      agent: run.agent,
      admitted,
    });
    if (input.toolResumeRequestId !== undefined) {
      this.#resumeRequests.set(requestKey(input.runId, input.toolResumeRequestId), {
        fingerprint,
        result,
      });
    }
    return Promise.resolve(result);
  }

  acceptSteering(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
    readonly message: import("@commissary/core").ModelMessage;
    readonly steeringRequestId?: SteeringRequestId;
  }): PromiseLike<SteeringResult> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || !same(run.agent, input.agent)) {
      return Promise.resolve({ type: "not-active", runId: input.runId });
    }
    const fingerprint = canonical(input.message);
    if (input.steeringRequestId !== undefined) {
      const key = requestKey(input.runId, input.steeringRequestId);
      const prior = this.#steeringRequests.get(key);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          return Promise.resolve({
            type: "steering-request-conflict",
            runId: input.runId,
            steeringRequestId: input.steeringRequestId,
          });
        }
        return Promise.resolve(
          prior.result.type === "accepted" ? { ...prior.result, admitted: false } : prior.result,
        );
      }
    }
    if (terminal(run.status)) {
      return Promise.resolve({ type: "not-active", runId: input.runId });
    }
    const pending = this.#pendingSteering.get(run.id) ?? [];
    const result: SteeringResult = {
      type: "accepted",
      runId: run.id,
      sequence: (this.#commandSequences.get(run.id) ?? 0) + 1,
      admitted: true,
    };
    this.#commandSequences.set(run.id, result.sequence);
    pending.push({ sequence: result.sequence, message: input.message });
    this.#pendingSteering.set(run.id, pending);
    if (input.steeringRequestId !== undefined) {
      this.#steeringRequests.set(requestKey(input.runId, input.steeringRequestId), {
        fingerprint,
        result,
      });
    }
    return Promise.resolve(result);
  }

  acceptRedirect(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
    readonly message: import("@commissary/core").ModelMessage;
    readonly redirectRequestId?: RedirectRequestId;
  }): PromiseLike<RedirectResult> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || !same(run.agent, input.agent)) {
      return Promise.resolve({ type: "not-active", runId: input.runId });
    }
    const fingerprint = canonical(input.message);
    if (input.redirectRequestId !== undefined) {
      const key = requestKey(input.runId, input.redirectRequestId);
      const prior = this.#redirectRequests.get(key);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          return Promise.resolve({
            type: "redirect-request-conflict",
            runId: input.runId,
            redirectRequestId: input.redirectRequestId,
          });
        }
        return Promise.resolve(
          prior.result.type === "accepted" ? { ...prior.result, admitted: false } : prior.result,
        );
      }
    }
    if (terminal(run.status)) {
      return Promise.resolve({ type: "not-active", runId: input.runId });
    }
    const pending = this.#pendingRedirects.get(run.id) ?? [];
    const result: RedirectResult = {
      type: "accepted",
      runId: run.id,
      sequence: (this.#commandSequences.get(run.id) ?? 0) + 1,
      admitted: true,
    };
    this.#commandSequences.set(run.id, result.sequence);
    pending.push({ sequence: result.sequence, message: input.message });
    this.#pendingRedirects.set(run.id, pending);
    if (input.redirectRequestId !== undefined) {
      this.#redirectRequests.set(requestKey(input.runId, input.redirectRequestId), {
        fingerprint,
        result,
      });
    }
    return Promise.resolve(result);
  }

  requestAbort(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
    readonly reason?: JsonValue;
  }): PromiseLike<AbortResult> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || !same(run.agent, input.agent)) {
      return Promise.resolve({ type: "not-active", runId: input.runId });
    }
    if (run.result !== undefined) {
      return Promise.resolve({ type: "already-resolved", result: run.result });
    }
    if (!run.abortRequested) {
      this.#runs.set(
        run.id,
        Object.freeze({
          ...run,
          abortRequested: true,
          ...(input.reason === undefined ? {} : { abortReason: input.reason }),
        }),
      );
      this.#notifyControl(run.id, {
        type: "abort-requested",
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
    }
    return Promise.resolve({ type: "accepted", runId: run.id });
  }

  readRunSnapshot(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
  }): PromiseLike<RunSnapshot | undefined> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || !same(run.agent, input.agent)) {
      return Promise.resolve(undefined);
    }
    const branch = this.#branch(run.threadId, run.branchId);
    const calls = this.#orderedCalls(run.id);
    // SAFETY: Tool provider identity and tagged stored Failures are written atomically for each call.
    const snapshot = Object.freeze({
      runId: run.id,
      threadId: run.threadId,
      branchId: run.branchId,
      head: branch.head!,
      agent: run.agent,
      status: run.status,
      settlementContinuations: run.settlementContinuations,
      toolCalls: Object.freeze(
        calls.map((call) => {
          const common = {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            ...(call.parentToolCallId === undefined
              ? {}
              : { parentToolCallId: call.parentToolCallId }),
            status: call.status,
            requestedInput: call.requestedInput,
            ...(call.effectiveInput === undefined ? {} : { effectiveInput: call.effectiveInput }),
            ...(call.result === undefined ? {} : { result: call.result }),
          };
          return call.providerId === undefined
            ? Object.freeze(common)
            : Object.freeze({
                ...common,
                dynamic: true as const,
                providerId: call.providerId,
              });
        }),
      ),
      suspensions: Object.freeze(
        calls
          .filter((call) => call.status === "suspended")
          .map((call) =>
            call.providerId === undefined
              ? Object.freeze({
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                })
              : Object.freeze({
                  dynamic: true as const,
                  providerId: call.providerId,
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                }),
          ),
      ),
      ...(run.result === undefined ? {} : { result: run.result }),
    }) as RunSnapshot;
    return Promise.resolve(snapshot);
  }

  readRunResult(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
  }): PromiseLike<RunResultRecord | undefined> {
    const run = this.#runs.get(input.runId);
    return Promise.resolve(
      run === undefined || !same(run.agent, input.agent)
        ? undefined
        : Object.freeze({
            agent: run.agent,
            ...(run.result === undefined ? {} : { result: run.result }),
          }),
    );
  }

  async readToolResumeContext(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
  }): Promise<ToolResumeContext | undefined> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || !same(run.agent, input.agent)) {
      return undefined;
    }
    const branch = this.#branch(run.threadId, run.branchId);
    const path = await this.readBranchHistory({
      threadId: run.threadId,
      branchId: run.branchId,
    });
    return Object.freeze({
      run,
      transcript: Object.freeze(path.map((entry) => entry.message)),
      head: branch.head!,
      toolCalls: Object.freeze(this.#orderedCalls(run.id)),
    });
  }

  acquireExecutionClaim(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
    readonly executionId: import("@commissary/core").ExecutionId;
    readonly leaseDurationMs: number;
  }): PromiseLike<ClaimResult> {
    const run = this.#runs.get(input.runId);
    if (run === undefined) {
      return Promise.resolve({ type: "run-not-found" });
    }
    if (!same(run.agent, input.agent)) {
      return Promise.resolve({ type: "wrong-agent" });
    }
    const now = this.#now();
    const current = this.#claims.get(run.id);
    if (current !== undefined && current.expiresAt > now) {
      return Promise.resolve({ type: "already-claimed", expiresAt: current.expiresAt });
    }
    if (current !== undefined) {
      this.#notifyControl(run.id, { type: "claim-lost" }, current.token);
      this.#claims.delete(run.id);
    }
    const readyResume = this.#graph(run.id).resumable.size > 0;
    if (
      terminal(run.status) ||
      (run.status === "suspended" && !readyResume && !run.abortRequested)
    ) {
      return Promise.resolve({
        type: "not-executable",
        ...(run.result === undefined ? {} : { result: run.result }),
      });
    }
    const fence = (this.#fences.get(run.id) ?? 0) + 1;
    this.#fences.set(run.id, fence);
    const claim: ExecutionClaim = Object.freeze({
      runId: run.id,
      executionId: input.executionId,
      token: ExecutionClaimToken.decode(globalThis.crypto.randomUUID()),
      fence,
      expiresAt: now + input.leaseDurationMs,
    });
    this.#claims.set(run.id, claim);
    return Promise.resolve({ type: "acquired", claim });
  }

  renewExecutionClaim(input: {
    readonly claim: ExecutionClaim;
    readonly leaseDurationMs: number;
  }): PromiseLike<ClaimRenewalResult> {
    if (!this.#validClaim(input.claim)) {
      return Promise.resolve({ type: "claim-lost" });
    }
    const run = this.#run(input.claim.runId);
    if (run.abortRequested) {
      return Promise.resolve({
        type: "abort-requested",
        ...(run.abortReason === undefined ? {} : { reason: run.abortReason }),
      });
    }
    const claim = Object.freeze({
      ...input.claim,
      expiresAt: this.#now() + input.leaseDurationMs,
    });
    this.#claims.set(claim.runId, claim);
    return Promise.resolve({ type: "renewed", claim });
  }

  waitForExecutionControl(input: {
    readonly claim: ExecutionClaim;
    readonly signal: AbortSignal;
  }): PromiseLike<ExecutionControl> {
    const immediate = this.#readControl(input.claim);
    if (immediate !== undefined) {
      return Promise.resolve(immediate);
    }
    return new Promise((resolve, reject) => {
      const waiters = this.#controlWaiters.get(input.claim.runId) ?? new Set<ControlWaiter>();
      const waiter: ControlWaiter = {
        token: input.claim.token,
        resolve,
        reject,
        signal: input.signal,
        onAbort: () => {
          waiters.delete(waiter);
          reject(input.signal.reason);
        },
      };
      waiters.add(waiter);
      this.#controlWaiters.set(input.claim.runId, waiters);
      input.signal.addEventListener("abort", waiter.onAbort, { once: true });
      const raced = this.#readControl(input.claim);
      if (raced !== undefined) {
        this.#settleWaiter(input.claim.runId, waiter, raced);
      }
    });
  }

  releaseExecutionClaim(claim: ExecutionClaim): PromiseLike<boolean> {
    if (!this.#sameClaim(claim)) {
      return Promise.resolve(false);
    }
    this.#claims.delete(claim.runId);
    return Promise.resolve(true);
  }

  async loadExecution(claim: ExecutionClaim): Promise<ExecutionSnapshot | undefined> {
    if (!this.#validClaim(claim)) {
      return undefined;
    }
    const run = this.#run(claim.runId);
    const branch = this.#branch(run.threadId, run.branchId);
    const path = await this.readBranchHistory({
      threadId: run.threadId,
      branchId: run.branchId,
    });
    return Object.freeze({
      run,
      branch,
      transcript: Object.freeze(path.map((entry) => entry.message)),
      head: branch.head!,
      pendingSteering: Object.freeze([...(this.#pendingSteering.get(run.id) ?? [])]),
      pendingRedirects: Object.freeze([...(this.#pendingRedirects.get(run.id) ?? [])]),
      toolCalls: Object.freeze(this.#orderedCalls(run.id)),
    });
  }
  /** Read one Tool Call only while the supplied Execution Claim remains valid. */
  loadToolCall(
    claim: ExecutionClaim,
    toolCallId: ToolCallId,
  ): PromiseLike<StoredToolCall | undefined> {
    if (!this.#validClaim(claim)) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(this.#calls(claim.runId).get(toolCallId));
  }

  commitStep(input: CommitStepInput): PromiseLike<GuardedStoreResult<BranchRecord>> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      const run = this.#run(input.claim.runId);
      return Promise.resolve({
        type: "committed",
        value: this.#branch(run.threadId, run.branchId),
      });
    }
    const failure = this.#guard(input.claim, input.expectedHead);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const run = this.#run(input.claim.runId);
    const branch = this.#append(run.threadId, run.branchId, input.expectedHead, input.entries);
    if (input.consumedSteeringThrough !== undefined) {
      this.#pendingSteering.set(
        run.id,
        (this.#pendingSteering.get(run.id) ?? []).filter(
          (item) => item.sequence > input.consumedSteeringThrough!,
        ),
      );
    }
    if (input.consumedRedirectsThrough !== undefined) {
      this.#pendingRedirects.set(
        run.id,
        (this.#pendingRedirects.get(run.id) ?? []).filter(
          (item) => item.sequence > input.consumedRedirectsThrough!,
        ),
      );
    }
    this.#commits.set(input.commitId, fingerprint);
    return Promise.resolve({ type: "committed", value: branch });
  }

  commitModelInvocation(
    input: CommitModelInvocationInput,
  ): PromiseLike<CommitModelInvocationStoreResult> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      const outcome = this.#modelCommitOutcomes.get(input.commitId);
      if (outcome === undefined) {
        throw new Error(`Commit '${input.commitId}' has no stored Model outcome`);
      }
      return Promise.resolve(outcome);
    }
    const failure = this.#guard(input.claim, input.expectedHead);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const run = this.#run(input.claim.runId);
    if ((this.#pendingRedirects.get(run.id)?.length ?? 0) > 0) {
      const outcome = Object.freeze({ type: "work-ready" as const });
      this.#commits.set(input.commitId, fingerprint);
      this.#modelCommitOutcomes.set(input.commitId, outcome);
      return Promise.resolve(outcome);
    }
    const graph = this.#graph(run.id);
    const calls = graph.calls;
    for (const call of input.toolCalls) {
      if (calls.has(call.toolCallId)) {
        throw new Error(`Tool Call '${call.toolCallId}' already exists`);
      }
    }
    const branch = this.#append(run.threadId, run.branchId, input.expectedHead, [input.entry]);
    for (const call of input.toolCalls) {
      this.#setCall(
        graph,
        Object.freeze({
          toolCallId: call.toolCallId,
          runId: run.id,
          sequence: this.#nextToolSequence(graph),
          toolName: call.toolName,
          ...(call.providerId === undefined ? {} : { providerId: call.providerId }),
          requestedInput: call.input,
          status: "pending",
          historyCommitted: false,
          ...(call.providerData === undefined ? {} : { providerData: call.providerData }),
        }),
      );
    }
    this.#commits.set(input.commitId, fingerprint);
    const outcome = Object.freeze({ type: "committed" as const, value: branch });
    this.#modelCommitOutcomes.set(input.commitId, outcome);
    return Promise.resolve(outcome);
  }

  recordModelCall(input: RecordModelCallInput): PromiseLike<GuardedStoreResult<RunUsage>> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      return Promise.resolve({
        type: "committed",
        value: this.#run(input.claim.runId).usage ?? emptyRunUsage(),
      });
    }
    if (!this.#validClaim(input.claim)) {
      return Promise.resolve({ type: "claim-lost" });
    }
    const run = this.#run(input.claim.runId);
    if (terminal(run.status)) {
      return Promise.resolve({
        type: "not-active",
        ...(run.result === undefined ? {} : { result: run.result }),
      });
    }
    const current = run.usage ?? emptyRunUsage();
    const index = current.models.findIndex((entry) => entry.modelId === input.modelId);
    const previous = index < 0 ? undefined : current.models[index];
    const modelUsage =
      input.usage === undefined
        ? (previous?.usage ?? emptyModelUsage())
        : addUsage(previous?.usage, input.usage);
    const entry: ModelRunUsage = Object.freeze({
      modelId: input.modelId,
      calls: (previous?.calls ?? 0) + 1,
      reportedCalls: (previous?.reportedCalls ?? 0) + (input.usage === undefined ? 0 : 1),
      usage: modelUsage,
    });
    const models =
      index < 0
        ? Object.freeze([...current.models, entry])
        : Object.freeze(
            current.models.map((candidate, candidateIndex) =>
              candidateIndex === index ? entry : candidate,
            ),
          );
    const usage: RunUsage = Object.freeze({
      total: input.usage === undefined ? current.total : addUsage(current.total, input.usage),
      models,
    });
    this.#runs.set(run.id, Object.freeze({ ...run, usage }));
    this.#commits.set(input.commitId, fingerprint);
    return Promise.resolve({ type: "committed", value: usage });
  }

  recordToolInput(input: RecordToolInputInput): PromiseLike<GuardedStoreResult<StoredToolCall>> {
    const failure = this.#guard(input.claim);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const graph = this.#graph(input.claim.runId);
    const call = this.#call(graph.calls, input.toolCallId);
    if (call.effectiveInput !== undefined && !same(call.effectiveInput, input.input)) {
      throw new Error(`Effective input for Tool Call '${call.toolCallId}' changed`);
    }
    const stored = Object.freeze({
      ...call,
      effectiveInput: call.effectiveInput ?? input.input,
    });
    this.#setCall(graph, stored);
    return Promise.resolve({ type: "committed", value: stored });
  }

  recordDelegatedToolCall(
    input: RecordDelegatedToolCallInput,
  ): PromiseLike<GuardedStoreResult<StoredToolCall>> {
    const failure = this.#guard(input.claim);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const graph = this.#graph(input.claim.runId);
    const calls = graph.calls;
    this.#call(calls, input.parentToolCallId);
    const currentId = graph.delegated.get(input.parentToolCallId)?.get(input.key);
    const current = currentId === undefined ? undefined : this.#call(calls, currentId);
    if (current !== undefined) {
      if (
        current.toolName !== input.toolName ||
        current.providerId !== input.providerId ||
        !same(current.requestedInput, input.input)
      ) {
        throw new Error(`Delegation key '${input.key}' was reused with different data`);
      }
      return Promise.resolve({ type: "committed", value: current });
    }
    if (calls.has(input.toolCallId)) {
      throw new Error(`Tool Call ID '${input.toolCallId}' is already in use`);
    }
    const stored: StoredToolCall = Object.freeze({
      toolCallId: input.toolCallId,
      runId: input.claim.runId,
      sequence: this.#nextToolSequence(graph),
      toolName: input.toolName,
      parentToolCallId: input.parentToolCallId,
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      delegationKey: input.key,
      requestedInput: input.input,
      status: "pending",
      historyCommitted: false,
    });
    this.#setCall(graph, stored);
    return Promise.resolve({ type: "committed", value: stored });
  }

  completeToolCall(input: CompleteToolCallInput): PromiseLike<GuardedStoreResult<StoredToolCall>> {
    const failure = this.#guard(input.claim);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const graph = this.#graph(input.claim.runId);
    const call = this.#call(graph.calls, input.toolCallId);
    const result =
      input.result.type === "success"
        ? Object.freeze({ ...input.result })
        : Object.freeze({
            ...input.result,
            failure:
              call.providerId === undefined
                ? Object.freeze({
                    type: "tool-failure" as const,
                    toolName: call.toolName,
                    toolCallId: call.toolCallId,
                    value: input.result.failure,
                  })
                : Object.freeze({
                    type: "tool-failure" as const,
                    dynamic: true as const,
                    providerId: call.providerId,
                    toolName: call.toolName,
                    toolCallId: call.toolCallId,
                    value: input.result.failure,
                  }),
          });
    if (call.result !== undefined) {
      if (!same(call.result, result)) {
        throw new Error(`Tool Call '${call.toolCallId}' completed with different results`);
      }
      return Promise.resolve({ type: "committed", value: call });
    }
    const terminal = {
      ...call,
      status: input.result.type === "success" ? ("succeeded" as const) : ("failed" as const),
      result,
    };
    delete terminal.suspension;
    const stored: StoredToolCall = Object.freeze(terminal);
    this.#setCall(graph, stored);
    return Promise.resolve({ type: "committed", value: stored });
  }

  suspendToolCall(input: SuspendToolCallInput): PromiseLike<GuardedStoreResult<StoredToolCall>> {
    const failure = this.#guard(input.claim);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const graph = this.#graph(input.claim.runId);
    const call = this.#call(graph.calls, input.toolCallId);
    const suspended = {
      ...call,
      status: "suspended" as const,
      suspension: Object.freeze({ ...input.suspension }),
    };
    delete suspended.result;
    const stored: StoredToolCall = Object.freeze(suspended);
    this.#setCall(graph, stored);
    return Promise.resolve({ type: "committed", value: stored });
  }

  commitToolResults(input: CommitToolResultsInput): PromiseLike<GuardedStoreResult<BranchRecord>> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      const run = this.#run(input.claim.runId);
      return Promise.resolve({
        type: "committed",
        value: this.#branch(run.threadId, run.branchId),
      });
    }
    const failure = this.#guard(input.claim, input.expectedHead);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const run = this.#run(input.claim.runId);
    const graph = this.#graph(run.id);
    const calls = graph.calls;
    for (const entry of input.entries) {
      const call = this.#call(calls, entry.toolCallId);
      if (
        call.parentToolCallId !== undefined ||
        (call.status !== "succeeded" && call.status !== "failed")
      ) {
        throw new Error(`Tool Call '${call.toolCallId}' has no terminal top-level result`);
      }
    }
    const branch = this.#append(run.threadId, run.branchId, input.expectedHead, input.entries);
    for (const entry of input.entries) {
      const call = this.#call(calls, entry.toolCallId);
      this.#setCall(graph, Object.freeze({ ...call, historyCommitted: true }));
    }
    this.#commits.set(input.commitId, fingerprint);
    return Promise.resolve({ type: "committed", value: branch });
  }

  continueSettlement(input: ContinueSettlementInput): PromiseLike<ContinueSettlementStoreResult> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      const outcome = this.#settlementOutcomes.get(input.commitId);
      if (outcome === undefined) {
        throw new Error(`Commit '${input.commitId}' has no stored settlement outcome`);
      }
      return Promise.resolve(outcome);
    }
    const failure = this.#guard(input.claim, input.expectedHead);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const run = this.#run(input.claim.runId);
    if ((this.#pendingRedirects.get(run.id)?.length ?? 0) > 0) {
      const outcome = Object.freeze({ type: "work-ready" as const });
      this.#commits.set(input.commitId, fingerprint);
      this.#settlementOutcomes.set(input.commitId, outcome);
      return Promise.resolve(outcome);
    }
    if ((this.#pendingSteering.get(run.id)?.length ?? 0) > 0) {
      this.#append(run.threadId, run.branchId, input.expectedHead, input.candidateEntries);
      const outcome = Object.freeze({ type: "work-ready" as const });
      this.#commits.set(input.commitId, fingerprint);
      this.#settlementOutcomes.set(input.commitId, outcome);
      return Promise.resolve(outcome);
    }
    if (run.settlementContinuations >= 32) {
      const outcome = Object.freeze({ type: "limit-reached" as const });
      this.#commits.set(input.commitId, fingerprint);
      this.#settlementOutcomes.set(input.commitId, outcome);
      return Promise.resolve(outcome);
    }
    const branch = this.#append(run.threadId, run.branchId, input.expectedHead, [
      ...input.candidateEntries,
      input.instructionEntry,
    ]);
    this.#runs.set(
      run.id,
      Object.freeze({
        ...run,
        settlementContinuations: run.settlementContinuations + 1,
      }),
    );
    this.#commits.set(input.commitId, fingerprint);
    const outcome = Object.freeze({ type: "committed" as const, value: branch });
    this.#settlementOutcomes.set(input.commitId, outcome);
    return Promise.resolve(outcome);
  }

  suspendRun(input: {
    readonly claim: ExecutionClaim;
    readonly expectedHead: MessageEntryId;
    readonly result: import("@commissary/core").SuspendedRunResult;
  }): PromiseLike<SuspendRunStoreResult> {
    const failure = this.#guard(input.claim, input.expectedHead);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    if (this.#graph(input.claim.runId).resumable.size > 0) {
      return Promise.resolve({ type: "work-ready" });
    }
    const run = this.#run(input.claim.runId);
    this.#runs.set(run.id, Object.freeze({ ...run, status: "suspended" }));
    return Promise.resolve({ type: "committed", value: input.result });
  }

  finalizeRun(input: FinalizeRunStoreInput): PromiseLike<FinalizeRunStoreResult> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      const outcome = this.#finalizationOutcomes.get(input.commitId);
      if (outcome === undefined) {
        throw new Error(`Commit '${input.commitId}' has no stored finalization outcome`);
      }
      return Promise.resolve(outcome);
    }
    if (!this.#validClaim(input.claim)) {
      return Promise.resolve({ type: "claim-lost" });
    }
    const run = this.#run(input.claim.runId);
    if (run.result !== undefined) {
      return Promise.resolve({ type: "not-active", result: run.result });
    }
    if (run.abortRequested && input.result.type !== "aborted") {
      return Promise.resolve({
        type: "abort-requested",
        ...(run.abortReason === undefined ? {} : { reason: run.abortReason }),
      });
    }
    const branch = this.#branch(run.threadId, run.branchId);
    if (branch.head !== input.expectedHead) {
      return Promise.resolve({ type: "head-changed", actualHead: branch.head! });
    }
    if (input.result.type !== "aborted" && (this.#pendingRedirects.get(run.id)?.length ?? 0) > 0) {
      const outcome = Object.freeze({ type: "work-ready" as const });
      this.#commits.set(input.commitId, fingerprint);
      this.#finalizationOutcomes.set(input.commitId, outcome);
      return Promise.resolve(outcome);
    }
    if (input.result.type !== "aborted" && (this.#pendingSteering.get(run.id)?.length ?? 0) > 0) {
      this.#append(run.threadId, run.branchId, input.expectedHead, input.entries);
      const outcome = Object.freeze({ type: "work-ready" as const });
      this.#commits.set(input.commitId, fingerprint);
      this.#finalizationOutcomes.set(input.commitId, outcome);
      return Promise.resolve(outcome);
    }
    this.#append(run.threadId, run.branchId, input.expectedHead, input.entries);
    if (input.abortUnresolvedTools) {
      const graph = this.#graph(run.id);
      for (const call of graph.calls.values()) {
        if (call.status !== "succeeded" && call.status !== "failed" && call.status !== "aborted") {
          const aborted = {
            ...call,
            status: "aborted" as const,
            result: Object.freeze({ type: "aborted" as const }),
          };
          delete aborted.suspension;
          this.#setCall(graph, Object.freeze(aborted));
        }
      }
    }
    const stored = Object.freeze({
      ...run,
      status: input.result.type,
      result: input.result,
      abortRequested: run.abortRequested || input.result.type === "aborted",
    });
    this.#runs.set(run.id, stored);
    this.#claims.delete(run.id);
    this.#commits.set(input.commitId, fingerprint);
    const outcome = Object.freeze({
      type: "committed" as const,
      value: input.result,
    });
    this.#finalizationOutcomes.set(input.commitId, outcome);
    return Promise.resolve(outcome);
  }

  recordInterruption(input: {
    readonly claim: ExecutionClaim;
    readonly interruption: Interruption;
  }): PromiseLike<GuardedStoreResult<Interruption>> {
    const failure = this.#guard(input.claim);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    this.#claims.delete(input.claim.runId);
    return Promise.resolve({ type: "committed", value: input.interruption });
  }

  #newCommit(commitId: CommitId, input: unknown): string | undefined {
    const fingerprint = canonical(input);
    const prior = this.#commits.get(commitId);
    if (prior === undefined) {
      return fingerprint;
    }
    if (prior !== fingerprint) {
      throw new Error(`Commit '${commitId}' was reused with different data`);
    }
    return undefined;
  }

  #branch(threadId: ThreadId, branchId: BranchId): BranchRecord {
    const branch = this.#branches.get(branchId);
    if (branch === undefined || branch.threadId !== threadId) {
      throw new Error(`Unknown Branch '${branchId}' in Thread '${threadId}'`);
    }
    return branch;
  }

  #run(runId: RunId): RunRecord {
    const run = this.#runs.get(runId);
    if (run === undefined) {
      throw new Error(`Unknown Run '${runId}'`);
    }
    return run;
  }

  #graph(runId: RunId): ToolCallGraph {
    const graph = this.#toolCalls.get(runId);
    if (graph === undefined) {
      throw new Error(`Unknown Tool Call Graph for Run '${runId}'`);
    }
    return graph;
  }

  #calls(runId: RunId): Map<ToolCallId, StoredToolCall> {
    return this.#graph(runId).calls;
  }

  #orderedCalls(runId: RunId): StoredToolCall[] {
    const graph = this.#graph(runId);
    return graph.order.map((toolCallId) => this.#call(graph.calls, toolCallId));
  }

  #nextToolSequence(graph: ToolCallGraph): number {
    graph.nextSequence += 1;
    return graph.nextSequence;
  }

  #setCall(graph: ToolCallGraph, call: StoredToolCall): void {
    const current = graph.calls.get(call.toolCallId);
    if (current === undefined) {
      graph.order.push(call.toolCallId);
      graph.nextSequence = Math.max(graph.nextSequence, call.sequence);
      if (call.parentToolCallId !== undefined && call.delegationKey !== undefined) {
        let delegated = graph.delegated.get(call.parentToolCallId);
        if (delegated === undefined) {
          delegated = new Map();
          graph.delegated.set(call.parentToolCallId, delegated);
        }
        delegated.set(call.delegationKey, call.toolCallId);
      }
    }
    graph.calls.set(call.toolCallId, call);
    if (call.suspension?.resumeInput === undefined) {
      graph.resumable.delete(call.toolCallId);
    } else {
      graph.resumable.add(call.toolCallId);
    }
  }

  #call(calls: Map<ToolCallId, StoredToolCall>, toolCallId: ToolCallId): StoredToolCall {
    const call = calls.get(toolCallId);
    if (call === undefined) {
      throw new Error(`Unknown Tool Call '${toolCallId}'`);
    }
    return call;
  }

  #append(
    threadId: ThreadId,
    branchId: BranchId,
    expectedHead: MessageEntryId | undefined,
    entries: readonly {
      readonly id: MessageEntryId;
      readonly message: import("@commissary/core").ModelMessage;
    }[],
  ): BranchRecord {
    let branch = this.#branch(threadId, branchId);
    if (branch.head !== expectedHead) {
      throw new Error(`Branch '${branchId}' head changed`);
    }
    let parent = expectedHead;
    for (const value of entries) {
      const current = this.#entries.get(value.id);
      const entry: MessageEntry = Object.freeze({
        id: value.id,
        threadId,
        ...(parent === undefined ? {} : { parent }),
        message: value.message,
      });
      if (current !== undefined && !same(current, entry)) {
        throw new Error(`Message Entry '${value.id}' already exists with different data`);
      }
      this.#entries.set(entry.id, current ?? entry);
      parent = entry.id;
    }
    branch = Object.freeze({
      ...branch,
      ...(parent === undefined ? {} : { head: parent }),
    });
    this.#branches.set(branch.id, branch);
    return branch;
  }

  #sameClaim(claim: ExecutionClaim): boolean {
    const current = this.#claims.get(claim.runId);
    return (
      current?.token === claim.token &&
      current.fence === claim.fence &&
      current.executionId === claim.executionId
    );
  }

  #validClaim(claim: ExecutionClaim): boolean {
    return this.#sameClaim(claim) && claim.expiresAt > this.#now();
  }

  #guard(
    claim: ExecutionClaim,
    expectedHead?: MessageEntryId,
  ):
    | { readonly type: "claim-lost" }
    | { readonly type: "head-changed"; readonly actualHead: MessageEntryId }
    | { readonly type: "abort-requested"; readonly reason?: JsonValue }
    | { readonly type: "not-active"; readonly result?: RunResult }
    | undefined {
    if (!this.#validClaim(claim)) {
      return { type: "claim-lost" };
    }
    const run = this.#run(claim.runId);
    if (terminal(run.status)) {
      return {
        type: "not-active",
        ...(run.result === undefined ? {} : { result: run.result }),
      };
    }
    if (run.abortRequested) {
      return {
        type: "abort-requested",
        ...(run.abortReason === undefined ? {} : { reason: run.abortReason }),
      };
    }
    if (expectedHead !== undefined) {
      const branch = this.#branch(run.threadId, run.branchId);
      if (branch.head !== expectedHead) {
        return { type: "head-changed", actualHead: branch.head! };
      }
    }
    return undefined;
  }

  #readControl(claim: ExecutionClaim): ExecutionControl | undefined {
    if (!this.#validClaim(claim)) {
      return { type: "claim-lost" };
    }
    const run = this.#run(claim.runId);
    if (run.abortRequested) {
      return {
        type: "abort-requested",
        ...(run.abortReason === undefined ? {} : { reason: run.abortReason }),
      };
    }
    return undefined;
  }

  #notifyControl(runId: RunId, control: ExecutionControl, token?: ExecutionClaimToken): void {
    for (const waiter of this.#controlWaiters.get(runId) ?? []) {
      if (token === undefined || waiter.token === token) {
        this.#settleWaiter(runId, waiter, control);
      }
    }
  }

  #settleWaiter(runId: RunId, waiter: ControlWaiter, control: ExecutionControl): void {
    this.#controlWaiters.get(runId)?.delete(waiter);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(control);
  }
}
