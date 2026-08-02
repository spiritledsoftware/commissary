import type { AgentDefinition } from "./agent.js";
import type { HookDefinition } from "./hook.js";
import type { AgentReference, RunIdentity } from "./identity.js";
import type {
  ContentPart,
  EncodedProviderData,
  ModelEvent,
  ModelFailure,
  ModelInterruption,
  ModelMessage,
  ModelResponse,
  RunUsage,
  ToolCallContentPart,
} from "./protocol.js";
import type { ThreadStore } from "./store.js";
import type { DynamicTool, Tool, ToolDefinition, ToolInvocationResult } from "./tool.js";
import type {
  BranchId,
  ExecutionId,
  JsonValue,
  MaybePromise,
  MessageEntryId,
  RunId,
  RedirectRequestId,
  SteeringRequestId,
  ThreadId,
  ToolCallId,
  ToolResumeRequestId,
} from "./types.js";

const preparedWorkType: unique symbol = Symbol("commissary.runtime.prepared-work");
const preparedToolCallType: unique symbol = Symbol("commissary.runtime.prepared-tool-call");
const executionEventType: unique symbol = Symbol("commissary.runtime.execution-event");
const modelInvocationType: unique symbol = Symbol("commissary.runtime.model");
const toolExecutionType: unique symbol = Symbol("commissary.runtime.tool");
const resolvedExecutionType: unique symbol = Symbol("commissary.runtime.resolved");

type OpenTools = ToolDefinition | DynamicTool;

type DynamicToolBranch<Tools, Value> = [Tool.Dynamic<Tools>] extends [never] ? never : Value;

type StaticToolIdentity<Definition extends ToolDefinition> = {
  readonly dynamic?: false;
  readonly providerId?: never;
  readonly toolName: Tool.Name<Definition>;
  readonly toolCallId: ToolCallId;
};

type DynamicToolIdentity = {
  readonly dynamic: true;
  readonly providerId: string;
  readonly toolName: string;
  readonly toolCallId: ToolCallId;
};

/** Process-local time operations used by the Runtime. */
export interface Clock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => PromiseLike<void>;
}

/** Create one opaque core-owned ID. */
export type GenerateId = () => string;

/** Input that creates a durable Run from one user Message. */
export interface CreateRunInput<Run extends RunId = RunId> {
  readonly runId?: Run;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly message: ModelMessage;
  readonly expectedHead?: MessageEntryId;
  readonly fields?: Readonly<Record<string, JsonValue | undefined>>;
}

/** One JSON resume input for either a static or dynamic suspended Tool Call. */
export type ToolResumeItem<Value extends JsonValue = JsonValue> =
  | {
      readonly dynamic?: false;
      readonly providerId?: never;
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly input: Value;
    }
  | {
      readonly dynamic: true;
      readonly providerId: string;
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly input: Value;
    };

/** Input that atomically attaches JSON input to one or more suspended Tool Calls. */
export interface ResumeRunInput<
  Item extends ToolResumeItem = ToolResumeItem,
  Run extends RunId = RunId,
> {
  readonly runId: Run;
  readonly items: readonly [Item, ...Item[]];
  readonly toolResumeRequestId?: ToolResumeRequestId;
}

/** The durable identity and head returned after a command is accepted. */
export interface AcceptedRun<Run extends RunId = RunId> {
  readonly type: "accepted";
  readonly runId: Run;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly head: MessageEntryId;
  readonly agent: AgentReference;
  readonly admitted: boolean;
}

/** A create command that observed a different current Branch head. */
export interface BranchConflict {
  readonly type: "branch-conflict";
  readonly expectedHead?: MessageEntryId;
  readonly actualHead?: MessageEntryId;
}

/** A Run ID that was already used for a different create command. */
export interface RunConflict<Run extends RunId = RunId> {
  readonly type: "run-conflict";
  readonly runId: Run;
}

/** A resume command that did not address the current suspended Tool Calls. */
export interface ToolResumeConflict<Run extends RunId = RunId> {
  readonly type: "tool-resume-conflict";
  readonly runId: Run;
  readonly toolCallIds: readonly ToolCallId[];
}

/** A request ID that was already used for different resume input. */
export interface ToolResumeRequestConflict<Run extends RunId = RunId> {
  readonly type: "tool-resume-request-conflict";
  readonly runId: Run;
  readonly toolResumeRequestId: ToolResumeRequestId;
}

/** The result of durable Run creation. */
export type CreateRunResult<Run extends RunId = RunId> =
  | AcceptedRun<Run>
  | BranchConflict
  | RunConflict<Run>;

