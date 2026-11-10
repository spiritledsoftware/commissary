// Port of corsMiddleware and corsAllowHeadersValue (internal/api/server_middleware.go).
import { Effect, Predicate } from "effect";
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import { refusalResponse } from "@commissary/auth";
import { isSystemOnePath } from "@commissary/core";

/** Mirrors `corsExposedResponseHeaders` in internal/api/server_middleware.go. */
export const CORS_EXPOSED_RESPONSE_HEADERS = [
  "X-CPA-TRACE-ID",
  "X-CPA-VERSION",
  "X-CPA-COMMIT",
  "X-CPA-BUILD-DATE",
  "X-CPA-SUPPORT-PLUGIN",
  "X-CPA-HOME-VERSION",
  "X-CPA-HOME-BUILD-DATE",
  "X-SERVER-VERSION",
  "X-SERVER-BUILD-DATE",
  "Location",
  "Retry-After",
  "X-Request-Id",
  "OpenAI-Request-Id",
] as const;

/** Mirrors `corsAllowedRequestHeaders`: Fetch excludes `Authorization` from the `*` wildcard, so it is named. */
export const CORS_ALLOWED_REQUEST_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Api-Key",
  "X-Goog-Api-Key",
  "Anthropic-Version",
  "Anthropic-Beta",
] as const;

/** Go's `http.CanonicalHeaderKey` for plain tokens: `x-api-KEY` -> `X-Api-Key`. */
const canonicalHeaderName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/(^|-)([a-z])/g, (_, dash: string, letter: string) => dash + letter.toUpperCase());

/**
 * Mirrors `corsAllowHeadersValue`: the known API headers, then (on preflight) the headers the client asked about,
 * de-duplicated case-insensitively, so no allowed header depends on the wildcard.
 */
const allowHeadersValue = (request: HttpServerRequest.HttpServerRequest): string => {
  const requested =
    request.method === "OPTIONS"
      ? (request.headers["access-control-request-headers"] ?? "").split(",")
      : [];

  const names = [...CORS_ALLOWED_REQUEST_HEADERS, ...requested].flatMap((name) => {
    const canonical = canonicalHeaderName(name);

    return canonical === "" ? [] : [canonical];
  });

  return [...new Set(names)].join(", ");
};

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-expose-headers": CORS_EXPOSED_RESPONSE_HEADERS.join(", "),
} as const;

/**
 * Gin answers unknown routes with a plain-text 404; on the System One path (a method other than `POST`) the 404 is
 * TypeSafe-shaped like every other answer there (ADR 0032).
 */
const notFound = (requestUrl: string): HttpServerResponse.HttpServerResponse =>
  isSystemOnePath(requestUrl)
    ? refusalResponse(404, "Not Found", "systemone")
    : HttpServerResponse.text("404 page not found", { status: 404 });

/**
 * Global middleware of the client API: every response (including 404s) carries the CORS headers, and `OPTIONS`
 * requests are answered with an empty 204 before routing. The client API is meant to be called from any origin with an
 * API key; the app Worker, whose management zone must not be readable across origins, answers no CORS (ADR 0030).
 */
export const CorsLayer = HttpRouter.middleware<{ handles: HttpServerError.HttpServerError }>()(
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      const response =
        request.method === "OPTIONS"
          ? HttpServerResponse.empty({ status: 204 })
          : yield* app.pipe(
              Effect.catchTag("HttpServerError", (error) =>
                Predicate.isTagged(error.reason, "RouteNotFound")
                  ? Effect.succeed(notFound(request.originalUrl))
                  : Effect.fail(error),
              ),
            );

      return HttpServerResponse.setHeaders(response, {
        ...corsHeaders,
        "access-control-allow-headers": allowHeadersValue(request),
      });
    }),
  { global: true },
);
