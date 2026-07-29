import type { AgentDefinition, InstalledAgentData } from "./agent.js";
import type { Contribution } from "./fragment.js";
import type {
  CompletedToolCallResult,
  HookBlock,
  HookDefinition,
  ModelInvocationCandidate,
  SettlementContinuation,
} from "./hook.js";
import { HookPoints } from "./hook.js";
import type { AgentReference, RunIdentity } from "./identity.js";
import type {
  ContextNode,
  ContentPart,
  ModelCapability,
  ModelEvent,
  ModelTool,
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
  ExecutionEventAppend,
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
  RedirectInput,
  RedirectResult,
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
  ExecutionEventStoreError,
  ExecutionUnavailableError,
  UnexpectedExecutionError,
} from "./runtime.js";
import { schemaJson, validateSchema } from "./schema.js";
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
  isToolSuccess,
  isToolSuspension,
  isToolRuntimeDefinition,
  runtimeDynamicToolProvider,
  runtimeToolDefinition,
  toolResultContent,
  toolFailureValue,
  toolSuccessValue,
  toolSuspensionValue,
  type DynamicTool,
  type DynamicToolProvider,
  type DynamicToolProviderFragment,
  type ToolDefinition,
  type ToolInvocationResult,
  type ToolExecutionMode,
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
  readonly executionEventStore?: ExecutionEventStore;
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
      readonly modelTool: ModelTool;
    };

interface PreparedStateBase {
  readonly snapshot: ExecutionSnapshot;
  readonly run: RunIdentity;
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly resolveDynamicProvider: (
    providerId: string,
  ) => Promise<ReadonlyMap<string, RuntimeTool>>;
}

interface PreparedModelState extends PreparedStateBase {
  readonly prepared: PreparedModelWork;
  readonly model: RuntimeModel;
  readonly request: ModelRequest;
}

interface PreparedToolState extends PreparedStateBase {
  readonly prepared: PreparedToolWork;
  readonly outcomes: Map<ToolCallId, StoredToolCall>;
  readonly executionMode: ToolExecutionMode;
}

type PreparedState = PreparedModelState | PreparedToolState;

function isPreparedModelState(state: PreparedState): state is PreparedModelState {
  return state.prepared.type === "model";
}

function isPreparedToolState(state: PreparedState): state is PreparedToolState {
  return state.prepared.type === "tools";
}

interface ToolAttemptSuccess {
  readonly type: "success";
  readonly result: ToolInvocationResult<JsonValue, JsonValue>;
  readonly stored: StoredToolCall;
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

class RedirectModelInvocation {}

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

function modelDelta(
  event: ExecutionEvent,
): { readonly type: "text-delta" | "reasoning-delta"; readonly delta: string } | undefined {
  if (
    event.type !== "model-event" ||
    (event.event.type !== "text-delta" && event.event.type !== "reasoning-delta")
  ) {
    return undefined;
  }
  return event.event;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function requireJson(value: unknown, description: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new RuntimeInvariantError(`${description} is not JSON-compatible`);
  }
  return value;
}

function parseModelUsage(value: unknown, description: string): ModelUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeInvariantError(`${description} is malformed`);
  }
  const object = value as Record<string, unknown>;
  if (
    typeof object.input !== "object" ||
    object.input === null ||
    Array.isArray(object.input) ||
    typeof object.output !== "object" ||
    object.output === null ||
    Array.isArray(object.output) ||
    Object.keys(object).some((key) => key !== "input" && key !== "output" && key !== "totalTokens")
  ) {
    throw new RuntimeInvariantError(`${description} is malformed`);
  }
  const input = object.input as Record<string, unknown>;
  const output = object.output as Record<string, unknown>;
  const validCount = (count: unknown): boolean =>
    count === undefined ||
    (typeof count === "number" && Number.isFinite(count) && Number.isInteger(count) && count >= 0);
  if (
    Object.keys(input).some(
      (key) => key !== "total" && key !== "uncached" && key !== "cacheRead" && key !== "cacheWrite",
    ) ||
    Object.keys(output).some((key) => key !== "total" && key !== "text" && key !== "reasoning") ||
    !validCount(input.total) ||
    !validCount(input.uncached) ||
    !validCount(input.cacheRead) ||
    !validCount(input.cacheWrite) ||
    !validCount(output.total) ||
    !validCount(output.text) ||
    !validCount(output.reasoning) ||
    !validCount(object.totalTokens)
  ) {
    throw new RuntimeInvariantError(`${description} counts must be finite nonnegative integers`);
  }
  // SAFETY: Every allowed field was checked above and the returned groups are immutable.
  return Object.freeze({
    input: Object.freeze({ ...input }),
    output: Object.freeze({ ...output }),
    ...(object.totalTokens === undefined ? {} : { totalTokens: object.totalTokens }),
  }) as ModelUsage;
}

