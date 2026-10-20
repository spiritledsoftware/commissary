/**
 * The app host's part of Commissary Cloud's OAuth server for MCP clients (#200, ADR 0036; the server itself is
 * `@commissary/tools`' `oauth/`): its public endpoints (RFC 8414 metadata, the token endpoint, dynamic registration),
 * the consent page (`/authorize`, the panel's, behind the panel session like any of its pages) and the management
 * routes that page calls (`/v9/management/mcp-sign-ins*`, `McpSignInsGroup` in `@commissary/contract/mcp-sign-ins`),
 * which issue the client's API key. Everything answers like an unknown path on a self-hosted Commissary, whose MCP
 * clients Access signs in (ADR 0045), and on a stage without the OAuth server's bindings (a preview).
 *
 * A completed sign-in creates exactly one API key for the member in the org of the page, named after the client, with
 * the tool scope the member picked; the client's tokens stand for it (`withMcpAccessToken`, the API Worker's gate). The
 * token endpoint asks whether that key is still live on every code exchange and refresh, so revoking the key in the
 * panel ends the client's access.
 */
import { Clock, Effect, Schema } from "effect";
import { Cookies, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AccessPrincipal, AuthDirectory, verifyApiKey } from "@commissary/auth";
import { ApproveMcpSignIn, BeginMcpSignIn, DenyMcpSignIn } from "@commissary/contract/mcp-sign-ins";
import {
  CurrentOrg,
  CurrentOutboundPolicy,
  handled,
  jsonReply,
  type Reply,
  replyError,
  WorkerExecutionContext,
} from "@commissary/core";
import {
  bodyJson,
  cleanName,
  controlPlane,
  MAX_NAME_LENGTH,
  type StateEnv,
} from "@commissary/state";
import { ToolsEnv } from "@commissary/tools/api";
import {
  approveSignIn,
  AUTHORIZATION_SERVER_METADATA_PATH,
  AUTHORIZE_PATH,
  beginSignIn,
  denySignIn,
  type McpOAuthConfig,
  mcpOAuthConfig,
  REGISTER_PATH,
  serveAuthorizationServer,
  type SignInEnd,
  type SignInKeys,
  signInUserId,
  TOKEN_PATH,
} from "@commissary/tools/management";
import { webPanelPage } from "../management/web-panel.ts";
import { routeNotFound } from "./only.ts";

const BASE = "/v9/management/mcp-sign-ins";

/** The OAuth server of this deployment, `undefined` when it has none (`mcpOAuthConfig`). */
const oauthConfig = Effect.map(ToolsEnv, mcpOAuthConfig);

/** Runs `handler` with the OAuth server; answers like an unknown path without one. */
const withOAuth = <A, E, R>(handler: (config: McpOAuthConfig) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* oauthConfig;

    return config === undefined ? yield* routeNotFound : yield* handler(config);
  });

const webRequest = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
  HttpServerRequest.toWeb(request).pipe(Effect.orDie),
);

/** Whether an API key is live: `false` for one the directory refuses; rejects when the directory cannot be asked. */
const keyLiveness = Effect.gen(function* () {
  // The request's own services (its logger and spans too), not only the directory.
  const run = Effect.runPromiseWith(yield* Effect.context<AuthDirectory>());

  return (key: string): Promise<boolean> =>
    run(
      verifyApiKey(key).pipe(
        Effect.as(true),
        Effect.catchTag("UnauthorizedError", () => Effect.succeed(false)),
      ),
    );
});

/** RFC 8414 metadata, the token endpoint (and RFC 7009 revocation) and dynamic registration: the library's. */
const authorizationServer = withOAuth((config) =>
  Effect.gen(function* () {
    const response = yield* serveAuthorizationServer(
      config,
      yield* webRequest,
      yield* WorkerExecutionContext,
      yield* CurrentOutboundPolicy,
      yield* keyLiveness,
    );

    return HttpServerResponse.fromWeb(response);
  }),
);

/** `GET /authorize` (and `/o/<slug>/authorize`): the panel, which shows its consent page there. */
const consentPage = withOAuth(() => webPanelPage);

/**
 * The name of a client's API key: its name, control characters and runs of spaces made one space, cut to the longest
 * name a key may have (`cleanName`, which the key store checks it against).
 */
export const keyNameOf = (clientName: string): string => {
  const cleaned = Array.from(
    clientName
      .replace(/\p{Cc}/gu, " ")
      .trim()
      .replace(/\s+/g, " "),
  );

  return cleanName(cleaned.slice(0, MAX_NAME_LENGTH).join("")) ?? "MCP client";
};

const refused = (message: string) => replyError(422, "sign_in_refused", { message });

