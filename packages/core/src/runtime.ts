import type { AgentDefinition } from "./agent.js";
import type { HookDefinition } from "./hook.js";
import type { AgentReference, RunIdentity } from "./identity.js";
import type {
  ModelEvent,
  ModelFailure,
  ModelInterruption,
  ModelMessage,
  ModelResponse,
  ModelUsage,
  ToolCallContentPart,
} from "./protocol.js";
import type { ThreadStore } from "./store.js";
import type { ToolInvocationResult } from "./tool.js";
import type {
  BranchId,
  ExecutionId,
  JsonValue,
  MessageEntryId,
  RunId,
  SteeringRequestId,
  ThreadId,
  ToolCallId,
  ToolResumeRequestId,
} from "./types.js";

const preparedRunType: unique symbol = Symbol("commissary.runtime.prepared");
const executionEventType: unique symbol = Symbol("commissary.runtime.execution-event");
const modelInvocationType: unique symbol = Symbol("commissary.runtime.model");
const toolExecutionType: unique symbol = Symbol("commissary.runtime.tool");
const resolvedExecutionType: unique symbol = Symbol("commissary.runtime.resolved");

/** Process-local time operations used by the Runtime. */
export interface Clock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => PromiseLike<void>;
}

/** Create one opaque core-owned ID. */
export type GenerateId = () => string;

/** A command that creates a durable Run from one user Message. */
export interface StartRunCommand {
  readonly type: "start";
  readonly runId?: RunId;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly message: ModelMessage;
  readonly expectedHead?: MessageEntryId;
}

/** One typed resume input addressed to a suspended Tool Call. */
export interface ToolResumeItem<Value = unknown> {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly input: Value;
}

/** A command that atomically attaches input to one or more suspended Tool Calls. */
export interface ResumeRunCommand<Item extends ToolResumeItem = ToolResumeItem> {
  readonly type: "resume";
  readonly runId: RunId;
  readonly items: readonly [Item, ...Item[]];
  readonly toolResumeRequestId?: ToolResumeRequestId;
}

/** A durable command accepted by an Agent Client. */
export type RunCommand<Item extends ToolResumeItem = ToolResumeItem> =
  | StartRunCommand
  | ResumeRunCommand<Item>;

/** The durable identity and head returned after a successful submission. */
export interface RunSubmission {
  readonly type: "submitted";
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly head: MessageEntryId;
  readonly agent: AgentReference;
  readonly admitted: boolean;
}

/** A start command that observed a different current Branch head. */
export interface BranchConflict {
  readonly type: "branch-conflict";
  readonly expectedHead?: MessageEntryId;
  readonly actualHead?: MessageEntryId;
}

/** A Run ID that was already used for a different start command. */
export interface RunConflict {
  readonly type: "run-conflict";
  readonly runId: RunId;
}

/** A resume command that did not address the current suspended Tool Calls. */
export interface ToolResumeConflict {
  readonly type: "tool-resume-conflict";
  readonly runId: RunId;
  readonly toolCallIds: readonly ToolCallId[];
}

/** A request ID that was already used for different resume input. */
export interface ToolResumeRequestConflict {
  readonly type: "tool-resume-request-conflict";
  readonly runId: RunId;
  readonly toolResumeRequestId: ToolResumeRequestId;
}

/** The result of durable Run submission. */
export type SubmitResult =
  | RunSubmission
  | BranchConflict
  | RunConflict
  | ToolResumeConflict
  | ToolResumeRequestConflict;

/** A durable Steering submission. */
export interface SteerInput {
  readonly runId: RunId;
  readonly message: ModelMessage;
  readonly steeringRequestId?: SteeringRequestId;
}

/** The result of durable Steering submission. */
export type SteeringResult =
  | {
      readonly type: "accepted";
      readonly runId: RunId;
      readonly sequence: number;
      readonly admitted: boolean;
    }
  | { readonly type: "not-active"; readonly runId: RunId }
  | {
      readonly type: "steering-request-conflict";
      readonly runId: RunId;
      readonly steeringRequestId: SteeringRequestId;
    };

/** The result of a durable Abort Request. */
export type AbortResult =
  | { readonly type: "accepted"; readonly runId: RunId }
  | { readonly type: "already-resolved"; readonly result: RunResult };

/** An interruption caused by incompatible deferred Tool state. */
export interface StaleAgentInterruption {
  readonly type: "stale-agent";
  readonly expected: AgentReference;
  readonly installed: AgentReference;
  readonly toolName?: string;
  readonly detail: string;
}

/** A declared nonterminal stop in one Execution. */
export type Interruption = StaleAgentInterruption | ModelInterruption;

