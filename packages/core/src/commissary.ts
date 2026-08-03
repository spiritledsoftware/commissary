import type { CreateInput, SelectedRecord } from "@commissary/store";

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
  CommandFieldsConfig,
  CoreRecordDefinitions,
  CreateBranchInput,
  CreateThreadInput,
  ThreadRecordDefinitions,
  ThreadStore,
  ThreadStoreRunSnapshot,
} from "./store.js";
import { BranchId, RunId, ThreadId } from "./types.js";
import type { AgentRunId, DecodedRunId, JsonValue, MaybePromise } from "./types.js";

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
/** Input that creates a Run with effective host-defined Run fields. */
export type AgentCreateRunInput<
  Definitions extends ThreadRecordDefinitions = CoreRecordDefinitions,
> = Omit<CreateRunInput<DecodedRunId>, "fields"> & CommandFieldsConfig<"run", Definitions>;

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

type SpecializedSelectedRecord<Selected, Specialized> = Specialized extends unknown
  ? Selected & Specialized
  : never;

/** Run Snapshot specialized by one Agent and the effective Store Records. */
export type AgentRunSnapshot<
  Definition extends AgentDefinition,
  Definitions extends ThreadRecordDefinitions = CoreRecordDefinitions,
> = Omit<Agent.RunSnapshots<Definition>, "run" | "toolCalls"> &
  Omit<ThreadStoreRunSnapshot<Definitions>, "run" | "toolCalls" | "suspensions"> & {
    readonly run: SpecializedSelectedRecord<
      SelectedRecord<Definitions["run"]>,
      Agent.RunSnapshots<Definition>["run"]
    >;
    readonly toolCalls: readonly SpecializedSelectedRecord<
      SelectedRecord<Definitions["toolCall"]>,
      Agent.RunSnapshots<Definition>["toolCalls"][number]
    >[];
  };
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

/** Agent-bound Runtime operations with specialized Run, Tool, failure, and Store Record types. */
export interface AgentClient<
  Definition extends AgentDefinition,
  Definitions extends ThreadRecordDefinitions = CoreRecordDefinitions,
> {
  /** Agent Definition installed for this client. */
  readonly definition: Definition;
  /** Durable Agent identity used to authorize Run operations. */
  readonly reference: AgentReference<Definition["id"]>;
  /** Submit one new Run command. */
  readonly createRun: (
    input: AgentCreateRunInput<Definitions>,
  ) => Promise<AgentCreateRunResult<Definition>>;
  /** Submit resume inputs for suspended Tool Calls. */
  readonly resumeRun: (
    input: AgentResumeRunInput<Definition>,
  ) => Promise<AgentResumeRunResult<Definition>>;
  /** Start one fenced Execution for an accepted Run. */
  readonly execute: (
    runId: AgentClientRunId<Definition>,
  ) => Promise<
    Execution<Agent.Tools<Definition>, Agent.Failure<Definition>, AgentRunId<Definition>>
  >;
  /** Read one point-in-time durable Run Snapshot. */
  readonly readRunSnapshot: (
    runId: AgentClientRunId<Definition>,
  ) => Promise<AgentRunSnapshot<Definition, Definitions> | undefined>;
  /** Read the terminal Run Result without building a full Snapshot. */
  readonly readResult: (
    runId: AgentClientRunId<Definition>,
  ) => Promise<Agent.RunResults<Definition> | undefined>;
  /** Add a Steering message to one active Run. */
  readonly steer: (
    input: AgentSteerInput<Definition>,
  ) => Promise<SteeringResult<AgentRunId<Definition>>>;
  /** Redirect one active Run with a new user message. */
  readonly redirect: (
    input: AgentRedirectInput<Definition>,
  ) => Promise<RedirectResult<AgentRunId<Definition>>>;
  /** Request durable Run abortion. */
  readonly abort: (
    runId: AgentClientRunId<Definition>,
    reason?: JsonValue,
  ) => Promise<
    AbortResult<Agent.Failure<Definition>, Agent.Tools<Definition>, AgentRunId<Definition>>
  >;
  /** Subscribe one Agent Hook handler and return its unsubscribe function. */
  readonly on: <Point extends HookPoint<string, unknown, unknown>>(
    point: Point,
    handler: (
      event: AgentHookEvent<Definition, Point>,
    ) => MaybePromise<AgentHookResult<Definition, Point>>,
  ) => () => void;
}

