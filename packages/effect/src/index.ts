import {
  type Agent,
  AgentRegistrationError,
  commissary,
  type AbortResult,
  type AgentClient,
  type AgentClientRunId,
  type AgentCreateRunInput,
  type AgentCreateRunResult,
  type AgentDefinition,
  type AgentRedirectInput,
  type AgentResumeRunInput,
  type AgentResumeRunResult,
  type AgentRunId,
  type AgentSteerInput,
  type ArtifactStore,
  type BranchId,
  type BranchRecord,
  type Clock as CoreClock,
  type CommissaryInstance,
  type Execution,
  type ExecutionClaimOptions,
  type ExecutionResult,
  type GenerateId,
  type JsonValue,
  type Loop,
  type MessageEntry,
  type MessageEntryId,
  type RedirectResult,
  type RunId,
  type SteeringResult,
  type ThreadId,
  type ThreadRecord,
  type ThreadStore,
} from "@commissary/core";
import { modelEnvironment } from "@commissary/core/internal";
import { Clock as EffectClock, Context, Duration, Effect, Layer } from "effect";

/** Configuration for one Effect-native Commissary Instance. */
export interface EffectCommissaryConfiguration {
  readonly threadStore: ThreadStore;
  readonly artifactStore?: ArtifactStore;
  readonly loop?: Loop;
  readonly executionClaims?: ExecutionClaimOptions;
  readonly generateId?: GenerateId;
}

/** An Effect-native view of one process-bound core Execution. */
export interface EffectExecution<Tools = unknown, Failure = unknown, Run extends RunId = RunId> {
  readonly id: import("@commissary/core").ExecutionId;
  readonly runId: Run;
  readonly result: Effect.Effect<ExecutionResult<Failure, Tools, Run>, unknown>;
  readonly abort: (reason?: JsonValue) => Effect.Effect<AbortResult<Failure, Tools, Run>, unknown>;
  readonly core: Execution<Tools, Failure, Run>;
}

/** The Effect-native client bound to one lazily installed Agent. */
export interface EffectAgentClient<Definition extends AgentDefinition> {
  readonly definition: Definition;
  readonly reference: import("@commissary/core").AgentReference<Definition["id"]>;
  readonly createRun: (
    input: AgentCreateRunInput,
  ) => Effect.Effect<AgentCreateRunResult<Definition>, unknown>;
  readonly resumeRun: (
    input: AgentResumeRunInput<Definition>,
  ) => Effect.Effect<AgentResumeRunResult<Definition>, unknown>;
  readonly execute: (
    runId: AgentClientRunId<Definition>,
  ) => Effect.Effect<
    EffectExecution<Agent.Tools<Definition>, Agent.Failure<Definition>, AgentRunId<Definition>>,
    unknown
  >;
  readonly readRunSnapshot: (
    runId: AgentClientRunId<Definition>,
  ) => Effect.Effect<Agent.RunSnapshots<Definition> | undefined, unknown>;
  readonly readResult: (
    runId: AgentClientRunId<Definition>,
  ) => Effect.Effect<Agent.RunResults<Definition> | undefined, unknown>;
  readonly steer: (
    input: AgentSteerInput<Definition>,
  ) => Effect.Effect<SteeringResult<AgentRunId<Definition>>, unknown>;
  readonly redirect: (
    input: AgentRedirectInput<Definition>,
  ) => Effect.Effect<RedirectResult<AgentRunId<Definition>>, unknown>;
  readonly abort: (
    runId: AgentClientRunId<Definition>,
    reason?: JsonValue,
  ) => Effect.Effect<
    AbortResult<Agent.Failure<Definition>, Agent.Tools<Definition>, AgentRunId<Definition>>,
    unknown
  >;
  readonly on: AgentClient<Definition>["on"];
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

function wrapExecution<Tools, Failure, Run extends RunId>(
  execution: Execution<Tools, Failure, Run>,
): EffectExecution<Tools, Failure, Run> {
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
    createRun: (input: AgentCreateRunInput) => fromPromise(() => client.createRun(input)),
    resumeRun: (input: AgentResumeRunInput<Definition>) =>
      fromPromise(() => client.resumeRun(input)),
    execute: (runId: AgentClientRunId<Definition>) =>
      Effect.map(
        fromPromise(() => client.execute(runId)),
        wrapExecution,
      ),
    readRunSnapshot: (runId: AgentClientRunId<Definition>) =>
      fromPromise(() => client.readRunSnapshot(runId)),
    readResult: (runId: AgentClientRunId<Definition>) =>
      fromPromise(() => client.readResult(runId)),
    steer: (input: AgentSteerInput<Definition>) => fromPromise(() => client.steer(input)),
    redirect: (input: AgentRedirectInput<Definition>) => fromPromise(() => client.redirect(input)),
    abort: (runId: AgentClientRunId<Definition>, reason?: JsonValue) =>
      fromPromise(() => client.abort(runId, reason)),
    on: client.on,
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
  const clients = new WeakMap<object, object>();

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
