/**
 * Finding an MCP server's authorization server (#202, the MCP authorization spec's "Authorization Server Discovery"):
 *
 * 1. the protected resource metadata (RFC 9728): from the `resource_metadata` of the `WWW-Authenticate` challenge the
 *    server answers an unauthenticated request with, else at the well-known URIs, the path-inserted one first;
 * 2. its first authorization server's metadata (RFC 8414, or OpenID Connect discovery), at the well-known URIs in the
 *    spec's order, whose `issuer` must be the one the resource named (RFC 8414 §3.3).
 *
 * Every fetch goes through the caller's `HttpClient`, the outbound guard's (ADR 0044), and every endpoint the metadata
 * names passes the guard's check before it is used: the browser is sent to the authorization endpoint, and Commissary
 * posts to the token and registration endpoints. The resource a sign-in names (RFC 8707) is the one the metadata
 * gives, which must be the source's origin and a prefix of its path.
 */
import { Effect, Option, Schema } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";
import { type Answer, guardedUrl, invalidAnswer, OAuthError, send } from "./http.ts";

const ResourceMetadata = Schema.Struct({
  resource: Schema.optionalKey(Schema.String),
  authorization_servers: Schema.Array(Schema.String),
  scopes_supported: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optionalKey(Schema.String),
  code_challenge_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
  client_id_metadata_document_supported: Schema.optionalKey(Schema.Boolean),
  authorization_response_iss_parameter_supported: Schema.optionalKey(Schema.Boolean),
});

const decodeResource = Schema.decodeUnknownOption(ResourceMetadata);

const decodeServer = Schema.decodeUnknownOption(ServerMetadata);

/** An authorization server as a sign-in uses it. */
export interface AuthorizationServer {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string | undefined;
  /** It takes a CIMD document's URL as a `client_id` (`client_id_metadata_document_supported`). */
  readonly cimd: boolean;
  /** It names itself in the authorization response (`iss`, RFC 9207), which must then be there. */
  readonly issParameter: boolean;
  /** The token endpoint's client authentication methods; undefined: not said. */
  readonly authMethods: ReadonlyArray<string> | undefined;
  /** It offers PKCE with S256 (`code_challenge_methods_supported`), which the MCP spec requires a sign-in to check. */
  readonly s256: boolean;
}

/** What discovery found for a source. */
export interface Discovered {
  /** The resource to name in authorization and token requests (RFC 8707). */
  readonly resource: string;
  /** The scopes to ask for: the challenge's, else the resource's `scopes_supported`; may be empty. */
  readonly scopes: ReadonlyArray<string>;
  readonly server: AuthorizationServer;
}

/** The auth-params of a `WWW-Authenticate` header's `Bearer` challenge (RFC 6750 §3), names lowercased. */
export const bearerChallenge = (header: string | undefined): ReadonlyMap<string, string> => {
  const params = new Map<string, string>();

  if (header === undefined) return params;
  const start = header.search(/(^|[\s,])bearer(\s|$)/i);

  if (start < 0) return params;

  const rest = header.slice(start).replace(/^[\s,]*bearer/i, "");
  const param = /\s*,?\s*([A-Za-z0-9_-]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^\s,]+)/y;

  for (;;) {
    const match = param.exec(rest);

    if (match === null) break;
    const value = match[3] === undefined ? (match[2] ?? "") : match[3].replace(/\\(.)/g, "$1");

    params.set((match[1] ?? "").toLowerCase(), value);
  }

  return params;
};

/**
 * The well-known URI `name` at the origin of `url`, with `suffix` (a path that starts with `/`, `/` for none) after it
 * (RFC 8615; RFC 8414 §3.1 and RFC 9728 §3.1 insert the issuer's or the resource's path there).
 */
const wellKnown = (url: URL, name: string, suffix: string): string =>
  `${url.origin}/.well-known/${name}${suffix === "/" ? "" : suffix}`;

/** Where the protected resource metadata of `source` may be: the path-inserted URI, then the root one. */
export const resourceMetadataUrls = (source: string): ReadonlyArray<string> => {
  const url = new URL(source);
  const path = url.pathname.replace(/\/+$/, "");
  const root = wellKnown(url, "oauth-protected-resource", "/");

  return path === "" ? [root] : [wellKnown(url, "oauth-protected-resource", path), root];
};

/** Where the metadata of the authorization server `issuer` may be, in the MCP spec's order. */
export const serverMetadataUrls = (issuer: string): ReadonlyArray<string> => {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");

  return path === ""
    ? [
        wellKnown(url, "oauth-authorization-server", "/"),
        wellKnown(url, "openid-configuration", "/"),
      ]
    : [
        wellKnown(url, "oauth-authorization-server", path),
        wellKnown(url, "openid-configuration", path),
        `${url.origin}${path}/.well-known/openid-configuration`,
      ];
};

