import {
  Content,
  Model,
  type AgentFragment,
  type ArtifactStore,
  type ContentPart,
  type EncodedProviderData,
  type FragmentMetadata,
  type JsonValue,
  type ModelAcquisitionContext,
  type ModelEvent,
  type ModelFailure,
  type ModelFinishReason,
  type ModelInterruption,
  type ModelMessage,
  type ModelRequest,
  type ModelTool,
  type ModelSession,
  type ModelUsage,
  type ProviderOption,
  type ProviderToolDescriptor,
  type ToolCallContentPart,
  type ToolResultContentPart,
} from "@commissary/core";
import {
  Context as EffectContext,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Scope,
  Stream,
} from "effect";
import {
  AiError,
  LanguageModel,
  Model as EffectModel,
  Prompt,
  Response,
  Tool as EffectTool,
  Toolkit,
} from "effect/unstable/ai";

export class EffectAiBridgeDefect extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EffectAiBridgeDefect";
  }
}

export type EffectAiProviderToolResolver = (
  descriptor: ProviderToolDescriptor,
) => EffectTool.AnyProviderDefined | undefined;

export interface EffectAiModelOptions<Id extends string = string> {
  readonly id?: Id;
  readonly resolveProviderTool?: EffectAiProviderToolResolver;
}

type StreamItem =
  | { readonly type: "part"; readonly part: Response.StreamPart<Record<string, EffectTool.Any>> }
  | { readonly type: "error"; readonly error: unknown };

type ReplayInterruption = Extract<
  ModelInterruption,
  { readonly type: "provider-compatibility" | "artifact-storage-required" }
>;

type PreparedRequest =
  | {
      readonly type: "ready";
      readonly prompt: Prompt.Prompt;
      readonly toolkit?: Toolkit.WithHandler<Record<string, EffectTool.Any>>;
      readonly tools: ReadonlyMap<string, ModelTool>;
    }
  | { readonly type: "interruption"; readonly interruption: ModelInterruption };

interface ResponseState {
  readonly content: ContentPart[];
  readonly text: Map<string, string>;
  readonly reasoning: Map<string, string>;
  readonly metadata: Map<string, EncodedProviderData[]>;
}

function providerOptions(
  options: readonly ProviderOption[],
  provider: string,
): Record<string, JsonValue> {
  const value: Record<string, JsonValue> = {};
  for (const option of options) {
    if (option.namespace === provider) {
      value[option.namespace] = option.value;
    }
  }
  return value;
}

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function partOptions(
  part: ContentPart,
  provider: string,
  requestOptions: Record<string, JsonValue>,
):
  | { readonly type: "options"; readonly value: Record<string, JsonValue> }
  | { readonly type: "interruption"; readonly interruption: ReplayInterruption } {
  const options: Record<string, JsonValue> = { ...requestOptions };
  for (const data of part.providerData ?? []) {
    if (data.namespace !== provider) {
      continue;
    }
    if (data.version !== 1) {
      return {
        type: "interruption",
        interruption: {
          type: "provider-compatibility",
          provider,
          detail: `Unsupported Provider Data version ${data.version} for ${data.namespace}`,
          providerDataNamespace: data.namespace,
          providerDataVersion: data.version,
        },
      };
    }
    const current = options[data.namespace];
    options[data.namespace] =
      current !== undefined && isJsonRecord(current) && isJsonRecord(data.value)
        ? { ...current, ...data.value }
        : data.value;
  }
  return { type: "options", value: options };
}

async function promptPart(
  part: ContentPart,
  provider: string,
  requestOptions: Record<string, JsonValue>,
  artifactStore: ArtifactStore | undefined,
  signal: AbortSignal,
): Promise<Prompt.Part | ReplayInterruption> {
  const resolved = partOptions(part, provider, requestOptions);
  if (resolved.type === "interruption") {
    return resolved.interruption;
  }
  const options = resolved.value;
  switch (part.type) {
    case "text":
      return Prompt.makePart("text", { text: part.text, options });
    case "reasoning":
      return Prompt.makePart("reasoning", { text: part.text, options });
    case "file": {
      if (artifactStore === undefined) {
        return {
          type: "artifact-storage-required",
          operation: "read",
          detail: `Cannot read artifact ${part.artifact.id} without an Artifact Store`,
        };
      }
      const content = await artifactStore.read(part.artifact, { signal });
      return Prompt.makePart("file", {
        data: content.data,
        mediaType: content.mediaType,
        ...(content.name === undefined ? {} : { fileName: content.name }),
        options,
      });
    }
    case "tool-call":
      return Prompt.makePart("tool-call", {
        id: part.toolCallId,
        name: part.toolName,
        params: part.input,
        providerExecuted: part.providerExecuted ?? false,
        options,
      });
    case "tool-result":
      return Prompt.makePart("tool-result", {
        id: part.toolCallId,
        name: part.toolName,
        result: part.output,
        isFailure: part.isFailure ?? false,
        options,
      });
    case "source":
      return {
        type: "provider-compatibility",
        provider,
        detail: `Effect AI cannot replay canonical ${part.sourceType} Source Parts`,
      };
  }
}

