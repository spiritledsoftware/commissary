import {
  Agent,
  AgentRegistrationError,
  commissary,
  type AgentClient,
  type AgentCommand,
  type AgentDefinition,
  type ArtifactStore,
  type BranchId,
  type BranchRecord,
  type Clock as CoreClock,
  type CommissaryInstance,
  type Execution,
  type ExecutionClaimOptions,
  type ExecutionResult,
  type HookFragment,
  type GenerateId,
  type JsonValue,
  type Loop,
  type MessageEntry,
  type MessageEntryId,
  type RunId,
  type RunResult,
  type RunSnapshot,
  type SteeringResult,
  type SteerInput,
  type SubmitResult,
  type ThreadId,
  type ThreadRecord,
  type ThreadStore,
} from "@commissary/core";
import { modelEnvironment } from "@commissary/core/internal";
import { Clock as EffectClock, Context, Duration, Effect, Layer } from "effect";

type CoreExecution<Definition extends AgentDefinition> = Awaited<
  ReturnType<AgentClient<Definition>["execute"]>
>;
type ExecutionToolEvent<Value> =
  Value extends Execution<infer ToolEvent, unknown> ? ToolEvent : never;
type ExecutionFailure<Value> = Value extends Execution<unknown, infer Failure> ? Failure : never;

/** Configuration for one Effect-native Commissary Instance. */
export interface EffectCommissaryConfiguration {
  readonly threadStore: ThreadStore;
  readonly artifactStore?: ArtifactStore;
  readonly loop?: Loop;
  readonly executionClaims?: ExecutionClaimOptions;
  readonly generateId?: GenerateId;
}

/** An Effect-native view of one process-bound core Execution. */
export interface EffectExecution<ToolEvent = unknown, Failure = unknown> {
  readonly id: import("@commissary/core").ExecutionId;
  readonly runId: RunId;
  readonly result: Effect.Effect<ExecutionResult<Failure>, unknown>;
  readonly abort: (
    reason?: JsonValue,
  ) => Effect.Effect<import("@commissary/core").AbortResult, unknown>;
  readonly core: Execution<ToolEvent, Failure>;
}

/** The Effect-native client bound to one lazily installed Agent. */
export interface EffectAgentClient<Definition extends AgentDefinition> {
  readonly definition: Definition;
  readonly reference: import("@commissary/core").AgentReference<Definition["id"]>;
  readonly submit: (command: AgentCommand<Definition>) => Effect.Effect<SubmitResult, unknown>;
  readonly execute: (
    runId: RunId,
  ) => Effect.Effect<
    EffectExecution<
      ExecutionToolEvent<CoreExecution<Definition>>,
      ExecutionFailure<CoreExecution<Definition>>
    >,
    unknown
  >;
  readonly readRunSnapshot: (
    runId: RunId,
  ) => Effect.Effect<RunSnapshot<ExecutionFailure<CoreExecution<Definition>>> | undefined, unknown>;
  readonly readResult: (
    runId: RunId,
  ) => Effect.Effect<RunResult<ExecutionFailure<CoreExecution<Definition>>> | undefined, unknown>;
  readonly steer: (input: SteerInput) => Effect.Effect<SteeringResult, unknown>;
  readonly abort: (
    runId: RunId,
    reason?: JsonValue,
  ) => Effect.Effect<import("@commissary/core").AbortResult, unknown>;
  readonly subscribe: (hook: HookFragment) => () => void;
  readonly core: AgentClient<Definition>;
}

/** The Effect-native host interface for Threads, Branches, and listed Agents. */
export interface EffectCommissaryInstance {
  readonly createThread: (input?: {
    readonly id?: ThreadId;
  }) => Effect.Effect<ThreadRecord, unknown>;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ThreadRecord | undefined, unknown>;
  readonly createBranch: (input: {
    readonly id?: BranchId;
    readonly threadId: ThreadId;
    readonly name: string;
    readonly from?: MessageEntryId;
  }) => Effect.Effect<BranchRecord, unknown>;
  readonly readBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => Effect.Effect<BranchRecord | undefined, unknown>;
  readonly renameBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
    readonly name: string;
  }) => Effect.Effect<BranchRecord, unknown>;
  readonly readBranchHistory: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => Effect.Effect<readonly MessageEntry[], unknown>;
  readonly agent: <Definition extends AgentDefinition>(
    definition: Definition,
  ) => Effect.Effect<EffectAgentClient<Definition>, unknown, Agent.Requirements<Definition>>;
  readonly core: CommissaryInstance;
}

/** Effect Context service for one Effect-native Commissary Instance. */
export class Commissary extends Context.Service<Commissary, EffectCommissaryInstance>()(
  "@commissary/effect/Commissary",
) {}

function fromPromise<Value>(evaluate: () => PromiseLike<Value>): Effect.Effect<Value, unknown> {
  return Effect.tryPromise({
    try: () => Promise.resolve(evaluate()),
    catch: (cause) => cause,
  });
}

