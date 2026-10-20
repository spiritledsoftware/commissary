/**
 * The HTTP-call path the toolkit kinds that call an HTTP API share (#203: OpenAPI; GraphQL #204 and Discovery #205
 * reuse it): a toolkit's credential applied to a request, the outbound guard (ADR 0044), the upstream's answer shaped
 * into an MCP tool result, and the size caps on documents and answers.
 *
 * - **Credentials** ({@link signRequest}): a source that names security schemes decides where the credential goes (an
 *   API key in a header, the query or a cookie, an HTTP bearer or basic sign-in, an OAuth 2 or OpenID Connect token as
 *   a bearer); one that names none gets the credential as it was connected (a bearer token, a named header or query
 *   parameter, basic auth).
 * - **The outbound guard** ({@link withOutboundGuard}): every request goes through the guard's `HttpClient` with the
 *   caller's policy. A call follows only same-origin redirects itself, so a credential in a named header, a cookie or
 *   the query never reaches another origin; a document fetch carries no credential and lets the guard follow redirects,
 *   checking each hop.
 * - **Answers** ({@link callHttp}): JSON pretty-printed as text, other text as it is, binary described rather than
 *   inlined, an answer above {@link MAX_ANSWER_BYTES} cut with a note saying so, and a `4xx`/`5xx` status an `isError`
 *   result with the status and the body.
 *
 * Error messages never quote a URL (a query parameter may carry a key) nor an upstream's body.
 */
import { Buffer } from "node:buffer";
import { type Duration, Effect, Predicate, Schema, Stream } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import type { HttpMethod } from "effect/http/HttpMethod";
import {
  CurrentOutboundPolicy,
  executeSameOriginRedirects,
  OUTBOUND_REFUSED_MESSAGE,
  OutboundHttpClientLive,
  type OutboundPolicy,
  outboundRefusalOf,
  releaseResponseBody,
} from "@commissary/core";
import type { UpstreamSecret } from "../toolkits/secret.ts";
import { TOOL_CALL_TIMEOUT } from "../mcp/client.ts";
import { JSON_MEDIA_TYPE } from "./shared.ts";

/** The most of an answer a tool result shows; the rest is cut, and the result says so. */
export const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * The largest document a toolkit is built from (an OpenAPI document, fetched or uploaded): Stripe's is several MB. An
 * OpenAPI document in YAML has a lower bound ({@link MAX_YAML_DOCUMENT_BYTES}); docs/ARCHITECTURE.md has the memory
 * each takes.
 */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

const USER_AGENT = "commissary";

export class HttpCallError extends Schema.TaggedError<HttpCallError>()("HttpCallError", {
  /**
   * - `refused`: the outbound guard refused an address;
   * - `unreachable`: the request failed or timed out;
   * - `http`: a document's server answered a status other than 2xx;
   * - `too_large`: a document above {@link MAX_DOCUMENT_BYTES}.
   */
  reason: Schema.Literals(["refused", "unreachable", "http", "too_large"]),
  message: Schema.String,
}) {}

// --- credentials -----------------------------------------------------------------------------------------------------

/** A security scheme a source names, as a call applies a credential to it. */
export type SecurityScheme =
  | { readonly type: "apiKey"; readonly in: "header" | "query" | "cookie"; readonly name: string }
  /** An HTTP authentication scheme, lowercase: `bearer` and `basic` are applied, others never are. */
  | { readonly type: "http"; readonly scheme: string }
  /** A token from an OAuth 2 or OpenID Connect sign-in, sent as a bearer token. */
  | { readonly type: "oauth2" }
  | { readonly type: "openIdConnect" }
  /** A scheme Commissary cannot apply (mutual TLS, an unknown type). */
  | { readonly type: "unsupported" };

/**
 * What a request may sign in with: one of the alternatives, each a set of schemes applied together (an empty one: no
 * sign-in). `undefined`: the source names no security schemes, so the credential is applied as it was connected.
 */
