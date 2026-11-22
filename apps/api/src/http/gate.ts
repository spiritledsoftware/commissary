/**
 * The API Worker's gate (ADR 0022, ADR 0030), for the client API and the hub API (ADR 0052). A client API request must
 * carry a credential `@commissary/auth`'s `authenticateClient` accepts (an API key, or an Access sign-in where the org still accepts them;
 * on Commissary Cloud an API key, under the request-rate ceiling of the org's plan, `@commissary/billing`), after the
 * cross-site checks (`crossSiteRejection`). On success the principal is available to handlers as `AccessPrincipal`, and
 * `CurrentOrg` is the org the API key names. Any new client-facing surface (the MCP endpoint, #197) must sit behind
 * this gate or call `limitClientRate` itself: the plan's ceiling is applied here, nowhere else. `/healthz` and the MCP
 * endpoint's OAuth metadata (and nothing else, `http/hosts.ts` refuses every other path first) pass through.
 * Registered after CORS (`cors.ts`), so preflights are answered before authentication and refusals still carry CORS
 * headers. Refusals on the System One endpoint are in TypeSafe's format (ADR 0032), so TypeSafe's
 * SDKs read them. A `401` on the MCP endpoint carries `WWW-Authenticate: Bearer` (the MCP authorization spec;
 * `resource_metadata` is Commissary Cloud's OAuth server's, #200), so an MCP client asks for a key rather than
 * retrying; there an MCP client may send an access token of that server instead of an API key, which the gate swaps
 * for the key it stands for (`withMcpAccessToken`), and a `503` answers when that server's store cannot be read.
 *
 * The hub API (`/v0/management*`) is not the client API: its requests are classified apart (`hubGate`) and take a
 * management key only (`authenticateManagementKey`), after the cross-site checks of a management route (JSON bodies
 * only, any foreign `Origin` refused), and on Commissary Cloud count against the same ceiling. The key acts as its
 * issuer (`AccessPrincipal`) in its own org (`CurrentOrg`). The gate is global, so no spelling of a path under the
 * prefix reaches a handler (or the router's 404) without a key.
 */
import { Effect, Layer, Result } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  accessErrorResponse,
  AccessJwks,
  AccessPrincipal,
  authenticateClient,
  authenticateManagementKey,
  type AuthConfig,
  type AuthDirectory,
  crossSiteRejection,
  reauthorizeClient,
  PUBLIC_ROUTE_IDENTITY,
  refusalResponse,
  RequestReauthorizer,
} from "@commissary/auth";
import { limitClientRate } from "@commissary/billing/api";
import { mcpChallenge, withMcpAccessToken } from "@commissary/tools/api";
import {
  CurrentOrg,
  isClientApiPath,
  isHubApiPath,
  isMcpPath,
  isSystemOnePath,
  normalizedPath,
  TOOLKIT_OAUTH_CLIENT_PATH,
} from "@commissary/core";
import { CorsLayer } from "./cors.ts";

/**
 * What a request URL is to the gate: the hub API (ADR 0052); open to anyone (any other path but the client API, and
 * Commissary's CIMD document of toolkits' OAuth sign-ins, #202, which an authorization server fetches without a key);
 * or the client API (a URL that cannot be parsed included).
 */
const classify = (requestUrl: string): "hub" | "public" | "client" => {
  const path = normalizedPath(requestUrl);

  if (path === undefined) return "client";

  if (isHubApiPath(path)) return "hub";

  return !isClientApiPath(path) || path === TOOLKIT_OAUTH_CLIENT_PATH ? "public" : "client";
};

/** The hub API to the cross-site checks: a management route of no panel page that takes JSON bodies only. */
const HUB_TARGET = { panelPage: false, bodyTypes: [] } as const;

/**
 * The hub API's gate (ADR 0052): the cross-site checks of a management route, then a management key (member role) acting
 * as its issuer, under the request-rate ceiling on Commissary Cloud. `app` runs with `AccessPrincipal` and `CurrentOrg`
 * provided, or the refusal is answered.
 */
const hubGate = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const rejection = crossSiteRejection(
      request.method,
      request.headers,
      request.originalUrl,
      HUB_TARGET,
    );

    if (rejection !== undefined) return refusalResponse(rejection.status, rejection.message);

    const authenticated = yield* Effect.result(
      authenticateManagementKey(request.headers, "member").pipe(
        Effect.tap((identity) => limitClientRate(identity.org)),
      ),
    );

    if (Result.isFailure(authenticated)) return yield* accessErrorResponse(authenticated.failure);

    return yield* app.pipe(
      Effect.provideService(AccessPrincipal, authenticated.success),
      Effect.provideService(CurrentOrg, authenticated.success.org),
    );
  });

/** Global middleware: gates every client API request (see the module comment). */
export const ClientGate = HttpRouter.middleware<{ provides: AccessPrincipal }>()(
  Effect.gen(function* () {
    // Resolved when the layer is built (once per isolate); `AuthConfig` stays a per-request service.
    const jwks = yield* AccessJwks;

    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const kind = classify(request.originalUrl);

        if (kind === "public")
          return yield* Effect.provideService(app, AccessPrincipal, PUBLIC_ROUTE_IDENTITY);

        if (kind === "hub") return yield* hubGate(request, app);

        const dialect = isSystemOnePath(request.originalUrl) ? "systemone" : "flat";

        const rejection = crossSiteRejection(
          request.method,
          request.headers,
          request.originalUrl,
          undefined,
        );

        if (rejection !== undefined)
          return refusalResponse(rejection.status, rejection.message, dialect);

        // On Commissary Cloud an MCP client may send an access token of its OAuth server for the API key it stands for.
        // A store that cannot be read is not a refusal: the client retries rather than signing in again.
        const swapped = yield* Effect.result(
          withMcpAccessToken(request.headers, request.originalUrl),
        );

        if (Result.isFailure(swapped))
          return yield* Effect.logError(
            `MCP access token lookup failed: ${swapped.failure.message}`,
          ).pipe(
            Effect.as(
              HttpServerResponse.setHeader(
                refusalResponse(503, "Authentication service unavailable", dialect),
                "retry-after",
                "5",
              ),
            ),
          );

        const headers = swapped.success;
        const ambient = yield* Effect.context<AuthConfig | AuthDirectory | CurrentOrg>();

        const withJwks = Effect.provideService(AccessJwks, jwks);

        const authenticated = yield* Effect.result(
          authenticateClient(headers, request.originalUrl).pipe(
            withJwks,
            // After authentication and standing: only an org's own requests count against its ceiling.
            Effect.tap((identity) => limitClientRate(identity.org)),
          ),
        );

        if (Result.isFailure(authenticated)) {
          const refusal = yield* accessErrorResponse(authenticated.failure, dialect);

          return refusal.status === 401 && isMcpPath(request.originalUrl)
            ? HttpServerResponse.setHeader(refusal, "www-authenticate", yield* mcpChallenge)
            : refusal;
        }

        // A request that outlives its authentication (a Responses WebSocket) authenticates again per turn, but not
        // against the ceiling: the upgrade was counted. An Access sign-in is re-checked for membership only, since its
        // token expires while the person stays valid (`reauthorizeClient`).
        const reauthorize = reauthorizeClient(
          headers,
          request.originalUrl,
          authenticated.success,
        ).pipe(withJwks, Effect.provideContext(ambient));

        return yield* app.pipe(
          Effect.provideService(AccessPrincipal, authenticated.success),
          Effect.provideService(RequestReauthorizer, reauthorize),
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
