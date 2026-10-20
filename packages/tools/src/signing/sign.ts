/**
 * Requests signed one by one (#206): an OAuth 1.0a (and NetSuite TBA) or AWS SigV4 credential signs each request when
 * it is sent, over its method, its URL as sent (its query parameters included), and an OAuth 1.0a form body's
 * parameters or SigV4's payload hash (a multipart body encoded here to hash it). {@link signingClient} wraps the client a call or a listing sends through, so each
 * hop of a same-origin redirect is signed anew for its own URL; the time is the `Clock`'s.
 */
import { randomBytes } from "node:crypto";
import { Clock, Effect, Predicate } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { type SigningSecret, signsEachRequest, type UpstreamSecret } from "../toolkits/secret.ts";
import { sha256Hex } from "./encoding.ts";
import { type OAuth1Keys, oauth1Authorization } from "./oauth1.ts";
import { amzDateOf, sigV4Authorization, sigV4Url } from "./sigv4.ts";

/** The URL `request` is sent to: its URL with its query parameters, as the client builds it. */
const requestUrl = (request: HttpClientRequest.HttpClientRequest): string => {
  const url = new URL(request.url);

  for (const [name, value] of request.urlParams.params) url.searchParams.append(name, value);

  return url.toString();
};

const FORM = "application/x-www-form-urlencoded";

const encodeError = (
  request: HttpClientRequest.HttpClientRequest,
  description: string,
  cause?: unknown,
) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.EncodeError({ request, description, cause }),
  });

/**
 * `request` with its body as bytes, and those bytes, so SigV4 can hash them: a form body (multipart) is encoded here
 * as the transport would; a raw or streamed body is not (`undefined`: S3 alone takes it unsigned). Toolkits' calls
 * send neither.
 */
const bufferedBody = Effect.fnUntraced(function* (
  request: HttpClientRequest.HttpClientRequest,
): Effect.fn.Return<
  readonly [HttpClientRequest.HttpClientRequest, Uint8Array | undefined],
  HttpClientError.HttpClientError
> {
  const body = request.body;

  if (Predicate.isTagged(body, "Empty")) return [request, new Uint8Array()];

  if (Predicate.isTagged(body, "Uint8Array")) return [request, body.body];

  if (Predicate.isTagged(body, "FormData")) {
    const encoded = new Response(body.formData);

    const bytes = yield* Effect.tryPromise({
      try: async () => new Uint8Array(await encoded.arrayBuffer()),
      catch: (cause) =>
        encodeError(request, "the form body could not be encoded to sign it", cause),
    });

    const contentType = encoded.headers.get("content-type") ?? "multipart/form-data";

    return [HttpClientRequest.bodyUint8Array(request, bytes, contentType), bytes];
  }

  return [request, undefined];
});

/** `request` signed with OAuth 1.0a `keys` at `now`. */
const oauth1Signed = (
  request: HttpClientRequest.HttpClientRequest,
  keys: OAuth1Keys,
  now: number,
): HttpClientRequest.HttpClientRequest => {
  const body = request.body;

  const form =
    Predicate.isTagged(body, "Uint8Array") && body.contentType.split(";")[0]?.trim() === FORM
      ? [...new URLSearchParams(new TextDecoder().decode(body.body))]
      : [];

  return HttpClientRequest.setHeader(
    request,
    "authorization",
    oauth1Authorization({ method: request.method, url: requestUrl(request), form }, keys, {
      nonce: randomBytes(16).toString("hex"),
      timestamp: Math.floor(now / 1000),
      extra: { oauth_version: "1.0" },
    }),
  );
};

/**
 * `request` signed with AWS keys at `now`: its URL rewritten as SigV4 sends it ({@link sigV4Url}) and its payload
 * hashed (a raw body, whose bytes are not known, only for S3, as `UNSIGNED-PAYLOAD`).
 */
const sigV4Signed = Effect.fnUntraced(function* (
  original: HttpClientRequest.HttpClientRequest,
  secret: Extract<SigningSecret, { kind: "aws_sigv4" }>,
  now: number,
): Effect.fn.Return<HttpClientRequest.HttpClientRequest, HttpClientError.HttpClientError> {
  const url = sigV4Url(requestUrl(original));
  const [request, bytes] = yield* bufferedBody(original);

  if (bytes === undefined && secret.keys.service !== "s3")
    return yield* encodeError(original, "an AWS request's body must be known to sign it");

  const payloadHash = bytes === undefined ? "UNSIGNED-PAYLOAD" : sha256Hex(bytes);
  const amzDate = amzDateOf(now);
  const body = request.body;

  const signed = {
    host: url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    ...(secret.sessionToken === undefined ? {} : { "x-amz-security-token": secret.sessionToken }),
    ...(Predicate.isTagged(body, "Uint8Array") ? { "content-type": body.contentType } : {}),
  };

  const { host: _host, ...sent } = signed;

  // Rebuilt on the empty request: query parameters kept apart would be written again as a form's (`+` a space).
  return HttpClientRequest.empty.pipe(
    HttpClientRequest.setMethod(request.method),
    HttpClientRequest.setUrl(url.toString()),
    HttpClientRequest.setBody(request.body),
    HttpClientRequest.setHeaders(request.headers),
    HttpClientRequest.setHeaders({
      ...sent,
      authorization: sigV4Authorization(
        {
          method: request.method,
          path: url.pathname,
          query: url.search.slice(1),
          headers: signed,
          payloadHash,
        },
        secret.keys,
        amzDate,
      ),
    }),
  );
});

/** `request` signed with an OAuth 1.0a key or AWS keys at `now`. */
export const signedRequest = (
  request: HttpClientRequest.HttpClientRequest,
  secret: SigningSecret,
  now: number,
): Effect.Effect<HttpClientRequest.HttpClientRequest, HttpClientError.HttpClientError> =>
  secret.kind === "oauth1"
    ? Effect.succeed(oauth1Signed(request, secret.keys, now))
    : sigV4Signed(request, secret, now);

/** `client`, its requests signed with `secret` as they are sent ({@link signedRequest}); any other secret's as it is. */
export const signingClient = (
  client: HttpClient.HttpClient,
  secret: UpstreamSecret,
): HttpClient.HttpClient =>
  signsEachRequest(secret)
    ? HttpClient.mapRequestEffect(client, (request) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => signedRequest(request, secret, now)),
      )
    : client;
