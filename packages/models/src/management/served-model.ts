/**
 * Whether the current org serves a model as clients name it, for the Agents area's check of a hosted agent's model
 * (#226, ADR 0040): the app Worker hands it to Agents' routes (`AgentReferences`), as Agents imports nothing of Models.
 * A model is served when some credential registers it under that name (its aliases and prefixes applied, as selection
 * resolves it): on the org's shared credentials for a shared agent, or among what one member may use for their private
 * agent. Workers addition, no Go counterpart.
 */
import { Effect } from "effect";
import { type CurrentOrg, type Reply, replyError } from "@commissary/core";
import type { ModelsEnv } from "../env.ts";
import { ModelRegistry } from "../registry/service.ts";

/** A check of one model in the current org; `member` undefined: on its shared credentials, whatever the grants. */
export type ServedModelCheck = (
  model: string,
  member: string | undefined,
) => Effect.Effect<boolean, Reply, ModelsEnv | CurrentOrg>;

/** The check over the isolate's registry, bound once (a route's layer builds it, as Models' own routes bind theirs). */
export const servedModelCheck: Effect.Effect<ServedModelCheck, never, ModelRegistry> = Effect.gen(
  function* () {
    const registry = yield* ModelRegistry;

    return (model, member) =>
      registry.fresh.pipe(
        Effect.map(
          (snapshot) =>
            (member === undefined
              ? snapshot.shared()
              : snapshot.visibleTo(member)
            ).providersForModel(model).length > 0,
        ),
        Effect.catch((error) =>
          Effect.logError(`served model check: registry build failed: ${error.message}`).pipe(
            Effect.andThen(Effect.fail(replyError(502, "model registry unavailable"))),
          ),
        ),
      );
  },
);
