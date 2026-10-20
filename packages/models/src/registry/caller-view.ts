/**
 * The registry as one caller of the client API may use it, for routing (`handlers/model-providers.ts`) and the model
 * lists (`registry/routes.ts`) alike: their grants and private credentials (ADR 0023), and for a hosted agent's run
 * (#227, ADR 0040) its definition: a shared agent's run acts as the agent, whose reach is the org's shared credentials
 * whatever the grants, and any run reaches its definition's model alone.
 */
import { type AccessIdentity, isSharedAgentRun } from "@commissary/auth";
import { parseSuffix } from "@commissary/translation/thinking";
import type { RegistrySnapshot } from "./service.ts";

/** The registry `identity` may use (no identity: a caller without a member). */
export const callerView = (
  snapshot: RegistrySnapshot,
  identity: AccessIdentity | undefined,
): RegistrySnapshot =>
  identity !== undefined && isSharedAgentRun(identity.principal)
    ? snapshot.shared()
    : snapshot.visibleTo(identity?.memberId);

const baseName = (model: string): string => parseSuffix(model).modelName.trim().toLowerCase();

/**
 * The models `identity` may name, when narrowed: an agent run's definition's model alone, whatever its thinking suffix
 * (the definition's thinking level is the suffix the run sends); `auto` names none. `undefined`: any model.
 */
export const runModelFilter = (
  identity: AccessIdentity | undefined,
): ((model: string) => boolean) | undefined => {
  if (identity?.principal.kind !== "run") return undefined;
  const only = baseName(identity.principal.reach.model);

  return (requested) => baseName(requested) === only;
};
