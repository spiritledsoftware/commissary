import type { ArtifactStore } from "./store.js";
import type { ArtifactId, JsonValue, MaybePromise, ToolCallId } from "./types.js";
import { stableJson } from "./types.js";

export interface ArtifactReference {
  readonly id: ArtifactId;
  readonly mediaType?: string;
  readonly name?: string;
}

export interface EncodedProviderData<
  Namespace extends string = string,
  Version extends number = number,
  Value extends JsonValue = JsonValue,
> {
  readonly namespace: Namespace;
  readonly version: Version;
  readonly value: Value;
}

interface ContentPartBase {
  readonly providerData?: readonly EncodedProviderData[];
}

export interface TextContentPart extends ContentPartBase {
  readonly type: "text";
  readonly text: string;
}

export interface FileContentPart extends ContentPartBase {
  readonly type: "file";
  readonly artifact: ArtifactReference;
}

export interface ToolCallContentPart extends ContentPartBase {
  readonly type: "tool-call";
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly input: JsonValue;
  readonly providerExecuted?: boolean;
}

export interface ToolResultContentPart extends ContentPartBase {
  readonly type: "tool-result";
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly output: JsonValue;
  readonly isFailure?: boolean;
  readonly providerExecuted?: boolean;
}

export interface ReasoningContentPart extends ContentPartBase {
  readonly type: "reasoning";
  readonly text: string;
}

export interface UrlSourceContentPart extends ContentPartBase {
  readonly type: "source";
  readonly sourceType: "url";
  readonly id: string;
  readonly url: string;
  readonly title: string;
}

export interface DocumentSourceContentPart extends ContentPartBase {
  readonly type: "source";
  readonly sourceType: "document";
  readonly id: string;
  readonly mediaType: string;
  readonly title: string;
  readonly fileName?: string;
}

export type SourceContentPart = UrlSourceContentPart | DocumentSourceContentPart;

export type ContentPart =
  | TextContentPart
  | ReasoningContentPart
  | SourceContentPart
  | FileContentPart
  | ToolCallContentPart
  | ToolResultContentPart;

export interface EncodedMessageData<
  Key extends string = string,
  Version extends number = number,
  Value extends JsonValue = JsonValue,
> {
  readonly key: Key;
  readonly version: Version;
  readonly value: Value;
}

export type ModelRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessage {
  readonly role: ModelRole;
  readonly content: readonly ContentPart[];
  readonly data?: readonly EncodedMessageData[];
}

export type Transcript = readonly ModelMessage[];

export interface ContextNode {
  readonly id: string;
  readonly content: readonly ContentPart[];
}

export type ContextTree = readonly ContextNode[];

export interface ProviderOption<
  Namespace extends string = string,
  Value extends JsonValue = JsonValue,
> {
  readonly namespace: Namespace;
  readonly value: Value;
}

export type ToolExecutionOwner = "commissary" | "provider" | "provider-callback";

export interface ProviderToolDescriptor<
  Namespace extends string = string,
  Id extends `${string}.${string}` = `${string}.${string}`,
  Args extends JsonValue = JsonValue,
> {
  readonly namespace: Namespace;
  readonly id: Id;
  readonly args: Args;
}

export interface ModelTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonValue;
  readonly execution?: ToolExecutionOwner;
  readonly provider?: ProviderToolDescriptor;
}

export interface ModelRequest {
  readonly context: ContextTree;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelTool[];
  readonly providerOptions: readonly ProviderOption[];
}

export type ModelFinishReason =
  | "stop"
  | "tool-calls"
  | "length"
  | "content-filter"
  | "error"
  | "pause"
  | "other";

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface AuthenticationRequiredInterruption {
  readonly type: "authentication-required";
  readonly provider: string;
  readonly detail?: string;
}

export interface ProviderCompatibilityInterruption {
  readonly type: "provider-compatibility";
  readonly provider: string;
  readonly detail: string;
  readonly capability?: string;
  readonly providerDataNamespace?: string;
  readonly providerDataVersion?: number;
}

export interface ProviderUnavailableInterruption {
  readonly type: "provider-unavailable";
  readonly provider: string;
  readonly reason: "rate-limit" | "transport" | "internal-provider" | "quota-exhausted";
  readonly retryAfterMs?: number;
  readonly resetAt?: string;
  readonly detail?: string;
}

