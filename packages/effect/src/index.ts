import {
  type Agent,
  AgentInstallationError,
  AgentRegistrationError,
  ArtifactStoreError,
  commissary,
  type AbortResult,
  type AgentClient,
  type AgentClientRunId,
  type AgentReference,
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
  ExecutionClaimLostError,
  ExecutionEventStoreError,
  type ExecutionId,
  type ExecutionResult,
  ExecutionUnavailableError,
  type GenerateId,
  type JsonValue,
  type Loop,
  type MessageEntry,
  type MessageEntryId,
  type RedirectResult,
  type RunId,
  type SteeringResult,
  UnexpectedExecutionError,
  type ThreadId,
  type ThreadRecord,
  type ThreadStore,
} from "@commissary/core";
import { modelEnvironment } from "@commissary/core/internal";
import { StoreError } from "@commissary/store";
import { Clock as EffectClock, Context, Duration, Effect, Layer } from "effect";

/** Configuration for one Effect-native Commissary Instance. */
export interface EffectCommissaryConfiguration {
  readonly threadStore: ThreadStore;
  readonly artifactStore?: ArtifactStore;
  readonly loop?: Loop;
  readonly executionClaims?: ExecutionClaimOptions;
  readonly generateId?: GenerateId;
}

/** Operation that can reject while the Effect adapter calls the JavaScript core API. */
export type EffectCommissaryOperation =
  | "abortExecution"
  | "abortRun"
  | "createBranch"
  | "createRun"
  | "createThread"
  | "readBranch"
  | "readBranchHistory"
  | "readRunResult"
  | "readRunSnapshot"
  | "installAgent"
  | "readThread"
  | "redirectRun"
  | "renameBranch"
  | "resumeRun"
  | "startExecution"
  | "steerRun"
  | "waitForExecutionResult";

/** Expected failures that can prevent an Effect Execution from starting. */
export type EffectCommissaryStartError = ExecutionUnavailableError | StoreError;

/** Expected failures that can reject a running Effect Execution. */
export type EffectCommissaryExecutionError =
  | ArtifactStoreError
  | ExecutionClaimLostError
  | ExecutionEventStoreError
  | StoreError
  | UnexpectedExecutionError;

/** Defect raised when a JavaScript core operation rejects with an undeclared value. */
export class EffectCommissaryDefect extends Error {
  /** JavaScript core operation that rejected unexpectedly. */
  readonly operation: EffectCommissaryOperation;

  /** Undeclared JavaScript rejection value. */
  override readonly cause: unknown;

  /** Create an Effect defect that preserves the undeclared JavaScript rejection. */
  constructor(operation: EffectCommissaryOperation, cause: unknown) {
    super(`Unexpected Effect Commissary operation failure: ${operation}`, { cause });
    this.name = "EffectCommissaryDefect";
    this.operation = operation;
    this.cause = cause;
  }
}

/** An Effect-native view of one process-bound core Execution. */
export interface EffectExecution<Tools = unknown, Failure = unknown, Run extends RunId = RunId> {
  readonly id: ExecutionId;
  readonly runId: Run;
  readonly result: Effect.Effect<
    ExecutionResult<Failure, Tools, Run>,
    EffectCommissaryExecutionError
  >;
  readonly abort: (
    reason?: JsonValue,
  ) => Effect.Effect<AbortResult<Failure, Tools, Run>, StoreError>;
  readonly core: Execution<Tools, Failure, Run>;
}

/** The Effect-native client bound to one lazily installed Agent. */
export interface EffectAgentClient<Definition extends AgentDefinition> {
  readonly definition: Definition;
  readonly reference: AgentReference<Definition["id"]>;
  readonly createRun: (
    input: AgentCreateRunInput,
  ) => Effect.Effect<AgentCreateRunResult<Definition>, StoreError>;
  readonly resumeRun: (
    input: AgentResumeRunInput<Definition>,
  ) => Effect.Effect<AgentResumeRunResult<Definition>, StoreError>;
  readonly execute: (
    runId: AgentClientRunId<Definition>,
  ) => Effect.Effect<
    EffectExecution<Agent.Tools<Definition>, Agent.Failure<Definition>, AgentRunId<Definition>>,
    EffectCommissaryStartError
  >;
  readonly readRunSnapshot: (
    runId: AgentClientRunId<Definition>,
  ) => Effect.Effect<Agent.RunSnapshots<Definition> | undefined, StoreError>;
  readonly readResult: (
    runId: AgentClientRunId<Definition>,
  ) => Effect.Effect<Agent.RunResults<Definition> | undefined, StoreError>;
  readonly steer: (
    input: AgentSteerInput<Definition>,
  ) => Effect.Effect<SteeringResult<AgentRunId<Definition>>, StoreError>;
  readonly redirect: (
    input: AgentRedirectInput<Definition>,
  ) => Effect.Effect<RedirectResult<AgentRunId<Definition>>, StoreError>;
  readonly abort: (
    runId: AgentClientRunId<Definition>,
    reason?: JsonValue,
  ) => Effect.Effect<
    AbortResult<Agent.Failure<Definition>, Agent.Tools<Definition>, AgentRunId<Definition>>,
    StoreError
  >;
  readonly on: AgentClient<Definition>["on"];
  readonly core: AgentClient<Definition>;
}

