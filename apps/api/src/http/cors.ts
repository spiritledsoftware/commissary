// Port of corsMiddleware (internal/api/server_middleware.go:25-143).
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

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
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

      return HttpServerResponse.setHeaders(response, corsHeaders);
    }),
  { global: true },
);
