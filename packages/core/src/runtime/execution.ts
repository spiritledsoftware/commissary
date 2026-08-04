import { StoreError } from "@commissary/store";

import type { AgentDefinition, InstalledAgentData } from "../agent.js";
import type { Contribution } from "../fragment.js";
import type { HookDefinition } from "../hook.js";
import type { AgentReference, RunIdentity } from "../identity.js";
import type { ContextNode, ModelMessage, ModelRequest, ModelResponse } from "../protocol.js";
import { Transcript } from "../protocol.js";
import type { ContextContribution, RuntimeModel } from "../render.js";
import type {
  AbortResult,
  Execution,
  ExecutionEventStore,
  ExecutionResult,
  Clock,
  GenerateId,
  InterruptedExecutionResult,
  Loop,
  ModelInvocation,
  PreparedModelWork,
  PreparedToolCall,
  PreparedToolWork,
  PreparedWork,
  ResolvedExecution,
  RunResult,
  RuntimeOperations,
  SuspendedRunResult,
  ToolExecution,
  UnexpectedExecutionPhase,
} from "../runtime.js";
import {
  ExecutionClaimLostError,
  ExecutionEventStoreError,
  ExecutionUnavailableError,
  UnexpectedExecutionError,
} from "../runtime.js";
import type { ArtifactStore, ExecutionClaim, ExecutionSnapshot, ThreadStore } from "../store.js";
import { ArtifactStoreError } from "../store.js";
import {
  CommitId,
  ExecutionId,
  type JsonValue,
  MessageEntryId,
  type RunId,
  ToolAttemptId,
  ToolCallId,
} from "../types.js";
import {
  AbortExecution,
  ContinueLoop,
  HookBlockedExecution,
  InterruptExecution,
  RedirectModelInvocation,
  RuntimeInvariantError,
} from "./execution-signals.js";
import { isJsonValue } from "./protocol-parsing.js";
import { createHookRuntime, staticHooks } from "./hooks.js";
import { createExecutionEvents } from "./execution-events.js";
import {
  isPreparedToolState,
  type PreparedState,
  type PreparedToolState,
} from "./execution-state.js";
import { createModelRuntime } from "./models.js";
import {
  createToolCatalog,
  createToolRuntime,
  publicSuspensions,
  toolExecutionMode,
} from "./tools.js";

/** Dependencies for one Runtime execution coordinator. */
export interface ExecutionCoordinatorOptions {
  readonly threadStore: ThreadStore;
  readonly artifactStore?: ArtifactStore;
  readonly executionEventStore?: ExecutionEventStore;
  readonly agents: ReadonlyMap<string, InstalledAgentData>;
  readonly loop?: Loop;
  readonly executionClaims?: { readonly leaseDurationMs?: number };
  readonly clock?: Clock;
  readonly generateId?: GenerateId;
  readonly modelEnvironment?: unknown;
  readonly requestAbort: (
    agent: AgentReference,
    runId: RunId,
    reason?: JsonValue,
  ) => Promise<AbortResult>;
}

/** Process-local coordination for claimed Run executions. */
export interface ExecutionCoordinator {
  readonly execute: <Definition extends AgentDefinition>(
    agent: Definition,
    runId: RunId,
    dynamicHooks: readonly HookDefinition[],
  ) => Promise<Execution>;
  readonly abortActive: (runId: RunId, reason?: JsonValue) => void;
  readonly redirectActive: (runId: RunId) => void;
}