export type Security = ReadonlyArray<ReadonlyArray<SecurityScheme>> | undefined;

/** The one secret value a credential carries (a token or a key), if it carries one. */
const secretValue = (secret: UpstreamSecret): string | undefined => {
  switch (secret.kind) {
    case "bearer":
      return secret.token;
    case "header":
    case "query":
      return secret.value;
    case "none":
    case "basic":
      return undefined;
  }
};

const basicAuthorization = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

/** Where a credential goes on a request. */
type Placement =
  | { readonly in: "header" | "query" | "cookie"; readonly name: string; readonly value: string }
  | { readonly in: "authorization"; readonly value: string };

const bearerTokenScheme = (scheme: SecurityScheme): boolean =>
  scheme.type === "oauth2" ||
  scheme.type === "openIdConnect" ||
  (scheme.type === "http" && scheme.scheme === "bearer");

/**
 * Where `secret` goes for `scheme`, if it fits it. `strict` asks for the kind the scheme names (a bearer token for a
 * bearer scheme, a header key named as the scheme's header, ...); otherwise any token or key fits a scheme that takes
 * one value.
 */
const placementFor = (
  scheme: SecurityScheme,
  secret: UpstreamSecret,
  strict: boolean,
): Placement | undefined => {
  if (scheme.type === "http" && scheme.scheme === "basic")
    return secret.kind === "basic"
      ? { in: "authorization", value: basicAuthorization(secret.username, secret.password) }
      : undefined;

  const value = secretValue(secret);

  if (value === undefined) return undefined;

  if (bearerTokenScheme(scheme))
    return !strict || secret.kind === "bearer"
      ? { in: "authorization", value: `Bearer ${value}` }
      : undefined;

  if (scheme.type !== "apiKey") return undefined;

  const named =
    (secret.kind === "header" && scheme.in === "header") ||
    (secret.kind === "query" && scheme.in === "query");

  return !strict || (named && secret.name.toLowerCase() === scheme.name.toLowerCase())
    ? { in: scheme.in, name: scheme.name, value }
    : undefined;
};

/** The credential as it was connected, for a source that names no scheme it fits. */
const connectedPlacement = (secret: UpstreamSecret): ReadonlyArray<Placement> => {
  switch (secret.kind) {
    case "none":
      return [];
    case "bearer":
      return [{ in: "authorization", value: `Bearer ${secret.token}` }];
    case "header":
      return [{ in: "header", name: secret.name, value: secret.value }];
    case "query":
      return [{ in: "query", name: secret.name, value: secret.value }];
    case "basic":
      return [{ in: "authorization", value: basicAuthorization(secret.username, secret.password) }];
  }
};

/**
 * Where `secret` goes under `security`: the first alternative the credential fits whole, the ones that fit its kind
 * exactly before the ones any token fits; an empty alternative (no sign-in) when it fits none; else the credential as
 * it was connected, as a source with no schemes gets it (a document's schemes are sometimes wrong or incomplete).
 */
const placementsOf = (secret: UpstreamSecret, security: Security): ReadonlyArray<Placement> => {
  if (security === undefined || secret.kind === "none") return connectedPlacement(secret);

  for (const strict of [true, false])
    for (const alternative of security) {
      if (alternative.length === 0) continue;
      const placements = alternative.map((scheme) => placementFor(scheme, secret, strict));

      if (placements.every((placement) => placement !== undefined)) return placements;
    }

  return security.some((alternative) => alternative.length === 0) ? [] : connectedPlacement(secret);
};

