import type { InstalledAgentData } from "../agent.js";
import type { CompletedToolCallResult } from "../hook.js";
import type { ModelMessage } from "../protocol.js";
import type {
  InterruptedExecutionResult,
  ExecutionEvent,
  PreparedToolCall,
  PreparedToolWork,
  ResumeRunInput,
  ResumeRunResult,
  ToolExecution,
  ToolSuspensionRecord,
} from "../runtime.js";
import { ExecutionClaimLostError } from "../runtime.js";
import type {
  ExecutionSnapshot,
  StoredToolCall,
  StoredToolFailure,
  ThreadStore,
} from "../store.js";
import {
  isToolRuntimeDefinition,
  isDynamicToolProviderFragment,
  isToolFailure,
  isToolSuccess,
  isToolSuspension,
  runtimeDynamicToolProvider,
  runtimeToolDefinition,
  toolFailureValue,
  toolResultContent,
  toolSuccessValue,
  toolSuspensionValue,
  type DynamicToolProvider,
  type DynamicToolProviderFragment,
  type ToolDefinition,
  type ToolExecutionMode,
  type ToolInvocationResult,
} from "../tool.js";
import type { AgentReference, RunIdentity } from "../identity.js";
import type { JsonValue, MessageEntryId, RunId, ToolAttemptId, ToolCallId } from "../types.js";
import { schemaJson, validateSchema } from "../schema.js";
import type { ExecutionEvents } from "./execution-events.js";
import {
  AbortExecution,
  ChildSuspended,
  InterruptExecution,
  RuntimeInvariantError,
} from "./execution-signals.js";
import {
  isPreparedToolState,
  type PreparedState,
  type PreparedToolState,
  type RuntimeTool,
} from "./execution-state.js";
import type { HookRuntime } from "./hooks.js";
import { malformedHookResult, parseContentParts, requireJson } from "./protocol-parsing.js";

interface ToolAttemptSuccess {
  readonly type: "success";
  readonly result: ToolInvocationResult<JsonValue, JsonValue>;
  readonly stored: StoredToolCall;
}

interface ToolAttemptSuspended {
  readonly type: "suspended";
}

type ToolAttemptOutcome = ToolAttemptSuccess | ToolAttemptSuspended;

/** One Tool Result entry awaiting a durable commit. */
export interface ToolResultEntry {
  readonly id: MessageEntryId;
  readonly toolCallId: ToolCallId;
  readonly message: ModelMessage;
}

/** Persistence operations needed by Tool execution. */
export interface ToolStore {
  readonly recordInterruption: (
    interruption: InterruptedExecutionResult["interruption"],
  ) => Promise<void>;
  readonly loadToolCall: (toolCallId: ToolCallId) => Promise<StoredToolCall | undefined>;
  readonly recordToolInput: (toolCallId: ToolCallId, input: JsonValue) => Promise<StoredToolCall>;
  readonly recordDelegatedToolCall: (input: {
    readonly parentToolCallId: ToolCallId;
    readonly toolCallId: ToolCallId;
    readonly toolName: string;
    readonly providerId?: string;
    readonly key: string;
    readonly input: JsonValue;
  }) => Promise<StoredToolCall>;
  readonly completeToolCall: (
    toolCallId: ToolCallId,
    result: CompletedToolCallResult,
  ) => Promise<StoredToolCall>;
  readonly suspendToolCall: (
    toolCallId: ToolCallId,
    continuation: JsonValue,
    agent: AgentReference,
  ) => Promise<void>;
  readonly commitToolResults: (
    expectedHead: MessageEntryId,
    entries: readonly ToolResultEntry[],
  ) => Promise<void>;
}

/** Internal Tool operations for one Execution. */
export interface ToolRuntime {
  readonly registerPrepared: (prepared: PreparedToolWork) => void;
  readonly execute: (
    prepared: PreparedToolWork,
    requested: PreparedToolCall,
  ) => Promise<ToolExecution>;
  readonly ownsProduct: (prepared: PreparedToolWork, product: object) => boolean;
}