const withCookies = (
  response: HttpServerResponse.HttpServerResponse,
  cookies: ReadonlyArray<string>,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setHeader(
    cookies.length === 0
      ? response
      : HttpServerResponse.mergeCookies(response, Cookies.fromSetCookie(cookies)),
    "cache-control",
    "no-store",
  );

const ended = (end: SignInEnd): Effect.Effect<HttpServerResponse.HttpServerResponse, Reply> =>
  end.kind === "refused"
    ? Effect.fail(refused(end.message))
    : Effect.succeed(withCookies(jsonReply(200, { redirect_to: end.to }), end.cookies));

const decoded = <S extends Schema.Top>(schema: S) =>
  bodyJson.pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(() => replyError(400, "invalid body")),
      ),
    ),
  );

/** `POST /mcp-sign-ins`: validates the client's authorization request and starts its consent. */
const begin = (config: McpOAuthConfig) =>
  Effect.gen(function* () {
    const input = yield* decoded(BeginMcpSignIn);

    if (input.query !== "" && !input.query.startsWith("?"))
      return yield* replyError(400, "invalid body", { message: "query starts with ?" });

    const start = yield* beginSignIn(config, input.query, yield* CurrentOutboundPolicy);

    switch (start.kind) {
      case "refused":
        return yield* refused(start.message);
      case "redirect":
        return withCookies(jsonReply(200, { kind: "redirect", redirect_to: start.to }), []);
      case "consent":
        return withCookies(
          jsonReply(200, {
            kind: "consent",
            handle: start.handle,
            client: {
              client_id: start.client.clientId,
              client_name: start.client.clientName,
              ...(start.client.clientDomain === undefined
                ? {}
                : { client_domain: start.client.clientDomain }),
              redirect_host: start.client.redirectHost,
              redirect_is_loopback: start.client.redirectIsLoopback,
            },
          }),
          start.cookies,
        );
    }
  });

/**
 * `POST /mcp-sign-ins/approve`: issues the member's API key for the client, with the tool scope they picked, and
 * completes the sign-in. An earlier sign-in of the same client from the same redirect URI is replaced, its key revoked.
 */
const approve = (config: McpOAuthConfig) =>
  Effect.gen(function* () {
    const identity = yield* AccessPrincipal;
    const memberId = identity.memberId;

    if (memberId === undefined)
      return yield* replyError(403, "member_required", {
        message: "API keys are issued to members of the org; add yourself as a member first",
      });

    const input = yield* decoded(ApproveMcpSignIn);
    const org = yield* CurrentOrg;
    const context = yield* Effect.context<StateEnv | CurrentOrg>();
    const run = Effect.runPromiseWith(context);

    const keys: SignInKeys = {
      issue: (clientName) =>
        run(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;

            const result = yield* controlPlane("createApiKey", (stub) =>
              stub.createApiKey(
                {
                  memberId,
                  name: keyNameOf(clientName),
                  ...(input.tool_scope === null ? {} : { toolScope: input.tool_scope }),
                },
                now,
              ),
            );

            return result.ok
              ? { key: result.value.key, keyId: result.value.record.id }
              : { refused: result.message };
          }).pipe(Effect.orDie),
        ),
      revoke: (keyIds) =>
        run(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;

            for (const id of keyIds)
              yield* controlPlane("revokeApiKey", (stub) => stub.revokeApiKey(id, now, memberId));
          }).pipe(Effect.orDie),
        ),
    };

    return yield* ended(
      yield* approveSignIn(
        config,
        yield* webRequest,
        input.handle,
        signInUserId(org, memberId),
        yield* CurrentOutboundPolicy,
        keys,
      ),
    );
  });

/** `POST /mcp-sign-ins/deny`: the client hears `access_denied`. */
const deny = (config: McpOAuthConfig) =>
  Effect.gen(function* () {
    const input = yield* decoded(DenyMcpSignIn);

    return yield* ended(yield* denySignIn(config, yield* webRequest, input.handle));
  });

const managementRoute = <R>(
  path: HttpRouter.PathInput,
  handler: (
    config: McpOAuthConfig,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, Reply, R>,
) =>
  HttpRouter.route(
    "POST",
    path,
    withOAuth((config) => handled(handler(config))),
  );

/**
 * The consent page and the routes it calls; wrap with `withAccess` (the panel session and the org's member role,
 * `management/policy.ts`).
 */
export const mcpSignInRoutes = [
  HttpRouter.route("GET", `${AUTHORIZE_PATH}/*`, consentPage),
  managementRoute(BASE, begin),
  managementRoute(`${BASE}/approve`, approve),
  managementRoute(`${BASE}/deny`, deny),
];

/** The OAuth server's public endpoints (the library answers `OPTIONS` and wrong methods itself). */
export const McpOAuthServerRoutes = HttpRouter.addAll([
  HttpRouter.route("*", AUTHORIZATION_SERVER_METADATA_PATH, authorizationServer),
  HttpRouter.route("*", TOKEN_PATH, authorizationServer),
  HttpRouter.route("*", REGISTER_PATH, authorizationServer),
]);
