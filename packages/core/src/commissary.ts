import { installAgent, type AgentDefinition, type InstalledAgentData } from "./agent.js";
import type { Agent } from "./agent.js";
import {
  agentHookDefinition,
  type AgentHookEvent,
  type AgentHookResult,
  type HookDefinition,
  type HookPoint,
} from "./hook.js";
import type { AgentReference } from "./identity.js";
import { modelEnvironment, type InternalCommissaryConfiguration } from "./internal.js";
import type {
  AbortResult,
  AcceptedRun,
  BranchConflict,
  Clock,
  CreateRunInput,
  Execution,
  ExecutionEventStore,
  GenerateId,
  Loop,
  RedirectInput,
  RedirectResult,
  ResumeRunInput,
  RunConflict,
  ToolResumeConflict,
  ToolResumeRequestConflict,
  SteeringResult,
  SteerInput,
  ToolResumeItem,
} from "./runtime.js";
import { makeRuntime } from "./runtime-implementation.js";
import type {
  ArtifactStore,
  BranchRecord,
  MessageEntry,
  ThreadRecord,
  ThreadStore,
} from "./store.js";
import { ThreadStoreError } from "./store.js";
import { BranchId, RunId, ThreadId } from "./types.js";
import type { AgentRunId, DecodedRunId, JsonValue, MaybePromise, MessageEntryId } from "./types.js";

/** A Run ID accepted by one bound Agent Client. */
export type AgentClientRunId<Definition extends AgentDefinition> =
  | AgentRunId<Definition>
  | DecodedRunId;

type AgentResumeItem<Definition extends AgentDefinition> =
  Agent.ToolResumptions<Definition> extends infer Item
    ? Item extends ToolResumeItem
      ? Item
      : never
    : never;

/** Input that creates a Run for one bound Agent. */
export type AgentCreateRunInput = CreateRunInput<DecodedRunId>;

/** Typed resume input for one bound Agent. */
export type AgentResumeRunInput<Definition extends AgentDefinition> = Omit<
  ResumeRunInput<AgentResumeItem<Definition>>,
  "runId"
> & {
  readonly runId: AgentClientRunId<Definition>;
};

/** Result of Run creation through one bound Agent Client. */
export type AgentCreateRunResult<Definition extends AgentDefinition> =
  | AcceptedRun<AgentRunId<Definition>>
  | BranchConflict
  | RunConflict<DecodedRunId>;

/** Result of Tool resumption through one bound Agent Client. */
export type AgentResumeRunResult<Definition extends AgentDefinition> =
  | AcceptedRun<AgentRunId<Definition>>
  | ToolResumeConflict<AgentClientRunId<Definition>>
  | ToolResumeRequestConflict<AgentClientRunId<Definition>>;

/** Typed Steering input for one bound Agent. */
export type AgentSteerInput<Definition extends AgentDefinition> = Omit<SteerInput, "runId"> & {
  readonly runId: AgentClientRunId<Definition>;
};

/** Typed Redirect input for one bound Agent. */
export type AgentRedirectInput<Definition extends AgentDefinition> = Omit<
  RedirectInput,
  "runId"
> & {
  readonly runId: AgentClientRunId<Definition>;
};

/** The typed host interface bound to one lazily installed Agent. */
export interface AgentClient<Definition extends AgentDefinition> {
  readonly definition: Definition;
  readonly reference: AgentReference<Definition["id"]>;
  readonly createRun: (input: AgentCreateRunInput) => Promise<AgentCreateRunResult<Definition>>;
  readonly resumeRun: (
    input: AgentResumeRunInput<Definition>,
  ) => Promise<AgentResumeRunResult<Definition>>;
  readonly execute: (
    runId: AgentClientRunId<Definition>,
  ) => Promise<
    Execution<Agent.Tools<Definition>, Agent.Failure<Definition>, AgentRunId<Definition>>
  >;
  readonly readRunSnapshot: (
    runId: AgentClientRunId<Definition>,
  ) => Promise<Agent.RunSnapshots<Definition> | undefined>;
  readonly readResult: (
    runId: AgentClientRunId<Definition>,
  ) => Promise<Agent.RunResults<Definition> | undefined>;
  readonly steer: (
    input: AgentSteerInput<Definition>,
  ) => Promise<SteeringResult<AgentRunId<Definition>>>;
  readonly redirect: (
    input: AgentRedirectInput<Definition>,
  ) => Promise<RedirectResult<AgentRunId<Definition>>>;
  readonly abort: (
    runId: AgentClientRunId<Definition>,
    reason?: JsonValue,
  ) => Promise<
    AbortResult<Agent.Failure<Definition>, Agent.Tools<Definition>, AgentRunId<Definition>>
  >;
  readonly on: <Point extends HookPoint<string, unknown, unknown>>(
    point: Point,
    handler: (
      event: AgentHookEvent<Definition, Point>,
    ) => MaybePromise<AgentHookResult<Definition, Point>>,
  ) => () => void;
}