function parseContentParts(
  content: readonly ContentPart[],
  description: string,
): readonly ContentPart[] {
  if (!Array.isArray(content)) {
    throw new RuntimeInvariantError(`${description} Content is not an array`);
  }
  return Object.freeze(
    content.map((part, index) => {
      requireJson(part, `${description} Content ${index}`);
      if (typeof part !== "object" || part === null || Array.isArray(part)) {
        throw new RuntimeInvariantError(`${description} Content ${index} is malformed`);
      }
      // SAFETY: requireJson and the object check establish a string-keyed JSON object.
      const object = part as Record<string, unknown>;
      const providerDataIsValid =
        object.providerData === undefined ||
        (Array.isArray(object.providerData) &&
          object.providerData.every(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              !Array.isArray(item) &&
              "namespace" in item &&
              typeof item.namespace === "string" &&
              "version" in item &&
              typeof item.version === "number" &&
              Number.isFinite(item.version) &&
              Number.isInteger(item.version) &&
              "value" in item,
          ));
      if (!providerDataIsValid) {
        throw new RuntimeInvariantError(
          `${description} Content ${index} has invalid Provider Data`,
        );
      }

      let valid: boolean;
      switch (object.type) {
        case "text":
        case "reasoning":
          valid = typeof object.text === "string";
          break;
        case "file": {
          const artifact = object.artifact;
          valid =
            typeof artifact === "object" &&
            artifact !== null &&
            !Array.isArray(artifact) &&
            "id" in artifact &&
            typeof artifact.id === "string" &&
            (!("mediaType" in artifact) ||
              artifact.mediaType === undefined ||
              typeof artifact.mediaType === "string") &&
            (!("name" in artifact) ||
              artifact.name === undefined ||
              typeof artifact.name === "string");
          break;
        }
        case "tool-call":
          valid =
            typeof object.toolCallId === "string" &&
            typeof object.toolName === "string" &&
            "input" in object;
          break;
        case "tool-result":
          valid =
            typeof object.toolCallId === "string" &&
            typeof object.toolName === "string" &&
            "output" in object &&
            (object.isFailure === undefined || typeof object.isFailure === "boolean");
          break;
        case "source":
          valid =
            typeof object.id === "string" &&
            typeof object.title === "string" &&
            ((object.sourceType === "url" && typeof object.url === "string") ||
              (object.sourceType === "document" &&
                typeof object.mediaType === "string" &&
                (object.fileName === undefined || typeof object.fileName === "string")));
          break;
        default:
          valid = false;
      }
      if (!valid) {
        throw new RuntimeInvariantError(`${description} Content ${index} is malformed`);
      }
      return Object.freeze({ ...part });
    }),
  );
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
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("context" in value) ||
    !Array.isArray(value.context) ||
    !("messages" in value) ||
    !Array.isArray(value.messages) ||
    !("tools" in value) ||
    !Array.isArray(value.tools) ||
    !("providerOptions" in value) ||
    !Array.isArray(value.providerOptions)
  ) {
    return false;
  }
  return (
    value.context.every(
      (node) =>
        typeof node === "object" &&
        node !== null &&
        !Array.isArray(node) &&
        "id" in node &&
        typeof node.id === "string" &&
        "content" in node &&
        Array.isArray(node.content),
    ) &&
    value.messages.every(isModelMessage) &&
    value.tools.every(
      (tool) =>
        typeof tool === "object" &&
        tool !== null &&
        !Array.isArray(tool) &&
        "name" in tool &&
        typeof tool.name === "string" &&
        "inputSchema" in tool &&
        (!("description" in tool) ||
          tool.description === undefined ||
          typeof tool.description === "string"),
    ) &&
    value.providerOptions.every(
      (option) =>
        typeof option === "object" &&
        option !== null &&
        !Array.isArray(option) &&
        "namespace" in option &&
        typeof option.namespace === "string" &&
        "value" in option,
    )
  );
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("role" in value) ||
    !["system", "user", "assistant", "tool"].includes(String(value.role)) ||
    !("content" in value) ||
    !Array.isArray(value.content) ||
    ("data" in value &&
      value.data !== undefined &&
      (!Array.isArray(value.data) ||
        value.data.some(
          (item) =>
            typeof item !== "object" ||
            item === null ||
            Array.isArray(item) ||
            !("key" in item) ||
            typeof item.key !== "string" ||
            !("version" in item) ||
            typeof item.version !== "number" ||
            !Number.isFinite(item.version) ||
            !Number.isInteger(item.version) ||
            !("value" in item),
        )))
  ) {
    return false;
  }
  try {
    parseContentParts(value.content, "Model Message");
    requireJson(value, "Model Message");
    return true;
  } catch {
    return false;
  }
}

function parseModelEvent(value: unknown, pointName: string): ModelEvent {
  try {
    requireJson(value, `Model Event from Hook '${pointName}'`);
  } catch {
    return malformedHookResult(pointName, "a non-JSON Model Event");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) {
    return malformedHookResult(pointName, "a malformed Model Event");
  }
  const object = value as Record<string, unknown>;
  switch (object.type) {
    case "text-delta":
    case "reasoning-delta":
      if (typeof object.delta !== "string") {
        return malformedHookResult(pointName, "a malformed Model delta Event");
      }
      break;
    case "tool-call":
      if (!("call" in object)) {
        return malformedHookResult(pointName, "a malformed Tool Call Event");
      }
      try {
        const [call] = parseContentParts([object.call as ContentPart], "Model Event");
        if (call?.type !== "tool-call") {
          return malformedHookResult(pointName, "a malformed Tool Call Event");
        }
      } catch {
        return malformedHookResult(pointName, "a malformed Tool Call Event");
      }
      break;
    case "usage":
      try {
        parseModelUsage(object.usage, `Usage Event from Hook '${pointName}'`);
      } catch {
        return malformedHookResult(pointName, "a malformed Usage Event");
      }
      break;
    case "finish": {
      const response = object.response;
      if (
        typeof response !== "object" ||
        response === null ||
        Array.isArray(response) ||
        !("message" in response) ||
        !isModelMessage(response.message) ||
        !("finishReason" in response) ||
        !["stop", "tool-calls", "length", "content-filter", "error", "pause", "other"].includes(
          String(response.finishReason),
        )
      ) {
        return malformedHookResult(pointName, "a malformed finish Event");
      }
      if ("usage" in response && response.usage !== undefined) {
        try {
          parseModelUsage(response.usage, `finish Usage from Hook '${pointName}'`);
        } catch {
          return malformedHookResult(pointName, "a malformed finish Usage");
        }
      }
      break;
    }
    case "failure": {
      const failure = object.failure;
      if (
        typeof failure !== "object" ||
        failure === null ||
        Array.isArray(failure) ||
        !("type" in failure) ||
        failure.type !== "model-failure" ||
        !("reason" in failure) ||
        (failure.reason !== "content-policy" && failure.reason !== "invalid-request") ||
        !("provider" in failure) ||
        typeof failure.provider !== "string" ||
        !("message" in failure) ||
        typeof failure.message !== "string"
      ) {
        return malformedHookResult(pointName, "a malformed Failure Event");
      }
      break;
    }
    case "interruption": {
      const interruption = object.interruption;
      if (
        typeof interruption !== "object" ||
        interruption === null ||
        Array.isArray(interruption) ||
        !("type" in interruption)
      ) {
        return malformedHookResult(pointName, "a malformed Interruption Event");
      }
      // SAFETY: The object check above establishes a string-keyed object.
      const fields = interruption as Record<string, unknown>;
      const optionalString = (item: unknown): boolean =>
        item === undefined || typeof item === "string";
      let valid: boolean;
      switch (fields.type) {
        case "authentication-required":
          valid = typeof fields.provider === "string" && optionalString(fields.detail);
          break;
        case "provider-compatibility":
          valid =
            typeof fields.provider === "string" &&
            typeof fields.detail === "string" &&
            optionalString(fields.capability) &&
            optionalString(fields.providerDataNamespace) &&
            (fields.providerDataVersion === undefined ||
              (typeof fields.providerDataVersion === "number" &&
                Number.isFinite(fields.providerDataVersion) &&
                Number.isInteger(fields.providerDataVersion)));
          break;
        case "provider-unavailable":
          valid =
            typeof fields.provider === "string" &&
            ["rate-limit", "transport", "internal-provider", "quota-exhausted"].includes(
              String(fields.reason),
            ) &&
            (fields.retryAfterMs === undefined ||
              (typeof fields.retryAfterMs === "number" &&
                Number.isFinite(fields.retryAfterMs) &&
                fields.retryAfterMs >= 0)) &&
            optionalString(fields.resetAt) &&
            optionalString(fields.detail);
          break;
        case "model-output":
          valid = typeof fields.provider === "string" && typeof fields.detail === "string";
          break;
        case "artifact-storage-required":
          valid =
            (fields.operation === "read" || fields.operation === "write") &&
            optionalString(fields.detail);
          break;
        default:
          valid = false;
      }
      if (!valid) {
        return malformedHookResult(pointName, "a malformed Interruption Event");
      }
      if (fields.usage !== undefined) {
        try {
          parseModelUsage(fields.usage, `Interruption Usage from Hook '${pointName}'`);
        } catch {
          return malformedHookResult(pointName, "a malformed Interruption Usage");
        }
      }
      break;
    }
    default:
      return malformedHookResult(pointName, "an unknown Model Event");
  }
  return Object.freeze({ ...value }) as ModelEvent;
}

