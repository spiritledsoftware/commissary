import type { Codec } from "./codec.js";
import { createFragment, type AgentFragment, type FragmentMetadata } from "./fragment.js";
import type { RunIdentity } from "./identity.js";
import type {
  ModelTool,
  ProviderToolDescriptor,
  ToolExecutionOwner,
  Transcript,
} from "./protocol.js";
import type { ModelSchema, SchemaOutput, StandardSchema } from "./schema.js";
import { schemaJson } from "./schema.js";
import type { JsonValue, MaybePromise, RunId, ToolAttemptId, ToolCallId } from "./types.js";

const toolType: unique symbol = Symbol("commissary.tool.type");
const failureType: unique symbol = Symbol("commissary.tool.failure");
const suspensionType: unique symbol = Symbol("commissary.tool.suspension");

export interface ToolFailure<Value> {
  readonly type: "failure";
  readonly [failureType]: Value;
}

export interface ToolSuspension<Continuation> {
  readonly type: "suspension";
  readonly [suspensionType]: Continuation;
}

const failureValues = new WeakMap<object, unknown>();
const suspensionValues = new WeakMap<object, unknown>();

export interface ToolExecutionContext<Signal = never> {
  readonly runId: RunId;
  readonly toolCallId: ToolCallId;
  readonly toolAttemptId: ToolAttemptId;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  readonly emit: (signal: Signal) => Promise<void>;
}

export interface ToolResumeRequest<Name extends string, Input> {
  readonly toolName: Name;
  readonly input: Input;
}

export interface ToolSuspensionDefinition<ResumeInput, Continuation, Output, Failure, Signal> {
  readonly resumeInput: Codec<ResumeInput>;
  readonly continuation: Codec<Continuation>;
  readonly resume: (
    value: { readonly input: ResumeInput; readonly continuation: Continuation },
    context: ToolExecutionContext<Signal>,
  ) => MaybePromise<Output | ToolFailure<Failure> | ToolSuspension<Continuation>>;
}

export interface ToolDefinition<
  Name extends string,
  Input,
  Output,
  Failure,
  Signal,
  ResumeInput,
  Continuation,
> extends AgentFragment<
  FragmentMetadata<
    ToolDefinition<Name, Input, Output, Failure, Signal, ResumeInput, Continuation>,
    Signal,
    [ResumeInput] extends [never] ? never : ToolResumeRequest<Name, ResumeInput>
  >
> {
  readonly [toolType]: {
    readonly name: Name;
    readonly input: Input;
    readonly output: Output;
    readonly failure: Failure;
    readonly signal: Signal;
    readonly resumeInput: ResumeInput;
    readonly continuation: Continuation;
  };
}

export interface DynamicTool {
  readonly type: "dynamic-tool";
  readonly definition: ModelTool;
  readonly execute: (
    input: unknown,
    context: ToolExecutionContext<unknown>,
  ) => MaybePromise<unknown>;
}

export interface ToolRuntimeDefinition {
  readonly name: string;
  readonly execution: ToolExecutionOwner;
  readonly modelTool: ModelTool;
  readonly input: StandardSchema;
  readonly output: StandardSchema;
  readonly failure?: StandardSchema;
  readonly signal?: StandardSchema;
  readonly handler?: (
    input: unknown,
    context: ToolExecutionContext<unknown>,
  ) => MaybePromise<unknown>;
  readonly suspension?: ToolSuspensionDefinition<unknown, unknown, unknown, unknown, unknown>;
}

export interface DynamicToolProviderInput {
  readonly transcript: Transcript;
  readonly run: RunIdentity;
  readonly signal: AbortSignal;
}

export interface DynamicToolProvider<Id extends string> {
  readonly id: Id;
  readonly resolve: (input: DynamicToolProviderInput) => MaybePromise<readonly DynamicTool[]>;
}

type ToolInput<Definition> = Definition extends {
  readonly [toolType]: { readonly input: infer Input };
}
  ? Input
  : never;

type ToolOutput<Definition> = Definition extends {
  readonly [toolType]: { readonly output: infer Output };
}
  ? Output
  : never;

type ToolFailureValue<Definition> = Definition extends {
  readonly [toolType]: { readonly failure: infer Failure };
}
  ? Failure
  : never;

type ToolResumeInput<Definition> = Definition extends {
  readonly [toolType]: { readonly resumeInput: infer ResumeInput };
}
  ? ResumeInput
  : never;

type ToolSuspensionOutcome<Definition> = Definition extends {
  readonly [toolType]: {
    readonly name: infer Name extends string;
    readonly resumeInput: infer ResumeInput;
  };
}
  ? [ResumeInput] extends [never]
    ? never
    : {
        readonly toolName: Name;
        readonly toolCallId: ToolCallId;
      }
  : never;

