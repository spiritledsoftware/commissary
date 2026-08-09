import type {
  BaseStoreOperatorTypes,
  CreateInput,
  Field,
  JsonValue as StoreJsonValue,
  RecordDefinition,
  SelectedRecord,
  Store,
  StoreOperatorTypes,
} from "@commissary/store";

import type {
  CommandFieldsConfig,
  CoreRecordDefinitions,
  ThreadRecordDefinitions,
} from "./store-records.js";
export {
  coreRecordDefinitions,
  durableEntityRecordDefinitions,
  composeThreadStoreRecordDefinitions,
  runtimeStateRecordDefinitions,
  type BeforeCreateDraft,
  type BeforeCreateHook,
  type CommandFieldsConfig,
  type CompatibleThreadRecordOverrides,
  type ContributedThreadRecordDefinitions,
  type CoreDurableRecordCompatibility,
  type CoreRecordDefinitions,
  type CoreCommandCreatedRecordName,
  type CoreCreateDrafts,
  type CoreInternallyCreatedRecordName,
  type EffectiveRecordDefinitions,
  type CreateBranchInput,
  type CreateThreadInput,
  type ThreadRecordDefinitions,
  type RequiredBeforeCreateHookNames,
  type ThreadStoreFactoryConfig,
  type ThreadStoreHooks,
  type ThreadStoreHooksConfig,
} from "./store-records.js";
export { addThreadStoreCreateHooks } from "./store-hooks.js";

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
  AcceptedRun,
  BranchConflict,
  Interruption,
  RunConflict,
  RedirectResult,
  RunResult,
  RunSnapshot,
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

/** A durable terminal Tool Failure with its exact Tool identity. */
export type StoredToolFailure =
  | {
      readonly type: "tool-failure";
      readonly dynamic?: false;
      readonly providerId?: never;
      readonly toolName: string;
      readonly toolCallId: ToolCallId;
      readonly value: JsonValue;
    }
  | {
      readonly type: "tool-failure";
      readonly dynamic: true;
      readonly providerId: string;
      readonly toolName: string;
      readonly toolCallId: ToolCallId;
      readonly value: JsonValue;
    };

