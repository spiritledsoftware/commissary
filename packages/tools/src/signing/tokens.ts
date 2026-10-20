/**
 * The access tokens of the credential types Commissary gets by exchange (#206), each minted when a request needs one
 * and none is fresh, and kept (sealed) with the credential until near its expiry:
 *
 * - **A signed JWT**: signed from the credential's key with the toolkit's algorithm and claims (`iss` and `sub` the
 *   credential's, `aud` the settings' or the token endpoint, `iat`, `exp` at most an hour on), exchanged at the token
 *   endpoint with RFC 7523's JWT bearer grant (the JWT naming its issuer; the request its scope, and the client's id and
 *   secret when the credential names them), or, without one, sent as the bearer token itself until it expires.
 * - **A GitHub App**: an app JWT (RS256, `iss` the app id, `iat` a minute back for clock drift, `exp` nine minutes on, as
 *   GitHub asks), exchanged for an installation token (`POST /app/installations/<id>/access_tokens`), which lasts an hour.
 * - **An RFC 8693 token exchange**: the subject token exchanged at the toolkit's endpoint, the client authenticating with
 *   HTTP Basic (RFC 6749 §2.3.1) when the credential names a secret; the answer must say what it issued.
 *
 * Every endpoint passes the outbound guard (the caller's `HttpClient`). A refusal (an OAuth error, GitHub's `401`,
 * `403`, `404` or `422`, a key that cannot sign) is `rejected`, so the credential needs connecting again; anything else
 * may pass. No token or assertion is put into a message.
 */
import { Effect, Option, Schema } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";
import type { CredentialSettings } from "@commissary/contract/tools";
import { guardedUrl, invalidAnswer, OAuthError, send } from "../oauth/http.ts";
import { basicAuthorization, tokenAnswer } from "../oauth/token.ts";
import { JWT_ISSUER, MAX_JWT_LIFETIME_SECONDS } from "../toolkits/credential-settings.ts";
import type { MintedSecret } from "../toolkits/secret.ts";
import { signJwt } from "./jwt.ts";

/** A token minted: the access token and when it expires (epoch ms), if said. */
export interface Minted {
  readonly access_token: string;
  readonly expires_at?: number;
}

/** GitHub's REST API, where a GitHub App's installation tokens come from unless the settings name GitHub Enterprise's. */
const GITHUB_API = "https://api.github.com";

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";

const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

const rejected = (message: string) => new OAuthError({ reason: "rejected", message });

const missingSettings = (type: string) =>
  rejected(`the toolkit has no ${type} settings: set them, then connect the credential again`);

/** `params` without the unset ones. */
const present = (
  params: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

/** A token request to `endpoint` with `params` and `headers`, read as {@link tokenAnswer} reads it. */
const postForm = (
  endpoint: string,
  params: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>>,
  now: number,
  tokenTypes: ReadonlyArray<string> = [],
) =>
  send(
    HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyUrlParams(params),
    ),
    "token_url",
  ).pipe(Effect.flatMap((answer) => tokenAnswer(answer, now, tokenTypes)));

const minted = (accessToken: string, expiresAt: number | undefined): Minted => ({
  access_token: accessToken,
  ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
});

/**
 * A JWT credential's token: the JWT exchanged at the token endpoint (RFC 7523 §2.1: its `scope`, and the client's id
 * and secret in the body when the credential names them), or the JWT itself. An exchanged JWT names its issuer (§3).
 */
export const mintJwt = Effect.fnUntraced(function* (
  secret: MintedSecret<"jwt">,
  settings: CredentialSettings["jwt"],
  now: number,
): Effect.fn.Return<Minted, OAuthError, HttpClient.HttpClient> {
  if (settings === undefined) return yield* missingSettings("JWT");

  const tokenUrl =
    settings.token_url === undefined
      ? undefined
      : yield* guardedUrl(settings.token_url, "token_url");

  if (tokenUrl !== undefined && secret.issuer === undefined) return yield* rejected(JWT_ISSUER);

  const issuedAt = Math.floor(now / 1000);
  const expires = issuedAt + (settings.lifetime_seconds ?? MAX_JWT_LIFETIME_SECONDS);
  const audience = settings.audience ?? tokenUrl;

  const assertion = yield* signJwt(
    settings.algorithm,
    secret.private_key,
    { kid: secret.key_id },
    {
      ...settings.claims,
      ...present({
        iss: secret.issuer,
        sub: secret.subject,
        aud: audience,
        scope: settings.scope,
      }),
      iat: issuedAt,
      exp: expires,
    },
  ).pipe(Effect.mapError((error) => rejected(error.message)));

  if (tokenUrl === undefined) return minted(assertion, expires * 1000);

  const tokens = yield* postForm(
    tokenUrl,
    present({
      grant_type: JWT_BEARER,
      assertion,
      scope: settings.scope,
      client_id: secret.client_id,
      client_secret: secret.client_secret,
    }),
    {},
    now,
  );

  return minted(tokens.accessToken, tokens.expiresAt);
});