/** Thread command specialized by the effective Thread Record fields. */
export type CreateThreadOperation<Definitions extends ThreadRecordDefinitions> =
  {} extends CreateThreadInput<Definitions>
    ? (input?: CreateThreadInput<Definitions>) => Promise<SelectedRecord<Definitions["thread"]>>
    : (input: CreateThreadInput<Definitions>) => Promise<SelectedRecord<Definitions["thread"]>>;

/** Options for fenced Execution Claims. */
export interface ExecutionClaimOptions {
  /** Requested Execution Claim lease duration in milliseconds. */
  readonly leaseDurationMs?: number;
}

/** Safe host interface for Threads, Branches, and lazily installed Agents. */
export interface CommissaryInstance<
  Definitions extends ThreadRecordDefinitions = CoreRecordDefinitions,
> {
  /** Create one Thread. */
  readonly createThread: CreateThreadOperation<Definitions>;
  /** Read one Thread by ID. */
  readonly readThread: (
    threadId: ThreadId,
  ) => Promise<SelectedRecord<Definitions["thread"]> | undefined>;
  /** Create one Branch. */
  readonly createBranch: (
    input: CreateBranchInput<Definitions>,
  ) => Promise<SelectedRecord<Definitions["branch"]>>;
  /** Read one Branch by Thread and Branch ID. */
  readonly readBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => Promise<SelectedRecord<Definitions["branch"]> | undefined>;
  /** Rename one Branch. */
  readonly renameBranch: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
    readonly name: string;
  }) => Promise<SelectedRecord<Definitions["branch"]>>;
  /** Read the Message history for one Branch. */
  readonly readBranchHistory: (input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }) => Promise<readonly SelectedRecord<Definitions["message"]>[]>;
  /** Install or retrieve one Agent-bound client. */
  readonly agent: <Definition extends AgentDefinition>(
    definition: Definition,
  ) => AgentClient<Definition, Definitions>;
}
/** An error caused by reuse of one installed Agent ID. */
export class AgentRegistrationError extends Error {
  /** Agent ID installed by another Definition. */
  readonly agentId: string;

  /** Create one Agent registration conflict. */
  constructor(agentId: string) {
    super(`Agent ID '${agentId}' is installed by a different Agent definition`);
    this.name = "AgentRegistrationError";
    this.agentId = agentId;
  }
}

/**
 * Create a Commissary Instance from explicit Runtime dependencies.
 *
 * @param configuration - Required and optional Runtime dependencies.
 * @returns A safe host interface with lazy Agent Installation.
 */
export function commissary<
  const Definitions extends ThreadRecordDefinitions = CoreRecordDefinitions,
