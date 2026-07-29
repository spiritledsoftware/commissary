import { installAgent, type AgentDefinition, type InstalledAgentData } from "./agent.js";
import type { Agent } from "./agent.js";
import {
  hookDefinitionOf,
  type HookBlockedFailure,
  type HookDefinition,
  type HookFragment,
} from "./hook.js";
import type { AgentReference } from "./identity.js";
import { modelEnvironment, type InternalCommissaryConfiguration } from "./internal.js";
import type { ModelFailure } from "./protocol.js";
import type {
  AbortResult,
  Execution,
  ExecutionEventStore,
  Clock,
  Loop,
  RedirectInput,
  RedirectResult,
  ResumeRunCommand,
  GenerateId,
  RunCommand,
  RunResult,
  RunSnapshot,
  StartRunCommand,
  SteeringResult,
  SteerInput,
  SubmitResult,
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
import type { Tool } from "./tool.js";
import type { BranchId, JsonValue, MessageEntryId, RunId, ThreadId } from "./types.js";

type AgentFailure<Definition extends AgentDefinition> =
  | Tool.Failure<Agent.Tools<Definition>>
  | HookBlockedFailure
  | ModelFailure;

type AgentResumeItem<Definition extends AgentDefinition> =
  Agent.ToolResumptions<Definition> extends infer Item
    ? Item extends ToolResumeItem
      ? Item
      : never
    : never;

/** A start or typed Tool resume command accepted by one Agent. */
export type AgentCommand<Definition extends AgentDefinition> =
  | StartRunCommand
  | ([AgentResumeItem<Definition>] extends [never]
      ? never
      : ResumeRunCommand<AgentResumeItem<Definition>>);

/** The typed host interface bound to one lazily installed Agent. */
export interface AgentClient<Definition extends AgentDefinition> {
  readonly definition: Definition;
  readonly reference: AgentReference<Definition["id"]>;
  readonly submit: (command: AgentCommand<Definition>) => Promise<SubmitResult>;
  readonly execute: (
    runId: RunId,
  ) => Promise<Execution<Agent.Events<Definition>, AgentFailure<Definition>>>;
  readonly readRunSnapshot: (
    runId: RunId,
  ) => Promise<RunSnapshot<AgentFailure<Definition>> | undefined>;
  readonly readResult: (runId: RunId) => Promise<RunResult<AgentFailure<Definition>> | undefined>;
  readonly steer: (input: SteerInput) => Promise<SteeringResult>;
  readonly redirect: (input: RedirectInput) => Promise<RedirectResult>;
  readonly abort: (runId: RunId, reason?: JsonValue) => Promise<AbortResult>;
  readonly subscribe: (hook: HookFragment) => () => void;
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
  function newId<Id extends string>(): Id {
    return generateId() as Id;
  }
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
        configuration.threadStore.createThread({ id: input.id ?? newId<ThreadId>() }),
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
        id: input.id ?? newId<BranchId>(),
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
        submit(command: AgentCommand<Definition>) {
          return runtime.submit(installed.reference, command as RunCommand);
        },
        async execute(runId: RunId) {
          const captured = Object.freeze([...subscriptions]);
          // SAFETY: Agent metadata carries the union of Tool Events and declared Failures for this definition.
          return (await runtime.execute(definition, runId, captured)) as Execution<
            Agent.Events<Definition>,
            AgentFailure<Definition>
          >;
        },
        async readRunSnapshot(runId: RunId) {
          // SAFETY: The Run belongs to this installed Agent Client when submitted through it.
          return (await runtime.readRunSnapshot(runId)) as
            | RunSnapshot<AgentFailure<Definition>>
            | undefined;
        },
        async readResult(runId: RunId) {
          // SAFETY: The Run belongs to this installed Agent Client when submitted through it.
          return (await runtime.readResult(runId)) as
            | RunResult<AgentFailure<Definition>>
            | undefined;
        },
        steer(input: SteerInput) {
          return runtime.steer(input);
        },
        redirect(input: RedirectInput) {
          return runtime.redirect(input);
        },
        abort(runId: RunId, reason?: JsonValue) {
          return runtime.abort(runId, reason);
        },
        subscribe(fragment: HookFragment) {
          const definition = hookDefinitionOf(fragment);
          subscriptions.push(definition);
          let subscribed = true;
          return () => {
            if (!subscribed) {
              return;
            }
            subscribed = false;
            const index = subscriptions.indexOf(definition);
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
