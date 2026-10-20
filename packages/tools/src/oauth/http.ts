/**
 * The HTTP of a toolkit's OAuth 2 sign-in (#202): one request to a metadata, registration or token endpoint, through
 * the `HttpClient` the caller provides, which is the outbound guard's (ADR 0044), answered with its status and its JSON
 * object body. Each request is bounded in time ({@link REQUEST_TIMEOUT}) and size ({@link MAX_BODY_BYTES}). Error
 * messages never quote a URL or the server's body: a URL may carry a secret, and a body is the server's to word.
 */
import { Effect, Option, Result, Schema, Stream } from "effect";
import { HttpClient, type HttpClientError, type HttpClientRequest } from "effect/http";
import {
  checkOutboundUrl,
  CurrentOutboundPolicy,
  OUTBOUND_REFUSED_MESSAGE,
  outboundRefusalOf,
} from "@commissary/core";

/** How long one request may take: as long as Claude's clients give discovery, registration and token requests. */
export const REQUEST_TIMEOUT = "10 seconds";

/** The most one answer may hold. */
const MAX_BODY_BYTES = 256 * 1024;

export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", {
  /**
   * - `refused`: the outbound guard refused a URL (`field` names which);
   * - `unreachable`: the request failed or timed out;
   * - `http`: an unexpected status;
   * - `invalid`: an answer that is not what was asked for;
   * - `rejected`: the token or registration endpoint refused the request with an OAuth error (`code`);
   * - `unsupported`: the server offers nothing Commissary can sign in with.
   */
  reason: Schema.Literals(["refused", "unreachable", "http", "invalid", "rejected", "unsupported"]),
  message: Schema.String,
  /** The field whose URL the outbound guard refused (`token_endpoint`, `authorize_url`, ...). */
  field: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Int),
  /** The OAuth error code an endpoint answered (`invalid_grant`). */
  code: Schema.optionalKey(Schema.String),
}) {}

/** The guard's refusal of the URL in `field`. */
export const refusedUrl = (field: string): OAuthError =>
  new OAuthError({ reason: "refused", message: OUTBOUND_REFUSED_MESSAGE, field });

/** `url`, named by `field`, as the outbound guard lets it through (normalised), or the guard's refusal. */
export const guardedUrl = Effect.fnUntraced(function* (url: string, field: string) {
  const checked = checkOutboundUrl(url, yield* CurrentOutboundPolicy);

  return Result.isFailure(checked) ? yield* refusedUrl(field) : checked.success.toString();
});

export const invalidAnswer = (message: string): OAuthError =>
  new OAuthError({ reason: "invalid", message });

/** What one request answered. */
export interface Answer {
  readonly status: number;
  /** The body, when it is a JSON object. */
  readonly json: Schema.JsonObject | undefined;
  /** A header (lowercase name). */
  readonly header: (name: string) => string | undefined;
}

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

const decodeObject = Schema.decodeUnknownOption(JsonObject);

const tooLarge = invalidAnswer("the server's answer is too large");

const transportError =
  (field: string) =>
  (error: HttpClientError.HttpClientError): OAuthError =>
    outboundRefusalOf(error) === undefined
      ? new OAuthError({ reason: "unreachable", message: "the server could not be reached" })
      : refusedUrl(field);

/**
 * Sends `request` (the URL of `field`) and reads its answer. A status is not a failure here: callers decide. A body that
 * is not a JSON object is `json: undefined`.
 */
export const send = (
  request: HttpClientRequest.HttpClientRequest,
  field: string,
): Effect.Effect<Answer, OAuthError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request).pipe(Effect.mapError(transportError(field)));
    let read = 0;

    const text = yield* response.stream.pipe(
      Stream.mapError(transportError(field)),
      Stream.tap((chunk) => {
        read += chunk.byteLength;

        return read > MAX_BODY_BYTES ? Effect.fail(tooLarge) : Effect.void;
      }),
      Stream.decodeText,
      Stream.mkString,
    );

    return {
      status: response.status,
      json: Option.getOrUndefined(decodeObject(text)),
      header: (name: string) => response.headers[name],
    } satisfies Answer;
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new OAuthError({ reason: "unreachable", message: "the server did not answer in time" }),
        ),
    }),
  );