/** The Effect-native host interface for Threads, Branches, and listed Agents. */
export interface EffectCommissaryInstance {
  readonly createThread: (input?: {
    readonly id?: ThreadId;
  }) => Effect.Effect<ThreadRecord, StoreError>;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ThreadRecord | undefined, StoreError>;
  readonly createBranch: (input: {
    readonly id?: BranchId;
    readonly threadId: ThreadId;
    readonly name: string;
    readonly from?: MessageEntryId;
  }) => Effect.Effect<BranchRecord, StoreError>;
  readonly readBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => Effect.Effect<BranchRecord | undefined, StoreError>;
  readonly renameBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
    readonly name: string;
  }) => Effect.Effect<BranchRecord, StoreError>;
  readonly readBranchHistory: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => Effect.Effect<readonly MessageEntry[], StoreError>;
  readonly agent: <Definition extends AgentDefinition>(
    definition: Definition,
  ) => Effect.Effect<
    EffectAgentClient<Definition>,
    AgentInstallationError | AgentRegistrationError,
    Agent.Requirements<Definition>
  >;
  readonly core: CommissaryInstance;
}

/** Effect Context service for one Effect-native Commissary Instance. */
export class Commissary extends Context.Service<Commissary, EffectCommissaryInstance>()(
  "@commissary/effect/Commissary",
) {}

function isStoreError(cause: unknown): cause is StoreError {
  return cause instanceof StoreError;
}

function isEffectCommissaryStartError(cause: unknown): cause is EffectCommissaryStartError {
  return cause instanceof ExecutionUnavailableError || cause instanceof StoreError;
}

function isEffectCommissaryExecutionError(cause: unknown): cause is EffectCommissaryExecutionError {
  return (
    cause instanceof ArtifactStoreError ||
    cause instanceof ExecutionClaimLostError ||
    cause instanceof ExecutionEventStoreError ||
    cause instanceof StoreError ||
    cause instanceof UnexpectedExecutionError
  );
}

function fromPromise<Value, ErrorType>(
  operation: EffectCommissaryOperation,
  isExpectedError: (cause: unknown) => cause is ErrorType,
  evaluate: () => PromiseLike<Value>,
): Effect.Effect<Value, ErrorType> {
  return Effect.tryPromise({
    try: () => Promise.resolve(evaluate()),
    catch: (cause) => {
      if (isExpectedError(cause)) {
        return cause;
      }
      throw new EffectCommissaryDefect(operation, cause);
    },
  });
}

function wrapExecution<Tools, Failure, Run extends RunId>(
  execution: Execution<Tools, Failure, Run>,
): EffectExecution<Tools, Failure, Run> {
  return Object.freeze({
    id: execution.id,
    runId: execution.runId,
    result: fromPromise(
      "waitForExecutionResult",
      isEffectCommissaryExecutionError,
      () => execution.result,
    ),
    abort: (reason?: JsonValue) =>
      fromPromise("abortExecution", isStoreError, () => execution.abort(reason)),
    core: execution,
  });
}

function wrapAgent<Definition extends AgentDefinition>(
  client: AgentClient<Definition>,
): EffectAgentClient<Definition> {
  return Object.freeze({
    definition: client.definition,
    reference: client.reference,
    createRun: (input: AgentCreateRunInput) =>
      fromPromise("createRun", isStoreError, () => client.createRun(input)),
    resumeRun: (input: AgentResumeRunInput<Definition>) =>
      fromPromise("resumeRun", isStoreError, () => client.resumeRun(input)),
    execute: (runId: AgentClientRunId<Definition>) =>
      Effect.map(
        fromPromise("startExecution", isEffectCommissaryStartError, () => client.execute(runId)),
        wrapExecution,
      ),
    readRunSnapshot: (runId: AgentClientRunId<Definition>) =>
      fromPromise("readRunSnapshot", isStoreError, () => client.readRunSnapshot(runId)),
    readResult: (runId: AgentClientRunId<Definition>) =>
      fromPromise("readRunResult", isStoreError, () => client.readResult(runId)),
    steer: (input: AgentSteerInput<Definition>) =>
      fromPromise("steerRun", isStoreError, () => client.steer(input)),
    redirect: (input: AgentRedirectInput<Definition>) =>
      fromPromise("redirectRun", isStoreError, () => client.redirect(input)),
    abort: (runId: AgentClientRunId<Definition>, reason?: JsonValue) =>
      fromPromise("abortRun", isStoreError, () => client.abort(runId, reason)),
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
      fromPromise("createThread", isStoreError, () => core.createThread(input)),
    readThread: (threadId: ThreadId) =>
      fromPromise("readThread", isStoreError, () => core.readThread(threadId)),
    createBranch: (input: {
      readonly id?: BranchId;
      readonly threadId: ThreadId;
      readonly name: string;
      readonly from?: MessageEntryId;
    }) => fromPromise("createBranch", isStoreError, () => core.createBranch(input)),
    readBranch: (input: { readonly threadId: ThreadId; readonly branchId: BranchId }) =>
      fromPromise("readBranch", isStoreError, () => core.readBranch(input)),
    renameBranch: (input: {
      readonly threadId: ThreadId;
      readonly branchId: BranchId;
      readonly name: string;
    }) => fromPromise("renameBranch", isStoreError, () => core.renameBranch(input)),
    readBranchHistory: (input: { readonly threadId: ThreadId; readonly branchId: BranchId }) =>
      fromPromise("readBranchHistory", isStoreError, () => core.readBranchHistory(input)),
    agent: <Definition extends AgentDefinition>(definition: Definition) =>
      Effect.flatMap(Effect.context<Agent.Requirements<Definition>>(), (environment) => {
        const current = definitions.get(definition.id);
        if (current !== undefined && current !== definition) {
          return Effect.fail(new AgentRegistrationError(definition.id));
        }
        return Effect.try({
          try: () => install(definition, environment),
          catch: (cause) => {
            if (cause instanceof AgentInstallationError) {
              return cause;
            }
            throw new EffectCommissaryDefect("installAgent", cause);
          },
        });
      }),
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