async function promptMessage(
  message: ModelMessage,
  provider: string,
  requestOptions: Record<string, JsonValue>,
  artifactStore: ArtifactStore | undefined,
  signal: AbortSignal,
): Promise<Prompt.Message | ReplayInterruption> {
  const content: Prompt.Part[] = [];
  for (const part of message.content) {
    const mapped = await promptPart(part, provider, requestOptions, artifactStore, signal);
    if (mapped.type === "provider-compatibility" || mapped.type === "artifact-storage-required") {
      return mapped;
    }
    content.push(mapped);
  }
  return Prompt.makeMessage(message.role, {
    content,
    options: requestOptions,
  } as never);
}

async function prepareRequest(
  request: ModelRequest,
  provider: string,
  artifactStore: ArtifactStore | undefined,
  signal: AbortSignal,
  resolveProviderTool: EffectAiProviderToolResolver | undefined,
): Promise<PreparedRequest> {
  const options = providerOptions(request.providerOptions, provider);
  const messages: Prompt.Message[] = [];
  for (const node of request.context) {
    const mapped = await promptMessage(
      { role: "system", content: node.content },
      provider,
      options,
      artifactStore,
      signal,
    );
    if ("type" in mapped) {
      return { type: "interruption", interruption: mapped };
    }
    messages.push(mapped);
  }
  for (const message of request.messages) {
    const mapped = await promptMessage(message, provider, options, artifactStore, signal);
    if ("type" in mapped) {
      return { type: "interruption", interruption: mapped };
    }
    messages.push(mapped);
  }

  const definitions: EffectTool.Any[] = [];
  for (const tool of request.tools) {
    const owner = tool.execution ?? "commissary";
    if (owner === "commissary") {
      definitions.push(
        EffectTool.dynamic(tool.name, {
          ...(tool.description === undefined ? {} : { description: tool.description }),
          parameters: tool.inputSchema as never,
        }),
      );
      continue;
    }
    if (tool.provider === undefined || tool.provider.namespace !== provider) {
      return {
        type: "interruption",
        interruption: {
          type: "provider-compatibility",
          provider,
          capability: "provider-tool",
          detail: `Provider Tool '${tool.name}' is not compatible with ${provider}`,
        },
      };
    }
    const resolved = resolveProviderTool?.(tool.provider);
    const needsHandler = owner === "provider-callback";
    if (
      resolved === undefined ||
      resolved.id !== tool.provider.id ||
      resolved.name !== tool.name ||
      resolved.requiresHandler !== needsHandler
    ) {
      return {
        type: "interruption",
        interruption: {
          type: "provider-compatibility",
          provider,
          capability: "provider-tool",
          detail: `Provider Tool '${tool.name}' could not be resolved by ${provider}`,
        },
      };
    }
    definitions.push(resolved);
  }

  const toolkit =
    definitions.length === 0
      ? undefined
      : ({
          tools: Toolkit.make(...definitions).tools,
          handle: () =>
            Effect.die(
              new EffectAiBridgeDefect(
                "Effect AI attempted to resolve a tool despite disableToolCallResolution",
              ),
            ),
        } as Toolkit.WithHandler<Record<string, EffectTool.Any>>);
  return {
    type: "ready",
    prompt: Prompt.fromMessages(messages),
    ...(toolkit === undefined ? {} : { toolkit }),
    tools: new Map(request.tools.map((tool) => [tool.name, tool])),
  };
}

function usage(value: Response.Usage): ModelUsage {
  const inputTokens = value.inputTokens.total;
  const outputTokens = value.outputTokens.total;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined || outputTokens === undefined
      ? {}
      : { totalTokens: inputTokens + outputTokens }),
  };
}

function finishReason(reason: Response.FinishReason): ModelFinishReason {
  return reason === "unknown" ? "other" : reason;
}

function metadata(value: Readonly<Record<string, unknown>>): EncodedProviderData[] {
  const entries: EncodedProviderData[] = [];
  for (const [namespace, item] of Object.entries(value)) {
    entries.push({ namespace, version: 1, value: item as JsonValue });
  }
  return entries;
}

