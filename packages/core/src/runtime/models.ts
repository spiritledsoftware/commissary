import type {
  ModelCapability,
  ModelEvent,
  ModelRequest,
  ModelSession,
  ModelUsage,
  ToolCallContentPart,
} from "../protocol.js";
import type {
  CompositeModelContext,
  ModelDefinition,
  NestedModelResult,
  RuntimeModel,
} from "../render.js";
import type { Clock, ModelInvocation, PreparedModelWork } from "../runtime.js";
import type { ArtifactStore, StoredModelToolCallInput } from "../store.js";
import { stableJson, type MessageEntryId, type ToolCallId } from "../types.js";
import type { ExecutionEvents } from "./execution-events.js";
import {
  ContinueLoop,
  RedirectModelInvocation,
  RuntimeInvariantError,
} from "./execution-signals.js";
import { isPreparedModelState, type PreparedState } from "./execution-state.js";
import type { HookRuntime } from "./hooks.js";
import { parseModelUsage, requireJson } from "./protocol-parsing.js";

/** One Model Call persistence operation. */
export interface RecordModelCall {
  readonly modelId: string;
  readonly usage?: ModelUsage;
}

/** One root Model result that must become durable before Tool execution. */
export interface CommitModelInvocation {
  readonly expectedHead: MessageEntryId;
  readonly entry: {
    readonly id: MessageEntryId;
    readonly message: import("../protocol.js").ModelMessage;
  };
  readonly toolCalls: readonly StoredModelToolCallInput[];
}

/** Internal Model operations for one Execution. */
export interface ModelRuntime {
  readonly invoke: (prepared: PreparedModelWork) => Promise<ModelInvocation>;
  readonly ownsProduct: (prepared: PreparedModelWork, product: object) => boolean;
  readonly closeSessions: () => Promise<void>;
}

function terminalInvocation(event: ModelEvent): ModelInvocation | undefined {
  switch (event.type) {
    case "finish":
      // SAFETY: Runtime creates this opaque Model invocation from a validated terminal Event.
      return Object.freeze({
        type: "response",
        response: event.response,
        toolCalls: event.response.message.content.filter(
          (part): part is ToolCallContentPart => part.type === "tool-call",
        ),
      }) as unknown as ModelInvocation;
    case "failure":
      // SAFETY: Runtime creates this opaque Model invocation from a validated terminal Event.
      return Object.freeze({
        type: "failure",
        failure: event.failure,
      }) as ModelInvocation;
    case "interruption":
      // SAFETY: Runtime creates this opaque Model invocation from a validated terminal Event.
      return Object.freeze({
        type: "interruption",
        interruption: event.interruption,
      }) as ModelInvocation;
    default:
      return undefined;
  }
}

function invocationUsage(invocation: ModelInvocation): ModelUsage | undefined {
  if (invocation.type === "response") {
    return invocation.response.usage;
  }
  return invocation.type === "interruption" && "usage" in invocation.interruption
    ? invocation.interruption.usage
    : undefined;
}

