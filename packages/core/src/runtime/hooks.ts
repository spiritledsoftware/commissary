import type { Contribution } from "../fragment.js";
import type {
  CompletedToolCallResult,
  HookBlock,
  HookDefinition,
  ModelInvocationCandidate,
  SettlementContinuation,
} from "../hook.js";
import { HookPoints } from "../hook.js";
import type { RunIdentity } from "../identity.js";
import type { ModelEvent, ModelMessage, ModelRequest } from "../protocol.js";
import type { Clock, ModelInvocation, RunResult, SuspendedRunResult } from "../runtime.js";
import { UnexpectedExecutionError } from "../runtime.js";
import type { StoredToolCall } from "../store.js";
import { stableJson } from "../types.js";
import { HookBlockedExecution, RuntimeInvariantError } from "./execution-signals.js";
import {
  hookResultObject,
  isModelMessage,
  isModelRequest,
  malformedHookResult,
  parseModelEvent,
  parseModelInvocationCandidate,
  requireJson,
} from "./protocol-parsing.js";

/** The name of one core Hook Point. */
export type HookPointName = keyof typeof HookPoints;

/** An isolated notification Hook failure. */
export type HookObserverFailure = (cause: unknown, failedHook: HookDefinition) => Promise<void>;

/** Runtime operations for installed Hooks in one Execution. */
export interface HookRuntime {
  readonly hooksAt: (pointName: HookPointName) => readonly HookDefinition[];
  readonly notify: (
    pointName: HookPointName,
    event: unknown,
    onFailure?: HookObserverFailure,
    skippedHook?: HookDefinition,
  ) => Promise<void>;
  readonly transformModelRequest: (
    request: ModelRequest,
    signal: AbortSignal,
  ) => Promise<ModelRequest>;
  readonly transformModelEvent: (
    event: ModelEvent,
    signal: AbortSignal,
  ) => Promise<ModelEvent | undefined>;
  readonly transformToolInput: (call: StoredToolCall, signal: AbortSignal) => Promise<unknown>;
  readonly afterModelInvocation: (
    invocation: ModelInvocation,
    signal: AbortSignal,
  ) => Promise<
    | { readonly type: "continue"; readonly invocation: ModelInvocation }
    | { readonly type: "retry"; readonly delayMs?: number }
  >;
  readonly transformCompletedToolResult: (
    call: StoredToolCall,
    result: CompletedToolCallResult,
    parseResult: (value: unknown) => Promise<CompletedToolCallResult>,
    signal: AbortSignal,
  ) => Promise<CompletedToolCallResult>;
  readonly beforeSettlement: (
    result: Exclude<RunResult, SuspendedRunResult>,
    options: {
      readonly signal: AbortSignal;
      readonly clock: Clock;
      readonly assertActive: () => void;
      readonly emitError: (error: UnexpectedExecutionError) => Promise<void>;
    },
  ) => Promise<ModelMessage | undefined>;
}

function isHookPointName(value: string): value is HookPointName {
  return Object.hasOwn(HookPoints, value);
}

function indexHooks(
  hooks: readonly HookDefinition[],
): ReadonlyMap<HookPointName, readonly HookDefinition[]> {
  const grouped = new Map<HookPointName, HookDefinition[]>();
  for (const hook of hooks) {
    const pointName = hook.point.name;
    if (!isHookPointName(pointName)) {
      throw new RuntimeInvariantError(`Unknown Hook Point '${pointName}'`);
    }
    const pointHooks = grouped.get(pointName);
    if (pointHooks === undefined) {
      grouped.set(pointName, [hook]);
    } else {
      pointHooks.push(hook);
    }
  }
  const indexed = new Map<HookPointName, readonly HookDefinition[]>();
  for (const [pointName, pointHooks] of grouped) {
    indexed.set(pointName, Object.freeze(pointHooks));
  }
  return indexed;
}

/** Read static Hook definitions from installed contributions. */
export function staticHooks(contributions: readonly Contribution[]): readonly HookDefinition[] {
  // SAFETY: The Hook contribution discriminant selects installed Hook definitions.
  return contributions
    .filter((contribution) => contribution.kind === "hook")
    .map((contribution) => contribution.value) as readonly HookDefinition[];
}

