/**
 * Antigravity (Google Cloud Code Assist) login: Google authorization code flow (no PKCE, installed-app client secret)
 * with the pasted `localhost:51121` redirect URL.
 *
 * Go source: auth_files_provider_oauth.go (`RequestAntigravityToken`), internal/auth/antigravity/{auth,constants,
 * filename}.go (`BuildAuthURL`, `ExchangeCodeForTokens`, `FetchUserInfo`, `FetchProjectID`, `OnboardUser`),
 * internal/misc/antigravity_version.go (user agents). Docs: config-management-oauth.md §3.2.3.
 * Deviation: the client version is the Go fallback (`2.29.0`); the Hub manifest is not polled on Workers.
 */
import { Effect } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_TOKEN_URL,
} from "../../credentials/refresh/antigravity.ts";
import { isJsonObject, type Json, type JsonObject } from "@commissary/json";
import {
  ANTIGRAVITY_FALLBACK_VERSION,
  antigravityUserAgent,
} from "../../executor/antigravity/version.ts";
import { encodeQuery } from "../encoding.ts";
import { call, parseJsonObject, rfc3339, seconds, str } from "./http.ts";
import { type CallbackFlow, type FlowFailure, flowFailure } from "./types.ts";

export const ANTIGRAVITY_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export const ANTIGRAVITY_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";

export const ANTIGRAVITY_DAILY_API_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";

const API_VERSION = "v1internal";

const CLIENT_VERSION = ANTIGRAVITY_FALLBACK_VERSION;

const SHORT_USER_AGENT = antigravityUserAgent(CLIENT_VERSION);

const NODE_USER_AGENT = `${SHORT_USER_AGENT} google-api-nodejs-client/10.3.0`;

const GOOG_API_CLIENT = "gl-node/22.21.1";

const ONBOARD_ATTEMPTS = 5;

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const antigravityFileName = (email: string): string =>
  email.trim() === "" ? "antigravity.json" : `antigravity-${email.trim()}.json`;

/** `extractCloudaicompanionProject`: a string or `{id}` under one of three keys. */
const extractProject = (data: JsonObject): string => {
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];

    if (typeof value === "string" && value.trim() !== "") return value.trim();

    if (isJsonObject(value) && str(value.id) !== "") return str(value.id);
  }

  return "";
};

/** `defaultAntigravityTierID`: the default allowed tier, else the current tier, else `free-tier`. */
const defaultTierId = (loadResponse: JsonObject): string => {
  const tiers = loadResponse.allowedTiers;

  if (Array.isArray(tiers)) {
    for (const tier of tiers) {
      if (isJsonObject(tier) && tier.isDefault === true && str(tier.id) !== "") return str(tier.id);
    }
  }

  const current = loadResponse.currentTier;

  if (isJsonObject(current) && str(current.id) !== "") return str(current.id);

  return "free-tier";
};

const jsonPost = (
  url: string,
  accessToken: string,
  userAgent: string,
  body: Json,
  options: { readonly extra?: Record<string, string>; readonly accept?: boolean } = {},
) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeaders({
      authorization: `Bearer ${accessToken}`,
      ...(options.accept === false ? {} : { accept: "*/*" }),
      "user-agent": userAgent,
      ...options.extra,
    }),
    HttpClientRequest.bodyJsonUnsafe(body),
  );

/** `OnboardUser`: polls `onboardUser` (2 s apart, 5 attempts) until the operation is done. */
const onboardUser = (
  accessToken: string,
  tierId: string,
): Effect.Effect<string, FlowFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = `${ANTIGRAVITY_DAILY_API_ENDPOINT}/${API_VERSION}:onboardUser`;

    const body = {
      tier_id: tierId,
      metadata: { ide_type: "ANTIGRAVITY", ide_version: CLIENT_VERSION, ide_name: "antigravity" },
    };

    for (let attempt = 1; attempt <= ONBOARD_ATTEMPTS; attempt++) {
      const reply = yield* call(
        jsonPost(url, accessToken, NODE_USER_AGENT, body, {
          extra: { "x-goog-api-client": GOOG_API_CLIENT },
        }),
      );

      if (reply.status !== 200)
        return yield* flowFailure(`onboardUser failed with status ${reply.status}`);
      const data = parseJsonObject(reply.text);

      if (data === undefined) return yield* flowFailure("onboardUser: decode response failed");

      if (data.done === true) {
        const project = isJsonObject(data.response) ? extractProject(data.response) : "";

        return project === "" ? yield* flowFailure("no project_id in response") : project;
      }

      yield* Effect.sleep("2 seconds");
    }

    return yield* flowFailure(`onboard user did not complete after ${ONBOARD_ATTEMPTS} attempts`);
  });

