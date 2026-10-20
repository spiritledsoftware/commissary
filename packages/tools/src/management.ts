/**
 * `@commissary/tools/management`, Tools' entry for the app Worker (#134 "The area package convention"): its management
 * API routes, its entries of the role table, its org-deletion step, its section of the org export, and the MCP endpoint
 * at a path of the app Worker's choosing, which a self-hosted Commissary serves on the app host behind Access (#251,
 * ADR 0045). The apps import
 * Tools only through this entry, `./api` and `./state` (the lint rule `boundaries/tools-imports`).
 */
export { accessRules } from "./management/access-rules.ts";

export { exportSection } from "./management/export-view.ts";

export { ManagementRoutes } from "./management/routes.ts";

export { mcpRoutesAt } from "./mcp/endpoint.ts";

export { orgDeletionStep } from "./org-deletion.ts";
