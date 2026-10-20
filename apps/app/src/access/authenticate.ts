/**
 * Authentication of one request of the management zone: `@commissary/auth`'s `authenticateManagement` with what the
 * Worker's routes say of the request: the role the route needs (`management/policy.ts`) and the org its URL addresses
 * (`management/zones.ts`). The client API is the API Worker's (apps/api), which calls `authenticateClient` itself. New
 * in the Workers port.
 */
import {
  type AccessError,
  type AccessIdentity,
  type AccessJwks,
  type AuthConfig,
  type AuthDirectory,
  authenticateManagement,
  type SignInSessions,
} from "@commissary/auth";
import type { CurrentOrg } from "@commissary/core";
import type { Effect } from "effect";
import { routeAccess } from "../management/policy.ts";
import { scopedUrl } from "../management/zones.ts";

/**
 * Authenticates a request of the management zone, or of the MCP endpoint a self-hosted Commissary serves behind Access
 * (`zone` "mcp", ADR 0045; any role in the org, like the client API). `method` decides, with the path, the role it
 * needs. `headers` must expose lowercased header names; `requestUrl` is the full URL as the client sent it.
 */
export const authenticateRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  method = "GET",
  zone: "management" | "mcp" = "management",
): Effect.Effect<
  AccessIdentity,
  AccessError,
  AuthConfig | AuthDirectory | CurrentOrg | AccessJwks | SignInSessions
> =>
  authenticateManagement(headers, requestUrl, {
    needs: routeAccess(method, requestUrl, zone),
    slug: scopedUrl(requestUrl)?.slug,
  });
