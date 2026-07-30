import type { Agent, AgentDefinition } from "./agent.js";
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
import type { Tool } from "./tool.js";
import type { AgentRunId, MaybePromise, ToolCallId } from "./types.js";

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
export interface HookFragment<
  Point extends HookPoint<string, unknown, unknown> = HookPoint<string, unknown, unknown>,
> extends AgentFragment<EmptyFragmentMetadata> {
  readonly [hookFragmentType]: Point;
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

type AgentFailure<Definition extends AgentDefinition> =
  | Tool.Failure<Agent.Tools<Definition>>
  | HookBlockedFailure
  | ModelFailure;

type AgentExecutionResult<Definition extends AgentDefinition> = ExecutionResult<
  AgentFailure<Definition>,
  Agent.Tools<Definition>,
  AgentRunId<Definition>
>;

/** One core Hook Point specialized from an Agent's installed contracts. */
export type AgentHookPoint<
  Definition extends AgentDefinition,
  Point extends HookPoint<string, unknown, unknown>,
> = Point extends typeof HookPoints.onExecutionEvent
  ? HookPoint<
      "onExecutionEvent",
      ExecutionEventNotification<ExecutionEvent<Agent.Tools<Definition>>>,
      undefined
    >
  : Point extends typeof HookPoints.onSettlement
    ? HookPoint<"onSettlement", SettlementNotification<AgentExecutionResult<Definition>>, undefined>
    : Point extends typeof HookPoints.beforeSettlement
      ? HookPoint<
          "beforeSettlement",
          BeforeSettlementEvent<AgentExecutionResult<Definition>>,
          SettlementContinuation | undefined
        >
      : Point;

/** The Agent-specialized event accepted by one core Hook Point. */
export type AgentHookEvent<
  Definition extends AgentDefinition,
  Point extends HookPoint<string, unknown, unknown>,
> = HookEvent<AgentHookPoint<Definition, Point>>;

/** The Agent-specialized result accepted by one core Hook Point. */
export type AgentHookResult<
  Definition extends AgentDefinition,
  Point extends HookPoint<string, unknown, unknown>,
> = HookResult<AgentHookPoint<Definition, Point>>;

function hook<Point extends HookPoint<string, unknown, unknown>>(
  hookPoint: Point,
  handler: (event: HookEvent<Point>) => MaybePromise<HookResult<Point>>,
): HookFragment<Point> {
  return createFragment<EmptyFragmentMetadata>([
    {
      kind: "hook",
      id: hookPoint.name,
      contract: { point: hookPoint.name },
      value: Object.freeze({ point: hookPoint, handler }),
    },
  ]) as HookFragment<Point>;
}

/** Return the one internal definition carried by an opaque Hook Fragment. */
export function hookDefinitionOf<Point extends HookPoint<string, unknown, unknown>>(
  fragment: HookFragment<Point>,
): HookDefinition<Point> {
  const contributions = contributionsOf(fragment);
  if (contributions.length !== 1 || contributions[0]?.kind !== "hook") {
    throw new TypeError("Expected a Hook created by Commissary");
  }
  return contributions[0].value as HookDefinition<Point>;
}

/** Constructors and helpers for closed typed Hooks. */
export const Hook = {
  on<Point extends HookPoint<string, unknown, unknown>>(
    hookPoint: Point,
    handler: (event: HookEvent<Point>) => MaybePromise<HookResult<Point>>,
  ): HookFragment<Point> {
    return hook(hookPoint, handler);
  },
  beforeModelRequest(
    handler: (
      event: BeforeModelRequestEvent,
    ) => MaybePromise<{ readonly request?: ModelRequest } | HookBlock | undefined>,
  ): HookFragment<typeof HookPoints.beforeModelRequest> {
    return hook(HookPoints.beforeModelRequest, handler);
  },
  beforeToolExecution(
    handler: (
      event: BeforeToolExecutionEvent,
    ) => MaybePromise<{ readonly input?: unknown } | HookBlock | undefined>,
  ): HookFragment<typeof HookPoints.beforeToolExecution> {
    return hook(HookPoints.beforeToolExecution, handler);
  },
  transformModelEvent(
    handler: (
      event: TransformModelEventEvent,
    ) => MaybePromise<{ readonly event?: ModelEvent } | HookBlock | undefined>,
  ): HookFragment<typeof HookPoints.transformModelEvent> {
    return hook(HookPoints.transformModelEvent, handler);
  },
  afterModelInvocation(
    handler: (
      event: AfterModelInvocationEvent,
    ) => MaybePromise<ModelInvocationReplacement | ModelRetryInstruction | HookBlock | undefined>,
  ): HookFragment<typeof HookPoints.afterModelInvocation> {
    return hook(HookPoints.afterModelInvocation, handler);
  },
  afterToolExecution(
    handler: (
      event: AfterToolExecutionEvent,
    ) => MaybePromise<{ readonly result: CompletedToolCallResult } | HookBlock | undefined>,
  ): HookFragment<typeof HookPoints.afterToolExecution> {
    return hook(HookPoints.afterToolExecution, handler);
  },
  beforeSettlement(
    handler: (event: BeforeSettlementEvent) => MaybePromise<SettlementContinuation | undefined>,
  ): HookFragment<typeof HookPoints.beforeSettlement> {
    return hook(HookPoints.beforeSettlement, handler);
  },
  onModelEvent(
    handler: (event: ModelEventNotification) => MaybePromise<undefined>,
  ): HookFragment<typeof HookPoints.onModelEvent> {
    return hook(HookPoints.onModelEvent, handler);
  },
  onExecutionEvent(
    handler: (event: ExecutionEventNotification) => MaybePromise<undefined>,
  ): HookFragment<typeof HookPoints.onExecutionEvent> {
    return hook(HookPoints.onExecutionEvent, handler);
  },
  onSettlement(
    handler: (event: SettlementNotification) => MaybePromise<undefined>,
  ): HookFragment<typeof HookPoints.onSettlement> {
    return hook(HookPoints.onSettlement, handler);
  },
  block<const Failure>(failure: Failure): HookBlock<Failure> {
    return Object.freeze({ type: "block", failure });
  },
};

/** Agent-specialized Hook constructors used by static Agent definitions. */
export type AgentHookBuilder<Definition extends AgentDefinition> = Omit<
  typeof Hook,
  "on" | "beforeSettlement" | "onExecutionEvent" | "onSettlement"
> & {
  readonly on: <Point extends HookPoint<string, unknown, unknown>>(
    point: Point,
    handler: (
      event: AgentHookEvent<Definition, Point>,
    ) => MaybePromise<AgentHookResult<Definition, Point>>,
  ) => HookFragment<AgentHookPoint<Definition, Point>>;
  readonly beforeSettlement: (
    handler: (
      event: AgentHookEvent<Definition, typeof HookPoints.beforeSettlement>,
    ) => MaybePromise<AgentHookResult<Definition, typeof HookPoints.beforeSettlement>>,
  ) => HookFragment<AgentHookPoint<Definition, typeof HookPoints.beforeSettlement>>;
  readonly onExecutionEvent: (
    handler: (
      event: AgentHookEvent<Definition, typeof HookPoints.onExecutionEvent>,
    ) => MaybePromise<undefined>,
  ) => HookFragment<AgentHookPoint<Definition, typeof HookPoints.onExecutionEvent>>;
  readonly onSettlement: (
    handler: (
      event: AgentHookEvent<Definition, typeof HookPoints.onSettlement>,
    ) => MaybePromise<undefined>,
  ) => HookFragment<AgentHookPoint<Definition, typeof HookPoints.onSettlement>>;
};

/** Create Agent-specialized Hook constructors without a second Hook engine. */
export function hooksForAgent<Definition extends AgentDefinition>(): AgentHookBuilder<Definition> {
  const on = <Point extends HookPoint<string, unknown, unknown>>(
    point: Point,
    handler: (
      event: AgentHookEvent<Definition, Point>,
    ) => MaybePromise<AgentHookResult<Definition, Point>>,
  ): HookFragment<AgentHookPoint<Definition, Point>> => {
    // SAFETY: AgentHookPoint changes only process-local event/result types for this installed Agent.
    return hook(point, handler as never) as HookFragment<AgentHookPoint<Definition, Point>>;
  };
  return Object.freeze({
    ...Hook,
    on,
    beforeSettlement: (
      handler: (
        event: AgentHookEvent<Definition, typeof HookPoints.beforeSettlement>,
      ) => MaybePromise<AgentHookResult<Definition, typeof HookPoints.beforeSettlement>>,
    ) => on(HookPoints.beforeSettlement, handler),
    onExecutionEvent: (
      handler: (
        event: AgentHookEvent<Definition, typeof HookPoints.onExecutionEvent>,
      ) => MaybePromise<undefined>,
    ) => on(HookPoints.onExecutionEvent, handler),
    onSettlement: (
      handler: (
        event: AgentHookEvent<Definition, typeof HookPoints.onSettlement>,
      ) => MaybePromise<undefined>,
    ) => on(HookPoints.onSettlement, handler),
  });
}

/** Create one dynamic Agent-specialized Hook definition. */
export function agentHookDefinition<
  Definition extends AgentDefinition,
  Point extends HookPoint<string, unknown, unknown>,
>(
  point: Point,
  handler: (
    event: AgentHookEvent<Definition, Point>,
  ) => MaybePromise<AgentHookResult<Definition, Point>>,
): HookDefinition {
  // SAFETY: Runtime dispatches the canonical Point; the bound client supplies the Agent specialization.
  return Object.freeze({ point, handler }) as HookDefinition;
}
