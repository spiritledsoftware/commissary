import {
  ArtifactStoreError,
  ExecutionClaimLostError,
  ExecutionEventStoreError,
  ExecutionUnavailableError,
  UnexpectedExecutionError,
  type Agent,
  type AgentClient,
  type AgentClientRunId,
  type AgentDefinition,
  type AgentRunId,
  type Execution,
  type ExecutionResult,
  type RunId,
} from "@commissary/core";
import type { EffectAgentClient } from "@commissary/effect";
import { StoreError } from "@commissary/store";
import { Effect, Stream } from "effect";

import {
  execute as executeJavaScript,
  StreamAlreadyConsumedError,
  type StreamEvent,
  type StreamOptions,
} from "./index.js";

/** Operation that can reject while the Effect stream adapter calls JavaScript APIs. */
export type EffectStreamOperation = "consumeEvents" | "startExecution" | "waitForExecutionResult";

/** Expected failures that can prevent an Effect stream Execution from starting. */
export type EffectStreamStartError = ExecutionUnavailableError | RangeError | StoreError;

/** Expected failures that can reject a running Effect stream Execution. */
export type EffectStreamExecutionError =
  | ArtifactStoreError
  | ExecutionClaimLostError
  | ExecutionEventStoreError
  | StoreError
  | UnexpectedExecutionError;

/** Defect raised when a JavaScript stream operation rejects with an undeclared value. */
export class EffectStreamDefect extends Error {
  /** JavaScript stream operation that rejected unexpectedly. */
  readonly operation: EffectStreamOperation;

  /** Undeclared JavaScript rejection value. */
  override readonly cause: unknown;

  /** Create an Effect stream defect that preserves the undeclared JavaScript rejection. */
  constructor(operation: EffectStreamOperation, cause: unknown) {
    super(`Unexpected Effect stream operation failure: ${operation}`, { cause });
    this.name = "EffectStreamDefect";
    this.operation = operation;
    this.cause = cause;
  }
}

/** An Effect-native view of one bounded Execution stream. */
export interface EffectStreamExecution<
  Tools = unknown,
  Failure = unknown,
  Run extends RunId = RunId,
> {
  readonly execution: Execution<Tools, Failure, Run>;
  readonly events: Stream.Stream<StreamEvent<Tools>, StreamAlreadyConsumedError>;
  readonly result: Effect.Effect<ExecutionResult<Failure, Tools, Run>, EffectStreamExecutionError>;
}

type SupportedClient<Definition extends AgentDefinition> =
  | AgentClient<Definition>
  | EffectAgentClient<Definition>;

function coreClient<Definition extends AgentDefinition>(
  client: SupportedClient<Definition>,
): AgentClient<Definition> {
  return "core" in client ? client.core : client;
}

function isEffectStreamStartError(cause: unknown): cause is EffectStreamStartError {
  return (
    cause instanceof ExecutionUnavailableError ||
    cause instanceof RangeError ||
    cause instanceof StoreError
  );
}

function isEffectStreamExecutionError(cause: unknown): cause is EffectStreamExecutionError {
  return (
    cause instanceof ArtifactStoreError ||
    cause instanceof ExecutionClaimLostError ||
    cause instanceof ExecutionEventStoreError ||
    cause instanceof StoreError ||
    cause instanceof UnexpectedExecutionError
  );
}

/** Capture one new Execution as an Effect-native bounded stream. */
export function execute<Definition extends AgentDefinition>(
  client: SupportedClient<Definition>,
  runId: AgentClientRunId<Definition>,
  options: StreamOptions = {},
): Effect.Effect<
  EffectStreamExecution<Agent.Tools<Definition>, Agent.Failure<Definition>, AgentRunId<Definition>>,
  EffectStreamStartError
> {
  return Effect.map(
    Effect.tryPromise({
      try: () => executeJavaScript(coreClient(client), runId, options),
      catch: (cause) => {
        if (isEffectStreamStartError(cause)) {
          return cause;
        }
        throw new EffectStreamDefect("startExecution", cause);
      },
    }),
    ({ execution, events }) => ({
      execution,
      events: Stream.fromAsyncIterable(events, (cause) => {
        if (cause instanceof StreamAlreadyConsumedError) {
          return cause;
        }
        throw new EffectStreamDefect("consumeEvents", cause);
      }),
      result: Effect.tryPromise({
        try: () => Promise.resolve(execution.result),
        catch: (cause) => {
          if (isEffectStreamExecutionError(cause)) {
            return cause;
          }
          throw new EffectStreamDefect("waitForExecutionResult", cause);
        },
      }),
    }),
  );
}