/** `url` without a trailing slash on its path, for comparing identifiers. */
const comparable = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);

    parsed.hash = "";

    return parsed.href.replace(/\/$/, "");
  } catch {
    return undefined;
  }
};

/**
 * Whether the resource metadata's `resource` names `source`: the same origin, and a path that is the source's or a
 * prefix of it at a segment boundary (a server's metadata often names its origin).
 */
export const namesSource = (resource: string, source: string): boolean => {
  try {
    const named = new URL(resource);
    const target = new URL(source);

    if (named.origin !== target.origin || named.search !== "") return false;
    const prefix = named.pathname.replace(/\/+$/, "");

    return prefix === "" || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
  } catch {
    return false;
  }
};

const MCP_HEADERS = { accept: "application/json, text/event-stream" };

/** The `WWW-Authenticate` challenge of the MCP server at `source` to a request without a credential, if any. */
const challengeOf = (source: string) =>
  send(
    HttpClientRequest.post(source).pipe(
      HttpClientRequest.setHeaders(MCP_HEADERS),
      HttpClientRequest.bodyJsonUnsafe({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "commissary", version: "1.0.0" },
        },
      }),
    ),
    "source",
  ).pipe(
    Effect.map((answer): ReadonlyMap<string, string> =>
      answer.status === 401 ? bearerChallenge(answer.header("www-authenticate")) : new Map(),
    ),
  );

/** The first of `urls` that answers `200` with what `decode` reads; `undefined` when none does. */
const firstFound = Effect.fnUntraced(function* <A>(
  urls: ReadonlyArray<string>,
  field: string,
  decode: (answer: Answer) => Option.Option<A>,
): Effect.fn.Return<A | undefined, OAuthError, HttpClient.HttpClient> {
  for (const url of urls) {
    const answer = yield* send(
      HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson),
      field,
    );

    if (answer.status === 200) {
      const found = decode(answer);

      if (Option.isSome(found)) return found.value;
    }
  }

  return undefined;
});

/** The metadata of the authorization server `issuer`, its endpoints checked by the outbound guard. */
export const authorizationServer = Effect.fnUntraced(function* (
  issuer: string,
): Effect.fn.Return<AuthorizationServer, OAuthError, HttpClient.HttpClient> {
  const checkedIssuer = yield* guardedUrl(issuer, "authorization_server");

  const metadata = yield* firstFound(
    serverMetadataUrls(checkedIssuer),
    "authorization_server",
    (answer) => decodeServer(answer.json),
  );

  if (metadata === undefined)
    return yield* invalidAnswer("the authorization server's metadata could not be read");

  if (comparable(metadata.issuer) !== comparable(issuer))
    return yield* invalidAnswer("the authorization server's metadata names another issuer");

  return {
    issuer: metadata.issuer,
    authorizationEndpoint: yield* guardedUrl(
      metadata.authorization_endpoint,
      "authorization_endpoint",
    ),
    tokenEndpoint: yield* guardedUrl(metadata.token_endpoint, "token_endpoint"),
    registrationEndpoint:
      metadata.registration_endpoint === undefined
        ? undefined
        : yield* guardedUrl(metadata.registration_endpoint, "registration_endpoint"),
    cimd: metadata.client_id_metadata_document_supported === true,
    issParameter: metadata.authorization_response_iss_parameter_supported === true,
    authMethods: metadata.token_endpoint_auth_methods_supported,
    s256: (metadata.code_challenge_methods_supported ?? []).includes("S256"),
  };
});

/**
 * Discovers the authorization server of the MCP server at `source`: its protected resource metadata, then its first
 * authorization server's metadata.
 */
export const discover = Effect.fnUntraced(function* (
  source: string,
): Effect.fn.Return<Discovered, OAuthError, HttpClient.HttpClient> {
  const challenge = yield* challengeOf(source);
  const named = challenge.get("resource_metadata");
  const urls = named === undefined ? resourceMetadataUrls(source) : [named];

  const resourceMetadata = yield* firstFound(urls, "resource_metadata", (answer) =>
    decodeResource(answer.json),
  );

  const issuer = resourceMetadata?.authorization_servers[0];

  if (resourceMetadata === undefined || issuer === undefined)
    return yield* new OAuthError({
      reason: "unsupported",
      message: "the MCP server names no authorization server (RFC 9728)",
    });

  const resource = resourceMetadata.resource ?? source;

  if (!namesSource(resource, source))
    return yield* invalidAnswer("the MCP server's metadata names another resource");

  const server = yield* authorizationServer(issuer);
  const scope = challenge.get("scope");

  return {
    resource,
    scopes:
      scope === undefined
        ? (resourceMetadata.scopes_supported ?? [])
        : scope.split(" ").filter((entry) => entry !== ""),
    server,
  };
});
