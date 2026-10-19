/**
 * Authentication on Commissary Cloud (ADR 0026), the counterpart of `access-gate.ts`: no Access application sits in
 * front of the Worker, so Access JWTs and Access service tokens are accepted nowhere. New in the Workers port.
 *
 * - The client API takes API keys only. A key of a suspended org or person is refused. Each org's requests are
 *   rate-limited by its plan, which is Billing's (`@commissary/billing`, called by the API Worker's gate after this one).
 * - The management API takes management keys (`management-key.ts`, refused for a suspended org or issuer), like a
 *   self-hosted Commissary.
 * - The management API and the panel take the session cookie of a person signed in with Better Auth, which the auth
 *   Worker looks up ({@link SignInSessions}, over its RPC, ADR 0030): the same verified email Access yields on a
 *   self-hosted Commissary, so roles, the person-to-orgs index and caller scopes work unchanged. The auth Worker signs
 *   a person up when their sign-in starts a session (`ensureSignedUp`, `standing.ts`); here the gate only checks their
 *   standing. Platform admins are the people in `PLATFORM_ADMIN_EMAILS` (a verified email);
 *   `PLATFORM_ADMIN_SERVICE_TOKENS` means nothing here.
 */
import { Context, Effect } from "effect";
import { type CurrentOrg, type InternalError, UnauthorizedError } from "@commissary/core";
import { platformAdminLists } from "./access/config.ts";
import { presentedCredentials } from "./api-key.ts";
import { AuthConfig } from "./config.ts";
import type { AuthDirectory } from "./directory.ts";
import {
  type AccessError,
  admitted,
  keyIdentity,
  type ManagementRoute,
  targetOrg,
} from "./gate.ts";
import { managementKeyIdentity, presentedManagementKey } from "./management-key.ts";
import type { AccessIdentity, Principal } from "./principal.ts";
import { requireActivePerson, requireStanding } from "./standing.ts";

/** The answer to a management request without a live session. */
export const NOT_SIGNED_IN = "Not signed in";

/** A signed-in person: Better Auth's user id and their email, which the provider verified. */
export interface SignedInPerson {
  readonly userId: string;
  /** Lowercased. */
  readonly email: string;
}

/**
 * Who a Better Auth session cookie belongs to, as the auth Worker looks it up (its `SignInService.session`, over the
 * app Worker's service binding), on every request, so a session ended by sign-out or suspension stops working at once.
 */
export class SignInSessions extends Context.Service<
  SignInSessions,
  {
    /**
     * The person whose live session `cookie` (the request's `Cookie` header) names; `undefined` without one, for an
     * expired or ended session and an unverified email. A failed lookup fails (a 500), so a broken auth Worker does
     * not pass for a signed-out person.
     */
    readonly person: (cookie: string) => Effect.Effect<SignedInPerson | undefined, InternalError>;
  }
>()("commissary/auth/SignInSessions") {}

/** Authenticates a client API request of Commissary Cloud: an API key of an org and a person in good standing. */
export const hostedClientGate = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
): Effect.Effect<AccessIdentity, AccessError, AuthConfig | AuthDirectory> =>
  Effect.gen(function* () {
    const credentials = presentedCredentials(headers, requestUrl);

    if (credentials.apiKey === undefined)
      return yield* new UnauthorizedError({
        message: credentials.any ? "Invalid API key" : "Missing API key",
      });
    const identity = yield* keyIdentity(credentials.apiKey);

    yield* requireStanding(
      identity.org,
      identity.principal.kind === "key" ? identity.principal.email : undefined,
    );

    return identity;
  });

/** Authenticates a management request of Commissary Cloud (`route`: what the Worker's routes say of it). */
export const hostedManagementGate = (
  headers: Readonly<Record<string, string | undefined>>,
  route: ManagementRoute,
): Effect.Effect<
  AccessIdentity,
  AccessError,
  AuthConfig | AuthDirectory | CurrentOrg | SignInSessions
> =>
  Effect.gen(function* () {
    const managementKey = presentedManagementKey(headers);

    if (managementKey !== undefined) {
      const { identity, key } = yield* managementKeyIdentity(
        managementKey,
        route.slug,
        route.needs,
      );

      yield* requireStanding(key.org, key.ownerEmail);

      return identity;
    }

    const cookie = headers["cookie"] ?? "";

    const person = cookie === "" ? undefined : yield* (yield* SignInSessions).person(cookie);

    if (person === undefined) return yield* new UnauthorizedError({ message: NOT_SIGNED_IN });

    const principal: Principal = {
      kind: "user",
      email: person.email,
      sub: `hosted:${person.userId}`,
    };

    const platformAdmin = platformAdminLists(yield* AuthConfig).adminEmails.has(person.email);
    const org = yield* targetOrg(route.slug, platformAdmin);

    // A platform admin still reaches a suspended org, to look at it and unsuspend it; a suspended person never.
    if (platformAdmin) yield* requireActivePerson(person.email);
    else yield* requireStanding(org, person.email);

    return yield* admitted(principal, org, platformAdmin, route.needs, undefined);
  });
