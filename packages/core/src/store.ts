import type { AgentReference } from "./identity.js";
import type {
  ArtifactReference,
  EncodedProviderData,
  ModelMessage,
  ModelUsage,
  RunUsage,
  Transcript,
} from "./protocol.js";
import type {
  AbortResult,
  BranchConflict,
  Interruption,
  RunConflict,
  RedirectResult,
  RunResult,
  RunSnapshot,
  RunSubmission,
  SteeringResult,
  SuspendedRunResult,
  ToolCallResult,
  ToolResumeConflict,
  ToolResumeRequestConflict,
} from "./runtime.js";
import type {
  BranchId,
  CommitId,
  ExecutionClaimToken,
  ExecutionId,
  JsonValue,
  MessageEntryId,
  RunId,
  RedirectRequestId,
  SteeringRequestId,
  ThreadId,
  ToolCallId,
  ToolResumeRequestId,
} from "./types.js";

/** Binary Artifact data read from or written to an Artifact Store. */
export interface ArtifactContent {
  readonly data: Uint8Array;
  readonly mediaType: string;
  readonly name?: string;
}

/** Durable storage for binary Model inputs and outputs. */
export interface ArtifactStore {
  readonly read: (
    reference: ArtifactReference,
    context: { readonly signal: AbortSignal },
  ) => PromiseLike<ArtifactContent>;
  readonly write: (
    content: ArtifactContent,
    context: { readonly signal: AbortSignal },
  ) => PromiseLike<ArtifactReference>;
}

/** A durable Thread identity. */
export interface ThreadRecord {
  readonly id: ThreadId;
}

/** A named path through immutable Thread Messages. */
export interface BranchRecord {
  readonly id: BranchId;
  readonly threadId: ThreadId;
  readonly name: string;
  readonly head?: MessageEntryId;
}

/** One immutable Message node in a Thread. */
export interface MessageEntry {
  readonly id: MessageEntryId;
  readonly threadId: ThreadId;
  readonly parent?: MessageEntryId;
  readonly message: ModelMessage;
}

/** Internal durable state for one Run. */
export interface RunRecord {
  readonly id: RunId;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly agent: AgentReference;
  readonly admittedHead: MessageEntryId;
  readonly status: "active" | "suspended" | "completed" | "failed" | "aborted";
  readonly abortRequested: boolean;
  readonly settlementContinuations: number;
  readonly usage?: RunUsage;
  readonly abortReason?: JsonValue;
  readonly result?: Exclude<RunResult, SuspendedRunResult>;
}

/** An expiring fenced authority to advance one Run. */
export interface ExecutionClaim {
  readonly runId: RunId;
  readonly executionId: ExecutionId;
  readonly token: ExecutionClaimToken;
  readonly fence: number;
  readonly expiresAt: number;
}

/** One durable Steering Message waiting for the next preparation step. */
export interface PendingSteering {
  readonly sequence: number;
  readonly message: ModelMessage;
}

/** One durable Redirect Message waiting for the next safe Run boundary. */
export interface PendingRedirect {
  readonly sequence: number;
  readonly message: ModelMessage;
}

/** Private durable state for one suspended Tool Call. */
export interface StoredToolSuspension {
  readonly continuation: JsonValue;
  readonly resumeInput?: JsonValue;
  readonly agent: AgentReference;
}

/** Internal durable state for one Tool Call Graph node. */
export interface StoredToolCall {
  readonly toolCallId: ToolCallId;
  readonly runId: RunId;
  readonly sequence: number;
  readonly toolName: string;
  readonly parentToolCallId?: ToolCallId;
  readonly providerId?: string;
  readonly delegationKey?: string;
  readonly input: JsonValue;
  readonly effectiveInput?: JsonValue;
  readonly status: "pending" | "running" | "suspended" | "succeeded" | "failed" | "aborted";
  readonly result?: ToolCallResult;
  readonly suspension?: StoredToolSuspension;
  readonly providerData?: readonly EncodedProviderData[];
  readonly historyCommitted: boolean;
}

