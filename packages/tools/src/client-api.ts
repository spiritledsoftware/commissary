/**
 * Tools' client API, which the API Worker mounts behind its client gate: the MCP endpoint (#197) and Commissary's CIMD
 * document for toolkits' OAuth sign-ins (#202), which the gate lets through without a key (an authorization server
 * fetches it).
 */
import { Layer } from "effect";
import { McpRoutes } from "./mcp/endpoint.ts";
import { ClientMetadataRoutes } from "./oauth/public-routes.ts";

export const ClientApiLayer = Layer.mergeAll(McpRoutes, ClientMetadataRoutes);