/** The result of a durable Tool resume command. */
export type ResumeRunResult<Run extends RunId = RunId> =
  | AcceptedRun<Run>
  | ToolResumeConflict<Run>
  | ToolResumeRequestConflict<Run>;

/** A durable Steering submission. */
export interface SteerInput<Run extends RunId = RunId> {
  readonly runId: Run;
  readonly message: ModelMessage;
  readonly steeringRequestId?: SteeringRequestId;
}

/** The result of durable Steering submission. */
export type SteeringResult<Run extends RunId = RunId> =
  | {
      readonly type: "accepted";
      readonly runId: Run;
      readonly sequence: number;
      readonly admitted: boolean;
    }
  | { readonly type: "not-active"; readonly runId: Run }
  | {
      readonly type: "steering-request-conflict";
      readonly runId: Run;
      readonly steeringRequestId: SteeringRequestId;
    };

/** A durable Redirect submission. */
export interface RedirectInput<Run extends RunId = RunId> {
  readonly runId: Run;
  readonly message: ModelMessage;
  readonly redirectRequestId?: RedirectRequestId;
}

/** The result of durable Redirect submission. */
export type RedirectResult<Run extends RunId = RunId> =
  | {
      readonly type: "accepted";
      readonly runId: Run;
      readonly sequence: number;
      readonly admitted: boolean;
    }
  | { readonly type: "not-active"; readonly runId: Run }
  | {
      readonly type: "redirect-request-conflict";
      readonly runId: Run;
      readonly redirectRequestId: RedirectRequestId;
    };

/** The result of a durable Abort Request. */
export type AbortResult<Failure = unknown, Tools = OpenTools, Run extends RunId = RunId> =
  | { readonly type: "accepted"; readonly runId: Run }
  | { readonly type: "not-active"; readonly runId: Run }
  | { readonly type: "already-resolved"; readonly result: RunResult<Failure, Tools, Run> };
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

interface RunResultBase<Run extends RunId = RunId> {
  readonly runId: Run;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly head: MessageEntryId;
  readonly agent: AgentReference;
  readonly usage?: RunUsage;
}

/** A successfully completed Run. */
export interface CompletedRunResult<Run extends RunId = RunId> extends RunResultBase<Run> {
  readonly type: "completed";
  readonly response: ModelResponse;
}

/** The public identity of one unresolved static or dynamic Tool Suspension. */
export type ToolSuspensionRecord<Tools = OpenTools> =
  | Tool.Suspension<Tool.Static<Tools>>
  | DynamicToolBranch<Tools, DynamicToolIdentity>;

/** A Run that has no ready work and one or more unresolved suspensions. */
export interface SuspendedRunResult<
  Tools = OpenTools,
  Run extends RunId = RunId,
> extends RunResultBase<Run> {
  readonly type: "suspended";
  readonly suspensions: readonly ToolSuspensionRecord<Tools>[];
}

/** A Run that ended with a declared failure. */
export interface FailedRunResult<
  Failure = unknown,
  Run extends RunId = RunId,
> extends RunResultBase<Run> {
  readonly type: "failed";
  readonly failure: Failure;
}

/** A Run that ended after a durable Abort Request. */
export interface AbortedRunResult<Run extends RunId = RunId> extends RunResultBase<Run> {
  readonly type: "aborted";
  readonly reason?: JsonValue;
}

/** A durable Run settlement value. */
export type RunResult<Failure = unknown, Tools = OpenTools, Run extends RunId = RunId> =
  | CompletedRunResult<Run>
  | SuspendedRunResult<Tools, Run>
  | FailedRunResult<Failure, Run>
  | AbortedRunResult<Run>;

/** A nonterminal Execution result with a recorded Interruption. */
export interface InterruptedExecutionResult<Run extends RunId = RunId> {
  readonly type: "interrupted";
  readonly runId: Run;
  readonly interruption: Interruption;
}

/** The resolved value of one Execution. */
export type ExecutionResult<Failure = unknown, Tools = OpenTools, Run extends RunId = RunId> =
  | RunResult<Failure, Tools, Run>
  | InterruptedExecutionResult<Run>;

/** A public Tool Call result in a Run Snapshot. */
export type ToolCallResult<Output extends JsonValue = JsonValue, Failure = JsonValue> =
  | {
      readonly type: "success";
      readonly output: Output;
      readonly content?: readonly ContentPart[];
    }
  | {
      readonly type: "failure";
      readonly failure: Failure;
      readonly content?: readonly ContentPart[];
    }
  | { readonly type: "aborted" };