/** A private atomic load used to advance one claimed Run. */
export interface ExecutionSnapshot {
  readonly run: RunRecord;
  readonly branch: BranchRecord;
  readonly transcript: Transcript;
  readonly head: MessageEntryId;
  readonly pendingSteering: readonly PendingSteering[];
  readonly pendingRedirects: readonly PendingRedirect[];
  readonly toolCalls: readonly StoredToolCall[];
}

/** Current durable context used to validate one Tool resume submission. */
export interface ToolResumeContext {
  readonly run: RunRecord;
  readonly transcript: Transcript;
  readonly head: MessageEntryId;
  readonly toolCalls: readonly StoredToolCall[];
}

/** The result of fenced Claim acquisition. */
export type ClaimResult =
  | { readonly type: "acquired"; readonly claim: ExecutionClaim }
  | { readonly type: "already-claimed"; readonly expiresAt: number }
  | { readonly type: "run-not-found" }
  | { readonly type: "not-executable"; readonly result?: RunResult };

/** The result of Claim renewal and Abort Request observation. */
export type ClaimRenewalResult =
  | { readonly type: "renewed"; readonly claim: ExecutionClaim }
  | { readonly type: "abort-requested"; readonly reason?: JsonValue }
  | { readonly type: "claim-lost" };

/** A control change observed while an Execution owns a Claim. */
export type ExecutionControl =
  | { readonly type: "abort-requested"; readonly reason?: JsonValue }
  | { readonly type: "claim-lost" };

/** The result of one claim-guarded Store transition. */
export type GuardedStoreResult<Value> =
  | { readonly type: "committed"; readonly value: Value }
  | { readonly type: "claim-lost" }
  | { readonly type: "head-changed"; readonly actualHead: MessageEntryId }
  | { readonly type: "abort-requested"; readonly reason?: JsonValue }
  | { readonly type: "not-active"; readonly result?: RunResult };

/** Input for atomic start command submission. */
export interface SubmitRunStoreInput {
  readonly runId: RunId;
  readonly entryId: MessageEntryId;
  readonly commitId: CommitId;
  readonly agent: AgentReference;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly message: ModelMessage;
  readonly expectedHead?: MessageEntryId;
}

/** Input for atomic Message append to one Branch. */
export interface AppendMessagesInput {
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly expectedHead?: MessageEntryId;
  readonly commitId: CommitId;
  readonly entries: readonly {
    readonly id: MessageEntryId;
    readonly message: ModelMessage;
  }[];
}

/** Input for claim-guarded Message append and Steering consumption. */
export interface CommitStepInput {
  readonly claim: ExecutionClaim;
  readonly expectedHead: MessageEntryId;
  readonly commitId: CommitId;
  readonly entries: readonly {
    readonly id: MessageEntryId;
    readonly message: ModelMessage;
  }[];
  readonly consumedSteeringThrough?: number;
  readonly consumedRedirectsThrough?: number;
}

/** One Tool Call created by a committed Model Message. */
export interface StoredModelToolCallInput {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly input: JsonValue;
  readonly providerId?: string;
  readonly providerData?: readonly EncodedProviderData[];
}

/** Input that commits a Model Message and its Tool Calls atomically. */
export interface CommitModelInvocationInput {
  readonly claim: ExecutionClaim;
  readonly expectedHead: MessageEntryId;
  readonly commitId: CommitId;
  readonly entry: { readonly id: MessageEntryId; readonly message: ModelMessage };
  readonly toolCalls: readonly StoredModelToolCallInput[];
}

/** Input that fixes effective Tool input before the first external attempt. */
export interface RecordToolInputInput {
  readonly claim: ExecutionClaim;
  readonly toolCallId: ToolCallId;
  readonly input: JsonValue;
}

/** Input that records a delegated child before its first Tool Attempt. */
export interface RecordDelegatedToolCallInput {
  readonly claim: ExecutionClaim;
  readonly parentToolCallId: ToolCallId;
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly providerId?: string;
  readonly key: string;
  readonly input: JsonValue;
}

/** Input that records one leaf Model call and its optional authoritative Usage. */
export interface RecordModelCallInput {
  readonly claim: ExecutionClaim;
  readonly commitId: CommitId;
  readonly modelId: string;
  readonly usage?: ModelUsage;
}