/** Create the Hook runtime for one Execution. */
export function createHookRuntime(
  definitions: readonly HookDefinition[],
  getRun: () => RunIdentity,
): HookRuntime {
  const hooksByPoint = indexHooks(definitions);
  const noHooks: readonly HookDefinition[] = Object.freeze([]);
  const hooksAt = (pointName: HookPointName): readonly HookDefinition[] =>
    hooksByPoint.get(pointName) ?? noHooks;

  const notify = async (
    pointName: HookPointName,
    event: unknown,
    onFailure?: HookObserverFailure,
    skippedHook?: HookDefinition,
  ): Promise<void> => {
    for (const hook of hooksAt(pointName)) {
      if (hook === skippedHook) {
        continue;
      }
      try {
        const result = await hook.handler(event);
        if (result !== undefined) {
          throw new TypeError(`Notification Hook '${pointName}' must return undefined`);
        }
      } catch (cause) {
        await onFailure?.(cause, hook);
      }
    }
  };

  const transformModelRequest = async (
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelRequest> => {
    let current = request;
    const availableTools = new Map(
      request.tools.map(
        (tool) =>
          [tool.name, stableJson(requireJson(tool, `Installed Tool '${tool.name}'`))] as const,
      ),
    );
    for (const hook of hooksAt("beforeModelRequest")) {
      let result: { readonly request?: ModelRequest } | HookBlock | undefined;
      try {
        // SAFETY: Hook Point definitions fix the handler result type for this pipeline.
        result = (await hook.handler({
          run: getRun(),
          request: current,
          signal,
        })) as typeof result;
      } catch (cause) {
        throw new UnexpectedExecutionError("hook", cause);
      }
      const object = hookResultObject("beforeModelRequest", result);
      if (object === undefined) {
        continue;
      }
      if ("type" in object) {
        if (
          object.type !== "block" ||
          !("failure" in object) ||
          Object.keys(object).some((key) => key !== "type" && key !== "failure")
        ) {
          return malformedHookResult("beforeModelRequest", "an invalid block result");
        }
        throw new HookBlockedExecution("beforeModelRequest", object.failure);
      }
      if (Object.keys(object).some((key) => key !== "request")) {
        return malformedHookResult("beforeModelRequest", "an invalid request patch");
      }
      if ("request" in object && object.request !== undefined) {
        if (!isModelRequest(object.request)) {
          return malformedHookResult("beforeModelRequest", "an invalid request patch");
        }
        try {
          requireJson(object.request, "Transformed Model Request");
        } catch {
          return malformedHookResult("beforeModelRequest", "a non-JSON request patch");
        }
        const names = new Set<string>();
        for (const tool of object.request.tools) {
          if (
            typeof tool !== "object" ||
            tool === null ||
            Array.isArray(tool) ||
            typeof tool.name !== "string" ||
            names.has(tool.name) ||
            availableTools.get(tool.name) !==
              stableJson(requireJson(tool, `Transformed Tool '${tool.name}'`))
          ) {
            return malformedHookResult(
              "beforeModelRequest",
              "a request patch that adds or changes a Tool",
            );
          }
          names.add(tool.name);
        }
        current = object.request;
      }
    }
    return current;
  };

  const transformModelEvent = async (
    event: ModelEvent,
    signal: AbortSignal,
  ): Promise<ModelEvent | undefined> => {
    let current: ModelEvent | undefined = event;
    for (const hook of hooksAt("transformModelEvent")) {
      if (current === undefined) {
        continue;
      }
      let result: { readonly event?: ModelEvent } | HookBlock | undefined;
      try {
        // SAFETY: Hook Point definitions fix the handler result type for this pipeline.
        result = (await hook.handler({
          run: getRun(),
          event: current,
          signal,
        })) as typeof result;
      } catch (cause) {
        throw new UnexpectedExecutionError("hook", cause);
      }
      const object = hookResultObject("transformModelEvent", result);
      if (object === undefined) {
        continue;
      }
      if ("type" in object) {
        if (
          object.type !== "block" ||
          !("failure" in object) ||
          Object.keys(object).some((key) => key !== "type" && key !== "failure")
        ) {
          return malformedHookResult("transformModelEvent", "an invalid block result");
        }
        throw new HookBlockedExecution("transformModelEvent", object.failure);
      }
      if (!("event" in object) || Object.keys(object).some((key) => key !== "event")) {
        return malformedHookResult("transformModelEvent", "an invalid Event patch");
      }
      current =
        object.event === undefined
          ? undefined
          : parseModelEvent(object.event, "transformModelEvent");
    }
    return current;
  };

  const transformToolInput = async (
    call: StoredToolCall,
    signal: AbortSignal,
  ): Promise<unknown> => {
    let current: unknown = call.requestedInput;
    for (const hook of hooksAt("beforeToolExecution")) {
      let result: { readonly input?: unknown } | HookBlock | undefined;
      try {
        // SAFETY: Hook Point definitions fix the handler result type for this pipeline.
        result = (await hook.handler({
          run: getRun(),
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          input: current,
          signal,
        })) as typeof result;
      } catch (cause) {
        throw new UnexpectedExecutionError("hook", cause);
      }
      const object = hookResultObject("beforeToolExecution", result);
      if (object === undefined) {
        continue;
      }
      if ("type" in object) {
        if (
          object.type !== "block" ||
          !("failure" in object) ||
          Object.keys(object).some((key) => key !== "type" && key !== "failure")
        ) {
          return malformedHookResult("beforeToolExecution", "an invalid block result");
        }
        throw new HookBlockedExecution("beforeToolExecution", object.failure);
      }
      if (Object.keys(object).some((key) => key !== "input")) {
        return malformedHookResult("beforeToolExecution", "an invalid input patch");
      }
      if ("input" in object) {
        current = object.input;
      }
    }
    return current;
  };

  const afterModelInvocation = async (
    invocation: ModelInvocation,
    signal: AbortSignal,
  ): Promise<
    | { readonly type: "continue"; readonly invocation: ModelInvocation }
    | { readonly type: "retry"; readonly delayMs?: number }
  > => {
    let current = invocation;
    for (const hook of hooksAt("afterModelInvocation")) {
      let result:
        | { readonly invocation: ModelInvocationCandidate }
        | { readonly type: "retry"; readonly delayMs?: number }
        | HookBlock
        | undefined;
      try {
        // SAFETY: Hook Point definitions fix the handler result type for this pipeline.
        result = (await hook.handler({
          run: getRun(),
          invocation: current,
          signal,
        })) as typeof result;
      } catch (cause) {
        throw new UnexpectedExecutionError("hook", cause);
      }
      const object = hookResultObject("afterModelInvocation", result);
      if (object === undefined) {
        continue;
      }
      if ("invocation" in object) {
        if (Object.keys(object).some((key) => key !== "invocation")) {
          return malformedHookResult("afterModelInvocation", "an invalid invocation replacement");
        }
        current = parseModelInvocationCandidate(object.invocation, "afterModelInvocation");
        continue;
      }
      if (object.type === "block") {
        if (
          !("failure" in object) ||
          Object.keys(object).some((key) => key !== "type" && key !== "failure")
        ) {
          return malformedHookResult("afterModelInvocation", "an invalid block result");
        }
        throw new HookBlockedExecution("afterModelInvocation", object.failure);
      }
      if (
        object.type !== "retry" ||
        Object.keys(object).some((key) => key !== "type" && key !== "delayMs") ||
        (object.delayMs !== undefined &&
          (typeof object.delayMs !== "number" ||
            !Number.isFinite(object.delayMs) ||
            object.delayMs < 0))
      ) {
        return malformedHookResult("afterModelInvocation", "an invalid retry result");
      }
      if (current.type !== "interruption") {
        throw new RuntimeInvariantError(
          "afterModelInvocation requested a retry for a non-Interruption result",
        );
      }
      // SAFETY: The retry result shape and fields were parsed above.
      return object as { readonly type: "retry"; readonly delayMs?: number };
    }
    return { type: "continue", invocation: current };
  };

  const transformCompletedToolResult = async (
    call: StoredToolCall,
    result: CompletedToolCallResult,
    parseResult: (value: unknown) => Promise<CompletedToolCallResult>,
    signal: AbortSignal,
  ): Promise<CompletedToolCallResult> => {
    let current = result;
    for (const hook of hooksAt("afterToolExecution")) {
      let hookResult: { readonly result: CompletedToolCallResult } | HookBlock | undefined;
      try {
        // SAFETY: Hook Point definitions fix the handler result type for this pipeline.
        hookResult = (await hook.handler({
          run: getRun(),
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          result: current,
          signal,
        })) as typeof hookResult;
      } catch (cause) {
        throw new UnexpectedExecutionError("hook", cause);
      }
      const object = hookResultObject("afterToolExecution", hookResult);
      if (object === undefined) {
        continue;
      }
      if ("type" in object) {
        if (
          object.type !== "block" ||
          !("failure" in object) ||
          Object.keys(object).some((key) => key !== "type" && key !== "failure")
        ) {
          return malformedHookResult("afterToolExecution", "an invalid block result");
        }
        throw new HookBlockedExecution("afterToolExecution", object.failure);
      }
      if (!("result" in object) || Object.keys(object).some((key) => key !== "result")) {
        return malformedHookResult("afterToolExecution", "an invalid result replacement");
      }
      try {
        current = await parseResult(object.result);
      } catch (cause) {
        if (cause instanceof UnexpectedExecutionError) {
          throw cause;
        }
        throw new UnexpectedExecutionError("hook", cause);
      }
    }
    return current;
  };

  const beforeSettlement = async (
    result: Exclude<RunResult, SuspendedRunResult>,
    options: {
      readonly signal: AbortSignal;
      readonly clock: Clock;
      readonly assertActive: () => void;
      readonly emitError: (error: UnexpectedExecutionError) => Promise<void>;
    },
  ): Promise<ModelMessage | undefined> => {
    for (const hook of hooksAt("beforeSettlement")) {
      const deadline = new AbortController();
      const abortDeadline = (): void => {
        deadline.abort(options.signal.reason);
      };
      options.signal.addEventListener("abort", abortDeadline, { once: true });
      const handler = Promise.resolve()
        .then(() =>
          hook.handler({
            run: getRun(),
            result,
            signal: deadline.signal,
          }),
        )
        .then(
          (value) => ({ type: "result" as const, value }),
          (cause: unknown) => ({ type: "failure" as const, cause }),
        );
      const timeout = Promise.resolve(options.clock.sleep(30_000, deadline.signal)).then(
        () => ({ type: "timeout" as const }),
        (cause: unknown) => ({ type: "timer-failure" as const, cause }),
      );
      const outcome = await Promise.race([handler, timeout]);
      options.signal.removeEventListener("abort", abortDeadline);
      if (!deadline.signal.aborted) {
        deadline.abort();
      }
      if (outcome.type === "timeout") {
        await options.emitError(
          new UnexpectedExecutionError(
            "hook",
            new Error("Hook 'beforeSettlement' exceeded its 30000 ms deadline"),
          ),
        );
        continue;
      }
      if (outcome.type === "timer-failure") {
        options.assertActive();
        throw new UnexpectedExecutionError("hook", outcome.cause);
      }
      if (outcome.type === "failure") {
        throw new UnexpectedExecutionError("hook", outcome.cause);
      }
      const object = hookResultObject("beforeSettlement", outcome.value);
      if (object === undefined) {
        continue;
      }
      if (
        object.type !== "continue" ||
        !("instruction" in object) ||
        !isModelMessage(object.instruction) ||
        Object.keys(object).some((key) => key !== "type" && key !== "instruction")
      ) {
        return malformedHookResult("beforeSettlement", "an invalid continuation instruction");
      }
      // SAFETY: The continuation result and instruction were parsed above.
      return (object as unknown as SettlementContinuation).instruction;
    }
    return undefined;
  };

  return Object.freeze({
    hooksAt,
    notify,
    transformModelRequest,
    transformModelEvent,
    transformToolInput,
    afterModelInvocation,
    transformCompletedToolResult,
    beforeSettlement,
  });
}
