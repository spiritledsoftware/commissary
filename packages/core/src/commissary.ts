import { installAgent, type AgentDefinition, type InstalledAgentData } from "./agent.js";
import type { Agent } from "./agent.js";
import type { HookBlockedFailure } from "./hook.js";
import type { AgentReference } from "./identity.js";
import { modelEnvironment, type InternalCommissaryConfiguration } from "./internal.js";
import type { ModelFailure } from "./protocol.js";
import type {
  AbortResult,
  AdmitInput,
  AdmitResult,
  AttemptOutcome,
  Driver,
  ExecutionAttempt,
  ResumeResult,
  RunAdmissionFailure,
  RunResult,
  SteeringResult,
  SteerInput,
} from "./runtime.js";
import { makeRuntime } from "./runtime-implementation.js";
import type { ArtifactStore, BranchRecord, ThreadRecord, ThreadStore } from "./store.js";
import type { Tool } from "./tool.js";
import type {
  BranchId,
  JsonValue,
  MessageEntryId,
  RunId,
  ThreadId,
  ToolResumeRequestId,
} from "./types.js";

type RegisteredAgent<Agents extends readonly AgentDefinition[]> = Agents[number];

type AgentFailure<Definition extends AgentDefinition> =
  | Tool.Failure<Agent.Tools<Definition>>
  | HookBlockedFailure
  | ModelFailure;

type AgentSuspension<Definition extends AgentDefinition> = Tool.Suspension<Agent.Tools<Definition>>;

type AgentResume<Definition extends AgentDefinition> =
  Agent.ToolResumptions<Definition> extends infer Resume
    ? Resume extends { readonly toolName: string; readonly input: unknown }
      ? Resume & {
          readonly runId: RunId;
          readonly toolResumeRequestId?: ToolResumeRequestId;
        }
      : never
    : never;

export interface AgentClient<Definition extends AgentDefinition> {
  readonly definition: Definition;
  readonly reference: AgentReference<Definition["id"]>;
  readonly admit: (input: AdmitInput) => Promise<AdmitResult>;
  readonly execute: (
    runId: RunId,
  ) => Promise<
    ExecutionAttempt<
      Agent.ToolSignals<Definition>,
      AgentFailure<Definition>,
      AgentSuspension<Definition>
    >
  >;
  readonly resume: (input: AgentResume<Definition>) => Promise<ResumeResult>;
  readonly steer: (input: SteerInput) => Promise<SteeringResult>;
  readonly abort: (runId: RunId, reason?: JsonValue) => Promise<AbortResult>;
  readonly readResult: (
    runId: RunId,
  ) => Promise<RunResult<AgentFailure<Definition>, AgentSuspension<Definition>> | undefined>;
  readonly run: (
    input: AdmitInput,
  ) => Promise<
    AttemptOutcome<AgentFailure<Definition>, AgentSuspension<Definition>> | RunAdmissionFailure
  >;
  readonly stream: (
    input: AdmitInput,
  ) => Promise<
    | ExecutionAttempt<
        Agent.ToolSignals<Definition>,
        AgentFailure<Definition>,
        AgentSuspension<Definition>
      >
    | RunAdmissionFailure
  >;
}

export interface CommissaryInstance<
  Agents extends readonly AgentDefinition[] = readonly AgentDefinition[],
> {
  readonly createThread: () => Promise<ThreadRecord>;
  readonly createBranch: (input: {
    readonly threadId: ThreadId;
    readonly name: string;
    readonly from?: MessageEntryId;
  }) => Promise<BranchRecord>;
  readonly agent: <Definition extends RegisteredAgent<Agents>>(
    definition: Definition,
  ) => AgentClient<Definition>;
}

