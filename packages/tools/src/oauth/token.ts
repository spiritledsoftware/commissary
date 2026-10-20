/**
 * Token and registration requests of a toolkit's OAuth 2 sign-in (#202): the authorization code exchange (with the PKCE
 * verifier and the RFC 8707 `resource`), refreshes, the client credentials grant, and dynamic client registration (RFC
 * 7591). A client authenticates as the registration or the toolkit's OAuth app says: `client_secret_basic` (RFC 6749
 * §2.3.1, the id and secret form-encoded first), `client_secret_post`, or `none` (a public client: PKCE alone).
 *
 * A token endpoint that refuses a request with an OAuth error (`400`/`401` with `error`) refuses it for good
 * (`rejected`, with the `code`); a failure to reach it, a `5xx` or a `429` may pass (`unreachable`, `http`).
 */
import { Effect, Option, Schema } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";
import { type Answer, invalidAnswer, OAuthError, send } from "./http.ts";

/** How a client authenticates at the token endpoint. */
export type ClientAuth = "none" | "client_secret_basic" | "client_secret_post";

/** A client as a token request presents it. */
export interface TokenClient {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly auth: ClientAuth;
}

/** The tokens a token endpoint issued. */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  /** Epoch ms; undefined when the endpoint said nothing (`expires_in`). */
  readonly expiresAt: number | undefined;
  readonly scope: string | undefined;
  /** What an RFC 8693 token exchange says it issued (§2.2.1). */
  readonly issuedTokenType?: string | undefined;
}

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.NumberFromString])),
  refresh_token: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  /** What an RFC 8693 token exchange issued (§2.2.1). */
  issued_token_type: Schema.optionalKey(Schema.String),
});

/**
 * An OAuth error answer (RFC 6749 §5.2) whose `error` is a plain code: anything else is the server's to word, and is
 * never put into a message or a log.
 */
const ErrorResponse = Schema.Struct({
  error: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,64}$/)),
});

const decodeToken = Schema.decodeUnknownOption(TokenResponse);

const decodeError = Schema.decodeUnknownOption(ErrorResponse);

/** `application/x-www-form-urlencoded` encoding of one value (RFC 6749 Appendix B). */
const formEncode = (value: string): string => encodeURIComponent(value).replace(/%20/g, "+");

/** The `Authorization` header of HTTP Basic client authentication, each part form-encoded (RFC 6749 §2.3.1). */
export const basicAuthorization = (clientId: string, secret: string): string =>
  `Basic ${btoa(`${formEncode(clientId)}:${formEncode(secret)}`)}`;

/** `params` with the client's authentication, as the request carries it. */
const authenticated = (
  request: HttpClientRequest.HttpClientRequest,
  client: TokenClient,
  params: Readonly<Record<string, string>>,
): HttpClientRequest.HttpClientRequest => {
  const secret = client.clientSecret ?? "";

  if (client.auth === "client_secret_basic" && secret !== "")
    return request.pipe(
      HttpClientRequest.setHeader("authorization", basicAuthorization(client.clientId, secret)),
      HttpClientRequest.bodyUrlParams(params),
    );

  return HttpClientRequest.bodyUrlParams(request, {
    ...params,
    client_id: client.clientId,
    ...(client.auth === "client_secret_post" && secret !== "" ? { client_secret: secret } : {}),
  });
};

/** One request to the token endpoint of `client`: the tokens it issued, or why not. */
export const requestToken = (
  client: TokenClient,
  params: Readonly<Record<string, string>>,
  now: number,
): Effect.Effect<TokenSet, OAuthError, HttpClient.HttpClient> =>
  Effect.flatMap(
    send(
      authenticated(
        HttpClientRequest.post(client.tokenEndpoint).pipe(HttpClientRequest.acceptJson),
        client,
        params,
      ),
      "token_endpoint",
    ),
    (answer) => tokenAnswer(answer, now),
  );

/**
 * The tokens a token endpoint's `answer` issued, or why not. `tokenTypes` are the token types taken besides `bearer`
 * (RFC 8693's `N_A`, for a token that is not an OAuth access token but is sent as one).
 */
