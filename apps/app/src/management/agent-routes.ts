/**
 * The Agents area's management routes (#226, `@commissary/agents/management`), mounted with what they check a hosted
 * agent's definition against: the models the org serves (Models' `servedModelCheck`, over the isolate's
 * `ModelRegistry`) and the toolkits it has (Tools' `toolkitIds`, over the Tools part). Agents imports neither area;
 * this adapter is the seam between them (`docs/ARCHITECTURE.md` "Agents").
 */
import { Effect, Layer } from "effect";
import { type AgentReferences, managementRoutes } from "@commissary/agents/management";
import type { CurrentOrg } from "@commissary/core";
import { type ModelsEnv } from "@commissary/models/api";
import { servedModelCheck } from "@commissary/models/management";
import { type ToolsEnv } from "@commissary/tools/api";
import { toolkitIds } from "@commissary/tools/management";

/** Agents' routes, needing the `ModelRegistry` the Models routes share. */
export const AgentRoutes = Layer.unwrap(
  Effect.map(servedModelCheck, (servesModel) => {
    const references: AgentReferences<ModelsEnv | ToolsEnv | CurrentOrg> = {
      servesModel,
      toolkits: toolkitIds,
    };

    return managementRoutes(references);
  }),
);
