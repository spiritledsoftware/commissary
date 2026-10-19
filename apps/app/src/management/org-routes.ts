/**
 * `GET /v9/management/me` and `GET|POST /v9/management/orgs`, `PATCH /v9/management/orgs/:slug` (`OrgsGroup` in
 * @commissary/contract/orgs): who the caller is, and the org list of the Platform registry (`@commissary/state`) with
 * its creation and rename. Workers addition, no Go counterpart.
 *
 * The org list, creation and rename are platform-level: they belong to no org, and only a platform admin
 * (`PLATFORM_ADMIN_*`, `AccessIdentity.platformAdmin`) may use them (`403 platform_admin_required`). `GET /me` is for
 * anyone Access admits and says which orgs the control panel may open (all of them for a platform admin, the orgs the
 * caller is a member of otherwise) and the caller's role in the addressed org. Creating an org only adds it to the
 * registry; its ControlPlane starts empty when first used.
 *
 * On Commissary Cloud (ADR 0026) anyone signed in may create orgs, up to their owned-org limit, and becomes the new org's
 * owner; platform admins suspend and unsuspend orgs through the rename route (`suspended`).
 */
import { Clock, Data, Effect, Match } from "effect";
import { HttpRouter } from "effect/http";
import {
  type AccessIdentity,
  AccessPrincipal,
  AuthConfig,
  forgetStanding,
  isHosted,
  roleAtLeast,
  syncOrgIndex,
} from "@commissary/auth";
import { ownedOrgLimit } from "../hosted/owned-orgs.ts";
import type { JsonObject } from "@commissary/json";
import { deleteSignInAccount, endSessions } from "../hosted/sign-in.ts";
import { apiOrigin } from "../http/hosts.ts";
import { deploymentOf } from "./deployment.ts";
import { GLOBAL_ORG, newOrgId, handled, jsonReply, replyError, type Reply } from "@commissary/core";
import {
  controlPlane,
  controlPlaneOf,
  type OrgRecord,
  type OrgWriteResult,
  platform,
  type PlatformStub,
  StateEnv,
  bodyObject,
} from "@commissary/state";
import { deleteOrg as deleteOrgData } from "../platform/org-deletion.ts";
import type { OrgView } from "@commissary/contract/orgs";
import { AppEnv } from "../worker-env.ts";
import {
  exportSection as modelsExportSection,
  orgDeletionStep as modelsOrgDeletionStep,
} from "@commissary/models/management";

const BASE = "/v9/management";

/** Calls the Platform registry; a failed RPC is logged and answered with 502. */
export const registry = <R>(
  label: string,
  call: (stub: PlatformStub) => R,
): Effect.Effect<Awaited<R>, Reply, StateEnv> =>
  platform(label, call).pipe(
    Effect.catchTag("PlatformUnavailable", (error) =>
      Effect.logError(`management ${error.message}`).pipe(
        Effect.andThen(Effect.fail(replyError(502, "platform registry unavailable"))),
      ),
    ),
  );

const view = (org: OrgRecord): OrgView => ({
  id: org.id,
  slug: org.slug,
  name: org.name,
  created_at: new Date(org.createdAt).toISOString(),
  usage_retention_days: org.usageRetentionDays,
  ...(org.suspendedAt === undefined ? {} : { suspended: true }),
});

/**
 * The orgs the caller may open in the panel: every org for a platform admin; for anyone else the orgs the Platform
 * registry indexes them in (ADR 0022), and the org of the request when the gate admitted them there.
 */
export const openableOrgs = (
  identity: AccessIdentity,
): Effect.Effect<ReadonlyArray<OrgRecord>, Reply, StateEnv> =>
  Effect.gen(function* () {
    if (identity.platformAdmin) return yield* registry("listOrgs", (stub) => stub.listOrgs());
    const { principal } = identity;

    // A management key belongs to its org alone: the org of the request, added below.
    const indexed: ReadonlyArray<OrgRecord> = yield* Match.value(principal).pipe(
      Match.discriminatorsExhaustive("kind")({
        mkey: () => Effect.succeed([]),
        service: (service) =>
          registry("orgOfServiceToken", (stub) => stub.orgOfServiceToken(service.commonName)).pipe(
            Effect.map((org) => (org === undefined ? [] : [org])),
          ),
        user: (person) => registry("orgsOfEmail", (stub) => stub.orgsOfEmail(person.email)),
        key: (key) => registry("orgsOfEmail", (stub) => stub.orgsOfEmail(key.email)),
      }),
    );

    if (identity.role === undefined || indexed.some((org) => org.id === identity.org))
      return indexed;
    const current = yield* registry("getOrgById", (stub) => stub.getOrgById(identity.org));

    return current === undefined ? indexed : [...indexed, current];
  });