/** `FetchProjectID`: `loadCodeAssist`, falling back to onboarding the user. Non-fatal for the login. */
export const fetchProjectId = (accessToken: string) =>
  Effect.gen(function* () {
    const url = `${ANTIGRAVITY_DAILY_API_ENDPOINT}/${API_VERSION}:loadCodeAssist`;

    const reply = yield* call(
      jsonPost(
        url,
        accessToken,
        SHORT_USER_AGENT,
        { metadata: { ideType: "ANTIGRAVITY" } },
        { accept: false },
      ),
    );

    if (reply.status < 200 || reply.status >= 300) {
      return yield* flowFailure(`loadCodeAssist failed with status ${reply.status}`);
    }

    const data = parseJsonObject(reply.text);

    if (data === undefined) return yield* flowFailure("loadCodeAssist: decode response failed");
    const project = extractProject(data);

    return project !== "" ? project : yield* onboardUser(accessToken, defaultTierId(data));
  });

export const antigravityFlow = (): CallbackFlow => ({
  kind: "callback",
  provider: "antigravity",
  timeoutMessage: "OAuth flow timed out",
  deniedMessage: "Authentication failed",
  saveMessage: "Failed to save token to file",
  start: ({ state }) =>
    Effect.succeed({
      url: `${ANTIGRAVITY_AUTH_URL}?${encodeQuery({
        access_type: "offline",
        client_id: ANTIGRAVITY_CLIENT_ID,
        prompt: "consent",
        redirect_uri: ANTIGRAVITY_REDIRECT_URI,
        response_type: "code",
        scope: SCOPES.join(" "),
        state,
      })}`,
      data: {},
    }),
  complete: ({ code, now }) =>
    Effect.gen(function* () {
      if (code.trim() === "") return yield* flowFailure("Authentication failed: code not found");

      const exchange = HttpClientRequest.post(ANTIGRAVITY_TOKEN_URL).pipe(
        HttpClientRequest.bodyUrlParams({
          code,
          client_id: ANTIGRAVITY_CLIENT_ID,
          client_secret: ANTIGRAVITY_CLIENT_SECRET,
          redirect_uri: ANTIGRAVITY_REDIRECT_URI,
          grant_type: "authorization_code",
        }),
      );

      const tokenReply = yield* call(exchange, "Failed to exchange token");

      const tokens =
        tokenReply.status >= 200 && tokenReply.status < 300
          ? parseJsonObject(tokenReply.text)
          : undefined;

      const accessToken = str(tokens?.access_token);

      if (tokens === undefined || accessToken === "")
        return yield* flowFailure("Failed to exchange token");

      const infoReply = yield* call(
        HttpClientRequest.get(ANTIGRAVITY_USERINFO_URL).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${accessToken}`,
            "user-agent": SHORT_USER_AGENT,
          }),
        ),
        "Failed to fetch user info",
      );

      const email =
        infoReply.status >= 200 && infoReply.status < 300
          ? str(parseJsonObject(infoReply.text)?.email)
          : "";

      if (email === "") return yield* flowFailure("Failed to fetch user info");

      // Project discovery must never fail the login.
      const projectId = yield* fetchProjectId(accessToken).pipe(
        Effect.catch(() => Effect.succeed("")),
      );

      const expiresIn = Math.trunc(seconds(tokens.expires_in));

      const metadata: JsonObject = {
        type: "antigravity",
        access_token: str(tokens.access_token),
        refresh_token: str(tokens.refresh_token),
        expires_in: expiresIn,
        timestamp: now,
        expired: rfc3339(now + expiresIn * 1000),
        email,
      };

      if (projectId !== "") metadata.project_id = projectId;

      return { fileName: antigravityFileName(email), metadata };
    }),
});