/** Input that records one declared Tool success or Failure. */
export interface CompleteToolCallInput {
  readonly claim: ExecutionClaim;
  readonly toolCallId: ToolCallId;
  readonly result: Exclude<ToolCallResult, { readonly type: "aborted" }>;
}

/** Input that durably suspends one Tool Call. */
export interface SuspendToolCallInput {
  readonly claim: ExecutionClaim;
  readonly toolCallId: ToolCallId;
  readonly suspension: StoredToolSuspension;
}

/** Input that appends terminal top-level Tool Results to Model history. */
export interface CommitToolResultsInput {
  readonly claim: ExecutionClaim;
  readonly expectedHead: MessageEntryId;
  readonly commitId: CommitId;
  readonly entries: readonly {
    readonly id: MessageEntryId;
    readonly toolCallId: ToolCallId;
    readonly message: ModelMessage;
  }[];
}

/** Input that commits one settlement continuation Step. */
export interface ContinueSettlementInput {
  readonly claim: ExecutionClaim;
  readonly expectedHead: MessageEntryId;
  readonly commitId: CommitId;
  readonly candidateEntries: readonly {
    readonly id: MessageEntryId;
    readonly message: ModelMessage;
  }[];
  readonly instructionEntry: {
    readonly id: MessageEntryId;
    readonly message: ModelMessage;
  };
}

/** Input for durable Run finalization. */
export interface FinalizeRunStoreInput {
  readonly claim: ExecutionClaim;
  readonly expectedHead: MessageEntryId;
  readonly commitId: CommitId;
  readonly entries: readonly {
    readonly id: MessageEntryId;
    readonly message: ModelMessage;
  }[];
  readonly result: Exclude<RunResult, SuspendedRunResult>;
  readonly abortUnresolvedTools?: boolean;
}

/** The guarded result of a suspension settlement race. */
export type SuspendRunStoreResult =
  | GuardedStoreResult<SuspendedRunResult>
  | { readonly type: "work-ready" };
/** The guarded result of committing a root Model result against a Redirect race. */
export type CommitModelInvocationStoreResult =
  | GuardedStoreResult<BranchRecord>
  | { readonly type: "work-ready" };

/** The guarded result of a settlement continuation commit. */
export type ContinueSettlementStoreResult =
  | GuardedStoreResult<BranchRecord>
  | { readonly type: "work-ready" }
  | { readonly type: "limit-reached" };

/** The guarded result of a terminal settlement race with accepted Steering. */
export type FinalizeRunStoreResult =
  | GuardedStoreResult<RunResult>
  | { readonly type: "work-ready" };