function parseModelInvocationCandidate(value: unknown, pointName: string): ModelInvocation {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) {
    return malformedHookResult(pointName, "a malformed Model invocation");
  }
  const candidate = value as ModelInvocationCandidate;
  switch (candidate.type) {
    case "response": {
      const event = parseModelEvent({ type: "finish", response: candidate.response }, pointName);
      if (event.type !== "finish") {
        return malformedHookResult(pointName, "a malformed Model response");
      }
      const toolCalls = event.response.message.content.filter(
        (part): part is ToolCallContentPart => part.type === "tool-call",
      );
      // SAFETY: The candidate and derived Tool Calls passed the canonical Model Event checks.
      return Object.freeze({
        type: "response",
        response: event.response,
        toolCalls,
      }) as unknown as ModelInvocation;
    }
    case "failure": {
      const event = parseModelEvent({ type: "failure", failure: candidate.failure }, pointName);
      if (event.type !== "failure") {
        return malformedHookResult(pointName, "a malformed Model Failure");
      }
      return Object.freeze({ type: "failure", failure: event.failure }) as ModelInvocation;
    }
    case "interruption": {
      const event = parseModelEvent(
        { type: "interruption", interruption: candidate.interruption },
        pointName,
      );
      if (event.type !== "interruption") {
        return malformedHookResult(pointName, "a malformed Model Interruption");
      }
      return Object.freeze({
        type: "interruption",
        interruption: event.interruption,
      }) as ModelInvocation;
    }
    default:
      return malformedHookResult(pointName, "an unknown Model invocation");
  }
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

const noHooks: readonly HookDefinition[] = Object.freeze([]);

type HookPointName = keyof typeof HookPoints;

function isHookPointName(value: string): value is HookPointName {
  return Object.hasOwn(HookPoints, value);
}

