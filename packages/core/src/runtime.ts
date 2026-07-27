import type { AgentDefinition } from "./agent.js";
import type { AgentReference, RunIdentity } from "./identity.js";
import type {
  ModelEvent,
  ModelMessage,
  ModelResponse,
  ModelUsage,
  ModelFailure,
  ModelInterruption,
  ToolCallContentPart,
} from "./protocol.js";
import type { ThreadStore } from "./store.js";
import type {
  AgentRevision,
  AttemptId,
  BranchId,
  JsonValue,
  MessageEntryId,
  RunId,
  RunRequestId,
  SteeringRequestId,
  ThreadId,
  ToolCallId,
  ToolResumeRequestId,
} from "./types.js";

const preparedRunType: unique symbol = Symbol("commissary.runtime.prepared");
const modelInvocationType: unique symbol = Symbol("commissary.runtime.model");
const toolExecutionType: unique symbol = Symbol("commissary.runtime.tool");

export interface RunAdmission {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly head: MessageEntryId;
  readonly agent: AgentReference;
  readonly admitted: boolean;
}

export type RunAdmissionFailure =
  | {
      readonly type: "branch-conflict";
      readonly expectedHead?: MessageEntryId;
      readonly actualHead?: MessageEntryId;
    }
  | {
      readonly type: "run-request-conflict";
      readonly runRequestId: RunRequestId;
    };

export type AdmitResult = RunAdmission | RunAdmissionFailure;

export interface AdmitInput {
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly message: ModelMessage;
  readonly expectedHead?: MessageEntryId;
  readonly runRequestId?: RunRequestId;
}

export type ResumeResult =
  | { readonly type: "accepted"; readonly runId: RunId; readonly admitted: boolean }
  | { readonly type: "not-suspended"; readonly runId: RunId }
  | {
      readonly type: "tool-resume-request-conflict";
      readonly runId: RunId;
      readonly toolResumeRequestId: ToolResumeRequestId;
    };

export interface ResumeInput<Value = unknown> {
  readonly runId: RunId;
  readonly toolName: string;
  readonly input: Value;
  readonly toolResumeRequestId?: ToolResumeRequestId;
}

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

export interface SteerInput {
  readonly runId: RunId;
  readonly message: ModelMessage;
  readonly steeringRequestId?: SteeringRequestId;
}

export type AbortResult =
  | { readonly type: "accepted"; readonly runId: RunId }
  | { readonly type: "already-resolved"; readonly result: RunResult };

export interface StaleAgentInterruption {
  readonly type: "stale-agent";
  readonly expected: AgentReference;
  readonly installed: AgentReference;
  readonly toolName?: string;
  readonly detail: string;
}

export type Interruption = StaleAgentInterruption | ModelInterruption;

interface RunResultBase {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly head: MessageEntryId;
  readonly agent: AgentReference;
  readonly usage?: ModelUsage;
}

export interface CompletedRunResult extends RunResultBase {
  readonly type: "completed";
  readonly response: ModelResponse;
}

export interface ToolSuspensionRecord<Value = unknown> {
  readonly toolName: string;
  readonly toolCallId: ToolCallId;
  readonly resumeInput: Value;
}

export interface SuspendedRunResult<Suspension = unknown> extends RunResultBase {
  readonly type: "suspended";
  readonly suspension: Suspension;
}

export interface FailedRunResult<Failure = unknown> extends RunResultBase {
  readonly type: "failed";
  readonly failure: Failure;
}

export interface AbortedRunResult extends RunResultBase {
  readonly type: "aborted";
  readonly reason?: JsonValue;
}

export type RunResult<Failure = unknown, Suspension = unknown> =
  | CompletedRunResult
  | SuspendedRunResult<Suspension>
  | FailedRunResult<Failure>
  | AbortedRunResult;

export interface InterruptedAttemptOutcome {
  readonly type: "interrupted";
  readonly runId: RunId;
  readonly interruption: Interruption;
}

export type AttemptOutcome<Failure = unknown, Suspension = unknown> =
  | RunResult<Failure, Suspension>
  | InterruptedAttemptOutcome;

export type CoreSignal =
  | { readonly type: "model-event"; readonly event: ModelEvent }
  | { readonly type: "model-text-delta"; readonly delta: string }
  | {
      readonly type: "tool-started";
      readonly toolName: string;
      readonly toolCallId: ToolCallId;
    }
  | {
      readonly type: "tool-finished";
      readonly toolName: string;
      readonly toolCallId: ToolCallId;
    };

export type Signal<ToolSignal = never> =
  | CoreSignal
  | {
      readonly type: "tool-signal";
      readonly toolName: string;
      readonly value: ToolSignal;
    };

export interface ExecutionAttempt<ToolSignal = never, Failure = unknown, Suspension = unknown> {
  readonly attemptId: AttemptId;
  readonly runId: RunId;
  readonly signals: AsyncIterable<Signal<ToolSignal>>;
  readonly outcome: PromiseLike<AttemptOutcome<Failure, Suspension>>;
  readonly abort: (reason?: JsonValue) => void;
}