/** Read the execution mode for one available Tool. */
export function toolExecutionMode(tool: RuntimeTool): ToolExecutionMode {
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
    return { type: "failure", failure: call.result.failure.value };
  }
  return undefined;
}

function finishedToolEvent(tool: RuntimeTool, call: StoredToolCall): ExecutionEvent {
  if (call.result?.type === "success") {
    return Object.freeze({
      ...eventIdentity(tool, call),
      type: "tool-finished",
      result: { type: "success" as const, output: call.result.output },
    });
  }
  if (call.result?.type !== "failure") {
    throw new RuntimeInvariantError(`Tool Call '${call.toolCallId}' has no terminal result`);
  }
  const failure: StoredToolFailure = call.result.failure;
  if (tool.type === "dynamic") {
    if (failure.dynamic !== true || failure.providerId !== tool.providerId) {
      throw new RuntimeInvariantError(`Dynamic Tool Call '${call.toolCallId}' has static Failure`);
    }
    return Object.freeze({
      dynamic: true,
      providerId: tool.providerId,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      type: "tool-finished",
      result: { type: "failure" as const, failure },
    });
  }
  if (failure.dynamic === true) {
    throw new RuntimeInvariantError(`Static Tool Call '${call.toolCallId}' has dynamic Failure`);
  }
  return Object.freeze({
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    type: "tool-finished",
    result: { type: "failure" as const, failure },
  });
}

function eventIdentity(tool: RuntimeTool, call: StoredToolCall) {
  return tool.type === "dynamic"
    ? {
        dynamic: true as const,
        providerId: tool.providerId,
        toolName: call.toolName,
        toolCallId: call.toolCallId,
      }
    : {
        toolName: call.toolName,
        toolCallId: call.toolCallId,
      };
}

/** Project durable Tool suspensions into the public Runtime result. */
export function publicSuspensions(snapshot: ExecutionSnapshot): readonly ToolSuspensionRecord[] {
  return snapshot.toolCalls
    .filter((call) => call.status === "suspended")
    .sort((left, right) => left.sequence - right.sequence)
    .map((call) =>
      call.providerId === undefined
        ? Object.freeze({ toolCallId: call.toolCallId, toolName: call.toolName })
        : Object.freeze({
            dynamic: true as const,
            providerId: call.providerId,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
          }),
    );
}

/** A cached view of static and dynamic Tools for one Run state. */
export interface ToolCatalog {
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly resolveDynamicProvider: (
    providerId: string,
  ) => Promise<ReadonlyMap<string, RuntimeTool>>;
  readonly prepare: (
    pendingCalls: readonly StoredToolCall[],
  ) => Promise<ReadonlyMap<string, RuntimeTool>>;
}

