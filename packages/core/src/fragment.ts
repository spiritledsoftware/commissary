import type { JsonValue } from "./types.js";

const fragmentMetadata: unique symbol = Symbol("commissary.fragment.metadata");

/** Compile-time metadata carried by an opaque Agent Fragment. */
export interface FragmentMetadata<
  Tools = never,
  Events = never,
  ToolResumptions = never,
  Requirements = never,
> {
  readonly tools: Tools;
  readonly events: Events;
  readonly toolResumptions: ToolResumptions;
  readonly requirements: Requirements;
}

export type EmptyFragmentMetadata = FragmentMetadata<never, never, never, never>;
export type AnyFragmentMetadata = FragmentMetadata<unknown, unknown, unknown, unknown>;

export interface AgentFragment<Metadata extends AnyFragmentMetadata = AnyFragmentMetadata> {
  readonly [fragmentMetadata]: Metadata;
}

export type MetadataOf<Fragment> =
  Fragment extends AgentFragment<infer Metadata> ? Metadata : never;

export type CombinedMetadata<Fragments extends readonly AgentFragment<AnyFragmentMetadata>[]> =
  FragmentMetadata<
    MetadataOf<Fragments[number]>["tools"],
    MetadataOf<Fragments[number]>["events"],
    MetadataOf<Fragments[number]>["toolResumptions"],
    MetadataOf<Fragments[number]>["requirements"]
  >;

export type ContributionKind = "context" | "model" | "tool" | "hook";

export interface Contribution {
  readonly kind: ContributionKind;
  readonly id: string;
  readonly contract: JsonValue;
  readonly value: unknown;
}

const contents = new WeakMap<object, readonly Contribution[]>();

export function createFragment<Metadata extends AnyFragmentMetadata>(
  contributions: readonly Contribution[],
): AgentFragment<Metadata> {
  const fragment = Object.freeze(Object.create(null)) as AgentFragment<Metadata>;
  contents.set(fragment, Object.freeze([...contributions]));
  return fragment;
}

export function combineFragments<
  const Fragments extends readonly AgentFragment<AnyFragmentMetadata>[],
>(fragments: Fragments): AgentFragment<CombinedMetadata<Fragments>> {
  const combined: Contribution[] = [];
  for (const fragment of fragments) {
    const contributions = contents.get(fragment);
    if (contributions === undefined) {
      throw new TypeError("Agent.combine received a value that is not an Agent Fragment");
    }
    combined.push(...contributions);
  }
  return createFragment<CombinedMetadata<Fragments>>(combined);
}

export function contributionsOf(
  fragment: AgentFragment<AnyFragmentMetadata>,
): readonly Contribution[] {
  const contributions = contents.get(fragment);
  if (contributions === undefined) {
    throw new TypeError("Expected an Agent Fragment created by Commissary");
  }
  return contributions;
}