>(
  configuration: {
    readonly threadStore: ThreadStore<Definitions>;
    readonly artifactStore?: ArtifactStore;
    readonly executionEventStore?: ExecutionEventStore;
    readonly loop?: Loop;
    readonly executionClaims?: ExecutionClaimOptions;
    readonly clock?: Clock;
    readonly generateId?: GenerateId;
  } & InternalCommissaryConfiguration,
): CommissaryInstance<Definitions> {
  const generateId = configuration.generateId ?? (() => globalThis.crypto.randomUUID());
  const newThreadId = () => ThreadId.decode(generateId());
  const newBranchId = () => BranchId.decode(generateId());
  const installedById = new Map<string, InstalledAgentData>();
  // SAFETY: Compatible Core Record overrides preserve every built-in selected output used by Runtime. Runtime uses the specialized operations and does not create a Thread directly.
  const runtimeThreadStore = configuration.threadStore as unknown as ThreadStore;
  const runtime = makeRuntime({
    threadStore: runtimeThreadStore,
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
  // SAFETY: The conditional public operation type requires all host command fields, while the implementation accepts the common optional-input shape.
  const createThread = ((
    input?: CreateThreadInput<Definitions>,
  ): Promise<SelectedRecord<Definitions["thread"]>> => {
    const draft = {
      ...input?.fields,
      id: input?.id ?? newThreadId(),
    };
    // SAFETY: Core supplies id, and the public conditional command type requires every host-defined command field before this merge.
    const createInput = draft as unknown as CreateInput<Definitions["thread"]>;
    return configuration.threadStore.createThread(createInput);
  }) as CreateThreadOperation<Definitions>;

  const clients = new WeakMap<object, object>();

  return Object.freeze({
    createThread,

    readThread(threadId: ThreadId): Promise<SelectedRecord<Definitions["thread"]> | undefined> {
      return configuration.threadStore.readThread(threadId);
    },

    createBranch(
      input: CreateBranchInput<Definitions>,
    ): Promise<SelectedRecord<Definitions["branch"]>> {
      const branch: BranchRecord = {
        ...input.fields,
        id: input.id ?? newBranchId(),
        threadId: input.threadId,
        name: input.name,
        ...(input.from === undefined ? {} : { head: input.from }),
      };
      // SAFETY: Core supplies every built-in Branch field, and CreateBranchInput requires every host-defined command field.
      return configuration.threadStore.createBranch({
        branch: branch as CreateInput<Definitions["branch"]>,
        ...(input.from === undefined ? {} : { from: input.from }),
      });
    },

    readBranch(input: {
      readonly threadId: ThreadId;
      readonly branchId: BranchId;
    }): Promise<SelectedRecord<Definitions["branch"]> | undefined> {
      return configuration.threadStore.readBranch(input);
    },

    renameBranch(input: {
      readonly threadId: ThreadId;
      readonly branchId: BranchId;
      readonly name: string;
    }): Promise<SelectedRecord<Definitions["branch"]>> {
      return configuration.threadStore.renameBranch(input);
    },

    readBranchHistory(input: {
      readonly threadId: ThreadId;
      readonly branchId: BranchId;
    }): Promise<readonly SelectedRecord<Definitions["message"]>[]> {
      return configuration.threadStore.readBranchHistory(input);
    },

    agent<Definition extends AgentDefinition>(
      definition: Definition,
    ): AgentClient<Definition, Definitions> {
      const current = installedById.get(definition.id);
      if (current !== undefined && current.definition !== definition) {
        throw new AgentRegistrationError(definition.id);
      }
      const installed = current ?? installAgent(definition);
      installedById.set(definition.id, installed);
      const existing = clients.get(definition);
      if (existing !== undefined) {
        // SAFETY: The WeakMap key is this exact Agent Definition object, so its cached client has the same generic Definition.
        return existing as AgentClient<Definition, Definitions>;
      }

      const subscriptions: HookDefinition[] = [];
      const client: AgentClient<Definition, Definitions> = Object.freeze({
        definition,
        // SAFETY: installAgent preserves the literal Agent ID from this Definition in its reference.
        reference: installed.reference as AgentReference<Definition["id"]>,
        async createRun(
          input: AgentCreateRunInput<Definitions>,
        ): Promise<AgentCreateRunResult<Definition>> {
          // SAFETY: AgentCreateRunInput narrows the generic Runtime input and is assignable after its Agent-only type metadata is erased.
          const result = await runtime.createRun(installed.reference, input as CreateRunInput);
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
            | AgentRunSnapshot<Definition, Definitions>
            | undefined;
        },
        async readResult(runId: AgentClientRunId<Definition>) {
          // SAFETY: The Store checks the stored Agent before returning the typed result.
          return (await runtime.readResult(installed.reference, runId)) as
            | Agent.RunResults<Definition>
            | undefined;
        },
        steer(input: AgentSteerInput<Definition>) {
          // SAFETY: Runtime receives this installed Agent reference, so an accepted result carries this Agent-bound Run ID.
          return runtime.steer(installed.reference, input) as Promise<
            SteeringResult<AgentRunId<Definition>>
          >;
        },
        redirect(input: AgentRedirectInput<Definition>) {
          // SAFETY: Runtime receives this installed Agent reference, so the redirect result carries this Agent-bound Run ID.
          return runtime.redirect(installed.reference, input) as Promise<
            RedirectResult<AgentRunId<Definition>>
          >;
        },
        abort(runId: AgentClientRunId<Definition>, reason?: JsonValue) {
          // SAFETY: Runtime receives this installed Agent reference, so the abort result carries this Agent's failure, Tool, and Run types.
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
      clients.set(definition, client);
      return client;
    },
  });
}
