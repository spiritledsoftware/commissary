/**
 * xAI (Grok) login: RFC 8628 device flow resolved through OIDC discovery.
 *
 * Go source: auth_files_provider_oauth.go (`RequestXAIToken`), internal/auth/xai/{xai,token,types}.go
 * (`StartDeviceFlow`, `PollForToken`, `exchangeDeviceCode`, `CreateTokenStorage`, `CredentialFileName`).
 * Docs: config-management-oauth.md §3.2.4. Deviation: a transport failure or 5xx answer of one poll keeps waiting
 * (Go aborts the login), because client polling would otherwise lose the session to a network blip.
 */
import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import { decodeJwtClaims } from "../../credentials/expiry.ts";
import {
  isXaiOAuthEndpoint,
  XAI_CLIENT_ID,
  XAI_DEFAULT_BASE_URL,
  XAI_DISCOVERY_URL,
} from "../../credentials/refresh/xai.ts";
import type { JsonObject } from "@commissary/json";
import { sha256Hex } from "../encoding.ts";
import { call, clipBody, parseJsonObject, rfc3339, seconds, str, tryCall } from "./http.ts";
import { type DeviceFlow, flowFailure } from "./types.ts";

export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";

export const XAI_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const MAX_POLL_MS = 30 * 60_000;

const DEFAULT_INTERVAL_MS = 5_000;

const MAX_ERROR_TEXT = 512;

/** `sanitizeFileSegment`: `[A-Za-z0-9@._-]` kept, anything else becomes `-`, then trimmed of `-`. */
const sanitizeSegment = (value: string): string =>
  value
    .trim()
    .replace(/[^A-Za-z0-9@._-]/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * `CredentialFileName` (d65840fb): readable name plus a hash of the identity, so accounts that sanitise alike do not
 * overwrite each other. The email is trimmed and lower-cased (the hash covers it only, so a later login without a
 * subject keeps the file); the subject is used when there is no email. Deviation: Go's migration of pre-hash files
 * on re-login (`FindMatchingLegacyCredential`) is not ported.
 */
export const xaiFileName = async (email: string, subject: string, now: number): Promise<string> => {
  const normalizedEmail = email.trim().toLowerCase();

  if (normalizedEmail !== "") {
    const sanitized = sanitizeSegment(normalizedEmail) || "account";

    return `xai-${sanitized.slice(0, 120)}-${await sha256Hex(`email\0${normalizedEmail}`, 8)}.json`;
  }

  const cleanSubject = subject.trim();

  if (cleanSubject === "") return `xai-${now}.json`;
  const sanitized = sanitizeSegment(cleanSubject) || "account";

  return `xai-${sanitized.slice(0, 120)}-${await sha256Hex(`subject\0${cleanSubject}`, 8)}.json`;
};

const formPost = (url: string, params: Record<string, string>) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
    HttpClientRequest.bodyUrlParams(params),
  );

export const xaiFlow = (): DeviceFlow => ({
  kind: "device",
  provider: "xai",
  expiredMessage: "Authentication failed: xai device code expired",
  saveMessage: "Failed to save token to file",
  startFailureMessage: "failed to start device authorization flow",
  start: () =>
    Effect.gen(function* () {
      const discovery = yield* call(
        HttpClientRequest.get(XAI_DISCOVERY_URL).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
        ),
      );

      const endpoints = discovery.status === 200 ? parseJsonObject(discovery.text) : undefined;
      const deviceEndpoint = str(endpoints?.device_authorization_endpoint);
      const tokenEndpoint = str(endpoints?.token_endpoint);

      if (!isXaiOAuthEndpoint(deviceEndpoint) || !isXaiOAuthEndpoint(tokenEndpoint)) {
        return yield* flowFailure("xai discovery: invalid OAuth endpoints");
      }

      const reply = yield* call(
        formPost(deviceEndpoint, { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE }),
      );

      const device = reply.status === 200 ? parseJsonObject(reply.text) : undefined;
      const deviceCode = str(device?.device_code);
      const userCode = str(device?.user_code);
      const url = str(device?.verification_uri_complete) || str(device?.verification_uri);

      if (device === undefined || deviceCode === "" || userCode === "" || url === "") {
        return yield* flowFailure("xai device code request failed");
      }

      const expiresIn = Math.trunc(seconds(device.expires_in));
      const intervalMs = Math.max(Math.trunc(seconds(device.interval)) * 1000, DEFAULT_INTERVAL_MS);

      return {
        url,
        userCode,
        expiresIn: expiresIn > 0 ? expiresIn : MAX_POLL_MS / 1000,
        data: { device_code: deviceCode, token_endpoint: tokenEndpoint } satisfies JsonObject,
        intervalMs,
        // Go polls once immediately, then waits.
        firstPollDelayMs: 0,
        windowMs: expiresIn > 0 ? Math.min(MAX_POLL_MS, expiresIn * 1000) : MAX_POLL_MS,
      };
    }),
  poll: ({ data, now, intervalMs }) =>
    Effect.gen(function* () {
      const tokenEndpoint = str(data.token_endpoint);

      const reply = yield* tryCall(
        formPost(tokenEndpoint, {
          grant_type: XAI_DEVICE_GRANT,
          device_code: str(data.device_code),
          client_id: XAI_CLIENT_ID,
        }),
      );

      if (reply === undefined || reply.status >= 500) return { _tag: "pending" as const };
      const payload = parseJsonObject(reply.text);

      if (payload === undefined) {
        return yield* flowFailure("Authentication failed: xai device token: parse response failed");
      }

      const error = str(payload.error);

      if (error !== "") {
        switch (error) {
          case "authorization_pending":
            return { _tag: "pending" as const };
          case "slow_down":
            return { _tag: "pending" as const, intervalMs: intervalMs + DEFAULT_INTERVAL_MS };
          case "expired_token":
            return yield* flowFailure("Authentication failed: xai device code expired");
          case "access_denied":
            return yield* flowFailure("Authentication failed: xai device authorization denied");
          default: {
            const description = str(payload.error_description);

            return yield* flowFailure(
              `Authentication failed: xai device token error: ${error}${description === "" ? "" : `: ${description}`}`,
            );
          }
        }
      }

      if (reply.status !== 200) {
        return yield* flowFailure(
          `Authentication failed: xai device token request failed with status ${reply.status}: ${clipBody(reply.text).slice(0, MAX_ERROR_TEXT)}`,
        );
      }

      const accessToken = str(payload.access_token);

      if (accessToken === "") {
        return yield* flowFailure(
          "Authentication failed: xai device token response missing access_token",
        );
      }

      const idToken = str(payload.id_token);
      const claims = idToken === "" ? undefined : decodeJwtClaims(idToken);
      const email = str(claims?.email);
      const subject = str(claims?.sub);
      const expiresIn = Math.trunc(seconds(payload.expires_in));

      const metadata: JsonObject = {
        type: "xai",
        access_token: accessToken,
        refresh_token: str(payload.refresh_token),
        id_token: idToken,
        token_type: str(payload.token_type),
        expires_in: expiresIn,
        expired: expiresIn > 0 ? rfc3339(now + expiresIn * 1000) : "",
        last_refresh: rfc3339(now),
        base_url: XAI_DEFAULT_BASE_URL,
        token_endpoint: tokenEndpoint,
        auth_kind: "oauth",
      };

      if (email !== "") metadata.email = email;

      if (subject !== "") metadata.sub = subject;

      return {
        _tag: "done" as const,
        record: {
          fileName: yield* Effect.promise(() => xaiFileName(email, subject, now)),
          metadata,
        },
      };
    }),
});