interface RunResultBase {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly head: MessageEntryId;
  readonly agent: AgentReference;
  readonly usage?: ModelUsage;
}

/** A successfully completed Run. */
export interface CompletedRunResult extends RunResultBase {
  readonly type: "completed";
  readonly response: ModelResponse;
}

/** The public identity of one unresolved Tool Suspension. */
export interface ToolSuspensionRecord {
  readonly toolName: string;
  readonly toolCallId: ToolCallId;
}

/** A Run that has no ready work and one or more unresolved suspensions. */
export interface SuspendedRunResult extends RunResultBase {
  readonly type: "suspended";
  readonly suspensions: readonly ToolSuspensionRecord[];
}

/** A Run that ended with a declared failure. */
export interface FailedRunResult<Failure = unknown> extends RunResultBase {
  readonly type: "failed";
  readonly failure: Failure;
}

/** A Run that ended after a durable Abort Request. */
export interface AbortedRunResult extends RunResultBase {
  readonly type: "aborted";
  readonly reason?: JsonValue;
}

/** A durable Run settlement value. */
export type RunResult<Failure = unknown> =
  | CompletedRunResult
  | SuspendedRunResult
  | FailedRunResult<Failure>
  | AbortedRunResult;

/** A nonterminal Execution result with a recorded Interruption. */
export interface InterruptedExecutionResult {
  readonly type: "interrupted";
  readonly runId: RunId;
  readonly interruption: Interruption;
}

/** The resolved value of one Execution. */
export type ExecutionResult<Failure = unknown> = RunResult<Failure> | InterruptedExecutionResult;

/** A public Tool Call result in a Run Snapshot. */
export type ToolCallResult =
  | { readonly type: "success"; readonly output: JsonValue }
  | { readonly type: "failure"; readonly failure: JsonValue }
  | { readonly type: "aborted" };

/** One public node in the complete Tool Call Graph. */
export interface ToolCallSnapshot {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly parentToolCallId?: ToolCallId;
  readonly status: "pending" | "running" | "suspended" | "succeeded" | "failed" | "aborted";
  readonly input: JsonValue;
  readonly result?: ToolCallResult;
}

/** One atomic point-in-time view of public durable Run state. */
export interface RunSnapshot<Failure = unknown> {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly head: MessageEntryId;
  readonly agent: AgentReference;
  readonly status: "active" | "suspended" | "completed" | "failed" | "aborted";
  readonly toolCalls: readonly ToolCallSnapshot[];
  readonly suspensions: readonly ToolSuspensionRecord[];
  readonly result?: RunResult<Failure>;
}

/** Canonical process-local progress from one Execution. */
export type ExecutionEvent<ToolEvent = unknown> =
  | { readonly type: "model-event"; readonly event: ModelEvent }
  | {
      readonly type: "tool-started";
      readonly toolName: string;
      readonly toolCallId: ToolCallId;
    }
  | {
      readonly type: "tool-event";
      readonly toolName: string;
      readonly toolCallId: ToolCallId;
      readonly event: ToolEvent;
    }
  | {
      readonly type: "tool-suspended";
      readonly toolName: string;
      readonly toolCallId: ToolCallId;
    }
  | {
      readonly type: "tool-finished";
      readonly toolName: string;
      readonly toolCallId: ToolCallId;
      readonly result: ToolInvocationResult;
    }
  | { readonly type: "error"; readonly error: unknown };

/** One process-bound attempt to advance a durable Run. */
export interface Execution<ToolEvent = never, Failure = unknown> {
  readonly [executionEventType]?: ToolEvent;
  readonly id: ExecutionId;
  readonly runId: RunId;
  readonly result: PromiseLike<ExecutionResult<Failure>>;
  readonly abort: (reason?: JsonValue) => Promise<AbortResult>;
}

/** A stable reason why an Execution could not start. */
export type ExecutionUnavailableReason =
  | "run-not-found"
  | "wrong-agent"
  | "already-claimed"
  | "not-executable";

/** An error reported before core can return an Execution. */
export class ExecutionUnavailableError extends Error {
  constructor(
    readonly runId: RunId,
    readonly reason: ExecutionUnavailableReason,
  ) {
    super(`Run '${runId}' cannot execute: ${reason}`);
    this.name = "ExecutionUnavailableError";
  }
}

/** An error reported when an Execution loses its fenced Claim. */
export class ExecutionClaimLostError extends Error {
  constructor(
    readonly runId: RunId,
    readonly cause?: unknown,
  ) {
    super(`Execution Claim for Run '${runId}' was lost`, { cause });
    this.name = "ExecutionClaimLostError";
  }
}

