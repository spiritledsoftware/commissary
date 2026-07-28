import type { Codec } from "./codec.js";
import {
  contributionsOf,
  createFragment,
  type AgentFragment,
  type AnyFragmentMetadata,
  type FragmentMetadata,
} from "./fragment.js";
import type { RunIdentity } from "./identity.js";
import type { ModelTool, Transcript } from "./protocol.js";
import type { ModelSchema, SchemaOutput, StandardSchema } from "./schema.js";
import { schemaJson } from "./schema.js";
import type { JsonValue, MaybePromise, RunId, ToolAttemptId, ToolCallId } from "./types.js";

const toolType: unique symbol = Symbol("commissary.tool.type");
const failureType: unique symbol = Symbol("commissary.tool.failure");
const suspensionType: unique symbol = Symbol("commissary.tool.suspension");

/** A declared Tool Failure value. */
export interface ToolFailure<Value> {
  readonly type: "failure";
  readonly [failureType]: Value;
}

/** A declared Tool Suspension value. */
export interface ToolSuspension<Continuation> {
  readonly type: "suspension";
  readonly [suspensionType]: Continuation;
}

/** The result of an installed child Tool invocation. */
export type ToolInvocationResult<Output = unknown, Failure = unknown> =
  | { readonly type: "success"; readonly output: Output }
  | { readonly type: "failure"; readonly failure: Failure };

const failureValues = new WeakMap<object, unknown>();
const suspensionValues = new WeakMap<object, unknown>();

/** Input for one dynamic Tool Provider resolution. */
export interface DynamicToolProviderInput {
  readonly transcript: Transcript;
  readonly run: RunIdentity;
  readonly signal: AbortSignal;
}

/** One Tool definition produced at Render time. */
export interface DynamicTool {
  readonly type: "dynamic-tool";
  readonly definition: ModelTool;
  readonly execute: (
    input: unknown,
    context: ToolExecutionContext<unknown>,
  ) => MaybePromise<unknown>;
}

/** A named process-bound source of dynamic Tools. */
export interface DynamicToolProvider<Id extends string = string> {
  readonly id: Id;
  readonly resolve: (input: DynamicToolProviderInput) => MaybePromise<readonly DynamicTool[]>;
}

/** An installed Agent Fragment that owns one dynamic Tool Provider. */
export interface DynamicToolProviderFragment<Id extends string = string> extends AgentFragment<
  FragmentMetadata<DynamicTool, unknown, never>
> {
  readonly [toolType]: { readonly providerId: Id };
}

/** Options that identify one delegated child invocation. */
export interface ToolInvocationOptions {
  readonly key: string;
}

/** The core-owned interface for installed child Tool invocation. */
export interface ToolInvoker {
  <Definition extends ToolDefinition>(
    tool: Definition,
    input: ToolInput<Definition>,
    options: ToolInvocationOptions,
  ): Promise<ToolInvocationResult<ToolOutput<Definition>, ToolFailureValue<Definition>>>;

  (
    provider: DynamicToolProviderFragment,
    input: { readonly toolName: string; readonly input: JsonValue },
    options: ToolInvocationOptions,
  ): Promise<ToolInvocationResult<unknown, unknown>>;
}

/** Immutable context for one Tool Attempt. */
export interface ToolExecutionContext<Event = never> {
  readonly runId: RunId;
  readonly toolCallId: ToolCallId;
  readonly toolAttemptId: ToolAttemptId;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  readonly emit: (event: Event) => Promise<void>;
  readonly invoke: ToolInvoker;
}

/** One typed item in a Tool resume submission. */
export interface ToolResumeRequest<Name extends string, Input> {
  readonly toolName: Name;
  readonly toolCallId: ToolCallId;
  readonly input: Input;
}

/** Durable suspension and resume behavior for one Tool. */
export interface ToolSuspensionDefinition<
  ResumeInputSchema extends StandardSchema,
  Continuation,
  Output,
  Failure,
  Event,
> {
  readonly resumeInput: ResumeInputSchema;
  readonly continuation: Codec<Continuation>;
  readonly resume: (
    value: {
      readonly input: SchemaOutput<ResumeInputSchema>;
      readonly continuation: Continuation;
    },
    context: ToolExecutionContext<Event>,
  ) => MaybePromise<Output | ToolFailure<Failure> | ToolSuspension<Continuation>>;
}

/** An opaque installed Tool definition with inferred contracts. */
export interface ToolDefinition<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  Failure = unknown,
  Event = unknown,
  ResumeInput = unknown,
  Continuation = unknown,
> extends AgentFragment<
  FragmentMetadata<
    ToolDefinition<Name, Input, Output, Failure, Event, ResumeInput, Continuation>,
    Event,
    [ResumeInput] extends [never] ? never : ToolResumeRequest<Name, ResumeInput>
  >
> {
  readonly [toolType]: {
    readonly name: Name;
    readonly input: Input;
    readonly output: Output;
    readonly failure: Failure;
    readonly event: Event;
    readonly resumeInput: ResumeInput;
    readonly continuation: Continuation;
  };
}