const requirePlatformAdmin = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  if (!identity.platformAdmin)
    return yield* replyError(403, "platform_admin_required", {
      message: "only a platform admin (PLATFORM_ADMIN_*) can manage the list of orgs",
    });
});

/** On Commissary Cloud, how many orgs a person (not a platform admin) owns and may own. */
const ownedOrgs = (identity: AccessIdentity) =>
  Effect.gen(function* () {
    const { principal } = identity;

    if (!isHosted(yield* AuthConfig) || identity.platformAdmin || principal.kind !== "user")
      return {};

    const limit = ownedOrgLimit(yield* AppEnv);
    const person = yield* registry("person", (stub) => stub.person(principal.email, limit));

    return { org_limit: person.orgLimit, owned_orgs: person.ownedOrgs };
  });

const me = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const orgs = yield* openableOrgs(identity);
  const api = apiOrigin(yield* AppEnv);

  const settings =
    identity.role === undefined
      ? undefined
      : yield* controlPlane("membershipSettings", (stub) => stub.membershipSettings());

  return jsonReply(200, {
    platform_admin: identity.platformAdmin,
    role: identity.role ?? null,
    orgs: orgs.map((org) => ({ slug: org.slug, name: org.name })),
    deployment: deploymentOf(yield* AuthConfig, yield* AppEnv),
    ...(settings === undefined ? {} : { private_credentials: settings.privateCredentials }),
    ...(yield* ownedOrgs(identity)),
    ...(api === undefined ? {} : { api_url: api }),
  });
});

const list = Effect.gen(function* () {
  yield* requirePlatformAdmin;
  const orgs = yield* registry("listOrgs", (stub) => stub.listOrgs());

  return jsonReply(200, { orgs: orgs.map(view) });
});

interface OrgFields {
  slug?: string;
  name?: string;
}

/** A body with only the allowed string fields; `400 invalid body` for anything else. */
const stringFields = (
  body: JsonObject,
  allowed: ReadonlyArray<keyof OrgFields>,
): Effect.Effect<OrgFields, Reply> => {
  const fields: OrgFields = {};

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;

    const known = key === "slug" || key === "name";

    if (!known || !allowed.includes(key) || typeof value !== "string") {
      return Effect.fail(replyError(400, "invalid body"));
    }

    fields[key] = value;
  }

  return Effect.succeed(fields);
};

/** The refusal of a registry write, as the response the contract names. */
const refused = (result: Extract<OrgWriteResult, { ok: false }>): Reply =>
  Match.value(result.error).pipe(
    Match.when("slug_taken", () => replyError(409, "slug_taken", { message: result.message })),
    Match.when("org_limit_reached", () =>
      replyError(409, "org_limit_reached", { message: result.message }),
    ),
    Match.when("not_found", () => replyError(404, "org_not_found", { message: result.message })),
    Match.orElse((error) => replyError(422, error, { message: result.message })),
  );

/**
 * Who may create an org: a platform admin; on Commissary Cloud also a person signed in, who becomes its owner and counts
 * it against their owned-org limit. `undefined` for a platform admin.
 */
const creator = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const { principal } = identity;

  if (identity.platformAdmin) return undefined;

  if (!isHosted(yield* AuthConfig) || principal.kind !== "user") return yield* requirePlatformAdmin;

  return { email: principal.email.toLowerCase(), defaultLimit: ownedOrgLimit(yield* AppEnv) };
});

