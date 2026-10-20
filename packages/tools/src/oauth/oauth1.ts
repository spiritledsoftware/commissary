/**
 * A toolkit's OAuth 1.0a sign-in (RFC 5849 §2, #206), three-legged, through the same callback as an OAuth 2 sign-in:
 * the toolkit's OAuth app is the consumer (its client id the consumer key, its secret the consumer secret) and names
 * the temporary credential request URL ({@link requestTemporaryCredentials}, whose `oauth_callback` is the callback with
 * the sign-in's `state`, so the callback finds its org and sign-in as an OAuth 2 one does), the resource owner
 * authorization URL the browser opens ({@link authorizeUrl}), and the token request URL that exchanges the verifier the
 * callback brings for the token credentials ({@link requestTokenCredentials}). Each request is signed with the toolkit's
 * signature method (`credential_settings.oauth1`) and goes through the caller's `HttpClient` (the outbound guard's).
 */
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";
import { oauth1Authorization, type OAuth1Keys } from "../signing/oauth1.ts";
import { guardedUrl, OAuthError, send } from "./http.ts";

/** Credentials an OAuth 1.0a server issued: temporary ones, or the token's. */
export interface OAuth1Credentials {
  readonly token: string;
  readonly tokenSecret: string;
}

/** A form-encoded answer's credentials, or why not. */
const credentialsOf = Effect.fnUntraced(function* (
  answer: { readonly status: number; readonly text: string },
  what: string,
  confirmed: boolean,
): Effect.fn.Return<OAuth1Credentials, OAuthError> {
  if (answer.status === 400 || answer.status === 401)
    return yield* new OAuthError({
      reason: "rejected",
      message: `the ${what} endpoint refused the request (HTTP ${answer.status})`,
      status: answer.status,
    });

  if (answer.status < 200 || answer.status >= 300)
    return yield* new OAuthError({
      reason: "http",
      message: `the ${what} endpoint answered HTTP ${answer.status}`,
      status: answer.status,
    });

  const form = new URLSearchParams(answer.text);
  const token = form.get("oauth_token") ?? "";
  const tokenSecret = form.get("oauth_token_secret") ?? "";

  if (token === "" || tokenSecret === "")
    return yield* new OAuthError({
      reason: "invalid",
      message: `the ${what} endpoint issued no credentials`,
    });

  // OAuth 1.0a's servers confirm the callback (RFC 5849 §2.1); one that does not is OAuth 1.0, which Commissary does not
  // speak.
  if (confirmed && form.get("oauth_callback_confirmed") !== "true")
    return yield* new OAuthError({
      reason: "unsupported",
      message: "the service did not confirm the callback: it does not speak OAuth 1.0a",
    });

  return { token, tokenSecret };
});

/** A signed `POST` to `url` (the URL of `field`), with the extra protocol parameters. */
const signedPost = Effect.fnUntraced(function* (
  url: string,
  field: string,
  keys: OAuth1Keys,
  extra: Readonly<Record<string, string>>,
  now: number,
) {
  const endpoint = yield* guardedUrl(url, field);

  const authorization = oauth1Authorization({ method: "POST", url: endpoint }, keys, {
    nonce: randomBytes(16).toString("hex"),
    timestamp: Math.floor(now / 1000),
    extra: { oauth_version: "1.0", ...extra },
  });

  return yield* send(
    HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeaders({ authorization, accept: "application/x-www-form-urlencoded" }),
    ),
    field,
  );
});

/** The temporary credentials of a sign-in whose browser comes back to `callback` (RFC 5849 §2.1). */
export const requestTemporaryCredentials = (
  requestTokenUrl: string,
  consumer: OAuth1Keys,
  callback: string,
  now: number,
): Effect.Effect<OAuth1Credentials, OAuthError, HttpClient.HttpClient> =>
  signedPost(
    requestTokenUrl,
    "request_token_url",
    consumer,
    { oauth_callback: callback },
    now,
  ).pipe(Effect.flatMap((answer) => credentialsOf(answer, "temporary credential", true)));

/** The URL the browser opens to authorize the temporary credentials (RFC 5849 §2.2), the endpoint's query kept. */
export const authorizeUrl = Effect.fnUntraced(function* (endpoint: string, token: string) {
  const url = new URL(yield* guardedUrl(endpoint, "authorize_url"));

  url.searchParams.set("oauth_token", token);

  return url.toString();
});

/** The token credentials the temporary ones and the callback's verifier get (RFC 5849 §2.3). */
export const requestTokenCredentials = (
  tokenUrl: string,
  keys: OAuth1Keys,
  verifier: string,
  now: number,
): Effect.Effect<OAuth1Credentials, OAuthError, HttpClient.HttpClient> =>
  signedPost(tokenUrl, "token_url", keys, { oauth_verifier: verifier }, now).pipe(
    Effect.flatMap((answer) => credentialsOf(answer, "token", false)),
  );