interface ToolCallSnapshotBase {
  readonly toolCallId: ToolCallId;
  readonly runId: RunId;
  readonly sequence: number;
  readonly parentToolCallId?: ToolCallId;
  readonly delegationKey?: string;
  readonly status: "pending" | "running" | "suspended" | "succeeded" | "failed" | "aborted";
  readonly suspension?: {
    readonly continuation: JsonValue;
    readonly resumeInput?: JsonValue;
    readonly agent: AgentReference;
  };
  readonly providerData?: readonly EncodedProviderData[];
  readonly historyCommitted: boolean;
}

type StaticToolCallSnapshot<Tools> =
  Tool.Static<Tools> extends infer Definition
    ? Definition extends ToolDefinition
      ? ToolCallSnapshotBase &
          StaticToolIdentity<Definition> & {
            readonly requestedInput: Tool.RequestedInput<Definition>;
            readonly effectiveInput?: Tool.RequestedInput<Definition>;
            readonly result?: ToolCallResult<Tool.Output<Definition>, Tool.Failure<Definition>>;
          }
      : never
    : never;

type DynamicToolCallSnapshot<Tools> = DynamicToolBranch<
  Tools,
  ToolCallSnapshotBase &
    DynamicToolIdentity & {
      readonly requestedInput: JsonValue;
      readonly effectiveInput?: JsonValue;
      readonly result?: ToolCallResult<JsonValue, Tool.Failure<DynamicTool>>;
    }
>;

/** One public node in the complete Tool Call Graph. */
export type ToolCallSnapshot<Tools = OpenTools> =
  | StaticToolCallSnapshot<Tools>
  | DynamicToolCallSnapshot<Tools>;
/** Complete built-in stored Run Record in one public Snapshot. */
export interface RunSnapshotRecord<
  Failure = unknown,
  Tools = OpenTools,
  Run extends RunId = RunId,
> {
  readonly id: Run;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly agent: AgentReference;
  readonly admittedHead: MessageEntryId;
  readonly status: "active" | "suspended" | "completed" | "failed" | "aborted";
  readonly abortRequested: boolean;
  readonly settlementContinuations: number;
  readonly usage?: RunUsage;
  readonly abortReason?: JsonValue;
  readonly result?: Exclude<RunResult<Failure, Tools, Run>, SuspendedRunResult<Tools, Run>>;
}

/** One atomic point-in-time view of public durable Run state. */
export interface RunSnapshot<Failure = unknown, Tools = OpenTools, Run extends RunId = RunId> {
  readonly run: RunSnapshotRecord<Failure, Tools, Run>;
  readonly head: MessageEntryId;
  readonly toolCalls: readonly ToolCallSnapshot<Tools>[];
  readonly suspensions: readonly ToolSuspensionRecord<Tools>[];
}

type StaticExecutionEvent<Tools> =
  Tool.Static<Tools> extends infer Definition
    ? Definition extends ToolDefinition
      ?
          | (StaticToolIdentity<Definition> & { readonly type: "tool-started" })
          | (StaticToolIdentity<Definition> & {
              readonly type: "tool-event";
              readonly event: Tool.Event<Definition>;
            })
          | ([Tool.ResumeInput<Definition>] extends [never]
              ? never
              : StaticToolIdentity<Definition> & { readonly type: "tool-suspended" })
          | (StaticToolIdentity<Definition> & {
              readonly type: "tool-finished";
              readonly result: ToolInvocationResult<
                Tool.Output<Definition>,
                Tool.Failure<Definition>
              >;
            })
      : never
    : never;

type DynamicExecutionEvent<Tools> = DynamicToolBranch<
  Tools,
  | (DynamicToolIdentity & { readonly type: "tool-started" })
  | (DynamicToolIdentity & { readonly type: "tool-event"; readonly event: unknown })
  | (DynamicToolIdentity & { readonly type: "tool-suspended" })
  | (DynamicToolIdentity & {
      readonly type: "tool-finished";
      readonly result: ToolInvocationResult<JsonValue, Tool.Failure<DynamicTool>>;
    })
>;

/** Canonical process-local progress from one Execution. */
export type ExecutionEvent<Tools = OpenTools> =
  | { readonly type: "model-event"; readonly event: ModelEvent }
  | StaticExecutionEvent<Tools>
  | DynamicExecutionEvent<Tools>
  | { readonly type: "error"; readonly error: unknown };

