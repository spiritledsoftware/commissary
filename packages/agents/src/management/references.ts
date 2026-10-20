/**
 * The seam between Agents and the areas whose things a definition names (#226, `docs/ARCHITECTURE.md` "Agents"): a
 * hosted agent names a model (Models) and toolkits (Tools), and Agents imports neither area. The management routes ask
 * an {@link AgentReferences} instead, which the app Worker fills from Models' and Tools' `/management` entries
 * (`servedModelCheck`, `toolkitIds`; `apps/app/src/management/agent-routes.ts`); Agents' own tests need none, as the
 * part takes what the routes found ({@link ReferenceCheck}) as plain data.
 *
 * `R` is what the adapter's checks need of the request (the org, the bindings), provided by the Worker's request
 * context like any route's.
 */
import { Effect } from "effect";
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
}

/**
 * What `references` say of a write's `model` and `toolScope` (each left out when the write does not change it) for an
 * agent of `member` (`undefined`: a shared agent). The agents toolkit's entry is Agents' own, checked by the part.
 */
export const checkReferences = Effect.fnUntraced(function* <R>(
  references: AgentReferences<R>,
  member: string | undefined,
  change: { readonly model?: string | undefined; readonly toolScope?: ToolScope | undefined },
): Effect.fn.Return<ReferenceCheck, Reply, R> {
  const modelServed =
    change.model === undefined
      ? undefined
      : yield* references.servesModel(change.model.trim(), member);

  const named = (change.toolScope ?? [])
    .map((entry) => entry.toolkit.trim())
    .filter((toolkit) => toolkit !== AGENTS_TOOLKIT);

  if (named.length === 0) return { modelServed };
  const known = yield* references.toolkits(member);

  return { modelServed, unknownToolkits: named.filter((toolkit) => !known.has(toolkit)) };
});
