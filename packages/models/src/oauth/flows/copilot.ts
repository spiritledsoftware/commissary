/**
 * GitHub Copilot login: GitHub's device flow, then the Copilot token exchange.
 *
 * Go source: internal/auth/copilot/client.go (`StartDeviceFlow`, `PollDeviceFlow`, `GetAccount`, `Exchange`,
 * `TrustedAPI`, `Token.API`), sdk/auth/copilot.go (`CompleteCopilotDeviceLogin`: the auth file it writes) and
 * internal/api/handlers/management/auth_files_copilot_oauth.go (`requestCopilotToken`).
 * The credential keeps the GitHub token as `refresh_token` and the short-lived Copilot token as `access_token`, with
 * the trusted inference `base_url` it names. Deviation: a transport failure or 5xx answer of one poll keeps waiting
 * (Go aborts the login), because client polling would otherwise lose the session to a network blip.
 */
import { Effect } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";
import { isJsonObject, type JsonObject } from "@commissary/json";
import { call, type HttpReply, parseJsonObject, rfc3339, seconds, str, tryCall } from "./http.ts";
import { SESSION_TTL_MS } from "../session-store.ts";
import { type DeviceFlow, type FlowFailure, flowFailure } from "./types.ts";

/** The public client id of GitHub's Copilot device flow (no secret: device flows carry none). */
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

const GITHUB_URL = "https://github.com";

const GITHUB_API = "https://api.github.com";

export const COPILOT_DEFAULT_API = "https://api.individual.githubcopilot.com";

const COPILOT_TOKEN_URL = `${GITHUB_API}/copilot_internal/v2/token`;

/** `CLIUserAgent`: the official CLI's agent; Workers report the `linux` platform. */
export const COPILOT_USER_AGENT = "copilot/1.0.114 (linux v24.22.1) term/unknown";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const VERIFICATION_URI = `${GITHUB_URL}/login/device`;

const DEFAULT_INTERVAL_MS = 5_000;

const MAX_DEVICE_SECONDS = 3_600;

const TRUSTED_HOSTS: ReadonlySet<string> = new Set([
  "api.githubcopilot.com",
  "api.individual.githubcopilot.com",
  "api.business.githubcopilot.com",
  "api.enterprise.githubcopilot.com",
]);

/** `TrustedAPI`: inference credentials only go to an https Copilot API origin, with no path, query or userinfo. */
export const isTrustedCopilotApi = (raw: string): boolean => {
  if (!/^https:\/\/[^/?#]+\/?$/i.test(raw)) return false;

  try {
    const url = new URL(raw);

    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      // URL parsing reads a backslash as a slash, so the pattern above alone would let a path through.
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      TRUSTED_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
};

/** `Token.API`: the token's `endpoints.api`, else its `proxy-ep=proxy.<host>` field, else the individual API. */
export const copilotApiBase = (token: JsonObject): string | undefined => {
  const api = isJsonObject(token.endpoints) ? str(token.endpoints.api) : "";

  if (api !== "") return isTrustedCopilotApi(api) ? new URL(api).origin : undefined;

  for (const part of str(token.token).split(";")) {
    if (part.startsWith("proxy-ep=proxy.")) {
      const base = `https://api.${part.slice("proxy-ep=proxy.".length)}`;

      return isTrustedCopilotApi(base) ? base : undefined;
    }
  }

  return COPILOT_DEFAULT_API;
};

/** `RequestJSON`'s headers: the CLI's user agent, JSON answers, the bearer when given. */
const githubRequest = (
  request: HttpClientRequest.HttpClientRequest,
  bearer?: string,
): HttpClientRequest.HttpClientRequest => {
  const headed = request.pipe(
    HttpClientRequest.setHeaders({ "user-agent": COPILOT_USER_AGENT, accept: "application/json" }),
  );

  return bearer === undefined ? headed : headed.pipe(HttpClientRequest.bearerToken(bearer));
};

const formPost = (url: string, params: Record<string, string>) =>
  githubRequest(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUrlParams(params)));

/** A 2xx JSON object, else a failure in Go's `copilot: upstream HTTP <status>` / invalid JSON wording. */
const jsonReply = (reply: HttpReply): Effect.Effect<JsonObject, FlowFailure> => {
  if (reply.status < 200 || reply.status >= 300)
    return Effect.fail(flowFailure(`copilot: upstream HTTP ${reply.status}`));
  const parsed = parseJsonObject(reply.text);

  return parsed === undefined
    ? Effect.fail(flowFailure("copilot: invalid upstream JSON"))
    : Effect.succeed(parsed);
};

/** `Exchange`: trades a GitHub token for a Copilot token (`token`, `expires_at` in epoch seconds, `endpoints`). */
export const exchangeCopilotToken = (
  githubToken: string,
  now: number,
): Effect.Effect<
  { readonly token: string; readonly expiresAt: number; readonly baseUrl: string },
  FlowFailure,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const payload = yield* jsonReply(
      yield* call(githubRequest(HttpClientRequest.get(COPILOT_TOKEN_URL), githubToken)),
    );

    const token = str(payload.token);
    const expiresAt = seconds(payload.expires_at);

    if (token === "" || expiresAt * 1000 <= now)
      return yield* flowFailure("copilot: invalid token response");
    const baseUrl = copilotApiBase(payload);

    if (baseUrl === undefined) return yield* flowFailure("copilot: untrusted API endpoint");

    return { token, expiresAt: Math.trunc(expiresAt), baseUrl };
  });

