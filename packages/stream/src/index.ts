import {
  Hook,
  type Agent,
  type AgentClient,
  type AgentDefinition,
  type Execution,
  type ExecutionEvent,
  type RunId,
} from "@commissary/core";

type ClientExecution<Definition extends AgentDefinition> = Awaited<
  ReturnType<AgentClient<Definition>["execute"]>
>;
type ClientFailure<Value> = Value extends Execution<unknown, infer Failure> ? Failure : never;

/** Adapter Event that reports discarded core Execution Events. */
export interface EventsDroppedEvent {
  readonly type: "events-dropped";
  readonly count: number;
}

/** One core Execution Event or one adapter loss marker. */
export type StreamEvent<ToolEvent = unknown> = ExecutionEvent<ToolEvent> | EventsDroppedEvent;

/** Options for one bounded process-local Execution stream. */
export interface StreamOptions {
  readonly capacity?: number;
}

/** One core Execution paired with its bounded single-consumer Events. */
export interface StreamExecution<ToolEvent = unknown, Failure = unknown> {
  readonly execution: Execution<ToolEvent, Failure>;
  readonly events: AsyncIterable<StreamEvent<ToolEvent>>;
}

/** An error caused by a second consumer of one adapter stream. */
export class StreamAlreadyConsumedError extends Error {
  constructor() {
    super("Execution Events may be consumed only once");
    this.name = "StreamAlreadyConsumedError";
  }
}

class BoundedEventQueue<Value extends ExecutionEvent> implements AsyncIterable<
  Value | EventsDroppedEvent
> {
  readonly #values: Array<Value | undefined>;
  readonly #waiters: Array<
    ((result: IteratorResult<Value | EventsDroppedEvent>) => void) | undefined
  > = [];
  #valueHead = 0;
  #valueSize = 0;
  #waiterHead = 0;
  #dropped = 0;
  #closed = false;
  #consumed = false;
  #pendingError: Value | undefined;

  constructor(readonly capacity: number) {
    this.#values = [];
    this.#values.length = capacity;
  }

  push(value: Value): void {
    if (this.#closed) {
      return;
    }
    if (value.type === "error") {
      if (this.#pendingError !== undefined) {
        this.#pushNormal(this.#pendingError);
      }
      this.#pendingError = value;
      return;
    }
    if (this.#pendingError !== undefined) {
      this.#pushNormal(this.#pendingError);
      this.#pendingError = undefined;
    }
    this.#pushNormal(value);
  }

  #pushNormal(value: Value): void {
    if (this.#dropped > 0 && this.#hasWaiter()) {
      this.#takeWaiter()({
        done: false,
        value: this.#takeDropped(),
      });
    }
    if (this.#hasWaiter()) {
      this.#takeWaiter()({ done: false, value });
      return;
    }

    const normalCapacity = this.capacity - 1;
    if (normalCapacity === 0) {
      this.#dropped += 1;
      return;
    }
    if (this.#valueSize === normalCapacity) {
      this.#dequeueValue();
      this.#dropped += 1;
    }
    this.#enqueueValue(value);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    if (this.#pendingError !== undefined) {
      this.#pushNormal(this.#pendingError);
      this.#pendingError = undefined;
    }
    this.#closed = true;
    this.#drainClosed();
  }

  closeWithError(value: Value): void {
    if (this.#closed) {
      return;
    }
    if (this.#pendingError !== undefined && this.#pendingError !== value) {
      this.#pushNormal(this.#pendingError);
    }
    this.#pendingError = undefined;
    this.#enqueueTerminal(value);
    this.#closed = true;
    this.#drainClosed();
  }

  [Symbol.asyncIterator](): AsyncIterator<Value | EventsDroppedEvent> {
    if (this.#consumed) {
      throw new StreamAlreadyConsumedError();
    }
    this.#consumed = true;
    return {
      next: () => this.#next(),
    };
  }

  #next(): Promise<IteratorResult<Value | EventsDroppedEvent>> {
    if (this.#dropped > 0) {
      return Promise.resolve({ done: false, value: this.#takeDropped() });
    }
    const value = this.#dequeueValue();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #enqueueTerminal(value: Value): void {
    if (this.#dropped > 0 && this.#hasWaiter()) {
      this.#takeWaiter()({
        done: false,
        value: this.#takeDropped(),
      });
    }
    if (this.#hasWaiter()) {
      this.#takeWaiter()({ done: false, value });
      return;
    }
    this.#enqueueValue(value);
  }

  #enqueueValue(value: Value): void {
    const index = (this.#valueHead + this.#valueSize) % this.#values.length;
    this.#values[index] = value;
    this.#valueSize += 1;
  }

  #dequeueValue(): Value | undefined {
    if (this.#valueSize === 0) {
      return undefined;
    }
    const value = this.#values[this.#valueHead];
    this.#values[this.#valueHead] = undefined;
    this.#valueHead = (this.#valueHead + 1) % this.#values.length;
    this.#valueSize -= 1;
    return value;
  }

  #hasWaiter(): boolean {
    return this.#waiterHead < this.#waiters.length;
  }

  #takeWaiter(): (result: IteratorResult<Value | EventsDroppedEvent>) => void {
    const waiter = this.#waiters[this.#waiterHead];
    if (waiter === undefined) {
      throw new Error("Event queue waiter index is inconsistent");
    }
    this.#waiters[this.#waiterHead] = undefined;
    this.#waiterHead += 1;
    if (this.#waiterHead === this.#waiters.length) {
      this.#waiters.length = 0;
      this.#waiterHead = 0;
    }
    return waiter;
  }

  #takeDropped(): EventsDroppedEvent {
    const event = Object.freeze({
      type: "events-dropped" as const,
      count: this.#dropped,
    });
    this.#dropped = 0;
    return event;
  }

  #drainClosed(): void {
    while (this.#hasWaiter() && this.#dropped > 0) {
      this.#takeWaiter()({ done: false, value: this.#takeDropped() });
    }
    while (this.#hasWaiter() && this.#valueSize > 0) {
      const value = this.#dequeueValue();
      if (value === undefined) {
        throw new Error("Event queue value index is inconsistent");
      }
      this.#takeWaiter()({ done: false, value });
    }
    while (this.#hasWaiter()) {
      this.#takeWaiter()({ done: true, value: undefined });
    }
  }
}

