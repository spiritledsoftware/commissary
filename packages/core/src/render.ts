import {
  createFragment,
  type AgentFragment,
  type EmptyFragmentMetadata,
  type FragmentMetadata,
} from "./fragment.js";
import type { RunIdentity } from "./identity.js";
import type { ContentPart, ModelCapability, Transcript } from "./protocol.js";
import type { MaybePromise } from "./types.js";

export interface RenderInput {
  readonly transcript: Transcript;
  readonly run: RunIdentity;
  readonly signal: AbortSignal;
}

export interface ContextContribution<Id extends string = string> {
  readonly id: Id;
  readonly render: (input: RenderInput) => MaybePromise<readonly ContentPart[]>;
}

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

export const Model = {
  define<const Id extends string, Requirements = never>(
    definition: ModelCapability<Id, Requirements>,
  ): AgentFragment<FragmentMetadata<never, never, never, Requirements>> {
    const value = Object.freeze({ ...definition });
    return createFragment<FragmentMetadata<never, never, never, Requirements>>([
      {
        kind: "model",
        id: definition.id,
        contract: { id: definition.id },
        value,
      },
    ]);
  },
};