function indexHooks(
  hooks: readonly HookDefinition[],
): ReadonlyMap<HookPointName, readonly HookDefinition[]> {
  const grouped = new Map<HookPointName, HookDefinition[]>();
  for (const hook of hooks) {
    const pointName = hook.point.name;
    if (!isHookPointName(pointName)) {
      throw new RuntimeInvariantError(`Unknown Hook Point '${pointName}'`);
    }
    const pointHooks = grouped.get(pointName);
    if (pointHooks === undefined) {
      grouped.set(pointName, [hook]);
    } else {
      pointHooks.push(hook);
    }
  }
  const indexed = new Map<HookPointName, readonly HookDefinition[]>();
  for (const [pointName, pointHooks] of grouped) {
    indexed.set(pointName, Object.freeze(pointHooks));
  }
  return indexed;
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
function toolExecutionMode(tool: RuntimeTool): ToolExecutionMode {
  return tool.type === "static"
    ? tool.definition.executionMode
    : (tool.definition.executionMode ?? "parallel");
}

function toolTarget(tool: RuntimeTool): string {
  return tool.type === "static"
    ? `static:${tool.definition.name}`
    : `dynamic:${tool.providerId}:${tool.definition.name}`;
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
  function newId<Id extends string>(): Id {
    return generateId() as Id;
  }
  interface ActiveExecution {
    readonly execution: AbortController;
    model?: AbortController;
  }

  const active = new Map<RunId, ActiveExecution>();

  const requestAbort = async (runId: RunId, reason?: JsonValue): Promise<AbortResult> => {
    const result = await storeCall("requestAbort", () =>
      threadStore.requestAbort({
        runId,
        ...(reason === undefined ? {} : { reason }),
      }),
    );
    if (result.type === "accepted") {
      active.get(runId)?.execution.abort(new AbortExecution(reason));
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
      const context = await storeCall("readToolResumeContext", () =>
        threadStore.readToolResumeContext(command.runId),
      );
      if (
        context === undefined ||
        context.run.agent.id !== installed.reference.id ||
        context.run.agent.revision !== installed.reference.revision
      ) {
        return {
          type: "tool-resume-conflict",
          runId: command.runId,
          toolCallIds: command.items.map((item) => item.toolCallId),
        };
      }
      const run: RunIdentity = Object.freeze({
        runId: context.run.id,
        threadId: context.run.threadId,
        branchId: context.run.branchId,
        agent: installed.reference,
      });
      const providerSignal = new AbortController().signal;
      const resolvedProviders = new Map<string, Promise<readonly DynamicTool[]>>();
      const encodedItems: Array<{
        toolCallId: ToolCallId;
        toolName: string;
        encodedInput: JsonValue;
      }> = [];
      for (const item of command.items) {
        const call = context.toolCalls.find(
          (candidate) =>
            candidate.toolCallId === item.toolCallId && candidate.toolName === item.toolName,
        );
        if (call === undefined) {
          return {
            type: "tool-resume-conflict",
            runId: command.runId,
            toolCallIds: [item.toolCallId],
          };
        }
        let definition: ToolRuntimeDefinition | DynamicTool | undefined;
        if (call.providerId === undefined) {
          const contribution = installed.contributions.find(
            (candidate) => candidate.kind === "tool" && candidate.id === item.toolName,
          );
          if (contribution !== undefined && isToolRuntimeDefinition(contribution.value)) {
            definition = contribution.value;
          }
        } else {
          const contribution = installed.contributions.find(
            (candidate) =>
              candidate.kind === "tool" && candidate.id === `dynamic:${call.providerId}`,
          );
          if (contribution !== undefined && !isToolRuntimeDefinition(contribution.value)) {
            let resolved = resolvedProviders.get(call.providerId);
            if (resolved === undefined) {
              const provider = contribution.value as DynamicToolProvider<string>;
              resolved = Promise.resolve(
                provider.resolve({
                  transcript: context.transcript,
                  run,
                  signal: providerSignal,
                }),
              );
              resolvedProviders.set(call.providerId, resolved);
            }
            definition = (await resolved).find((candidate) => candidate.name === item.toolName);
          }
        }
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
          expectedHead: context.head,
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

    async redirect(input: RedirectInput): Promise<RedirectResult> {
      const result = await storeCall("acceptRedirect", () => threadStore.acceptRedirect(input));
      if (result.type === "accepted" && result.admitted) {
        active.get(input.runId)?.model?.abort(new RedirectModelInvocation());
      }
      return result;
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

      const modelProducts = new WeakMap<object, PreparedModelWork>();
      const toolProducts = new WeakMap<object, PreparedToolWork>();
      const preparedToolCalls = new WeakMap<object, PreparedToolWork>();
      const preparedToolCommits = new WeakMap<object, Promise<void>>();
      const hooksByPoint = indexHooks([...staticHooks(installed.contributions), ...dynamicHooks]);
      const hooksAt = (pointName: HookPointName): readonly HookDefinition[] =>
        hooksByPoint.get(pointName) ?? noHooks;
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
      let currentPhase: UnexpectedExecutionPhase = "prepare";
      const modelSessions = new Map<ModelCapability<string, unknown>, Promise<ModelSession>>();
      const acquiredModelSessions: ModelSession[] = [];
      let modelSessionsClosed = false;

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

      const assertModelActive = (signal: AbortSignal): void => {
        assertActive();
        if (signal.aborted) {
          throw signal.reason;
        }
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
        if (executionEventStore !== undefined) {
          const record = Object.freeze({
            runId,
            executionId,
            event,
          });
          try {
            await executionEventStore.append([record]);
          } catch (appendCause) {
            throw failEventStore(appendCause);
          }
        }
        for (const candidate of hooksAt("onExecutionEvent")) {
          if (candidate === failedHook) {
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
        pointName: HookPointName,
        event: unknown,
        reportObserverErrors = true,
      ): Promise<void> => {
        for (const hook of hooksAt(pointName)) {
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

      const observeEvent = async (event: ExecutionEvent): Promise<void> => {
        if (event.type === "model-event") {
          await notify("onModelEvent", { run: currentRun, event: event.event });
        }
        await notify("onExecutionEvent", { run: currentRun, event }, event.type !== "error");
      };

      let eventBuffer: ExecutionEventAppend[] = [];
      let bufferedSourceEvents = 0;
      let bufferedBytes = 0;
      let flushScheduled = false;
      let eventStoreFailure: ExecutionEventStoreError | undefined;
      let flushChain = Promise.resolve();

      const failEventStore = (cause: unknown): ExecutionEventStoreError => {
        const error =
          cause instanceof ExecutionEventStoreError ? cause : new ExecutionEventStoreError(cause);
        eventStoreFailure ??= error;
        if (!controller.signal.aborted) {
          controller.abort(error);
        }
        return eventStoreFailure;
      };

      const flushEvents = (): Promise<void> => {
        if (eventStoreFailure !== undefined) {
          return Promise.reject(eventStoreFailure);
        }
        if (eventBuffer.length === 0) {
          return flushChain;
        }
        const records = eventBuffer;
        eventBuffer = [];
        bufferedSourceEvents = 0;
        bufferedBytes = 0;
        const operation = flushChain.then(async () => {
          if (executionEventStore !== undefined) {
            // SAFETY: flushEvents returns before append when the batch is empty.
            await executionEventStore.append(
              records as [ExecutionEventAppend, ...ExecutionEventAppend[]],
            );
          }
          for (const record of records) {
            await observeEvent(record.event);
          }
        });
        flushChain = operation.catch((cause: unknown) => {
          throw failEventStore(cause);
        });
        return flushChain;
      };

      const scheduleEventFlush = (): void => {
        if (flushScheduled) {
          return;
        }
        flushScheduled = true;
        void Promise.resolve(clock.sleep(16, lifecycleController.signal))
          .then(() => {
            flushScheduled = false;
            return flushEvents();
          })
          .catch((cause: unknown) => {
            flushScheduled = false;
            if (
              !lifecycleController.signal.aborted &&
              !(cause instanceof ExecutionEventStoreError)
            ) {
              failEventStore(cause);
            }
          });
      };

      const emit = async (event: ExecutionEvent): Promise<void> => {
        if (executionEventStore === undefined) {
          await observeEvent(event);
          return;
        }
        if (eventStoreFailure !== undefined) {
          throw eventStoreFailure;
        }

        const delta = modelDelta(event);
        if (delta === undefined) {
          await flushEvents();
          eventBuffer.push(
            Object.freeze({
              runId,
              executionId,
              event,
            }),
          );
          bufferedSourceEvents += 1;
          await flushEvents();
          return;
        }

        const previous = eventBuffer.at(-1);
        const previousDelta = previous === undefined ? undefined : modelDelta(previous.event);
        if (previous !== undefined && previousDelta?.type === delta.type) {
          eventBuffer[eventBuffer.length - 1] = Object.freeze({
            ...previous,
            event: Object.freeze({
              type: "model-event" as const,
              event: Object.freeze({
                type: delta.type,
                delta: previousDelta.delta + delta.delta,
              }),
            }),
          });
        } else {
          eventBuffer.push(
            Object.freeze({
              runId,
              executionId,
              event,
            }),
          );
        }
        bufferedSourceEvents += 1;
        bufferedBytes += utf8ByteLength(delta.delta);
        if (bufferedSourceEvents >= 64 || bufferedBytes >= 64 * 1024) {
          await flushEvents();
          return;
        }
        scheduleEventFlush();
      };

      const transformModelRequest = async (
        request: ModelRequest,
        signal: AbortSignal,
      ): Promise<ModelRequest> => {
        let current = request;
        const availableTools = new Map(
          request.tools.map(
            (tool) =>
              [tool.name, stableJson(requireJson(tool, `Installed Tool '${tool.name}'`))] as const,
          ),
        );
        for (const hook of hooksAt("beforeModelRequest")) {
          let result: { readonly request?: ModelRequest } | HookBlock | undefined;
          try {
            result = (await hook.handler({
              run: currentRun,
              request: current,
              signal,
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
            try {
              requireJson(object.request, "Transformed Model Request");
            } catch {
              return malformedHookResult("beforeModelRequest", "a non-JSON request patch");
            }
            const names = new Set<string>();
            for (const tool of object.request.tools) {
              if (
                typeof tool !== "object" ||
                tool === null ||
                Array.isArray(tool) ||
                typeof tool.name !== "string" ||
                names.has(tool.name) ||
                availableTools.get(tool.name) !==
                  stableJson(requireJson(tool, `Transformed Tool '${tool.name}'`))
              ) {
                return malformedHookResult(
                  "beforeModelRequest",
                  "a request patch that adds or changes a Tool",
                );
              }
              names.add(tool.name);
            }
            current = object.request;
          }
        }
        return current;
      };

      const transformModelEvent = async (
        event: ModelEvent,
        signal: AbortSignal,
      ): Promise<ModelEvent | undefined> => {
        let current: ModelEvent | undefined = event;
        for (const hook of hooksAt("transformModelEvent")) {
          if (current === undefined) {
            continue;
          }
          let result: { readonly event?: ModelEvent } | HookBlock | undefined;
          try {
            result = (await hook.handler({
              run: currentRun,
              event: current,
              signal,
            })) as typeof result;
          } catch (cause) {
            throw new UnexpectedExecutionError("hook", cause);
          }
          const object = hookResultObject("transformModelEvent", result);
          if (object === undefined) {
            continue;
          }
          if ("type" in object) {
            if (
              object.type !== "block" ||
              !("failure" in object) ||
              Object.keys(object).some((key) => key !== "type" && key !== "failure")
            ) {
              return malformedHookResult("transformModelEvent", "an invalid block result");
            }
            throw new HookBlockedExecution("transformModelEvent", object.failure);
          }
          if (!("event" in object) || Object.keys(object).some((key) => key !== "event")) {
            return malformedHookResult("transformModelEvent", "an invalid Event patch");
          }
          current =
            object.event === undefined
              ? undefined
              : parseModelEvent(object.event, "transformModelEvent");
        }
        return current;
      };

      const transformToolInput = async (call: StoredToolCall): Promise<unknown> => {
        let current: unknown = call.input;
        for (const hook of hooksAt("beforeToolExecution")) {
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
        signal: AbortSignal,
      ): Promise<
        | { readonly type: "continue"; readonly invocation: ModelInvocation }
        | { readonly type: "retry"; readonly delayMs?: number }
      > => {
        let current = invocation;
        for (const hook of hooksAt("afterModelInvocation")) {
          let result:
            | { readonly invocation: ModelInvocationCandidate }
            | { readonly type: "retry"; readonly delayMs?: number }
            | HookBlock
            | undefined;
          try {
            result = (await hook.handler({
              run: currentRun,
              invocation: current,
              signal,
            })) as typeof result;
          } catch (cause) {
            throw new UnexpectedExecutionError("hook", cause);
          }
          const object = hookResultObject("afterModelInvocation", result);
          if (object === undefined) {
            continue;
          }
          if ("invocation" in object) {
            if (Object.keys(object).some((key) => key !== "invocation")) {
              return malformedHookResult(
                "afterModelInvocation",
                "an invalid invocation replacement",
              );
            }
            current = parseModelInvocationCandidate(object.invocation, "afterModelInvocation");
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
          if (current.type !== "interruption") {
            throw new RuntimeInvariantError(
              "afterModelInvocation requested a retry for a non-Interruption result",
            );
          }
          return object as { readonly type: "retry"; readonly delayMs?: number };
        }
        return { type: "continue", invocation: current };
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
            id: newId<MessageEntryId>(),
            message: pending.message,
          }));
          const consumedSteering = snapshot.pendingSteering.at(-1);
          const consumedRedirect = snapshot.pendingRedirects.at(-1);
          guarded(
            await storeCall("commitStep", () =>
              threadStore.commitStep({
                claim,
                expectedHead: snapshot.head,
                commitId: newId<CommitId>(),
                entries,
                ...(consumedSteering === undefined
                  ? {}
                  : { consumedSteeringThrough: consumedSteering.sequence }),
                ...(consumedRedirect === undefined
                  ? {}
                  : { consumedRedirectsThrough: consumedRedirect.sequence }),
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
        const pendingToolCalls = snapshot.toolCalls
          .filter((call) => call.parentToolCallId === undefined && !call.historyCommitted)
          .sort((left, right) => left.sequence - right.sequence);
        const tools = new Map<string, RuntimeTool>();
        const providers = new Map<string, DynamicToolProvider<string>>();
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
          providers.set(provider.id, provider);
        }
        const resolvedProviders = new Map<string, Promise<ReadonlyMap<string, RuntimeTool>>>();
        const emptyDynamicTools: ReadonlyMap<string, RuntimeTool> = new Map();
        const emptyDynamicToolsPromise = Promise.resolve(emptyDynamicTools);
        const resolveDynamicProvider = (
          providerId: string,
        ): Promise<ReadonlyMap<string, RuntimeTool>> => {
          const current = resolvedProviders.get(providerId);
          if (current !== undefined) {
            return current;
          }
          const provider = providers.get(providerId);
          if (provider === undefined) {
            resolvedProviders.set(providerId, emptyDynamicToolsPromise);
            return emptyDynamicToolsPromise;
          }
          const resolved = Promise.resolve()
            .then(() =>
              provider.resolve({
                transcript: snapshot.transcript,
                run: currentRun,
                signal: controller.signal,
              }),
            )
            .then((definitions) => {
              const providerTools = new Map<string, RuntimeTool>();
              for (const definition of definitions) {
                const name = definition.name;
                if (providerTools.has(name)) {
                  throw new RuntimeInvariantError(
                    `Dynamic Tool '${name}' conflicts with another Tool`,
                  );
                }
                providerTools.set(name, {
                  type: "dynamic",
                  providerId,
                  modelTool: Object.freeze({
                    name,
                    ...(definition.description === undefined
                      ? {}
                      : { description: definition.description }),
                    inputSchema: schemaJson(definition.input),
                  }),
                  definition: Object.freeze({ ...definition }),
                });
              }
              return providerTools;
            });
          resolvedProviders.set(providerId, resolved);
          return resolved;
        };
        const pendingProviderIds = new Set<string>();
        for (const call of pendingToolCalls) {
          if (call.providerId !== undefined) {
            pendingProviderIds.add(call.providerId);
          }
        }
        const selectedProviderIds = [...providers.keys()].filter(
          (providerId) => pendingToolCalls.length === 0 || pendingProviderIds.has(providerId),
        );
        const providerToolsPromise = Promise.all(selectedProviderIds.map(resolveDynamicProvider));
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
        const [providerToolSets, context] = await Promise.all([
          providerToolsPromise,
          contextPromise,
        ]);
        for (const providerTools of providerToolSets) {
          for (const [name, tool] of providerTools) {
            if (tools.has(name)) {
              throw new RuntimeInvariantError(`Dynamic Tool '${name}' conflicts with another Tool`);
            }
            tools.set(name, tool);
          }
        }
        if (pendingToolCalls.length > 0) {
          const calls = Object.freeze(
            pendingToolCalls.map((call) => {
              // SAFETY: The private map below proves that only this Runtime-created call can authorize execution.
              const preparedCall = Object.freeze({
                type: "tool-call" as const,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
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
          for (const call of calls) {
            preparedToolCalls.set(call, prepared);
          }
          return prepared;
        }

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
        signal: AbortSignal,
      ): AsyncIterable<ModelEvent> => ({
        async *[Symbol.asyncIterator]() {
          assertModelActive(signal);
          const session = await acquireModelSession(model);
          const source = await session.invoke(request, { signal });
          let terminal = false;
          for await (const event of source) {
            assertModelActive(signal);
            if (terminal) {
              throw new RuntimeInvariantError("Model emitted an Event after its terminal Event");
            }
            const invocation = terminalInvocation(event);
            if (invocation !== undefined) {
              terminal = true;
              const reportedUsage = invocationUsage(invocation);
              const usage =
                reportedUsage === undefined
                  ? undefined
                  : parseModelUsage(reportedUsage, `Usage from Model '${model.id}'`);
              guarded(
                await storeCall("recordModelCall", () =>
                  threadStore.recordModelCall({
                    claim,
                    commitId: newId<CommitId>(),
                    modelId: model.id,
                    ...(usage === undefined ? {} : { usage }),
                  }),
                ),
              );
            }
            yield event;
          }
          if (!terminal) {
            throw new RuntimeInvariantError("Model stream ended without a terminal Event");
          }
        },
      });

      const invokeRuntimeModel = async (
        model: RuntimeModel,
        request: ModelRequest,
        activeModels: readonly RuntimeModel[],
        signal: AbortSignal,
      ): Promise<AsyncIterable<ModelEvent>> => {
        if (activeModels.includes(model)) {
          const id = model.type === "leaf" ? model.capability.id : model.id;
          throw new RuntimeInvariantError(`Composite Model cycle reached '${id}'`);
        }
        if (model.type === "leaf") {
          return leafEvents(model.capability, request, signal);
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
          signal,
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
            const result = invokeRuntimeModel(runtime, childRequest, path, signal).then(
              nestedResult,
            );
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
                const events = await invokeRuntimeModel(runtime, childRequest, path, signal);
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

      const invokeModel = async (prepared: PreparedModelWork): Promise<ModelInvocation> => {
        const state = preparedStates.get(prepared);
        if (state === undefined || !isPreparedModelState(state)) {
          throw new RuntimeInvariantError("Model Work belongs to another Execution");
        }
        currentPhase = "model";
        assertActive();
        const modelController = new AbortController();
        const abortModel = (): void => {
          modelController.abort(controller.signal.reason);
        };
        controller.signal.addEventListener("abort", abortModel, { once: true });
        activeExecution.model = modelController;
        const runModel = async (): Promise<ModelInvocation> => {
          while (true) {
            assertModelActive(modelController.signal);
            const request = await transformModelRequest(state.request, modelController.signal);
            const advertisedTools = new Set(request.tools.map((tool) => tool.name));
            const events = await invokeRuntimeModel(
              state.model,
              request,
              [],
              modelController.signal,
            );
            let invocation: ModelInvocation | undefined;
            for await (const sourceEvent of events) {
              assertModelActive(modelController.signal);
              const event = await transformModelEvent(sourceEvent, modelController.signal);
              if (event === undefined) {
                continue;
              }
              if (invocation !== undefined) {
                throw new RuntimeInvariantError("Model emitted an Event after its terminal Event");
              }
              const terminal = terminalInvocation(event);
              if (terminal === undefined) {
                await emit(Object.freeze({ type: "model-event", event }));
                continue;
              }
              invocation = terminal;
            }
            if (invocation === undefined) {
              throw new RuntimeInvariantError("Model stream ended without a terminal Event");
            }

            const decision = await afterModelInvocation(invocation, modelController.signal);
            if (decision.type === "retry") {
              if (decision.delayMs !== undefined) {
                await clock.sleep(decision.delayMs, modelController.signal);
              }
              continue;
            }
            invocation = decision.invocation;
            if (invocation.type === "response") {
              const seen = new Set<ToolCallId>();
              for (const call of invocation.toolCalls) {
                if (seen.has(call.toolCallId)) {
                  throw new RuntimeInvariantError(`Duplicate Tool Call ID '${call.toolCallId}'`);
                }
                seen.add(call.toolCallId);
                if (!state.tools.has(call.toolName)) {
                  throw new RuntimeInvariantError(
                    `Model requested unknown Tool '${call.toolName}'`,
                  );
                }
                if (!advertisedTools.has(call.toolName)) {
                  throw new RuntimeInvariantError(`Model requested hidden Tool '${call.toolName}'`);
                }
              }
            }

            const terminalEvent = eventForNestedResult(invocation);
            await emit(
              Object.freeze({
                type: "model-event",
                event: Object.freeze(terminalEvent),
              }),
            );

            assertModelActive(modelController.signal);
            if (invocation.type === "response") {
              const mustCommit =
                invocation.toolCalls.length > 0 || invocation.response.finishReason === "pause";
              if (mustCommit) {
                const entry = {
                  id: newId<MessageEntryId>(),
                  message: invocation.response.message,
                };
                const committed = await storeCall("commitModelInvocation", () =>
                  threadStore.commitModelInvocation({
                    claim,
                    expectedHead: state.snapshot.head,
                    commitId: newId<CommitId>(),
                    entry,
                    toolCalls: invocation.toolCalls.map((call) => {
                      const tool = state.tools.get(call.toolName);
                      if (tool === undefined) {
                        throw new RuntimeInvariantError(
                          `Model requested unknown Tool '${call.toolName}'`,
                        );
                      }
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
                );
                if (committed.type === "work-ready") {
                  throw new ContinueLoop();
                }
                guarded(committed);
              }
            }
            modelProducts.set(invocation, prepared);
            return invocation;
          }
        };
        try {
          return await runModel();
        } catch (cause) {
          if (modelController.signal.reason instanceof RedirectModelInvocation) {
            throw new ContinueLoop();
          }
          throw cause;
        } finally {
          controller.signal.removeEventListener("abort", abortModel);
          if (activeExecution.model === modelController) {
            activeExecution.model = undefined;
          }
        }
      };

      const interruptStaleAgent = async (
        call: StoredToolCall,
        snapshot: ExecutionSnapshot,
        detail: string,
      ): Promise<never> => {
        const interruption: InterruptedExecutionResult = {
          type: "interrupted",
          runId,
          interruption: {
            type: "stale-agent",
            expected: call.suspension?.agent ?? snapshot.run.agent,
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

      const resolveAvailableTool = async (
        state: PreparedState,
        toolName: string,
        providerId: string | undefined,
      ): Promise<RuntimeTool | undefined> => {
        const installedTool = state.tools.get(toolName);
        if (installedTool !== undefined || providerId === undefined) {
          return installedTool;
        }
        return (await state.resolveDynamicProvider(providerId)).get(toolName);
      };

      const resolveRuntimeTool = async (
        state: PreparedState,
        call: StoredToolCall,
        snapshot: ExecutionSnapshot,
      ): Promise<RuntimeTool> => {
        const tool = await resolveAvailableTool(state, call.toolName, call.providerId);
        if (tool === undefined) {
          if (call.providerId !== undefined) {
            return interruptStaleAgent(
              call,
              snapshot,
              `Dynamic Tool '${call.toolName}' is no longer available`,
            );
          }
          throw new RuntimeInvariantError(`Stored Tool '${call.toolName}' is not installed`);
        }
        if ((tool.type === "dynamic" ? tool.providerId : undefined) !== call.providerId) {
          if (call.providerId !== undefined) {
            return interruptStaleAgent(
              call,
              snapshot,
              `Dynamic Tool '${call.toolName}' changed Provider ownership`,
            );
          }
          throw new RuntimeInvariantError(`Stored Tool '${call.toolName}' changed ownership`);
        }
        return tool;
      };

      const validateCompletedToolResult = async (
        tool: RuntimeTool,
        toolName: string,
        value: unknown,
      ): Promise<CompletedToolCallResult> => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return malformedHookResult("afterToolExecution", "a malformed Tool result");
        }
        const object = value as Record<string, unknown>;
        const content =
          object.content === undefined
            ? Object.freeze([])
            : parseContentParts(object.content as readonly ContentPart[], toolName);
        if (object.type === "success") {
          if (
            !("output" in object) ||
            Object.keys(object).some(
              (key) => key !== "type" && key !== "output" && key !== "content",
            )
          ) {
            return malformedHookResult("afterToolExecution", "a malformed Tool success");
          }
          const output =
            tool.definition.output === undefined
              ? object.output
              : await validateSchema(tool.definition.output, object.output);
          return Object.freeze({
            type: "success",
            output: requireJson(output, `Output from Tool '${toolName}'`),
            ...(content.length === 0 ? {} : { content }),
          });
        }
        if (object.type === "failure") {
          const failureSchema = tool.definition.failure;
          if (
            failureSchema === undefined ||
            !("failure" in object) ||
            Object.keys(object).some(
              (key) => key !== "type" && key !== "failure" && key !== "content",
            )
          ) {
            return malformedHookResult("afterToolExecution", "a malformed Tool Failure");
          }
          const failure = await validateSchema(failureSchema, object.failure);
          return Object.freeze({
            type: "failure",
            failure: requireJson(failure, `Failure from Tool '${toolName}'`),
            ...(content.length === 0 ? {} : { content }),
          });
        }
        return malformedHookResult("afterToolExecution", "an unknown Tool result");
      };

      const transformCompletedToolResult = async (
        call: StoredToolCall,
        tool: RuntimeTool,
        result: CompletedToolCallResult,
      ): Promise<CompletedToolCallResult> => {
        let current = result;
        for (const hook of hooksAt("afterToolExecution")) {
          let hookResult: { readonly result: CompletedToolCallResult } | HookBlock | undefined;
          try {
            hookResult = (await hook.handler({
              run: currentRun,
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              result: current,
              signal: controller.signal,
            })) as typeof hookResult;
          } catch (cause) {
            throw new UnexpectedExecutionError("hook", cause);
          }
          const object = hookResultObject("afterToolExecution", hookResult);
          if (object === undefined) {
            continue;
          }
          if ("type" in object) {
            if (
              object.type !== "block" ||
              !("failure" in object) ||
              Object.keys(object).some((key) => key !== "type" && key !== "failure")
            ) {
              return malformedHookResult("afterToolExecution", "an invalid block result");
            }
            throw new HookBlockedExecution("afterToolExecution", object.failure);
          }
          if (!("result" in object) || Object.keys(object).some((key) => key !== "result")) {
            return malformedHookResult("afterToolExecution", "an invalid result replacement");
          }
          try {
            current = await validateCompletedToolResult(tool, call.toolName, object.result);
          } catch (cause) {
            if (cause instanceof UnexpectedExecutionError) {
              throw cause;
            }
            throw new UnexpectedExecutionError("hook", cause);
          }
        }
        return current;
      };

      const attemptToolCall = async (
        prepared: PreparedToolWork,
        originalCall: StoredToolCall,
        activeTargets: readonly string[],
      ): Promise<ToolAttemptOutcome> => {
        const state = preparedToolState(prepared);
        currentPhase = "tool";
        assertActive();
        const snapshot = state.snapshot;
        let call = originalCall;
        const existing = toolResult(call);
        if (existing !== undefined) {
          return { type: "success", result: existing, stored: call };
        }
        if (call.status === "aborted") {
          throw new AbortExecution(snapshot.run.abortReason);
        }

        const toolCallId = call.toolCallId;
        const toolName = call.toolName;
        const tool = await resolveRuntimeTool(state, call, snapshot);
        const validateToolInput = async (
          currentCall: StoredToolCall,
          value: unknown,
        ): Promise<unknown> => {
          try {
            return await validateSchema(tool.definition.input, value);
          } catch (cause) {
            if (tool.type === "dynamic") {
              return interruptStaleAgent(
                currentCall,
                snapshot,
                cause instanceof Error
                  ? cause.message
                  : `Dynamic Tool '${currentCall.toolName}' rejected its stored input`,
              );
            }
            throw cause;
          }
        };
        const target = toolTarget(tool);
        if (activeTargets.includes(target)) {
          throw new RuntimeInvariantError(`Tool delegation cycle reached '${call.toolName}'`);
        }
        const path = [...activeTargets, target];

        let input: unknown = call.effectiveInput;
        if (input === undefined) {
          input = await transformToolInput(call);
          input = await validateToolInput(call, input);
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
        } else {
          input = await validateToolInput(call, input);
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
            const candidate = await resolveAvailableTool(state, dynamicToolName, provider.id);
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
            const eventSchema = tool.definition.event;
            if (eventSchema === undefined) {
              throw new RuntimeInvariantError(`Tool '${toolName}' emitted an undeclared Event`);
            }
            value = await validateSchema(eventSchema, event);
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

        try {
          let rawResult: unknown;
          if (call.suspension?.resumeInput !== undefined) {
            const suspension = tool.definition.suspension;
            if (suspension === undefined) {
              if (tool.type === "dynamic") {
                await interruptStaleAgent(
                  call,
                  snapshot,
                  `Dynamic Tool '${call.toolName}' no longer declares Suspension`,
                );
              }
              throw new RuntimeInvariantError(
                `Tool '${call.toolName}' has resume input without a suspension contract`,
              );
            }
            if (
              tool.type === "static" &&
              call.suspension.agent.revision !== installed.reference.revision
            ) {
              await interruptStaleAgent(
                call,
                snapshot,
                "Suspended Tool state was created by a different Agent revision",
              );
            }
            let continuation: unknown;
            try {
              continuation = await suspension.continuation.decode(call.suspension.continuation);
            } catch (cause) {
              await interruptStaleAgent(
                call,
                snapshot,
                cause instanceof Error ? cause.message : "Continuation Codec rejected stored state",
              );
            }
            let resumeInput: unknown;
            try {
              resumeInput = await validateSchema(
                suspension.resumeInput,
                call.suspension.resumeInput,
              );
            } catch (cause) {
              if (tool.type === "dynamic") {
                await interruptStaleAgent(
                  call,
                  snapshot,
                  cause instanceof Error
                    ? cause.message
                    : `Dynamic Tool '${call.toolName}' rejected its stored resume input`,
                );
              }
              throw cause;
            }
            rawResult = await suspension.resume({ input: resumeInput, continuation }, context);
          } else if (call.status === "suspended") {
            return { type: "suspended" };
          } else if (tool.type === "dynamic") {
            rawResult = await tool.definition.execute(input, context);
          } else {
            rawResult = await tool.definition.handler(input, context);
          }

          if (isToolFailure(rawResult)) {
            const failureSchema = tool.definition.failure;
            if (failureSchema === undefined) {
              throw new RuntimeInvariantError(`Tool '${toolName}' returned an undeclared Failure`);
            }
            const failure = await validateSchema(failureSchema, toolFailureValue(rawResult));
            const content = parseContentParts(toolResultContent(rawResult), toolName);
            const result = await transformCompletedToolResult(
              call,
              tool,
              Object.freeze({
                type: "failure" as const,
                failure: requireJson(failure, `Failure from Tool '${call.toolName}'`),
                ...(content.length === 0 ? {} : { content }),
              }),
            );
            const stored = guarded(
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
            return { type: "success", result, stored };
          }

          if (isToolSuspension(rawResult)) {
            const suspension = tool.definition.suspension;
            if (suspension === undefined) {
              throw new RuntimeInvariantError(
                `Tool '${call.toolName}' returned an undeclared Suspension`,
              );
            }
            const continuation = requireJson(
              await suspension.continuation.encode(toolSuspensionValue(rawResult)),
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

          const content = isToolSuccess(rawResult)
            ? parseContentParts(toolResultContent(rawResult), toolName)
            : Object.freeze([]);
          const rawOutput = isToolSuccess(rawResult) ? toolSuccessValue(rawResult) : rawResult;
          const output =
            tool.definition.output === undefined
              ? rawOutput
              : await validateSchema(tool.definition.output, rawOutput);
          const result = await transformCompletedToolResult(
            call,
            tool,
            Object.freeze({
              type: "success" as const,
              output: requireJson(output, `Output from Tool '${call.toolName}'`),
              ...(content.length === 0 ? {} : { content }),
            }),
          );
          const stored = guarded(
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
          return { type: "success", result, stored };
        } catch (cause) {
          if (cause instanceof ChildSuspended) {
            return { type: "suspended" };
          }
          throw cause;
        }
      };
      const commitPreparedToolResults = async (state: PreparedToolState): Promise<void> => {
        if (state.outcomes.size !== state.prepared.calls.length) {
          return;
        }
        let commit = preparedToolCommits.get(state.prepared);
        if (commit === undefined) {
          commit = (async () => {
            const entries = state.prepared.calls.map((preparedCall) => {
              const call = state.outcomes.get(preparedCall.toolCallId);
              if (call === undefined) {
                throw new RuntimeInvariantError(
                  `Prepared Tool Call '${preparedCall.toolCallId}' has no stored outcome`,
                );
              }
              const result = call.result;
              if (result === undefined || result.type === "aborted") {
                throw new RuntimeInvariantError(
                  `Resolved Tool Call '${call.toolCallId}' has no declared result`,
                );
              }
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
                      ...(call.providerData === undefined
                        ? {}
                        : { providerData: call.providerData }),
                    },
                    ...(result.content ?? []),
                  ],
                },
              };
            });
            guarded(
              await storeCall("commitToolResults", () =>
                threadStore.commitToolResults({
                  claim,
                  expectedHead: state.snapshot.head,
                  commitId: newId<CommitId>(),
                  entries,
                }),
              ),
            );
          })();
          preparedToolCommits.set(state.prepared, commit);
        }
        await commit;
      };

      const executeTool = async (
        prepared: PreparedToolWork,
        requested: PreparedToolCall,
      ): Promise<ToolExecution> => {
        if (preparedToolCalls.get(requested) !== prepared) {
          throw new RuntimeInvariantError("Tool Call belongs to another Prepared Work value");
        }
        const state = preparedToolState(prepared);
        const call = await storeCall("loadToolCall", () =>
          threadStore.loadToolCall(claim, requested.toolCallId),
        );
        if (call === undefined) {
          throw new ExecutionClaimLostError(runId);
        }
        if (call.toolName !== requested.toolName) {
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
          state.outcomes.set(call.toolCallId, outcome.stored);
          await commitPreparedToolResults(state);
        }
        return product;
      };

      const beforeSettlement = async (
        result: Exclude<RunResult, SuspendedRunResult>,
      ): Promise<ModelMessage | undefined> => {
        for (const hook of hooksAt("beforeSettlement")) {
          const deadline = new AbortController();
          const abortDeadline = (): void => {
            deadline.abort(controller.signal.reason);
          };
          controller.signal.addEventListener("abort", abortDeadline, {
            once: true,
          });
          const handler = Promise.resolve()
            .then(() =>
              hook.handler({
                run: currentRun,
                result,
                signal: deadline.signal,
              }),
            )
            .then(
              (value) => ({ type: "result" as const, value }),
              (cause: unknown) => ({ type: "failure" as const, cause }),
            );
          const timeout = Promise.resolve(clock.sleep(30_000, deadline.signal)).then(
            () => ({ type: "timeout" as const }),
            (cause: unknown) => ({ type: "timer-failure" as const, cause }),
          );
          const outcome = await Promise.race([handler, timeout]);
          controller.signal.removeEventListener("abort", abortDeadline);
          if (!deadline.signal.aborted) {
            deadline.abort();
          }
          if (outcome.type === "timeout") {
            await emit(
              Object.freeze({
                type: "error",
                error: new UnexpectedExecutionError(
                  "hook",
                  new Error("Hook 'beforeSettlement' exceeded its 30000 ms deadline"),
                ),
              }),
            );
            continue;
          }
          if (outcome.type === "timer-failure") {
            assertActive();
            throw new UnexpectedExecutionError("hook", outcome.cause);
          }
          if (outcome.type === "failure") {
            throw new UnexpectedExecutionError("hook", outcome.cause);
          }
          const object = hookResultObject("beforeSettlement", outcome.value);
          if (object === undefined) {
            continue;
          }
          if (
            object.type !== "continue" ||
            !("instruction" in object) ||
            !isModelMessage(object.instruction) ||
            Object.keys(object).some((key) => key !== "type" && key !== "instruction")
          ) {
            return malformedHookResult("beforeSettlement", "an invalid continuation instruction");
          }
          return (object as unknown as SettlementContinuation).instruction;
        }
        return undefined;
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
        if (type !== "aborted") {
          const instruction = await beforeSettlement(result);
          if (instruction !== undefined && snapshot.run.settlementContinuations < 32) {
            const continued = await storeCall("continueSettlement", () =>
              threadStore.continueSettlement({
                claim,
                expectedHead: snapshot.head,
                commitId: newId<CommitId>(),
                candidateEntries: entries,
                instructionEntry: {
                  id: newId<MessageEntryId>(),
                  message: instruction,
                },
              }),
            );
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
        prepared: PreparedWork,
        product: ModelInvocation | ToolExecution,
      ): Promise<ResolvedExecution> => {
        if (!preparedStates.has(prepared)) {
          throw new RuntimeInvariantError("Prepared Work belongs to another Execution");
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
                cause instanceof ThreadStoreError ||
                cause instanceof ArtifactStoreError ||
                cause instanceof UnexpectedExecutionError
                  ? cause
                  : new UnexpectedExecutionError(currentPhase, cause));
              if (!(error instanceof ExecutionEventStoreError)) {
                await emit(Object.freeze({ type: "error", error }));
              }
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