/**
 * Capture one new Execution as a bounded single-consumer Event stream.
 *
 * Consumption never controls or aborts the Execution.
 */
export async function execute<Definition extends AgentDefinition>(
  client: AgentClient<Definition>,
  runId: RunId,
  options: StreamOptions = {},
): Promise<StreamExecution<Agent.Events<Definition>, ClientFailure<ClientExecution<Definition>>>> {
  const capacity = options.capacity ?? 64;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError("Stream capacity must be a positive safe integer");
  }

  const queue = new BoundedEventQueue<ExecutionEvent>(capacity);
  let latestError: Extract<ExecutionEvent, { readonly type: "error" }> | undefined;
  const unsubscribe = client.subscribe(
    Hook.onExecutionEvent(({ event }) => {
      if (event.type === "error") {
        latestError = event;
      }
      queue.push(event);
      return undefined;
    }),
  );
  let execution: ClientExecution<Definition>;
  try {
    execution = await client.execute(runId);
  } finally {
    unsubscribe();
  }
  void Promise.resolve(execution.result).then(
    () => queue.close(),
    (cause) => {
      const terminal =
        latestError !== undefined && latestError.error === cause
          ? latestError
          : Object.freeze({ type: "error" as const, error: cause });
      queue.closeWithError(terminal);
    },
  );
  return {
    execution,
    // SAFETY: Agent metadata narrows only Tool Event payloads. Core supplied every queued Event for this Agent Execution.
    events: queue as AsyncIterable<StreamEvent<Agent.Events<Definition>>>,
  };
}

/** Project canonical nested Model text deltas from an Execution Event stream. */
export function text(events: AsyncIterable<StreamEvent>): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        if (event.type === "model-event" && event.event.type === "text-delta") {
          yield event.event.delta;
        }
      }
    },
  };
}
