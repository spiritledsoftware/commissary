/**
 * The Access configuration of a stack as plain data, apart from the Alchemy resources in infra/access.ts that apply it:
 * the client API paths of a stage with one host and the Managed OAuth of its Access application. Kept free of Alchemy
 * so that tests can import it (apps/app/test/infra-access.test.ts).
 */
import type { Settings } from "./settings.ts";
import { CLIENT_API_PREFIXES, MCP_PATH } from "../packages/core/src/http/client-api.ts";

/**
 * The client API paths the zone routes of a stage with one host send to the API Worker (`CLIENT_API_PREFIXES`,
 * packages/core/src/http/client-api.ts). On a self-hosted Commissary every one but the MCP endpoint: its `/mcp` on the
 * app host is the app Worker's, behind Access (ADR 0045), so the API-key endpoint needs an API host there. On
 * Commissary Cloud (`hosted`) the app host serves no `/mcp`, so all of them.
 */
export const zoneRoutedPrefixes = (options: { readonly hosted: boolean }): ReadonlyArray<string> =>
  options.hosted
    ? CLIENT_API_PREFIXES
    : CLIENT_API_PREFIXES.filter((prefix) => prefix !== MCP_PATH);

/**
 * The paths Access lets through on a self-hosted stage with one host: the client API ({@link zoneRoutedPrefixes}),
 * where clients authenticate with API keys the Worker checks itself (ADR 0022). Not `/mcp`, which stays behind Access
 * for the app Worker (ADR 0045). Access matches a path and its sub-paths (`/v1` covers `/v1/models`), not other paths
 * that start with the same letters, so `/v1beta` and `/v1internal`, which the `/v1*` zone route covers, are listed on
 * their own (the order is the one the deployed applications were created with).
 */
export const clientApiBypassPaths = (): readonly [string, ...string[]] => [
  "/v1",
  "/v1beta",
  "/v1internal",
  ...zoneRoutedPrefixes({ hosted: false }).filter((prefix) => prefix !== "/v1"),
];

/** {@link clientApiBypassPaths}, the destinations of the bypass application. */
export const CLIENT_API_PATHS = clientApiBypassPaths();

/**
 * Managed OAuth of the stack's Access application (ADR 0045), `undefined` while `ACCESS_MANAGED_OAUTH` is off: Access
 * acts as the OAuth server of MCP clients that sign in to the app host's `/mcp`, registering them dynamically (DCR) for
 * the redirect URIs `settings` allows, and any client on a loopback address when `loopbackClients` is on. Its grant
 * keeps Access's defaults (15-minute tokens, refreshed after re-checking the policy).
 */
export const managedOAuth = (settings: Pick<Settings, "managedOAuth">) =>
  settings.managedOAuth.enabled
    ? {
        enabled: true,
        dynamicClientRegistration: {
          enabled: true,
          allowedUris: [...settings.managedOAuth.redirectUris],
          allowAnyOnLocalhost: settings.managedOAuth.loopbackClients,
          allowAnyOnLoopback: settings.managedOAuth.loopbackClients,
        },
      }
    : undefined;

/** The Managed OAuth configuration {@link managedOAuth} gives when it is on. */
export type ManagedOAuth = NonNullable<ReturnType<typeof managedOAuth>>;