function withMetadata<Part extends ContentPart>(
  part: Part,
  values: readonly EncodedProviderData[],
): Part {
  if (values.length === 0) {
    return part;
  }
  return Object.freeze({ ...part, providerData: Object.freeze([...values]) }) as unknown as Part;
}

function rememberMetadata(
  state: ResponseState,
  id: string,
  value: Readonly<Record<string, unknown>>,
): void {
  const entries = metadata(value);
  if (entries.length === 0) {
    return;
  }
  const current = state.metadata.get(id) ?? [];
  for (const entry of entries) {
    const index = current.findIndex(
      (candidate) => candidate.namespace === entry.namespace && candidate.version === entry.version,
    );
    if (index === -1) {
      current.push(entry);
    } else {
      current[index] = entry;
    }
  }
  state.metadata.set(id, current);
}

function messageFrom(state: ResponseState): ModelMessage {
  return Object.freeze({ role: "assistant", content: Object.freeze([...state.content]) });
}

function formatErrorDetail(error: AiError.AiError): string {
  return error.message;
}

function mapAiError(
  provider: string,
  error: AiError.AiError,
):
  | { readonly type: "failure"; readonly failure: ModelFailure }
  | { readonly type: "interruption"; readonly interruption: ModelInterruption } {
  const reason = error.reason;
  switch (reason._tag) {
    case "AuthenticationError":
      return {
        type: "interruption",
        interruption: {
          type: "authentication-required",
          provider,
          detail: formatErrorDetail(error),
        },
      };
    case "RateLimitError":
      return {
        type: "interruption",
        interruption: {
          type: "provider-unavailable",
          provider,
          reason: "rate-limit",
          ...(reason.retryAfter === undefined
            ? {}
            : { retryAfterMs: Duration.toMillis(reason.retryAfter) }),
          detail: formatErrorDetail(error),
        },
      };
    case "QuotaExhaustedError":
      return {
        type: "interruption",
        interruption: {
          type: "provider-unavailable",
          provider,
          reason: "quota-exhausted",
          ...(reason.resetAt === undefined ? {} : { resetAt: DateTime.formatIso(reason.resetAt) }),
          detail: formatErrorDetail(error),
        },
      };
    case "NetworkError":
      if (reason.reason !== "TransportError") {
        throw new EffectAiBridgeDefect(
          "Effect AI provider could not encode a canonical request",
          error,
        );
      }
      return {
        type: "interruption",
        interruption: {
          type: "provider-unavailable",
          provider,
          reason: "transport",
          detail: formatErrorDetail(error),
        },
      };
    case "InternalProviderError":
      return {
        type: "interruption",
        interruption: {
          type: "provider-unavailable",
          provider,
          reason: "internal-provider",
          detail: formatErrorDetail(error),
        },
      };
    case "ContentPolicyError":
      return {
        type: "failure",
        failure: {
          type: "model-failure",
          reason: "content-policy",
          provider,
          message: reason.description,
        },
      };
    case "InvalidRequestError":
    case "InvalidUserInputError":
      return {
        type: "failure",
        failure: {
          type: "model-failure",
          reason: "invalid-request",
          provider,
          message:
            "description" in reason && reason.description !== undefined
              ? reason.description
              : formatErrorDetail(error),
        },
      };
    case "InvalidOutputError":
    case "StructuredOutputError":
      return {
        type: "interruption",
        interruption: {
          type: "model-output",
          provider,
          detail: reason.description,
          ...("usage" in reason && reason.usage !== undefined
            ? {
                usage: {
                  ...(reason.usage.promptTokens === undefined
                    ? {}
                    : { inputTokens: reason.usage.promptTokens }),
                  ...(reason.usage.completionTokens === undefined
                    ? {}
                    : { outputTokens: reason.usage.completionTokens }),
                  ...(reason.usage.totalTokens === undefined
                    ? {}
                    : { totalTokens: reason.usage.totalTokens }),
                },
              }
            : {}),
        },
      };
    case "UnsupportedSchemaError":
      return {
        type: "interruption",
        interruption: {
          type: "provider-compatibility",
          provider,
          capability: "tool-schema",
          detail: reason.description,
        },
      };
    default:
      throw new EffectAiBridgeDefect(`Unexpected Effect AI error: ${reason._tag}`, error);
  }
}

