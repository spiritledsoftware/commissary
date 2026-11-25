/**
 * Antigravity (Google Cloud Code Assist) login: Google authorization code flow (no PKCE, installed-app client secret)
 * with the pasted `localhost:51121` redirect URL.
 *
 * Go source: auth_files_provider_oauth.go (`RequestAntigravityToken`), internal/auth/antigravity/{auth,constants,
 * filename}.go (`BuildAuthURL`, `ExchangeCodeForTokens`, `FetchUserInfo`, `FetchProjectID`, `OnboardUser`),
 * internal/misc/antigravity_version.go (user agents). Docs: config-management-oauth.md §3.2.3.
 * Deviation: the client version is the Go fallback (`ANTIGRAVITY_FALLBACK_VERSION`); the Hub manifest is not polled on
 * Workers. A login whose project discovery fails or finds no project fails (CLIProxyAPI d214f881).
 */
import { Clock, Data, Effect } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";
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
import { readBoundedText } from "../../executor/helps/bounded-body.ts";
import { encodeQuery } from "../encoding.ts";
import { call, parseJsonObject, rfc3339, seconds, str } from "./http.ts";
import { type CallbackFlow, flowFailure } from "./types.ts";

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

/** `antigravity.ErrProjectIDNotFound`: discovery finished without a usable `project_id`. */
const PROJECT_NOT_FOUND = "antigravity: project id not found";

/** `maxAntigravityAuthResponseBytes`: the largest 2xx JSON reply read. */
const MAX_RESPONSE_BYTES = 1 << 20;

/** `maxAntigravityAuthErrorBodyBytes`: the most of an error body read. */
const MAX_ERROR_BODY_BYTES = 64 << 10;

/** `maxAntigravityAuthErrorMessageBytes`: the longest error text kept in a message. */
const MAX_ERROR_MESSAGE_BYTES = 8 << 10;

/**
 * A failed project discovery (Go `HTTPStatusError`, `ErrProjectIDNotFound`, CLIProxyAPI 204be8b9, 91ccf284): `status`
 * is the upstream's (`0` without an answer), with its `Retry-After` and body; `notFound` when discovery finished
 * without a project.
 */
export class ProjectDiscoveryError extends Data.TaggedError("ProjectDiscoveryError")<{
  readonly message: string;
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly body: string;
  readonly notFound: boolean;
}> {}

/** What a {@link ProjectDiscoveryError} carries besides its message (defaults: status 0, empty body, found). */
interface DiscoveryFields {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly body?: string;
  readonly notFound?: boolean;
}

const discoveryError = (message: string, fields: DiscoveryFields = {}): ProjectDiscoveryError =>
  new ProjectDiscoveryError({ message, status: 0, body: "", notFound: false, ...fields });

/** `truncateUTF8Bytes`: at most `max` UTF-8 bytes, without a cut character at the end. */
export const truncateUtf8 = (text: string, max: number): string => {
  const bytes = new TextEncoder().encode(text);

  if (bytes.length <= max) return text;

  return new TextDecoder().decode(bytes.subarray(0, max)).replace(/\uFFFD+$/u, "");
};

/** `retryAfterFromHeaders`: delta seconds or an HTTP date in the future. */
const retryAfterOf = (header: string | null, now: number): number | undefined => {
  const raw = (header ?? "").trim();

  if (raw === "") return undefined;

  if (/^-?\d+$/.test(raw)) return Number(raw) < 0 ? undefined : Number(raw) * 1000;
  const date = Date.parse(raw);

  return Number.isNaN(date) || date - now <= 0 ? undefined : date - now;
};

interface DiscoveryReply {
  readonly status: number;
  readonly text: string;
  readonly retryAfterMs: number | undefined;
}

const transportFailure = (error: HttpClientError.HttpClientError): ProjectDiscoveryError =>
  discoveryError(`execute request: ${error.reason._tag}`);

/** One discovery call: 2xx bodies over 1 MiB fail, error bodies are read up to 64 KiB (CLIProxyAPI 91ccf284). */
const discoveryCall = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<DiscoveryReply, ProjectDiscoveryError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request).pipe(Effect.mapError(transportFailure));
    const ok = response.status >= 200 && response.status < 300;

    const read = yield* readBoundedText(
      response,
      ok ? MAX_RESPONSE_BYTES : MAX_ERROR_BODY_BYTES,
    ).pipe(Effect.mapError(transportFailure));

    if (ok && read.overflow)
      return yield* discoveryError(
        `read response: response body exceeds ${MAX_RESPONSE_BYTES} bytes`,
      );
    const now = yield* Clock.currentTimeMillis;

    return {
      status: response.status,
      text: read.text,
      retryAfterMs: retryAfterOf(response.headers["retry-after"] ?? null, now),
    };
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(discoveryError("execute request: timeout")),
    }),
  );

const statusFailure = (prefix: string, reply: DiscoveryReply): ProjectDiscoveryError =>
  discoveryError(`${prefix}: ${truncateUtf8(reply.text.trim(), MAX_ERROR_MESSAGE_BYTES)}`, {
    status: reply.status,
    body: reply.text,
    ...(reply.retryAfterMs === undefined ? {} : { retryAfterMs: reply.retryAfterMs }),
  });

