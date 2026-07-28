import {
  contributionsOf,
  createFragment,
  type AgentFragment,
  type EmptyFragmentMetadata,
} from "./fragment.js";
import type { RunIdentity } from "./identity.js";
import type { ModelEvent, ModelRequest } from "./protocol.js";
import type { ExecutionEvent, ExecutionResult, ModelInvocation } from "./runtime.js";
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
  afterModelInvocation: point<
    "afterModelInvocation",
    AfterModelInvocationEvent,
    ModelRetryInstruction | HookBlock | undefined
  >("afterModelInvocation", "decision"),
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
  afterModelInvocation(
    handler: (
      event: AfterModelInvocationEvent,
    ) => MaybePromise<ModelRetryInstruction | HookBlock | undefined>,
  ): HookFragment {
    return hook(HookPoints.afterModelInvocation, handler);
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