/** Options for fenced Execution Claims. */
export interface ExecutionClaimOptions {
  readonly leaseDurationMs?: number;
}

/** Safe host interface for Threads, Branches, and lazily installed Agents. */
export interface CommissaryInstance {
  readonly createThread: (input?: { readonly id?: ThreadId }) => Promise<ThreadRecord>;
  readonly readThread: (threadId: ThreadId) => Promise<ThreadRecord | undefined>;
  readonly createBranch: (input: {
    readonly id?: BranchId;
    readonly threadId: ThreadId;
    readonly name: string;
    readonly from?: MessageEntryId;
  }) => Promise<BranchRecord>;
  readonly readBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => Promise<BranchRecord | undefined>;
  readonly renameBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
    readonly name: string;
  }) => Promise<BranchRecord>;
  readonly readBranchHistory: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => Promise<readonly MessageEntry[]>;
  readonly agent: <Definition extends AgentDefinition>(
    definition: Definition,
  ) => AgentClient<Definition>;
}

/** An error caused by reuse of one installed Agent ID. */
export class AgentRegistrationError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent ID '${agentId}' is installed by a different Agent definition`);
    this.name = "AgentRegistrationError";
  }
}

async function storeCall<Value>(
  operation: string,
  evaluate: () => PromiseLike<Value>,
): Promise<Value> {
  try {
    return await evaluate();
  } catch (cause) {
    if (cause instanceof ThreadStoreError) {
      throw cause;
    }
    throw new ThreadStoreError(operation, cause);
  }
}

/**
 * Create a Commissary Instance from explicit Runtime dependencies.
 *
 * @param configuration - Required and optional Runtime dependencies.
 * @returns A safe host interface with lazy Agent Installation.
 */
export function commissary(
  configuration: {
    readonly threadStore: ThreadStore;
    readonly artifactStore?: ArtifactStore;
    readonly executionEventStore?: ExecutionEventStore;
    readonly loop?: Loop;
    readonly executionClaims?: ExecutionClaimOptions;
    readonly clock?: Clock;
    readonly generateId?: GenerateId;
  } & InternalCommissaryConfiguration,
): CommissaryInstance {
  const generateId = configuration.generateId ?? (() => globalThis.crypto.randomUUID());
  const newThreadId = () => ThreadId.decode(generateId());
  const newBranchId = () => BranchId.decode(generateId());
  const installedById = new Map<string, InstalledAgentData>();
  const runtime = makeRuntime({
    threadStore: configuration.threadStore,
    ...(configuration.clock === undefined ? {} : { clock: configuration.clock }),
    generateId,
    ...(configuration.artifactStore === undefined
      ? {}
      : { artifactStore: configuration.artifactStore }),
    ...(configuration.executionEventStore === undefined
      ? {}
      : { executionEventStore: configuration.executionEventStore }),
    ...(configuration[modelEnvironment] === undefined
      ? {}
      : { modelEnvironment: configuration[modelEnvironment] }),
    agents: installedById,
    ...(configuration.loop === undefined ? {} : { loop: configuration.loop }),
    ...(configuration.executionClaims === undefined
      ? {}
      : { executionClaims: configuration.executionClaims }),
  });
  const clients = new WeakMap<object, AgentClient<AgentDefinition>>();

  return Object.freeze({
    createThread(input: { readonly id?: ThreadId } = {}): Promise<ThreadRecord> {
      return storeCall("createThread", () =>
        configuration.threadStore.createThread({ id: input.id ?? newThreadId() }),
      );
    },

    readThread(threadId: ThreadId): Promise<ThreadRecord | undefined> {
      return storeCall("readThread", () => configuration.threadStore.readThread(threadId));
    },

    createBranch(input: {
      readonly id?: BranchId;
      readonly threadId: ThreadId;
      readonly name: string;
      readonly from?: MessageEntryId;
    }): Promise<BranchRecord> {
      const branch: BranchRecord = {
        id: input.id ?? newBranchId(),
        threadId: input.threadId,
        name: input.name,
        ...(input.from === undefined ? {} : { head: input.from }),
      };
      return storeCall("createBranch", () =>
        configuration.threadStore.createBranch({
          branch,
          ...(input.from === undefined ? {} : { from: input.from }),
        }),
      );
    },

    readBranch(input: {
      readonly threadId: ThreadId;
      readonly branchId: BranchId;
    }): Promise<BranchRecord | undefined> {
      return storeCall("readBranch", () => configuration.threadStore.readBranch(input));
    },

    renameBranch(input: {
      readonly threadId: ThreadId;
      readonly branchId: BranchId;
      readonly name: string;
    }): Promise<BranchRecord> {
      return storeCall("renameBranch", () => configuration.threadStore.renameBranch(input));
    },

    readBranchHistory(input: {
      readonly threadId: ThreadId;
      readonly branchId: BranchId;
    }): Promise<readonly MessageEntry[]> {
      return storeCall("readBranchHistory", () =>
        configuration.threadStore.readBranchHistory(input),
      );
    },

    agent<Definition extends AgentDefinition>(definition: Definition): AgentClient<Definition> {
      const current = installedById.get(definition.id);
      if (current !== undefined && current.definition !== definition) {
        throw new AgentRegistrationError(definition.id);
      }
      const installed = current ?? installAgent(definition);
      installedById.set(definition.id, installed);
      const existing = clients.get(definition);
      if (existing !== undefined) {
        return existing as AgentClient<Definition>;
      }

      const subscriptions: HookDefinition[] = [];
      const client: AgentClient<Definition> = Object.freeze({
        definition,
        reference: installed.reference as AgentReference<Definition["id"]>,
        async createRun(input: AgentCreateRunInput): Promise<AgentCreateRunResult<Definition>> {
          const result = await runtime.createRun(installed.reference, input);
          if (result.type === "accepted") {
            // SAFETY: The Store accepted the Run with this installed Agent reference.
            return result as AcceptedRun<AgentRunId<Definition>>;
          }
          return result.type === "run-conflict"
            ? Object.freeze({ ...result, runId: RunId.decode(result.runId) })
            : result;
        },
        async resumeRun(
          input: AgentResumeRunInput<Definition>,
        ): Promise<AgentResumeRunResult<Definition>> {
          const result = await runtime.resumeRun(installed.reference, input);
          if (result.type === "accepted") {
            // SAFETY: The Store accepted the submitted Run ID for this installed Agent.
            return result as AcceptedRun<AgentRunId<Definition>>;
          }
          return Object.freeze({ ...result, runId: input.runId });
        },
        async execute(runId: AgentClientRunId<Definition>) {
          const captured = Object.freeze([...subscriptions]);
          // SAFETY: Claim acquisition checks the stored Agent before returning the Execution.
          return (await runtime.execute(definition, runId, captured)) as Execution<
            Agent.Tools<Definition>,
            Agent.Failure<Definition>,
            AgentRunId<Definition>
          >;
        },
        async readRunSnapshot(runId: AgentClientRunId<Definition>) {
          // SAFETY: The Store checks the stored Agent before returning the typed Snapshot.
          return (await runtime.readRunSnapshot(installed.reference, runId)) as
            | Agent.RunSnapshots<Definition>
            | undefined;
        },
        async readResult(runId: AgentClientRunId<Definition>) {
          // SAFETY: The Store checks the stored Agent before returning the typed result.
          return (await runtime.readResult(installed.reference, runId)) as
            | Agent.RunResults<Definition>
            | undefined;
        },
        steer(input: AgentSteerInput<Definition>) {
          return runtime.steer(installed.reference, input) as Promise<
            SteeringResult<AgentRunId<Definition>>
          >;
        },
        redirect(input: AgentRedirectInput<Definition>) {
          return runtime.redirect(installed.reference, input) as Promise<
            RedirectResult<AgentRunId<Definition>>
          >;
        },
        abort(runId: AgentClientRunId<Definition>, reason?: JsonValue) {
          return runtime.abort(installed.reference, runId, reason) as Promise<
            AbortResult<Agent.Failure<Definition>, Agent.Tools<Definition>, AgentRunId<Definition>>
          >;
        },
        on<Point extends HookPoint<string, unknown, unknown>>(
          point: Point,
          handler: (
            event: AgentHookEvent<Definition, Point>,
          ) => MaybePromise<AgentHookResult<Definition, Point>>,
        ) {
          const subscription = agentHookDefinition<Definition, Point>(point, handler);
          subscriptions.push(subscription);
          let subscribed = true;
          return () => {
            if (!subscribed) {
              return;
            }
            subscribed = false;
            const index = subscriptions.indexOf(subscription);
            if (index !== -1) {
              subscriptions.splice(index, 1);
            }
          };
        },
      });
      clients.set(definition, client as AgentClient<AgentDefinition>);
      return client;
    },
  });
}