/** Internal durable state for one Tool Call Graph node. */
export interface StoredToolCall {
  readonly toolCallId: ToolCallId;
  readonly runId: RunId;
  readonly sequence: number;
  readonly toolName: string;
  readonly parentToolCallId?: ToolCallId;
  readonly providerId?: string;
  readonly delegationKey?: string;
  readonly requestedInput: JsonValue;
  readonly effectiveInput?: JsonValue;
  readonly status: "pending" | "running" | "suspended" | "succeeded" | "failed" | "aborted";
  readonly result?: ToolCallResult<JsonValue, StoredToolFailure>;
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

/** A cheap Agent-aware read of one Run settlement slot. */
export interface RunResultRecord {
  readonly agent: AgentReference;
  readonly result?: RunResult;
}

/** The result of fenced Claim acquisition. */
export type ClaimResult =
  | { readonly type: "acquired"; readonly claim: ExecutionClaim }
  | { readonly type: "already-claimed"; readonly expiresAt: number }
  | { readonly type: "run-not-found" }
  | { readonly type: "wrong-agent" }
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
export type SubmitRunStoreInput<
  Definitions extends ThreadRecordDefinitions = CoreRecordDefinitions,
> = {
  readonly runId: RunId;
  readonly entryId: MessageEntryId;
  readonly commitId: CommitId;
  readonly agent: AgentReference;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly message: ModelMessage;
  readonly expectedHead?: MessageEntryId;
} & CommandFieldsConfig<"run", Definitions>;

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
  readonly result: Exclude<ToolCallResult<JsonValue, JsonValue>, { readonly type: "aborted" }>;
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
export type CommitModelInvocationStoreResult<
  Definitions extends { readonly branch: RecordDefinition },
> = GuardedStoreResult<SelectedRecord<Definitions["branch"]>> | { readonly type: "work-ready" };

/** The guarded result of a settlement continuation commit. */
export type ContinueSettlementStoreResult<
  Definitions extends { readonly branch: RecordDefinition },
> =
  | GuardedStoreResult<SelectedRecord<Definitions["branch"]>>
  | { readonly type: "work-ready" }
  | { readonly type: "limit-reached" };

/** The guarded result of a terminal settlement race with accepted Steering. */
export type FinalizeRunStoreResult<_Definitions extends { readonly run: RecordDefinition }> =
  | GuardedStoreResult<RunResult>
  | { readonly type: "work-ready" };

/** Run Snapshot with complete effective Run and Tool Call Records. */
export type ThreadStoreRunSnapshot<
  Definitions extends ThreadRecordDefinitions = CoreRecordDefinitions,
> = Pick<RunSnapshot, "head" | "suspensions"> & {
  readonly run: SelectedRecord<Definitions["run"]>;
  readonly toolCalls: readonly SelectedRecord<Definitions["toolCall"]>[];
};

/** Query operator surface required by Core Thread Store transitions. */
export interface CoreQueryOperators<PredicateValue> {
  /** Compare one Field or JSON value with another value of the same type. */
  readonly eq: <Value extends StoreJsonValue>(
    left: Field<Value | undefined> | Value,
    right: Field<Value | undefined> | Value,
  ) => PredicateValue;
  /** Require every supplied Core Predicate to match. */
  readonly and: (...predicates: readonly (PredicateValue | undefined)[]) => PredicateValue;
  /** Require at least one supplied Core Predicate to match. */
  readonly or: (...predicates: readonly (PredicateValue | undefined)[]) => PredicateValue;
}

/** Capability-honest Store operator types that can execute Core transitions. */
export interface CoreStoreOperatorTypes extends StoreOperatorTypes {
  /** Query operators used by Core persistence logic. */
  readonly operators: CoreQueryOperators<this["predicate"]>;
}

/** Durable persistence required by Commissary core. */
export interface ThreadStore<
  Definitions extends ThreadRecordDefinitions = CoreRecordDefinitions,
  Operators extends CoreStoreOperatorTypes = BaseStoreOperatorTypes,
> extends Store<Definitions, Operators> {
  readonly createThread: (
    record: CreateInput<Definitions["thread"]>,
  ) => Promise<SelectedRecord<Definitions["thread"]>>;
  readonly readThread: (
    threadId: ThreadId,
  ) => Promise<SelectedRecord<Definitions["thread"]> | undefined>;
  readonly createBranch: (input: {
    readonly branch: CreateInput<Definitions["branch"]>;
    readonly from?: MessageEntryId;
  }) => Promise<SelectedRecord<Definitions["branch"]>>;
  readonly readBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => Promise<SelectedRecord<Definitions["branch"]> | undefined>;
  readonly renameBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
    readonly name: string;
  }) => Promise<SelectedRecord<Definitions["branch"]>>;
  readonly readBranchHistory: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => Promise<readonly SelectedRecord<Definitions["message"]>[]>;
  readonly appendMessages: (
    input: AppendMessagesInput,
  ) => Promise<SelectedRecord<Definitions["branch"]>>;

  readonly submitRun: (
    input: SubmitRunStoreInput<Definitions>,
  ) => Promise<AcceptedRun | BranchConflict | RunConflict>;
  readonly submitToolResumes: (input: {
    readonly runId: RunId;
    readonly agent: AgentReference;
    readonly expectedHead: MessageEntryId;
    readonly items: readonly {
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly input: JsonValue;
    }[];
    readonly toolResumeRequestId?: ToolResumeRequestId;
  }) => Promise<AcceptedRun | ToolResumeConflict | ToolResumeRequestConflict>;
  readonly acceptSteering: (input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
    readonly message: ModelMessage;
    readonly steeringRequestId?: SteeringRequestId;
  }) => Promise<SteeringResult>;
  readonly acceptRedirect: (input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
    readonly message: ModelMessage;
    readonly redirectRequestId?: RedirectRequestId;
  }) => Promise<RedirectResult>;
  readonly requestAbort: (input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
    readonly reason?: JsonValue;
  }) => Promise<AbortResult>;
  readonly readRunSnapshot: (input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
  }) => Promise<ThreadStoreRunSnapshot<Definitions> | undefined>;
  readonly readRunResult: (input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
  }) => Promise<RunResultRecord | undefined>;
  readonly readToolResumeContext: (input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
  }) => Promise<ToolResumeContext | undefined>;

  readonly acquireExecutionClaim: (input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
    readonly executionId: ExecutionId;
    readonly leaseDurationMs: number;
  }) => Promise<ClaimResult>;
  readonly renewExecutionClaim: (input: {
    readonly claim: ExecutionClaim;
    readonly leaseDurationMs: number;
  }) => Promise<ClaimRenewalResult>;
  readonly waitForExecutionControl?: (input: {
    readonly claim: ExecutionClaim;
    readonly signal: AbortSignal;
  }) => Promise<ExecutionControl>;
  readonly releaseExecutionClaim: (claim: ExecutionClaim) => Promise<boolean>;
  readonly loadExecution: (claim: ExecutionClaim) => Promise<ExecutionSnapshot | undefined>;
  /** Read one Tool Call while its Run is owned by the supplied Execution Claim. */
  readonly loadToolCall: (
    claim: ExecutionClaim,
    toolCallId: ToolCallId,
  ) => Promise<StoredToolCall | undefined>;

  readonly commitStep: (
    input: CommitStepInput,
  ) => Promise<GuardedStoreResult<SelectedRecord<Definitions["branch"]>>>;
  readonly commitModelInvocation: (
    input: CommitModelInvocationInput,
  ) => Promise<CommitModelInvocationStoreResult<Definitions>>;
  readonly recordModelCall: (input: RecordModelCallInput) => Promise<GuardedStoreResult<RunUsage>>;
  readonly recordToolInput: (
    input: RecordToolInputInput,
  ) => Promise<GuardedStoreResult<SelectedRecord<Definitions["toolCall"]>>>;
  readonly recordDelegatedToolCall: (
    input: RecordDelegatedToolCallInput,
  ) => Promise<GuardedStoreResult<SelectedRecord<Definitions["toolCall"]>>>;
  readonly completeToolCall: (
    input: CompleteToolCallInput,
  ) => Promise<GuardedStoreResult<SelectedRecord<Definitions["toolCall"]>>>;
  readonly suspendToolCall: (
    input: SuspendToolCallInput,
  ) => Promise<GuardedStoreResult<SelectedRecord<Definitions["toolCall"]>>>;
  readonly commitToolResults: (
    input: CommitToolResultsInput,
  ) => Promise<GuardedStoreResult<SelectedRecord<Definitions["branch"]>>>;
  readonly continueSettlement: (
    input: ContinueSettlementInput,
  ) => Promise<ContinueSettlementStoreResult<Definitions>>;
  readonly suspendRun: (input: {
    readonly claim: ExecutionClaim;
    readonly expectedHead: MessageEntryId;
    readonly result: SuspendedRunResult;
  }) => Promise<SuspendRunStoreResult>;
  readonly finalizeRun: (
    input: FinalizeRunStoreInput,
  ) => Promise<FinalizeRunStoreResult<Definitions>>;
  readonly recordInterruption: (input: {
    readonly claim: ExecutionClaim;
    readonly interruption: Interruption;
  }) => Promise<GuardedStoreResult<Interruption>>;
}

/** A specific Artifact Store operation failure. */
export class ArtifactStoreError extends Error {
  /** Artifact Store operation that failed. */
  readonly operation: "read" | "write";
  /** Original Artifact Store failure. */
  override readonly cause?: unknown;

  /** Create one Artifact Store operation failure. */
  constructor(operation: "read" | "write", cause?: unknown) {
    super(`Artifact Store operation '${operation}' failed`, { cause });
    this.name = "ArtifactStoreError";
    this.operation = operation;
    this.cause = cause;
  }
}
