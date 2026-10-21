/**
 * The secrets a toolkit signs in with: the static ones (#196: none, a bearer token, an API key in a named header or
 * query parameter, basic auth), an OAuth 2 client credentials grant, an OAuth 2 authorization code sign-in (#202), and
 * the other credential types (#206: OAuth 1.0a and NetSuite TBA, a signed JWT, a GitHub App, an RFC 8693 token
 * exchange, AWS SigV4 keys and compound secrets), as {@link StoredSecret} keeps them (sealed), and what signs a request
 * in ({@link UpstreamSecret}). A header must not be one the MCP client sets itself.
 */
import type { ToolkitSecret } from "@commissary/contract/tools";
import type { ClientVia } from "../oauth/store.ts";
import type { ClientAuth } from "../oauth/token.ts";
import type { OAuth1Keys } from "../signing/oauth1.ts";
import type { SigV4Keys } from "../signing/sigv4.ts";

const MINTED_KINDS = ["client_credentials", "jwt", "app", "token_exchange"] as const;

/** The connected types whose access token Commissary gets by exchange, and caches until near its expiry. */
export type MintedKind = (typeof MINTED_KINDS)[number];

const MINTED: ReadonlySet<string> = new Set(MINTED_KINDS);

/** Whether a credential of `kind` gets its access token by exchange. */
export const isMintedKind = (kind: string): kind is MintedKind => MINTED.has(kind);

/** A connected secret whose token Commissary mints, as stored: the secret and the last token it got, if any. */
export type MintedSecret<K extends MintedKind = MintedKind> = K extends MintedKind
  ? Extract<ToolkitSecret, { kind: K }> & {
      readonly access_token?: string;
      /** Epoch ms; absent: the token endpoint did not say. */
      readonly expires_at?: number;
      /** What the toolkit's settings were when the token was minted (`mintedWith`): other settings, a new token. */
      readonly minted_with?: string;
    }
  : never;

/** Whether `secret` is one whose token Commissary mints. */
export const isMinted = (secret: StoredSecret): secret is MintedSecret => isMintedKind(secret.kind);

/** A client credentials grant as stored: the connected secret and the last token it minted, if any. */
export type ClientCredentialsSecret = MintedSecret<"client_credentials">;

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

/** A secret that signs a request as it is (or as the toolkit's settings say), with nothing to mint. */
export type ConnectedSecret = Exclude<ToolkitSecret, { kind: MintedKind }>;

/** A credential's secret as the store keeps it, sealed. */
export type StoredSecret = ConnectedSecret | MintedSecret | OAuthSecret;

/** The static secrets: placed on a request as they are, or where a source's security schemes say. */
export type StaticSecret = Extract<
  ToolkitSecret,
  { kind: "none" | "bearer" | "header" | "query" | "basic" }
>;

/**
 * What signs a request in: a static secret (an OAuth credential's or a minted current access token as a `bearer` one),
 * an OAuth 1.0a or AWS SigV4 signer (each request signed when it is sent), or a compound credential's fields as the
 * toolkit's template places them.
 */
export type UpstreamSecret =
  | StaticSecret
  | { readonly kind: "oauth1"; readonly keys: OAuth1Keys }
  | { readonly kind: "aws_sigv4"; readonly keys: SigV4Keys; readonly sessionToken?: string }
  | {
      readonly kind: "compound";
      readonly headers: ReadonlyArray<readonly [string, string]>;
      readonly query: ReadonlyArray<readonly [string, string]>;
      /** The base URL an OpenAPI toolkit's calls go to, in place of its own. */
      readonly baseUrl?: string;
    };

/** The upstream secrets that sign each request as it is sent (`signing/sign.ts`), not once. */
export type SigningSecret = Extract<UpstreamSecret, { kind: "oauth1" | "aws_sigv4" }>;

const SIGNING_KINDS: ReadonlySet<UpstreamSecret["kind"]> = new Set(["oauth1", "aws_sigv4"]);

/** Whether `secret` signs each request as it is sent. */
export const signsEachRequest = (secret: UpstreamSecret): secret is SigningSecret =>
  SIGNING_KINDS.has(secret.kind);

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

/** Why a header named `name` cannot carry a key, if it cannot. */
export const headerNameRefusal = (name: string): string | undefined => {
  if (!HEADER_NAME.test(name)) return "the header's name is not a valid header name";

  return RESERVED_HEADERS.has(name.toLowerCase())
    ? `the ${name.toLowerCase()} header cannot carry a key`
    : undefined;
};