const authFailed = (reason: string) => flowFailure(`Authentication failed: ${reason}`);

export const copilotFlow = (): DeviceFlow => ({
  kind: "device",
  provider: "copilot",
  expiredMessage: "Authentication failed: copilot: GitHub device authorization failed or expired",
  saveMessage: "Failed to save token to file",
  startFailureMessage: "failed to start device authorization flow",
  start: () =>
    Effect.gen(function* () {
      const device = yield* jsonReply(
        yield* call(
          formPost(`${GITHUB_URL}/login/device/code`, {
            client_id: COPILOT_CLIENT_ID,
            scope: "read:user",
          }),
        ),
      );

      const deviceCode = str(device.device_code);
      const userCode = str(device.user_code);
      const expiresIn = Math.trunc(seconds(device.expires_in));
      const interval = Math.trunc(seconds(device.interval));

      if (
        deviceCode === "" ||
        userCode === "" ||
        str(device.verification_uri) !== VERIFICATION_URI ||
        expiresIn <= 0 ||
        expiresIn > MAX_DEVICE_SECONDS ||
        interval > MAX_DEVICE_SECONDS
      ) {
        return yield* flowFailure("copilot: invalid device authorization response");
      }

      const intervalMs = interval > 0 ? interval * 1000 : DEFAULT_INTERVAL_MS;
      // `requestCopilotToken`: the login cannot outlive its session.
      const windowSeconds = Math.min(expiresIn, SESSION_TTL_MS / 1000);

      return {
        url: VERIFICATION_URI,
        userCode,
        expiresIn: windowSeconds,
        data: { device_code: deviceCode } satisfies JsonObject,
        intervalMs,
        // Go waits one interval before the first poll.
        firstPollDelayMs: intervalMs,
        windowMs: windowSeconds * 1000,
      };
    }),
  poll: ({ data, now, intervalMs }) =>
    Effect.gen(function* () {
      const reply = yield* tryCall(
        formPost(`${GITHUB_URL}/login/oauth/access_token`, {
          client_id: COPILOT_CLIENT_ID,
          device_code: str(data.device_code),
          grant_type: DEVICE_GRANT,
        }),
      );

      if (reply === undefined || reply.status >= 500) return { _tag: "pending" as const };
      const payload = yield* jsonReply(reply).pipe(Effect.mapError((e) => authFailed(e.message)));
      const githubToken = str(payload.access_token);

      if (githubToken === "") {
        switch (str(payload.error)) {
          case "authorization_pending":
            return { _tag: "pending" as const };
          case "slow_down":
            return { _tag: "pending" as const, intervalMs: intervalMs + DEFAULT_INTERVAL_MS };
          case "access_denied":
            return yield* authFailed("copilot: GitHub device authorization denied");
          default:
            return yield* authFailed("copilot: GitHub device authorization failed or expired");
        }
      }

      // `GetAccount`: the numeric GitHub id names the file, so a re-login replaces the same account's credential.
      const account = yield* call(
        githubRequest(HttpClientRequest.get(`${GITHUB_API}/user`), githubToken),
      ).pipe(
        Effect.flatMap(jsonReply),
        Effect.mapError((e) => authFailed(e.message)),
      );

      const accountId = Math.trunc(seconds(account.id));

      if (accountId <= 0) return yield* authFailed("copilot: missing GitHub account ID");
      const login = str(account.login);

      const exchanged = yield* exchangeCopilotToken(githubToken, now).pipe(
        Effect.mapError((e) => authFailed(e.message)),
      );

      const metadata: JsonObject = {
        type: "copilot",
        account_id: String(accountId),
        username: login,
        access_token: exchanged.token,
        refresh_token: githubToken,
        base_url: exchanged.baseUrl,
        expired: rfc3339(exchanged.expiresAt * 1000),
        last_refresh: rfc3339(now),
      };

      return {
        _tag: "done" as const,
        record: { fileName: `copilot-${accountId}.json`, metadata },
      };
    }),
});
