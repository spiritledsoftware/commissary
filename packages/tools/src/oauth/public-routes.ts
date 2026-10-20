/**
 * The public routes of toolkits' OAuth 2 sign-ins (#202), outside the management API:
 *
 * - **the callback** (`GET /oauth/toolkits/callback`, {@link SIGN_IN_CALLBACK_PATH}), on the app host: the one redirect
 *   URI of the deployment, which admins also enter in their own OAuth apps. It acts only on the `state` of a pending
 *   sign-in, which names its org (`org.<org>.<hex>`, a bare one is `global`'s), so only that org's ControlPlane is
 *   asked, and only for the member who started the sign-in: the app Worker's gate signs the request in (an Access
 *   sign-in, a Commissary Cloud session) as a member of that org (`AccessPrincipal`), and a request from anyone else,
 *   or from no one, is refused like an unknown state, the sign-in left pending for its starter. So a link to the
 *   callback that an attacker got from signing in to their own account cannot connect it for someone else (login
 *   CSRF). It answers with a static page that never holds a code, a state, a token or an error's details.
 * - **Commissary's Client ID Metadata Document** (`GET /oauth/toolkits/client.json`, `TOOLKIT_OAUTH_CLIENT_PATH`), on
 *   the API Worker: a client API path, so it is served where an MCP server's authorization server reaches it without
 *   signing in (the API host, or the app host's zone route outside Access). Its `client_id` is its own URL and its one
 *   redirect URI the callback on the app host (`APP_DOMAIN`); a Worker that does not know the app host (a preview,
 *   `alchemy dev`) serves none, and sign-ins there do not offer it (`signInUrls`).
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AccessPrincipal } from "@commissary/auth";
import { CurrentOrg, CurrentOutboundPolicy, TOOLKIT_OAUTH_CLIENT_PATH } from "@commissary/core";
import { toolsControlPlane, ToolsEnv } from "../env.ts";
import { clientMetadata, SIGN_IN_CALLBACK_PATH, signInCallbackOrg } from "./urls.ts";

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
} as const;

const page = (status: number, title: string, message: string) =>
  HttpServerResponse.text(
    `<html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`,
    { status, contentType: "text/html; charset=utf-8", headers: PAGE_HEADERS },
  );

/**
 * The page of a callback that is refused: a state that is unknown, used, expired or another org's, or a caller who is
 * not the member who started the sign-in (the app Worker's gate answers it to anyone it cannot sign in as a member).
 */
export const signInCallbackRejected = () =>
  page(
    400,
    "Invalid request",
    "This sign-in link is invalid or has expired. Start the sign-in again.",
  );

const rejected = signInCallbackRejected();

const callback = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = new URL(request.originalUrl, "http://localhost").searchParams;
  const state = params.get("state")?.trim() ?? "";
  const code = params.get("code")?.trim() ?? "";
  const error = params.get("error")?.trim() ?? "";
  const iss = params.get("iss")?.trim();
  const org = signInCallbackOrg(request.originalUrl);
  // Who the gate signed in, as a member of the org the state names (it refused anyone else).
  const caller = yield* AccessPrincipal;
  const member = caller.org === org ? caller.memberId : undefined;

  // Cheap filters before the ControlPlane is asked.
  if (org === undefined || member === undefined || (code === "" && error === "")) return rejected;
  const policy = yield* CurrentOutboundPolicy;

  const result = yield* toolsControlPlane("completeSignIn", (stub) =>
    stub
      .tools()
      .completeSignIn({ state, code, error, iss: iss === "" ? undefined : iss, member }, policy),
  ).pipe(
    Effect.provideService(CurrentOrg, org),
    // The org only, never the state (which finishes the sign-in) nor the code (the server's grant).
    Effect.catch(() =>
      Effect.logWarning("toolkit sign-in callback failed").pipe(
        Effect.annotateLogs({ org }),
        Effect.as(undefined),
      ),
    ),
  );

  if (result === undefined)
    return page(503, "Unavailable", "The sign-in could not be finished right now. Try again.");

  switch (result.outcome) {
    case "rejected":
      return rejected;
    case "completed":
      return page(200, "Signed in", "You can close this window and return to Commissary.");
    case "failed":
      return page(
        200,
        "Sign-in failed",
        "Return to Commissary to see what went wrong and try again.",
      );
  }
});

/**
 * The callback, for the app Worker, which serves it behind its gate: the route reads the member the gate signed in
 * (`AccessPrincipal`, for the org the state names; `signInCallbackOrg`).
 */
export const SignInCallbackRoutes = HttpRouter.add("GET", SIGN_IN_CALLBACK_PATH, callback);

const clientDocument = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const env = yield* ToolsEnv;
  const appHost = (env.APP_DOMAIN ?? "").trim();
  const own = new URL(request.originalUrl, "http://localhost");

  if (appHost === "" || own.protocol !== "https:")
    return HttpServerResponse.jsonUnsafe(
      { error: "not found" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );

  return HttpServerResponse.jsonUnsafe(
    clientMetadata(`https://${own.host}${TOOLKIT_OAUTH_CLIENT_PATH}`, appHost),
    { headers: { "cache-control": "public, max-age=3600" } },
  );
});

/** Commissary's CIMD document, for the API Worker. */
export const ClientMetadataRoutes = HttpRouter.add(
  "GET",
  TOOLKIT_OAUTH_CLIENT_PATH,
  clientDocument,
);
