/**
 * The entry points of authentication (#132): {@link authenticateClient} for the client API and
 * {@link authenticateManagement} for the management API and the panel. Each picks the deployment's gate (ADR 0026): the
 * Access gate of a self-hosted Commissary (`access-gate.ts`) or the gate of Commissary Cloud (`hosted-gate.ts`).
 *
 * `headers` must expose lowercased header names; `requestUrl` is the full URL as the client sent it. What a path needs
 * is the Worker's to say, since it owns the routes: the role a management request needs and the org its URL addresses
 * ({@link ManagementRoute}), and whether a request is for the client API at all. Cross-site checks (`csrf.ts`) come
 * before either.
 */
import { Clock, Effect } from "effect";
import { decodeJwt } from "jose";
import { type CurrentOrg, UnauthorizedError } from "@commissary/core";
import { ACCESS_JWT_HEADER, ACCESS_TOKEN_HEADER, accessGate } from "./access-gate.ts";
import { presentedCredentials } from "./api-key.ts";
import type { AccessJwks } from "./access/jwks.ts";
import { AuthConfig } from "./config.ts";
import type { AuthDirectory } from "./directory.ts";
import { type AccessError, admitted, type ManagementRoute } from "./gate.ts";
import { hostedClientGate, hostedManagementGate, type SignInSessions } from "./hosted-gate.ts";
import { isHosted } from "./mode.ts";
import type { AccessIdentity } from "./principal.ts";

/**
 * Authenticates a client API request (`/v1*`, …): an API key, or on a self-hosted Commissary an Access sign-in where
 * the org still takes them from clients. The identity's org is the key's, the request's `CurrentOrg` otherwise.
 */
export const authenticateClient = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
): Effect.Effect<
  AccessIdentity,
  AccessError,
  AuthConfig | AuthDirectory | CurrentOrg | AccessJwks
> =>
  Effect.gen(function* () {
    return isHosted(yield* AuthConfig)
      ? yield* hostedClientGate(headers, requestUrl)
      : yield* accessGate(headers, requestUrl, undefined);
  });

/** The `exp` (seconds) of a token the gate verified at the upgrade; `undefined` when it carries none. */
const tokenExpiry = (token: string): number | undefined => {
  try {
    return decodeJwt(token).exp;
  } catch {
    return undefined;
  }
};

/**
 * Authenticates a client API request again after it was admitted as `upgraded`, while it is still running (a Responses
 * WebSocket, CLIProxyAPI b9bb031d). An API key is verified again, so a revoked key, a withdrawn membership or a
 * suspended person stops at once. An Access sign-in is not verified again (its signature was checked at the upgrade,
 * and a rotated JWKS key says nothing about the person): it is bounded by its token's own `exp`, read from the upgrade's
 * token, after which it is refused with a 401 so the client reconnects with a fresh one, which keeps an identity
 * provider's offboarding within the Access session duration. Before `exp` the revocable state is checked again: the
 * person is still a member of the org, which still takes Access sign-ins from clients.
 */
export const reauthorizeClient = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  upgraded: AccessIdentity,
): Effect.Effect<
  AccessIdentity,
  AccessError,
  AuthConfig | AuthDirectory | CurrentOrg | AccessJwks
> =>
  Effect.gen(function* () {
    const { principal } = upgraded;

    if (
      (principal.kind === "user" || principal.kind === "service") &&
      !isHosted(yield* AuthConfig)
    ) {
      const token =
        headers[ACCESS_JWT_HEADER]?.trim() || headers[ACCESS_TOKEN_HEADER]?.trim() || "";

      const exp = token === "" ? undefined : tokenExpiry(token);

      if (exp !== undefined && (yield* Clock.currentTimeMillis) >= exp * 1000)
        return yield* new UnauthorizedError({ message: "Access token expired" });

      return yield* admitted(principal, upgraded.org, upgraded.platformAdmin, "member", {
        credentialSent: presentedCredentials(headers, requestUrl).any,
      });
    }

    return yield* authenticateClient(headers, requestUrl);
  });

/**
 * Authenticates a management request: a management key, or a person (an Access sign-in, a Commissary Cloud session),
 * or an Access service token on a self-hosted Commissary, with the role `route.needs` in the org `route.slug` addresses
 * (the request's `CurrentOrg` without one).
 */
export const authenticateManagement = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  route: ManagementRoute,
): Effect.Effect<
  AccessIdentity,
  AccessError,
  AuthConfig | AuthDirectory | CurrentOrg | AccessJwks | SignInSessions
> =>
  Effect.gen(function* () {
    return isHosted(yield* AuthConfig)
      ? yield* hostedManagementGate(headers, route)
      : yield* accessGate(headers, requestUrl, route);
  });
