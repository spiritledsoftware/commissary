import { createFragment, type AgentFragment, type EmptyFragmentMetadata } from "./fragment.js";
import type { RunIdentity } from "./identity.js";
import type { ModelEvent, ModelRequest } from "./protocol.js";
import type { MaybePromise } from "./types.js";

const hookPointType: unique symbol = Symbol("commissary.hook.point");

export interface HookBlock<Failure = unknown> {
  readonly type: "block";
  readonly failure: Failure;
}

export interface HookBlockedFailure {
  readonly type: "hook-blocked";
  readonly point: string;
  readonly failure: unknown;
}

export interface HookPoint<Name extends string, Event, Result> {
  readonly name: Name;
  readonly [hookPointType]: {
    readonly event: Event;
    readonly result: Result;
  };
}

type HookEvent<Point> = Point extends HookPoint<string, infer Event, unknown> ? Event : never;
type HookResult<Point> = Point extends HookPoint<string, unknown, infer Result> ? Result : never;

export interface BeforeModelRequestEvent {
  readonly run: RunIdentity;
  readonly request: ModelRequest;
  readonly signal: AbortSignal;
}

export interface BeforeToolExecutionEvent {
  readonly run: RunIdentity;
  readonly toolName: string;
  readonly input: unknown;
  readonly signal: AbortSignal;
}

export interface ModelEventNotification {
  readonly run: RunIdentity;
  readonly event: ModelEvent;
}

export interface SignalNotification<Signal = unknown> {
  readonly run: RunIdentity;
  readonly signal: Signal;
}

export interface SettlementNotification<Outcome = unknown> {
  readonly run: RunIdentity;
  readonly outcome: Outcome;
}

function point<const Name extends string, Event, Result>(
  name: Name,
): HookPoint<Name, Event, Result> {
  return Object.freeze({ name }) as HookPoint<Name, Event, Result>;
}

export const HookPoints = Object.freeze({
  beforeModelRequest: point<
    "beforeModelRequest",
    BeforeModelRequestEvent,
    { readonly request?: ModelRequest } | HookBlock | undefined
  >("beforeModelRequest"),
  beforeToolExecution: point<
    "beforeToolExecution",
    BeforeToolExecutionEvent,
    { readonly input?: unknown } | HookBlock | undefined
  >("beforeToolExecution"),
  onModelEvent: point<"onModelEvent", ModelEventNotification, undefined>("onModelEvent"),
  onSignal: point<"onSignal", SignalNotification, undefined>("onSignal"),
  onSettlement: point<"onSettlement", SettlementNotification, undefined>("onSettlement"),
});

function hook<Point extends HookPoint<string, unknown, unknown>>(
  point: Point,
  handler: (event: HookEvent<Point>) => MaybePromise<HookResult<Point>>,
): AgentFragment<EmptyFragmentMetadata> {
  return createFragment<EmptyFragmentMetadata>([
    {
      kind: "hook",
      id: point.name,
      contract: { point: point.name },
      value: Object.freeze({ point, handler }),
    },
  ]);
}

export const Hook = {
  on<Point extends HookPoint<string, unknown, unknown>>(
    point: Point,
    handler: (event: HookEvent<Point>) => MaybePromise<HookResult<Point>>,
  ): AgentFragment<EmptyFragmentMetadata> {
    return hook(point, handler);
  },
  beforeModelRequest(
    handler: (
      event: BeforeModelRequestEvent,
    ) => MaybePromise<{ readonly request?: ModelRequest } | HookBlock | undefined>,
  ): AgentFragment<EmptyFragmentMetadata> {
    return hook(HookPoints.beforeModelRequest, handler);
  },
  beforeToolExecution(
    handler: (
      event: BeforeToolExecutionEvent,
    ) => MaybePromise<{ readonly input?: unknown } | HookBlock | undefined>,
  ): AgentFragment<EmptyFragmentMetadata> {
    return hook(HookPoints.beforeToolExecution, handler);
  },
  onModelEvent(
    handler: (event: ModelEventNotification) => MaybePromise<undefined>,
  ): AgentFragment<EmptyFragmentMetadata> {
    return hook(HookPoints.onModelEvent, handler);
  },
  onSignal(
    handler: (event: SignalNotification) => MaybePromise<undefined>,
  ): AgentFragment<EmptyFragmentMetadata> {
    return hook(HookPoints.onSignal, handler);
  },
  onSettlement(
    handler: (event: SettlementNotification) => MaybePromise<undefined>,
  ): AgentFragment<EmptyFragmentMetadata> {
    return hook(HookPoints.onSettlement, handler);
  },
  block<const Failure>(failure: Failure): HookBlock<Failure> {
    return Object.freeze({ type: "block", failure });
  },
};