/** `request` signed in with `secret` as `security` says (see {@link placementsOf}). */
export const signRequest = (
  request: HttpClientRequest.HttpClientRequest,
  secret: UpstreamSecret,
  security: Security,
): HttpClientRequest.HttpClientRequest => {
  let signed = request;
  const cookies: Array<string> = [];

  for (const placement of placementsOf(secret, security))
    switch (placement.in) {
      case "authorization":
        signed = HttpClientRequest.setHeader(signed, "authorization", placement.value);
        break;
      case "header":
        signed = HttpClientRequest.setHeader(signed, placement.name, placement.value);
        break;
      case "query":
        signed = HttpClientRequest.appendUrlParam(signed, placement.name, placement.value);
        break;
      case "cookie":
        cookies.push(`${placement.name}=${encodeURIComponent(placement.value)}`);
        break;
    }

  if (cookies.length === 0) return signed;
  const existing = signed.headers["cookie"];

  return HttpClientRequest.setHeader(
    signed,
    "cookie",
    [...(existing === undefined || existing === "" ? [] : [existing]), ...cookies].join("; "),
  );
};

// --- the outbound guard ----------------------------------------------------------------------------------------------

/** Runs `effect`'s requests through the outbound guard with `policy` (ADR 0044). */
export const withOutboundGuard =
  (policy: OutboundPolicy) =>
  <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provide(OutboundHttpClientLive),
      Effect.provideService(CurrentOutboundPolicy, policy),
    );

const transportError =
  (what: string) =>
  (error: HttpClientError.HttpClientError): HttpCallError =>
    outboundRefusalOf(error) === undefined
      ? new HttpCallError({ reason: "unreachable", message: `${what} could not be reached` })
      : new HttpCallError({ reason: "refused", message: OUTBOUND_REFUSED_MESSAGE });

const timedOut = (what: string) =>
  Effect.fail(
    new HttpCallError({ reason: "unreachable", message: `${what} did not answer in time` }),
  );

/**
 * Up to `limit` bytes of `response`'s body, and whether there was more (the rest is not read: the stream is cancelled
 * once it passed the limit).
 */
const readBounded = (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
  onError: (error: HttpClientError.HttpClientError) => HttpCallError,
) =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let read = 0;

    yield* response.stream.pipe(
      // An answer without a body (`fetch` gives some no stream at all) is an empty one.
      Stream.catchIf(
        (error) => Predicate.isTagged(error.reason, "EmptyBodyError"),
        () => Stream.empty,
      ),
      Stream.mapError(onError),
      Stream.takeUntil((chunk) => {
        chunks.push(chunk);
        read += chunk.byteLength;

        return read > limit;
      }),
      Stream.runDrain,
    );

    const bytes = Buffer.concat(chunks);

    return { bytes: bytes.subarray(0, limit), cut: bytes.byteLength > limit };
  });

// --- documents -------------------------------------------------------------------------------------------------------

/**
 * The document at `url` as text (a toolkit's source: an OpenAPI document), fetched without a credential within
 * `timeout`, through the guard, which follows redirects and checks each hop; refused above {@link MAX_DOCUMENT_BYTES}.
 */
export const fetchDocument = (
  url: string,
  timeout: Duration.Input,
): Effect.Effect<string, HttpCallError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const onError = transportError("the document");

    const response = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json, application/yaml, text/yaml;q=0.9, */*;q=0.8",
            "user-agent": USER_AGENT,
          }),
        ),
      )
      .pipe(Effect.mapError(onError));

    if (response.status < 200 || response.status >= 300) {
      yield* releaseResponseBody(response);

      return yield* new HttpCallError({
        reason: "http",
        message: `the document's server answered HTTP ${response.status}`,
      });
    }

    const tooLarge = new HttpCallError({
      reason: "too_large",
      message: `the document is larger than ${MAX_DOCUMENT_BYTES} bytes`,
    });

    if (Number(response.headers["content-length"] ?? 0) > MAX_DOCUMENT_BYTES) {
      yield* releaseResponseBody(response);

      return yield* tooLarge;
    }

    const { bytes, cut } = yield* readBounded(response, MAX_DOCUMENT_BYTES, onError);

    if (cut) return yield* tooLarge;

    return new TextDecoder().decode(bytes);
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => timedOut("the document"),
    }),
  );

// --- calls -----------------------------------------------------------------------------------------------------------

/** A request body as a call sends it. */
export type HttpCallBody =
  | { readonly kind: "text"; readonly contentType: string; readonly text: string }
  /** `multipart/form-data`: each field a text value. */
  | { readonly kind: "multipart"; readonly fields: ReadonlyArray<readonly [string, string]> };