export class AgentRegistrationError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent ID '${agentId}' is registered more than once`);
    this.name = "AgentRegistrationError";
  }
}

export function commissary<const Agents extends readonly AgentDefinition[]>(
  configuration: {
    readonly threadStore: ThreadStore;
    readonly artifactStore?: ArtifactStore;
    readonly agents: Agents;
    readonly driver?: Driver;
  } & InternalCommissaryConfiguration,
): CommissaryInstance<Agents> {
  const installedById = new Map<string, InstalledAgentData>();
  for (const definition of configuration.agents) {
    if (installedById.has(definition.id)) {
      throw new AgentRegistrationError(definition.id);
    }
    installedById.set(definition.id, installAgent(definition));
  }
  const runtime = makeRuntime({
    threadStore: configuration.threadStore,
    ...(configuration.artifactStore === undefined
      ? {}
      : { artifactStore: configuration.artifactStore }),
    ...(configuration[modelEnvironment] === undefined
      ? {}
      : { modelEnvironment: configuration[modelEnvironment] }),
    agents: installedById,
    ...(configuration.driver === undefined ? {} : { driver: configuration.driver }),
  });
  const clients = new WeakMap<object, AgentClient<AgentDefinition>>();

  return Object.freeze({
    async createThread(): Promise<ThreadRecord> {
      return configuration.threadStore.createThread({
        id: globalThis.crypto.randomUUID() as ThreadId,
      });
    },

    async createBranch(input: {
      readonly threadId: ThreadId;
      readonly name: string;
      readonly from?: MessageEntryId;
    }): Promise<BranchRecord> {
      const branch: BranchRecord = {
        id: globalThis.crypto.randomUUID() as BranchId,
        threadId: input.threadId,
        name: input.name,
        ...(input.from === undefined ? {} : { head: input.from }),
      };
      return configuration.threadStore.createBranch({
        branch,
        ...(input.from === undefined ? {} : { from: input.from }),
      });
    },

    agent<Definition extends RegisteredAgent<Agents>>(
      definition: Definition,
    ): AgentClient<Definition> {
      const installed = installedById.get(definition.id);
      if (installed === undefined || installed.definition !== definition) {
        throw new AgentRegistrationError(definition.id);
      }
      const existing = clients.get(definition);
      if (existing !== undefined) {
        return existing as AgentClient<Definition>;
      }

      const client: AgentClient<Definition> = Object.freeze({
        definition,
        reference: installed.reference as AgentReference<Definition["id"]>,
        admit(input: AdmitInput) {
          return runtime.admit(installed.reference, input);
        },
        async execute(runId: RunId) {
          return (await runtime.execute(definition, runId)) as ExecutionAttempt<
            Agent.ToolSignals<Definition>,
            AgentFailure<Definition>,
            AgentSuspension<Definition>
          >;
        },
        resume(input: AgentResume<Definition>) {
          return runtime.resume(input);
        },
        steer(input: SteerInput) {
          return runtime.steer(input);
        },
        abort(runId: RunId, reason?: JsonValue) {
          return runtime.abort(runId, reason);
        },
        async readResult(runId: RunId) {
          return (await runtime.readResult(runId)) as
            | RunResult<AgentFailure<Definition>, AgentSuspension<Definition>>
            | undefined;
        },
        async run(input: AdmitInput) {
          const admission = await runtime.admit(installed.reference, input);
          if ("type" in admission) {
            return admission;
          }
          const attempt = await runtime.execute(definition, admission.runId);
          return (await attempt.outcome) as AttemptOutcome<
            AgentFailure<Definition>,
            AgentSuspension<Definition>
          >;
        },
        async stream(input: AdmitInput) {
          const admission = await runtime.admit(installed.reference, input);
          if ("type" in admission) {
            return admission;
          }
          return (await runtime.execute(definition, admission.runId)) as ExecutionAttempt<
            Agent.ToolSignals<Definition>,
            AgentFailure<Definition>,
            AgentSuspension<Definition>
          >;
        },
      });
      clients.set(definition, client as AgentClient<AgentDefinition>);
      return client;
    },
  });
}
