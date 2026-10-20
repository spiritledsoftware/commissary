/**
 * The orgs of the deployment and what the caller may do with them (`apps/app/src/management/org-routes.ts`, the
 * Platform registry in `packages/state/src/platform`): `GET /me` for the panel's org switcher, and the platform admins' org
 * list, creation and rename. Workers addition, no Go counterpart. Shared with the browser: imports `effect` only.
 *
 * `/orgs` and `/orgs/:slug` are platform-level. Every other management route also exists once per org, as
 * `/v9/management/orgs/<slug>/<route>`; the unscoped spelling means the deployment's first org, `global` (ADR 0021).
 * Only platform admins (`PLATFORM_ADMIN_*`) may list, create and rename orgs: anyone else gets
 * `403 platform_admin_required`. On Commissary Cloud (ADR 0026) anyone signed in may create orgs, up to their owned-org
 * limit (`409 org_limit_reached`), and becomes the new org's owner.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";
import { OrgRole } from "./members.ts";

/** One org of the registry. */
export const OrgView = Schema.Struct({
  /** Permanent; names the org's stored data. */
  id: Schema.String,
  /** Addresses the org in URLs (`/o/<slug>/accounts`); unique, renamable. */
  slug: Schema.String,
  name: Schema.String,
  /** ISO time the org was created. */
  created_at: Schema.String,
  /** How many days the org's usage records are kept; `null`: forever (ADR 0027). */
  usage_retention_days: Schema.NullOr(Schema.Int),
  /** Commissary Cloud: a platform admin suspended it (refused everywhere, nothing deleted). Absent otherwise. */
  suspended: Schema.optionalKey(Schema.Boolean),
});

export type OrgView = typeof OrgView.Type;

export const OrgList = Schema.Struct({ orgs: Schema.Array(OrgView) });

export type OrgList = typeof OrgList.Type;

/**
 * `POST /orgs`: 1-63 lowercase letters, digits and inner hyphens; a display name of up to 100 characters.
 * `private_credentials` chooses whether members may connect private credentials in the new org, `private_toolkits`
 * whether they may add private toolkits (default: no for both).
 */
export const CreateOrg = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  private_credentials: Schema.optionalKey(Schema.Boolean),
  private_toolkits: Schema.optionalKey(Schema.Boolean),
});

export type CreateOrg = typeof CreateOrg.Type;

/**
 * `PATCH /orgs/:slug`: the fields to change. Renaming the slug breaks the old address; the id stays. `suspended` (a
 * Commissary Cloud only) suspends the org, signing its members out, or unsuspends it.
 */
export const UpdateOrg = Schema.Struct({
  slug: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  suspended: Schema.optionalKey(Schema.Boolean),
});

export type UpdateOrg = typeof UpdateOrg.Type;

/**
 * `PATCH /org`: the settings of the addressed org. `usage_retention_days`: whole days from 1 to 3650 that usage records
 * are kept, or `null` to keep them forever.
 */
export const UpdateOrgSettings = Schema.Struct({
  usage_retention_days: Schema.optionalKey(Schema.NullOr(Schema.Int)),
});

export type UpdateOrgSettings = typeof UpdateOrgSettings.Type;

/**
 * `GET /export`: what an org keeps before it is deleted (ADR 0027): the org, its shared config with every secret as a
 * preview, its price overrides, its credentials (summaries without tokens) and who belongs. Usage records are not in
 * it: the usage routes page and export them.
 */
export const OrgExport = Schema.Struct({
  exported_at: Schema.String,
  org: OrgView,
  config: Schema.Unknown,
  prices: Schema.Array(Schema.Unknown),
  credentials: Schema.Array(Schema.Unknown),
  grants: Schema.Array(Schema.Unknown),
  members: Schema.Array(Schema.Unknown),
  teams: Schema.Array(Schema.Unknown),
  service_tokens: Schema.Array(Schema.Unknown),
});

export type OrgExport = typeof OrgExport.Type;

/** `DELETE /me`: the caller's own email, typed again. */
export const DeleteAccount = Schema.Struct({ email: Schema.String });

export const AccountDeleted = Schema.Struct({
  deleted: Schema.Literal(true),
  orgs_left: Schema.Array(Schema.String),
  orgs_deleted: Schema.Array(Schema.String),
});

export type AccountDeleted = typeof AccountDeleted.Type;

/** `DELETE /org`: the org's name, typed again to confirm. */
export const DeleteOrg = Schema.Struct({ name: Schema.String });

export type DeleteOrg = typeof DeleteOrg.Type;

/** `DELETE /org`: the org that is gone. */
export const OrgDeleted = Schema.Struct({
  deleted: Schema.Literal(true),
  id: Schema.String,
  slug: Schema.String,
});

export type OrgDeleted = typeof OrgDeleted.Type;

/** An org the caller belongs to, as the panel's org switcher lists it. */
export const MyOrg = Schema.Struct({ slug: Schema.String, name: Schema.String });

export type MyOrg = typeof MyOrg.Type;

