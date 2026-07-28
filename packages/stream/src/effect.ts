import type {
  Agent,
  AgentClient,
  AgentDefinition,
  Execution,
  ExecutionResult,
  RunId,
} from "@commissary/core";
import { Effect, Stream } from "effect";

import { execute as executeJavaScript, type StreamEvent, type StreamOptions } from "./index.js";

type ClientExecution<Definition extends AgentDefinition> = Awaited<
  ReturnType<AgentClient<Definition>["execute"]>
>;
type ClientFailure<Value> = Value extends Execution<unknown, infer Failure> ? Failure : never;

/** An Effect-native view of one bounded Execution stream. */
export interface EffectStreamExecution<ToolEvent = unknown, Failure = unknown> {
  readonly execution: Execution<ToolEvent, Failure>;
  readonly events: Stream.Stream<StreamEvent<ToolEvent>, unknown>;
  readonly result: Effect.Effect<ExecutionResult<Failure>, unknown>;
}

/** Capture one new Execution as an Effect-native bounded stream. */
export function execute<Definition extends AgentDefinition>(
  client: AgentClient<Definition>,
  runId: RunId,
  options: StreamOptions = {},
): Effect.Effect<
  EffectStreamExecution<Agent.Events<Definition>, ClientFailure<ClientExecution<Definition>>>,
  unknown
> {
  return Effect.map(
    Effect.tryPromise({
      try: () => executeJavaScript(client, runId, options),
      catch: (cause) => cause,
    }),
    ({ execution, events }) => ({
      execution,
      events: Stream.fromAsyncIterable(events, (cause) => cause),
      result: Effect.tryPromise({
        try: () => Promise.resolve(execution.result),
        catch: (cause) => cause,
      }),
    }),
  );
}