const InstallationToken = Schema.Struct({
  token: Schema.NonEmptyString,
  expires_at: Schema.optionalKey(Schema.String),
});

const decodeInstallationToken = Schema.decodeUnknownOption(InstallationToken);

/** A GitHub App's installation token. */
export const mintGitHubApp = Effect.fnUntraced(function* (
  secret: MintedSecret<"app">,
  settings: CredentialSettings["app"],
  now: number,
): Effect.fn.Return<Minted, OAuthError, HttpClient.HttpClient> {
  const api = yield* guardedUrl(settings?.api_url ?? GITHUB_API, "api_url");
  const issuedAt = Math.floor(now / 1000);

  const appJwt = yield* signJwt(
    "RS256",
    secret.private_key,
    {},
    { iat: issuedAt - 60, exp: issuedAt + 540, iss: secret.app_id },
  ).pipe(Effect.mapError((error) => rejected(error.message)));

  const answer = yield* send(
    HttpClientRequest.post(
      `${api.replace(/\/+$/, "")}/app/installations/${secret.installation_id}/access_tokens`,
    ).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt}`,
        "user-agent": "commissary",
        "x-github-api-version": "2022-11-28",
      }),
    ),
    "api_url",
  );

  if ([401, 403, 404, 422].includes(answer.status))
    return yield* new OAuthError({
      reason: "rejected",
      message: `GitHub refused the installation token (HTTP ${answer.status})`,
      status: answer.status,
    });

  if (answer.status < 200 || answer.status >= 300)
    return yield* new OAuthError({
      reason: "http",
      message: `GitHub answered HTTP ${answer.status}`,
      status: answer.status,
    });

  const token = Option.getOrUndefined(decodeInstallationToken(answer.json));

  if (token === undefined) return yield* invalidAnswer("GitHub issued no installation token");
  const expiresAt = token.expires_at === undefined ? Number.NaN : Date.parse(token.expires_at);

  return minted(token.token, Number.isFinite(expiresAt) ? expiresAt : undefined);
});

/** An RFC 8693 token exchange's access token. */
export const exchangeToken = Effect.fnUntraced(function* (
  secret: MintedSecret<"token_exchange">,
  settings: CredentialSettings["token_exchange"],
  now: number,
): Effect.fn.Return<Minted, OAuthError, HttpClient.HttpClient> {
  if (settings === undefined) return yield* missingSettings("token exchange");
  const tokenUrl = yield* guardedUrl(settings.token_url, "token_url");
  const clientId = secret.client_id;
  const clientSecret = secret.client_secret;
  const basic = clientId !== undefined && clientSecret !== undefined && clientSecret !== "";

  const answer = yield* postForm(
    tokenUrl,
    present({
      grant_type: TOKEN_EXCHANGE,
      subject_token: secret.subject_token,
      subject_token_type: settings.subject_token_type ?? ACCESS_TOKEN_TYPE,
      requested_token_type: settings.requested_token_type,
      audience: settings.audience,
      resource: settings.resource,
      scope: settings.scope,
      client_id: basic ? undefined : clientId,
    }),
    basic ? { authorization: basicAuthorization(clientId, clientSecret) } : {},
    now,
    // RFC 8693 §2.2.1: a token that is not an OAuth access token says `N_A`; it is sent as the bearer all the same.
    ["N_A"],
  );

  // §2.2.1: an exchange's answer says what it issued.
  if (answer.issuedTokenType === undefined || answer.issuedTokenType === "")
    return yield* invalidAnswer("the token exchange did not say what token it issued");

  return minted(answer.accessToken, answer.expiresAt);
});
