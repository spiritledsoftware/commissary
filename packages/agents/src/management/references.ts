/**
 * The seam between Agents and the areas whose things a definition names (#226, `docs/ARCHITECTURE.md` "Agents"): a
 * hosted agent names a model (Models) and toolkits (Tools), and Agents imports neither area. The management routes ask
 * an {@link AgentReferences} instead, which the app Worker fills from Models' and Tools' `/management` entries
 * (`servedModelCheck`, `toolkitIds`, `sandboxRefusal`; `apps/app/src/management/agent-routes.ts`); Agents' own tests
 * need none, as the part takes what the routes found ({@link ReferenceCheck}) as plain data. The run routes read what
 * runs cost from Models' usage records through it too (`runCosts`, #234).
 *
 * `R` is what the adapter's checks need of the request (the org, the bindings), provided by the Worker's request
 * context like any route's.
 */
import { Effect, type Option } from "effect";
import type { AgentSandbox } from "@commissary/contract/agents";
import { AGENTS_TOOLKIT, type ToolScope } from "@commissary/contract/api-keys";
import type { Reply } from "@commissary/core";
import type { ReferenceCheck } from "../control-plane-part.ts";

export interface AgentReferences<R> {
  /**
   * Whether the current org serves `model` as clients name it (its aliases included): on its shared credentials for a
   * shared agent (`member` undefined), or to `member` for their private agent.
   */
  readonly servesModel: (
    model: string,
    member: string | undefined,
  ) => Effect.Effect<boolean, Reply, R>;
  /**
   * The ids of the toolkits a definition may name: the org's toolkits for a shared agent (`member` undefined), or those
   * `member` can see (the org's and their private toolkits) for their private agent. Tools outside their grants are
   * narrowed at run time (#227).
   */
  readonly toolkits: (member: string | undefined) => Effect.Effect<ReadonlySet<string>, Reply, R>;
  /**
   * Why `sandbox` cannot be the sandbox of an agent of `member` (#230; `undefined`: a shared agent): it names no
   * sandbox toolkit the org has (or `member` can see), or asks for a network or the computer beyond that toolkit's
   * ceiling. `undefined` when it can be.
   */
  readonly sandboxRefusal: (
    sandbox: AgentSandbox,
    member: string | undefined,
  ) => Effect.Effect<string | undefined, Reply, R>;
  /**
   * What each of `runs` (runs the caller sees, #232) cost so far, in micro-dollars, by run id, from the usage records,
   * `member` (the caller) reading their own private records too (#234); a run with no priced record is left out (it
   * cost nothing). Never fails: `None` when the usage store is missing or could not be read.
   */
  readonly runCosts: (
    runs: ReadonlyArray<string>,
    member: string | undefined,
  ) => Effect.Effect<Option.Option<ReadonlyMap<string, number>>, never, R>;
}

/**
 * What `references` say of a write's `model`, `toolScope` and `sandbox` (each left out when the write does not change
 * it, and `sandbox` when it clears it) for an agent of `member` (`undefined`: a shared agent). The agents toolkit's
 * entry is Agents' own, checked by the part.
 */
export const checkReferences = Effect.fnUntraced(function* <R>(
  references: AgentReferences<R>,
  member: string | undefined,
  change: {
    readonly model?: string | undefined;
    readonly toolScope?: ToolScope | undefined;
    readonly sandbox?: AgentSandbox | null | undefined;
  },
): Effect.fn.Return<ReferenceCheck, Reply, R> {
  const modelServed =
    change.model === undefined
      ? undefined
      : yield* references.servesModel(change.model.trim(), member);

  const sandboxRefusal =
    change.sandbox === undefined || change.sandbox === null
      ? undefined
      : yield* references.sandboxRefusal(
          { ...change.sandbox, toolkit: change.sandbox.toolkit.trim() },
          member,
        );

  const named = (change.toolScope ?? [])
    .map((entry) => entry.toolkit.trim())
    .filter((toolkit) => toolkit !== AGENTS_TOOLKIT);

  if (named.length === 0) return { modelServed, sandboxRefusal };
  const known = yield* references.toolkits(member);

  return {
    modelServed,
    unknownToolkits: named.filter((toolkit) => !known.has(toolkit)),
    sandboxRefusal,
  };
});