export const tokenAnswer = Effect.fnUntraced(function* (
  answer: Answer,
  now: number,
  tokenTypes: ReadonlyArray<string> = [],
): Effect.fn.Return<TokenSet, OAuthError> {
  if (answer.status === 400 || answer.status === 401) {
    const refused = Option.getOrUndefined(decodeError(answer.json));

    return yield* new OAuthError({
      reason: "rejected",
      message: `the token endpoint refused the request (${refused?.error ?? `HTTP ${answer.status}`})`,
      status: answer.status,
      ...(refused === undefined ? {} : { code: refused.error }),
    });
  }

  if (answer.status < 200 || answer.status >= 300)
    return yield* new OAuthError({
      reason: "http",
      message: `the token endpoint answered HTTP ${answer.status}`,
      status: answer.status,
    });

  const tokens = Option.getOrUndefined(decodeToken(answer.json));

  if (tokens === undefined)
    return yield* invalidAnswer("the token endpoint issued no access token");

  if (
    tokens.token_type !== undefined &&
    tokens.token_type.toLowerCase() !== "bearer" &&
    !tokenTypes.includes(tokens.token_type)
  )
    return yield* invalidAnswer("the token endpoint issued a token that is not a bearer token");

  return {
    accessToken: tokens.access_token,
    refreshToken:
      tokens.refresh_token === undefined || tokens.refresh_token === ""
        ? undefined
        : tokens.refresh_token,
    expiresAt:
      tokens.expires_in === undefined || tokens.expires_in <= 0
        ? undefined
        : now + tokens.expires_in * 1000,
    scope: tokens.scope,
    issuedTokenType: tokens.issued_token_type,
  };
});

/** Whether a failed token request failed for good: the endpoint refused it, so trying again changes nothing. */
export const refusedForGood = (error: OAuthError): boolean => error.reason === "rejected";

const Registration = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optionalKey(Schema.String),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
});

const decodeRegistration = Schema.decodeUnknownOption(Registration);

/** A client dynamic registration gave (RFC 7591). */
export interface RegisteredClient {
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly auth: ClientAuth;
}

/** The authentication to ask a registration for: a public client where the server allows it, else a secret. */
const wantedAuth = (supported: ReadonlyArray<string> | undefined): ClientAuth => {
  if (supported === undefined || supported.includes("none")) return "none";

  return supported.includes("client_secret_post") && !supported.includes("client_secret_basic")
    ? "client_secret_post"
    : "client_secret_basic";
};

const isClientAuth = Schema.is(
  Schema.Literals(["none", "client_secret_basic", "client_secret_post"]),
);

/** Registers Commissary at `endpoint` for `redirectUri` (RFC 7591). */
export const registerClient = Effect.fnUntraced(function* (
  endpoint: string,
  redirectUri: string,
  supportedAuth: ReadonlyArray<string> | undefined,
): Effect.fn.Return<RegisteredClient, OAuthError, HttpClient.HttpClient> {
  const auth = wantedAuth(supportedAuth);

  const answer = yield* send(
    HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe({
        client_name: "Commissary",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: auth,
      }),
    ),
    "registration_endpoint",
  );

  if (answer.status < 200 || answer.status >= 300)
    return yield* new OAuthError({
      reason: answer.status === 400 ? "rejected" : "http",
      message: `the registration endpoint answered HTTP ${answer.status}`,
      status: answer.status,
    });

  const registered = Option.getOrUndefined(decodeRegistration(answer.json));

  if (registered === undefined)
    return yield* invalidAnswer("the registration endpoint issued no client id");

  const method = registered.token_endpoint_auth_method;
  const secret = registered.client_secret === "" ? undefined : registered.client_secret;

  return {
    clientId: registered.client_id,
    clientSecret: secret,
    auth:
      method !== undefined && isClientAuth(method)
        ? method
        : secret === undefined
          ? "none"
          : "client_secret_basic",
  };
});
