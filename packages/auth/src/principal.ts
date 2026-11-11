// Mirrors CallerScope in sdk/cliproxy/session/identity.go (sha256 of a versioned prefix + caller credential).
// The Go `userApiKey` is replaced by the Cloudflare Access principal.
import { Context, Effect } from "effect";
import type { OrgRole } from "@commissary/contract/members";
import { GLOBAL_ORG, type OrgId } from "@commissary/core";

/**
 * The authenticated caller: a person (an Access user, or on Commissary Cloud a person signed in with Better Auth: their
 * verified email), an Access service token (client id), an API key a member presented on a client API route (ADR 0022,
 * `api-key.ts`; never on a management route), a management key a script presented on the management API (ADR
 * 0026, `management-key.ts`; never on a client API route).
 */
export type Principal =
  | { readonly kind: "user"; readonly email: string; readonly sub: string }
  | { readonly kind: "service"; readonly commonName: string }
  | {
      readonly kind: "key";
      readonly keyId: string;
      /** The member the key belongs to, and their email at the time it was verified. */
      readonly memberId: string;
      readonly email: string;
    }
  | {
      readonly kind: "mkey";
      readonly keyId: string;
      readonly name: string;
      /** The person who issued it, when a person did: their suspension refuses it on Commissary Cloud. */
      readonly ownerEmail?: string;
    };

/**
 * A principal that is a member of an org, or may become one: anything but a management key, which belongs to its org.
 */
export type AdmissiblePrincipal = Exclude<Principal, { readonly kind: "mkey" }>;

/** A verified principal plus the identifiers derived from it. */
export interface AccessIdentity {
  readonly principal: Principal;
  /**
   * Stable text identity for usage records and audit: `user:<lowercased email>`, `service:<common_name>`,
   * `key:<key id>` or `mkey:<key id>`.
   */
  readonly principalId: string;
  /**
   * Irreversible namespace used to isolate session state between callers (`callerScope(principalId, org)`). An API
   * key takes its member's scope (`user:<email>`), so one member's tools share session state.
   */
  readonly callerScope: string;
  /** The org the request is for: the org addressed by a management URL, otherwise the request's `CurrentOrg`. */
  readonly org: OrgId;
  /** The principal is a platform admin (`PLATFORM_ADMIN_*`, or the local dev bypass): it may manage every org. */
  readonly platformAdmin: boolean;
  /**
   * The principal's role in `org` (ADR 0022): `owner` for a platform admin, absent on a platform-level route for a
   * principal that belongs to no org there (the Worker's role table, `management/policy.ts`).
   */
  readonly role?: OrgRole | undefined;
  /** The member id of a person who belongs to `org` (usage records' `member_id`); absent for a service token. */
  readonly memberId?: string | undefined;
}

/**
 * The authenticated principal of the current request.
 *
 * Provided by the Worker's Access gate for every request under a protected prefix (`management/zones.ts`); handlers
 * for `/v1*`, `/v1beta*`, `/openai/v1*`, `/backend-api/codex*` and `/v9/management*` can `yield* AccessPrincipal`.
 */
export class AccessPrincipal extends Context.Service<AccessPrincipal, AccessIdentity>()(
  "commissary/auth/AccessPrincipal",
) {}

export const principalId = (principal: Principal): string => {
  switch (principal.kind) {
    case "user":
      return `user:${principal.email.toLowerCase()}`;
    case "service":
      return `service:${principal.commonName}`;
    case "key":
      return `key:${principal.keyId}`;
    case "mkey":
      return `mkey:${principal.keyId}`;
  }
};

/** What the caller scope is derived from: the principal, or the member an API key belongs to. */
const scopeSource = (principal: Principal): string =>
  principal.kind === "key" ? `user:${principal.email.toLowerCase()}` : principalId(principal);

const CALLER_SCOPE_PREFIX = "cli-proxy-api:caller-scope:v1\u0000";

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * `sha256("cli-proxy-api:caller-scope:v1\x00" + value)` as lowercase hex in the org `global` (like Go, so the sessions
 * from before orgs existed keep their scope), `sha256("cli-proxy-api:caller-scope:v1\x00org:<org>\x00" + value)` in
 * any other org (ADR 0021). Empty for a blank value (like Go).
 */
export const callerScope = (value: string, org: OrgId): Effect.Effect<string> => {
  const trimmed = value.trim();

  if (trimmed === "") return Effect.succeed("");
  const scoped = org === GLOBAL_ORG ? trimmed : `org:${org}\u0000${trimmed}`;

  return Effect.promise(async () =>
    toHex(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CALLER_SCOPE_PREFIX + scoped)),
    ),
  );
};

/**
 * The identity of `principal` in `org`; `platformAdmin` when it is on the platform admin lists (an owner of every org),
 * `membership` its place in the org otherwise.
 */
export const makeIdentity = (
  principal: Principal,
  org: OrgId,
  platformAdmin = false,
  membership?: { readonly role: OrgRole; readonly memberId?: string | undefined },
): Effect.Effect<AccessIdentity> =>
  Effect.gen(function* () {
    const id = principalId(principal);
    const role = platformAdmin ? "owner" : membership?.role;

    return {
      principal,
      principalId: id,
      callerScope: yield* callerScope(scopeSource(principal), org),
      org,
      platformAdmin,
      ...(role === undefined ? {} : { role }),
      ...(membership?.memberId === undefined ? {} : { memberId: membership.memberId }),
    };
  });