/** One HTTP request a tool call makes, before the credential is applied. */
export interface HttpCall {
  readonly method: HttpMethod;
  /** The URL, its own query included. */
  readonly url: string;
  /** Query parameters added to the URL's own, in order. */
  readonly query?: ReadonlyArray<readonly [string, string]>;
  readonly headers?: Readonly<Record<string, string>>;
  /** Cookies, joined into one `Cookie` header with the credential's. */
  readonly cookies?: ReadonlyArray<readonly [string, string]>;
  readonly body?: HttpCallBody | undefined;
}

/** A request for `call`, before signing. */
const requestOf = (call: HttpCall): HttpClientRequest.HttpClientRequest => {
  let request = HttpClientRequest.make(call.method)(new URL(call.url)).pipe(
    HttpClientRequest.setHeaders({
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      "user-agent": USER_AGENT,
      ...call.headers,
    }),
  );

  for (const [name, value] of call.query ?? [])
    request = HttpClientRequest.appendUrlParam(request, name, value);

  if (call.cookies !== undefined && call.cookies.length > 0)
    request = HttpClientRequest.setHeader(
      request,
      "cookie",
      call.cookies.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "),
    );

  const body = call.body;

  if (body === undefined) return request;

  if (body.kind === "text") return HttpClientRequest.bodyText(request, body.text, body.contentType);

  const form = new FormData();

  for (const [name, value] of body.fields) form.append(name, value);

  return HttpClientRequest.bodyFormData(request, form);
};

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const TEXT_TYPE =
  /^(?:text\/[\w.+-]+|application\/(?:[\w.+-]+\+)?(?:xml|yaml|x-yaml|javascript|ecmascript|x-www-form-urlencoded|graphql))$/;

/** The media type of `contentType`, lowercase, without its parameters. */
const mediaType = (contentType: string | undefined): string =>
  (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

/** `bytes` as UTF-8 text, or `undefined` when they are not. */
const utf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
};

/** Text cut to a size, and whether it had to be. */
interface CutText {
  readonly text: string;
  readonly cut: boolean;
}

/** `text` cut to at most `limit` UTF-8 bytes, on a character boundary; whether it was cut. */
const cutText = (text: string, limit: number): CutText => {
  const bytes = Buffer.from(text, "utf8");

  if (bytes.byteLength <= limit) return { text, cut: false };

  // A cut through a character leaves its first bytes, which the lenient decoder turns into one replacement character.
  return {
    text: new TextDecoder().decode(bytes.subarray(0, limit)).replace(/\uFFFD$/, ""),
    cut: true,
  };
};

const cutNote = (total: number | undefined): string =>
  `\n\n[Commissary cut this answer at ${MAX_ANSWER_BYTES} bytes` +
  (total === undefined ? "." : ` of ${total}.`) +
  " Ask for less, for example with a filter or a smaller page, to see the rest.]";

/** What a tool result says of a binary answer, of `size` bytes if known. */
const binaryText = (type: string, size: number | undefined): string =>
  `The answer is binary (${type === "" ? "no content type" : type}` +
  `${size === undefined ? "" : `, ${size} bytes`}); Commissary does not show it.`;

/**
 * The text of an answer's body: JSON pretty-printed, other text as it is, binary described; cut to
 * {@link MAX_ANSWER_BYTES} with a note when longer.
 */
