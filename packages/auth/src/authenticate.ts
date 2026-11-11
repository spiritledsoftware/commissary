/**
 * The entry points of authentication (#132): {@link authenticateClient} for the client API and
 * {@link authenticateManagement} for the management API and the panel, and {@link authenticateRun} for a hosted
 * agent's run, which the API Worker's run gateway presents (#227). Each picks the deployment's gate (ADR 0026): the
 * Access gate of a self-hosted Commissary (`access-gate.ts`) or the gate of Commissary Cloud (`hosted-gate.ts`).
 *
 * `headers` must expose lowercased header names; `requestUrl` is the full URL as the client sent it. What a path needs
 * is the Worker's to say, since it owns the routes: the role a management request needs and the org its URL addresses
 * ({@link ManagementRoute}), and whether a request is for the client API at all. Cross-site checks (`csrf.ts`) come
 * before either.
 */
import { Clock, Effect } from "effect";
import { decodeJwt } from "jose";
import { type CurrentOrg, type OrgId, UnauthorizedError } from "@commissary/core";
import { ACCESS_JWT_HEADER, ACCESS_TOKEN_HEADER, accessGate } from "./access-gate.ts";
import { presentedCredentials } from "./api-key.ts";
import type { AccessJwks } from "./access/jwks.ts";
import { AuthConfig } from "./config.ts";
import type { AuthDirectory } from "./directory.ts";
import { type AccessError, admitted, type ManagementRoute } from "./gate.ts";
import { hostedClientGate, hostedManagementGate, type SignInSessions } from "./hosted-gate.ts";
import { isHosted } from "./mode.ts";
import { type AccessIdentity, type RunPrincipal, runIdentity } from "./principal.ts";
import { requireStanding } from "./standing.ts";

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
 * The identity of an agent run of `org` (#227), whose principal the API Worker's run gateway resolved from the org's
 * ControlPlane (never from the request). On Commissary Cloud the org, the run's starter (if anyone started it) and the
 * member a private agent's run acts as must be in good standing, as a key's person must (403 `Suspended`,
 * `standing.ts`): a suspended starter's runs, of shared agents too, are refused at once.
 */
export const authenticateRun = (
  principal: RunPrincipal,
  org: OrgId,
): Effect.Effect<AccessIdentity, AccessError, AuthConfig | AuthDirectory> =>
  Effect.gen(function* () {
    if (isHosted(yield* AuthConfig)) {
      yield* requireStanding(org, principal.starterEmail);

      if (principal.actsAs.kind === "member" && principal.actsAs.email !== principal.starterEmail)
        yield* requireStanding(org, principal.actsAs.email);
    }

    return yield* runIdentity(principal, org);
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
