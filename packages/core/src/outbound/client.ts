/**
 * The outbound guard around an `HttpClient` (ADR 0044): every request, and every hop of a redirect, passes
 * {@link checkOutboundUrl} before it is sent. The guard follows redirects itself (`redirect: "manual"` to the
 * transport), at most {@link MAX_OUTBOUND_REDIRECTS} of them, so a public address cannot bounce a fetch onto a
 * refused one. A refusal fails the request with an `HttpClientError` (`InvalidUrlError`) whose cause is the
 * {@link OutboundRefused}: {@link outboundRefusalOf} finds it for the caller's message.
 *
 * Which policy applies is the fiber's {@link CurrentOutboundPolicy}: each Worker provides it per request from its
 * bindings and the request's URL ({@link outboundPolicy}); without one, the strictest applies (no loopback, no own
 * hosts known).
 */
import { Context, Effect, Layer, Option, Predicate, Result, Stream } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
  Url,
} from "effect/http";
import {
  checkOutboundUrl,
  isLoopbackHost,
  OutboundRefused,
  outboundRefused,
  type OutboundPolicy,
} from "./check.ts";

/** Redirects the guard follows for one request; one more is refused (`too_many_redirects`). */
export const MAX_OUTBOUND_REDIRECTS = 5;

/** The outbound policy of the current request; by default no loopback and no own hosts. */
export const CurrentOutboundPolicy = Context.Reference<OutboundPolicy>(
  "@commissary/core/CurrentOutboundPolicy",
  { defaultValue: () => ({ ownHosts: [], localDevelopment: false }) },
);

/** A workers.dev host (`<worker>.<account>.workers.dev`): its account's subdomain. */
const WORKERS_DEV = /^[^.]+\.([^.]+\.workers\.dev)$/;

const hostOf = (entry: string): string => {
  if (!entry.includes("://")) return entry.toLowerCase();

  try {
    return new URL(entry).hostname;
  } catch {
    return "";
  }
};

/**
 * The outbound policy of a Worker invocation. `hosts` are the deployment's own hosts as the Worker's bindings name
 * them: a host, an origin (`https://auth.example.com`) or a comma separated list (`OWN_HOSTS`). `requestUrl`, the
 * request being served, adds its own host, and every Worker of the account when it is a workers.dev host (a preview's
 * Workers share the account's workers.dev subdomain). A request to a loopback host means local development
 * (`alchemy dev`), as for the Access dev bypass.
 */
export const outboundPolicy = (options: {
  readonly hosts: ReadonlyArray<string | undefined>;
  readonly requestUrl?: string | undefined;
}): OutboundPolicy => {
  let requestHost = "";

  try {
    requestHost = options.requestUrl === undefined ? "" : new URL(options.requestUrl).hostname;
  } catch {
    requestHost = "";
  }

  const localDevelopment = isLoopbackHost(requestHost);

  const named = options.hosts
    .flatMap((value) => (value ?? "").split(","))
    .map((entry) => hostOf(entry.trim()))
    .filter((host) => host !== "");

  const own = [...named];

  if (requestHost !== "" && !localDevelopment) {
    own.push(requestHost);
    const account = WORKERS_DEV.exec(requestHost)?.[1];

    if (account !== undefined) own.push(`*.${account}`);
  }

  return { ownHosts: [...new Set(own)], localDevelopment };
};

/** The guard's refusal behind an error (an `HttpClientError`, an error caused by one, ...), if any. */
export const outboundRefusalOf = (error: Error | undefined): OutboundRefused | undefined => {
  let current: unknown = error;

  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof OutboundRefused) return current;

    if (current instanceof HttpClientError.HttpClientError) {
      current = current.reason.cause;
      continue;
    }

    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }

  return undefined;
};

const refusedRequest = (request: HttpClientRequest.HttpClientRequest, refused: OutboundRefused) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.InvalidUrlError({
      request,
      cause: refused,
      description: refused.message,
    }),
  });

/** Checks the URL `request` goes to (with its query parameters and hash, as the transport builds it). */
const check = (request: HttpClientRequest.HttpClientRequest, policy: OutboundPolicy) => {
  const url = Url.make(request.url, request.urlParams, Option.getOrUndefined(request.hash));

  const checked = Result.isFailure(url)
    ? Result.fail(outboundRefused("invalid_url"))
    : checkOutboundUrl(url.success, policy);

  return Result.isFailure(checked)
    ? Effect.fail(refusedRequest(request, checked.failure))
    : Effect.void;
};

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * The request a redirect leads to, as `fetch` builds it: a POST answered 301/302, and anything but GET/HEAD answered
 * 303, becomes a bodiless GET; credentials are dropped on a change of origin. `undefined` when it cannot be followed:
 * a 307/308 would have to send a streamed body again.
 */