const answerText = (
  bytes: Uint8Array,
  readCut: boolean,
  contentType: string | undefined,
  declaredLength: number | undefined,
): string => {
  const type = mediaType(contentType);
  const total = readCut ? declaredLength : bytes.byteLength;

  const text =
    JSON_MEDIA_TYPE.test(type) || TEXT_TYPE.test(type) || type === "" ? utf8(bytes) : undefined;

  if (text === undefined) return binaryText(type, total);

  let shown = text;

  if (JSON_MEDIA_TYPE.test(type) && !readCut)
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      shown = text;
    }

  const cut = cutText(shown, MAX_ANSWER_BYTES);

  return cut.cut || readCut ? `${cut.text}${cutNote(readCut ? total : undefined)}` : cut.text;
};

/**
 * Where a redirect the call did not follow leads, as a tool result shows it: its origin and path only (its query may
 * carry what the upstream put there for the browser it expected, a token for one).
 */
const redirectTarget = (location: string, from: string): string | undefined => {
  try {
    const target = new URL(location, from);

    return `${target.origin}${target.pathname}`;
  } catch {
    return undefined;
  }
};

/** The MCP tool result of an upstream's answer: its text, `isError` with the status for a `4xx`/`5xx`. */
const toolResultOf = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<Schema.JsonObject, HttpCallError> {
  const status = response.status;
  const failed = status >= 400;

  const bodiless =
    response.request.method === "HEAD" || status === 204 || status === 205 || status === 304;

  const declared = Number(response.headers["content-length"] ?? Number.NaN);
  const declaredLength = Number.isFinite(declared) ? declared : undefined;
  const contentType = response.headers["content-type"];

  let body = "";

  if (bodiless) yield* releaseResponseBody(response);
  else {
    const type = mediaType(contentType);
    const textual = JSON_MEDIA_TYPE.test(type) || TEXT_TYPE.test(type) || type === "";

    // A binary answer is described, not read: its first byte is enough to tell it is not empty.
    const { bytes, cut } = yield* readBounded(
      response,
      textual ? MAX_ANSWER_BYTES : 1,
      transportError("the API"),
    );

    body =
      bytes.byteLength === 0
        ? ""
        : textual
          ? answerText(bytes, cut, contentType, declaredLength)
          : binaryText(type, declaredLength);
  }

  const location = response.headers["location"];

  const target =
    REDIRECTS.has(status) && location !== undefined
      ? redirectTarget(location, response.request.url)
      : undefined;

  const head =
    failed || body === ""
      ? `HTTP ${status}${target === undefined ? "" : `, redirected to ${target}`}`
      : undefined;

  const text =
    head === undefined
      ? body
      : body === ""
        ? `${head}${failed ? "" : ": no content"}`
        : `${head}\n\n${body}`;

  return {
    content: [{ type: "text", text }],
    ...(failed ? { isError: true } : {}),
  };
});

/** An upstream's answer to a call: its MCP tool result and the status it came with. */
export interface HttpAnswer {
  readonly result: Schema.JsonObject;
  readonly status: number;
}

/**
 * Makes `call` signed in with `secret` as `security` says, through the caller's `HttpClient` (the outbound guard's:
 * {@link withOutboundGuard}), within `timeout`, and answers its MCP tool result with the status. Same-origin redirects
 * are followed; one to another origin is the answer, so the credential never goes there. A failure to reach the
 * upstream is an {@link HttpCallError}; any status is a result.
 */
export const callHttp = (
  call: HttpCall,
  secret: UpstreamSecret,
  security: Security,
  timeout: Duration.Input = TOOL_CALL_TIMEOUT,
): Effect.Effect<HttpAnswer, HttpCallError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = signRequest(requestOf(call), secret, security);

    const response = yield* executeSameOriginRedirects(client, request).pipe(
      Effect.mapError(transportError("the API")),
    );

    return { result: yield* toolResultOf(response), status: response.status };
  }).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => timedOut("the API") }));