/** One Event batch item awaiting durable Run-local sequence assignment. */
export interface ExecutionEventAppend<Tools = OpenTools> {
  readonly runId: RunId;
  readonly executionId: ExecutionId;
  readonly event: ExecutionEvent<Tools>;
}

/** One durable Event envelope appended in canonical Run order. */
export interface ExecutionEventRecord<Tools = OpenTools> extends ExecutionEventAppend<Tools> {
  readonly sequence: number;
}

/**
 * Append-only persistence for ordered Execution Event batches.
 *
 * The Store assigns and persists a strictly increasing sequence within each Run.
 */
export interface ExecutionEventStore {
  readonly append: (
    events: readonly [ExecutionEventAppend, ...ExecutionEventAppend[]],
  ) => MaybePromise<void>;
}

/** An error reported when durable Execution Event append fails. */
export class ExecutionEventStoreError extends Error {
  constructor(override readonly cause: unknown) {
    super("Execution Event Store append failed", { cause });
    this.name = "ExecutionEventStoreError";
  }
}

/** One process-bound attempt to advance a durable Run. */
export interface Execution<Tools = OpenTools, Failure = unknown, Run extends RunId = RunId> {
  readonly [executionEventType]?: Tools;
  readonly id: ExecutionId;
  readonly runId: Run;
  readonly result: PromiseLike<ExecutionResult<Failure, Tools, Run>>;
  readonly abort: (reason?: JsonValue) => Promise<AbortResult<Failure, Tools, Run>>;
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
    override readonly cause?: unknown,
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
    override readonly cause: unknown,
  ) {
    super(`Unexpected exception during Execution phase '${phase}'`, { cause });
    this.name = "UnexpectedExecutionError";
  }
}

interface PreparedWorkBase<Definition extends AgentDefinition> {
  readonly [preparedWorkType]: Definition;
  readonly run: RunIdentity;
  readonly transcriptHead: MessageEntryId;
}

/** Runtime-created permission to invoke the root Model for one prepared Run state. */
export interface PreparedModelWork<
  Definition extends AgentDefinition = AgentDefinition,
> extends PreparedWorkBase<Definition> {
  readonly type: "model";
}

/** One committed top-level Tool Call that a custom Loop can execute. */
export interface PreparedToolCall<
  Definition extends AgentDefinition = AgentDefinition,
> extends ToolCallContentPart {
  readonly [preparedToolCallType]: Definition;
}

/** Runtime-created permission to advance committed top-level Tool Calls. */
export interface PreparedToolWork<
  Definition extends AgentDefinition = AgentDefinition,
> extends PreparedWorkBase<Definition> {
  readonly type: "tools";
  readonly calls: readonly PreparedToolCall<Definition>[];
}

/** The next executable work for one claimed Run. */
export type PreparedWork<Definition extends AgentDefinition = AgentDefinition> =
  | PreparedModelWork<Definition>
  | PreparedToolWork<Definition>;

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
  readonly prepare: (runId: RunId) => Promise<PreparedWork<Definition>>;
  readonly invokeModel: (
    prepared: PreparedModelWork<Definition>,
  ) => Promise<ModelInvocation<Definition>>;
  readonly executeTool: (
    prepared: PreparedToolWork<Definition>,
    call: PreparedToolCall<Definition>,
  ) => Promise<ToolExecution<Definition>>;
  readonly settle: {
    (
      prepared: PreparedModelWork<Definition>,
      product: ModelInvocation<Definition>,
    ): Promise<ResolvedExecution>;
    (
      prepared: PreparedToolWork<Definition>,
      product: ToolExecution<Definition>,
    ): Promise<ResolvedExecution>;
  };
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
  readonly createRun: (agent: AgentReference, input: CreateRunInput) => Promise<CreateRunResult>;
  readonly resumeRun: (agent: AgentReference, input: ResumeRunInput) => Promise<ResumeRunResult>;
  readonly steer: (agent: AgentReference, input: SteerInput) => Promise<SteeringResult>;
  readonly redirect: (agent: AgentReference, input: RedirectInput) => Promise<RedirectResult>;
  readonly abort: (agent: AgentReference, runId: RunId, reason?: JsonValue) => Promise<AbortResult>;
  readonly execute: <Definition extends AgentDefinition>(
    agent: Definition,
    runId: RunId,
    dynamicHooks: readonly HookDefinition[],
  ) => Promise<Execution>;
  readonly readRunSnapshot: (
    agent: AgentReference,
    runId: RunId,
  ) => Promise<RunSnapshot | undefined>;
  readonly readResult: (agent: AgentReference, runId: RunId) => Promise<RunResult | undefined>;
}
