/**
 * The entry points of authentication (#132): {@link authenticateClient} for the client API,
 * {@link authenticateManagement} for the management API and the panel, and {@link authenticateManagementKey} for the
 * hub API (ADR 0052). Each picks the deployment's gate (ADR 0026): the
 * Access gate of a self-hosted Commissary (`access-gate.ts`) or the gate of Commissary Cloud (`hosted-gate.ts`).
 *
 * `headers` must expose lowercased header names; `requestUrl` is the full URL as the client sent it. What a path needs
 * is the Worker's to say, since it owns the routes: the role a management request needs and the org its URL addresses
 * ({@link ManagementRoute}), and whether a request is for the client API at all. Cross-site checks (`csrf.ts`) come
 * before either.
 */
import { Clock, Effect } from "effect";
import { decodeJwt } from "jose";
import type { OrgRole } from "@commissary/contract/members";
import { type CurrentOrg, ForbiddenError, UnauthorizedError } from "@commissary/core";
import { ACCESS_JWT_HEADER, ACCESS_TOKEN_HEADER, accessGate } from "./access-gate.ts";
import { presentedCredentials } from "./api-key.ts";
import type { AccessJwks } from "./access/jwks.ts";
import { AuthConfig } from "./config.ts";
import { AuthDirectory, directoryFailure } from "./directory.ts";
import { type AccessError, admitted, type ManagementRoute } from "./gate.ts";
import { hostedClientGate, hostedManagementGate, type SignInSessions } from "./hosted-gate.ts";
import { managementKeyInStanding, presentedManagementKey } from "./management-key.ts";
import { isHosted } from "./mode.ts";
import { type AccessIdentity, makeIdentity } from "./principal.ts";
import { lowerRole, roleAtLeast } from "./roles.ts";

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

/** The answer to a hub API request whose management key's issuer is no longer a member of the key's org. */
export const ISSUER_DEPARTED = "Forbidden: the key's issuer is no longer a member of its org";

/**
 * Authenticates a hub API request (ADR 0052): a management key (`Authorization: Bearer cmsm_…`) and nothing else, on
 * every deployment. No Access sign-in, session cookie, API key or dev bypass is taken: `Missing API key` (401) without
 * an `Authorization` header, `Invalid API key` for anything but a live management key. On Commissary Cloud the key's
 * org and issuer must be in good standing, as on the management API.
 *
 * Unlike on the management API, the key acts as the member who issued it (its `ownerEmail`, looked up the way an
 * Access sign-in is, without joining), so that member's private accounts are theirs to reach: the identity carries
 * their member id, and the lower of the key's role and the issuer's current one. A key whose issuer is no longer a
 * member of its org is refused (403). A key nobody issued acts as no member, with its own role.
 */
export const authenticateManagementKey = (
  headers: Readonly<Record<string, string | undefined>>,
  needs: OrgRole,
): Effect.Effect<AccessIdentity, AccessError, AuthConfig | AuthDirectory> =>
  Effect.gen(function* () {
    const text = presentedManagementKey(headers);

    if (text === undefined)
      return yield* new UnauthorizedError({
        message:
          (headers["authorization"] ?? "").trim() === "" ? "Missing API key" : "Invalid API key",
      });

    const { identity, key } = yield* managementKeyInStanding(text, undefined, needs);

    if (key.ownerEmail === undefined) return identity;

    const issuer = yield* (yield* AuthDirectory)
      .admit(key.org, { kind: "user", email: key.ownerEmail }, false, false)
      .pipe(Effect.mapError(directoryFailure("management key issuer lookup")));

    if (issuer === undefined || "apiKeysOnly" in issuer)
      return yield* new ForbiddenError({ message: ISSUER_DEPARTED });

    const role = lowerRole(key.role, issuer.role);

    if (!roleAtLeast(role, needs)) return yield* new ForbiddenError({ message: "Forbidden" });

    return yield* makeIdentity(identity.principal, key.org, false, {
      role,
      memberId: issuer.memberId,
    });
  });