const create = Effect.gen(function* () {
  const person = yield* creator;
  const body = yield* bodyObject;
  const { private_credentials: privateCredentials, ...named } = body;

  if (privateCredentials !== undefined && typeof privateCredentials !== "boolean")
    return yield* replyError(400, "invalid body");
  const { slug, name } = yield* stringFields(named, ["slug", "name"]);

  if (slug === undefined || name === undefined) return yield* replyError(400, "invalid body");
  const now = yield* Clock.currentTimeMillis;
  const id = newOrgId();
  const env = yield* StateEnv;

  // The creator chooses whether members of the new org may connect private credentials (off unless asked). The org's
  // ControlPlane takes the choice before the org exists in the registry: a failure here creates nothing (a retry is safe),
  // and an org that does exist never has a different setting than the one chosen. A refused registry write leaves the
  // unreachable ControlPlane of an id nobody holds, which has no slug and is never addressed.
  if (privateCredentials === true) {
    yield* Effect.tryPromise({
      try: async () =>
        await controlPlaneOf(env, id).setMembershipSettings({ privateCredentials: true }),
      catch: () => replyError(502, "control plane unavailable"),
    });
  }

  // A person creating an org owns it; the same applies to an org refused by the registry, which nobody reaches.
  if (person !== undefined) {
    const added = yield* Effect.tryPromise({
      try: async () =>
        await controlPlaneOf(env, id).addMember(
          { email: person.email, role: "owner" },
          { role: "owner", sensitive: false },
          person.email,
        ),
      catch: () => replyError(502, "control plane unavailable"),
    });

    if (!added.ok) return yield* replyError(502, "control plane unavailable");
  }

  const result = yield* registry("createOrg", (stub) =>
    stub.createOrg({ slug, name, id, ...(person === undefined ? {} : { createdBy: person }) }, now),
  );

  if (!result.ok) return yield* refused(result);

  if (person !== undefined) yield* syncOrgIndex(id);

  return jsonReply(201, view(result.org));
});

/**
 * Suspends or unsuspends an org of Commissary Cloud: its members are signed out, its keys refused (`@commissary/auth` `standing.ts`
 * forgets what this isolate knew at once; other isolates within `STANDING_TTL_MS`).
 */
const suspendOrg = (slug: string, suspended: boolean) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const result = yield* registry("setOrgSuspended", (stub) =>
      stub.setOrgSuspended(slug, suspended, now),
    );

    if (!result.ok) return yield* refused(result);
    const { org } = result;
    forgetStanding({ org: org.id });

    if (suspended) {
      const emails = yield* registry("emailsOfOrg", (stub) => stub.emailsOfOrg(org.id));
      const ended = yield* endSessions(emails);

      yield* Effect.logInfo("org suspended").pipe(
        Effect.annotateLogs({ org: org.id, sessionsEnded: ended }),
      );
    }

    return org;
  });

const update = Effect.gen(function* () {
  yield* requirePlatformAdmin;
  const hosted = isHosted(yield* AuthConfig);
  const { slug: current } = yield* HttpRouter.params;
  const body = yield* bodyObject;
  const { suspended, ...renamed } = body;

  // Suspension exists on Commissary Cloud only; elsewhere the field is an unknown one.
  if (suspended !== undefined && (!hosted || typeof suspended !== "boolean"))
    return yield* replyError(400, "invalid body");
  const patch = yield* stringFields(renamed, ["slug", "name"]);

  if (
    current === undefined ||
    (patch.slug === undefined && patch.name === undefined && suspended === undefined)
  )
    return yield* replyError(400, "invalid body");

  const renamedOrg =
    patch.slug === undefined && patch.name === undefined
      ? undefined
      : yield* registry("updateOrg", (stub) => stub.updateOrg(current, patch));

  if (renamedOrg !== undefined && !renamedOrg.ok) return yield* refused(renamedOrg);

  if (typeof suspended === "boolean")
    return jsonReply(200, view(yield* suspendOrg(renamedOrg?.org.slug ?? current, suspended)));

  // Without `suspended`, a slug or a name was given, so the rename ran.
  return renamedOrg === undefined
    ? yield* replyError(400, "invalid body")
    : jsonReply(200, view(renamedOrg.org));
});

/** The org the request addresses, from the registry (`404 org_not_found` when it is no longer listed). */
const addressedOrg = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const org = yield* registry("getOrgById", (stub) => stub.getOrgById(identity.org));

  return org ?? (yield* replyError(404, "org_not_found", { message: "no org has this id" }));
});

const own = addressedOrg.pipe(Effect.map((org) => jsonReply(200, view(org))));

const updateSettings = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const body = yield* bodyObject;
  const days = body["usage_retention_days"];

  if (
    Object.keys(body).some((key) => key !== "usage_retention_days") ||
    (days !== null && typeof days !== "number")
  )
    return yield* replyError(400, "invalid body");

  const result = yield* registry("setUsageRetention", (stub) =>
    stub.setUsageRetention(identity.org, days),
  );

  if (!result.ok) return yield* refused(result);

  return jsonReply(200, view(result.org));
});