/** The stable phase in which an undeclared Execution exception occurred. */
export type UnexpectedExecutionPhase = "prepare" | "model" | "tool" | "hook" | "finalize" | "loop";

/** A wrapper for an undeclared exception from Execution work. */
export class UnexpectedExecutionError extends Error {
  constructor(
    readonly phase: UnexpectedExecutionPhase,
    readonly cause: unknown,
  ) {
    super(`Unexpected exception during Execution phase '${phase}'`, { cause });
    this.name = "UnexpectedExecutionError";
  }
}

/** A Runtime-created prepared view accepted by later Runtime Operations. */
export interface PreparedRun<Definition extends AgentDefinition = AgentDefinition> {
  readonly [preparedRunType]: Definition;
  readonly run: RunIdentity;
  readonly transcriptHead: MessageEntryId;
}

/** A successful Model invocation whose Tool Calls are already durable. */
export interface ModelResponseInvocation<Definition extends AgentDefinition = AgentDefinition> {
  readonly [modelInvocationType]: Definition;
  readonly type: "response";
  readonly response: ModelResponse;
  readonly toolCalls: readonly ToolCallContentPart[];
}

/** A declared Model Failure produced by a Runtime Operation. */
export interface ModelFailureInvocation<Definition extends AgentDefinition = AgentDefinition> {
  readonly [modelInvocationType]: Definition;
  readonly type: "failure";
  readonly failure: ModelFailure;
}

/** A declared Model Interruption produced by a Runtime Operation. */
export interface ModelInterruptionInvocation<Definition extends AgentDefinition = AgentDefinition> {
  readonly [modelInvocationType]: Definition;
  readonly type: "interruption";
  readonly interruption: ModelInterruption;
}

/** A branded result from Model invocation. */
export type ModelInvocation<Definition extends AgentDefinition = AgentDefinition> =
  | ModelResponseInvocation<Definition>
  | ModelFailureInvocation<Definition>
  | ModelInterruptionInvocation<Definition>;

/** One Runtime-created Tool result or durable suspension. */
export type ToolExecutionResult = ToolInvocationResult | { readonly type: "suspended" };

/** A Runtime-created Tool result accepted by later Runtime Operations. */
export interface ToolExecution<Definition extends AgentDefinition = AgentDefinition> {
  readonly [toolExecutionType]: Definition;
  readonly toolName: string;
  readonly toolCallId: ToolCallId;
  readonly result: ToolExecutionResult;
}

/** A Runtime-created durable Execution settlement. */
export interface ResolvedExecution<Failure = unknown> {
  readonly [resolvedExecutionType]: true;
  readonly value: ExecutionResult<Failure>;
}

/** The closed set of invariant-preserving operations available to a custom Loop. */
export interface RuntimeOperations<Definition extends AgentDefinition = AgentDefinition> {
  readonly prepare: (runId: RunId) => Promise<PreparedRun<Definition>>;
  readonly invokeModel: (prepared: PreparedRun<Definition>) => Promise<ModelInvocation<Definition>>;
  readonly executeTool: (
    prepared: PreparedRun<Definition>,
    call: ToolCallContentPart,
  ) => Promise<ToolExecution<Definition>>;
  readonly settle: (
    prepared: PreparedRun<Definition>,
    product: ModelInvocation<Definition> | ToolExecution<Definition>,
  ) => Promise<ResolvedExecution>;
}

/** The capabilities supplied to a custom Loop. */
export interface LoopExecutionContext<Definition extends AgentDefinition = AgentDefinition> {
  readonly runId: RunId;
  readonly agent: Definition;
  readonly runtime: RuntimeOperations<Definition>;
  readonly signal: AbortSignal;
}

/** A host-controlled replacement for the default Machine loop. */
export interface Loop {
  readonly execute: <Definition extends AgentDefinition>(
    context: LoopExecutionContext<Definition>,
  ) => Promise<ResolvedExecution>;
}

/** Internal core operations used by typed Agent Clients. */
export interface Runtime {
  readonly threadStore: ThreadStore;
  readonly submit: (agent: AgentReference, command: RunCommand) => Promise<SubmitResult>;
  readonly steer: (input: SteerInput) => Promise<SteeringResult>;
  readonly abort: (runId: RunId, reason?: JsonValue) => Promise<AbortResult>;
  readonly execute: <Definition extends AgentDefinition>(
    agent: Definition,
    runId: RunId,
    dynamicHooks: readonly HookDefinition[],
  ) => Promise<Execution<unknown>>;
  readonly readRunSnapshot: (runId: RunId) => Promise<RunSnapshot | undefined>;
  readonly readResult: (runId: RunId) => Promise<RunResult | undefined>;
}
