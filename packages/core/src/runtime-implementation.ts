import type { AgentDefinition, InstalledAgentData } from "./agent.js";
import type { Contribution } from "./fragment.js";
import type { HookBlock, HookDefinition } from "./hook.js";
import type { AgentReference, RunIdentity } from "./identity.js";
import type {
  ContextNode,
  ModelCapability,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ModelSession,
  ToolCallContentPart,
} from "./protocol.js";
import { Transcript } from "./protocol.js";
import type {
  CompositeModelContext,
  ContextContribution,
  ModelDefinition,
  NestedModelResult,
  RuntimeModel,
} from "./render.js";
import type {
  AbortResult,
  Execution,
  ExecutionEvent,
  ExecutionResult,
  Clock,
  GenerateId,
  InterruptedExecutionResult,
  Loop,
  ModelInvocation,
  PreparedRun,
  ResolvedExecution,
  RunCommand,
  RunResult,
  RunSnapshot,
  Runtime,
  RuntimeOperations,
  SteeringResult,
  SteerInput,
  SubmitResult,
  SuspendedRunResult,
  ToolExecution,
  ToolSuspensionRecord,
  UnexpectedExecutionPhase,
} from "./runtime.js";
import {
  ExecutionClaimLostError,
  ExecutionUnavailableError,
  UnexpectedExecutionError,
} from "./runtime.js";
import { canonicalJsonObject, validateSchema } from "./schema.js";
import type {
  ArtifactStore,
  ExecutionClaim,
  ExecutionSnapshot,
  StoredToolCall,
  ThreadStore,
} from "./store.js";
import { ArtifactStoreError, ThreadStoreError } from "./store.js";
import {
  isDynamicToolProviderFragment,
  isToolFailure,
  isToolSuspension,
  isToolRuntimeDefinition,
  runtimeDynamicToolProvider,
  runtimeToolDefinition,
  toolFailureValue,
  toolSuspensionValue,
  type DynamicTool,
  type DynamicToolProvider,
  type DynamicToolProviderFragment,
  type ToolDefinition,
  type ToolInvocationResult,
  type ToolRuntimeDefinition,
} from "./tool.js";
import {
  stableJson,
  type CommitId,
  type ExecutionId,
  type JsonValue,
  type MessageEntryId,
  type RunId,
  type ToolAttemptId,
  type ToolCallId,
} from "./types.js";

interface RuntimeOptions {
  readonly threadStore: ThreadStore;
  readonly artifactStore?: ArtifactStore;
  readonly agents: ReadonlyMap<string, InstalledAgentData>;
  readonly loop?: Loop;
  readonly executionClaims?: { readonly leaseDurationMs?: number };
  readonly clock?: Clock;
  readonly generateId?: GenerateId;
  readonly modelEnvironment?: unknown;
}

type RuntimeTool =
  | {
      readonly type: "static";
      readonly definition: ToolRuntimeDefinition;
    }
  | {
      readonly type: "dynamic";
      readonly providerId: string;
      readonly definition: DynamicTool;
    };

interface PreparedState {
  readonly prepared: PreparedRun;
  readonly snapshot: ExecutionSnapshot;
  readonly run: RunIdentity;
  readonly model: RuntimeModel;
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly request: ModelRequest;
}

interface ToolAttemptSuccess {
  readonly type: "success";
  readonly result: ToolInvocationResult<JsonValue, JsonValue>;
}

interface ToolAttemptSuspended {
  readonly type: "suspended";
}

type ToolAttemptOutcome = ToolAttemptSuccess | ToolAttemptSuspended;

class RuntimeInvariantError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "RuntimeInvariantError";
  }
}

class AbortExecution {
  constructor(readonly reason?: JsonValue) {}
}

class InterruptExecution {
  constructor(readonly result: InterruptedExecutionResult) {}
}

class HookBlockedExecution {
  constructor(
    readonly point: string,
    readonly failure: unknown,
  ) {}
}

class ContinueLoop {}
class ChildSuspended {}

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

function requireJson(value: unknown, description: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new RuntimeInvariantError(`${description} is not JSON-compatible`);
  }
  return value;
}

function malformedHookResult(point: string, detail: string): never {
  throw new UnexpectedExecutionError("hook", new TypeError(`Hook '${point}' returned ${detail}`));
}

function hookResultObject(point: string, result: unknown): Record<string, unknown> | undefined {
  if (result === undefined) {
    return undefined;
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return malformedHookResult(point, "a malformed result");
  }
  return result as Record<string, unknown>;
}

function isModelRequest(value: unknown): value is ModelRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "context" in value &&
    Array.isArray(value.context) &&
    "messages" in value &&
    Array.isArray(value.messages) &&
    "tools" in value &&
    Array.isArray(value.tools) &&
    "providerOptions" in value &&
    Array.isArray(value.providerOptions)
  );
}

function values(
  contributions: readonly Contribution[],
  kind: Contribution["kind"],
): readonly unknown[] {
  return contributions
    .filter((contribution) => contribution.kind === kind)
    .map((contribution) => contribution.value);
}

function staticHooks(contributions: readonly Contribution[]): readonly HookDefinition[] {
  return values(contributions, "hook") as readonly HookDefinition[];
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

function toolTarget(tool: RuntimeTool): string {
  return tool.type === "static"
    ? `static:${tool.definition.name}`
    : `dynamic:${tool.providerId}:${tool.definition.definition.name}`;
}

function toolResult(call: StoredToolCall): ToolInvocationResult<JsonValue, JsonValue> | undefined {
  if (call.result?.type === "success") {
    return { type: "success", output: call.result.output };
  }
  if (call.result?.type === "failure") {
    return { type: "failure", failure: call.result.failure };
  }
  return undefined;
}

function publicSuspensions(snapshot: ExecutionSnapshot): readonly ToolSuspensionRecord[] {
  return snapshot.toolCalls
    .filter((call) => call.status === "suspended")
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ toolCallId, toolName }) => Object.freeze({ toolCallId, toolName }));
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

function invocationUsage(invocation: ModelInvocation): ModelUsage | undefined {
  if (invocation.type === "response") {
    return invocation.response.usage;
  }
  return invocation.type === "interruption" && "usage" in invocation.interruption
    ? invocation.interruption.usage
    : undefined;
}

