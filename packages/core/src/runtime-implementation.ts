import { Effect } from "effect";

import type { AgentDefinition, InstalledAgentData } from "./agent.js";
import type { Contribution } from "./fragment.js";
import type { HookBlock, HookPoint } from "./hook.js";
import type { AgentReference, RunIdentity } from "./identity.js";
import type {
  ContextNode,
  EncodedProviderData,
  ModelCapability,
  ModelSession,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ToolCallContentPart,
} from "./protocol.js";
import { Transcript } from "./protocol.js";
import type { ContextContribution } from "./render.js";
import type {
  AbortResult,
  AdmitInput,
  AdmitResult,
  AttemptOutcome,
  Driver,
  ExecutionAttempt,
  FinalizeDecision,
  InterruptedAttemptOutcome,
  ModelInvocation,
  PreparedRun,
  ResumeInput,
  ResumeResult,
  RunResult,
  Runtime,
  RuntimeOperations,
  Signal as RuntimeSignal,
  SteeringResult,
  SteerInput,
  ToolExecution,
} from "./runtime.js";
import { singleConsumer } from "./runtime.js";
import { validateSchema } from "./schema.js";
import type {
  ArtifactStore,
  ExecutionClaim,
  ExecutionSnapshot,
  StoredToolSuspension,
  ThreadStore,
} from "./store.js";
import {
  isToolFailure,
  isToolSuspension,
  toolFailureValue,
  toolSuspensionValue,
  type DynamicTool,
  type DynamicToolProvider,
  type ToolRuntimeDefinition,
} from "./tool.js";
import type {
  AttemptId,
  CommitId,
  JsonValue,
  MessageEntryId,
  RunId,
  ToolAttemptId,
} from "./types.js";

interface RuntimeOptions {
  readonly threadStore: ThreadStore;
  readonly artifactStore?: ArtifactStore;
  readonly agents: ReadonlyMap<string, InstalledAgentData>;
  readonly driver?: Driver;
  readonly claimDurationMs?: number;
  readonly modelEnvironment?: unknown;
}

interface RuntimeHook {
  readonly point: HookPoint<string, unknown, unknown>;
  readonly handler: (event: unknown) => PromiseLike<unknown> | unknown;
}

type RuntimeTool =
  | { readonly type: "static"; readonly definition: ToolRuntimeDefinition }
  | { readonly type: "dynamic"; readonly definition: DynamicTool };

interface PreparedState {
  readonly prepared: PreparedRun;
  readonly installed: InstalledAgentData;
  readonly snapshot: ExecutionSnapshot;
  readonly run: RunIdentity;
  readonly model: ModelCapability;
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly hooks: readonly RuntimeHook[];
  readonly request: ModelRequest;
  lastResponse?: ModelResponse;
}

type ToolResultState =
  | { readonly type: "success"; readonly value: JsonValue }
  | { readonly type: "failure"; readonly failure: unknown }
  | {
      readonly type: "suspension";
      readonly publicValue: {
        readonly toolName: string;
        readonly toolCallId: ToolCallContentPart["toolCallId"];
      };
      readonly stored: StoredToolSuspension;
    };

interface ToolExecutionState {
  readonly result: ToolResultState;
  readonly providerData?: readonly EncodedProviderData[];
}

class RuntimeInvariantError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "RuntimeInvariantError";
  }
}

export class ExecutionUnavailableError extends Error {
  constructor(
    readonly runId: RunId,
    readonly reason: string,
  ) {
    super(`Run '${runId}' cannot execute: ${reason}`);
    this.name = "ExecutionUnavailableError";
  }
}

export class ClaimLostError extends Error {
  constructor(
    readonly runId: RunId,
    readonly cause?: unknown,
  ) {
    super(`Execution Claim for Run '${runId}' was lost`, { cause });
    this.name = "ClaimLostError";
  }
}

class AbortExecution {
  constructor(readonly reason?: JsonValue) {}
}

class InterruptExecution {
  constructor(readonly outcome: InterruptedAttemptOutcome) {}
}

class HookBlockedExecution {
  constructor(
    readonly point: string,
    readonly failure: unknown,
  ) {}
}

