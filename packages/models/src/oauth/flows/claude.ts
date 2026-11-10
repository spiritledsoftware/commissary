/**
 * Claude (Anthropic) login: authorization code + PKCE, completed by pasting the `localhost:54545` redirect URL.
 *
 * Go source: internal/api/handlers/management/auth_files_provider_oauth.go (`RequestAnthropicToken`),
 * internal/auth/claude/anthropic_auth.go (`GenerateAuthURL`, `ExchangeCodeForTokens`, `inspectOAuthAccount`,
 * `CreateTokenStorage`), filename.go, identity.go. Docs: config-management-oauth.md §3.2.1.
 * Workers cannot reproduce the uTLS/ordered-header fingerprint of Go: the Axios `Accept`/`Content-Type`/`User-Agent`
 * headers are kept, the rest is up to `fetch`.
 */
import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import { isJsonObject, type Json, type JsonObject } from "@commissary/json";
import {
  CLAUDE_CLIENT_ID,
  CLAUDE_OAUTH_SCOPE,
  CLAUDE_PROFILE_URL,
  CLAUDE_TOKEN_URL,
} from "../../credentials/refresh/claude.ts";
import {
  base64Url,
  encodeQuery,
  generatePkce,
  randomBytes,
  randomHex,
  sha256Hex,
} from "../encoding.ts";
import { call, parseJsonObject, rfc3339, seconds, str, tryCall } from "./http.ts";
import { type CallbackFlow, type CredentialRecord, flowFailure } from "./types.ts";

export const CLAUDE_AUTH_URL = "https://claude.ai/oauth/authorize";

export const CLAUDE_ROLES_URL = "https://api.anthropic.com/api/oauth/claude_cli/roles";

export const CLAUDE_REDIRECT_URI = "http://localhost:54545/callback";

const AXIOS_HEADERS = {
  accept: "application/json, text/plain, */*",
  "content-type": "application/json",
  "user-agent": "axios/1.15.2",
} as const;

const EXCHANGE_FAILED = "Failed to exchange authorization code for tokens";

/** `CredentialFileName`: the organization (else account) identity is hashed into the name. */
export const claudeFileName = async (
  email: string,
  organizationUuid: string,
  accountUuid: string,
): Promise<string> => {
  const cleanEmail = email.trim();
  const identity = organizationUuid.trim() || accountUuid.trim();

  if (identity === "") return `claude-${cleanEmail}.json`;

  return `claude-${await sha256Hex(identity, 4)}-${cleanEmail}.json`;
};

interface Identity {
  email: string;
  accountUuid: string;
  organizationUuid: string;
  organizationName: string;
}

const nested = (value: Json | undefined, key: string): string =>
  isJsonObject(value) ? str(value[key]) : "";

/** Profile (identity wins) and roles lookups the native client issues after the exchange; both are advisory. */
const inspectAccount = (accessToken: string, identity: Identity) =>
  Effect.gen(function* () {
    const headers = {
      ...AXIOS_HEADERS,
      authorization: `Bearer ${accessToken}`,
      "cache-control": "no-cache",
    };

    const profile = yield* tryCall(
      HttpClientRequest.get(CLAUDE_PROFILE_URL).pipe(HttpClientRequest.setHeaders(headers)),
    );

    yield* tryCall(
      HttpClientRequest.get(CLAUDE_ROLES_URL).pipe(HttpClientRequest.setHeaders(headers)),
    );

    if (profile === undefined || profile.status < 200 || profile.status >= 300) return;
    const body = parseJsonObject(profile.text);

    // The profile is only trusted with an account UUID (`FetchOAuthProfile`).
    if (body === undefined || nested(body.account, "uuid") === "") return;
    identity.accountUuid = nested(body.account, "uuid");
    identity.email = nested(body.account, "email") || identity.email;
    identity.organizationUuid = nested(body.organization, "uuid") || identity.organizationUuid;
    identity.organizationName = nested(body.organization, "name") || identity.organizationName;
  });

/** Go `claude.GenerateState` (ea0b4712): 256 random bits as unpadded base64url, as native Claude Code sends. */
const generateClaudeState = (): string => base64Url(randomBytes(32));

/** The authorize scope adds the Console scope; the token refresh keeps `CLAUDE_OAUTH_SCOPE` (ea0b4712). */
const CLAUDE_AUTHORIZE_SCOPE = `org:create_api_key ${CLAUDE_OAUTH_SCOPE}`;

export const claudeFlow = (): CallbackFlow => ({
  kind: "callback",
  provider: "anthropic",
  timeoutMessage: "Timeout waiting for OAuth callback",
  deniedMessage: "Bad request",
  saveMessage: "Failed to save authentication tokens",
  generateState: generateClaudeState,
  start: ({ state }) =>
    Effect.promise(async () => {
      const pkce = await generatePkce(96);

      const query = encodeQuery({
        code: "true",
        client_id: CLAUDE_CLIENT_ID,
        response_type: "code",
        redirect_uri: CLAUDE_REDIRECT_URI,
        scope: CLAUDE_AUTHORIZE_SCOPE,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: "S256",
        state,
      });

      return {
        url: `${CLAUDE_AUTH_URL}?${query}`,
        data: { code_verifier: pkce.codeVerifier } satisfies JsonObject,
      };
    }),
  complete: ({ state, code, data, now }) =>
    Effect.gen(function* () {
      // Claude's code page shows `code#state`; like the Go handler only the part before `#` is the code.
      const plainCode = code.split("#")[0] ?? "";

      const request = HttpClientRequest.post(CLAUDE_TOKEN_URL).pipe(
        HttpClientRequest.setHeaders(AXIOS_HEADERS),
        // Key order reproduces the body Claude Code sends.
        HttpClientRequest.bodyJsonUnsafe({
          grant_type: "authorization_code",
          code: plainCode,
          redirect_uri: CLAUDE_REDIRECT_URI,
          client_id: CLAUDE_CLIENT_ID,
          code_verifier: str(data.code_verifier),
          state,
        }),
      );

      const reply = yield* call(request, EXCHANGE_FAILED);
      const body = reply.status === 200 ? parseJsonObject(reply.text) : undefined;
      const accessToken = str(body?.access_token);

      if (body === undefined || accessToken === "") return yield* flowFailure(EXCHANGE_FAILED);

      const identity: Identity = {
        email: nested(body.account, "email_address"),
        accountUuid: nested(body.account, "uuid"),
        organizationUuid: nested(body.organization, "uuid"),
        organizationName: nested(body.organization, "name"),
      };

      yield* inspectAccount(accessToken, identity);

      const metadata: JsonObject = {
        id_token: "",
        access_token: str(body.access_token),
        refresh_token: str(body.refresh_token),
        last_refresh: rfc3339(now),
        email: identity.email,
      };

      if (identity.accountUuid !== "") metadata.account_uuid = identity.accountUuid;

      if (identity.organizationUuid !== "") metadata.organization_uuid = identity.organizationUuid;

      if (identity.organizationName !== "") metadata.organization_name = identity.organizationName;
      metadata.claude_device_ids = [randomHex(32)];
      metadata.type = "claude";
      metadata.expired = rfc3339(now + seconds(body.expires_in) * 1000);

      const fileName = yield* Effect.promise(() =>
        claudeFileName(identity.email, identity.organizationUuid, identity.accountUuid),
      );

      return { fileName, metadata } satisfies CredentialRecord;
    }),
});
