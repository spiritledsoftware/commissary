/**
 * Which paths are the client API (ADR 0030): the API Worker serves them, the app Worker serves everything else, and on
 * a stage with one host zone routes send them to the API Worker (alchemy.run.ts). Mirrors the Go route groups in
 * internal/api/server_routes.go that use AuthMiddleware, without the management API.
 */

/** Commissary's MCP endpoint (Tools, #197): a client API path like the model routes. */
export const MCP_PATH = "/mcp";

/**
 * The `_meta` key of a tool result the MCP endpoint gives an agent run (#227) when a spend limit refused the call: the
 * refusal's text, by which the run ends its turn with that text as the answer (Tools writes it, Agents reads it).
 */
export const SPEND_REFUSAL_META = "commissary.dev/spend_refusal";

/**
 * The `_meta` key of a tool result the MCP endpoint gives when the org's plan refused the call (#241): `{ error:
 * "plan_limit_reached", limit, allowed, retry_after? }` (`retry_after`, in seconds, for a limit that starts over), as
 * the model routes' `plan_limit_reached` body names its limit, so a client can tell a plan limit from a Spend limit.
 */
export const PLAN_LIMIT_META = "commissary.dev/plan_limit";

/**
 * Commissary's Client ID Metadata Document (CIMD) for toolkits' OAuth sign-ins (Tools, #202): the `client_id` an MCP
 * server's authorization server fetches, unauthenticated. A client API path, so it is served where an authorization
 * server reaches it (the API host, or the app host's zone route, outside Access).
 */
export const TOOLKIT_OAUTH_CLIENT_PATH = "/oauth/toolkits/client.json";

/**
 * Where hosted agents' webhook triggers take deliveries (Agents, #231): `/agent-webhooks/<org id>/<trigger id>`, a client
 * API path served on the API host (or the app host's zone route, outside Access), whose requests prove themselves with
 * the trigger's secret instead of an API key. Not `/webhooks`: the app Worker takes Polar's at `/webhooks/polar`.
 */
export const AGENT_WEBHOOK_PREFIX = "/agent-webhooks";

/** The path of the webhook trigger `trigger` of `org` ({@link AGENT_WEBHOOK_PREFIX}). */
export const agentWebhookPath = (org: string, trigger: string): string =>
  `${AGENT_WEBHOOK_PREFIX}/${org}/${trigger}`;

/** Whether a normalised path ({@link normalizedPath}) is under {@link AGENT_WEBHOOK_PREFIX}. */
export const isAgentWebhookPath = (path: string): boolean =>
  path.startsWith(`${AGENT_WEBHOOK_PREFIX}/`);

/**
 * The client API's path prefixes. `/v1` also covers `/v1beta*` and `/v1internal`; `/chat/completions`, `/completions`
 * and `/responses` are the unprefixed aliases of the `/v1` routes (not in Go, see Models' handlers/openai/routes.ts);
 * `/mcp` is the MCP endpoint ({@link MCP_PATH}); the toolkits' CIMD document is {@link TOOLKIT_OAUTH_CLIENT_PATH}; hosted
 * agents' webhook triggers are under {@link AGENT_WEBHOOK_PREFIX}.
 */
export const CLIENT_API_PREFIXES = [
  "/v1",
  "/openai/v1",
  "/backend-api/codex",
  "/chat/completions",
  "/completions",
  "/responses",
  MCP_PATH,
  TOOLKIT_OAUTH_CLIENT_PATH,
  AGENT_WEBHOOK_PREFIX,
] as const;

/**
 * The path of a request URL (absolute or origin-relative), percent-decoded, with duplicate slashes collapsed and
 * lowercased; `undefined` when the URL cannot be parsed.
 */
export const normalizedPath = (requestUrl: string): string | undefined => {
  let path: string;

  try {
    path = new URL(requestUrl, "http://invalid.invalid").pathname;
  } catch {
    return undefined;
  }

  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }

  return path.replace(/\/{2,}/g, "/").toLowerCase();
};

/**
 * Whether a normalised path ({@link normalizedPath}) is on the client API. Matching is deliberately a superset of what
 * the routers match (any path under a prefix), so an unusual spelling of a client API path is never taken for another
 * zone's.
 */
export const isClientApiPath = (path: string): boolean =>
  CLIENT_API_PREFIXES.some((prefix) => path.startsWith(prefix));

/** Whether a request URL is for the MCP endpoint ({@link MCP_PATH}, with or without a trailing slash). */
export const isMcpPath = (requestUrl: string): boolean => {
  const path = normalizedPath(requestUrl);

  return path === MCP_PATH || path === `${MCP_PATH}/`;
};
