import {
  createFragment,
  type AgentFragment,
  type EmptyFragmentMetadata,
  type FragmentMetadata,
} from "./fragment.js";
import type { RunIdentity } from "./identity.js";
import type {
  ContentPart,
  ModelCapability,
  ModelEvent,
  ModelFailure,
  ModelInterruption,
  ModelRequest,
  ModelResponse,
  Transcript,
} from "./protocol.js";
import type { MaybePromise } from "./types.js";

const modelType: unique symbol = Symbol("commissary.model.type");

/** Input for one Context renderer. */
export interface RenderInput {
  readonly transcript: Transcript;
  readonly run: RunIdentity;
  readonly signal: AbortSignal;
}

/** One named Context contribution. */
export interface ContextContribution<Id extends string = string> {
  readonly id: Id;
  readonly render: (input: RenderInput) => MaybePromise<readonly ContentPart[]>;
}

/** A Model Fragment that can be installed as a root or declared as a child. */
export interface ModelDefinition<
  Id extends string = string,
  Requirements = never,
> extends AgentFragment<FragmentMetadata<never, never, never, Requirements>> {
  readonly [modelType]: {
    readonly id: Id;
    readonly requirements: Requirements;
  };
}

/** The terminal result of one nested Model invocation. */
export type NestedModelResult =
  | { readonly type: "response"; readonly response: ModelResponse }
  | { readonly type: "failure"; readonly failure: ModelFailure }
  | { readonly type: "interruption"; readonly interruption: ModelInterruption };

/** Options that identify one child invocation inside a Composite Model frame. */
export interface NestedModelInvocationOptions {
  readonly key: string;
}

/** Core-owned child invocation methods supplied to one Composite Model. */
export interface CompositeModelContext<
  Child extends ModelDefinition<string, unknown> = ModelDefinition<string, unknown>,
> {
  readonly signal: AbortSignal;
  readonly invoke: (
    child: Child,
    request: ModelRequest,
    options: NestedModelInvocationOptions,
  ) => Promise<NestedModelResult>;
  readonly forward: (
    child: Child,
    request: ModelRequest,
    options: NestedModelInvocationOptions,
  ) => AsyncIterable<ModelEvent>;
}

/** Runtime form of one Composite Model definition. */
export interface CompositeModelRuntime {
  readonly type: "composite";
  readonly id: string;
  readonly children: ReadonlyMap<ModelDefinition<string, unknown>, RuntimeModel>;
  readonly invoke: (
    request: ModelRequest,
    context: CompositeModelContext,
  ) => MaybePromise<AsyncIterable<ModelEvent>>;
}

/** Runtime form of a leaf or Composite Model. */
export type RuntimeModel =
  | { readonly type: "leaf"; readonly capability: ModelCapability<string, unknown> }
  | CompositeModelRuntime;

type ModelRequirements<Definition> =
  Definition extends ModelDefinition<string, infer Requirements> ? Requirements : never;

const runtimeModels = new WeakMap<object, RuntimeModel>();

/** Constructors for named Context contributions. */
export const Context = {
  define<const Id extends string>(
    definition: ContextContribution<Id>,
  ): AgentFragment<EmptyFragmentMetadata> {
    const value = Object.freeze({ ...definition });
    return createFragment<EmptyFragmentMetadata>([
      {
        kind: "context",
        id: definition.id,
        contract: { id: definition.id },
        value,
      },
    ]);
  },
};

/** Constructors and helpers for leaf and Composite Models. */
export const Model = {
  define<const Id extends string, Requirements = never>(
    definition: ModelCapability<Id, Requirements>,
  ): ModelDefinition<Id, Requirements> {
    const capability = Object.freeze({ ...definition });
    const runtime: RuntimeModel = Object.freeze({ type: "leaf", capability });
    const fragment = createFragment<FragmentMetadata<never, never, never, Requirements>>([
      {
        kind: "model",
        id: definition.id,
        contract: { id: definition.id, type: "leaf" },
        value: runtime,
      },
    ]);
    runtimeModels.set(fragment, runtime);
    // SAFETY: The hidden Model marker carries the same ID and Requirements as FragmentMetadata.
    return fragment as ModelDefinition<Id, Requirements>;
  },

  composite<
    const Id extends string,
    const Children extends readonly [
      ModelDefinition<string, unknown>,
      ...ModelDefinition<string, unknown>[],
    ],
  >(definition: {
    readonly id: Id;
    readonly children: Children;
    readonly invoke: (
      request: ModelRequest,
      context: CompositeModelContext<Children[number]>,
    ) => MaybePromise<AsyncIterable<ModelEvent>>;
  }): ModelDefinition<Id, ModelRequirements<Children[number]>> {
    const children = new Map<ModelDefinition<string, unknown>, RuntimeModel>();
    for (const child of definition.children) {
      if (children.has(child)) {
        throw new TypeError(`Composite Model '${definition.id}' declares one child more than once`);
      }
      children.set(child, runtimeModelDefinition(child));
    }
    const runtime: CompositeModelRuntime = Object.freeze({
      type: "composite",
      id: definition.id,
      children,
      // SAFETY: Runtime checks each opaque child against the declared child map before invocation.
      invoke: definition.invoke as CompositeModelRuntime["invoke"],
    });
    const fragment = createFragment<
      FragmentMetadata<never, never, never, ModelRequirements<Children[number]>>
    >([
      {
        kind: "model",
        id: definition.id,
        contract: {
          id: definition.id,
          type: "composite",
          children: [...children.values()].map((child) =>
            child.type === "leaf" ? child.capability.id : child.id,
          ),
        },
        value: runtime,
      },
    ]);
    runtimeModels.set(fragment, runtime);
    // SAFETY: Child Requirements are preserved as a union in FragmentMetadata and the hidden marker.
    return fragment as ModelDefinition<Id, ModelRequirements<Children[number]>>;
  },

  events(result: NestedModelResult): AsyncIterable<ModelEvent> {
    return {
      async *[Symbol.asyncIterator]() {
        switch (result.type) {
          case "response":
            yield { type: "finish", response: result.response };
            break;
          case "failure":
            yield { type: "failure", failure: result.failure };
            break;
          case "interruption":
            yield { type: "interruption", interruption: result.interruption };
            break;
        }
      },
    };
  },
};

/** Return hidden Runtime data for a Model created by this module. */
export function runtimeModelDefinition(model: ModelDefinition<string, unknown>): RuntimeModel {
  const runtime = runtimeModels.get(model);
  if (runtime === undefined) {
    throw new TypeError("Expected a Model created by Commissary");
  }
  return runtime;
}
