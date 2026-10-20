/**
 * The steps of a toolkit's OAuth 2 sign-ins (#202) that talk to the outside, apart from where their state is kept (the
 * Tools part, `control-plane-part.ts`):
 *
 * - {@link prepareSignIn} picks the client of an authorization code sign-in: the toolkit's own OAuth app when it has
 *   one, else Commissary as the MCP server's client, registered through its CIMD document where the authorization
 *   server takes one, else through dynamic client registration (kept per toolkit, and made again when the issuer or the
 *   redirect URI changed; a new one rides in the flow until its sign-in completes), in the MCP spec's order
 *   (pre-registered, CIMD, DCR);
 * - {@link authorizationUrl} builds the URL the browser opens (PKCE S256, the RFC 8707 `resource`);
 * - {@link exchangeCode}, {@link refreshTokens} and {@link mintClientCredentials} ask the token endpoint.
 *
 * Every request goes through the caller's `HttpClient` (the outbound guard's, ADR 0044), and every URL the browser is
 * sent to passes the guard's check first.
 */
import { Effect } from "effect";
import type { HttpClient } from "effect/http";
import type { ClientCredentialsSecret, OAuthSecret } from "../toolkits/secret.ts";
import { discover } from "./discovery.ts";
import { guardedUrl, OAuthError } from "./http.ts";
import type { OAuthApp, RegisteredOAuthClient, SignInFlow } from "./store.ts";
import {
  type ClientAuth,
  registerClient,
  requestToken,
  type TokenClient,
  type TokenSet,
} from "./token.ts";
import type { ClientUrls } from "./urls.ts";

/**
 * A sign-in ready to start: its flow without the verifier (with the dynamic registration made for it, if one was), where
 * to send the browser, and what to ask for.
 */
export interface PreparedSignIn {
  readonly flow: Omit<SignInFlow, "verifier" | "subject" | "by">;
  readonly authorizationEndpoint: string;
  readonly scopes: ReadonlyArray<string>;
}

const appAuth = (app: OAuthApp): ClientAuth =>
  app.clientSecret === undefined ? "none" : "client_secret_post";

/** Picks the client of a sign-in to `source` and where its browser goes ({@link prepareSignIn} above). */
export const prepareSignIn = Effect.fnUntraced(function* (input: {
  readonly toolkitId: string;
  readonly source: string;
  readonly app: OAuthApp | undefined;
  readonly registered: RegisteredOAuthClient | undefined;
  readonly urls: ClientUrls;
}): Effect.fn.Return<PreparedSignIn, OAuthError, HttpClient.HttpClient> {
  const { app, urls } = input;

  if (app !== undefined)
    return {
      flow: {
        redirectUri: urls.callback,
        via: "app",
        clientId: app.clientId,
        tokenEndpoint: yield* guardedUrl(app.tokenUrl, "token_url"),
        auth: appAuth(app),
        // The app's issuer when its managers named one: the answer must then name it too.
        issuer: app.issuer,
        issRequired: app.issuer !== undefined,
        resource: undefined,
      },
      authorizationEndpoint: yield* guardedUrl(app.authorizeUrl, "authorize_url"),
      scopes: app.scopes,
    };

  const { resource, scopes, server } = yield* discover(input.source);

  if (!server.s256)
    return yield* new OAuthError({
      reason: "unsupported",
      message: "the authorization server does not offer PKCE with S256",
    });

  const common = {
    redirectUri: urls.callback,
    tokenEndpoint: server.tokenEndpoint,
    issuer: server.issuer,
    issRequired: server.issParameter,
    resource,
  };

  if (server.cimd && urls.clientId !== undefined)
    return {
      flow: { ...common, via: "cimd", clientId: urls.clientId, auth: "none" },
      authorizationEndpoint: server.authorizationEndpoint,
      scopes,
    };

  if (server.registrationEndpoint === undefined)
    return yield* new OAuthError({
      reason: "unsupported",
      message:
        "the authorization server registers no clients Commissary can use: give the toolkit an OAuth app",
    });

  const kept = input.registered;

  // The toolkit's registration where it was made for this issuer and redirect URI; else a new one, which the flow
  // carries until its sign-in completes.
  if (kept !== undefined && kept.issuer === server.issuer && kept.redirectUri === urls.callback)
    return {
      flow: { ...common, via: "dcr", clientId: kept.clientId, auth: kept.auth },
      authorizationEndpoint: server.authorizationEndpoint,
      scopes,
    };

  const registered: RegisteredOAuthClient = {
    toolkitId: input.toolkitId,
    issuer: server.issuer,
    redirectUri: urls.callback,
    ...(yield* registerClient(server.registrationEndpoint, urls.callback, server.authMethods)),
  };

  return {
    flow: {
      ...common,
      via: "dcr",
      clientId: registered.clientId,
      auth: registered.auth,
      registered,
    },
    authorizationEndpoint: server.authorizationEndpoint,
    scopes,
  };
});