/** Durable persistence required by Commissary core. */
export interface ThreadStore {
  readonly createThread: (record: ThreadRecord) => PromiseLike<ThreadRecord>;
  readonly readThread: (threadId: ThreadId) => PromiseLike<ThreadRecord | undefined>;
  readonly createBranch: (input: {
    readonly branch: BranchRecord;
    readonly from?: MessageEntryId;
  }) => PromiseLike<BranchRecord>;
  readonly readBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => PromiseLike<BranchRecord | undefined>;
  readonly renameBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
    readonly name: string;
  }) => PromiseLike<BranchRecord>;
  readonly readBranchHistory: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => PromiseLike<readonly MessageEntry[]>;
  readonly appendMessages: (input: AppendMessagesInput) => PromiseLike<BranchRecord>;

  readonly submitRun: (
    input: SubmitRunStoreInput,
  ) => PromiseLike<RunSubmission | BranchConflict | RunConflict>;
  readonly submitToolResumes: (input: {
    readonly runId: RunId;
    readonly agent: AgentReference;
    readonly expectedHead: MessageEntryId;
    readonly items: readonly {
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly encodedInput: JsonValue;
    }[];
    readonly toolResumeRequestId?: ToolResumeRequestId;
  }) => PromiseLike<RunSubmission | ToolResumeConflict | ToolResumeRequestConflict>;
  readonly acceptSteering: (input: {
    readonly runId: RunId;
    readonly message: ModelMessage;
    readonly steeringRequestId?: SteeringRequestId;
  }) => PromiseLike<SteeringResult>;
  readonly acceptRedirect: (input: {
    readonly runId: RunId;
    readonly message: ModelMessage;
    readonly redirectRequestId?: RedirectRequestId;
  }) => PromiseLike<RedirectResult>;
  readonly requestAbort: (input: {
    readonly runId: RunId;
    readonly reason?: JsonValue;
  }) => PromiseLike<AbortResult>;
  readonly readRunSnapshot: (runId: RunId) => PromiseLike<RunSnapshot | undefined>;
  readonly readRunResult: (runId: RunId) => PromiseLike<RunResult | undefined>;
  readonly readToolResumeContext: (runId: RunId) => PromiseLike<ToolResumeContext | undefined>;

  readonly acquireExecutionClaim: (input: {
    readonly runId: RunId;
    readonly executionId: ExecutionId;
    readonly leaseDurationMs: number;
  }) => PromiseLike<ClaimResult>;
  readonly renewExecutionClaim: (input: {
    readonly claim: ExecutionClaim;
    readonly leaseDurationMs: number;
  }) => PromiseLike<ClaimRenewalResult>;
  readonly waitForExecutionControl?: (input: {
    readonly claim: ExecutionClaim;
    readonly signal: AbortSignal;
  }) => PromiseLike<ExecutionControl>;
  readonly releaseExecutionClaim: (claim: ExecutionClaim) => PromiseLike<boolean>;
  readonly loadExecution: (claim: ExecutionClaim) => PromiseLike<ExecutionSnapshot | undefined>;
  /** Read one Tool Call while its Run is owned by the supplied Execution Claim. */
  readonly loadToolCall: (
    claim: ExecutionClaim,
    toolCallId: ToolCallId,
  ) => PromiseLike<StoredToolCall | undefined>;

  readonly commitStep: (input: CommitStepInput) => PromiseLike<GuardedStoreResult<BranchRecord>>;
  readonly commitModelInvocation: (
    input: CommitModelInvocationInput,
  ) => PromiseLike<CommitModelInvocationStoreResult>;
  readonly recordModelCall: (
    input: RecordModelCallInput,
  ) => PromiseLike<GuardedStoreResult<RunUsage>>;
  readonly recordToolInput: (
    input: RecordToolInputInput,
  ) => PromiseLike<GuardedStoreResult<StoredToolCall>>;
  readonly recordDelegatedToolCall: (
    input: RecordDelegatedToolCallInput,
  ) => PromiseLike<GuardedStoreResult<StoredToolCall>>;
  readonly completeToolCall: (
    input: CompleteToolCallInput,
  ) => PromiseLike<GuardedStoreResult<StoredToolCall>>;
  readonly suspendToolCall: (
    input: SuspendToolCallInput,
  ) => PromiseLike<GuardedStoreResult<StoredToolCall>>;
  readonly commitToolResults: (
    input: CommitToolResultsInput,
  ) => PromiseLike<GuardedStoreResult<BranchRecord>>;
  readonly continueSettlement: (
    input: ContinueSettlementInput,
  ) => PromiseLike<ContinueSettlementStoreResult>;
  readonly suspendRun: (input: {
    readonly claim: ExecutionClaim;
    readonly expectedHead: MessageEntryId;
    readonly result: SuspendedRunResult;
  }) => PromiseLike<SuspendRunStoreResult>;
  readonly finalizeRun: (input: FinalizeRunStoreInput) => PromiseLike<FinalizeRunStoreResult>;
  readonly recordInterruption: (input: {
    readonly claim: ExecutionClaim;
    readonly interruption: Interruption;
  }) => PromiseLike<GuardedStoreResult<Interruption>>;
}

/** A specific Thread Store operation failure. */
export class ThreadStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly cause?: unknown,
  ) {
    super(`Thread Store operation '${operation}' failed`, { cause });
    this.name = "ThreadStoreError";
  }
}

/** A specific Artifact Store operation failure. */
export class ArtifactStoreError extends Error {
  constructor(
    readonly operation: "read" | "write",
    readonly cause?: unknown,
  ) {
    super(`Artifact Store operation '${operation}' failed`, { cause });
    this.name = "ArtifactStoreError";
  }
}
