/**
 * The API Worker's client gate (ADR 0022, ADR 0030): a client API request must carry a credential
 * `@commissary/auth`'s `authenticateClient` accepts (an API key, or an Access sign-in where the org still accepts them;
 * on Commissary Cloud an API key, under the request-rate ceiling of the org's plan, `@commissary/billing`), after the
 * cross-site checks (`crossSiteRejection`). On success the principal is available to handlers as `AccessPrincipal`, and
 * `CurrentOrg` is the org the API key names. Any new client-facing surface (the MCP endpoint, #197; webhook triggers,
 * #231) must sit behind this gate or call `limitClientRate` itself: the plan's ceiling is applied here and nowhere else.
 * `/healthz` (and nothing else, `http/hosts.ts` refuses every other path first) passes through. Registered after CORS
 * (`cors.ts`), so preflights are answered before authentication and refusals still carry CORS headers. Refusals on
 * the System One endpoint are in TypeSafe's format (ADR 0032), so TypeSafe's SDKs read them. A `401` on the MCP
 * endpoint carries `WWW-Authenticate: Bearer` (the MCP authorization spec; `resource_metadata` is Commissary Cloud's
 * OAuth server's, #200), so an MCP client asks for a key rather than retrying.
 */
import { Effect, Layer, Result } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  accessErrorResponse,
  AccessJwks,
  AccessPrincipal,
  authenticateClient,
  crossSiteRejection,
  PUBLIC_ROUTE_IDENTITY,
  refusalResponse,
} from "@commissary/auth";
import { limitClientRate } from "@commissary/billing/api";
import {
  CurrentOrg,
  isClientApiPath,
  isMcpPath,
  isSystemOnePath,
  normalizedPath,
} from "@commissary/core";
import { CorsLayer } from "./cors.ts";

/** Whether a request URL is open to anyone: any path but the client API (a URL that cannot be parsed is not). */
const isPublic = (requestUrl: string): boolean => {
  const path = normalizedPath(requestUrl);

  return path !== undefined && !isClientApiPath(path);
};

/** Global middleware: authenticates every client API request (see the module comment). */
export const ClientGate = HttpRouter.middleware<{ provides: AccessPrincipal }>()(
  Effect.gen(function* () {
    // Resolved when the layer is built (once per isolate); `AuthConfig` stays a per-request service.
    const jwks = yield* AccessJwks;

    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        if (isPublic(request.originalUrl))
          return yield* Effect.provideService(app, AccessPrincipal, PUBLIC_ROUTE_IDENTITY);

        const dialect = isSystemOnePath(request.originalUrl) ? "systemone" : "flat";

        const rejection = crossSiteRejection(
          request.method,
          request.headers,
          request.originalUrl,
          undefined,
        );

        if (rejection !== undefined)
          return refusalResponse(rejection.status, rejection.message, dialect);

        const authenticated = yield* Effect.result(
          authenticateClient(request.headers, request.originalUrl).pipe(
            Effect.provideService(AccessJwks, jwks),
            // After authentication and standing: only an org's own requests count against its ceiling.
            Effect.tap((identity) => limitClientRate(identity.org)),
          ),
        );

        if (Result.isFailure(authenticated)) {
          const refusal = yield* accessErrorResponse(authenticated.failure, dialect);

          return refusal.status === 401 && isMcpPath(request.originalUrl)
            ? HttpServerResponse.setHeader(refusal, "www-authenticate", "Bearer")
            : refusal;
        }

        return yield* app.pipe(
          Effect.provideService(AccessPrincipal, authenticated.success),
          Effect.provideService(CurrentOrg, authenticated.success.org),
        );
      });
  }),
  { global: true },
);

/**
 * CORS plus the client gate, in that order (global middleware registered first is outermost); `jwks` is replaceable in
 * tests.
 */
export const makeGateLayer = (jwks: Layer.Layer<AccessJwks> = AccessJwks.layerLive) =>
  ClientGate.pipe(Layer.provide(Layer.mergeAll(CorsLayer, jwks)));

/** Builds the `behindGate` helper for a given gate layer (tests pass one with a fake JWKS). */
export const makeBehindGate =
  <PA, PE, PR>(gate: Layer.Layer<PA, PE, PR>) =>
  <A, E, R>(routes: Layer.Layer<A, E, R>) =>
    routes.pipe(Layer.provide(gate));

/** The production gate layer; a singleton so every `behindGate` shares one registration of the middleware. */
export const GateLayer = makeGateLayer();

/** Marks route layers as consumers of `AccessPrincipal`: `behindGate(routes)` discharges that requirement. */
export const behindGate = makeBehindGate(GateLayer);
