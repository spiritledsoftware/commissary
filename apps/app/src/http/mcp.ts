/**
 * The MCP endpoint on the app host of a self-hosted Commissary (#251, ADR 0045): Tools' endpoint at `/mcp` (the org
 * `global`) and `/o/<slug>/mcp` (another org), for MCP clients Access signs in. The Access gate
 * (`access/middleware.ts`) authenticates them and names the org (`management/zones.ts` `mcpAddress`), and refuses both
 * on Commissary Cloud, whose MCP clients use the API host's endpoint.
 */
import { Layer } from "effect";
import { MCP_PATH } from "@commissary/core";
import { mcpRoutesAt } from "@commissary/tools/management";
import { MCP_ORG_ROUTE } from "../management/zones.ts";

export const AppMcpRoutes = Layer.mergeAll(mcpRoutesAt(MCP_PATH), mcpRoutesAt(MCP_ORG_ROUTE));
