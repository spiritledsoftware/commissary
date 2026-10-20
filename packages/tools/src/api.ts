/**
 * `@commissary/tools/api`, Tools' entry for the API Worker (#134 "The area package convention"): its client API (the
 * MCP endpoint at `/mcp`, #197, and Commissary's CIMD document for toolkits' OAuth sign-ins, #202), its cron task and
 * its view of `env`. The apps import Tools only through this entry, `./management` and `./state` (the lint rule
 * `boundaries/tools-imports`).
 */
export { type ToolsBindings, ToolsEnv } from "./env.ts";

export { ClientApiLayer } from "./client-api.ts";

export { scheduledTasks } from "./scheduled-tasks.ts";

export {
  mcpChallenge,
  ProtectedResourceMetadataRoutes,
  withMcpAccessToken,
} from "./oauth/resource.ts";

export { PROTECTED_RESOURCE_METADATA_PATH } from "./oauth/config.ts";