/**
 * Which optional pieces a deployment has (ADR 0043), on every deployment. `hosted`: Commissary Cloud (ADR 0026).
 * `browser`: the deployment has a Browser Run binding (the browser toolkit exists). `computer`: it has the sandbox's
 * container binding (the sandbox's computer exists). The panel decides what to show from it.
 */
export const Deployment = Schema.Struct({
  hosted: Schema.Boolean,
  browser: Schema.Boolean,
  computer: Schema.Boolean,
});

export type Deployment = typeof Deployment.Type;

/**
 * `GET /me`: who the caller is for the panel, which orgs they may open, and their role in the org the request
 * addresses (`/v9/management/orgs/<slug>/me`; `global` for the unscoped spelling).
 */
export const Me = Schema.Struct({
  /** A platform admin is an owner of every org and may create orgs. */
  platform_admin: Schema.Boolean,
  /** The caller's role in the addressed org; `null` when they do not belong to it. */
  role: Schema.NullOr(OrgRole),
  /** Every org for a platform admin; for anyone else the orgs they are a member of. */
  orgs: Schema.Array(MyOrg),
  /**
   * Whether the addressed org lets members connect private credentials (`private_credentials` of `/membership`): the
   * panel offers a plain member their own Accounts page only then. Absent when the caller belongs to no org there.
   */
  private_credentials: Schema.optionalKey(Schema.Boolean),
  /**
   * Whether the addressed org lets members add private toolkits (`private_toolkits` of `/membership`). Absent when the
   * caller belongs to no org there.
   */
  private_toolkits: Schema.optionalKey(Schema.Boolean),
  /** Which optional pieces this deployment has, and whether it is Commissary Cloud. */
  deployment: Deployment,
  /**
   * Present on Commissary Cloud only (ADR 0026): anyone signed in may create orgs, up to `org_limit` orgs of their own
   * (`owned_orgs` so far). A platform admin has no limit (both absent then).
   */
  org_limit: Schema.optionalKey(Schema.Number),
  owned_orgs: Schema.optionalKey(Schema.Number),
  /**
   * Where clients send API keys (`https://<API_DOMAIN>`, ADR 0028) when the deployment serves its client API routes on an
   * API host of their own; absent when the panel's own origin serves them.
   */
  api_url: Schema.optionalKey(Schema.String),
});

export type Me = typeof Me.Type;

const slugParam = { params: { slug: Schema.String } };

export class OrgsGroup extends HttpApiGroup.make("orgs").add(
  /** The caller and the orgs they belong to; anyone Access admits may ask. */
  HttpApiEndpoint.get("me", "/me", { success: Me, error: managementErrors }),
  /**
   * The caller deletes their own account (ADR 0027): they leave every org they belong to with all their data there, and
   * an org they are the only member of is deleted with everything in it. People only. `422 email_mismatch` unless the
   * body names their own email; `409 sole_owner` (with `orgs`) while they are the only owner of an org that has other
   * members; `503 deletion_incomplete` when an org needs the call repeated.
   */
  HttpApiEndpoint.delete("deleteAccount", "/me", {
    payload: DeleteAccount,
    success: AccountDeleted,
    error: managementErrors,
  }),
  /** Every org, `global` (slug `default` at first) leading. Platform admins only. */
  HttpApiEndpoint.get("list", "/orgs", { success: OrgList, error: managementErrors }),
  /**
   * Creates an org with an id of its own. Platform admins only. `422 invalid_slug` / `invalid_name`, `409 slug_taken`.
   */
  HttpApiEndpoint.post("create", "/orgs", {
    payload: CreateOrg,
    success: OrgView.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /** The org the request addresses (`global` for the unscoped route), with its settings. Org admins. */
  HttpApiEndpoint.get("org", "/org", { success: OrgView, error: managementErrors }),
  /**
   * Changes the settings of the addressed org: its usage retention period. Org admins. `422 invalid_retention`.
   */
  HttpApiEndpoint.patch("updateSettings", "/org", {
    payload: UpdateOrgSettings,
    success: OrgView,
    error: managementErrors,
  }),
  /** Downloads what the org keeps, secrets as previews, before it is deleted. Org admins. */
  HttpApiEndpoint.get("export", "/export", { success: OrgExport, error: managementErrors }),
  /**
   * Deletes the addressed org with all its data at once (ADR 0027): usage records, credentials, config, members, API
   * keys, session state and its registry entry; the slug is free to take again. Org owners and platform admins; the
   * body repeats the org's name. `422 name_mismatch`, `409 global_org` (the first org is never deleted), `503
   * deletion_incomplete` (a big org: send the request again until it succeeds).
   */
  HttpApiEndpoint.delete("deleteOrg", "/org", {
    payload: DeleteOrg,
    success: OrgDeleted,
    error: managementErrors,
  }),
  /** Renames an org's name and/or slug. Platform admins only. `404 org_not_found`, plus the errors of `create`. */
  HttpApiEndpoint.patch("update", "/orgs/:slug", {
    ...slugParam,
    payload: UpdateOrg,
    success: OrgView,
    error: managementErrors,
  }),
) {}
