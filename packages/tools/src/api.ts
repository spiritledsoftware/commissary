/**
 * `@commissary/tools/api`, Tools' entry for the API Worker (#134 "The area package convention"): its client API (the
 * MCP endpoint, #197, which the app Worker of a self-hosted Commissary also mounts, #251), its cron task and its view of
 * `env`. The apps import Tools only through this entry,
 * `./management` and `./state` (the lint rule `boundaries/tools-imports`).
 */
export { type ToolsBindings, ToolsEnv } from "./env.ts";

export { McpRoutes as ClientApiLayer } from "./mcp/endpoint.ts";

/** The MCP endpoint alone, which a self-hosted Commissary's app Worker also serves behind Access (#251, ADR 0045). */
export { McpRoutes } from "./mcp/endpoint.ts";

export { scheduledTasks } from "./scheduled-tasks.ts";