type DefinitionFor<
  Name extends string,
  InputSchema extends ModelSchema,
  OutputSchema extends StandardSchema,
  FailureSchema extends StandardSchema | undefined,
  SignalSchema extends StandardSchema | undefined,
  ResumeInput,
  Continuation,
> = ToolDefinition<
  Name,
  SchemaOutput<InputSchema>,
  SchemaOutput<OutputSchema>,
  FailureSchema extends StandardSchema ? SchemaOutput<FailureSchema> : never,
  SignalSchema extends StandardSchema ? SchemaOutput<SignalSchema> : never,
  ResumeInput,
  Continuation
>;

export const Tool = {
  define<
    const Name extends string,
    const InputSchema extends ModelSchema,
    const OutputSchema extends StandardSchema,
    const FailureSchema extends StandardSchema | undefined = undefined,
    const SignalSchema extends StandardSchema | undefined = undefined,
    ResumeInput = never,
    Continuation = never,
  >(definition: {
    readonly name: Name;
    readonly description?: string;
    readonly input: InputSchema;
    readonly output: OutputSchema;
    readonly failure?: FailureSchema;
    readonly signal?: SignalSchema;
    readonly handler: (
      input: SchemaOutput<InputSchema>,
      context: ToolExecutionContext<
        SignalSchema extends StandardSchema ? SchemaOutput<SignalSchema> : never
      >,
    ) => MaybePromise<
      | SchemaOutput<OutputSchema>
      | ToolFailure<FailureSchema extends StandardSchema ? SchemaOutput<FailureSchema> : never>
      | ToolSuspension<Continuation>
    >;
    readonly suspension?: ToolSuspensionDefinition<
      ResumeInput,
      Continuation,
      SchemaOutput<OutputSchema>,
      FailureSchema extends StandardSchema ? SchemaOutput<FailureSchema> : never,
      SignalSchema extends StandardSchema ? SchemaOutput<SignalSchema> : never
    >;
  }): DefinitionFor<
    Name,
    InputSchema,
    OutputSchema,
    FailureSchema,
    SignalSchema,
    ResumeInput,
    Continuation
  > {
    const modelTool: ModelTool = Object.freeze({
      name: definition.name,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      inputSchema: schemaJson(definition.input),
      execution: "commissary",
    });
    const value = Object.freeze({ ...definition, execution: "commissary" as const, modelTool });
    return createFragment<
      FragmentMetadata<
        DefinitionFor<
          Name,
          InputSchema,
          OutputSchema,
          FailureSchema,
          SignalSchema,
          ResumeInput,
          Continuation
        >,
        SignalSchema extends StandardSchema ? SchemaOutput<SignalSchema> : never,
        [ResumeInput] extends [never] ? never : ToolResumeRequest<Name, ResumeInput>
      >
    >([
      {
        kind: "tool",
        id: definition.name,
        contract: {
          name: definition.name,
          input: schemaJson(definition.input),
          outputVendor: definition.output["~standard"].vendor,
          resumable: definition.suspension !== undefined,
          execution: "commissary",
        },
        value,
      },
    ]) as DefinitionFor<
      Name,
      InputSchema,
      OutputSchema,
      FailureSchema,
      SignalSchema,
      ResumeInput,
      Continuation
    >;
  },

  provider<
    const Name extends string,
    const Namespace extends string,
    const Id extends `${string}.${string}`,
    const Args extends JsonValue,
    const InputSchema extends ModelSchema,
    const OutputSchema extends StandardSchema,
  >(definition: {
    readonly name: Name;
    readonly description?: string;
    readonly provider: ProviderToolDescriptor<Namespace, Id, Args>;
    readonly input: InputSchema;
    readonly output: OutputSchema;
  }): DefinitionFor<Name, InputSchema, OutputSchema, undefined, undefined, never, never> {
    const provider = Object.freeze({ ...definition.provider });
    const modelTool: ModelTool = Object.freeze({
      name: definition.name,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      inputSchema: schemaJson(definition.input),
      execution: "provider",
      provider,
    });
    const value = Object.freeze({
      ...definition,
      provider,
      execution: "provider" as const,
      modelTool,
    });
    return createFragment<
      FragmentMetadata<
        DefinitionFor<Name, InputSchema, OutputSchema, undefined, undefined, never, never>,
        never,
        never
      >
    >([
      {
        kind: "tool",
        id: definition.name,
        contract: {
          name: definition.name,
          input: schemaJson(definition.input),
          outputVendor: definition.output["~standard"].vendor,
          resumable: false,
          execution: "provider",
          provider,
        },
        value,
      },
    ]) as DefinitionFor<Name, InputSchema, OutputSchema, undefined, undefined, never, never>;
  },

  providerCallback<
    const Name extends string,
    const Namespace extends string,
    const Id extends `${string}.${string}`,
    const Args extends JsonValue,
    const InputSchema extends ModelSchema,
    const OutputSchema extends StandardSchema,
    const FailureSchema extends StandardSchema | undefined = undefined,
    const SignalSchema extends StandardSchema | undefined = undefined,
    ResumeInput = never,
    Continuation = never,
  >(definition: {
    readonly name: Name;
    readonly description?: string;
    readonly provider: ProviderToolDescriptor<Namespace, Id, Args>;
    readonly input: InputSchema;
    readonly output: OutputSchema;
    readonly failure?: FailureSchema;
    readonly signal?: SignalSchema;
    readonly handler: (
      input: SchemaOutput<InputSchema>,
      context: ToolExecutionContext<
        SignalSchema extends StandardSchema ? SchemaOutput<SignalSchema> : never
      >,
    ) => MaybePromise<
      | SchemaOutput<OutputSchema>
      | ToolFailure<FailureSchema extends StandardSchema ? SchemaOutput<FailureSchema> : never>
      | ToolSuspension<Continuation>
    >;
    readonly suspension?: ToolSuspensionDefinition<
      ResumeInput,
      Continuation,
      SchemaOutput<OutputSchema>,
      FailureSchema extends StandardSchema ? SchemaOutput<FailureSchema> : never,
      SignalSchema extends StandardSchema ? SchemaOutput<SignalSchema> : never
    >;
  }): DefinitionFor<
    Name,
    InputSchema,
    OutputSchema,
    FailureSchema,
    SignalSchema,
    ResumeInput,
    Continuation
  > {
    const provider = Object.freeze({ ...definition.provider });
    const modelTool: ModelTool = Object.freeze({
      name: definition.name,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      inputSchema: schemaJson(definition.input),
      execution: "provider-callback",
      provider,
    });
    const value = Object.freeze({
      ...definition,
      provider,
      execution: "provider-callback" as const,
      modelTool,
    });
    return createFragment<
      FragmentMetadata<
        DefinitionFor<
          Name,
          InputSchema,
          OutputSchema,
          FailureSchema,
          SignalSchema,
          ResumeInput,
          Continuation
        >,
        SignalSchema extends StandardSchema ? SchemaOutput<SignalSchema> : never,
        [ResumeInput] extends [never] ? never : ToolResumeRequest<Name, ResumeInput>
      >
    >([
      {
        kind: "tool",
        id: definition.name,
        contract: {
          name: definition.name,
          input: schemaJson(definition.input),
          outputVendor: definition.output["~standard"].vendor,
          resumable: definition.suspension !== undefined,
          execution: "provider-callback",
          provider,
        },
        value,
      },
    ]) as DefinitionFor<
      Name,
      InputSchema,
      OutputSchema,
      FailureSchema,
      SignalSchema,
      ResumeInput,
      Continuation
    >;
  },

  dynamic<const Id extends string>(
    provider: DynamicToolProvider<Id>,
  ): AgentFragment<FragmentMetadata<DynamicTool, unknown, unknown>> {
    return createFragment<FragmentMetadata<DynamicTool, unknown, unknown>>([
      {
        kind: "tool",
        id: `dynamic:${provider.id}`,
        contract: { dynamic: provider.id },
        value: Object.freeze({ ...provider, dynamic: true }),
      },
    ]);
  },

  failure<const Value>(value: Value): ToolFailure<Value> {
    const failure = Object.freeze({ type: "failure" }) as ToolFailure<Value>;
    failureValues.set(failure, value);
    return failure;
  },

  suspend<const Continuation>(continuation: Continuation): ToolSuspension<Continuation> {
    const suspension = Object.freeze({
      type: "suspension",
    }) as ToolSuspension<Continuation>;
    suspensionValues.set(suspension, continuation);
    return suspension;
  },
};

export namespace Tool {
  export type Input<Definition> = ToolInput<Definition>;
  export type Output<Definition> = ToolOutput<Definition>;
  export type Failure<Definition> = ToolFailureValue<Definition>;
  export type ResumeInput<Definition> = ToolResumeInput<Definition>;
  export type Suspension<Definition> = ToolSuspensionOutcome<Definition>;
}

export function isToolFailure(value: unknown): value is ToolFailure<unknown> {
  return typeof value === "object" && value !== null && failureValues.has(value);
}

export function isToolSuspension(value: unknown): value is ToolSuspension<unknown> {
  return typeof value === "object" && value !== null && suspensionValues.has(value);
}

export function toolFailureValue<Value>(failure: ToolFailure<Value>): Value {
  if (!failureValues.has(failure)) {
    throw new TypeError("Expected a Tool Failure created by Tool.failure");
  }
  return failureValues.get(failure) as Value;
}

export function toolSuspensionValue<Continuation>(
  suspension: ToolSuspension<Continuation>,
): Continuation {
  if (!suspensionValues.has(suspension)) {
    throw new TypeError("Expected a Tool Suspension created by Tool.suspend");
  }
  return suspensionValues.get(suspension) as Continuation;
}
