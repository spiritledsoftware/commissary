import type {
  Agent,
  AgentClient,
  AgentClientRunId,
  AgentDefinition,
  AgentRunId,
  Execution,
  ExecutionResult,
  RunId,
} from "@commissary/core";
import type { EffectAgentClient } from "@commissary/effect";
import { Effect, Stream } from "effect";

import { execute as executeJavaScript, type StreamEvent, type StreamOptions } from "./index.js";

/** An Effect-native view of one bounded Execution stream. */
export interface EffectStreamExecution<
  Tools = unknown,
  Failure = unknown,
  Run extends RunId = RunId,
> {
  readonly execution: Execution<Tools, Failure, Run>;
  readonly events: Stream.Stream<StreamEvent<Tools>, unknown>;
  readonly result: Effect.Effect<ExecutionResult<Failure, Tools, Run>, unknown>;
}

type SupportedClient<Definition extends AgentDefinition> =
  | AgentClient<Definition>
  | EffectAgentClient<Definition>;

function coreClient<Definition extends AgentDefinition>(
  client: SupportedClient<Definition>,
): AgentClient<Definition> {
  return "core" in client ? client.core : client;
}

/** Capture one new Execution as an Effect-native bounded stream. */
export function execute<Definition extends AgentDefinition>(
  client: SupportedClient<Definition>,
  runId: AgentClientRunId<Definition>,
  options: StreamOptions = {},
): Effect.Effect<
  EffectStreamExecution<Agent.Tools<Definition>, Agent.Failure<Definition>, AgentRunId<Definition>>,
  unknown
> {
  return Effect.map(
    Effect.tryPromise({
      try: () => executeJavaScript(coreClient(client), runId, options),
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
