// Router middleware gating the panel and the management routes, and refusing the client API (mirrors AuthMiddleware in
// internal/api/server_middleware.go: flat `{"error": "..."}` bodies).
import { Effect, Option, Predicate, Result } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { CurrentOrg } from "@commissary/core";
import {
  authenticateMcp,
  authenticateRequest,
  authenticateSignInCallback,
  MCP_SIGN_IN,
} from "./authenticate.ts";
import { crossSiteRejection } from "./csrf.ts";
import {
  type AccessError,
  accessErrorResponse,
  AccessJwks,
  AccessPrincipal,
  AuthConfig,
  isHosted,
  PUBLIC_ROUTE_IDENTITY,
} from "@commissary/auth";
import {
  classifyPath,
  isPanelAssetPath,
  isPanelPagePath,
  normalizedPath,
} from "../management/zones.ts";
import { SIGN_IN_PAGE_PATH } from "@commissary/contract/sign-in";
import {
  SIGN_IN_CALLBACK_PATH,
  signInCallbackOrg,
  signInCallbackRejected,
} from "@commissary/tools/management";
import { clientApiElsewhere } from "../http/hosts.ts";
import { AppEnv } from "../worker-env.ts";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const errorResponse = (status: number, message: string) =>
  HttpServerResponse.text(JSON.stringify({ error: message }), {
    status,
    contentType: JSON_CONTENT_TYPE,
  });

/**
 * On Commissary Cloud, a browser that opens a panel page without a session goes to the sign-in page, which brings it back
 * (`next`, a path of this origin) once signed in.
 */
const signInRedirect = (
  request: HttpServerRequest.HttpServerRequest,
  failure: AccessError,
): HttpServerResponse.HttpServerResponse | undefined => {
  const url = new URL(request.originalUrl, "http://localhost");

  if (
    !Predicate.isTagged(failure, "UnauthorizedError") ||
    (request.method !== "GET" && request.method !== "HEAD") ||
    !isPanelPagePath(normalizedPath(request.originalUrl) ?? "")
  )
    return undefined;

  const next = `${url.pathname}${url.search}`;

  return HttpServerResponse.redirect(
    next === "/" ? SIGN_IN_PAGE_PATH : `${SIGN_IN_PAGE_PATH}?next=${encodeURIComponent(next)}`,
    { status: 302, headers: { "cache-control": "no-store" } },
  );
};

/**
 * Global middleware: requests of the management zone (`management/zones.ts`: the management API and the panel) and, on
 * a self-hosted Commissary, of the MCP endpoint (`/mcp`, `/o/<slug>/mcp`, ADR 0045: Access signs MCP clients in) must
 * carry a credential `@commissary/auth` accepts (`authenticate.ts`): an Access JWT, a Commissary Cloud session or a
 * management key, and come from a member of the request's org with the role the route needs (`management/policy.ts`,
 * ADR 0022): a platform admin (`PLATFORM_ADMIN_*`) is an owner of every org, anyone else has the role their membership
 * gives them. Cross-site requests and cross-origin WebSocket upgrades are refused first (`csrf.ts`). A client API path
 * is refused with a 404 that says where the client API is (`http/hosts.ts`): the API Worker serves it (ADR 0030), and
 * so is `/mcp` on Commissary Cloud. A toolkit sign-in's callback (#202) is signed in as a member of the org its state
 * names, and refused with the page of an invalid sign-in otherwise. Everything else (`/healthz`, unknown paths) is
 * passed through untouched. On success
 * the principal is available to handlers as `AccessPrincipal`, and `CurrentOrg` is the org of the request: the org
 * addressed by an org-scoped management URL (`management/org-address.ts`), unchanged otherwise.
 */
export const AccessGate = HttpRouter.middleware<{ provides: AccessPrincipal }>()(
  Effect.gen(function* () {
    // Resolved when the layer is built (once per isolate); `AuthConfig` stays a per-request service.
    const jwks = yield* AccessJwks;

    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const zone = classifyPath(request.originalUrl);

        const hosted = isHosted(yield* AuthConfig);

        // A toolkit sign-in's callback (#202) is its starter's to finish: the person is signed in as a member of the org
        // its state names, and anyone who is not (nobody signed in, a management key, a service token, someone outside
        // the org) gets the page of an invalid sign-in, as for a state that is not known.
        if (normalizedPath(request.originalUrl) === SIGN_IN_CALLBACK_PATH) {
          const org = signInCallbackOrg(request.originalUrl);

          if (org === undefined) return signInCallbackRejected();

          const caller = yield* authenticateSignInCallback(
            request.headers,
            request.originalUrl,
            org,
          ).pipe(Effect.provideService(AccessJwks, jwks), Effect.option);

          return Option.isNone(caller)
            ? signInCallbackRejected()
            : yield* Effect.provideService(app, AccessPrincipal, caller.value);
        }

        // Commissary Cloud's sign-in page loads the panel's bundle before anyone is signed in; the bundle holds no data.
        if (zone === "public" || (hosted && isPanelAssetPath(request.originalUrl))) {
          return yield* Effect.provideService(app, AccessPrincipal, PUBLIC_ROUTE_IDENTITY);
        }

        // Commissary Cloud serves the MCP endpoint on the API host only: its MCP clients sign in through its own OAuth
        // server (ADR 0036), not here (ADR 0045).
        if (zone === "protected" || (zone === "mcp" && hosted))
          return HttpServerResponse.setHeader(
            errorResponse(404, clientApiElsewhere(yield* AppEnv)),
            "cache-control",
            "no-store",
          );

        const rejection = crossSiteRejection(
          request.method,
          request.headers,
          request.originalUrl,
          zone,
        );

        if (rejection !== undefined) return errorResponse(rejection.status, rejection.message);

        const authenticated = yield* Effect.result(
          (zone === "mcp"
            ? authenticateMcp(request.headers, request.originalUrl, request.method)
            : authenticateRequest(request.headers, request.originalUrl, request.method)
          ).pipe(Effect.provideService(AccessJwks, jwks)),
        );

        if (Result.isFailure(authenticated)) {
          const page = hosted ? signInRedirect(request, authenticated.failure) : undefined;
          const refusal = page ?? (yield* accessErrorResponse(authenticated.failure));

          // An MCP client is told to sign in through Access, with the MCP authorization spec's challenge, as on the API
          // Worker; with Managed OAuth, Access answers a client without a sign-in itself, before this.
          return zone === "mcp" && refusal.status === 401
            ? HttpServerResponse.setHeader(
                errorResponse(401, MCP_SIGN_IN),
                "www-authenticate",
                "Bearer",
              )
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