const exportOrg = Effect.gen(function* () {
  const org = yield* addressedOrg;
  const now = yield* Clock.currentTimeMillis;
  const members = yield* controlPlane("listMembers", (stub) => stub.listMembers());
  const teams = yield* controlPlane("listTeams", (stub) => stub.listTeams());
  const byId = new Map(members.map((member) => [member.id, member.email]));
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));

  // Each area's section goes through its own view of the ControlPlane.
  const models = yield* modelsExportSection({ members: byId, teams: teamNames });
  const tokens = yield* controlPlane("listServiceTokens", (stub) => stub.listServiceTokens());
  const iso = (at: number) => new Date(at).toISOString();

  return jsonReply(200, {
    exported_at: iso(now),
    org: view(org),
    ...models,
    members: members.map((member) => ({
      email: member.email,
      role: member.role,
      added_at: iso(member.addedAt),
      teams: member.teams.flatMap((id) => teamNames.get(id) ?? []),
    })),
    teams: teams.map((team) => ({
      name: team.name,
      created_at: iso(team.createdAt),
      members: team.members.flatMap((id) => byId.get(id) ?? []),
    })),
    service_tokens: tokens.map((token) => ({
      client_id: token.clientId,
      name: token.name,
      role: token.role,
      added_at: iso(token.addedAt),
    })),
  });
});

/** A deletion that threw: the cause is logged (never with payloads) and the caller is told to try again. */
class DeletionThrew extends Data.TaggedError("DeletionThrew")<{ readonly cause: unknown }> {}

const planeFailed = (label: string, org: string) => (error: DeletionThrew) =>
  Effect.logError(`management ${label} failed`).pipe(
    Effect.annotateLogs({
      org,
      cause: error.cause instanceof Error ? error.cause.message : "unknown error",
    }),
    Effect.andThen(Effect.fail(replyError(502, "control plane unavailable"))),
  );

const deletionFailed = (org: string) => (error: DeletionThrew) =>
  Effect.logError("org deletion failed").pipe(
    Effect.annotateLogs({
      org,
      cause: error.cause instanceof Error ? error.cause.message : "unknown error",
    }),
    Effect.andThen(Effect.fail(replyError(502, "org deletion failed"))),
  );

const signInDeletionFailed = (error: DeletionThrew) =>
  Effect.logError("sign-in account deletion failed").pipe(
    Effect.annotateLogs({
      cause: error.cause instanceof Error ? error.cause.message : "unknown error",
    }),
    Effect.andThen(Effect.fail(replyError(502, "account deletion failed"))),
  );

/** The org-deletion steps of the areas this Worker mounts, in order. */
const areaDeletionSteps = Effect.all([modelsOrgDeletionStep]);

const deleteOrgRoute = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  // Deleting an org is for a person (an org owner or a platform admin), never for a machine: a leaked service token must
  // not be able to wipe an org, whatever role it holds.
  if (identity.principal.kind !== "user")
    return yield* replyError(403, "person_required", {
      message: "only a person can delete an org, not a service token",
    });

  if (!roleAtLeast(identity.role, "owner"))
    return yield* replyError(403, "owner_required", {
      message: "only an org owner or a platform admin can delete the org",
    });

  const body = yield* bodyObject;
  const org = yield* addressedOrg;

  if (Object.keys(body).some((key) => key !== "name") || typeof body["name"] !== "string")
    return yield* replyError(400, "invalid body");

  if (org.id === GLOBAL_ORG)
    return yield* replyError(409, "global_org", {
      message: "the first org holds the deployment's own settings and is never deleted",
    });

  if (body["name"] !== org.name)
    return yield* replyError(422, "name_mismatch", {
      message: "type the org's name exactly to confirm that it is deleted with everything in it",
    });

  const state = yield* StateEnv;
  const steps = yield* areaDeletionSteps;
  const now = yield* Clock.currentTimeMillis;

  const outcome = yield* Effect.tryPromise({
    try: async () => await deleteOrgData(state, steps, org.id, { now }),
    catch: (cause) => new DeletionThrew({ cause }),
  }).pipe(Effect.catch(deletionFailed(org.id)));

  if (outcome.state === "incomplete") {
    yield* Effect.logWarning("org deletion incomplete").pipe(
      Effect.annotateLogs({ org: org.id, step: outcome.step }),
    );

    return yield* replyError(503, "deletion_incomplete", {
      message: "the org still holds data; send the request again",
    });
  }

  if (outcome.state === "refused")
    return yield* replyError(409, outcome.reason === "global" ? "global_org" : "org_not_found", {
      message: outcome.message,
    });

  return jsonReply(200, { deleted: true, id: org.id, slug: org.slug });
});

