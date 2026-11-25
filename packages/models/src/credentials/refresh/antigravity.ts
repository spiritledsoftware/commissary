/**
 * Antigravity (Google OAuth installed-app) token refresh.
 *
 * Go source: internal/runtime/executor/antigravity_executor_auth.go (`Refresh`, `refreshToken`,
 * `refreshTokenSingleFlight`), internal/auth/antigravity/constants.go. Docs: providers-google.md §2.3.
 * Not ported here: `ensureAntigravityProjectID` (project discovery) and the credits-hint probe belong to the
 * Antigravity executor slice, which persists `project_id` through `ControlPlane.patchCredentialMetadata`.
 */
import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import type { JsonObject } from "@commissary/json";
import { refreshError } from "./error.ts";
import { parseGoogleRetryDelayWithHeadersMs } from "../../executor/helps/google-retry.ts";
import { clipBody, parseJsonObject, rfc3339, send, seconds, statusFailure, str } from "./http.ts";
import type { RefreshContext, RefreshProtocolEffect } from "./types.ts";

export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const ANTIGRAVITY_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

/** Public installed-app secret (embedded in the Go source and in the upstream client). */
export const ANTIGRAVITY_CLIENT_SECRET = "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";

export const refreshAntigravity = (context: RefreshContext): RefreshProtocolEffect =>
  Effect.gen(function* () {
    const metadata: JsonObject = { ...context.metadata };
    const refreshToken = str(metadata.refresh_token);

    if (refreshToken === "")
      return yield* Effect.fail(refreshError({ message: "missing refresh token", status: 401 }));

    const request = HttpClientRequest.post(ANTIGRAVITY_TOKEN_URL).pipe(
      // Real Antigravity uses Go's default User-Agent for the OAuth refresh.
      HttpClientRequest.setHeader("user-agent", "Go-http-client/2.0"),
      HttpClientRequest.bodyUrlParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    );

    const reply = yield* send(request);

    if (reply.status === 429) {
      // The body's RetryInfo blocks the refresh token for that long (`refreshTokenSingleFlight`), so the attempt's
      // error carries the wait (CLIProxyAPI 2f57a5a6).
      const blockMs = parseGoogleRetryDelayWithHeadersMs(undefined, reply.text, context.now);

      return yield* Effect.fail(
        refreshError({
          message: `token refresh failed with status 429: ${clipBody(reply.text)}`,
          status: 429,
          ...(blockMs === undefined || blockMs <= 0 ? {} : { blockMs }),
        }),
      );
    }

    if (reply.status < 200 || reply.status >= 300)
      return yield* Effect.fail(statusFailure("token refresh", reply));
    const body = parseJsonObject(reply.text);
    const accessToken = str(body?.access_token);

    if (body === undefined || accessToken === "") {
      return yield* Effect.fail(
        refreshError({ message: "token refresh response has no access_token" }),
      );
    }

    const expiresIn = Math.trunc(seconds(body.expires_in));
    metadata.access_token = accessToken;
    const rotated = str(body.refresh_token);

    if (rotated !== "") metadata.refresh_token = rotated;
    metadata.expires_in = expiresIn;
    metadata.timestamp = context.now;
    metadata.expired = rfc3339(context.now + expiresIn * 1000);
    metadata.type = "antigravity";

    return metadata;
  });
