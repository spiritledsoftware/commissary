import type { AgentReference } from "./identity.js";
import type {
  ArtifactReference,
  EncodedProviderData,
  ModelMessage,
  Transcript,
} from "./protocol.js";
import type {
  AbortResult,
  AdmitResult,
  Interruption,
  ResumeResult,
  RunResult,
  SteeringResult,
} from "./runtime.js";
import type {
  AttemptId,
  BranchId,
  CommitId,
  ExecutionClaimToken,
  JsonValue,
  MessageEntryId,
  RunId,
  RunRequestId,
  SteeringRequestId,
  ThreadId,
  ToolCallId,
  ToolResumeRequestId,
} from "./types.js";

export interface ArtifactContent {
  readonly data: Uint8Array;
  readonly mediaType: string;
  readonly name?: string;
}

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

export interface ThreadRecord {
  readonly id: ThreadId;
}

export interface BranchRecord {
  readonly id: BranchId;
  readonly threadId: ThreadId;
  readonly name: string;
  readonly head?: MessageEntryId;
}

export interface MessageEntry {
  readonly id: MessageEntryId;
  readonly threadId: ThreadId;
  readonly parent?: MessageEntryId;
  readonly message: ModelMessage;
}

export interface RunRecord {
  readonly id: RunId;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly agent: AgentReference;
  readonly admittedHead: MessageEntryId;
  readonly status: "active" | "suspended" | "completed" | "failed" | "aborted";
}

export interface ExecutionClaim {
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly token: ExecutionClaimToken;
  readonly fence: number;
  readonly expiresAt: number;
}

export interface PendingSteering {
  readonly sequence: number;
  readonly message: ModelMessage;
}

export interface StoredToolSuspension {
  readonly toolName: string;
  readonly toolCallId: ToolCallId;
  readonly agent: AgentReference;
  readonly compatibility: string;
  readonly continuation: JsonValue;
  readonly resumeInput?: JsonValue;
  readonly providerData?: readonly EncodedProviderData[];
}

export interface ExecutionSnapshot {
  readonly run: RunRecord;
  readonly branch: BranchRecord;
  readonly transcript: Transcript;
  readonly head: MessageEntryId;
  readonly pendingSteering: readonly PendingSteering[];
  readonly suspension?: StoredToolSuspension;
}

export type ClaimResult =
  | { readonly type: "acquired"; readonly claim: ExecutionClaim }
  | { readonly type: "already-claimed"; readonly expiresAt: number }
  | { readonly type: "not-executable"; readonly result?: RunResult };

export type GuardedStoreResult<Value> =
  | { readonly type: "committed"; readonly value: Value }
  | { readonly type: "claim-lost" }
  | { readonly type: "head-changed"; readonly actualHead: MessageEntryId }
  | { readonly type: "not-active"; readonly result?: RunResult };

export interface AdmitRunStoreInput {
  readonly runId: RunId;
  readonly entryId: MessageEntryId;
  readonly commitId: CommitId;
  readonly agent: AgentReference;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly message: ModelMessage;
  readonly expectedHead?: MessageEntryId;
  readonly runRequestId?: RunRequestId;
}

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

export interface CommitStepInput {
  readonly claim: ExecutionClaim;
  readonly expectedHead: MessageEntryId;
  readonly commitId: CommitId;
  readonly entries: readonly {
    readonly id: MessageEntryId;
    readonly message: ModelMessage;
  }[];
  readonly consumedSteeringThrough?: number;
}

export interface FinalizeRunStoreInput {
  readonly claim: ExecutionClaim;
  readonly expectedHead: MessageEntryId;
  readonly commitId: CommitId;
  readonly entries: readonly {
    readonly id: MessageEntryId;
    readonly message: ModelMessage;
  }[];
  readonly result: RunResult;
  readonly suspension?: StoredToolSuspension;
}

export interface ThreadStore {
  readonly createThread: (record: ThreadRecord) => PromiseLike<ThreadRecord>;
  readonly createBranch: (input: {
    readonly branch: BranchRecord;
    readonly from?: MessageEntryId;
  }) => PromiseLike<BranchRecord>;
  readonly renameBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
    readonly name: string;
  }) => PromiseLike<BranchRecord>;
  readonly readBranchPath: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => PromiseLike<readonly MessageEntry[]>;
  readonly appendMessages: (input: AppendMessagesInput) => PromiseLike<BranchRecord>;

  readonly admitRun: (input: AdmitRunStoreInput) => PromiseLike<AdmitResult>;
  readonly admitToolResume: (input: {
    readonly runId: RunId;
    readonly toolName: string;
    readonly encodedInput: JsonValue;
    readonly toolResumeRequestId?: ToolResumeRequestId;
  }) => PromiseLike<ResumeResult>;
  readonly readToolSuspension: (runId: RunId) => PromiseLike<StoredToolSuspension | undefined>;
  readonly acceptSteering: (input: {
    readonly runId: RunId;
    readonly message: ModelMessage;
    readonly steeringRequestId?: SteeringRequestId;
  }) => PromiseLike<SteeringResult>;
  readonly requestAbort: (input: {
    readonly runId: RunId;
    readonly reason?: JsonValue;
  }) => PromiseLike<AbortResult>;
  readonly readRunResult: (runId: RunId) => PromiseLike<RunResult | undefined>;

  readonly acquireExecutionClaim: (input: {
    readonly runId: RunId;
    readonly attemptId: AttemptId;
    readonly expiresAt: number;
  }) => PromiseLike<ClaimResult>;
  readonly renewExecutionClaim: (input: {
    readonly claim: ExecutionClaim;
    readonly expiresAt: number;
  }) => PromiseLike<ExecutionClaim | undefined>;
  readonly releaseExecutionClaim: (claim: ExecutionClaim) => PromiseLike<boolean>;
  readonly loadExecution: (claim: ExecutionClaim) => PromiseLike<ExecutionSnapshot | undefined>;
  readonly commitStep: (input: CommitStepInput) => PromiseLike<GuardedStoreResult<BranchRecord>>;
  readonly finalizeRun: (
    input: FinalizeRunStoreInput,
  ) => PromiseLike<GuardedStoreResult<RunResult>>;
  readonly recordInterruption: (input: {
    readonly claim: ExecutionClaim;
    readonly interruption: Interruption;
  }) => PromiseLike<GuardedStoreResult<Interruption>>;
}

export class ThreadStoreDefect extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ThreadStoreDefect";
  }
}