/**
 * `DELETE /me`: a person deletes their own account (ADR 0027). They leave every org they belong to with everything of
 * theirs; an org they are the only member of is deleted with all it holds; an org they are the only owner of while
 * others belong is not left ownerless: `409 sole_owner` names such orgs and nothing changes. The first org holds the
 * deployment's own settings and is never deleted: a person alone in it only leaves it.
 *
 * On Commissary Cloud (ADR 0026) the sign-in account goes too, after the last org step and before the registry forgets the
 * person: Better Auth's user, its sessions and linked accounts, which the auth Worker deletes (`hosted/sign-in.ts`). Signing in again later is a new
 * sign-up, with a new Personal org. A failed step answers an error and a repeated request picks up where it stopped.
 */
const deleteAccount = Effect.gen(function* () {
  const { principal } = yield* AccessPrincipal;

  if (principal.kind !== "user")
    return yield* replyError(403, "person_required", {
      message: "only a person can delete their account, not a service token",
    });

  const body = yield* bodyObject;
  const confirmed = body["email"];

  if (Object.keys(body).some((key) => key !== "email") || typeof confirmed !== "string")
    return yield* replyError(400, "invalid body");

  const email = principal.email.trim().toLowerCase();

  if (confirmed.trim().toLowerCase() !== email)
    return yield* replyError(422, "email_mismatch", {
      message: "type your own email address to confirm that your account is deleted",
    });

  const state = yield* StateEnv;
  const steps = yield* areaDeletionSteps;
  const now = yield* Clock.currentTimeMillis;
  const orgs = yield* registry("orgsOfEmail", (stub) => stub.orgsOfEmail(email));

  const standings = yield* Effect.forEach(orgs, (org) =>
    Effect.tryPromise({
      try: async () => await controlPlaneOf(state, org.id).accountStanding(email),
      catch: (cause) => new DeletionThrew({ cause }),
    }).pipe(
      Effect.catch(planeFailed("accountStanding", org.id)),
      Effect.map((standing) => ({ org, standing })),
    ),
  );

  const blocking = standings.filter(({ standing }) => standing.soleOwner);

  if (blocking.length > 0)
    return yield* replyError(409, "sole_owner", {
      message:
        "you are the only owner of an org with other members: hand it over to another member first",
      orgs: blocking.map(({ org }) => org.slug),
    });

  const deleted: string[] = [];
  const left: string[] = [];

  for (const { org, standing } of standings) {
    if (standing.alone && org.id !== GLOBAL_ORG) {
      const outcome = yield* Effect.tryPromise({
        try: async () => await deleteOrgData(state, steps, org.id, { now }),
        catch: (cause) => new DeletionThrew({ cause }),
      }).pipe(Effect.catch(deletionFailed(org.id)));

      if (outcome.state === "incomplete")
        return yield* replyError(503, "deletion_incomplete", {
          message: "an org of yours still holds data; send the request again",
        });
      deleted.push(org.slug);
    } else if (standing.member) {
      yield* Effect.tryPromise({
        try: async () => await controlPlaneOf(state, org.id).leaveOrg(email),
        catch: (cause) => new DeletionThrew({ cause }),
      }).pipe(Effect.catch(planeFailed("leaveOrg", org.id)));
      yield* syncOrgIndex(org.id);
      left.push(org.slug);
    }
  }

  if (isHosted(yield* AuthConfig)) {
    yield* deleteSignInAccount(email).pipe(
      Effect.mapError((cause) => new DeletionThrew({ cause })),
      Effect.catch(signInDeletionFailed),
    );
  }

  yield* registry("removePerson", (stub) => stub.removePerson(email));
  forgetStanding({ email });

  return jsonReply(200, { deleted: true, orgs_left: left, orgs_deleted: deleted });
});

export const orgRoutes = [
  HttpRouter.route("DELETE", `${BASE}/me`, handled(deleteAccount)),
  HttpRouter.route("GET", `${BASE}/export`, handled(exportOrg)),
  HttpRouter.route("DELETE", `${BASE}/org`, handled(deleteOrgRoute)),
  HttpRouter.route("GET", `${BASE}/org`, handled(own)),
  HttpRouter.route("PATCH", `${BASE}/org`, handled(updateSettings)),
  HttpRouter.route("GET", `${BASE}/me`, handled(me)),
  HttpRouter.route("GET", `${BASE}/orgs`, handled(list)),
  HttpRouter.route("POST", `${BASE}/orgs`, handled(create)),
  HttpRouter.route("PATCH", `${BASE}/orgs/:slug`, handled(update)),
];