async function* streamEvents(
  provider: string,
  iterable: AsyncIterable<StreamItem>,
  tools: ReadonlyMap<string, ModelTool>,
  artifactStore: ArtifactStore | undefined,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const state: ResponseState = {
    content: [],
    text: new Map(),
    reasoning: new Map(),
    metadata: new Map(),
  };
  let missingArtifactStore = false;
  let lastUsage: ModelUsage | undefined;

  for await (const item of iterable) {
    if (item.type === "error") {
      if (!AiError.isAiError(item.error)) {
        throw new EffectAiBridgeDefect("Effect AI rejected a canonical response", item.error);
      }
      yield mapAiError(provider, item.error);
      return;
    }
    const part = item.part;
    switch (part.type) {
      case "text-start":
        state.text.set(part.id, "");
        rememberMetadata(state, part.id, part.metadata);
        break;
      case "text-delta":
        state.text.set(part.id, `${state.text.get(part.id) ?? ""}${part.delta}`);
        rememberMetadata(state, part.id, part.metadata);
        yield { type: "text-delta", delta: part.delta };
        break;
      case "text-end":
        rememberMetadata(state, part.id, part.metadata);
        state.content.push(
          withMetadata(
            Content.text(state.text.get(part.id) ?? ""),
            state.metadata.get(part.id) ?? [],
          ),
        );
        state.text.delete(part.id);
        state.metadata.delete(part.id);
        break;
      case "reasoning-start":
        state.reasoning.set(part.id, "");
        rememberMetadata(state, part.id, part.metadata);
        break;
      case "reasoning-delta":
        state.reasoning.set(part.id, `${state.reasoning.get(part.id) ?? ""}${part.delta}`);
        rememberMetadata(state, part.id, part.metadata);
        yield { type: "reasoning-delta", delta: part.delta };
        break;
      case "reasoning-end":
        rememberMetadata(state, part.id, part.metadata);
        state.content.push(
          withMetadata(
            Content.reasoning(state.reasoning.get(part.id) ?? ""),
            state.metadata.get(part.id) ?? [],
          ),
        );
        state.reasoning.delete(part.id);
        state.metadata.delete(part.id);
        break;
      case "tool-call": {
        const tool = tools.get(part.name);
        if (tool === undefined) {
          throw new EffectAiBridgeDefect(`Effect AI emitted unknown Tool '${part.name}'`);
        }
        const providerExecuted = (tool.execution ?? "commissary") === "provider";
        if (part.providerExecuted !== providerExecuted) {
          throw new EffectAiBridgeDefect(
            `Effect AI reported invalid execution ownership for Tool '${part.name}'`,
          );
        }
        const call = withMetadata(
          Object.freeze({
            type: "tool-call",
            toolCallId: part.id,
            toolName: part.name,
            input: part.params as JsonValue,
            ...(providerExecuted ? { providerExecuted: true } : {}),
          }) as unknown as ToolCallContentPart,
          metadata(part.metadata),
        );
        state.content.push(call);
        yield { type: "tool-call", call };
        break;
      }
      case "tool-result": {
        if (part.preliminary) {
          break;
        }
        const tool = tools.get(part.name);
        if (tool === undefined) {
          throw new EffectAiBridgeDefect(`Effect AI emitted unknown Tool '${part.name}'`);
        }
        const providerExecuted = (tool.execution ?? "commissary") === "provider";
        if (part.providerExecuted !== providerExecuted) {
          throw new EffectAiBridgeDefect(
            `Effect AI reported invalid execution ownership for Tool '${part.name}'`,
          );
        }
        state.content.push(
          withMetadata(
            Object.freeze({
              type: "tool-result",
              toolCallId: part.id,
              toolName: part.name,
              output: part.result as JsonValue,
              ...(part.isFailure ? { isFailure: true } : {}),
              ...(providerExecuted ? { providerExecuted: true } : {}),
            }) as unknown as ToolResultContentPart,
            metadata(part.metadata),
          ),
        );
        break;
      }
      case "file":
        if (artifactStore === undefined) {
          missingArtifactStore = true;
          break;
        }
        state.content.push(
          withMetadata(
            Content.file(
              await artifactStore.write({ data: part.data, mediaType: part.mediaType }, { signal }),
            ),
            metadata(part.metadata),
          ),
        );
        break;
      case "source":
        state.content.push(
          withMetadata(
            part.sourceType === "url"
              ? Content.source({
                  sourceType: "url",
                  id: part.id,
                  url: part.url.toString(),
                  title: part.title,
                })
              : Content.source({
                  sourceType: "document",
                  id: part.id,
                  mediaType: part.mediaType,
                  title: part.title,
                  ...(part.fileName === undefined ? {} : { fileName: part.fileName }),
                }),
            metadata(part.metadata),
          ),
        );
        break;
      case "finish": {
        lastUsage = usage(part.usage);
        if (missingArtifactStore) {
          yield {
            type: "interruption",
            interruption: {
              type: "artifact-storage-required",
              operation: "write",
              detail: "Cannot preserve a model-generated file without an Artifact Store",
              usage: lastUsage,
            },
          };
          return;
        }
        yield {
          type: "finish",
          response: {
            message: messageFrom(state),
            finishReason: finishReason(part.reason),
            usage: lastUsage,
          },
        };
        return;
      }
      case "error":
        if (AiError.isAiError(part.error)) {
          yield mapAiError(provider, part.error);
          return;
        }
        throw new EffectAiBridgeDefect("Effect AI emitted an unknown stream error", part.error);
      case "response-metadata":
      case "tool-params-start":
      case "tool-params-delta":
      case "tool-params-end":
        break;
      case "tool-approval-request":
        yield {
          type: "interruption",
          interruption: {
            type: "provider-compatibility",
            provider,
            detail: "Effect AI Tool approval requests are not supported by Commissary",
          },
        };
        return;
    }
  }
}