/** The URL the browser opens to sign in: the endpoint's own query kept, the request's parameters set. */
export const authorizationUrl = (
  endpoint: string,
  flow: Pick<SignInFlow, "clientId" | "redirectUri" | "resource">,
  state: string,
  challenge: string,
  scopes: ReadonlyArray<string>,
): string => {
  const url = new URL(endpoint);
  const params = url.searchParams;

  params.set("response_type", "code");
  params.set("client_id", flow.clientId);
  params.set("redirect_uri", flow.redirectUri);
  params.set("state", state);
  params.set("code_challenge", challenge);
  params.set("code_challenge_method", "S256");

  if (scopes.length > 0) params.set("scope", scopes.join(" "));

  if (flow.resource !== undefined) params.set("resource", flow.resource);

  return url.toString();
};

/** The client a flow's token requests present, its secret from the store it was registered in. */
export const tokenClient = (
  flow: Pick<SignInFlow, "tokenEndpoint" | "clientId" | "auth">,
  clientSecret: string | undefined,
): TokenClient => ({
  tokenEndpoint: flow.tokenEndpoint,
  clientId: flow.clientId,
  clientSecret,
  auth: flow.auth,
});

/** The authorization code exchange of a sign-in's callback: its tokens, as the credential keeps them. */
export const exchangeCode = Effect.fnUntraced(function* (
  flow: SignInFlow,
  clientSecret: string | undefined,
  code: string,
  now: number,
): Effect.fn.Return<OAuthSecret, OAuthError, HttpClient.HttpClient> {
  const tokens = yield* requestToken(
    tokenClient(flow, clientSecret),
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
      ...(flow.resource === undefined ? {} : { resource: flow.resource }),
    },
    now,
  );

  return {
    ...withTokens(tokens),
    via: flow.via,
    client_id: flow.clientId,
    token_endpoint: flow.tokenEndpoint,
    auth: flow.auth,
    ...(flow.resource === undefined ? {} : { resource: flow.resource }),
  };
});

const withTokens = (tokens: TokenSet) => ({
  kind: "oauth" as const,
  access_token: tokens.accessToken,
  ...(tokens.refreshToken === undefined ? {} : { refresh_token: tokens.refreshToken }),
  ...(tokens.expiresAt === undefined ? {} : { expires_at: tokens.expiresAt }),
  ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
});

/** A refresh of `secret` with its refresh token: the new tokens, the refresh token kept when none is issued. */
export const refreshTokens = Effect.fnUntraced(function* (
  secret: OAuthSecret & { readonly refresh_token: string },
  clientSecret: string | undefined,
  now: number,
): Effect.fn.Return<OAuthSecret, OAuthError, HttpClient.HttpClient> {
  const tokens = yield* requestToken(
    tokenClient(
      { tokenEndpoint: secret.token_endpoint, clientId: secret.client_id, auth: secret.auth },
      clientSecret,
    ),
    {
      grant_type: "refresh_token",
      refresh_token: secret.refresh_token,
      ...(secret.resource === undefined ? {} : { resource: secret.resource }),
    },
    now,
  );

  const { refresh_token: _old, expires_at: _expired, scope: _scope, ...client } = secret;

  return {
    ...client,
    ...withTokens({ ...tokens, refreshToken: tokens.refreshToken ?? secret.refresh_token }),
  };
});

/**
 * A token of a client credentials grant: at its `token_url`, or at the token endpoint of the MCP server's authorization
 * server (RFC 9728, RFC 8414), naming the server's resource (RFC 8707). The client authenticates with HTTP Basic,
 * which every token endpoint must take (RFC 6749 §2.3.1), unless the server's metadata names only `client_secret_post`.
 */
export const mintClientCredentials = Effect.fnUntraced(function* (
  secret: ClientCredentialsSecret,
  source: string,
  now: number,
): Effect.fn.Return<
  ClientCredentialsSecret & { readonly access_token: string },
  OAuthError,
  HttpClient.HttpClient
> {
  let tokenEndpoint = secret.token_url;
  let auth: ClientAuth = "client_secret_basic";
  let resource: string | undefined;

  if (tokenEndpoint === undefined) {
    const discovered = yield* discover(source);
    const methods = discovered.server.authMethods;

    tokenEndpoint = discovered.server.tokenEndpoint;
    resource = discovered.resource;

    if (
      methods !== undefined &&
      !methods.includes("client_secret_basic") &&
      methods.includes("client_secret_post")
    )
      auth = "client_secret_post";
  } else tokenEndpoint = yield* guardedUrl(tokenEndpoint, "token_url");

  const tokens = yield* requestToken(
    { tokenEndpoint, clientId: secret.client_id, clientSecret: secret.client_secret, auth },
    {
      grant_type: "client_credentials",
      ...(secret.scope === undefined || secret.scope === "" ? {} : { scope: secret.scope }),
      ...(resource === undefined ? {} : { resource }),
    },
    now,
  );

  const { access_token: _token, expires_at: _expired, ...grant } = secret;

  return {
    ...grant,
    access_token: tokens.accessToken,
    ...(tokens.expiresAt === undefined ? {} : { expires_at: tokens.expiresAt }),
  };
});
