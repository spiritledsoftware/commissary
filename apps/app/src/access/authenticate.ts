/**
 * Authentication of one request of the management zone: `@commissary/auth`'s `authenticateManagement` with what the
 * Worker's routes say of the request: the role the route needs (`management/policy.ts`) and the org its URL addresses
 * (`management/zones.ts`), and of the MCP endpoint a self-hosted Commissary serves on the app host behind Access (ADR
 * 0045). The client API is the API Worker's (apps/api), which calls `authenticateClient` itself. New in the Workers
 * port.
 */
import {
  type AccessError,
  type AccessIdentity,
  type AccessJwks,
  type AuthConfig,
  type AuthDirectory,
  authenticateManagement,
  presentedManagementKey,
  type SignInSessions,
} from "@commissary/auth";
import { type CurrentOrg, ForbiddenError, UnauthorizedError } from "@commissary/core";
import { Effect } from "effect";
import { routeAccess } from "../management/policy.ts";
import { mcpAddress, mcpOrgSlug, scopedUrl } from "../management/zones.ts";

/**
 * Authenticates a management request (`method` decides, with the path, the role it needs). `headers` must expose
 * lowercased header names; `requestUrl` is the full URL as the client sent it.
 */
export const authenticateRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  method = "GET",
): Effect.Effect<
  AccessIdentity,
  AccessError,
  AuthConfig | AuthDirectory | CurrentOrg | AccessJwks | SignInSessions
> =>
  authenticateManagement(headers, requestUrl, {
    needs: routeAccess(method, requestUrl, "management"),
    slug: scopedUrl(requestUrl)?.slug,
  });

/** Why the app host's MCP endpoint refuses a request it cannot authenticate (`401`). */
export const MCP_SIGN_IN = "Sign in through Access";

/**
 * Authenticates a request of the MCP endpoint on the app host (ADR 0045): the person or service token Access signed in
 * (`Cf-Access-Jwt-Assertion`, as for the panel), with any role in the org its address names (`/o/<slug>/mcp`; `/mcp`
 * is `global`). A management key is refused before anything else: it is for scripts on the management API, never for an
 * MCP client, which sends an API key to the API host instead. An address whose org is no slug (`/o/-bad-/mcp`) is
 * refused `403` for everybody, platform admins too, as an org one may not use is.
 */
export const authenticateMcp = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  method: string,
): Effect.Effect<
  AccessIdentity,
  AccessError,
  AuthConfig | AuthDirectory | CurrentOrg | AccessJwks | SignInSessions
> =>
  Effect.gen(function* () {
    if (presentedManagementKey(headers) !== undefined)
      return yield* new UnauthorizedError({ message: MCP_SIGN_IN });

    const address = mcpAddress(requestUrl);
    const org = address === undefined ? "invalid" : mcpOrgSlug(address);

    if (org === "invalid") return yield* new ForbiddenError({ message: "Forbidden" });

    return yield* authenticateManagement(headers, requestUrl, {
      needs: routeAccess(method, requestUrl, "mcp"),
      slug: org.slug,
    });
  });