/** The longest secret value or name kept. */
const MAX_LENGTH = 8192;

/** The most fields a compound credential holds. */
const MAX_FIELDS = 20;

/** A compound credential's field name, as a template names it (`{account_id}`). */
const FIELD_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Whether any of `values` is longer than `max`. */
export const longerThan = (max: number, ...values: ReadonlyArray<string | undefined>): boolean =>
  values.some((value) => value !== undefined && value.length > max);

const tooLong = (...values: ReadonlyArray<string | undefined>): boolean =>
  longerThan(MAX_LENGTH, ...values);

const blank = (...values: ReadonlyArray<string>): boolean =>
  values.some((value) => value.trim() === "");

/** Why `secret` cannot be stored, if it cannot (what its toolkit's settings require is checked apart). */
export const secretRefusal = (secret: ToolkitSecret): string | undefined => {
  switch (secret.kind) {
    case "none":
      return undefined;
    case "bearer":
      if (secret.token.trim() === "") return "a bearer credential needs its token";

      return tooLong(secret.token) ? "the token is too long" : undefined;
    case "header": {
      const refused = headerNameRefusal(secret.name);

      if (refused !== undefined) return refused;

      if (secret.value.trim() === "") return "a header credential needs its value";

      return tooLong(secret.name, secret.value) ? "the header is too long" : undefined;
    }

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

      return tooLong(secret.client_id, secret.client_secret, secret.scope)
        ? "the credential is too long"
        : undefined;
    case "oauth1":
      if (blank(secret.consumer_key, secret.consumer_secret, secret.token, secret.token_secret))
        return "an OAuth 1.0a credential needs its consumer key and secret and its token and secret";

      return tooLong(secret.consumer_key, secret.consumer_secret, secret.token, secret.token_secret)
        ? "the credential is too long"
        : undefined;
    case "tba":
      if (blank(secret.consumer_key, secret.consumer_secret, secret.token_id, secret.token_secret))
        return "token-based auth needs its consumer key and secret and its token id and secret";

      return tooLong(
        secret.consumer_key,
        secret.consumer_secret,
        secret.token_id,
        secret.token_secret,
      )
        ? "the credential is too long"
        : undefined;
    case "jwt":
      if (blank(secret.private_key)) return "a JWT credential needs its key";

      if (secret.client_secret !== undefined && blank(secret.client_id ?? ""))
        return "a JWT credential's client secret goes with its client id";

      return tooLong(
        secret.private_key,
        secret.key_id,
        secret.issuer,
        secret.sub,
        secret.client_id,
        secret.client_secret,
      )
        ? "the credential is too long"
        : undefined;
    case "app":
      if (blank(secret.app_id, secret.private_key))
        return "a GitHub App credential needs its app id and private key";

      // It goes into the token request's path.
      if (!/^[0-9]{1,20}$/.test(secret.installation_id))
        return "a GitHub App credential names its installation by its numeric id";

      return tooLong(secret.app_id, secret.private_key) ? "the credential is too long" : undefined;
    case "token_exchange":
      if (blank(secret.subject_token)) return "a token exchange needs its subject token";

      if (secret.client_secret !== undefined && blank(secret.client_id ?? ""))
        return "a token exchange's client secret goes with its client id";

      return tooLong(secret.subject_token, secret.client_id, secret.client_secret)
        ? "the credential is too long"
        : undefined;
    case "aws_sigv4":
      if (blank(secret.access_key_id, secret.secret_access_key))
        return "AWS keys need the access key id and the secret access key";

      return tooLong(secret.access_key_id, secret.secret_access_key, secret.session_token)
        ? "the credential is too long"
        : undefined;
    case "compound": {
      const fields = Object.entries(secret.fields);

      if (fields.length === 0) return "a compound credential holds at least one field";

      if (fields.length > MAX_FIELDS)
        return `a compound credential holds at most ${MAX_FIELDS} fields`;

      if (fields.some(([name]) => !FIELD_NAME.test(name)))
        return "a compound credential's field names are letters, digits, `_`, `.` and `-`";

      return tooLong(...fields.map(([, value]) => value)) ? "a field is too long" : undefined;
    }
  }
};
