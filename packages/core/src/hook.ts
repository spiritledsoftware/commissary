import {
  contributionsOf,
  createFragment,
  type AgentFragment,
  type EmptyFragmentMetadata,
} from "./fragment.js";
import type { RunIdentity } from "./identity.js";
import type {
  ModelEvent,
  ModelFailure,
  ModelInterruption,
  ModelMessage,
  ModelRequest,
  ModelResponse,
} from "./protocol.js";
import type {
  ExecutionEvent,
  ExecutionResult,
  ModelInvocation,
  ToolCallResult,
} from "./runtime.js";
import type { MaybePromise, ToolCallId } from "./types.js";

const hookPointType: unique symbol = Symbol("commissary.hook.point");
const hookFragmentType: unique symbol = Symbol("commissary.hook.fragment");

/** A declared policy result that stops the current phase. */
export interface HookBlock<Failure = unknown> {
  readonly type: "block";
  readonly failure: Failure;
}

/** The durable Failure produced when a policy Hook blocks work. */
export interface HookBlockedFailure {
  readonly type: "hook-blocked";
  readonly point: string;
  readonly failure: unknown;
}

/** A closed typed Hook Point. */
export interface HookPoint<Name extends string, Event, Result> {
  readonly name: Name;
  readonly kind: "transform" | "decision" | "notification";
  readonly [hookPointType]: {
    readonly event: Event;
    readonly result: Result;
  };
}

/** An installed or dynamically subscribed Hook handler. */
export interface HookDefinition<
  Point extends HookPoint<string, unknown, unknown> = HookPoint<string, unknown, unknown>,
> {
  readonly point: Point;
  readonly handler: (event: HookEvent<Point>) => MaybePromise<HookResult<Point>>;
}

/** An opaque Agent Fragment that contains exactly one Hook. */
export interface HookFragment extends AgentFragment<EmptyFragmentMetadata> {
  readonly [hookFragmentType]: true;
}

/** The event type accepted by one Hook Point. */
export type HookEvent<Point> =
  Point extends HookPoint<string, infer Event, unknown> ? Event : never;

/** The result type accepted by one Hook Point. */
export type HookResult<Point> =
  Point extends HookPoint<string, unknown, infer Result> ? Result : never;

/** Input to a Model request transformation Hook. */
export interface BeforeModelRequestEvent {
  readonly run: RunIdentity;
  readonly request: ModelRequest;
  readonly signal: AbortSignal;
}

/** Input to the one-time effective Tool input transformation Hook. */
export interface BeforeToolExecutionEvent {
  readonly run: RunIdentity;
  readonly toolName: string;
  readonly toolCallId: ToolCallId;
  readonly input: unknown;
  readonly signal: AbortSignal;
}

/** Input to the Model invocation decision point. */
export interface AfterModelInvocationEvent {
  readonly run: RunIdentity;
  readonly invocation: ModelInvocation;
  readonly signal: AbortSignal;
}

/** Input to one root Model Event transformation. */
export interface TransformModelEventEvent {
  readonly run: RunIdentity;
  readonly event: ModelEvent;
  readonly signal: AbortSignal;
}

/** An unbranded replacement candidate for the root Model result. */
export type ModelInvocationCandidate =
  | { readonly type: "response"; readonly response: ModelResponse }
  | { readonly type: "failure"; readonly failure: ModelFailure }
  | { readonly type: "interruption"; readonly interruption: ModelInterruption };

/** A replacement for the current root Model invocation candidate. */
export interface ModelInvocationReplacement {
  readonly invocation: ModelInvocationCandidate;
}

/** One completed Tool result available to transformation Hooks. */
export type CompletedToolCallResult = Exclude<ToolCallResult, { readonly type: "aborted" }>;

/** Input to the Tool result transformation pipeline. */
export interface AfterToolExecutionEvent {
  readonly run: RunIdentity;
  readonly toolName: string;
  readonly toolCallId: ToolCallId;
  readonly result: CompletedToolCallResult;
  readonly signal: AbortSignal;
}

/** Input to the durable Run settlement gate. */
export interface BeforeSettlementEvent<Result = ExecutionResult> {
  readonly run: RunIdentity;
  readonly result: Result;
  readonly signal: AbortSignal;
}

/** One canonical instruction that continues the current Run. */
export interface SettlementContinuation {
  readonly type: "continue";
  readonly instruction: ModelMessage;
}

/** A retry instruction for one declared Model Interruption. */
export interface ModelRetryInstruction {
  readonly type: "retry";
  readonly delayMs?: number;
}

/** Notification for one canonical Model Event. */
export interface ModelEventNotification {
  readonly run: RunIdentity;
  readonly event: ModelEvent;
}

/** Notification for one canonical Execution Event. */
export interface ExecutionEventNotification<Event = ExecutionEvent> {
  readonly run: RunIdentity;
  readonly event: Event;
}

/** Notification after one Execution settles. */
export interface SettlementNotification<Result = ExecutionResult> {
  readonly run: RunIdentity;
  readonly result: Result;
}

function point<const Name extends string, Event, Result>(
  name: Name,
  kind: HookPoint<Name, Event, Result>["kind"],
): HookPoint<Name, Event, Result> {
  return Object.freeze({ name, kind }) as HookPoint<Name, Event, Result>;
}

