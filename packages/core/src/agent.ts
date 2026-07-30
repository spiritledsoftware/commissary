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
import {
  hooksForAgent,
  type AgentHookBuilder,
  type HookBlockedFailure,
  type HookFragment,
} from "./hook.js";
import type { AgentReference } from "./identity.js";
import type { ModelFailure } from "./protocol.js";
import type {
  ExecutionEvent as RuntimeExecutionEvent,
  ExecutionResult as RuntimeExecutionResult,
  RunResult as RuntimeRunResult,
  RunSnapshot as RuntimeRunSnapshot,
} from "./runtime.js";
import { isToolRuntimeDefinition, type Tool } from "./tool.js";
import { AgentRevision, stableJson, type AgentRunId } from "./types.js";

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

type DefinitionFor<Id extends string, Fragments extends FragmentInput> = AgentDefinition<
  Id,
  InputMetadata<Fragments>
>;

type HookInput = HookFragment | readonly HookFragment[];

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
    cause?: unknown,
  ) {
    super(message, { cause });
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
  return AgentRevision.decode(`r_${hash.toString(16).padStart(16, "0")}`);
}

function normalizeFragments(input: FragmentInput) {
  return Array.isArray(input)
    ? combineFragments(input)
    : (input as AgentFragment<AnyFragmentMetadata>);
}

function installContributions(
  agentId: string,
  contributions: readonly Contribution[],
): readonly Contribution[] {
  return Object.freeze(
    contributions.map((contribution, position) => {
      if (!isToolRuntimeDefinition(contribution.value)) {
        return contribution;
      }
      try {
        return Object.freeze({
          ...contribution,
          contract: Object.freeze({
            name: contribution.value.name,
            input: contribution.value.modelTool.inputSchema,
            ...(contribution.value.output === undefined
              ? {}
              : { outputVendor: contribution.value.output["~standard"].vendor }),
            resumable: contribution.value.suspension !== undefined,
          }),
        });
      } catch (cause) {
        throw new AgentInstallationError(
          cause instanceof Error
            ? cause.message
            : `Tool '${contribution.value.name}' has an invalid input JSON Schema`,
          agentId,
          [position],
          cause,
        );
      }
    }),
  );
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
  const contributions = installContributions(definition.id, contributionsOf(source.fragment));
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
    readonly hooks?: (hooks: AgentHookBuilder<DefinitionFor<Id, Fragments>>) => HookInput;
  }): DefinitionFor<Id, Fragments> {
    const agent = Object.freeze({ id: definition.id }) as DefinitionFor<Id, Fragments>;
    const base = normalizeFragments(definition.fragments);
    const hookInput = definition.hooks?.(hooksForAgent<DefinitionFor<Id, Fragments>>());
    sources.set(agent, {
      fragment:
        hookInput === undefined ? base : combineFragments([base, normalizeFragments(hookInput)]),
    });
    return agent;
  },
};

export namespace Agent {
  export type Fragment<Metadata extends AnyFragmentMetadata = AnyFragmentMetadata> =
    AgentFragment<Metadata>;
  export type Metadata<Definition> = AgentMetadataOf<Definition>;
  export type Tools<Definition> = AgentMetadataOf<Definition>["tools"];
  export type Events<Definition> = AgentMetadataOf<Definition>["events"];
  export type ToolResumptions<Definition> = AgentMetadataOf<Definition>["toolResumptions"];
  export type Requirements<Definition> = AgentMetadataOf<Definition>["requirements"];
  /** Every declared terminal Failure that an installed Agent can produce. */
  export type Failure<Definition extends AgentDefinition> =
    | Tool.Failure<Tools<Definition>>
    | HookBlockedFailure
    | ModelFailure;
  /** Execution Events specialized to an installed Agent's static and dynamic Tools. */
  export type ExecutionEvents<Definition extends AgentDefinition> = RuntimeExecutionEvent<
    Tools<Definition>
  >;
  /** Process-bound Execution results specialized to one installed Agent. */
  export type ExecutionResults<Definition extends AgentDefinition> = RuntimeExecutionResult<
    Failure<Definition>,
    Tools<Definition>,
    AgentRunId<Definition>
  >;
  /** Durable Run results specialized to one installed Agent. */
  export type RunResults<Definition extends AgentDefinition> = RuntimeRunResult<
    Failure<Definition>,
    Tools<Definition>,
    AgentRunId<Definition>
  >;
  /** Durable Run snapshots specialized to one installed Agent. */
  export type RunSnapshots<Definition extends AgentDefinition> = RuntimeRunSnapshot<
    Failure<Definition>,
    Tools<Definition>,
    AgentRunId<Definition>
  >;
  export type FragmentTools<Fragment> = MetadataOf<Fragment>["tools"];
  export type Empty = FragmentMetadata<never, never, never, never>;
}
