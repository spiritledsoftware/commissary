/**
 * Agents' section of the export of an org (`GET /v9/management/export`, ADR 0027; the app Worker's `org-routes.ts`
 * builds the rest, #134 "The area package convention"): the agents the caller manages, each with its definition and,
 * for a shared agent, its watchers and grants (members by email, teams by name). Runs are not part of it (#227).
 */
import { Effect } from "effect";
import { currentViewer } from "@commissary/auth";
import { agentsControlPlane } from "../env.ts";

/** Agents' section of the current org's export, as the caller may see it. */
export const exportSection = Effect.gen(function* () {
  const viewer = yield* currentViewer;

  const agents = yield* agentsControlPlane("exportAgents", (stub) =>
    stub.agents().exportAgents(viewer),
  );

  return { agents };
});