/** Create one Tool catalog for a stable Run transcript. */
export function createToolCatalog(options: {
  readonly installed: InstalledAgentData;
  readonly transcript: ExecutionSnapshot["transcript"];
  readonly run: RunIdentity;
  readonly signal: AbortSignal;
}): ToolCatalog {
  const tools = new Map<string, RuntimeTool>();
  const providers = new Map<string, DynamicToolProvider<string>>();
  for (const contribution of options.installed.contributions) {
    if (contribution.kind !== "tool") {
      continue;
    }
    if (isToolRuntimeDefinition(contribution.value)) {
      const definition = contribution.value;
      if (tools.has(definition.name)) {
        throw new RuntimeInvariantError(`Tool '${definition.name}' conflicts with another Tool`);
      }
      tools.set(definition.name, { type: "static", definition });
      continue;
    }
    // SAFETY: Tool contributions that are not static definitions are installed Dynamic Tool Providers.
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
          transcript: options.transcript,
          run: options.run,
          signal: options.signal,
        }),
      )
      .then((definitions) => {
        const providerTools = new Map<string, RuntimeTool>();
        for (const definition of definitions) {
          const name = definition.name;
          if (providerTools.has(name)) {
            throw new RuntimeInvariantError(`Dynamic Tool '${name}' conflicts with another Tool`);
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

  const prepare = async (
    pendingCalls: readonly StoredToolCall[],
  ): Promise<ReadonlyMap<string, RuntimeTool>> => {
    const pendingProviderIds = new Set<string>();
    for (const call of pendingCalls) {
      if (call.providerId !== undefined) {
        pendingProviderIds.add(call.providerId);
      }
    }
    const selectedProviderIds = [...providers.keys()].filter(
      (providerId) => pendingCalls.length === 0 || pendingProviderIds.has(providerId),
    );
    const providerToolSets = await Promise.all(selectedProviderIds.map(resolveDynamicProvider));
    for (const providerTools of providerToolSets) {
      for (const [name, tool] of providerTools) {
        if (tools.has(name)) {
          throw new RuntimeInvariantError(`Dynamic Tool '${name}' conflicts with another Tool`);
        }
        tools.set(name, tool);
      }
    }
    return tools;
  };

  return Object.freeze({ tools, resolveDynamicProvider, prepare });
}

/** Execute one Thread Store call with Runtime error translation. */
export interface ToolStoreCall {
  <Value>(operation: string, evaluate: () => PromiseLike<Value>): Promise<Value>;
}

/** Validate and submit one Tool resume command. */
export async function submitToolResumes(options: {
  readonly installed: InstalledAgentData;
  readonly input: ResumeRunInput;
  readonly threadStore: ThreadStore;
  readonly storeCall: ToolStoreCall;
}): Promise<ResumeRunResult> {
  const conflict = (toolCallIds: readonly ToolCallId[]): ResumeRunResult => ({
    type: "tool-resume-conflict",
    runId: options.input.runId,
    toolCallIds,
  });
  const context = await options.storeCall("readToolResumeContext", () =>
    options.threadStore.readToolResumeContext({
      runId: options.input.runId,
      agent: options.installed.reference,
    }),
  );
  if (context === undefined) {
    return conflict(options.input.items.map((item) => item.toolCallId));
  }
  const run: RunIdentity = Object.freeze({
    runId: context.run.id,
    threadId: context.run.threadId,
    branchId: context.run.branchId,
    agent: options.installed.reference,
  });
  const catalog = createToolCatalog({
    installed: options.installed,
    transcript: context.transcript,
    run,
    signal: new AbortController().signal,
  });
  const submittedItems: Array<{
    toolCallId: ToolCallId;
    toolName: string;
    input: JsonValue;
  }> = [];
  for (const item of options.input.items) {
    const call = context.toolCalls.find(
      (candidate) =>
        candidate.toolCallId === item.toolCallId && candidate.toolName === item.toolName,
    );
    if (
      call === undefined ||
      (call.providerId === undefined
        ? item.dynamic === true || item.providerId !== undefined
        : item.dynamic !== true || item.providerId !== call.providerId)
    ) {
      return conflict([item.toolCallId]);
    }
    let definition: RuntimeTool["definition"] | undefined;
    if (call.providerId === undefined) {
      const tool = catalog.tools.get(item.toolName);
      if (tool?.type === "static") {
        definition = tool.definition;
      }
    } else {
      const tool = (await catalog.resolveDynamicProvider(call.providerId)).get(item.toolName);
      if (tool?.type === "dynamic") {
        definition = tool.definition;
      }
    }
    if (definition?.suspension === undefined) {
      return conflict([item.toolCallId]);
    }
    const submitted = requireJson(item.input, `Resume input for Tool '${item.toolName}'`);
    await validateSchema(definition.suspension.resumeInput, submitted);
    submittedItems.push({
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      input: submitted,
    });
  }
  return options.storeCall("submitToolResumes", () =>
    options.threadStore.submitToolResumes({
      runId: options.input.runId,
      agent: options.installed.reference,
      expectedHead: context.head,
      items: submittedItems,
      ...(options.input.toolResumeRequestId === undefined
        ? {}
        : { toolResumeRequestId: options.input.toolResumeRequestId }),
    }),
  );
}

/** Create Tool execution for one claimed Execution. */
export function createToolRuntime(options: {
  readonly runId: RunId;
  readonly installed: InstalledAgentData;
  readonly executionSignal: AbortSignal;
  readonly hooks: HookRuntime;
  readonly events: ExecutionEvents;
  readonly store: ToolStore;
  readonly getPreparedState: (prepared: PreparedToolWork) => PreparedState | undefined;
  readonly setPhase: () => void;
  readonly assertActive: () => void;
  readonly newToolCallId: () => ToolCallId;
  readonly newToolAttemptId: () => ToolAttemptId;
  readonly newMessageEntryId: () => MessageEntryId;
}): ToolRuntime {
  const products = new WeakMap<object, PreparedToolWork>();
  const preparedCalls = new WeakMap<object, PreparedToolWork>();
  const preparedCommits = new WeakMap<object, Promise<void>>();

  const preparedToolState = (prepared: PreparedToolWork): PreparedToolState => {
    const state = options.getPreparedState(prepared);
    if (state === undefined || !isPreparedToolState(state)) {
      throw new RuntimeInvariantError("Tool Work belongs to another Execution");
    }
    return state;
  };

  const interruptStaleAgent = async (
    call: StoredToolCall,
    snapshot: ExecutionSnapshot,
    detail: string,
  ): Promise<never> => {
    const interruption: InterruptedExecutionResult = {
      type: "interrupted",
      runId: options.runId,
      interruption: {
        type: "stale-agent",
        expected: call.suspension?.agent ?? snapshot.run.agent,
        installed: options.installed.reference,
        toolName: call.toolName,
        detail,
      },
    };
    await options.store.recordInterruption(interruption.interruption);
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
    // SAFETY: The object check above establishes a string-keyed object.
    const object = value as Record<string, unknown>;
    const content =
      object.content === undefined
        ? Object.freeze([])
        : parseContentParts(object.content, toolName);
    if (object.type === "success") {
      if (
        !("output" in object) ||
        Object.keys(object).some((key) => key !== "type" && key !== "output" && key !== "content")
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
        Object.keys(object).some((key) => key !== "type" && key !== "failure" && key !== "content")
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

  const transformCompletedToolResult = (
    call: StoredToolCall,
    tool: RuntimeTool,
    result: CompletedToolCallResult,
  ): Promise<CompletedToolCallResult> =>
    options.hooks.transformCompletedToolResult(
      call,
      result,
      (value) => validateCompletedToolResult(tool, call.toolName, value),
      options.executionSignal,
    );

  const attemptToolCall = async (
    prepared: PreparedToolWork,
    originalCall: StoredToolCall,
    activeTargets: readonly string[],
  ): Promise<ToolAttemptOutcome> => {
    const state = preparedToolState(prepared);
    options.setPhase();
    options.assertActive();
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
    const identity = eventIdentity(tool, call);
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

    let input: unknown;
    if (call.effectiveInput === undefined) {
      const effective = requireJson(
        await options.hooks.transformToolInput(call, options.executionSignal),
        `Effective input for Tool '${call.toolName}'`,
      );
      input = await validateToolInput(call, effective);
      call = await options.store.recordToolInput(toolCallId, effective);
    } else {
      input = await validateToolInput(call, call.effectiveInput);
    }

    const invokeChild = async (
      targetValue: ToolDefinition | DynamicToolProviderFragment,
      childInput: unknown,
      key: string,
      dynamicToolName?: string,
    ): Promise<ToolInvocationResult<unknown, unknown>> => {
      const childId = options.newToolCallId();
      let childTool: RuntimeTool;
      let childName: string;
      let providerId: string | undefined;
      let encodedInput: JsonValue;

      if (dynamicToolName === undefined) {
        // SAFETY: Static delegation passes ToolDefinition values without a dynamic Tool name.
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
        // SAFETY: Dynamic delegation passes Dynamic Tool Provider fragments with a Tool name.
        const provider = runtimeDynamicToolProvider(targetValue as DynamicToolProviderFragment);
        const contribution = options.installed.contributions.find(
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
      const child = await options.store.recordDelegatedToolCall({
        parentToolCallId: toolCallId,
        toolCallId: childId,
        toolName: childName,
        ...(providerId === undefined ? {} : { providerId }),
        key,
        input: encodedInput,
      });
      const outcome = await attemptToolCall(prepared, child, path);
      if (outcome.type === "suspended") {
        throw new ChildSuspended();
      }
      return outcome.result;
    };

    const context = Object.freeze({
      runId: options.runId,
      toolCallId: call.toolCallId,
      toolAttemptId: options.newToolAttemptId(),
      idempotencyKey: `${options.runId}:${call.toolCallId}`,
      signal: options.executionSignal,
      emit: async (event: unknown) => {
        let value = event;
        const eventSchema = tool.definition.event;
        if (eventSchema === undefined) {
          throw new RuntimeInvariantError(`Tool '${toolName}' emitted an undeclared Event`);
        }
        value = await validateSchema(eventSchema, event);
        await options.events.emit(
          Object.freeze({
            ...identity,
            type: "tool-event",
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
          return invokeChild(targetValue, childInput.input, invokeOptions.key, childInput.toolName);
        }
        return invokeChild(targetValue, childInput, invokeOptions.key);
      },
    });

    await options.events.emit(
      Object.freeze({
        ...identity,
        type: "tool-started",
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
          call.suspension.agent.revision !== options.installed.reference.revision
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
          resumeInput = await validateSchema(suspension.resumeInput, call.suspension.resumeInput);
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
        const stored = await options.store.completeToolCall(toolCallId, result);
        await options.events.emit(finishedToolEvent(tool, stored));
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
        await options.store.suspendToolCall(toolCallId, continuation, options.installed.reference);
        await options.events.emit(
          Object.freeze({
            ...identity,
            type: "tool-suspended",
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
      const stored = await options.store.completeToolCall(toolCallId, result);
      await options.events.emit(finishedToolEvent(tool, stored));
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
    let commit = preparedCommits.get(state.prepared);
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
            id: options.newMessageEntryId(),
            toolCallId: call.toolCallId,
            message: {
              role: "tool" as const,
              content: [
                {
                  type: "tool-result" as const,
                  toolName: call.toolName,
                  toolCallId: call.toolCallId,
                  output: result.type === "success" ? result.output : result.failure.value,
                  ...(result.type === "failure" ? { isFailure: true as const } : {}),
                  ...(call.providerData === undefined ? {} : { providerData: call.providerData }),
                },
                ...(result.content ?? []),
              ],
            },
          };
        });
        await options.store.commitToolResults(state.snapshot.head, entries);
      })();
      preparedCommits.set(state.prepared, commit);
    }
    await commit;
  };

  const execute = async (
    prepared: PreparedToolWork,
    requested: PreparedToolCall,
  ): Promise<ToolExecution> => {
    if (preparedCalls.get(requested) !== prepared) {
      throw new RuntimeInvariantError("Tool Call belongs to another Prepared Work value");
    }
    const state = preparedToolState(prepared);
    const call = await options.store.loadToolCall(requested.toolCallId);
    if (call === undefined) {
      throw new ExecutionClaimLostError(options.runId);
    }
    if (call.toolName !== requested.toolName) {
      throw new RuntimeInvariantError(
        `Tool Call '${requested.toolCallId}' was not committed by this Runtime`,
      );
    }
    const outcome = await attemptToolCall(prepared, call, []);
    const result: ToolExecution["result"] =
      outcome.type === "success" ? outcome.result : { type: "suspended" };
    // SAFETY: Runtime creates this opaque Tool Execution product and tracks its owner below.
    const product = Object.freeze({
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      result,
    }) as ToolExecution;
    products.set(product, prepared);
    if (outcome.type === "success") {
      state.outcomes.set(call.toolCallId, outcome.stored);
      await commitPreparedToolResults(state);
    }
    return product;
  };

  return Object.freeze({
    registerPrepared: (prepared: PreparedToolWork): void => {
      for (const call of prepared.calls) {
        preparedCalls.set(call, prepared);
      }
    },
    execute,
    ownsProduct: (prepared: PreparedToolWork, product: object): boolean =>
      products.get(product) === prepared,
  });
}
