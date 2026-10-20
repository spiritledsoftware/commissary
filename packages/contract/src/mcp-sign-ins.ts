/**
 * Commissary Cloud's consent page for MCP clients (#200; `apps/app/src/hosted/mcp-oauth.ts`): an MCP client that signs
 * in through Commissary's OAuth server sends the member's browser to the panel's `/authorize`, which shows who asks
 * and lets the member pick the tools the client may use. The page starts the sign-in with the query the client sent
 * (`POST /mcp-sign-ins`), then approves it (`POST /mcp-sign-ins/approve`: an API key named after the client, with the
 * chosen tool scope) or denies it (`POST /mcp-sign-ins/deny`); either answer names where the browser goes next, the
 * client's redirect URI. Any member of the org may use them. A self-hosted Commissary has no such routes (404): Access
 * signs its MCP clients in (ADR 0045). Shared with the browser: imports `effect` only.
 *
 * A request the page cannot go on with (an unknown client, a redirect URI it did not register, a sign-in that expired
 * or was opened in another browser) is refused with `422 sign_in_refused` and a `message` to show.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ToolScope } from "./api-keys.ts";
import { managementErrors } from "./errors.ts";

/** Who asks, as the consent page shows it: every string is the client's own, so the page escapes them. */
export const McpSignInClient = Schema.Struct({
  client_id: Schema.String,
  /** Self-asserted, unless `client_domain` is set. */
  client_name: Schema.String,
  /** A client whose id is a URL (a Client ID Metadata Document): its host, which the client controls. */
  client_domain: Schema.optionalKey(Schema.String),
  /** Where the tokens go: the redirect URI's host. */
  redirect_host: Schema.String,
  /** The redirect goes to an app on the member's own computer, whatever its name says. */
  redirect_is_loopback: Schema.Boolean,
});

export type McpSignInClient = typeof McpSignInClient.Type;

/** `POST /mcp-sign-ins`: the query string the client sent to `/authorize` (with its `?`). */
export const BeginMcpSignIn = Schema.Struct({ query: Schema.String });

export type BeginMcpSignIn = typeof BeginMcpSignIn.Type;

/**
 * The start of a sign-in: the consent to ask for (its `handle` approves or denies it, once, for ten minutes, in this
 * browser), or an answer the client hears at once (a request it must fix: the browser goes to `redirect_to`).
 */
export const McpSignInStart = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("consent"),
    handle: Schema.String,
    client: McpSignInClient,
  }),
  Schema.Struct({ kind: Schema.Literal("redirect"), redirect_to: Schema.String }),
]);

export type McpSignInStart = typeof McpSignInStart.Type;

/** `POST /mcp-sign-ins/approve`: the sign-in, and the tools the client may use (`null`: every tool the member may). */
export const ApproveMcpSignIn = Schema.Struct({
  handle: Schema.String,
  tool_scope: Schema.NullOr(ToolScope),
});

export type ApproveMcpSignIn = typeof ApproveMcpSignIn.Type;

/** `POST /mcp-sign-ins/deny`. */
export const DenyMcpSignIn = Schema.Struct({ handle: Schema.String });

export type DenyMcpSignIn = typeof DenyMcpSignIn.Type;

/** Where the browser goes now: the client's redirect URI, with the code (or the refusal) and `state`. */
export const McpSignInEnd = Schema.Struct({ redirect_to: Schema.String });

export type McpSignInEnd = typeof McpSignInEnd.Type;

export class McpSignInsGroup extends HttpApiGroup.make("mcpSignIns").add(
  HttpApiEndpoint.post("begin", "/mcp-sign-ins", {
    payload: BeginMcpSignIn,
    success: McpSignInStart,
    error: managementErrors,
  }),
  /** `403 member_required` for a caller who is not a member of the org (API keys are members'). */
  HttpApiEndpoint.post("approve", "/mcp-sign-ins/approve", {
    payload: ApproveMcpSignIn,
    success: McpSignInEnd,
    error: managementErrors,
  }),
  HttpApiEndpoint.post("deny", "/mcp-sign-ins/deny", {
    payload: DenyMcpSignIn,
    success: McpSignInEnd,
    error: managementErrors,
  }),
) {}
