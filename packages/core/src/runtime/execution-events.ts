import type { HookDefinition } from "../hook.js";
import type { RunIdentity } from "../identity.js";
import type {
  Clock,
  ExecutionEvent,
  ExecutionEventAppend,
  ExecutionEventStore,
} from "../runtime.js";
import { ExecutionEventStoreError, UnexpectedExecutionError } from "../runtime.js";
import type { ExecutionId, RunId } from "../types.js";
import type { HookPointName, HookRuntime } from "./hooks.js";

/** Operations for ordered Execution Event delivery. */
export interface ExecutionEvents {
  readonly emit: (event: ExecutionEvent) => Promise<void>;
  readonly flush: () => Promise<void>;
  readonly notify: (
    pointName: HookPointName,
    event: unknown,
    reportObserverErrors?: boolean,
  ) => Promise<void>;
}

function modelDelta(
  event: ExecutionEvent,
): { readonly type: "text-delta" | "reasoning-delta"; readonly delta: string } | undefined {
  if (
    event.type !== "model-event" ||
    (event.event.type !== "text-delta" && event.event.type !== "reasoning-delta")
  ) {
    return undefined;
  }
  return event.event;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Create ordered Event delivery for one Execution. */
export function createExecutionEvents(options: {
  readonly runId: RunId;
  readonly executionId: ExecutionId;
  readonly store?: ExecutionEventStore;
  readonly clock: Clock;
  readonly lifecycleSignal: AbortSignal;
  readonly executionController: AbortController;
  readonly hooks: HookRuntime;
  readonly getRun: () => RunIdentity;
}): ExecutionEvents {
  let eventBuffer: ExecutionEventAppend[] = [];
  let bufferedSourceEvents = 0;
  let bufferedBytes = 0;
  let flushScheduled = false;
  let eventStoreFailure: ExecutionEventStoreError | undefined;
  let flushChain = Promise.resolve();

  const failEventStore = (cause: unknown): ExecutionEventStoreError => {
    const error =
      cause instanceof ExecutionEventStoreError ? cause : new ExecutionEventStoreError(cause);
    eventStoreFailure ??= error;
    if (!options.executionController.signal.aborted) {
      options.executionController.abort(error);
    }
    return eventStoreFailure;
  };

  const publishObserverError = async (
    cause: unknown,
    failedHook: HookDefinition,
  ): Promise<void> => {
    const error =
      cause instanceof UnexpectedExecutionError
        ? cause
        : new UnexpectedExecutionError("hook", cause);
    const event: ExecutionEvent = Object.freeze({ type: "error", error });
    if (options.store !== undefined) {
      const record = Object.freeze({
        runId: options.runId,
        executionId: options.executionId,
        event,
      });
      try {
        await options.store.append([record]);
      } catch (appendCause) {
        throw failEventStore(appendCause);
      }
    }
    await options.hooks.notify(
      "onExecutionEvent",
      { run: options.getRun(), event },
      undefined,
      failedHook,
    );
  };

  const notify = (
    pointName: HookPointName,
    event: unknown,
    reportObserverErrors = true,
  ): Promise<void> =>
    options.hooks.notify(pointName, event, reportObserverErrors ? publishObserverError : undefined);

  const observeEvent = async (event: ExecutionEvent): Promise<void> => {
    if (event.type === "model-event") {
      await notify("onModelEvent", { run: options.getRun(), event: event.event });
    }
    await notify("onExecutionEvent", { run: options.getRun(), event }, event.type !== "error");
  };

  const flush = (): Promise<void> => {
    if (eventStoreFailure !== undefined) {
      return Promise.reject(eventStoreFailure);
    }
    if (eventBuffer.length === 0) {
      return flushChain;
    }
    const records = eventBuffer;
    eventBuffer = [];
    bufferedSourceEvents = 0;
    bufferedBytes = 0;
    const operation = flushChain.then(async () => {
      if (options.store !== undefined) {
        // SAFETY: flush returns before append when the batch is empty.
        await options.store.append(records as [ExecutionEventAppend, ...ExecutionEventAppend[]]);
      }
      for (const record of records) {
        await observeEvent(record.event);
      }
    });
    flushChain = operation.catch((cause: unknown) => {
      throw failEventStore(cause);
    });
    return flushChain;
  };

  const scheduleFlush = (): void => {
    if (flushScheduled) {
      return;
    }
    flushScheduled = true;
    void Promise.resolve(options.clock.sleep(16, options.lifecycleSignal))
      .then(() => {
        flushScheduled = false;
        return flush();
      })
      .catch((cause: unknown) => {
        flushScheduled = false;
        if (!options.lifecycleSignal.aborted && !(cause instanceof ExecutionEventStoreError)) {
          failEventStore(cause);
        }
      });
  };

  const emit = async (event: ExecutionEvent): Promise<void> => {
    if (options.store === undefined) {
      await observeEvent(event);
      return;
    }
    if (eventStoreFailure !== undefined) {
      throw eventStoreFailure;
    }

    const delta = modelDelta(event);
    if (delta === undefined) {
      await flush();
      eventBuffer.push(
        Object.freeze({
          runId: options.runId,
          executionId: options.executionId,
          event,
        }),
      );
      bufferedSourceEvents += 1;
      await flush();
      return;
    }

    const previous = eventBuffer.at(-1);
    const previousDelta = previous === undefined ? undefined : modelDelta(previous.event);
    if (previous !== undefined && previousDelta?.type === delta.type) {
      eventBuffer[eventBuffer.length - 1] = Object.freeze({
        ...previous,
        event: Object.freeze({
          type: "model-event" as const,
          event: Object.freeze({
            type: delta.type,
            delta: previousDelta.delta + delta.delta,
          }),
        }),
      });
    } else {
      eventBuffer.push(
        Object.freeze({
          runId: options.runId,
          executionId: options.executionId,
          event,
        }),
      );
    }
    bufferedSourceEvents += 1;
    bufferedBytes += utf8ByteLength(delta.delta);
    if (bufferedSourceEvents >= 64 || bufferedBytes >= 64 * 1024) {
      await flush();
      return;
    }
    scheduleFlush();
  };

  return Object.freeze({ emit, flush, notify });
}