function values(
  contributions: readonly Contribution[],
  kind: Contribution["kind"],
): readonly unknown[] {
  return contributions
    .filter((contribution) => contribution.kind === kind)
    .map((contribution) => contribution.value);
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function resultBase(snapshot: ExecutionSnapshot, head: MessageEntryId) {
  return {
    runId: snapshot.run.id,
    threadId: snapshot.run.threadId,
    branchId: snapshot.run.branchId,
    head,
    agent: snapshot.run.agent,
    ...(snapshot.run.usage === undefined ? {} : { usage: snapshot.run.usage }),
  };
}

/** Build the core Runtime behind one Commissary Instance. */
export function createExecutionCoordinator(
  options: ExecutionCoordinatorOptions,
): ExecutionCoordinator {
  const { threadStore, executionEventStore, agents, loop } = options;
  const leaseDurationMs = options.executionClaims?.leaseDurationMs ?? 60_000;
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new RangeError("executionClaims.leaseDurationMs must be finite and positive");
  }
  const clock: Clock = options.clock ?? {
    now: () => Date.now(),
    sleep: wait,
  };
  const generateId = options.generateId ?? (() => globalThis.crypto.randomUUID());
  const newCommitId = () => CommitId.decode(generateId());
  const newExecutionId = () => ExecutionId.decode(generateId());
  const newMessageEntryId = () => MessageEntryId.decode(generateId());
  const newToolAttemptId = () => ToolAttemptId.decode(generateId());
  const newToolCallId = () => ToolCallId.decode(generateId());
  interface ActiveExecution {
    readonly execution: AbortController;
    model?: AbortController;
  }

  const active = new Map<RunId, ActiveExecution>();
  const requestAbort = options.requestAbort;

  return Object.freeze({
    abortActive(runId: RunId, reason?: JsonValue): void {
      active.get(runId)?.execution.abort(new AbortExecution(reason));
    },

    redirectActive(runId: RunId): void {
      active.get(runId)?.model?.abort(new RedirectModelInvocation());
    },

    async execute<Definition extends AgentDefinition>(
      agent: Definition,
      runId: RunId,
      dynamicHooks: readonly HookDefinition[],
    ): Promise<Execution> {
      const installed = agents.get(agent.id);
      if (installed === undefined || installed.definition !== agent) {
        throw new ExecutionUnavailableError(runId, "wrong-agent");
      }

      const executionId = newExecutionId();
      const claimResult = await threadStore.acquireExecutionClaim({
        agent: installed.reference,
        runId,
        executionId,
        leaseDurationMs,
      });
      if (claimResult.type === "run-not-found") {
        throw new ExecutionUnavailableError(runId, "run-not-found");
      }
      if (claimResult.type === "wrong-agent") {
        throw new ExecutionUnavailableError(runId, "wrong-agent");
      }
      if (claimResult.type === "already-claimed") {
        throw new ExecutionUnavailableError(runId, "already-claimed");
      }
      if (claimResult.type === "not-executable") {
        throw new ExecutionUnavailableError(runId, "not-executable");
      }

      let claim: ExecutionClaim = claimResult.claim;
      const initialSnapshot = await threadStore.loadExecution(claim);
      if (initialSnapshot === undefined) {
        await threadStore.releaseExecutionClaim(claim);
        throw new ExecutionUnavailableError(runId, "not-executable");
      }

      const controller = new AbortController();
      const lifecycleController = new AbortController();
      const activeExecution: ActiveExecution = { execution: controller };
      active.set(runId, activeExecution);
      const preparedStates = new WeakMap<object, PreparedState>();
      const resolvedExecutions = new WeakSet<object>();
      function preparedToolState(prepared: PreparedToolWork): PreparedToolState {
        const state = preparedStates.get(prepared);
        if (state === undefined || !isPreparedToolState(state)) {
          throw new RuntimeInvariantError("Tool Work belongs to another Execution");
        }
        return state;
      }
      let currentRun: RunIdentity = Object.freeze({
        runId,
        threadId: initialSnapshot.run.threadId,
        branchId: initialSnapshot.run.branchId,
        agent: installed.reference,
      });
      const hookRuntime = createHookRuntime(
        [...staticHooks(installed.contributions), ...dynamicHooks],
        () => currentRun,
      );
      let currentPhase: UnexpectedExecutionPhase = "prepare";

      const assertActive = (): void => {
        if (!controller.signal.aborted) {
          return;
        }
        if (
          controller.signal.reason instanceof ExecutionClaimLostError ||
          controller.signal.reason instanceof ExecutionEventStoreError
        ) {
          throw controller.signal.reason;
        }
        if (controller.signal.reason instanceof AbortExecution) {
          throw controller.signal.reason;
        }
        throw new AbortExecution(
          isJsonValue(controller.signal.reason) ? controller.signal.reason : undefined,
        );
      };

      const executionEvents = createExecutionEvents({
        runId,
        executionId,
        ...(executionEventStore === undefined ? {} : { store: executionEventStore }),
        clock,
        lifecycleSignal: lifecycleController.signal,
        executionController: controller,
        hooks: hookRuntime,
        getRun: () => currentRun,
      });
      const emit = executionEvents.emit;
      const flushEvents = executionEvents.flush;
      const notify = executionEvents.notify;

      const guarded = <Value>(
        result:
          | { readonly type: "committed"; readonly value: Value }
          | { readonly type: "claim-lost" }
          | { readonly type: "head-changed"; readonly actualHead: MessageEntryId }
          | { readonly type: "abort-requested"; readonly reason?: JsonValue }
          | { readonly type: "not-active"; readonly result?: RunResult },
      ): Value => {
        if (result.type === "committed") {
          return result.value;
        }
        if (result.type === "abort-requested") {
          throw new AbortExecution(result.reason);
        }
        if (result.type === "claim-lost") {
          throw new ExecutionClaimLostError(runId);
        }
        throw new RuntimeInvariantError(
          result.type === "head-changed"
            ? `Branch head changed to '${result.actualHead}' during a fenced transition`
            : "Run became non-active during a fenced transition",
        );
      };

      const load = async (): Promise<ExecutionSnapshot> => {
        const snapshot = await threadStore.loadExecution(claim);
        if (snapshot === undefined) {
          throw new ExecutionClaimLostError(runId);
        }
        return snapshot;
      };
      const modelRuntime = createModelRuntime({
        executionSignal: controller.signal,
        ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
        ...(options.modelEnvironment === undefined
          ? {}
          : { environment: options.modelEnvironment }),
        clock,
        hooks: hookRuntime,
        events: executionEvents,
        getPreparedState: (prepared) => preparedStates.get(prepared),
        setPhase: () => {
          currentPhase = "model";
        },
        assertActive,
        setActiveModel: (modelController) => {
          if (modelController === undefined) {
            delete activeExecution.model;
          } else {
            activeExecution.model = modelController;
          }
        },
        newMessageEntryId: () => newMessageEntryId(),
        recordModelCall: async ({ modelId, usage }) => {
          guarded(
            await threadStore.recordModelCall({
              claim,
              commitId: newCommitId(),
              modelId,
              ...(usage === undefined ? {} : { usage }),
            }),
          );
        },
        commitModelInvocation: async ({ expectedHead, entry, toolCalls }) => {
          const committed = await threadStore.commitModelInvocation({
            claim,
            expectedHead,
            commitId: newCommitId(),
            entry,
            toolCalls,
          });
          if (committed.type === "work-ready") {
            return "work-ready";
          }
          guarded(committed);
          return "committed";
        },
      });
      const invokeModel = modelRuntime.invoke;
      const closeModelSessions = modelRuntime.closeSessions;
      const toolRuntime = createToolRuntime({
        runId,
        installed,
        executionSignal: controller.signal,
        hooks: hookRuntime,
        events: executionEvents,
        getPreparedState: (prepared) => preparedStates.get(prepared),
        setPhase: () => {
          currentPhase = "tool";
        },
        assertActive,
        newToolCallId: () => newToolCallId(),
        newToolAttemptId: () => newToolAttemptId(),
        newMessageEntryId: () => newMessageEntryId(),
        store: {
          recordInterruption: async (interruption) => {
            guarded(await threadStore.recordInterruption({ claim, interruption }));
          },
          loadToolCall: (toolCallId) => threadStore.loadToolCall(claim, toolCallId),
          recordToolInput: async (toolCallId, input) =>
            guarded(await threadStore.recordToolInput({ claim, toolCallId, input })),
          recordDelegatedToolCall: async (input) =>
            guarded(await threadStore.recordDelegatedToolCall({ claim, ...input })),
          completeToolCall: async (toolCallId, result) =>
            guarded(await threadStore.completeToolCall({ claim, toolCallId, result })),
          suspendToolCall: async (toolCallId, continuation, agent) => {
            guarded(
              await threadStore.suspendToolCall({
                claim,
                toolCallId,
                suspension: { continuation, agent },
              }),
            );
          },
          commitToolResults: async (expectedHead, entries) => {
            guarded(
              await threadStore.commitToolResults({
                claim,
                expectedHead,
                commitId: newCommitId(),
                entries,
              }),
            );
          },
        },
      });
      const executeTool = toolRuntime.execute;

      const prepare = async (): Promise<PreparedWork> => {
        currentPhase = "prepare";
        assertActive();
        let snapshot = await load();
        if (snapshot.run.abortRequested) {
          throw new AbortExecution(snapshot.run.abortReason);
        }
        const pendingCommands = [
          ...snapshot.pendingSteering.map((pending) => ({
            type: "steering" as const,
            ...pending,
          })),
          ...snapshot.pendingRedirects.map((pending) => ({
            type: "redirect" as const,
            ...pending,
          })),
        ].sort((left, right) => left.sequence - right.sequence);
        if (
          pendingCommands.length > 0 &&
          !snapshot.toolCalls.some(
            (call) => call.parentToolCallId === undefined && !call.historyCommitted,
          )
        ) {
          const entries = pendingCommands.map((pending) => ({
            id: newMessageEntryId(),
            message: pending.message,
          }));
          const consumedSteering = snapshot.pendingSteering.at(-1);
          const consumedRedirect = snapshot.pendingRedirects.at(-1);
          guarded(
            await threadStore.commitStep({
              claim,
              expectedHead: snapshot.head,
              commitId: newCommitId(),
              entries,
              ...(consumedSteering === undefined
                ? {}
                : { consumedSteeringThrough: consumedSteering.sequence }),
              ...(consumedRedirect === undefined
                ? {}
                : { consumedRedirectsThrough: consumedRedirect.sequence }),
            }),
          );
          snapshot = await load();
        }

        currentRun = Object.freeze({
          runId,
          threadId: snapshot.run.threadId,
          branchId: snapshot.run.branchId,
          agent: installed.reference,
        });
        const pendingToolCalls = snapshot.toolCalls
          .filter((call) => call.parentToolCallId === undefined && !call.historyCommitted)
          .sort((left, right) => left.sequence - right.sequence);
        const catalog = createToolCatalog({
          installed,
          transcript: snapshot.transcript,
          run: currentRun,
          signal: controller.signal,
        });
        const toolsPromise = catalog.prepare(pendingToolCalls);
        const contextPromise: Promise<readonly ContextNode[]> =
          pendingToolCalls.length > 0
            ? Promise.resolve([])
            : Promise.all(
                values(installed.contributions, "context").map((value) => {
                  // SAFETY: values selects only installed Context contributions by their discriminant.
                  const contribution = value as ContextContribution;
                  return Promise.resolve()
                    .then(() =>
                      contribution.render({
                        transcript: snapshot.transcript,
                        run: currentRun,
                        signal: controller.signal,
                      }),
                    )
                    .then((content) => Object.freeze({ id: contribution.id, content }));
                }),
              );
        const [tools, context] = await Promise.all([toolsPromise, contextPromise]);
        const resolveDynamicProvider = catalog.resolveDynamicProvider;
        if (pendingToolCalls.length > 0) {
          const calls = Object.freeze(
            pendingToolCalls.map((call) => {
              // SAFETY: The private map below proves that only this Runtime-created call can authorize execution.
              const preparedCall = Object.freeze({
                type: "tool-call" as const,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.requestedInput,
                ...(call.providerData === undefined ? {} : { providerData: call.providerData }),
              }) as PreparedToolCall;
              return preparedCall;
            }),
          );
          // SAFETY: Runtime creates this opaque capability and keeps its state in preparedStates.
          const prepared = Object.freeze({
            type: "tools" as const,
            run: currentRun,
            transcriptHead: snapshot.head,
            calls,
          }) as PreparedToolWork;
          preparedStates.set(prepared, {
            prepared,
            snapshot,
            run: currentRun,
            tools,
            resolveDynamicProvider,
            outcomes: new Map(),
            executionMode: pendingToolCalls.some((call) => {
              const tool = tools.get(call.toolName);
              return tool !== undefined && toolExecutionMode(tool) === "sequential";
            })
              ? "sequential"
              : "parallel",
          });
          toolRuntime.registerPrepared(prepared);
          return prepared;
        }

        // SAFETY: Agent Installation guarantees exactly one Runtime Model contribution.
        const model = values(installed.contributions, "model")[0] as RuntimeModel;

        const request: ModelRequest = Object.freeze({
          context: Object.freeze(context),
          messages: Transcript.toModelMessages(snapshot.transcript),
          tools: Object.freeze(
            [...tools.values()].map((tool) =>
              tool.type === "static" ? tool.definition.modelTool : tool.modelTool,
            ),
          ),
          providerOptions: Object.freeze([]),
        });
        // SAFETY: Runtime creates this opaque capability and keeps its state in preparedStates.
        const prepared = Object.freeze({
          type: "model" as const,
          run: currentRun,
          transcriptHead: snapshot.head,
        }) as PreparedModelWork;
        preparedStates.set(prepared, {
          prepared,
          snapshot,
          run: currentRun,
          model,
          tools,
          resolveDynamicProvider,
          request,
        });
        return prepared;
      };

      const beforeSettlement = (
        result: Exclude<RunResult, SuspendedRunResult>,
      ): Promise<ModelMessage | undefined> =>
        hookRuntime.beforeSettlement(result, {
          signal: controller.signal,
          clock,
          assertActive,
          emitError: (error) => emit(Object.freeze({ type: "error", error })),
        });

      type FinalizeTerminalResult = RunResult | { readonly type: "work-ready" };

      const finalizeTerminal = async (
        type: "completed" | "failed" | "aborted",
        value: unknown,
      ): Promise<FinalizeTerminalResult> => {
        currentPhase = "finalize";
        const snapshot = await load();
        const entries: Array<{ id: MessageEntryId; message: ModelMessage }> = [];
        if (type === "completed") {
          // SAFETY: completed finalization always receives a Model Response.
          entries.push({
            id: newMessageEntryId(),
            message: (value as ModelResponse).message,
          });
        } else if (type === "aborted") {
          for (const call of snapshot.toolCalls
            .filter(
              (candidate) =>
                candidate.parentToolCallId === undefined &&
                !candidate.historyCommitted &&
                candidate.status !== "succeeded" &&
                candidate.status !== "failed" &&
                candidate.status !== "aborted",
            )
            .sort((left, right) => left.sequence - right.sequence)) {
            entries.push({
              id: newMessageEntryId(),
              message: {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolName: call.toolName,
                    toolCallId: call.toolCallId,
                    output: { type: "aborted" },
                    isFailure: true,
                    ...(call.providerData === undefined ? {} : { providerData: call.providerData }),
                  },
                ],
              },
            });
          }
        }
        const head = entries.at(-1)?.id ?? snapshot.head;
        let result: Exclude<RunResult, SuspendedRunResult>;
        if (type === "completed") {
          // SAFETY: completed finalization always receives a Model Response.
          result = Object.freeze({
            ...resultBase(snapshot, head),
            type,
            response: value as ModelResponse,
          });
        } else if (type === "failed") {
          result = Object.freeze({
            ...resultBase(snapshot, head),
            type,
            failure: value,
          });
        } else {
          // SAFETY: aborted finalization accepts only an optional JSON reason.
          result = Object.freeze({
            ...resultBase(snapshot, head),
            type,
            ...(value === undefined ? {} : { reason: value as JsonValue }),
          });
        }
        if (type !== "aborted") {
          const instruction = await beforeSettlement(result);
          if (instruction !== undefined && snapshot.run.settlementContinuations < 32) {
            const continued = await threadStore.continueSettlement({
              claim,
              expectedHead: snapshot.head,
              commitId: newCommitId(),
              candidateEntries: entries,
              instructionEntry: {
                id: newMessageEntryId(),
                message: instruction,
              },
            });
            if (continued.type === "abort-requested") {
              return finalizeTerminal("aborted", continued.reason);
            }
            if (continued.type === "work-ready") {
              return continued;
            }
            if (continued.type !== "limit-reached") {
              guarded(continued);
              return { type: "work-ready" };
            }
          }
        }
        const committed = await threadStore.finalizeRun({
          claim,
          expectedHead: snapshot.head,
          commitId: newCommitId(),
          entries,
          result,
          ...(type === "aborted" ? { abortUnresolvedTools: true } : {}),
        });
        if (committed.type === "work-ready") {
          return committed;
        }
        if (committed.type === "abort-requested" && type !== "aborted") {
          return finalizeTerminal("aborted", committed.reason);
        }
        return guarded(committed);
      };

      const requireTerminal = (result: FinalizeTerminalResult): RunResult => {
        if (result.type === "work-ready") {
          throw new ContinueLoop();
        }
        return result;
      };

      const recordInterruption = async (
        interruption: InterruptedExecutionResult["interruption"],
      ): Promise<InterruptedExecutionResult> => {
        const result: InterruptedExecutionResult = { type: "interrupted", runId, interruption };
        guarded(await threadStore.recordInterruption({ claim, interruption }));
        return result;
      };

      const settle = async (
        prepared: PreparedWork,
        product: ModelInvocation | ToolExecution,
      ): Promise<ResolvedExecution> => {
        if (!preparedStates.has(prepared)) {
          throw new RuntimeInvariantError("Prepared Work belongs to another Execution");
        }
        let value: ExecutionResult;
        // SAFETY: The ownership check narrows the opaque prepared work and product pair.
        if (modelRuntime.ownsProduct(prepared as PreparedModelWork, product)) {
          // SAFETY: Model Runtime ownership proves this product is a Model invocation.
          const invocation = product as ModelInvocation;
          switch (invocation.type) {
            case "response":
              if (invocation.toolCalls.length > 0 || invocation.response.finishReason === "pause") {
                throw new RuntimeInvariantError(
                  "Cannot settle a Model response with pending Tool work",
                );
              }
              if (invocation.response.finishReason === "tool-calls") {
                throw new RuntimeInvariantError("Model ended for Tool Calls without any Tool Call");
              }
              const result = await finalizeTerminal("completed", invocation.response);
              if (result.type === "work-ready") {
                throw new ContinueLoop();
              }
              value = result;
              break;
            case "failure":
              value = requireTerminal(await finalizeTerminal("failed", invocation.failure));
              break;
            case "interruption":
              value = await recordInterruption(invocation.interruption);
              break;
          }
          // SAFETY: The ownership check narrows the opaque prepared work and product pair.
        } else if (toolRuntime.ownsProduct(prepared as PreparedToolWork, product)) {
          // SAFETY: Tool Runtime ownership proves this product is a Tool execution.
          const execution = product as ToolExecution;
          if (execution.result.type !== "suspended") {
            throw new RuntimeInvariantError(
              "Only a suspended Tool product can settle an Execution",
            );
          }
          const snapshot = await load();
          if (
            snapshot.toolCalls.some(
              (call) =>
                call.parentToolCallId === undefined &&
                !call.historyCommitted &&
                (call.status === "pending" || call.status === "running"),
            )
          ) {
            throw new RuntimeInvariantError(
              "Cannot settle while a top-level Tool Call is still executable",
            );
          }
          const suspensions = publicSuspensions(snapshot);
          if (suspensions.length === 0) {
            throw new RuntimeInvariantError("Cannot settle without a durable Tool Suspension");
          }
          const result: SuspendedRunResult = {
            ...resultBase(snapshot, snapshot.head),
            type: "suspended",
            suspensions,
          };
          const stored = await threadStore.suspendRun({
            claim,
            expectedHead: snapshot.head,
            result,
          });
          if (stored.type === "work-ready") {
            throw new RuntimeInvariantError("Cannot settle while Tool resume work is ready");
          }
          value = guarded(stored);
        } else {
          throw new RuntimeInvariantError(
            "Settlement product belongs to another Runtime Operation",
          );
        }
        // SAFETY: Runtime creates this opaque resolved product and records it below.
        const resolved = Object.freeze({ value }) as ResolvedExecution;
        resolvedExecutions.add(resolved);
        return resolved;
      };

      const runtimeOperations: RuntimeOperations = Object.freeze({
        prepare,
        invokeModel,
        executeTool,
        settle,
      });

      const defaultMachine = async (): Promise<ExecutionResult> => {
        while (true) {
          assertActive();
          const prepared = await prepare();
          if (prepared.type === "tools") {
            const state = preparedToolState(prepared);
            let executions: ToolExecution[];
            if (state.executionMode === "sequential") {
              executions = [];
              for (const call of prepared.calls) {
                executions.push(await executeTool(prepared, call));
              }
            } else {
              executions = await Promise.all(
                prepared.calls.map((call) => executeTool(prepared, call)),
              );
            }
            const suspended = executions.find((execution) => execution.result.type === "suspended");
            if (suspended === undefined) {
              continue;
            }
            const snapshot = await load();
            if (
              !snapshot.toolCalls.some(
                (call) => call.parentToolCallId === undefined && !call.historyCommitted,
              )
            ) {
              continue;
            }

            const suspensions = publicSuspensions(snapshot);
            if (suspensions.length > 0) {
              const suspended: SuspendedRunResult = {
                ...resultBase(snapshot, snapshot.head),
                type: "suspended",
                suspensions,
              };
              const result = await threadStore.suspendRun({
                claim,
                expectedHead: snapshot.head,
                result: suspended,
              });
              if (result.type === "work-ready") {
                continue;
              }
              return guarded(result);
            }
            continue;
          }

          const invocation = await invokeModel(prepared);
          if (invocation.type === "failure") {
            return requireTerminal(await finalizeTerminal("failed", invocation.failure));
          }
          if (invocation.type === "interruption") {
            return recordInterruption(invocation.interruption);
          }
          if (invocation.toolCalls.length > 0 || invocation.response.finishReason === "pause") {
            continue;
          }
          if (invocation.response.finishReason === "tool-calls") {
            throw new RuntimeInvariantError("Model ended for Tool Calls without any Tool Call");
          }
          const terminal = await finalizeTerminal("completed", invocation.response);
          if (terminal.type === "work-ready") {
            continue;
          }
          return terminal;
        }
      };

      const renewals = (async () => {
        while (!lifecycleController.signal.aborted) {
          try {
            await clock.sleep(leaseDurationMs / 2, lifecycleController.signal);
          } catch (cause) {
            if (!lifecycleController.signal.aborted) {
              controller.abort(new ExecutionClaimLostError(runId, cause));
            }
            return;
          }
          let renewal;
          try {
            renewal = await threadStore.renewExecutionClaim({ claim, leaseDurationMs });
          } catch (cause) {
            controller.abort(new ExecutionClaimLostError(runId, cause));
            return;
          }
          if (renewal.type === "renewed") {
            claim = renewal.claim;
          } else if (renewal.type === "abort-requested") {
            controller.abort(new AbortExecution(renewal.reason));
            return;
          } else {
            controller.abort(new ExecutionClaimLostError(runId));
            return;
          }
        }
      })();

      const controlWatch =
        threadStore.waitForExecutionControl === undefined
          ? Promise.resolve()
          : threadStore
              .waitForExecutionControl({
                claim,
                signal: lifecycleController.signal,
              })
              .then((control) => {
                if (control.type === "abort-requested") {
                  controller.abort(new AbortExecution(control.reason));
                } else {
                  controller.abort(new ExecutionClaimLostError(runId));
                }
              })
              .catch((cause) => {
                if (!lifecycleController.signal.aborted) {
                  controller.abort(new ExecutionClaimLostError(runId, cause));
                }
              });

      const runExecution = async (): Promise<ExecutionResult> => {
        executionLoop: while (true) {
          let settled: ExecutionResult;
          try {
            if (loop !== undefined) {
              while (true) {
                currentPhase = "loop";
                try {
                  const resolved = await loop.execute({
                    runId,
                    agent,
                    // SAFETY: Runtime Operations preserve the Agent definition through opaque products.
                    runtime: runtimeOperations as unknown as RuntimeOperations<Definition>,
                    signal: controller.signal,
                  });
                  if (
                    typeof resolved !== "object" ||
                    resolved === null ||
                    !resolvedExecutions.has(resolved)
                  ) {
                    throw new RuntimeInvariantError(
                      "Loop returned without a Runtime-created resolved Execution",
                    );
                  }
                  settled = resolved.value;
                  break;
                } catch (cause) {
                  if (cause instanceof ContinueLoop) {
                    continue;
                  }
                  throw cause;
                }
              }
            } else {
              settled = await defaultMachine();
            }
            currentPhase = "loop";
            await closeModelSessions();
            await flushEvents();
            await notify("onSettlement", { run: currentRun, result: settled });
            return settled;
          } catch (cause) {
            if (cause instanceof ContinueLoop) {
              continue;
            }
            let restarting = false;
            try {
              if (
                cause instanceof AbortExecution ||
                controller.signal.reason instanceof AbortExecution
              ) {
                const reason =
                  cause instanceof AbortExecution ? cause.reason : controller.signal.reason.reason;
                settled = requireTerminal(await finalizeTerminal("aborted", reason));
                await closeModelSessions();
                await flushEvents();
                await notify("onSettlement", { run: currentRun, result: settled });
                return settled;
              }
              if (cause instanceof InterruptExecution) {
                settled = cause.result;
                await closeModelSessions();
                await flushEvents();
                await notify("onSettlement", { run: currentRun, result: settled });
                return settled;
              }
              if (cause instanceof HookBlockedExecution) {
                const terminal = await finalizeTerminal("failed", {
                  type: "hook-blocked",
                  point: cause.point,
                  failure: cause.failure,
                });
                if (terminal.type === "work-ready") {
                  restarting = true;
                  continue executionLoop;
                }
                settled = terminal;
                await closeModelSessions();
                await flushEvents();
                await notify("onSettlement", { run: currentRun, result: settled });
                return settled;
              }
              const eventStoreError =
                cause instanceof ExecutionEventStoreError
                  ? cause
                  : controller.signal.reason instanceof ExecutionEventStoreError
                    ? controller.signal.reason
                    : undefined;
              const error =
                eventStoreError ??
                (cause instanceof ExecutionClaimLostError ||
                cause instanceof StoreError ||
                cause instanceof ArtifactStoreError ||
                cause instanceof UnexpectedExecutionError
                  ? cause
                  : new UnexpectedExecutionError(currentPhase, cause));
              if (!(error instanceof ExecutionEventStoreError)) {
                await emit(Object.freeze({ type: "error", error }));
              }
              throw error;
            } finally {
              if (!restarting) {
                try {
                  await closeModelSessions();
                } catch {
                  // Preserve the first Execution error.
                }
              }
            }
          }
        }
      };

      const cleanupExecution = async (): Promise<unknown> => {
        lifecycleController.abort();
        let failure: unknown;
        try {
          await Promise.all([renewals, controlWatch]);
        } catch (cause) {
          failure = cause;
        }
        try {
          await threadStore.releaseExecutionClaim(claim);
        } catch (cause) {
          failure ??= cause;
        }
        active.delete(runId);
        return failure;
      };

      const result = Promise.resolve().then(async (): Promise<ExecutionResult> => {
        const outcome = await runExecution().then(
          (value) => ({ type: "success" as const, value }),
          (cause: unknown) => ({ type: "failure" as const, cause }),
        );
        const cleanupFailure = await cleanupExecution();
        if (outcome.type === "failure") {
          throw outcome.cause;
        }
        if (cleanupFailure !== undefined) {
          const error =
            cleanupFailure instanceof StoreError
              ? cleanupFailure
              : new UnexpectedExecutionError("finalize", cleanupFailure);
          await emit(Object.freeze({ type: "error", error }));
          throw error;
        }
        return outcome.value;
      });

      return Object.freeze({
        id: executionId,
        runId,
        result,
        abort(reason?: JsonValue) {
          return requestAbort(installed.reference, runId, reason);
        },
      });
    },
  });
}