class AsyncQueue<Value> implements AsyncIterable<Value> {
  readonly #values: Value[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<Value>) => void;
    readonly reject: (cause: unknown) => void;
  }> = [];
  #closed = false;
  #failure: unknown;

  push(value: Value): void {
    if (this.#closed) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#values.push(value);
    } else {
      waiter.resolve({ done: false, value });
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(cause: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#failure = cause;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Value> {
    return {
      next: (): Promise<IteratorResult<Value>> => {
        const value = this.#values.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }
        if (this.#failure !== undefined) {
          return Promise.reject(this.#failure);
        }
        if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<Value>>();
        this.#waiters.push({ resolve, reject });
        return promise;
      },
    };
  }
}

function newId<Id extends string>(): Id {
  return globalThis.crypto.randomUUID() as Id;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }
  return Object.entries(value).every(([, child]) => child !== undefined && isJsonValue(child));
}

function values(
  contributions: readonly Contribution[],
  kind: Contribution["kind"],
): readonly unknown[] {
  return contributions
    .filter((contribution) => contribution.kind === kind)
    .map((contribution) => contribution.value);
}

function hooksOf(contributions: readonly Contribution[]): readonly RuntimeHook[] {
  return values(contributions, "hook") as readonly RuntimeHook[];
}

async function notify(
  hooks: readonly RuntimeHook[],
  pointName: string,
  event: unknown,
): Promise<void> {
  for (const hook of hooks) {
    if (hook.point.name === pointName) {
      await hook.handler(event);
    }
  }
}

async function transformModelRequest(
  hooks: readonly RuntimeHook[],
  run: RunIdentity,
  request: ModelRequest,
  signal: AbortSignal,
): Promise<ModelRequest> {
  let current = request;
  for (const hook of hooks) {
    if (hook.point.name !== "beforeModelRequest") {
      continue;
    }
    const result = (await hook.handler({
      run,
      request: current,
      signal,
    })) as { readonly request?: ModelRequest } | HookBlock | undefined;
    if (result !== undefined && "type" in result && result.type === "block") {
      throw new HookBlockedExecution("beforeModelRequest", result.failure);
    }
    if (result !== undefined && "request" in result && result.request !== undefined) {
      current = result.request;
    }
  }
  return current;
}

async function transformToolInput(
  hooks: readonly RuntimeHook[],
  run: RunIdentity,
  toolName: string,
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  let current = input;
  for (const hook of hooks) {
    if (hook.point.name !== "beforeToolExecution") {
      continue;
    }
    const result = (await hook.handler({
      run,
      toolName,
      input: current,
      signal,
    })) as { readonly input?: unknown } | HookBlock | undefined;
    if (result !== undefined && "type" in result && result.type === "block") {
      throw new HookBlockedExecution("beforeToolExecution", result.failure);
    }
    if (result !== undefined && "input" in result) {
      current = result.input;
    }
  }
  return current;
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AbortExecution(isJsonValue(signal.reason) ? signal.reason : undefined);
  }
}

