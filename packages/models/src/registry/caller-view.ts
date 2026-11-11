/**
 * The registry as one caller of the client API may use it, for routing (`handlers/model-providers.ts`) and the model
 * lists (`registry/routes.ts`) alike: their grants and private credentials (ADR 0023).
 */
import type { AccessIdentity } from "@commissary/auth";
import type { RegistrySnapshot } from "./service.ts";

/** The registry `identity` may use (no identity: a caller without a member). */
export const callerView = (
  snapshot: RegistrySnapshot,
  identity: AccessIdentity | undefined,
): RegistrySnapshot => snapshot.visibleTo(identity?.memberId);