function waitForAbort(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => {
      resume(Effect.void);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function makeSession<Requirements>(
  effectModel: EffectModel.Model<string, LanguageModel.LanguageModel, Requirements>,
  provider: string,
  acquisition: ModelAcquisitionContext,
  resolveProviderTool: EffectAiProviderToolResolver | undefined,
): Promise<ModelSession> {
  const environment = (acquisition.environment ??
    EffectContext.empty()) as EffectContext.Context<Requirements>;
  return Effect.runPromiseWith(environment)(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const built = yield* Layer.buildWithScope(effectModel, scope).pipe(
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit))),
      );
      const service = EffectContext.get(built, LanguageModel.LanguageModel);
      return {
        invoke: async (request: ModelRequest, invocation: { readonly signal: AbortSignal }) => {
          const prepared = await prepareRequest(
            request,
            provider,
            acquisition.artifactStore,
            invocation.signal,
            resolveProviderTool,
          );
          if (prepared.type === "interruption") {
            return (async function* () {
              yield { type: "interruption", interruption: prepared.interruption } as const;
            })();
          }
          const source = (
            prepared.toolkit === undefined
              ? service.streamText({
                  prompt: prepared.prompt,
                  disableToolCallResolution: true,
                })
              : service.streamText({
                  prompt: prepared.prompt,
                  toolkit: prepared.toolkit,
                  disableToolCallResolution: true,
                })
          ) as Stream.Stream<Response.StreamPart<Record<string, EffectTool.Any>>, unknown, never>;
          const safe = source.pipe(
            Stream.interruptWhen(waitForAbort(invocation.signal)),
            Stream.map((part) => ({ type: "part", part }) as StreamItem),
            Stream.catch((error) => Stream.make({ type: "error", error } as StreamItem)),
          );
          const iterable = Stream.toAsyncIterableWith(safe, built);
          return streamEvents(
            provider,
            iterable,
            prepared.tools,
            acquisition.artifactStore,
            invocation.signal,
          );
        },
        close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
      } satisfies ModelSession;
    }),
    { signal: acquisition.signal },
  );
}

export const EffectAi = {
  model<
    const Provider extends string,
    Provides extends LanguageModel.LanguageModel,
    Requirements,
    const Id extends string = `effect-ai:${Provider}`,
  >(
    effectModel: EffectModel.Model<Provider, Provides, Requirements>,
    options?: EffectAiModelOptions<Id>,
  ): AgentFragment<FragmentMetadata<never, never, never, Requirements>> {
    const id = options?.id ?? (`effect-ai:${effectModel.provider}` as Id);
    const capability = {
      id,
      acquire: (context: ModelAcquisitionContext) =>
        makeSession(
          effectModel as unknown as EffectModel.Model<
            string,
            LanguageModel.LanguageModel,
            Requirements
          >,
          effectModel.provider,
          context,
          options?.resolveProviderTool,
        ),
      invoke: async (request: ModelRequest, context: { readonly signal: AbortSignal }) => {
        const session = await makeSession(
          effectModel as unknown as EffectModel.Model<
            string,
            LanguageModel.LanguageModel,
            Requirements
          >,
          effectModel.provider,
          { signal: context.signal },
          options?.resolveProviderTool,
        );
        const stream = await session.invoke(request, context);
        return (async function* () {
          try {
            yield* stream;
          } finally {
            await session.close?.();
          }
        })();
      },
    };
    return Model.define<Id, Requirements>(capability);
  },
};