export interface ModelOutputInterruption {
  readonly type: "model-output";
  readonly provider: string;
  readonly detail: string;
  readonly usage?: ModelUsage;
}

export interface ArtifactStorageRequiredInterruption {
  readonly type: "artifact-storage-required";
  readonly operation: "read" | "write";
  readonly detail?: string;
  readonly usage?: ModelUsage;
}

export type ModelInterruption =
  | AuthenticationRequiredInterruption
  | ProviderCompatibilityInterruption
  | ProviderUnavailableInterruption
  | ModelOutputInterruption
  | ArtifactStorageRequiredInterruption;

export interface ModelFailure {
  readonly type: "model-failure";
  readonly reason: "content-policy" | "invalid-request";
  readonly provider: string;
  readonly message: string;
  readonly details?: JsonValue;
}

export interface ModelResponse {
  readonly message: ModelMessage;
  readonly finishReason: ModelFinishReason;
  readonly usage?: ModelUsage;
}

export type ModelEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "reasoning-delta"; readonly delta: string }
  | { readonly type: "tool-call"; readonly call: ToolCallContentPart }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "finish"; readonly response: ModelResponse }
  | { readonly type: "failure"; readonly failure: ModelFailure }
  | { readonly type: "interruption"; readonly interruption: ModelInterruption };

export interface ModelInvocationContext {
  readonly signal: AbortSignal;
}

export interface ModelAcquisitionContext extends ModelInvocationContext {
  readonly artifactStore?: ArtifactStore;
  readonly environment?: unknown;
}

export interface ModelSession {
  readonly invoke: (
    request: ModelRequest,
    context: ModelInvocationContext,
  ) => MaybePromise<AsyncIterable<ModelEvent>>;
  readonly close?: () => MaybePromise<void>;
}

declare const modelRequirements: unique symbol;

export interface ModelCapability<
  Id extends string = string,
  Requirements = never,
> extends ModelSession {
  readonly id: Id;
  readonly acquire?: (context: ModelAcquisitionContext) => MaybePromise<ModelSession>;
  readonly [modelRequirements]?: Requirements;
}

export const Content = {
  text(text: string): TextContentPart {
    return Object.freeze({ type: "text", text });
  },
  reasoning(text: string): ReasoningContentPart {
    return Object.freeze({ type: "reasoning", text });
  },
  source(
    source:
      | Omit<UrlSourceContentPart, "type" | "providerData">
      | Omit<DocumentSourceContentPart, "type" | "providerData">,
  ): SourceContentPart {
    return Object.freeze({ type: "source", ...source }) as SourceContentPart;
  },
  file(artifact: ArtifactReference): FileContentPart {
    return Object.freeze({ type: "file", artifact });
  },
  toolCall(toolCallId: ToolCallId, toolName: string, input: JsonValue): ToolCallContentPart {
    return Object.freeze({ type: "tool-call", toolCallId, toolName, input });
  },
  toolResult(
    toolCallId: ToolCallId,
    toolName: string,
    output: JsonValue,
    isFailure = false,
  ): ToolResultContentPart {
    return Object.freeze({
      type: "tool-result",
      toolCallId,
      toolName,
      output,
      ...(isFailure ? { isFailure: true } : {}),
    });
  },
};

export const Message = {
  define<const Message extends ModelMessage>(message: Message): Readonly<Message> {
    return Object.freeze({
      ...message,
      content: Object.freeze([...message.content]),
      ...(message.data === undefined ? {} : { data: Object.freeze([...message.data]) }),
    });
  },
};

export const Transcript = {
  toModelMessages(transcript: Transcript): readonly ModelMessage[] {
    return transcript.map((message) => {
      const renderedData = (message.data ?? []).map<TextContentPart>((item) =>
        Object.freeze({
          type: "text",
          text: stableJson({
            key: item.key,
            version: item.version,
            value: item.value,
          }),
        }),
      );
      return Object.freeze({
        role: message.role,
        content: Object.freeze([...message.content, ...renderedData]),
      });
    });
  },
};

export const ProviderOptions = {
  define<const Namespace extends string>(namespace: Namespace) {
    return Object.freeze({
      make<const Value extends JsonValue>(value: Value): ProviderOption<Namespace, Value> {
        return Object.freeze({ namespace, value });
      },
    });
  },
};