function wrapExecution<ToolEvent, Failure>(
  execution: Execution<ToolEvent, Failure>,
): EffectExecution<ToolEvent, Failure> {
  return Object.freeze({
    id: execution.id,
    runId: execution.runId,
    result: fromPromise(() => execution.result),
    abort: (reason?: JsonValue) => fromPromise(() => execution.abort(reason)),
    core: execution,
  });
}

function wrapAgent<Definition extends AgentDefinition>(
  client: AgentClient<Definition>,
): EffectAgentClient<Definition> {
  return Object.freeze({
    definition: client.definition,
    reference: client.reference,
    submit: (command: AgentCommand<Definition>) => fromPromise(() => client.submit(command)),
    execute: (runId: RunId) =>
      Effect.map(
        fromPromise(() => client.execute(runId)),
        wrapExecution,
      ),
    readRunSnapshot: (runId: RunId) => fromPromise(() => client.readRunSnapshot(runId)),
    readResult: (runId: RunId) => fromPromise(() => client.readResult(runId)),
    steer: (input: SteerInput) => fromPromise(() => client.steer(input)),
    abort: (runId: RunId, reason?: JsonValue) => fromPromise(() => client.abort(runId, reason)),
    subscribe: (hook: HookFragment) => client.subscribe(hook),
    core: client,
  });
}

function runtimeClock(clock: EffectClock.Clock): CoreClock {
  return Object.freeze({
    now: () => clock.currentTimeMillisUnsafe(),
    sleep: (milliseconds: number, signal: AbortSignal) =>
      Effect.runPromise(clock.sleep(Duration.millis(milliseconds)), { signal }),
  });
}

function makeCore(
  configuration: EffectCommissaryConfiguration,
  clock: CoreClock,
  environment?: unknown,
): CommissaryInstance {
  return commissary({
    threadStore: configuration.threadStore,
    clock,
    ...(configuration.generateId === undefined ? {} : { generateId: configuration.generateId }),
    ...(configuration.artifactStore === undefined
      ? {}
      : { artifactStore: configuration.artifactStore }),
    ...(configuration.loop === undefined ? {} : { loop: configuration.loop }),
    ...(configuration.executionClaims === undefined
      ? {}
      : { executionClaims: configuration.executionClaims }),
    ...(environment === undefined ? {} : { [modelEnvironment]: environment }),
  });
}

function wrapInstance(
  configuration: EffectCommissaryConfiguration,
  clock: CoreClock,
  core: CommissaryInstance,
): EffectCommissaryInstance {
  const definitions = new Map<string, AgentDefinition>();
  const clients = new WeakMap<object, EffectAgentClient<AgentDefinition>>();

  function install<Definition extends AgentDefinition>(
    definition: Definition,
    environment: unknown,
  ): EffectAgentClient<Definition> {
    const current = definitions.get(definition.id);
    if (current !== undefined && current !== definition) {
      throw new AgentRegistrationError(definition.id);
    }
    const existing = clients.get(definition);
    if (existing !== undefined) {
      return existing as EffectAgentClient<Definition>;
    }
    const client = wrapAgent(makeCore(configuration, clock, environment).agent(definition));
    definitions.set(definition.id, definition);
    clients.set(definition, client);
    return client;
  }

  return Object.freeze({
    createThread: (input?: { readonly id?: ThreadId }) =>
      fromPromise(() => core.createThread(input)),
    readThread: (threadId: ThreadId) => fromPromise(() => core.readThread(threadId)),
    createBranch: (input: {
      readonly id?: BranchId;
      readonly threadId: ThreadId;
      readonly name: string;
      readonly from?: MessageEntryId;
    }) => fromPromise(() => core.createBranch(input)),
    readBranch: (input: { readonly threadId: ThreadId; readonly branchId: BranchId }) =>
      fromPromise(() => core.readBranch(input)),
    renameBranch: (input: {
      readonly threadId: ThreadId;
      readonly branchId: BranchId;
      readonly name: string;
    }) => fromPromise(() => core.renameBranch(input)),
    readBranchHistory: (input: { readonly threadId: ThreadId; readonly branchId: BranchId }) =>
      fromPromise(() => core.readBranchHistory(input)),
    agent: <Definition extends AgentDefinition>(definition: Definition) =>
      Effect.flatMap(Effect.context<Agent.Requirements<Definition>>(), (environment) =>
        Effect.try({
          try: () => install(definition, environment),
          catch: (cause) => cause,
        }),
      ),
    core,
  });
}

function make(
  configuration: EffectCommissaryConfiguration,
): Effect.Effect<EffectCommissaryInstance> {
  return Effect.map(EffectClock.Clock, (clock) => {
    const adapted = runtimeClock(clock);
    return wrapInstance(configuration, adapted, makeCore(configuration, adapted));
  });
}

function layer(configuration: EffectCommissaryConfiguration): Layer.Layer<Commissary> {
  return Layer.effect(
    Commissary,
    Effect.map(make(configuration), (instance) => instance),
  );
}

/** Constructors for Effect-native Commissary Instances and Layers. */
export const EffectCommissary = {
  make,
  layer,
};
