// What a Worker puts in front of Models' client API in its harnesses: `@commissary/auth`'s client gate
// (`authenticateClient`) over a replaceable Access JWKS, which provides the principal and its org to the routes, and a
// public `/healthz` the gate lets through. The Worker's own gate (path zones, CORS, cross-site checks, the management
// zone's roles) is tested with the Worker.
import { Effect, Layer, Match, Result } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  type AccessError,
  type AccessIdentity,
  AccessJwks,
  AccessPrincipal,
  authenticateClient,
  reauthorizeClient,
  type AuthConfig,
  type AuthDirectory,
  RequestReauthorizer,
} from "@commissary/auth";
import { CurrentOrg } from "@commissary/core";

const noPrincipal = (): never => {
  throw new Error("AccessPrincipal is not available on public routes");
};

/** The identity of a public route, which has no caller: reading any field is a defect, like a missing service. */
const PUBLIC_ROUTE_IDENTITY: AccessIdentity = {
  get principal() {
    return noPrincipal();
  },
  get principalId() {
    return noPrincipal();
  },
  get callerScope() {
    return noPrincipal();
  },
  get org() {
    return noPrincipal();
  },
  get platformAdmin() {
    return noPrincipal();
  },
  get role() {
    return noPrincipal();
  },
  get memberId() {
    return noPrincipal();
  },
};

/** A test hook: while set, every re-authorisation of a running request fails with it (a key revoked mid-socket). */
export const reauthorization = { failure: undefined as AccessError | undefined };

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const errorResponse = (status: number, message: string) =>
  HttpServerResponse.text(JSON.stringify({ error: message }), {
    status,
    contentType: JSON_CONTENT_TYPE,
  });

/** The Worker's answers to a failed authentication: the status of the failure, a flat `{"error": …}` body. */
const refused = (error: AccessError): HttpServerResponse.HttpServerResponse =>
  Match.value(error).pipe(
    Match.tag("UnauthorizedError", (denied) => errorResponse(401, denied.message)),
    Match.tag("ForbiddenError", (denied) => errorResponse(403, denied.message)),
    Match.tag("NotFoundError", (missing) => errorResponse(404, missing.message)),
    Match.tag("RateLimitedError", (limited) =>
      HttpServerResponse.setHeader(
        errorResponse(429, limited.message),
        "retry-after",
        String(limited.retryAfterSeconds),
      ),
    ),
    Match.orElse(() => errorResponse(500, "Authentication service error")),
  );

const isPublic = (url: string): boolean =>
  new URL(url, "https://commissary.test").pathname === "/healthz";

/** Global middleware: every request but `/healthz` must carry a credential `authenticateClient` accepts. */
const ClientGate = HttpRouter.middleware<{ provides: AccessPrincipal }>()(
  Effect.gen(function* () {
    const jwks = yield* AccessJwks;

    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        if (isPublic(request.originalUrl))
          return yield* Effect.provideService(app, AccessPrincipal, PUBLIC_ROUTE_IDENTITY);

        const ambient = yield* Effect.context<AuthConfig | AuthDirectory | CurrentOrg>();

        const authenticated = yield* Effect.result(
          authenticateClient(request.headers, request.originalUrl).pipe(
            Effect.provideService(AccessJwks, jwks),
          ),
        );

        if (Result.isFailure(authenticated)) return refused(authenticated.failure);

        return yield* app.pipe(
          Effect.provideService(AccessPrincipal, authenticated.success),
          Effect.provideService(
            RequestReauthorizer,
            Effect.suspend(() =>
              reauthorization.failure === undefined
                ? reauthorizeClient(request.headers, request.originalUrl, authenticated.success)
                : Effect.fail(reauthorization.failure),
            ).pipe(Effect.provideService(AccessJwks, jwks), Effect.provideContext(ambient)),
          ),
          Effect.provideService(CurrentOrg, authenticated.success.org),
        );
      });
  }),
  { global: true },
);

const health = HttpRouter.add(
  "GET",
  "/healthz",
  HttpServerResponse.text(JSON.stringify({ status: "ok" }), { contentType: JSON_CONTENT_TYPE }),
);

/**
 * The client API `routes` behind the gate, with the Access keys `jwks` answers (`fakeJwksLayer` of
 * `@commissary/auth/testing`), and `/healthz`.
 */
export const behindClientGate = <A, E, R>(
  routes: Layer.Layer<A, E, R>,
  jwks: Layer.Layer<AccessJwks>,
) => {
  const gate = ClientGate.pipe(Layer.provide(jwks));

  return Layer.mergeAll(health, gate, routes.pipe(Layer.provide(gate)));
};