/** Runtime data hidden behind a Tool Fragment. */
export interface ToolRuntimeDefinition {
  readonly name: string;
  readonly modelTool: ModelTool;
  readonly input: StandardSchema;
  readonly output: StandardSchema;
  readonly failure?: StandardSchema;
  readonly event?: StandardSchema;
  readonly handler: (
    input: unknown,
    context: ToolExecutionContext<unknown>,
  ) => MaybePromise<unknown>;
  readonly suspension?: ToolSuspensionDefinition<
    StandardSchema,
    unknown,
    unknown,
    unknown,
    unknown
  >;
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

type ToolEvent<Definition> = Definition extends {
  readonly [toolType]: { readonly event: infer Event };
}
  ? Event
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
  EventSchema extends StandardSchema | undefined,
  ResumeInputSchema extends StandardSchema | undefined,
  Continuation,
> = ToolDefinition<
  Name,
  SchemaOutput<InputSchema>,
  SchemaOutput<OutputSchema>,
  FailureSchema extends StandardSchema ? SchemaOutput<FailureSchema> : never,
  EventSchema extends StandardSchema ? SchemaOutput<EventSchema> : never,
  ResumeInputSchema extends StandardSchema ? SchemaOutput<ResumeInputSchema> : never,
  Continuation
>;

const runtimeDefinitions = new WeakMap<object, ToolRuntimeDefinition>();
const dynamicProviders = new WeakMap<object, DynamicToolProvider>();
const runtimeDefinitionValues = new WeakSet<object>();

/** Constructors and result helpers for Tool values. */
export const Tool = {
  define<
    const Name extends string,
    const InputSchema extends ModelSchema,
    const OutputSchema extends StandardSchema,
    const FailureSchema extends StandardSchema | undefined = undefined,
    const EventSchema extends StandardSchema | undefined = undefined,
    const ResumeInputSchema extends StandardSchema | undefined = undefined,
    Continuation = never,
  >(definition: {
    readonly name: Name;
    readonly description?: string;
    readonly input: InputSchema;
    readonly output: OutputSchema;
    readonly failure?: FailureSchema;
    readonly event?: EventSchema;
    readonly handler: (
      input: SchemaOutput<InputSchema>,
      context: ToolExecutionContext<
        EventSchema extends StandardSchema ? SchemaOutput<EventSchema> : never
      >,
    ) => MaybePromise<
      | SchemaOutput<OutputSchema>
      | ToolFailure<FailureSchema extends StandardSchema ? SchemaOutput<FailureSchema> : never>
      | ToolSuspension<Continuation>
    >;
    readonly suspension?: ResumeInputSchema extends StandardSchema
      ? ToolSuspensionDefinition<
          ResumeInputSchema,
          Continuation,
          SchemaOutput<OutputSchema>,
          FailureSchema extends StandardSchema ? SchemaOutput<FailureSchema> : never,
          EventSchema extends StandardSchema ? SchemaOutput<EventSchema> : never
        >
      : never;
  }): DefinitionFor<
    Name,
    InputSchema,
    OutputSchema,
    FailureSchema,
    EventSchema,
    ResumeInputSchema,
    Continuation
  > {
    let installedModelTool: ModelTool | undefined;
    const readModelTool = (): ModelTool => {
      if (installedModelTool !== undefined) {
        return installedModelTool;
      }
      let inputSchema: JsonValue;
      try {
        inputSchema = schemaJson(definition.input);
      } catch (cause) {
        throw new TypeError(`Tool '${definition.name}' has an invalid input JSON Schema`, {
          cause,
        });
      }
      installedModelTool = Object.freeze({
        name: definition.name,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        inputSchema,
      });
      return installedModelTool;
    };
    const runtime: ToolRuntimeDefinition = Object.freeze({
      name: definition.name,
      get modelTool() {
        return readModelTool();
      },
      input: definition.input,
      output: definition.output,
      ...(definition.failure === undefined ? {} : { failure: definition.failure }),
      ...(definition.event === undefined ? {} : { event: definition.event }),
      // SAFETY: The public generic contract proves the handler and suspension types. Runtime validates every boundary before invocation.
      handler: definition.handler as ToolRuntimeDefinition["handler"],
      ...(definition.suspension === undefined
        ? {}
        : {
            // SAFETY: The public generic contract proves the suspension types. Runtime parses resume input and decodes continuation state.
            suspension: definition.suspension as ToolRuntimeDefinition["suspension"],
          }),
    });
    const fragment = createFragment<
      FragmentMetadata<
        DefinitionFor<
          Name,
          InputSchema,
          OutputSchema,
          FailureSchema,
          EventSchema,
          ResumeInputSchema,
          Continuation
        >,
        EventSchema extends StandardSchema ? SchemaOutput<EventSchema> : never,
        ResumeInputSchema extends StandardSchema
          ? ToolResumeRequest<Name, SchemaOutput<ResumeInputSchema>>
          : never
      >
    >([
      {
        kind: "tool",
        id: definition.name,
        contract: {
          name: definition.name,
          outputVendor: definition.output["~standard"].vendor,
          resumable: definition.suspension !== undefined,
        },
        value: runtime,
      },
    ]);
    runtimeDefinitionValues.add(runtime);
    runtimeDefinitions.set(fragment, runtime);
    // SAFETY: FragmentMetadata and toolType describe the same contracts. The runtime marker stays inaccessible to callers.
    return fragment as unknown as DefinitionFor<
      Name,
      InputSchema,
      OutputSchema,
      FailureSchema,
      EventSchema,
      ResumeInputSchema,
      Continuation
    >;
  },

  dynamic<const Id extends string>(
    provider: DynamicToolProvider<Id>,
  ): DynamicToolProviderFragment<Id> {
    const fragment = createFragment<FragmentMetadata<DynamicTool, unknown, never>>([
      {
        kind: "tool",
        id: `dynamic:${provider.id}`,
        contract: { dynamic: provider.id },
        value: Object.freeze({ ...provider, dynamic: true }),
      },
    ]);
    dynamicProviders.set(fragment, provider);
    // SAFETY: The hidden marker carries only the provider ID. The provider value stays in a WeakMap and the Agent contribution.
    return fragment as DynamicToolProviderFragment<Id>;
  },

  failure<const Value>(value: Value): ToolFailure<Value> {
    // SAFETY: The WeakMap binds this frozen marker to Value. Callers cannot create a valid marker directly.
    const failure = Object.freeze({ type: "failure" }) as ToolFailure<Value>;
    failureValues.set(failure, value);
    return failure;
  },

  suspend<const Continuation>(continuation: Continuation): ToolSuspension<Continuation> {
    // SAFETY: The WeakMap binds this frozen marker to Continuation. Callers cannot create a valid marker directly.
    const suspension = Object.freeze({ type: "suspension" }) as ToolSuspension<Continuation>;
    suspensionValues.set(suspension, continuation);
    return suspension;
  },
};

/** Inferred contracts for Tool values. */
export namespace Tool {
  export type Input<Definition> = ToolInput<Definition>;
  export type Output<Definition> = ToolOutput<Definition>;
  export type Failure<Definition> = ToolFailureValue<Definition>;
  export type Event<Definition> = ToolEvent<Definition>;
  export type ResumeInput<Definition> = ToolResumeInput<Definition>;
  export type Suspension<Definition> = ToolSuspensionOutcome<Definition>;
}

/** Test whether a value is a Tool Failure marker. */
export function isToolFailure(value: unknown): value is ToolFailure<unknown> {
  return typeof value === "object" && value !== null && failureValues.has(value);
}

/** Test whether a value is a Tool Suspension marker. */
export function isToolSuspension(value: unknown): value is ToolSuspension<unknown> {
  return typeof value === "object" && value !== null && suspensionValues.has(value);
}

/** Read the value from a valid Tool Failure marker. */
export function toolFailureValue<Value>(failure: ToolFailure<Value>): Value {
  if (!failureValues.has(failure)) {
    throw new TypeError("Expected a Tool Failure created by Tool.failure");
  }
  // SAFETY: isToolFailure and Tool.failure preserve the Value association in failureValues.
  return failureValues.get(failure) as Value;
}

/** Read the continuation from a valid Tool Suspension marker. */
export function toolSuspensionValue<Continuation>(
  suspension: ToolSuspension<Continuation>,
): Continuation {
  if (!suspensionValues.has(suspension)) {
    throw new TypeError("Expected a Tool Suspension created by Tool.suspend");
  }
  // SAFETY: isToolSuspension and Tool.suspend preserve the Continuation association in suspensionValues.
  return suspensionValues.get(suspension) as Continuation;
}

/** Test whether one hidden contribution value is a static Tool Runtime definition. */
export function isToolRuntimeDefinition(value: unknown): value is ToolRuntimeDefinition {
  return typeof value === "object" && value !== null && runtimeDefinitionValues.has(value);
}

/** Return the hidden Runtime definition for an installed static Tool Fragment. */
export function runtimeToolDefinition(tool: ToolDefinition): ToolRuntimeDefinition {
  const definition = runtimeDefinitions.get(tool);
  if (definition === undefined) {
    const contribution = contributionsOf(tool as AgentFragment<AnyFragmentMetadata>).find(
      (candidate) => candidate.kind === "tool" && !candidate.id.startsWith("dynamic:"),
    );
    if (contribution === undefined) {
      throw new TypeError("Expected a Tool created by Tool.define");
    }
    // SAFETY: Tool contributions created by this module always contain ToolRuntimeDefinition.
    return contribution.value as ToolRuntimeDefinition;
  }
  return definition;
}

/** Test whether a value is a dynamic Tool Provider Fragment. */
export function isDynamicToolProviderFragment(
  value: ToolDefinition | DynamicToolProviderFragment,
): value is DynamicToolProviderFragment {
  return dynamicProviders.has(value);
}

/** Return the hidden provider for an installed dynamic Tool Provider Fragment. */
export function runtimeDynamicToolProvider(
  fragment: DynamicToolProviderFragment,
): DynamicToolProvider {
  const provider = dynamicProviders.get(fragment);
  if (provider === undefined) {
    throw new TypeError("Expected a Tool Provider created by Tool.dynamic");
  }
  return provider;
}