/** Create Model execution for one claimed Execution. */
export function createModelRuntime(options: {
  readonly executionSignal: AbortSignal;
  readonly artifactStore?: ArtifactStore;
  readonly environment?: unknown;
  readonly clock: Clock;
  readonly hooks: HookRuntime;
  readonly events: ExecutionEvents;
  readonly getPreparedState: (prepared: PreparedModelWork) => PreparedState | undefined;
  readonly setPhase: () => void;
  readonly assertActive: () => void;
  readonly setActiveModel: (controller: AbortController | undefined) => void;
  readonly newMessageEntryId: () => MessageEntryId;
  readonly recordModelCall: (call: RecordModelCall) => Promise<void>;
  readonly commitModelInvocation: (
    invocation: CommitModelInvocation,
  ) => Promise<"committed" | "work-ready">;
}): ModelRuntime {
  const products = new WeakMap<object, PreparedModelWork>();
  const sessions = new Map<ModelCapability<string, unknown>, Promise<ModelSession>>();
  const acquiredSessions: ModelSession[] = [];
  let sessionsClosed = false;

  const assertModelActive = (signal: AbortSignal): void => {
    options.assertActive();
    if (signal.aborted) {
      throw signal.reason;
    }
  };

  const acquireSession = (model: ModelCapability<string, unknown>): Promise<ModelSession> => {
    if (model.acquire === undefined) {
      return Promise.resolve(model);
    }
    const current = sessions.get(model);
    if (current !== undefined) {
      return current;
    }
    const acquired = Promise.resolve(
      model.acquire({
        signal: options.executionSignal,
        ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      }),
    ).then((session) => {
      acquiredSessions.push(session);
      return session;
    });
    sessions.set(model, acquired);
    return acquired;
  };

  const nestedResult = async (events: AsyncIterable<ModelEvent>): Promise<NestedModelResult> => {
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
      const session = await acquireSession(model);
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
          await options.recordModelCall({
            modelId: model.id,
            ...(usage === undefined ? {} : { usage }),
          });
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
    const signature = (child: RuntimeModel, childRequest: ModelRequest, key: string): string => {
      if (key.length === 0) {
        throw new RuntimeInvariantError(`Composite Model '${model.id}' used an empty child key`);
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
        const result = invokeRuntimeModel(runtime, childRequest, path, signal).then(nestedResult);
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

  const invoke = async (prepared: PreparedModelWork): Promise<ModelInvocation> => {
    const state = options.getPreparedState(prepared);
    if (state === undefined || !isPreparedModelState(state)) {
      throw new RuntimeInvariantError("Model Work belongs to another Execution");
    }
    options.setPhase();
    options.assertActive();
    const modelController = new AbortController();
    const abortModel = (): void => {
      modelController.abort(options.executionSignal.reason);
    };
    options.executionSignal.addEventListener("abort", abortModel, { once: true });
    options.setActiveModel(modelController);
    const runModel = async (): Promise<ModelInvocation> => {
      while (true) {
        assertModelActive(modelController.signal);
        const request = await options.hooks.transformModelRequest(
          state.request,
          modelController.signal,
        );
        const advertisedTools = new Set(request.tools.map((tool) => tool.name));
        const events = await invokeRuntimeModel(state.model, request, [], modelController.signal);
        let invocation: ModelInvocation | undefined;
        for await (const sourceEvent of events) {
          assertModelActive(modelController.signal);
          const event = await options.hooks.transformModelEvent(
            sourceEvent,
            modelController.signal,
          );
          if (event === undefined) {
            continue;
          }
          if (invocation !== undefined) {
            throw new RuntimeInvariantError("Model emitted an Event after its terminal Event");
          }
          const terminal = terminalInvocation(event);
          if (terminal === undefined) {
            await options.events.emit(Object.freeze({ type: "model-event", event }));
            continue;
          }
          invocation = terminal;
        }
        if (invocation === undefined) {
          throw new RuntimeInvariantError("Model stream ended without a terminal Event");
        }

        const decision = await options.hooks.afterModelInvocation(
          invocation,
          modelController.signal,
        );
        if (decision.type === "retry") {
          if (decision.delayMs !== undefined) {
            await options.clock.sleep(decision.delayMs, modelController.signal);
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
              throw new RuntimeInvariantError(`Model requested unknown Tool '${call.toolName}'`);
            }
            if (!advertisedTools.has(call.toolName)) {
              throw new RuntimeInvariantError(`Model requested hidden Tool '${call.toolName}'`);
            }
          }
        }

        const terminalEvent = eventForNestedResult(invocation);
        await options.events.emit(
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
            const committed = await options.commitModelInvocation({
              expectedHead: state.snapshot.head,
              entry: {
                id: options.newMessageEntryId(),
                message: invocation.response.message,
              },
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
                  ...(call.providerData === undefined ? {} : { providerData: call.providerData }),
                };
              }),
            });
            if (committed === "work-ready") {
              throw new ContinueLoop();
            }
          }
        }
        products.set(invocation, prepared);
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
      options.executionSignal.removeEventListener("abort", abortModel);
      options.setActiveModel(undefined);
    }
  };

  const closeSessions = async (): Promise<void> => {
    if (sessionsClosed) {
      return;
    }
    sessionsClosed = true;
    let failure: unknown;
    let failed = false;
    for (let index = acquiredSessions.length - 1; index >= 0; index -= 1) {
      try {
        const session = acquiredSessions[index];
        if (session === undefined) {
          throw new RuntimeInvariantError("Acquired Model Session is missing during cleanup");
        }
        await session.close?.();
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

  return Object.freeze({
    invoke,
    ownsProduct: (prepared: PreparedModelWork, product: object): boolean =>
      products.get(product) === prepared,
    closeSessions,
  });
}
