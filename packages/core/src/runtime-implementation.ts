import type { AgentDefinition, InstalledAgentData } from "./agent.js";
import type { HookDefinition } from "./hook.js";
import type { AgentReference } from "./identity.js";
import type {
  AbortResult,
  Clock,
  CreateRunInput,
  CreateRunResult,
  Execution,
  ExecutionEventStore,
  GenerateId,
  Loop,
  RedirectInput,
  RedirectResult,
  ResumeRunInput,
  ResumeRunResult,
  RunResult,
  RunSnapshot,
  Runtime,
  SteeringResult,
  SteerInput,
} from "./runtime.js";
import type { ArtifactStore, ThreadStore } from "./store.js";
import { CommitId, MessageEntryId, RunId } from "./types.js";
import type { JsonValue } from "./types.js";
import { createExecutionCoordinator } from "./runtime/execution.js";
import { submitToolResumes } from "./runtime/tools.js";

interface RuntimeOptions {
  readonly threadStore: ThreadStore;
  readonly artifactStore?: ArtifactStore;
  readonly executionEventStore?: ExecutionEventStore;
  readonly agents: ReadonlyMap<string, InstalledAgentData>;
  readonly loop?: Loop;
  readonly executionClaims?: { readonly leaseDurationMs?: number };
  readonly clock?: Clock;
  readonly generateId?: GenerateId;
  readonly modelEnvironment?: unknown;
}

/** Build the core Runtime behind one Commissary Instance. */
export function makeRuntime(options: RuntimeOptions): Runtime {
  const { threadStore, agents } = options;
  const generateId = options.generateId ?? (() => globalThis.crypto.randomUUID());
  const newRunId = () => RunId.decode(generateId());
  const newMessageEntryId = () => MessageEntryId.decode(generateId());
  const newCommitId = () => CommitId.decode(generateId());

  const requestAbort = async (
    agent: AgentReference,
    runId: RunId,
    reason?: JsonValue,
  ): Promise<AbortResult> => {
    const result = await threadStore.requestAbort({
      agent,
      runId,
      ...(reason === undefined ? {} : { reason }),
    });
    if (result.type === "accepted") {
      coordinator.abortActive(runId, reason);
    }
    return result;
  };

  const coordinator = createExecutionCoordinator({
    ...options,
    generateId,
    requestAbort,
  });

  return Object.freeze({
    threadStore,

    createRun(agent: AgentReference, input: CreateRunInput): Promise<CreateRunResult> {
      return threadStore.submitRun({
        runId: input.runId ?? newRunId(),
        entryId: newMessageEntryId(),
        commitId: newCommitId(),
        agent,
        threadId: input.threadId,
        branchId: input.branchId,
        message: input.message,
        ...(input.expectedHead === undefined ? {} : { expectedHead: input.expectedHead }),
        ...(input.fields === undefined ? {} : { fields: input.fields }),
      });
    },

    resumeRun(agent: AgentReference, input: ResumeRunInput): Promise<ResumeRunResult> {
      const installed = agents.get(agent.id);
      if (installed === undefined || installed.reference.revision !== agent.revision) {
        return Promise.resolve({
          type: "tool-resume-conflict",
          runId: input.runId,
          toolCallIds: input.items.map((item) => item.toolCallId),
        });
      }
      return submitToolResumes({
        installed,
        input,
        threadStore,
      });
    },

    steer(agent: AgentReference, input: SteerInput): Promise<SteeringResult> {
      return threadStore.acceptSteering({ agent, ...input });
    },

    async redirect(agent: AgentReference, input: RedirectInput): Promise<RedirectResult> {
      const result = await threadStore.acceptRedirect({ agent, ...input });
      if (result.type === "accepted" && result.admitted) {
        coordinator.redirectActive(input.runId);
      }
      return result;
    },

    abort(agent: AgentReference, runId: RunId, reason?: JsonValue): Promise<AbortResult> {
      return requestAbort(agent, runId, reason);
    },
    async readRunSnapshot(agent: AgentReference, runId: RunId): Promise<RunSnapshot | undefined> {
      const snapshot = await threadStore.readRunSnapshot({ agent, runId });
      if (snapshot === undefined) {
        return undefined;
      }
      // Runtime adds Agent-facing Tool discrimination after the raw Store Record boundary.
      return Object.freeze({
        ...snapshot,
        toolCalls: Object.freeze(
          snapshot.toolCalls.map((call) =>
            call.providerId === undefined
              ? call
              : Object.freeze({
                  ...call,
                  dynamic: true as const,
                }),
          ),
        ),
      }) as unknown as RunSnapshot;
    },

    async readResult(agent: AgentReference, runId: RunId): Promise<RunResult | undefined> {
      const record = await threadStore.readRunResult({ agent, runId });
      return record?.result;
    },

    execute<Definition extends AgentDefinition>(
      agent: Definition,
      runId: RunId,
      dynamicHooks: readonly HookDefinition[],
    ): Promise<Execution> {
      return coordinator.execute(agent, runId, dynamicHooks);
    },
  });
}
