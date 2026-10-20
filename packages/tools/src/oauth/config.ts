/**
 * Where Commissary Cloud's OAuth server for MCP clients answers (#200, ADR 0036, ADR 0045): the authorization server on
 * the app host (its issuer), whose consent page is the panel's and uses the panel session (the session cookie is the
 * base domain's, ADR 0031), and the MCP endpoint it issues tokens for (the resource: `/mcp` on the API host, or on the
 * app host of a stage with one host, where zone routes send it to the API Worker). A self-hosted Commissary signs MCP
 * clients in through Access instead (ADR 0045) and serves none of it.
 *
 * It is on only on Commissary Cloud with its three bindings: the KV namespace `@cloudflare/workers-oauth-provider`
 * keeps clients, grants and tokens in (`OAUTH_KV`), the issuer (`MCP_OAUTH_ISSUER`) and the resource
 * (`MCP_OAUTH_RESOURCE`), which `alchemy.run.ts` binds on the `cloud` stage (and under `alchemy dev`), never on a
 * self-hosted one or a preview. Without them every OAuth path answers as unknown and the MCP endpoint takes API keys
 * only, as before.
 */
import { isHosted } from "@commissary/auth";
import { MCP_PATH } from "@commissary/core";
import type { ToolsBindings } from "../env.ts";

/** The authorization endpoint: the panel's consent page (`/authorize`, and `/o/<slug>/authorize` in an org). */
export const AUTHORIZE_PATH = "/authorize";

/** The token endpoint (also revocation, RFC 7009), served by the library. */
export const TOKEN_PATH = "/oauth/token";

/** Dynamic client registration (RFC 7591), the fallback to CIMD. */
export const REGISTER_PATH = "/oauth/register";

/** RFC 8414 authorization server metadata, on the issuer's origin. */
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** The prefix of RFC 9728 protected resource metadata; the resource's path follows it. */
const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

/** Where the MCP endpoint's RFC 9728 metadata is, on the resource's origin. */
export const PROTECTED_RESOURCE_METADATA_PATH = `${PROTECTED_RESOURCE_METADATA_PREFIX}${MCP_PATH}`;

/** The OAuth server of a deployment that has one. */
export interface McpOAuthConfig {
  /** `https://<app host>`: the RFC 8414 issuer. */
  readonly issuer: string;
  /** `https://<API host>/mcp`: the one resource tokens are issued for (RFC 8707). */
  readonly resource: string;
  readonly kv: NonNullable<ToolsBindings["OAUTH_KV"]>;
}

/** An origin or URL without a trailing slash, `undefined` when it is none. */
const canonical = (value: string | undefined): string | undefined => {
  const trimmed = (value ?? "").trim();

  if (trimmed === "" || !URL.canParse(trimmed)) return undefined;
  const url = new URL(trimmed);

  return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname.replace(/\/$/, "")}`;
};

/**
 * The OAuth server of `env`, `undefined` on a self-hosted Commissary, without its bindings, or with a resource that is
 * not the MCP endpoint (`/mcp`).
 */
export const mcpOAuthConfig = (
  env: Pick<
    ToolsBindings,
    "COMMISSARY_MODE" | "OAUTH_KV" | "MCP_OAUTH_ISSUER" | "MCP_OAUTH_RESOURCE"
  >,
): McpOAuthConfig | undefined => {
  const issuer = canonical(env.MCP_OAUTH_ISSUER);
  const resource = canonical(env.MCP_OAUTH_RESOURCE);

  return isHosted(env) &&
    env.OAUTH_KV !== undefined &&
    issuer !== undefined &&
    resource !== undefined &&
    new URL(resource).pathname === MCP_PATH
    ? { issuer, resource, kv: env.OAUTH_KV }
    : undefined;
};

/** Where the resource's RFC 9728 metadata is: the well-known prefix on its origin, then its path. */
export const protectedResourceMetadataUrl = (config: McpOAuthConfig): string => {
  const resource = new URL(config.resource);

  return `${resource.origin}${PROTECTED_RESOURCE_METADATA_PREFIX}${resource.pathname}`;
};

/** Whether `requestUrl` asks for the resource's metadata ({@link protectedResourceMetadataUrl}), on any host. */
export const isProtectedResourceMetadataPath = (
  config: McpOAuthConfig,
  requestUrl: string,
): boolean =>
  URL.canParse(requestUrl) &&
  new URL(requestUrl).pathname === new URL(protectedResourceMetadataUrl(config)).pathname;

/** The MCP endpoint's RFC 9728 metadata: the resource, its authorization server, and that tokens go in a header. */
export const protectedResourceMetadata = (config: McpOAuthConfig) => ({
  resource: config.resource,
  authorization_servers: [config.issuer],
  bearer_methods_supported: ["header"],
  resource_name: "Commissary",
});

/**
 * The `WWW-Authenticate` challenge of a `401` on the MCP endpoint (MCP authorization, RFC 9728 §5.1): where its
 * metadata is, so a client finds the authorization server; a plain `Bearer` without the OAuth server.
 */
export const bearerChallenge = (config: McpOAuthConfig | undefined): string =>
  config === undefined
    ? "Bearer"
    : `Bearer resource_metadata="${protectedResourceMetadataUrl(config)}"`;