/** Build the core Runtime behind one Commissary Instance. */
export function makeRuntime(options: RuntimeOptions): Runtime {
  const { threadStore, agents, loop } = options;
  const leaseDurationMs = options.executionClaims?.leaseDurationMs ?? 60_000;
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new RangeError("executionClaims.leaseDurationMs must be finite and positive");
  }
  const clock: Clock = options.clock ?? {
    now: () => Date.now(),
    sleep: wait,
  };
  const generateId = options.generateId ?? (() => globalThis.crypto.randomUUID());
  function newId<Id extends string>(): Id {
    return generateId() as Id;
  }
  const active = new Map<RunId, AbortController>();

  const requestAbort = async (runId: RunId, reason?: JsonValue): Promise<AbortResult> => {
    const result = await storeCall("requestAbort", () =>
      threadStore.requestAbort({
        runId,
        ...(reason === undefined ? {} : { reason }),
      }),
    );
    if (result.type === "accepted") {
      active.get(runId)?.abort(new AbortExecution(reason));
    }
    return result;
  };

  return Object.freeze({
    threadStore,

    async submit(agent: AgentReference, command: RunCommand): Promise<SubmitResult> {
      if (command.type === "start") {
        return storeCall("submitRun", () =>
          threadStore.submitRun({
            runId: command.runId ?? newId<RunId>(),
            entryId: newId<MessageEntryId>(),
            commitId: newId<CommitId>(),
            agent,
            threadId: command.threadId,
            branchId: command.branchId,
            message: command.message,
            ...(command.expectedHead === undefined ? {} : { expectedHead: command.expectedHead }),
          }),
        );
      }

      const installed = agents.get(agent.id);
      if (installed === undefined || installed.reference.revision !== agent.revision) {
        return {
          type: "tool-resume-conflict",
          runId: command.runId,
          toolCallIds: command.items.map((item) => item.toolCallId),
        };
      }
      const encodedItems: Array<{
        toolCallId: ToolCallId;
        toolName: string;
        encodedInput: JsonValue;
      }> = [];
      for (const item of command.items) {
        const contribution = installed.contributions.find(
          (candidate) => candidate.kind === "tool" && candidate.id === item.toolName,
        );
        const definition = contribution?.value as ToolRuntimeDefinition | undefined;
        if (definition?.suspension === undefined) {
          return {
            type: "tool-resume-conflict",
            runId: command.runId,
            toolCallIds: [item.toolCallId],
          };
        }
        const input = await validateSchema(definition.suspension.resumeInput, item.input);
        encodedItems.push({
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          encodedInput: requireJson(input, `Resume input for Tool '${item.toolName}'`),
        });
      }
      return storeCall("submitToolResumes", () =>
        threadStore.submitToolResumes({
          runId: command.runId,
          agent: installed.reference,
          items: encodedItems,
          ...(command.toolResumeRequestId === undefined
            ? {}
            : { toolResumeRequestId: command.toolResumeRequestId }),
        }),
      );
    },

    steer(input: SteerInput): Promise<SteeringResult> {
      return storeCall("acceptSteering", () => threadStore.acceptSteering(input));
    },

    abort(runId: RunId, reason?: JsonValue): Promise<AbortResult> {
      return requestAbort(runId, reason);
    },

    readRunSnapshot(runId: RunId): Promise<RunSnapshot | undefined> {
      return storeCall("readRunSnapshot", () => threadStore.readRunSnapshot(runId));
    },

    readResult(runId: RunId): Promise<RunResult | undefined> {
      return storeCall("readRunResult", () => threadStore.readRunResult(runId));
    },

    async execute<Definition extends AgentDefinition>(
      agent: Definition,
      runId: RunId,
      dynamicHooks: readonly HookDefinition[],
    ): Promise<Execution<unknown>> {
      const installed = agents.get(agent.id);
      if (installed === undefined || installed.definition !== agent) {
        throw new ExecutionUnavailableError(runId, "wrong-agent");
      }

      const executionId = newId<ExecutionId>();
      const claimResult = await storeCall("acquireExecutionClaim", () =>
        threadStore.acquireExecutionClaim({ runId, executionId, leaseDurationMs }),
      );
      if (claimResult.type === "run-not-found") {
        throw new ExecutionUnavailableError(runId, "run-not-found");
      }
      if (claimResult.type === "already-claimed") {
        throw new ExecutionUnavailableError(runId, "already-claimed");
      }
      if (claimResult.type === "not-executable") {
        throw new ExecutionUnavailableError(runId, "not-executable");
      }

      let claim: ExecutionClaim = claimResult.claim;
      const initialSnapshot = await storeCall("loadExecution", () =>
        threadStore.loadExecution(claim),
      );
      if (initialSnapshot === undefined) {
        await storeCall("releaseExecutionClaim", () => threadStore.releaseExecutionClaim(claim));
        throw new ExecutionUnavailableError(runId, "not-executable");
      }
      if (initialSnapshot.run.agent.id !== installed.reference.id) {
        await storeCall("releaseExecutionClaim", () => threadStore.releaseExecutionClaim(claim));
        throw new ExecutionUnavailableError(runId, "wrong-agent");
      }

      const modelProducts = new WeakMap<object, PreparedRun>();
      const toolProducts = new WeakMap<object, PreparedRun>();
      const hooks = Object.freeze([...staticHooks(installed.contributions), ...dynamicHooks]);
      const controller = new AbortController();
      const lifecycleController = new AbortController();
      active.set(runId, controller);
      const preparedStates = new WeakMap<object, PreparedState>();
      const resolvedExecutions = new WeakSet<object>();
      let currentRun: RunIdentity = Object.freeze({
        runId,
        threadId: initialSnapshot.run.threadId,
        branchId: initialSnapshot.run.branchId,
        agent: installed.reference,
      });
      let currentPhase: UnexpectedExecutionPhase = "prepare";
      const modelSessions = new Map<ModelCapability<string, unknown>, Promise<ModelSession>>();
      const acquiredModelSessions: ModelSession[] = [];
      let modelSessionsClosed = false;

      const assertActive = (): void => {
        if (!controller.signal.aborted) {
          return;
        }
        if (controller.signal.reason instanceof ExecutionClaimLostError) {
          throw controller.signal.reason;
        }
        if (controller.signal.reason instanceof AbortExecution) {
          throw controller.signal.reason;
        }
        throw new AbortExecution(
          isJsonValue(controller.signal.reason) ? controller.signal.reason : undefined,
        );
      };

      const publishObserverError = async (
        cause: unknown,
        failedHook: HookDefinition,
      ): Promise<void> => {
        const error =
          cause instanceof UnexpectedExecutionError
            ? cause
            : new UnexpectedExecutionError("hook", cause);
        const event: ExecutionEvent = Object.freeze({ type: "error", error });
        for (const candidate of hooks) {
          if (candidate === failedHook || candidate.point.name !== "onExecutionEvent") {
            continue;
          }
          try {
            await candidate.handler({ run: currentRun, event });
          } catch {
            // Error Event observers are isolated. Recursive Error Events are prohibited.
          }
        }
      };

      const notify = async (
        pointName: string,
        event: unknown,
        reportObserverErrors = true,
      ): Promise<void> => {
        for (const hook of hooks) {
          if (hook.point.name !== pointName) {
            continue;
          }
          try {
            const result = await hook.handler(event);
            if (result !== undefined) {
              throw new TypeError(`Notification Hook '${pointName}' must return undefined`);
            }
          } catch (cause) {
            if (reportObserverErrors) {
              await publishObserverError(cause, hook);
            }
          }
        }
      };

      const emit = async (event: ExecutionEvent): Promise<void> => {
        if (event.type === "model-event") {
          await notify("onModelEvent", { run: currentRun, event: event.event });
        }
        await notify("onExecutionEvent", { run: currentRun, event }, event.type !== "error");
      };

      const transformModelRequest = async (request: ModelRequest): Promise<ModelRequest> => {
        let current = request;
        for (const hook of hooks) {
          if (hook.point.name !== "beforeModelRequest") {
            continue;
          }
          let result: { readonly request?: ModelRequest } | HookBlock | undefined;
          try {
            result = (await hook.handler({
              run: currentRun,
              request: current,
              signal: controller.signal,
            })) as typeof result;
          } catch (cause) {
            throw new UnexpectedExecutionError("hook", cause);
          }
          const object = hookResultObject("beforeModelRequest", result);
          if (object === undefined) {
            continue;
          }
          if ("type" in object) {
            if (
              object.type !== "block" ||
              !("failure" in object) ||
              Object.keys(object).some((key) => key !== "type" && key !== "failure")
            ) {
              return malformedHookResult("beforeModelRequest", "an invalid block result");
            }
            throw new HookBlockedExecution("beforeModelRequest", object.failure);
          }
          if (Object.keys(object).some((key) => key !== "request")) {
            return malformedHookResult("beforeModelRequest", "an invalid request patch");
          }
          if ("request" in object && object.request !== undefined) {
            if (!isModelRequest(object.request)) {
              return malformedHookResult("beforeModelRequest", "an invalid request patch");
            }
            current = object.request;
          }
        }
        return current;
      };

      const transformToolInput = async (call: StoredToolCall): Promise<unknown> => {
        let current: unknown = call.input;
        for (const hook of hooks) {
          if (hook.point.name !== "beforeToolExecution") {
            continue;
          }
          let result: { readonly input?: unknown } | HookBlock | undefined;
          try {
            result = (await hook.handler({
              run: currentRun,
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              input: current,
              signal: controller.signal,
            })) as typeof result;
          } catch (cause) {
            throw new UnexpectedExecutionError("hook", cause);
          }
          const object = hookResultObject("beforeToolExecution", result);
          if (object === undefined) {
            continue;
          }
          if ("type" in object) {
            if (
              object.type !== "block" ||
              !("failure" in object) ||
              Object.keys(object).some((key) => key !== "type" && key !== "failure")
            ) {
              return malformedHookResult("beforeToolExecution", "an invalid block result");
            }
            throw new HookBlockedExecution("beforeToolExecution", object.failure);
          }
          if (Object.keys(object).some((key) => key !== "input")) {
            return malformedHookResult("beforeToolExecution", "an invalid input patch");
          }
          if ("input" in object) {
            current = object.input;
          }
        }
        return current;
      };

      const afterModelInvocation = async (
        invocation: ModelInvocation,
      ): Promise<"continue" | { readonly type: "retry"; readonly delayMs?: number }> => {
        for (const hook of hooks) {
          if (hook.point.name !== "afterModelInvocation") {
            continue;
          }
          let result: { readonly type: "retry"; readonly delayMs?: number } | HookBlock | undefined;
          try {
            result = (await hook.handler({
              run: currentRun,
              invocation,
              signal: controller.signal,
            })) as typeof result;
          } catch (cause) {
            throw new UnexpectedExecutionError("hook", cause);
          }
          const object = hookResultObject("afterModelInvocation", result);
          if (object === undefined) {
            continue;
          }
          if (object.type === "block") {
            if (
              !("failure" in object) ||
              Object.keys(object).some((key) => key !== "type" && key !== "failure")
            ) {
              return malformedHookResult("afterModelInvocation", "an invalid block result");
            }
            throw new HookBlockedExecution("afterModelInvocation", object.failure);
          }
          if (
            object.type !== "retry" ||
            Object.keys(object).some((key) => key !== "type" && key !== "delayMs") ||
            (object.delayMs !== undefined &&
              (typeof object.delayMs !== "number" ||
                !Number.isFinite(object.delayMs) ||
                object.delayMs < 0))
          ) {
            return malformedHookResult("afterModelInvocation", "an invalid retry result");
          }
          return object as { readonly type: "retry"; readonly delayMs?: number };
        }
        return "continue";
      };

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
        const snapshot = await storeCall("loadExecution", () => threadStore.loadExecution(claim));
        if (snapshot === undefined) {
          throw new ExecutionClaimLostError(runId);
        }
        return snapshot;
      };

      const prepare = async (): Promise<PreparedRun> => {
        currentPhase = "prepare";
        assertActive();
        let snapshot = await load();
        if (snapshot.run.abortRequested) {
          throw new AbortExecution(snapshot.run.abortReason);
        }
        if (
          snapshot.pendingSteering.length > 0 &&
          !snapshot.toolCalls.some(
            (call) => call.parentToolCallId === undefined && !call.historyCommitted,
          )
        ) {
          const entries = snapshot.pendingSteering.map((pending) => ({
            id: newId<MessageEntryId>(),
            message: pending.message,
          }));
          guarded(
            await storeCall("commitStep", () =>
              threadStore.commitStep({
                claim,
                expectedHead: snapshot.head,
                commitId: newId<CommitId>(),
                entries,
                consumedSteeringThrough: snapshot.pendingSteering.at(-1)!.sequence,
              }),
            ),
          );
          snapshot = await load();
        }

        currentRun = Object.freeze({
          runId,
          threadId: snapshot.run.threadId,
          branchId: snapshot.run.branchId,
          agent: installed.reference,
        });
        const context: ContextNode[] = [];
        for (const value of values(installed.contributions, "context")) {
          const contribution = value as ContextContribution;
          const content = await contribution.render({
            transcript: snapshot.transcript,
            run: currentRun,
            signal: controller.signal,
          });
          context.push(Object.freeze({ id: contribution.id, content }));
        }

        const model = values(installed.contributions, "model")[0] as RuntimeModel;
        const tools = new Map<string, RuntimeTool>();
        for (const contribution of installed.contributions) {
          if (contribution.kind !== "tool") {
            continue;
          }
          if (isToolRuntimeDefinition(contribution.value)) {
            const definition = contribution.value;
            if (tools.has(definition.name)) {
              throw new RuntimeInvariantError(
                `Tool '${definition.name}' conflicts with another Tool`,
              );
            }
            tools.set(definition.name, { type: "static", definition });
            continue;
          }
          const provider = contribution.value as DynamicToolProvider<string>;
          for (const definition of await provider.resolve({
            transcript: snapshot.transcript,
            run: currentRun,
            signal: controller.signal,
          })) {
            const modelTool = Object.freeze({
              ...definition.definition,
              inputSchema: canonicalJsonObject(definition.definition.inputSchema),
            });
            const installedDefinition = Object.freeze({
              ...definition,
              definition: modelTool,
            });
            const name = modelTool.name;
            if (tools.has(name)) {
              throw new RuntimeInvariantError(`Dynamic Tool '${name}' conflicts with another Tool`);
            }
            tools.set(name, {
              type: "dynamic",
              providerId: provider.id,
              definition: installedDefinition,
            });
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
          run: currentRun,
          transcriptHead: snapshot.head,
        }) as PreparedRun;
        preparedStates.set(prepared, {
          prepared,
          snapshot,
          run: currentRun,
          model,
          tools,
          request,
        });
        return prepared;
      };

      const acquireModelSession = (
        model: ModelCapability<string, unknown>,
      ): Promise<ModelSession> => {
        if (model.acquire === undefined) {
          return Promise.resolve(model);
        }
        const current = modelSessions.get(model);
        if (current !== undefined) {
          return current;
        }
        const acquired = Promise.resolve(
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
          acquiredModelSessions.push(session);
          return session;
        });
        modelSessions.set(model, acquired);
        return acquired;
      };

      const terminalInvocation = (event: ModelEvent): ModelInvocation | undefined => {
        switch (event.type) {
          case "finish":
            return Object.freeze({
              type: "response",
              response: event.response,
              toolCalls: event.response.message.content.filter(
                (part): part is ToolCallContentPart => part.type === "tool-call",
              ),
            }) as unknown as ModelInvocation;
          case "failure":
            return Object.freeze({
              type: "failure",
              failure: event.failure,
            }) as ModelInvocation;
          case "interruption":
            return Object.freeze({
              type: "interruption",
              interruption: event.interruption,
            }) as ModelInvocation;
          default:
            return undefined;
        }
      };

      const nestedResult = async (
        events: AsyncIterable<ModelEvent>,
      ): Promise<NestedModelResult> => {
        let result: NestedModelResult | undefined;
        for await (const event of events) {
          const invocation = terminalInvocation(event);
          if (invocation === undefined) {
            if (result !== undefined) {
              throw new RuntimeInvariantError("Model emitted an Event after its terminal Event");
            }
            continue;
          }
          if (result !== undefined) {
            throw new RuntimeInvariantError("Model emitted more than one terminal Event");
          }
          switch (invocation.type) {
            case "response":
              result = { type: "response", response: invocation.response };
              break;
            case "failure":
              result = { type: "failure", failure: invocation.failure };
              break;
            case "interruption":
              result = { type: "interruption", interruption: invocation.interruption };
              break;
          }
        }
        if (result === undefined) {
          throw new RuntimeInvariantError("Model stream ended without a terminal Event");
        }
        return result;
      };

      const eventForNestedResult = (result: NestedModelResult): ModelEvent => {
        switch (result.type) {
          case "response":
            return { type: "finish", response: result.response };
          case "failure":
            return { type: "failure", failure: result.failure };
          case "interruption":
            return { type: "interruption", interruption: result.interruption };
        }
      };

      const leafEvents = (
        model: ModelCapability<string, unknown>,
        request: ModelRequest,
      ): AsyncIterable<ModelEvent> => ({
        async *[Symbol.asyncIterator]() {
          while (true) {
            assertActive();
            const transformed = await transformModelRequest(request);
            const session = await acquireModelSession(model);
            const source = await session.invoke(transformed, {
              signal: controller.signal,
            });
            let terminal = false;
            let retry: { readonly type: "retry"; readonly delayMs?: number } | undefined;
            for await (const event of source) {
              assertActive();
              if (terminal) {
                throw new RuntimeInvariantError("Model emitted an Event after its terminal Event");
              }
              const invocation = terminalInvocation(event);
              if (invocation === undefined) {
                yield event;
                continue;
              }
              const usage = invocationUsage(invocation);
              if (usage !== undefined) {
                guarded(
                  await storeCall("recordModelUsage", () =>
                    threadStore.recordModelUsage({
                      claim,
                      commitId: newId<CommitId>(),
                      usage,
                    }),
                  ),
                );
              }
              const decision = await afterModelInvocation(invocation);
              if (decision !== "continue") {
                if (invocation.type !== "interruption") {
                  throw new RuntimeInvariantError(
                    "afterModelInvocation requested a retry for a non-Interruption result",
                  );
                }
                retry = decision;
                break;
              }
              terminal = true;
              yield event;
            }
            if (retry !== undefined) {
              if (retry.delayMs !== undefined) {
                if (!Number.isFinite(retry.delayMs) || retry.delayMs < 0) {
                  throw new RuntimeInvariantError(
                    "Model retry delay must be finite and nonnegative",
                  );
                }
                await clock.sleep(retry.delayMs, controller.signal);
              }
              continue;
            }
            if (!terminal) {
              throw new RuntimeInvariantError("Model stream ended without a terminal Event");
            }
            return;
          }
        },
      });

      const invokeRuntimeModel = async (
        model: RuntimeModel,
        request: ModelRequest,
        activeModels: readonly RuntimeModel[],
      ): Promise<AsyncIterable<ModelEvent>> => {
        if (activeModels.includes(model)) {
          const id = model.type === "leaf" ? model.capability.id : model.id;
          throw new RuntimeInvariantError(`Composite Model cycle reached '${id}'`);
        }
        if (model.type === "leaf") {
          return leafEvents(model.capability, request);
        }

        const path = [...activeModels, model];
        const records = new Map<
          string,
          {
            readonly signature: string;
            readonly mode: "invoke" | "forward";
            readonly result?: Promise<NestedModelResult>;
          }
        >();
        let committedKey: string | undefined;
        const childRuntime = (child: ModelDefinition<string, unknown>): RuntimeModel => {
          const runtime = model.children.get(child);
          if (runtime === undefined) {
            throw new RuntimeInvariantError(
              `Composite Model '${model.id}' invoked an undeclared child`,
            );
          }
          return runtime;
        };
        const signature = (
          child: RuntimeModel,
          childRequest: ModelRequest,
          key: string,
        ): string => {
          if (key.length === 0) {
            throw new RuntimeInvariantError(
              `Composite Model '${model.id}' used an empty child key`,
            );
          }
          const childId = child.type === "leaf" ? child.capability.id : child.id;
          return stableJson([
            childId,
            key,
            requireJson(childRequest, `Nested request from Composite Model '${model.id}'`),
          ]);
        };
        const context: CompositeModelContext = Object.freeze({
          signal: controller.signal,
          invoke: (
            child: ModelDefinition<string, unknown>,
            childRequest: ModelRequest,
            invocationOptions: { readonly key: string },
          ) => {
            const runtime = childRuntime(child);
            const fingerprint = signature(runtime, childRequest, invocationOptions.key);
            const current = records.get(invocationOptions.key);
            if (current !== undefined) {
              if (
                current.signature !== fingerprint ||
                current.mode !== "invoke" ||
                current.result === undefined
              ) {
                throw new RuntimeInvariantError(
                  `Composite Model child key '${invocationOptions.key}' was reused with different work`,
                );
              }
              return current.result;
            }
            const result = invokeRuntimeModel(runtime, childRequest, path).then(nestedResult);
            records.set(invocationOptions.key, {
              signature: fingerprint,
              mode: "invoke",
              result,
            });
            return result;
          },
          forward: (
            child: ModelDefinition<string, unknown>,
            childRequest: ModelRequest,
            invocationOptions: { readonly key: string },
          ): AsyncIterable<ModelEvent> => {
            const runtime = childRuntime(child);
            const fingerprint = signature(runtime, childRequest, invocationOptions.key);
            const current = records.get(invocationOptions.key);
            if (current !== undefined && current.signature !== fingerprint) {
              throw new RuntimeInvariantError(
                `Composite Model child key '${invocationOptions.key}' was reused with different work`,
              );
            }
            if (current?.mode === "forward") {
              throw new RuntimeInvariantError(
                `Composite Model child key '${invocationOptions.key}' was forwarded more than once`,
              );
            }
            if (current === undefined) {
              records.set(invocationOptions.key, {
                signature: fingerprint,
                mode: "forward",
              });
            }
            return {
              async *[Symbol.asyncIterator]() {
                if (current?.mode === "invoke" && current.result !== undefined) {
                  if (committedKey !== undefined && committedKey !== invocationOptions.key) {
                    throw new RuntimeInvariantError(
                      `Composite Model '${model.id}' switched children after forwarding output`,
                    );
                  }
                  committedKey = invocationOptions.key;
                  yield eventForNestedResult(await current.result);
                  return;
                }
                const events = await invokeRuntimeModel(runtime, childRequest, path);
                for await (const event of events) {
                  if (committedKey !== undefined && committedKey !== invocationOptions.key) {
                    throw new RuntimeInvariantError(
                      `Composite Model '${model.id}' switched children after forwarding output`,
                    );
                  }
                  committedKey = invocationOptions.key;
                  yield event;
                }
              },
            };
          },
        });
        return model.invoke(request, context);
      };

      const invokeModel = async (prepared: PreparedRun): Promise<ModelInvocation> => {
        const state = preparedStates.get(prepared);
        if (state === undefined) {
          throw new RuntimeInvariantError("Prepared Run belongs to another Execution");
        }
        currentPhase = "model";
        assertActive();
        let response: ModelResponse | undefined;
        let invocation: ModelInvocation | undefined;
        const events = await invokeRuntimeModel(state.model, state.request, []);
        for await (const event of events) {
          assertActive();
          await emit(Object.freeze({ type: "model-event", event }));
          const terminal = terminalInvocation(event);
          if (terminal === undefined) {
            if (response !== undefined || invocation !== undefined) {
              throw new RuntimeInvariantError("Model emitted an Event after its terminal Event");
            }
            continue;
          }
          if (response !== undefined || invocation !== undefined) {
            throw new RuntimeInvariantError("Model emitted more than one terminal Event");
          }
          if (terminal.type === "response") {
            response = terminal.response;
          } else {
            invocation = terminal;
          }
        }
        if (invocation === undefined && response === undefined) {
          throw new RuntimeInvariantError("Model stream ended without a terminal Event");
        }
        if (invocation === undefined) {
          const toolCalls = response!.message.content.filter(
            (part): part is ToolCallContentPart => part.type === "tool-call",
          );
          const seen = new Set<ToolCallId>();
          for (const call of toolCalls) {
            if (seen.has(call.toolCallId)) {
              throw new RuntimeInvariantError(`Duplicate Tool Call ID '${call.toolCallId}'`);
            }
            seen.add(call.toolCallId);
            if (!state.tools.has(call.toolName)) {
              throw new RuntimeInvariantError(`Model requested unknown Tool '${call.toolName}'`);
            }
          }
          invocation = Object.freeze({
            type: "response",
            response: response!,
            toolCalls,
          }) as unknown as ModelInvocation;
        }

        if (invocation.type === "response") {
          const mustCommit =
            invocation.toolCalls.length > 0 || invocation.response.finishReason === "pause";
          if (mustCommit) {
            const entry = {
              id: newId<MessageEntryId>(),
              message: invocation.response.message,
            };
            guarded(
              await storeCall("commitModelInvocation", () =>
                threadStore.commitModelInvocation({
                  claim,
                  expectedHead: state.snapshot.head,
                  commitId: newId<CommitId>(),
                  entry,
                  toolCalls: invocation.toolCalls.map((call) => {
                    const tool = state.tools.get(call.toolName)!;
                    return {
                      toolCallId: call.toolCallId,
                      toolName: call.toolName,
                      input: call.input,
                      ...(tool.type === "dynamic" ? { providerId: tool.providerId } : {}),
                      ...(call.providerData === undefined
                        ? {}
                        : { providerData: call.providerData }),
                    };
                  }),
                }),
              ),
            );
          }
        }
        modelProducts.set(invocation, prepared);
        return invocation;
      };

      const resolveRuntimeTool = (state: PreparedState, call: StoredToolCall): RuntimeTool => {
        const tool = state.tools.get(call.toolName);
        if (tool === undefined) {
          throw new RuntimeInvariantError(`Stored Tool '${call.toolName}' is not installed`);
        }
        if ((tool.type === "dynamic" ? tool.providerId : undefined) !== call.providerId) {
          throw new RuntimeInvariantError(`Stored Tool '${call.toolName}' changed ownership`);
        }
        return tool;
      };

      const attemptToolCall = async (
        prepared: PreparedRun,
        originalCall: StoredToolCall,
        activeTargets: readonly string[],
      ): Promise<ToolAttemptOutcome> => {
        const state = preparedStates.get(prepared);
        if (state === undefined) {
          throw new RuntimeInvariantError("Prepared Run belongs to another Execution");
        }
        currentPhase = "tool";
        assertActive();
        let snapshot = await load();
        let call = snapshot.toolCalls.find(
          (candidate) => candidate.toolCallId === originalCall.toolCallId,
        );
        if (call === undefined) {
          throw new RuntimeInvariantError(
            `Stored Tool Call '${originalCall.toolCallId}' is missing`,
          );
        }
        const existing = toolResult(call);
        if (existing !== undefined) {
          return { type: "success", result: existing };
        }
        if (call.status === "aborted") {
          throw new AbortExecution(snapshot.run.abortReason);
        }

        const toolCallId = call.toolCallId;
        const toolName = call.toolName;
        const tool = resolveRuntimeTool(state, call);
        const target = toolTarget(tool);
        if (activeTargets.includes(target)) {
          throw new RuntimeInvariantError(`Tool delegation cycle reached '${call.toolName}'`);
        }
        const path = [...activeTargets, target];

        let input: unknown = call.effectiveInput;
        if (input === undefined) {
          input = await transformToolInput(call);
          if (tool.type === "static") {
            input = await validateSchema(tool.definition.input, input);
          }
          const encoded = requireJson(input, `Effective input for Tool '${call.toolName}'`);
          call = guarded(
            await storeCall("recordToolInput", () =>
              threadStore.recordToolInput({
                claim,
                toolCallId,
                input: encoded,
              }),
            ),
          );
          input = call.effectiveInput;
        } else if (tool.type === "static") {
          input = await validateSchema(tool.definition.input, input);
        }

        const invokeChild = async (
          targetValue: ToolDefinition | DynamicToolProviderFragment,
          childInput: unknown,
          key: string,
          dynamicToolName?: string,
        ): Promise<ToolInvocationResult<unknown, unknown>> => {
          const childId = newId<ToolCallId>();
          let childTool: RuntimeTool;
          let childName: string;
          let providerId: string | undefined;
          let encodedInput: JsonValue;

          if (dynamicToolName === undefined) {
            const definition = runtimeToolDefinition(targetValue as ToolDefinition);
            const installedDefinition = state.tools.get(definition.name);
            if (
              installedDefinition?.type !== "static" ||
              installedDefinition.definition !== definition
            ) {
              throw new RuntimeInvariantError(
                `Delegated Tool '${definition.name}' is not installed in this Agent`,
              );
            }
            childTool = installedDefinition;
            childName = definition.name;
            encodedInput = requireJson(childInput, `Delegated input for Tool '${definition.name}'`);
          } else {
            const provider = runtimeDynamicToolProvider(targetValue as DynamicToolProviderFragment);
            const contribution = installed.contributions.find(
              (candidate) => candidate.kind === "tool" && candidate.id === `dynamic:${provider.id}`,
            );
            if (contribution === undefined) {
              throw new RuntimeInvariantError(
                `Dynamic Tool Provider '${provider.id}' is not installed in this Agent`,
              );
            }
            const candidate = state.tools.get(dynamicToolName);
            if (candidate?.type !== "dynamic" || candidate.providerId !== provider.id) {
              throw new RuntimeInvariantError(
                `Dynamic Tool '${dynamicToolName}' is not available from Provider '${provider.id}'`,
              );
            }
            childTool = candidate;
            childName = dynamicToolName;
            providerId = provider.id;
            encodedInput = requireJson(
              childInput,
              `Delegated input for Dynamic Tool '${dynamicToolName}'`,
            );
          }

          if (path.includes(toolTarget(childTool))) {
            throw new RuntimeInvariantError(`Tool delegation cycle reached '${childName}'`);
          }
          const child = guarded(
            await storeCall("recordDelegatedToolCall", () =>
              threadStore.recordDelegatedToolCall({
                claim,
                parentToolCallId: toolCallId,
                toolCallId: childId,
                toolName: childName,
                ...(providerId === undefined ? {} : { providerId }),
                key,
                input: encodedInput,
              }),
            ),
          );
          const outcome = await attemptToolCall(prepared, child, path);
          if (outcome.type === "suspended") {
            throw new ChildSuspended();
          }
          return outcome.result;
        };

        const context = Object.freeze({
          runId,
          toolCallId: call.toolCallId,
          toolAttemptId: newId<ToolAttemptId>(),
          idempotencyKey: `${runId}:${call.toolCallId}`,
          signal: controller.signal,
          emit: async (event: unknown) => {
            let value = event;
            if (tool.type === "static") {
              if (tool.definition.event === undefined) {
                throw new RuntimeInvariantError(`Tool '${toolName}' emitted an undeclared Event`);
              }
              value = await validateSchema(tool.definition.event, event);
            }
            await emit(
              Object.freeze({
                type: "tool-event",
                toolName,
                toolCallId,
                event: value,
              }),
            );
          },
          invoke: (
            targetValue: ToolDefinition | DynamicToolProviderFragment,
            childInput: unknown | { readonly toolName: string; readonly input: JsonValue },
            invokeOptions: { readonly key: string },
          ) => {
            if (isDynamicToolProviderFragment(targetValue)) {
              if (
                typeof childInput !== "object" ||
                childInput === null ||
                !("toolName" in childInput) ||
                typeof childInput.toolName !== "string" ||
                !("input" in childInput)
              ) {
                throw new RuntimeInvariantError(
                  "Dynamic Tool invocation requires a Tool name and JSON input",
                );
              }
              return invokeChild(
                targetValue,
                childInput.input,
                invokeOptions.key,
                childInput.toolName,
              );
            }
            return invokeChild(targetValue, childInput, invokeOptions.key);
          },
        });

        await emit(
          Object.freeze({
            type: "tool-started",
            toolName: call.toolName,
            toolCallId: call.toolCallId,
          }),
        );

        const interruptStaleAgent = async (detail: string): Promise<never> => {
          const interruption: InterruptedExecutionResult = {
            type: "interrupted",
            runId,
            interruption: {
              type: "stale-agent",
              expected: call.suspension!.agent,
              installed: installed.reference,
              toolName: call.toolName,
              detail,
            },
          };
          guarded(
            await storeCall("recordInterruption", () =>
              threadStore.recordInterruption({
                claim,
                interruption: interruption.interruption,
              }),
            ),
          );
          throw new InterruptExecution(interruption);
        };

        try {
          let rawResult: unknown;
          if (call.suspension?.resumeInput !== undefined) {
            if (tool.type !== "static" || tool.definition.suspension === undefined) {
              throw new RuntimeInvariantError(
                `Tool '${call.toolName}' has resume input without a suspension contract`,
              );
            }
            if (call.suspension.agent.revision !== installed.reference.revision) {
              await interruptStaleAgent(
                "Suspended Tool state was created by a different Agent revision",
              );
            }
            let continuation: unknown;
            try {
              continuation = await tool.definition.suspension.continuation.decode(
                call.suspension.continuation,
              );
            } catch (cause) {
              await interruptStaleAgent(
                cause instanceof Error ? cause.message : "Continuation Codec rejected stored state",
              );
            }
            const resumeInput = await validateSchema(
              tool.definition.suspension.resumeInput,
              call.suspension.resumeInput,
            );
            rawResult = await tool.definition.suspension.resume(
              { input: resumeInput, continuation },
              context,
            );
          } else if (call.status === "suspended") {
            return { type: "suspended" };
          } else if (tool.type === "dynamic") {
            rawResult = await tool.definition.execute(input, context);
          } else {
            rawResult = await tool.definition.handler(input, context);
          }

          if (isToolFailure(rawResult)) {
            let failure: unknown;
            if (tool.type === "dynamic") {
              failure = toolFailureValue(rawResult);
            } else {
              const failureSchema = tool.definition.failure;
              if (failureSchema === undefined) {
                throw new RuntimeInvariantError(
                  `Tool '${toolName}' returned an undeclared Failure`,
                );
              }
              failure = await validateSchema(failureSchema, toolFailureValue(rawResult));
            }
            const result = {
              type: "failure" as const,
              failure: requireJson(failure, `Failure from Tool '${call.toolName}'`),
            };
            guarded(
              await storeCall("completeToolCall", () =>
                threadStore.completeToolCall({
                  claim,
                  toolCallId,
                  result,
                }),
              ),
            );
            await emit(
              Object.freeze({
                type: "tool-finished",
                toolName: call.toolName,
                toolCallId: call.toolCallId,
                result,
              }),
            );
            return { type: "success", result };
          }

          if (isToolSuspension(rawResult)) {
            if (tool.type !== "static" || tool.definition.suspension === undefined) {
              throw new RuntimeInvariantError(
                `Tool '${call.toolName}' returned an undeclared Suspension`,
              );
            }
            const continuation = requireJson(
              await tool.definition.suspension.continuation.encode(toolSuspensionValue(rawResult)),
              `Continuation from Tool '${call.toolName}'`,
            );
            guarded(
              await storeCall("suspendToolCall", () =>
                threadStore.suspendToolCall({
                  claim,
                  toolCallId,
                  suspension: { continuation, agent: installed.reference },
                }),
              ),
            );
            await emit(
              Object.freeze({
                type: "tool-suspended",
                toolName: call.toolName,
                toolCallId: call.toolCallId,
              }),
            );
            return { type: "suspended" };
          }

          const output =
            tool.type === "static"
              ? await validateSchema(tool.definition.output, rawResult)
              : rawResult;
          const result = {
            type: "success" as const,
            output: requireJson(output, `Output from Tool '${call.toolName}'`),
          };
          guarded(
            await storeCall("completeToolCall", () =>
              threadStore.completeToolCall({
                claim,
                toolCallId,
                result,
              }),
            ),
          );
          await emit(
            Object.freeze({
              type: "tool-finished",
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              result,
            }),
          );
          return { type: "success", result };
        } catch (cause) {
          if (cause instanceof ChildSuspended) {
            return { type: "suspended" };
          }
          throw cause;
        }
      };

      const commitResolvedToolResults = async (): Promise<boolean> => {
        const snapshot = await load();
        const calls = snapshot.toolCalls
          .filter((call) => call.parentToolCallId === undefined && !call.historyCommitted)
          .sort((left, right) => left.sequence - right.sequence);
        if (
          calls.length === 0 ||
          !calls.every((call) => call.status === "succeeded" || call.status === "failed")
        ) {
          return false;
        }
        const entries = calls.map((call) => {
          const result = toolResult(call)!;
          return {
            id: newId<MessageEntryId>(),
            toolCallId: call.toolCallId,
            message: {
              role: "tool" as const,
              content: [
                {
                  type: "tool-result" as const,
                  toolName: call.toolName,
                  toolCallId: call.toolCallId,
                  output: result.type === "success" ? result.output : result.failure,
                  ...(result.type === "failure" ? { isFailure: true as const } : {}),
                  ...(call.providerData === undefined ? {} : { providerData: call.providerData }),
                },
              ],
            },
          };
        });
        guarded(
          await storeCall("commitToolResults", () =>
            threadStore.commitToolResults({
              claim,
              expectedHead: snapshot.head,
              commitId: newId<CommitId>(),
              entries,
            }),
          ),
        );
        return true;
      };

      const executeTool = async (
        prepared: PreparedRun,
        requested: ToolCallContentPart,
      ): Promise<ToolExecution> => {
        const snapshot = await load();
        const call = snapshot.toolCalls.find(
          (candidate) => candidate.toolCallId === requested.toolCallId,
        );
        if (call === undefined || call.toolName !== requested.toolName) {
          throw new RuntimeInvariantError(
            `Tool Call '${requested.toolCallId}' was not committed by this Runtime`,
          );
        }
        const outcome = await attemptToolCall(prepared, call, []);
        const result: ToolExecution["result"] =
          outcome.type === "success" ? outcome.result : { type: "suspended" };
        const product = Object.freeze({
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          result,
        }) as ToolExecution;
        toolProducts.set(product, prepared);
        if (outcome.type === "success") {
          await commitResolvedToolResults();
        }
        return product;
      };

      type FinalizeTerminalResult = RunResult | { readonly type: "work-ready" };

      const finalizeTerminal = async (
        type: "completed" | "failed" | "aborted",
        value: ModelResponse | unknown | JsonValue | undefined,
      ): Promise<FinalizeTerminalResult> => {
        currentPhase = "finalize";
        const snapshot = await load();
        const entries: Array<{ id: MessageEntryId; message: ModelMessage }> = [];
        if (type === "completed") {
          entries.push({
            id: newId<MessageEntryId>(),
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
              id: newId<MessageEntryId>(),
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
          result = Object.freeze({
            ...resultBase(snapshot, head),
            type,
            ...(value === undefined ? {} : { reason: value as JsonValue }),
          });
        }
        const committed = await storeCall("finalizeRun", () =>
          threadStore.finalizeRun({
            claim,
            expectedHead: snapshot.head,
            commitId: newId<CommitId>(),
            entries,
            result,
            ...(type === "aborted" ? { abortUnresolvedTools: true } : {}),
          }),
        );
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
        guarded(
          await storeCall("recordInterruption", () =>
            threadStore.recordInterruption({ claim, interruption }),
          ),
        );
        return result;
      };

      const settle = async (
        prepared: PreparedRun,
        product: ModelInvocation | ToolExecution,
      ): Promise<ResolvedExecution> => {
        if (!preparedStates.has(prepared)) {
          throw new RuntimeInvariantError("Prepared Run belongs to another Execution");
        }
        let value: ExecutionResult;
        if (modelProducts.get(product) === prepared) {
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
        } else if (toolProducts.get(product) === prepared) {
          const execution = product as ToolExecution;
          if (execution.result.type !== "suspended") {
            throw new RuntimeInvariantError(
              "Only a suspended Tool product can settle an Execution",
            );
          }
          const snapshot = await load();
          const suspensions = publicSuspensions(snapshot);
          if (suspensions.length === 0) {
            throw new RuntimeInvariantError("Cannot settle without a durable Tool Suspension");
          }
          const result: SuspendedRunResult = {
            ...resultBase(snapshot, snapshot.head),
            type: "suspended",
            suspensions,
          };
          const stored = await storeCall("suspendRun", () =>
            threadStore.suspendRun({
              claim,
              expectedHead: snapshot.head,
              result,
            }),
          );
          if (stored.type === "work-ready") {
            throw new RuntimeInvariantError("Cannot settle while Tool resume work is ready");
          }
          value = guarded(stored);
        } else {
          throw new RuntimeInvariantError(
            "Settlement product belongs to another Runtime Operation",
          );
        }
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
          let snapshot = preparedStates.get(prepared)!.snapshot;
          const topLevel = snapshot.toolCalls
            .filter((call) => call.parentToolCallId === undefined && !call.historyCommitted)
            .sort((left, right) => left.sequence - right.sequence);

          if (topLevel.length > 0) {
            for (const call of topLevel) {
              if (call.status !== "succeeded" && call.status !== "failed") {
                await attemptToolCall(prepared, call, []);
              }
            }
            if (await commitResolvedToolResults()) {
              continue;
            }
            snapshot = await load();

            const suspensions = publicSuspensions(snapshot);
            if (suspensions.length > 0) {
              const suspended: SuspendedRunResult = {
                ...resultBase(snapshot, snapshot.head),
                type: "suspended",
                suspensions,
              };
              const result = await storeCall("suspendRun", () =>
                threadStore.suspendRun({
                  claim,
                  expectedHead: snapshot.head,
                  result: suspended,
                }),
              );
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
            renewal = await storeCall("renewExecutionClaim", () =>
              threadStore.renewExecutionClaim({ claim, leaseDurationMs }),
            );
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
          : storeCall("waitForExecutionControl", () =>
              threadStore.waitForExecutionControl!({
                claim,
                signal: lifecycleController.signal,
              }),
            )
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

      const closeModelSessions = async (): Promise<void> => {
        if (modelSessionsClosed) {
          return;
        }
        modelSessionsClosed = true;
        let failure: unknown;
        let failed = false;
        for (let index = acquiredModelSessions.length - 1; index >= 0; index -= 1) {
          try {
            await acquiredModelSessions[index]!.close?.();
          } catch (cause) {
            if (!failed) {
              failure = cause;
              failed = true;
            }
          }
        }
        if (failed) {
          throw failure;
        }
      };

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
                await notify("onSettlement", { run: currentRun, result: settled });
                return settled;
              }
              if (cause instanceof InterruptExecution) {
                settled = cause.result;
                await closeModelSessions();
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
                await notify("onSettlement", { run: currentRun, result: settled });
                return settled;
              }
              const error =
                cause instanceof ExecutionClaimLostError ||
                cause instanceof ThreadStoreError ||
                cause instanceof ArtifactStoreError ||
                cause instanceof UnexpectedExecutionError
                  ? cause
                  : new UnexpectedExecutionError(currentPhase, cause);
              await emit(Object.freeze({ type: "error", error }));
              throw error;
            } finally {
              if (!restarting && !modelSessionsClosed) {
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
          await storeCall("releaseExecutionClaim", () => threadStore.releaseExecutionClaim(claim));
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
            cleanupFailure instanceof ThreadStoreError
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
          return requestAbort(runId, reason);
        },
      });
    },
  });
}