/** `onboardOperationHTTPStatus`: the HTTP status of a finished operation's `error`, `0` when it names none. */
const operationStatus = (code: number, status: string): number => {
  const upper = status.toUpperCase();

  if (code === 7 || code === 403 || upper === "PERMISSION_DENIED") return 403;

  if (code === 8 || code === 429 || upper === "RESOURCE_EXHAUSTED") return 429;

  if (code === 16 || code === 401 || upper === "UNAUTHENTICATED") return 401;

  return 0;
};

/** `onboardOperationError` (CLIProxyAPI 204be8b9): the `error` of a finished onboarding operation, if any. */
const operationError = (raw: Json | undefined, body: string): ProjectDiscoveryError | undefined => {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw === "string")
    return raw.trim() === ""
      ? undefined
      : discoveryError(`onboard user operation error: ${raw.trim()}`);

  if (!isJsonObject(raw))
    return discoveryError(`onboard user operation error: ${JSON.stringify(raw)}`);

  if (Object.keys(raw).length === 0) return undefined;
  const code = typeof raw.code === "number" ? Math.trunc(raw.code) : 0;
  const status = str(raw.status);
  const message = str(raw.message);

  const parts = [
    ...(code === 0 ? [] : [`code ${code}`]),
    ...(status === "" ? [] : [status]),
    ...(message === "" ? [] : [message]),
  ];

  const text =
    parts.length > 0
      ? `onboard user operation error (${parts.join(": ")})`
      : `onboard user operation error: ${JSON.stringify(raw)}`;

  const httpStatus = operationStatus(code, status);

  return httpStatus > 0 ? discoveryError(text, { status: httpStatus, body }) : discoveryError(text);
};

/**
 * `OnboardUser`: polls `onboardUser` (2 s apart, 5 attempts) until the operation is done; no wait after the last
 * attempt (CLIProxyAPI 91ccf284).
 */
const onboardUser = (
  accessToken: string,
  tierId: string,
): Effect.Effect<string, ProjectDiscoveryError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = `${ANTIGRAVITY_DAILY_API_ENDPOINT}/${API_VERSION}:onboardUser`;

    const body = {
      tier_id: tierId,
      metadata: { ide_type: "ANTIGRAVITY", ide_version: CLIENT_VERSION, ide_name: "antigravity" },
    };

    for (let attempt = 1; attempt <= ONBOARD_ATTEMPTS; attempt++) {
      const reply = yield* discoveryCall(
        jsonPost(url, accessToken, NODE_USER_AGENT, body, {
          extra: { "x-goog-api-client": GOOG_API_CLIENT },
        }),
      );

      if (reply.status !== 200) return yield* statusFailure(`http ${reply.status}`, reply);
      const data = parseJsonObject(reply.text);

      if (data === undefined) return yield* discoveryError("decode response: invalid JSON");

      if (data.done === true) {
        const failed = operationError(data.error, reply.text);

        if (failed !== undefined) return yield* failed;
        const project = isJsonObject(data.response) ? extractProject(data.response) : "";

        return project !== ""
          ? project
          : yield* discoveryError(`${PROJECT_NOT_FOUND}: no project_id in response`, {
              notFound: true,
            });
      }

      if (attempt < ONBOARD_ATTEMPTS) yield* Effect.sleep("2 seconds");
    }

    return yield* discoveryError(
      `onboard user did not complete after ${ONBOARD_ATTEMPTS} attempts`,
    );
  });

/**
 * `FetchProjectID`: `loadCodeAssist`, falling back to onboarding the user. An HTTP failure keeps its status,
 * `Retry-After` and body (CLIProxyAPI 204be8b9); discovery without a project fails with `notFound`.
 */
export const fetchProjectId = (
  accessToken: string,
): Effect.Effect<string, ProjectDiscoveryError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = `${ANTIGRAVITY_DAILY_API_ENDPOINT}/${API_VERSION}:loadCodeAssist`;

    const reply = yield* discoveryCall(
      jsonPost(
        url,
        accessToken,
        SHORT_USER_AGENT,
        { metadata: { ideType: "ANTIGRAVITY" } },
        { accept: false },
      ),
    );

    if (reply.status < 200 || reply.status >= 300)
      return yield* statusFailure(`request failed with status ${reply.status}`, reply);

    const data = parseJsonObject(reply.text);

    if (data === undefined) return yield* discoveryError("decode response: invalid JSON");
    const project = extractProject(data);

    if (project !== "") return project;
    const onboarded = yield* onboardUser(accessToken, defaultTierId(data));

    return onboarded.trim() !== ""
      ? onboarded
      : yield* discoveryError(`${PROJECT_NOT_FOUND} in loadCodeAssist or onboardUser response`, {
          notFound: true,
        });
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

      // A login without a project would store a credential that cannot serve (CLIProxyAPI d214f881).
      const projectId = yield* fetchProjectId(accessToken).pipe(
        Effect.map((project) => project.trim()),
        Effect.catch(() => Effect.succeed("")),
      );

      if (projectId === "") return yield* flowFailure("Failed to fetch project ID");

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

      metadata.project_id = projectId;

      return { fileName: antigravityFileName(email), metadata };
    }),
});
