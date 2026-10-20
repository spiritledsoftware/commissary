/**
 * The secrets a toolkit signs in with: the static ones (#196: none, a bearer token, an API key in a named header or
 * query parameter, basic auth), an OAuth 2 client credentials grant, and an OAuth 2 authorization code sign-in (#202),
 * as {@link StoredSecret} keeps them (sealed). The other types come later (#206). A header must not be one the MCP
 * client sets itself.
 */
import type { ToolkitSecret } from "@commissary/contract/tools";
import type { ClientVia } from "../oauth/store.ts";
import type { ClientAuth } from "../oauth/token.ts";

/** A client credentials grant as stored: the connected secret and the last token it minted, if any. */
export type ClientCredentialsSecret = Extract<ToolkitSecret, { kind: "client_credentials" }> & {
  readonly access_token?: string;
  /** Epoch ms. */
  readonly expires_at?: number;
};

/** An OAuth 2 authorization code sign-in as stored: its tokens and the client they were issued to. */
export interface OAuthSecret {
  readonly kind: "oauth";
  readonly access_token: string;
  readonly refresh_token?: string;
  /** Epoch ms; absent: the token endpoint did not say. */
  readonly expires_at?: number;
  readonly scope?: string;
  readonly via: ClientVia;
  readonly client_id: string;
  readonly token_endpoint: string;
  readonly auth: ClientAuth;
  /** The resource refreshes name (RFC 8707). */
  readonly resource?: string;
}

/** A credential's secret as the store keeps it, sealed. */
export type StoredSecret =
  | Exclude<ToolkitSecret, { kind: "client_credentials" }>
  | ClientCredentialsSecret
  | OAuthSecret;

/** What signs a request in: a static secret, or an OAuth credential's current access token. */
export type UpstreamSecret = Exclude<ToolkitSecret, { kind: "client_credentials" }>;

/** A header name (RFC 9110 `token`). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Headers the MCP client or the transport set: a key cannot replace them. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
  "transfer-encoding",
]);

/** The longest secret value or name kept. */
const MAX_LENGTH = 8192;

const tooLong = (...values: ReadonlyArray<string>): boolean =>
  values.some((value) => value.length > MAX_LENGTH);

/** Why `secret` cannot be stored, if it cannot. */
export const secretRefusal = (secret: ToolkitSecret): string | undefined => {
  switch (secret.kind) {
    case "none":
      return undefined;
    case "bearer":
      if (secret.token.trim() === "") return "a bearer credential needs its token";

      return tooLong(secret.token) ? "the token is too long" : undefined;
    case "header":
      if (!HEADER_NAME.test(secret.name)) return "the header's name is not a valid header name";

      if (RESERVED_HEADERS.has(secret.name.toLowerCase()))
        return `the ${secret.name.toLowerCase()} header cannot carry a key`;

      if (secret.value.trim() === "") return "a header credential needs its value";

      return tooLong(secret.name, secret.value) ? "the header is too long" : undefined;
    case "query":
      if (secret.name.trim() === "") return "a query credential names its parameter";

      if (secret.value.trim() === "") return "a query credential needs its value";

      return tooLong(secret.name, secret.value) ? "the query parameter is too long" : undefined;
    case "basic":
      if (secret.username === "" || secret.username.includes(":"))
        return "basic auth needs a user name without a colon";

      return tooLong(secret.username, secret.password) ? "the credential is too long" : undefined;
    case "client_credentials":
      if (secret.client_id.trim() === "" || secret.client_secret === "")
        return "a client credentials grant needs its client id and secret";

      return tooLong(secret.client_id, secret.client_secret, secret.scope ?? "")
        ? "the credential is too long"
        : undefined;
  }
};