/** The closed set of Hook Points owned by core. */
export const HookPoints = Object.freeze({
  beforeModelRequest: point<
    "beforeModelRequest",
    BeforeModelRequestEvent,
    { readonly request?: ModelRequest } | HookBlock | undefined
  >("beforeModelRequest", "transform"),
  beforeToolExecution: point<
    "beforeToolExecution",
    BeforeToolExecutionEvent,
    { readonly input?: unknown } | HookBlock | undefined
  >("beforeToolExecution", "transform"),
  transformModelEvent: point<
    "transformModelEvent",
    TransformModelEventEvent,
    { readonly event?: ModelEvent } | HookBlock | undefined
  >("transformModelEvent", "transform"),
  afterModelInvocation: point<
    "afterModelInvocation",
    AfterModelInvocationEvent,
    ModelInvocationReplacement | ModelRetryInstruction | HookBlock | undefined
  >("afterModelInvocation", "decision"),
  afterToolExecution: point<
    "afterToolExecution",
    AfterToolExecutionEvent,
    { readonly result: CompletedToolCallResult } | HookBlock | undefined
  >("afterToolExecution", "transform"),
  beforeSettlement: point<
    "beforeSettlement",
    BeforeSettlementEvent,
    SettlementContinuation | undefined
  >("beforeSettlement", "decision"),
  onModelEvent: point<"onModelEvent", ModelEventNotification, undefined>(
    "onModelEvent",
    "notification",
  ),
  onExecutionEvent: point<"onExecutionEvent", ExecutionEventNotification, undefined>(
    "onExecutionEvent",
    "notification",
  ),
  onSettlement: point<"onSettlement", SettlementNotification, undefined>(
    "onSettlement",
    "notification",
  ),
});

function hook<Point extends HookPoint<string, unknown, unknown>>(
  hookPoint: Point,
  handler: (event: HookEvent<Point>) => MaybePromise<HookResult<Point>>,
): HookFragment {
  return createFragment<EmptyFragmentMetadata>([
    {
      kind: "hook",
      id: hookPoint.name,
      contract: { point: hookPoint.name },
      value: Object.freeze({ point: hookPoint, handler }),
    },
  ]) as HookFragment;
}

/** Return the one internal definition carried by an opaque Hook Fragment. */
export function hookDefinitionOf(fragment: HookFragment): HookDefinition {
  const contributions = contributionsOf(fragment);
  if (contributions.length !== 1 || contributions[0]?.kind !== "hook") {
    throw new TypeError("Expected a Hook created by Commissary");
  }
  return contributions[0].value as HookDefinition;
}

/** Constructors and helpers for closed typed Hooks. */
export const Hook = {
  on<Point extends HookPoint<string, unknown, unknown>>(
    hookPoint: Point,
    handler: (event: HookEvent<Point>) => MaybePromise<HookResult<Point>>,
  ): HookFragment {
    return hook(hookPoint, handler);
  },
  beforeModelRequest(
    handler: (
      event: BeforeModelRequestEvent,
    ) => MaybePromise<{ readonly request?: ModelRequest } | HookBlock | undefined>,
  ): HookFragment {
    return hook(HookPoints.beforeModelRequest, handler);
  },
  beforeToolExecution(
    handler: (
      event: BeforeToolExecutionEvent,
    ) => MaybePromise<{ readonly input?: unknown } | HookBlock | undefined>,
  ): HookFragment {
    return hook(HookPoints.beforeToolExecution, handler);
  },
  transformModelEvent(
    handler: (
      event: TransformModelEventEvent,
    ) => MaybePromise<{ readonly event?: ModelEvent } | HookBlock | undefined>,
  ): HookFragment {
    return hook(HookPoints.transformModelEvent, handler);
  },
  afterModelInvocation(
    handler: (
      event: AfterModelInvocationEvent,
    ) => MaybePromise<ModelInvocationReplacement | ModelRetryInstruction | HookBlock | undefined>,
  ): HookFragment {
    return hook(HookPoints.afterModelInvocation, handler);
  },
  afterToolExecution(
    handler: (
      event: AfterToolExecutionEvent,
    ) => MaybePromise<{ readonly result: CompletedToolCallResult } | HookBlock | undefined>,
  ): HookFragment {
    return hook(HookPoints.afterToolExecution, handler);
  },
  beforeSettlement(
    handler: (event: BeforeSettlementEvent) => MaybePromise<SettlementContinuation | undefined>,
  ): HookFragment {
    return hook(HookPoints.beforeSettlement, handler);
  },
  onModelEvent(handler: (event: ModelEventNotification) => MaybePromise<undefined>): HookFragment {
    return hook(HookPoints.onModelEvent, handler);
  },
  onExecutionEvent(
    handler: (event: ExecutionEventNotification) => MaybePromise<undefined>,
  ): HookFragment {
    return hook(HookPoints.onExecutionEvent, handler);
  },
  onSettlement(handler: (event: SettlementNotification) => MaybePromise<undefined>): HookFragment {
    return hook(HookPoints.onSettlement, handler);
  },
  block<const Failure>(failure: Failure): HookBlock<Failure> {
    return Object.freeze({ type: "block", failure });
  },
};
