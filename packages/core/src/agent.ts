import {
  combineFragments,
  contributionsOf,
  createFragment,
  type AgentFragment,
  type AnyFragmentMetadata,
  type CombinedMetadata,
  type Contribution,
  type EmptyFragmentMetadata,
  type FragmentMetadata,
  type MetadataOf,
} from "./fragment.js";
import type { AgentReference } from "./identity.js";
import { stableJson, type AgentRevision } from "./types.js";

const agentMetadata: unique symbol = Symbol("commissary.agent.metadata");

export interface AgentDefinition<
  Id extends string = string,
  Metadata extends AnyFragmentMetadata = AnyFragmentMetadata,
> {
  readonly id: Id;
  readonly [agentMetadata]: Metadata;
}

type FragmentInput =
  | AgentFragment<AnyFragmentMetadata>
  | readonly AgentFragment<AnyFragmentMetadata>[];

type InputMetadata<Input extends FragmentInput> =
  Input extends AgentFragment<infer Metadata>
    ? Metadata
    : Input extends readonly AgentFragment<AnyFragmentMetadata>[]
      ? CombinedMetadata<Input>
      : never;

type AgentMetadataOf<Definition> =
  Definition extends AgentDefinition<string, infer Metadata> ? Metadata : never;

interface AgentSource {
  readonly fragment: AgentFragment<AnyFragmentMetadata>;
}

export interface InstalledAgentData<
  Id extends string = string,
  Metadata extends AnyFragmentMetadata = AnyFragmentMetadata,
> {
  readonly definition: AgentDefinition<Id, Metadata>;
  readonly reference: AgentReference<Id>;
  readonly contributions: readonly Contribution[];
}

const sources = new WeakMap<object, AgentSource>();
const installed = new WeakMap<object, InstalledAgentData>();

export class AgentInstallationError extends Error {
  constructor(
    message: string,
    readonly agentId: string,
    readonly contributions: readonly number[],
  ) {
    super(message);
    this.name = "AgentInstallationError";
  }
}

function revisionFor(id: string, contributions: readonly Contribution[]) {
  const manifest = stableJson({
    id,
    contributions: contributions.map(({ kind, id: contributionId, contract }) => ({
      kind,
      id: contributionId,
      contract,
    })),
  });
  let hash = 0xcbf29ce484222325n;
  for (const character of manifest) {
    hash ^= BigInt(character.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `r_${hash.toString(16).padStart(16, "0")}` as AgentRevision;
}

function normalizeFragments(input: FragmentInput) {
  return Array.isArray(input)
    ? combineFragments(input)
    : (input as AgentFragment<AnyFragmentMetadata>);
}

export function installAgent<Id extends string, Metadata extends AnyFragmentMetadata>(
  definition: AgentDefinition<Id, Metadata>,
): InstalledAgentData<Id, Metadata> {
  const previous = installed.get(definition);
  if (previous !== undefined) {
    return previous as InstalledAgentData<Id, Metadata>;
  }

  const source = sources.get(definition);
  if (source === undefined) {
    throw new AgentInstallationError(
      "Expected an Agent created by Agent.define",
      definition.id,
      [],
    );
  }
  const contributions = contributionsOf(source.fragment);
  const identities = new Map<string, number>();
  const modelPositions: number[] = [];

  for (const [position, contribution] of contributions.entries()) {
    if (contribution.kind === "model") {
      modelPositions.push(position);
    }
    if (contribution.kind === "hook") {
      continue;
    }
    const key = `${contribution.kind}:${contribution.id}`;
    const previousPosition = identities.get(key);
    if (previousPosition !== undefined) {
      throw new AgentInstallationError(
        `Conflicting ${contribution.kind} contribution '${contribution.id}' at positions ${previousPosition} and ${position}`,
        definition.id,
        [previousPosition, position],
      );
    }
    identities.set(key, position);
  }

  if (modelPositions.length !== 1) {
    throw new AgentInstallationError(
      `Agent '${definition.id}' must install exactly one Model contribution; received ${modelPositions.length}`,
      definition.id,
      modelPositions,
    );
  }

  const result: InstalledAgentData<Id, Metadata> = Object.freeze({
    definition,
    reference: Object.freeze({
      id: definition.id,
      revision: revisionFor(definition.id, contributions),
    }),
    contributions,
  });
  installed.set(definition, result);
  return result;
}

export const Agent = {
  empty: createFragment<EmptyFragmentMetadata>([]),

  combine<const Fragments extends readonly AgentFragment<AnyFragmentMetadata>[]>(
    ...fragments: Fragments
  ): AgentFragment<CombinedMetadata<Fragments>> {
    return combineFragments(fragments);
  },

  define<const Id extends string, const Fragments extends FragmentInput>(definition: {
    readonly id: Id;
    readonly fragments: Fragments;
  }): AgentDefinition<Id, InputMetadata<Fragments>> {
    const agent = Object.freeze({ id: definition.id }) as AgentDefinition<
      Id,
      InputMetadata<Fragments>
    >;
    sources.set(agent, {
      fragment: normalizeFragments(definition.fragments),
    });
    return agent;
  },
};

export namespace Agent {
  export type Fragment<Metadata extends AnyFragmentMetadata = AnyFragmentMetadata> =
    AgentFragment<Metadata>;
  export type Metadata<Definition> = AgentMetadataOf<Definition>;
  export type Tools<Definition> = AgentMetadataOf<Definition>["tools"];
  export type ToolSignals<Definition> = AgentMetadataOf<Definition>["toolSignals"];
  export type ToolResumptions<Definition> = AgentMetadataOf<Definition>["toolResumptions"];
  export type Requirements<Definition> = AgentMetadataOf<Definition>["requirements"];
  export type FragmentTools<Fragment> = MetadataOf<Fragment>["tools"];
  export type Empty = FragmentMetadata<never, never, never, never>;
}