export class SignalAlreadyConsumedError extends Error {
  constructor() {
    super("Execution Attempt Signals may be consumed only once");
    this.name = "SignalAlreadyConsumedError";
  }
}

export function singleConsumer<Value>(source: AsyncIterable<Value>): AsyncIterable<Value> {
  let consumed = false;
  return {
    [Symbol.asyncIterator]() {
      if (consumed) {
        throw new SignalAlreadyConsumedError();
      }
      consumed = true;
      return source[Symbol.asyncIterator]();
    },
  };
}

export const Signal = {
  text<ToolSignal>(signals: AsyncIterable<Signal<ToolSignal>>): AsyncIterable<string> {
    return {
      async *[Symbol.asyncIterator]() {
        for await (const signal of signals) {
          if (signal.type === "model-text-delta") {
            yield signal.delta;
          }
        }
      },
    };
  },
};

export const AttemptOutcome = {
  match<Failure, Suspension, Result>(
    outcome: AttemptOutcome<Failure, Suspension>,
    cases: {
      readonly completed: (outcome: CompletedRunResult) => Result;
      readonly suspended: (outcome: SuspendedRunResult<Suspension>) => Result;
      readonly failed: (outcome: FailedRunResult<Failure>) => Result;
      readonly interrupted: (outcome: InterruptedAttemptOutcome) => Result;
      readonly aborted: (outcome: AbortedRunResult) => Result;
    },
  ): Result {
    switch (outcome.type) {
      case "completed":
        return cases.completed(outcome);
      case "suspended":
        return cases.suspended(outcome);
      case "failed":
        return cases.failed(outcome);
      case "interrupted":
        return cases.interrupted(outcome);
      case "aborted":
        return cases.aborted(outcome);
    }
  },
};

export interface PreparedRun<Agent extends AgentDefinition = AgentDefinition> {
  readonly [preparedRunType]: Agent;
  readonly run: RunIdentity;
  readonly transcriptHead: MessageEntryId;
}

export interface ModelResponseInvocation<Agent extends AgentDefinition = AgentDefinition> {
  readonly [modelInvocationType]: Agent;
  readonly type: "response";
  readonly response: ModelResponse;
  readonly toolCalls: readonly ToolCallContentPart[];
}

export interface ModelFailureInvocation<Agent extends AgentDefinition = AgentDefinition> {
  readonly [modelInvocationType]: Agent;
  readonly type: "failure";
  readonly failure: ModelFailure;
}

export type ModelInvocation<Agent extends AgentDefinition = AgentDefinition> =
  | ModelResponseInvocation<Agent>
  | ModelFailureInvocation<Agent>;

export interface ToolExecution<Agent extends AgentDefinition = AgentDefinition> {
  readonly [toolExecutionType]: Agent;
  readonly toolName: string;
  readonly toolCallId: ToolCallId;
}

export type FinalizeDecision<Failure = unknown, Suspension = unknown> =
  | { readonly type: "completed"; readonly response: ModelResponse }
  | { readonly type: "suspended"; readonly suspension: Suspension }
  | { readonly type: "failed"; readonly failure: Failure }
  | { readonly type: "aborted"; readonly reason?: JsonValue };

export interface RuntimeOperations<Agent extends AgentDefinition = AgentDefinition> {
  readonly prepare: (runId: RunId) => Promise<PreparedRun<Agent>>;
  readonly invokeModel: (prepared: PreparedRun<Agent>) => Promise<ModelInvocation<Agent>>;
  readonly executeTool: (
    prepared: PreparedRun<Agent>,
    call: ToolCallContentPart,
  ) => Promise<ToolExecution<Agent>>;
  readonly resumeTool: (prepared: PreparedRun<Agent>) => Promise<ToolExecution<Agent>>;
  readonly finalize: <Failure, Suspension>(
    prepared: PreparedRun<Agent>,
    decision: FinalizeDecision<Failure, Suspension>,
  ) => Promise<RunResult<Failure, Suspension>>;
}

export interface DriverExecutionContext<Agent extends AgentDefinition = AgentDefinition> {
  readonly runId: RunId;
  readonly agent: Agent;
  readonly operations: RuntimeOperations<Agent>;
  readonly signal: AbortSignal;
}

export interface Driver {
  readonly execute: <Agent extends AgentDefinition>(
    context: DriverExecutionContext<Agent>,
  ) => Promise<AttemptOutcome>;
}

export interface Runtime {
  readonly threadStore: ThreadStore;
  readonly admit: (agent: AgentReference, input: AdmitInput) => Promise<AdmitResult>;
  readonly resume: (input: ResumeInput) => Promise<ResumeResult>;
  readonly steer: (input: SteerInput) => Promise<SteeringResult>;
  readonly abort: (runId: RunId, reason?: JsonValue) => Promise<AbortResult>;
  readonly execute: <Agent extends AgentDefinition>(
    agent: Agent,
    runId: RunId,
  ) => Promise<ExecutionAttempt<unknown>>;
  readonly readResult: (runId: RunId) => Promise<RunResult | undefined>;
}

export interface AgentCompatibilityCheck {
  readonly expectedRevision: AgentRevision;
  readonly installedRevision: AgentRevision;
}
