// Mirrors CallerScope in sdk/cliproxy/session/identity.go (sha256 of a versioned prefix + caller credential).
// The Go `userApiKey` is replaced by the Cloudflare Access principal.
import { Context, Effect } from "effect";
import type { ToolScope } from "@commissary/contract/api-keys";
import type { OrgRole } from "@commissary/contract/members";
import { GLOBAL_ORG, type OrgId } from "@commissary/core";

/**
 * Who started an agent run (GLOSSARY "Starter"): a member, for now. Child runs (#229) and runs no one started (#231) come
 * later.
 */
export interface RunStarter {
  readonly kind: "member";
  readonly id: string;
}

/**
 * Whom an agent run acts as (ADR 0040): a private agent's run acts as its member (their reach, private credentials and
 * spend limits), a shared agent's run as the agent itself (its reach is its definition).
 */
export type RunActsAs =
  | { readonly kind: "member"; readonly memberId: string; readonly email: string }
  | { readonly kind: "agent" };

/**
 * What an agent run's definition names, which narrows what it reaches: its one model, as clients name it (any other
 * answers like an unknown one), and its tool scope.
 */
export interface RunReach {
  readonly model: string;
  readonly toolScope: ToolScope;
}

/**
 * The authenticated caller: a person (an Access user, or on Commissary Cloud a person signed in with Better Auth: their
 * verified email), an Access service token (client id), an API key a member presented on a client API route (ADR 0022,
 * `api-key.ts`; never on a management route), a management key a script presented on the management API (ADR
 * 0026, `management-key.ts`; never on a client API route), or a hosted agent's run (#227) calling the client API from
 * its Durable Object. A run principal is never read from a request: the API Worker's run gateway alone presents it,
 * resolved from the org's ControlPlane (docs/ARCHITECTURE.md, "Agents").
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
    }
  | {
      readonly kind: "run";
      readonly runId: string;
      readonly agentId: string;
      readonly starter: RunStarter;
      /** The starter's email: on Commissary Cloud their standing is checked on every request of the run. */
      readonly starterEmail: string;
      readonly actsAs: RunActsAs;
      readonly reach: RunReach;
    };

/**
 * A principal that is a member of an org, or may become one: anything but a management key, which belongs to its org,
 * and an agent run, which its org's ControlPlane resolves.
 */
export type AdmissiblePrincipal = Exclude<Principal, { readonly kind: "mkey" | "run" }>;

/** A verified principal plus the identifiers derived from it. */
export interface AccessIdentity {
  readonly principal: Principal;
  /**
   * Stable text identity for usage records and audit: `user:<lowercased email>`, `service:<common_name>`,
   * `key:<key id>`, `mkey:<key id>` or `run:<run id>`.
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
    case "run":
      return `run:${principal.runId}`;
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

/** An agent run's principal (#227). */
export type RunPrincipal = Extract<Principal, { readonly kind: "run" }>;

/**
 * Whether `principal` is a shared agent's run, which acts as the agent itself (ADR 0040): its reach is its definition,
 * the org's shared credentials and toolkits whatever the grants, with no member behind it.
 */
export const isSharedAgentRun = (
  principal: Principal,
): principal is RunPrincipal & { readonly actsAs: { readonly kind: "agent" } } =>
  principal.kind === "run" && principal.actsAs.kind === "agent";

/** What a usage record says of the agent run it comes from (#227): its agent, the run and its starter, as text. */
export interface UsageRun {
  readonly agentId: string;
  readonly runId: string;
  /** `member:<member id>`. */
  readonly starter?: string;
}

/** The agent run `principal` is, as usage records name it; `undefined` for any other principal. */
export const usageRunOf = (principal: Principal): UsageRun | undefined =>
  principal.kind === "run"
    ? {
        agentId: principal.agentId,
        runId: principal.runId,
        starter: `${principal.starter.kind}:${principal.starter.id}`,
      }
    : undefined;

/**
 * The identity of an agent run in `org` (#227): its own principal (`run:<run id>`), whose usage and session state are
 * its own, acting as its member's for a private agent (`memberId`, so their reach, private credentials and spend
 * limits apply) and as no member for a shared agent. A run holds no role: it is never an org admin.
 */
export const runIdentity = (principal: RunPrincipal, org: OrgId): Effect.Effect<AccessIdentity> =>
  Effect.gen(function* () {
    const id = principalId(principal);

    return {
      principal,
      principalId: id,
      callerScope: yield* callerScope(id, org),
      org,
      platformAdmin: false,
      ...(principal.actsAs.kind === "member" ? { memberId: principal.actsAs.memberId } : {}),
    };
  });

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