const redirected = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse,
  location: string,
): HttpClientRequest.HttpClientRequest | undefined => {
  let target: URL;

  try {
    target = new URL(location, response.request.url);
  } catch {
    return undefined;
  }

  let next = request;
  const status = response.status;

  if (
    ((status === 301 || status === 302) && request.method === "POST") ||
    (status === 303 && request.method !== "GET" && request.method !== "HEAD")
  ) {
    next = HttpClientRequest.setBody(HttpClientRequest.setMethod(next, "GET"), HttpBody.empty);
  } else if (Predicate.isTagged(request.body, "Stream")) {
    return undefined;
  }

  if (target.origin !== new URL(response.request.url).origin) {
    next = HttpClientRequest.removeHeader(next, "authorization");
    next = HttpClientRequest.removeHeader(next, "proxy-authorization");
    next = HttpClientRequest.removeHeader(next, "cookie");
  }

  return HttpClientRequest.setUrl(next, target);
};

/**
 * Lets go of a response's body without reading it: opening the stream in a scope and closing the scope cancels its
 * reader, so a hop that never sends its body cannot hold the request.
 */
export const releaseResponseBody = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<void> =>
  Effect.scoped(Effect.asVoid(Stream.toPull(response.stream))).pipe(Effect.ignore);

/**
 * `client` behind the outbound guard. A caller that asked for `redirect: "manual"` (or `"error"`) itself
 * (`FetchHttpClient.RequestInit`) keeps it: only the first hop is checked, and the redirect is the caller's to read.
 */
export const guardHttpClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >(
    (prepared) =>
      Effect.flatMap(prepared, (first) =>
        Effect.gen(function* () {
          const policy = yield* CurrentOutboundPolicy;

          const callerInit = Option.getOrElse(
            yield* Effect.serviceOption(FetchHttpClient.RequestInit),
            (): globalThis.RequestInit => ({}),
          );

          const follows = callerInit.redirect === undefined || callerInit.redirect === "follow";

          // The guard follows redirects itself; a caller's own `"manual"` or `"error"` stays as it asked.
          const init: globalThis.RequestInit = follows
            ? { ...callerInit, redirect: "manual" }
            : callerInit;

          let request = first;

          for (let hop = 0; ; hop += 1) {
            yield* check(request, policy);

            const response = yield* client
              .execute(request)
              .pipe(Effect.provideService(FetchHttpClient.RequestInit, init));

            const location = response.headers["location"];

            if (!follows || !REDIRECTS.has(response.status) || location === undefined)
              return response;

            // A followed or refused hop's body is never read: cancel it so its connection is let go.
            if (hop >= MAX_OUTBOUND_REDIRECTS) {
              yield* releaseResponseBody(response);

              return yield* refusedRequest(
                request,
                outboundRefused("too_many_redirects", new URL(response.request.url).hostname),
              );
            }

            const next = redirected(request, response, location);

            if (next === undefined) return response;

            yield* releaseResponseBody(response);
            request = next;
          }
        }),
      ),
    Effect.succeed,
  );

/** A caller's own `redirect: "manual"`: the guard checks the request and hands any redirect back. */
const MANUAL_REDIRECTS: globalThis.RequestInit = { redirect: "manual" };

/**
 * Executes `request` with `client` (the guard's) following only same-origin redirects, at most
 * {@link MAX_OUTBOUND_REDIRECTS} of them: a redirect to another origin, or one past the limit, is the response. A
 * credential the request carries (in a named header, a cookie, its query) so never reaches another origin. Each hop is
 * its own request, which the guard checks.
 */
export const executeSameOriginRedirects = (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
  Effect.gen(function* () {
    let current = request;

    for (let hop = 0; ; hop += 1) {
      const response = yield* client
        .execute(current)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECTS));

      const location = response.headers["location"];

      if (
        !REDIRECTS.has(response.status) ||
        location === undefined ||
        hop >= MAX_OUTBOUND_REDIRECTS
      )
        return response;

      const next = redirected(current, response, location);

      if (next === undefined || new URL(next.url).origin !== new URL(response.request.url).origin)
        return response;

      yield* releaseResponseBody(response);
      current = next;
    }
  });

/** The `HttpClient` of `inner` behind the outbound guard ({@link guardHttpClient}). */
export const guardedHttpClientLayer = (
  inner: Layer.Layer<HttpClient.HttpClient>,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, guardHttpClient)).pipe(
    Layer.provide(inner),
  );

/** The global `fetch` behind the outbound guard: the transport for every user-supplied URL. */
export const OutboundHttpClientLive: Layer.Layer<HttpClient.HttpClient> = guardedHttpClientLayer(
  FetchHttpClient.layer,
);