function waitForClaimRenewal(claim: ExecutionClaim, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  const delayMs = Math.max(1, Math.floor((claim.expiresAt - Date.now()) / 2));
  return new Promise((resolve) => {
    const finish = (elapsed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(elapsed);
    };
    const onAbort = () => {
      finish(false);
    };
    const timer = setTimeout(() => {
      finish(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function runWithEffect<Value>(evaluate: () => Promise<Value>): Promise<Value> {
  const result = await Effect.runPromise(
    Effect.promise(async () => {
      try {
        return { succeeded: true as const, value: await evaluate() };
      } catch (cause) {
        return { succeeded: false as const, cause };
      }
    }),
  );
  if (!result.succeeded) {
    throw result.cause;
  }
  return result.value;
}

export function makeRuntime(options: RuntimeOptions): Runtime {
  const { threadStore, agents, driver } = options;
  const claimDurationMs = options.claimDurationMs ?? 60_000;
  const active = new Map<RunId, AbortController>();

  return Object.freeze({
    threadStore,

    async admit(agent: AgentReference, input: AdmitInput): Promise<AdmitResult> {
      return threadStore.admitRun({
        runId: newId<RunId>(),
        entryId: newId<MessageEntryId>(),
        commitId: newId<CommitId>(),
        agent,
        ...input,
      });
    },

    async resume(input: ResumeInput): Promise<ResumeResult> {
      const suspension = await threadStore.readToolSuspension(input.runId);
      if (suspension === undefined || suspension.toolName !== input.toolName) {
        return { type: "not-suspended", runId: input.runId };
      }
      const installed = agents.get(suspension.agent.id);
      const contribution = installed?.contributions.find(
        (candidate) => candidate.kind === "tool" && candidate.id === input.toolName,
      );
      const tool = contribution?.value as ToolRuntimeDefinition | undefined;
      if (tool?.suspension === undefined) {
        return { type: "not-suspended", runId: input.runId };
      }
      const encodedInput = await tool.suspension.resumeInput.encode(input.input);
      return threadStore.admitToolResume({
        runId: input.runId,
        toolName: input.toolName,
        encodedInput,
        ...(input.toolResumeRequestId === undefined
          ? {}
          : { toolResumeRequestId: input.toolResumeRequestId }),
      });
    },

    async steer(input: SteerInput): Promise<SteeringResult> {
      return threadStore.acceptSteering(input);
    },

    async abort(runId: RunId, reason?: JsonValue): Promise<AbortResult> {
      const result = await threadStore.requestAbort({
        runId,
        ...(reason === undefined ? {} : { reason }),
      });
      active.get(runId)?.abort(reason);
      return result;
    },

    async readResult(runId: RunId): Promise<RunResult | undefined> {
      return threadStore.readRunResult(runId);
    },

    async execute<Agent extends AgentDefinition>(
      agent: Agent,
      runId: RunId,
    ): Promise<ExecutionAttempt<unknown>> {
      const installed = agents.get(agent.id);
      if (installed === undefined || installed.definition !== agent) {
        throw new ExecutionUnavailableError(runId, "Agent is not registered");
      }
      const attemptId = newId<AttemptId>();
      const claimResult = await threadStore.acquireExecutionClaim({
        runId,
        attemptId,
        expiresAt: Date.now() + claimDurationMs,
      });
      if (claimResult.type !== "acquired") {
        throw new ExecutionUnavailableError(runId, claimResult.type);
      }

      let claim = claimResult.claim;
      const controller = new AbortController();
      const queue = new AsyncQueue<RuntimeSignal<unknown>>();
      active.set(runId, controller);
      const preparedStates = new WeakMap<object, PreparedState>();
      const toolStates = new WeakMap<object, ToolExecutionState>();
      let latestPrepared: PreparedRun | undefined;
      let latestRun: RunIdentity | undefined;
      let acquiredModelSession: ModelSession | undefined;
      let modelSessionPromise: Promise<ModelSession> | undefined;
      const renewalController = new AbortController();
      const renewal = (async () => {
        while (await waitForClaimRenewal(claim, renewalController.signal)) {
          let renewed: ExecutionClaim | undefined;
          try {
            renewed = await threadStore.renewExecutionClaim({
              claim,
              expiresAt: Date.now() + claimDurationMs,
            });
          } catch (cause) {
            controller.abort(new ClaimLostError(runId, cause));
            return;
          }
          if (renewed === undefined) {
            controller.abort(new ClaimLostError(runId));
            return;
          }
          claim = renewed;
        }
      })();

      const acquireModelSession = (model: ModelCapability): Promise<ModelSession> => {
        if (model.acquire === undefined) {
          return Promise.resolve(model);
        }
        modelSessionPromise ??= Promise.resolve(
          model.acquire({
            signal: controller.signal,
            ...(options.artifactStore === undefined
              ? {}
              : { artifactStore: options.artifactStore }),
            ...(options.modelEnvironment === undefined
              ? {}
              : { environment: options.modelEnvironment }),
          }),
        ).then((session) => {
          acquiredModelSession = session;
          return session;
        });
        return modelSessionPromise;
      };

      const emit = async (signal: RuntimeSignal<unknown>): Promise<void> => {
        if (latestRun === undefined) {
          throw new RuntimeInvariantError("Cannot emit an Execution Signal before preparation");
        }
        queue.push(Object.freeze(signal));
        if (signal.type === "model-event") {
          await notify(hooksOf(installed.contributions), "onModelEvent", {
            run: latestRun,
            event: signal.event,
          });
        }
        await notify(hooksOf(installed.contributions), "onSignal", {
          run: latestRun,
          signal,
        });
      };

      const prepare = async (): Promise<PreparedRun> => {
        assertActive(controller.signal);
        let snapshot = await threadStore.loadExecution(claim);
        if (snapshot === undefined) {
          throw new ClaimLostError(runId);
        }
        if (snapshot.run.agent.id !== installed.reference.id) {
          throw new ExecutionUnavailableError(
            runId,
            `Run belongs to Agent '${snapshot.run.agent.id}', not '${installed.reference.id}'`,
          );
        }

        if (snapshot.pendingSteering.length > 0) {
          const entries = snapshot.pendingSteering.map((pending) => ({
            id: newId<MessageEntryId>(),
            message: pending.message,
          }));
          const committed = await threadStore.commitStep({
            claim,
            expectedHead: snapshot.head,
            commitId: newId<CommitId>(),
            entries,
            consumedSteeringThrough: snapshot.pendingSteering.at(-1)!.sequence,
          });
          if (committed.type !== "committed") {
            throw new ClaimLostError(runId);
          }
          snapshot = await threadStore.loadExecution(claim);
          if (snapshot === undefined) {
            throw new ClaimLostError(runId);
          }
        }

        const run: RunIdentity = Object.freeze({
          runId,
          threadId: snapshot.run.threadId,
          branchId: snapshot.run.branchId,
          agent: installed.reference,
        });
        latestRun = run;
        const hooks = hooksOf(installed.contributions);
        const context: ContextNode[] = [];
        for (const value of values(installed.contributions, "context")) {
          const contribution = value as ContextContribution;
          const content = await contribution.render({
            transcript: snapshot.transcript,
            run,
            signal: controller.signal,
          });
          context.push(Object.freeze({ id: contribution.id, content }));
        }

        const model = values(installed.contributions, "model")[0] as ModelCapability;
        const tools = new Map<string, RuntimeTool>();
        for (const contribution of installed.contributions) {
          if (contribution.kind !== "tool") {
            continue;
          }
          if (contribution.id.startsWith("dynamic:")) {
            const provider = contribution.value as DynamicToolProvider<string>;
            for (const dynamic of await provider.resolve({
              transcript: snapshot.transcript,
              run,
              signal: controller.signal,
            })) {
              if (tools.has(dynamic.definition.name)) {
                throw new RuntimeInvariantError(
                  `Dynamic Tool '${dynamic.definition.name}' conflicts with another Tool`,
                );
              }
              tools.set(dynamic.definition.name, {
                type: "dynamic",
                definition: dynamic,
              });
            }
          } else {
            const definition = contribution.value as ToolRuntimeDefinition;
            tools.set(definition.name, { type: "static", definition });
          }
        }

        const request: ModelRequest = Object.freeze({
          context: Object.freeze(context),
          messages: Transcript.toModelMessages(snapshot.transcript),
          tools: Object.freeze(
            [...tools.values()].map((tool) =>
              tool.type === "static" ? tool.definition.modelTool : tool.definition.definition,
            ),
          ),
          providerOptions: Object.freeze([]),
        });
        const prepared = Object.freeze({
          run,
          transcriptHead: snapshot.head,
        }) as PreparedRun;
        preparedStates.set(prepared, {
          prepared,
          installed,
          snapshot,
          run,
          model,
          tools,
          hooks,
          request,
        });
        latestPrepared = prepared;
        return prepared;
      };

      const invokeModel = async (prepared: PreparedRun): Promise<ModelInvocation> => {
        const state = preparedStates.get(prepared);
        if (state === undefined) {
          throw new RuntimeInvariantError("Prepared Run belongs to another execution");
        }
        assertActive(controller.signal);
        const request = await transformModelRequest(
          state.hooks,
          state.run,
          state.request,
          controller.signal,
        );
        const modelSession = await acquireModelSession(state.model);
        const stream = await modelSession.invoke(request, {
          signal: controller.signal,
        });
        let response: ModelResponse | undefined;
        for await (const event of stream) {
          assertActive(controller.signal);
          await emit({ type: "model-event", event });
          if (event.type === "text-delta") {
            await emit({ type: "model-text-delta", delta: event.delta });
          } else if (event.type === "finish") {
            if (response !== undefined) {
              throw new RuntimeInvariantError("Model emitted more than one finish event");
            }
            response = event.response;
          } else if (event.type === "failure") {
            return Object.freeze({
              type: "failure",
              failure: event.failure,
            }) as ModelInvocation;
          } else if (event.type === "interruption") {
            const outcome: InterruptedAttemptOutcome = {
              type: "interrupted",
              runId,
              interruption: event.interruption,
            };
            const recorded = await threadStore.recordInterruption({
              claim,
              interruption: event.interruption,
            });
            if (recorded.type !== "committed") {
              throw new ClaimLostError(runId);
            }
            throw new InterruptExecution(outcome);
          }
        }
        assertActive(controller.signal);
        if (response === undefined) {
          throw new RuntimeInvariantError("Model stream ended without a finish event");
        }
        state.lastResponse = response;
        const toolCalls: ToolCallContentPart[] = [];
        for (const call of response.message.content.filter(
          (part): part is ToolCallContentPart => part.type === "tool-call",
        )) {
          const tool = state.tools.get(call.toolName);
          if (tool === undefined) {
            throw new RuntimeInvariantError(`Model requested unknown Tool '${call.toolName}'`);
          }
          const owner = tool.type === "dynamic" ? "commissary" : tool.definition.execution;
          if (owner === "provider") {
            if (call.providerExecuted !== true) {
              throw new RuntimeInvariantError(
                `Provider Tool '${call.toolName}' was returned without provider execution`,
              );
            }
            continue;
          }
          if (call.providerExecuted === true) {
            throw new RuntimeInvariantError(
              `Tool '${call.toolName}' was unexpectedly executed by the provider`,
            );
          }
          toolCalls.push(call);
        }
        return Object.freeze({
          type: "response",
          response,
          toolCalls,
        }) as unknown as ModelInvocation;
      };

      const executeTool = async (
        prepared: PreparedRun,
        call: ToolCallContentPart,
      ): Promise<ToolExecution> => {
        const state = preparedStates.get(prepared);
        if (state === undefined) {
          throw new RuntimeInvariantError("Prepared Run belongs to another execution");
        }
        const tool = state.tools.get(call.toolName);
        if (tool === undefined) {
          throw new RuntimeInvariantError(`Model requested unknown Tool '${call.toolName}'`);
        }
        assertActive(controller.signal);
        await emit({
          type: "tool-started",
          toolName: call.toolName,
          toolCallId: call.toolCallId,
        });
        const context = Object.freeze({
          runId,
          toolCallId: call.toolCallId,
          toolAttemptId: newId<ToolAttemptId>(),
          idempotencyKey: `${runId}:${call.toolCallId}`,
          signal: controller.signal,
          emit: async (value: unknown) => {
            await emit({
              type: "tool-signal",
              toolName: call.toolName,
              value,
            });
          },
        });

        const transformedInput = await transformToolInput(
          state.hooks,
          state.run,
          call.toolName,
          call.input,
          controller.signal,
        );
        let result: unknown;
        if (tool.type === "dynamic") {
          result = await tool.definition.execute(transformedInput, context);
        } else {
          if (tool.definition.execution === "provider" || tool.definition.handler === undefined) {
            throw new RuntimeInvariantError(
              `Provider Tool '${call.toolName}' cannot create a Commissary Tool Attempt`,
            );
          }
          const input = await validateSchema(tool.definition.input, transformedInput);
          result = await tool.definition.handler(input, context);
        }

        let toolResult: ToolResultState;
        if (isToolFailure(result)) {
          toolResult = { type: "failure", failure: toolFailureValue(result) };
        } else if (isToolSuspension(result)) {
          if (tool.type !== "static" || tool.definition.suspension === undefined) {
            throw new RuntimeInvariantError(
              `Tool '${call.toolName}' suspended without a suspension contract`,
            );
          }
          const continuation = await tool.definition.suspension.continuation.encode(
            toolSuspensionValue(result),
          );
          toolResult = {
            type: "suspension",
            publicValue: {
              toolName: call.toolName,
              toolCallId: call.toolCallId,
            },
            stored: {
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              agent: installed.reference,
              compatibility: installed.reference.revision,
              continuation,
              ...(call.providerData === undefined ? {} : { providerData: call.providerData }),
            },
          };
        } else {
          const output =
            tool.type === "static" ? await validateSchema(tool.definition.output, result) : result;
          if (!isJsonValue(output)) {
            throw new RuntimeInvariantError(`Tool '${call.toolName}' returned a non-JSON output`);
          }
          toolResult = { type: "success", value: output };
        }

        await emit({
          type: "tool-finished",
          toolName: call.toolName,
          toolCallId: call.toolCallId,
        });
        const execution = Object.freeze({
          toolName: call.toolName,
          toolCallId: call.toolCallId,
        }) as ToolExecution;
        toolStates.set(execution, {
          result: toolResult,
          ...(call.providerData === undefined ? {} : { providerData: call.providerData }),
        });
        return execution;
      };

      const resumeTool = async (prepared: PreparedRun): Promise<ToolExecution> => {
        const state = preparedStates.get(prepared);
        if (state === undefined) {
          throw new RuntimeInvariantError("Prepared Run belongs to another execution");
        }
        const suspension = state.snapshot.suspension;
        if (suspension?.resumeInput === undefined) {
          throw new RuntimeInvariantError("Run has no admitted Tool Resume input");
        }
        if (suspension.agent.revision !== installed.reference.revision) {
          const interruption: InterruptedAttemptOutcome = {
            type: "interrupted",
            runId,
            interruption: {
              type: "stale-agent",
              expected: suspension.agent,
              installed: installed.reference,
              toolName: suspension.toolName,
              detail: "Suspended Tool was created by an incompatible Agent Revision",
            },
          };
          const recorded = await threadStore.recordInterruption({
            claim,
            interruption: interruption.interruption,
          });
          if (recorded.type !== "committed") {
            throw new ClaimLostError(runId);
          }
          throw new InterruptExecution(interruption);
        }
        const contribution = installed.contributions.find(
          (candidate) => candidate.kind === "tool" && candidate.id === suspension.toolName,
        );
        const tool = contribution?.value as ToolRuntimeDefinition | undefined;
        if (tool?.suspension === undefined) {
          throw new RuntimeInvariantError(
            `Suspended Tool '${suspension.toolName}' is not installed as resumable`,
          );
        }
        const continuation = await tool.suspension.continuation.decode(suspension.continuation);
        const input = await tool.suspension.resumeInput.decode(suspension.resumeInput);
        const call: ToolCallContentPart = {
          type: "tool-call",
          toolName: suspension.toolName,
          toolCallId: suspension.toolCallId,
          input: suspension.resumeInput,
          ...(suspension.providerData === undefined
            ? {}
            : { providerData: suspension.providerData }),
        };
        const context = Object.freeze({
          runId,
          toolCallId: suspension.toolCallId,
          toolAttemptId: newId<ToolAttemptId>(),
          idempotencyKey: `${runId}:${suspension.toolCallId}`,
          signal: controller.signal,
          emit: async (value: unknown) => {
            await emit({
              type: "tool-signal",
              toolName: suspension.toolName,
              value,
            });
          },
        });
        const result = await tool.suspension.resume({ input, continuation }, context);

        let toolResult: ToolResultState;
        if (isToolFailure(result)) {
          toolResult = { type: "failure", failure: toolFailureValue(result) };
        } else if (isToolSuspension(result)) {
          const encodedContinuation = await tool.suspension.continuation.encode(
            toolSuspensionValue(result),
          );
          toolResult = {
            type: "suspension",
            publicValue: {
              toolName: suspension.toolName,
              toolCallId: suspension.toolCallId,
            },
            stored: {
              ...suspension,
              continuation: encodedContinuation,
              resumeInput: undefined,
              agent: installed.reference,
              compatibility: installed.reference.revision,
            },
          };
        } else {
          const output = await validateSchema(tool.output, result);
          if (!isJsonValue(output)) {
            throw new RuntimeInvariantError(
              `Tool '${suspension.toolName}' returned a non-JSON output`,
            );
          }
          toolResult = { type: "success", value: output };
        }
        const execution = Object.freeze({
          toolName: call.toolName,
          toolCallId: call.toolCallId,
        }) as ToolExecution;
        toolStates.set(execution, {
          result: toolResult,
          ...(suspension.providerData === undefined
            ? {}
            : { providerData: suspension.providerData }),
        });
        return execution;
      };

      const finalize = async <Failure, Suspension>(
        prepared: PreparedRun,
        decision: FinalizeDecision<Failure, Suspension>,
      ): Promise<RunResult<Failure, Suspension>> => {
        const state = preparedStates.get(prepared);
        if (state === undefined) {
          throw new RuntimeInvariantError("Prepared Run belongs to another execution");
        }
        const entries: Array<{ id: MessageEntryId; message: ModelMessage }> = [];
        if (decision.type === "completed") {
          entries.push({
            id: newId<MessageEntryId>(),
            message: decision.response.message,
          });
        }
        const head = entries.at(-1)?.id ?? state.snapshot.head;
        const base = {
          runId,
          threadId: state.snapshot.run.threadId,
          branchId: state.snapshot.run.branchId,
          head,
          agent: installed.reference,
        };
        let result: RunResult<Failure, Suspension>;
        switch (decision.type) {
          case "completed":
            result = Object.freeze({
              ...base,
              type: "completed",
              response: decision.response,
            });
            break;
          case "suspended":
            result = Object.freeze({
              ...base,
              type: "suspended",
              suspension: decision.suspension,
            });
            break;
          case "failed":
            result = Object.freeze({
              ...base,
              type: "failed",
              failure: decision.failure,
            });
            break;
          case "aborted":
            result = Object.freeze({
              ...base,
              type: "aborted",
              ...(decision.reason === undefined ? {} : { reason: decision.reason }),
            });
            break;
        }
        const committed = await threadStore.finalizeRun({
          claim,
          expectedHead: state.snapshot.head,
          commitId: newId<CommitId>(),
          entries,
          result,
        });
        if (committed.type === "committed") {
          return committed.value as RunResult<Failure, Suspension>;
        }
        if (committed.type === "not-active" && committed.result !== undefined) {
          return committed.result as RunResult<Failure, Suspension>;
        }
        throw new ClaimLostError(runId);
      };

      const operations: RuntimeOperations = Object.freeze({
        prepare,
        invokeModel,
        executeTool,
        resumeTool,
        finalize,
      });

      const defaultExecute = async (): Promise<AttemptOutcome> => {
        let prepared = await prepare();
        const initial = preparedStates.get(prepared)!;
        if (initial.snapshot.suspension?.resumeInput !== undefined) {
          const execution = await resumeTool(prepared);
          const state = toolStates.get(execution)!;
          if (state.result.type === "failure") {
            return finalize(prepared, {
              type: "failed",
              failure: state.result.failure,
            });
          }
          if (state.result.type === "suspension") {
            const suspended: RunResult = Object.freeze({
              type: "suspended",
              runId,
              threadId: initial.snapshot.run.threadId,
              branchId: initial.snapshot.run.branchId,
              head: initial.snapshot.head,
              agent: installed.reference,
              suspension: state.result.publicValue,
            });
            const committed = await threadStore.finalizeRun({
              claim,
              expectedHead: initial.snapshot.head,
              commitId: newId<CommitId>(),
              entries: [],
              result: suspended,
              suspension: state.result.stored,
            });
            if (committed.type !== "committed") {
              throw new ClaimLostError(runId);
            }
            return committed.value;
          }
          const committed = await threadStore.commitStep({
            claim,
            expectedHead: initial.snapshot.head,
            commitId: newId<CommitId>(),
            entries: [
              {
                id: newId<MessageEntryId>(),
                message: {
                  role: "tool",
                  content: [
                    {
                      type: "tool-result",
                      toolName: execution.toolName,
                      toolCallId: execution.toolCallId,
                      output: state.result.value,
                      ...(state.providerData === undefined
                        ? {}
                        : { providerData: state.providerData }),
                    },
                  ],
                },
              },
            ],
          });
          if (committed.type !== "committed") {
            throw new ClaimLostError(runId);
          }
          prepared = await prepare();
        }

        while (true) {
          assertActive(controller.signal);
          const invocation = await invokeModel(prepared);
          if (invocation.type === "failure") {
            return finalize(prepared, {
              type: "failed",
              failure: invocation.failure,
            });
          }
          if (invocation.toolCalls.length === 0 && invocation.response.finishReason === "pause") {
            const preparedState = preparedStates.get(prepared)!;
            const committed = await threadStore.commitStep({
              claim,
              expectedHead: preparedState.snapshot.head,
              commitId: newId<CommitId>(),
              entries: [
                {
                  id: newId<MessageEntryId>(),
                  message: invocation.response.message,
                },
              ],
            });
            if (committed.type !== "committed") {
              throw new ClaimLostError(runId);
            }
            prepared = await prepare();
            continue;
          }
          if (invocation.toolCalls.length === 0) {
            return finalize(prepared, {
              type: "completed",
              response: invocation.response,
            });
          }

          if (
            invocation.toolCalls.length > 1 &&
            invocation.toolCalls.some((call) => {
              const tool = preparedStates.get(prepared)!.tools.get(call.toolName);
              return tool?.type === "static" && tool.definition.suspension !== undefined;
            })
          ) {
            throw new RuntimeInvariantError(
              "A response cannot batch a resumable Tool Call with other Tool Calls",
            );
          }

          const toolMessages: ModelMessage[] = [];
          for (const call of invocation.toolCalls) {
            const execution = await executeTool(prepared, call);
            const state = toolStates.get(execution)!;
            if (state.result.type === "failure") {
              return finalize(prepared, {
                type: "failed",
                failure: state.result.failure,
              });
            }
            if (state.result.type === "suspension") {
              const preparedState = preparedStates.get(prepared)!;
              const entryId = newId<MessageEntryId>();
              const base = {
                runId,
                threadId: preparedState.snapshot.run.threadId,
                branchId: preparedState.snapshot.run.branchId,
                head: entryId,
                agent: installed.reference,
              };
              const result: RunResult = Object.freeze({
                ...base,
                type: "suspended",
                suspension: state.result.publicValue,
              });
              const committed = await threadStore.finalizeRun({
                claim,
                expectedHead: preparedState.snapshot.head,
                commitId: newId<CommitId>(),
                entries: [{ id: entryId, message: invocation.response.message }],
                result,
                suspension: state.result.stored,
              });
              if (committed.type !== "committed") {
                throw new ClaimLostError(runId);
              }
              return committed.value;
            }
            toolMessages.push({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolName: call.toolName,
                  toolCallId: call.toolCallId,
                  output: state.result.value,
                  ...(state.providerData === undefined ? {} : { providerData: state.providerData }),
                },
              ],
            });
          }

          const preparedState = preparedStates.get(prepared)!;
          const committed = await threadStore.commitStep({
            claim,
            expectedHead: preparedState.snapshot.head,
            commitId: newId<CommitId>(),
            entries: [invocation.response.message, ...toolMessages].map((message) => ({
              id: newId<MessageEntryId>(),
              message,
            })),
          });
          if (committed.type !== "committed") {
            throw new ClaimLostError(runId);
          }
          prepared = await prepare();
        }
      };

      const settle = async (result: AttemptOutcome): Promise<AttemptOutcome> => {
        if (latestRun !== undefined) {
          await notify(hooksOf(installed.contributions), "onSettlement", {
            run: latestRun,
            outcome: result,
          });
        }
        queue.close();
        return result;
      };

      const outcome = runWithEffect(async (): Promise<AttemptOutcome> => {
        try {
          const result = driver
            ? await driver.execute({
                runId,
                agent,
                operations: operations as unknown as RuntimeOperations<Agent>,
                signal: controller.signal,
              })
            : await defaultExecute();
          return settle(result);
        } catch (cause) {
          if (controller.signal.reason instanceof ClaimLostError) {
            queue.fail(controller.signal.reason);
            throw controller.signal.reason;
          }
          if (cause instanceof HookBlockedExecution && latestPrepared !== undefined) {
            const result = await finalize(latestPrepared, {
              type: "failed",
              failure: {
                type: "hook-blocked",
                point: cause.point,
                failure: cause.failure,
              },
            });
            return settle(result);
          }
          if (cause instanceof InterruptExecution) {
            return settle(cause.outcome);
          }
          if (cause instanceof AbortExecution || controller.signal.aborted) {
            try {
              let reason: JsonValue | undefined;
              if (cause instanceof AbortExecution && cause.reason !== undefined) {
                reason = cause.reason;
              } else if (isJsonValue(controller.signal.reason)) {
                reason = controller.signal.reason;
              }
              let result: RunResult;
              if (latestPrepared !== undefined) {
                result = await finalize(latestPrepared, {
                  type: "aborted",
                  ...(reason === undefined ? {} : { reason }),
                });
              } else {
                const snapshot = await threadStore.loadExecution(claim);
                if (snapshot === undefined) {
                  throw new ClaimLostError(runId);
                }
                latestRun = Object.freeze({
                  runId,
                  threadId: snapshot.run.threadId,
                  branchId: snapshot.run.branchId,
                  agent: installed.reference,
                });
                const aborted: RunResult = Object.freeze({
                  type: "aborted",
                  runId,
                  threadId: snapshot.run.threadId,
                  branchId: snapshot.run.branchId,
                  head: snapshot.head,
                  agent: installed.reference,
                  ...(reason === undefined ? {} : { reason }),
                });
                const committed = await threadStore.finalizeRun({
                  claim,
                  expectedHead: snapshot.head,
                  commitId: newId<CommitId>(),
                  entries: [],
                  result: aborted,
                });
                if (committed.type !== "committed") {
                  throw new ClaimLostError(runId);
                }
                result = committed.value;
              }
              return settle(result);
            } catch (abortCause) {
              queue.fail(abortCause);
              throw abortCause;
            }
          }
          queue.fail(cause);
          throw cause;
        } finally {
          renewalController.abort();
          await renewal;
          try {
            await acquiredModelSession?.close?.();
          } finally {
            active.delete(runId);
            await threadStore.releaseExecutionClaim(claim);
          }
        }
      });

      return Object.freeze({
        attemptId,
        runId,
        signals: singleConsumer(queue),
        outcome,
        abort(reason?: JsonValue) {
          controller.abort(reason);
        },
      });
    },
  });
}
