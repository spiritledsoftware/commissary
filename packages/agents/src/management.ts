/**
 * `@commissary/agents/management`, Agents' entry for the app Worker (#134 "The area package convention"): its
 * management API routes (with the seam through which the app Worker checks what a definition names in Models and Tools,
 * {@link AgentReferences}), its entries of the role table, its org-deletion step and its section of the org export
 * (its view of `env` and whether the deployment has the area are `./api`'s). The apps import Agents only through this
 * entry, `./api` and `./state` (the lint rule `boundaries/agents-imports`).
 */
export { accessRules } from "./management/access-rules.ts";

export { exportSection } from "./management/export-view.ts";

export { type AgentReferences } from "./management/references.ts";

export { managementRoutes } from "./management/routes.ts";

export { orgDeletionStep } from "./org-deletion.ts";
