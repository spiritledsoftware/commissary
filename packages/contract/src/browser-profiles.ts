/**
 * Browser profiles (`/v9/management/browser-profiles`, `packages/tools/src/management/routes.ts`; ADR 0039, #215): saved
 * logins and site data (cookies and per-origin storage, a Playwright storage state, sealed with the org's data key) that
 * a browser session of the browser toolkit can start from, and the grants on shared profiles
 * (`/v9/management/grants/profiles`). Shared with the browser: imports `effect`, `./config.ts`, `./errors.ts` and
 * `./grants.ts` only.
 *
 * A profile is created empty and named here; a session fills it: `browser_open` with `profile` starts from it, and
 * `browser_close` with `save` saves the session's state back into it. A profile is not a credential (one holds logins to
 * many sites), and nothing here reads what it holds.
 *
 * - A **shared** profile is created, renamed and removed by org admins only, and the profile grants decide who may use it
 *   (the same subjects as the other grants; there is no default grant, so an org admin needs one too). Only an org admin
 *   saves into it.
 * - A **private** profile is one member's, while the org's `membership.private_toolkits` setting allows private toolkits
 *   (`403 private_toolkits_unavailable` otherwise; turning it off keeps them, but no session opens from one or saves into
 *   one). It needs no grant. An org admin sees only that it exists (`others`: its member, no name) and may remove it.
 *
 * Names are 1-64 of `[a-z0-9_-]`. A shared profile's name is unique among the shared ones; a private one's among its
 * member's and the shared ones, as for toolkits (a shared profile added later with a private one's name is shadowed by
 * it for that member). Renames and removals name the profile's revision in `If-Match`; a save moves `saved_at`, not the
 * revision.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Revision } from "./config.ts";
import { managementErrors } from "./errors.ts";
import { GrantSubject } from "./grants.ts";

const optional = Schema.optionalKey;

/** A browser profile as its manager sees it: a private profile's member, or an org admin for a shared one. */
export const BrowserProfileView = Schema.Struct({
  id: Schema.String,
  /** 1-64 of `[a-z0-9_-]`: what `browser_open` takes as `profile`. */
  name: Schema.String,
  /** A private profile, the caller's own. */
  private: Schema.Boolean,
  /** When a session last saved into it; `null` while it is empty. */
  saved_at: Schema.NullOr(Schema.String),
  revision: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
});

export type BrowserProfileView = typeof BrowserProfileView.Type;

/** A private profile's member. */
export const BrowserProfileOwner = Schema.Struct({
  member_id: Schema.String,
  email: optional(Schema.String),
});

export type BrowserProfileOwner = typeof BrowserProfileOwner.Type;

/** An org admin's view of another member's private profile: that it exists, and whose it is. */
export const LimitedBrowserProfileView = Schema.Struct({
  id: Schema.String,
  private: Schema.Literal(true),
  limited: Schema.Literal(true),
  owner: BrowserProfileOwner,
  created_at: Schema.String,
  /** For the `If-Match` of an org admin's removal. */
  revision: Schema.Int,
});

export type LimitedBrowserProfileView = typeof LimitedBrowserProfileView.Type;

/** `GET /browser-profiles`: the profiles the caller manages; org admins also get the other members' private ones. */
export const BrowserProfilesList = Schema.Struct({
  profiles: Schema.Array(BrowserProfileView),
  others: optional(Schema.Array(LimitedBrowserProfileView)),
});

export type BrowserProfilesList = typeof BrowserProfilesList.Type;

/**
 * `POST /browser-profiles`: an empty profile. A plain member's is always private; an org admin's is shared unless
 * `private` is true.
 */
export const CreateBrowserProfile = Schema.Struct({
  name: Schema.String,
  private: optional(Schema.Boolean),
});

export type CreateBrowserProfile = typeof CreateBrowserProfile.Type;

/** `PATCH /browser-profiles/:id`: renames it. */
export const UpdateBrowserProfile = Schema.Struct({ name: Schema.String });

export type UpdateBrowserProfile = typeof UpdateBrowserProfile.Type;

export const RemovedBrowserProfile = Schema.Struct({
  id: Schema.String,
  removed: Schema.Literal(true),
});

export type RemovedBrowserProfile = typeof RemovedBrowserProfile.Type;

/** What a profile grant says: who may use which shared profile. */
export const BrowserProfileGrantBody = Schema.Struct({
  subject: GrantSubject,
  /** The shared profile's id. */
  profile: Schema.String,
});

export type BrowserProfileGrantBody = typeof BrowserProfileGrantBody.Type;

export const BrowserProfileGrant = Schema.Struct({
  ...BrowserProfileGrantBody.fields,
  id: Schema.String,
  revision: Revision,
  /** Epoch milliseconds. */
  updated_at: Schema.Number,
  /** The principal that wrote it. */
  updated_by: Schema.String,
});

export type BrowserProfileGrant = typeof BrowserProfileGrant.Type;

/** `GET /grants/profiles`: every profile grant of the org. */
export const BrowserProfileGrants = Schema.Struct({ grants: Schema.Array(BrowserProfileGrant) });

export type BrowserProfileGrants = typeof BrowserProfileGrants.Type;

/** A saved profile grant: its `id` and new `revision` (0 when it was removed). */
export const BrowserProfileGrantSaved = Schema.Struct({
  status: Schema.Literal("ok"),
  id: Schema.String,
  revision: Revision,
});

export type BrowserProfileGrantSaved = typeof BrowserProfileGrantSaved.Type;

/** The `If-Match` request header: the revision the edit was based on (a bare number or `"<number>"`). */
const IfMatch = { headers: Schema.Struct({ "if-match": Schema.String }) };

const idParam = { params: { id: Schema.String } };

export class BrowserProfilesGroup extends HttpApiGroup.make("browserProfiles").add(
  HttpApiEndpoint.get("list", "/browser-profiles", {
    success: BrowserProfilesList,
    error: managementErrors,
  }),
  /**
   * `422 invalid` (a name), `409 name_taken`, `403 forbidden` (a private profile by a caller who is no member), `403
   * private_toolkits_unavailable`. A plain member's profile is private whatever `private` says.
   */
  HttpApiEndpoint.post("create", "/browser-profiles", {
    payload: CreateBrowserProfile,
    success: BrowserProfileView.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /** As `create`'s refusals, `409 conflict` for a stale revision, `403 forbidden` for another member's profile. */
  HttpApiEndpoint.patch("update", "/browser-profiles/:id", {
    ...idParam,
    ...IfMatch,
    payload: UpdateBrowserProfile,
    success: BrowserProfileView,
    error: managementErrors,
  }),
  /** Deletes the profile at once (ADR 0027) with its grants; a session open from it can no longer save into it. */
  HttpApiEndpoint.delete("remove", "/browser-profiles/:id", {
    ...idParam,
    ...IfMatch,
    success: RemovedBrowserProfile,
    error: managementErrors,
  }),
) {}

/**
 * Profile grants (`/v9/management/grants/profiles`, ADR 0039): which shared browser profiles a member, a team or everyone
 * may use, beside the model grants (`/grants`), the tool grants (`/grants/tools`) and the agent grants
 * (`/grants/agents`). Org admins only; there is no default grant. Using a profile also takes the browser toolkit's
 * session tools, which tool grants give.
 */
export class BrowserProfileGrantsGroup extends HttpApiGroup.make("browserProfileGrants").add(
  HttpApiEndpoint.get("list", "/grants/profiles", {
    success: BrowserProfileGrants,
    error: managementErrors,
  }),
  /**
   * `409 conflict` when the subject holds a grant of the profile already, `422 invalid` for an unknown subject or
   * shared profile.
   */
  HttpApiEndpoint.post("create", "/grants/profiles", {
    payload: BrowserProfileGrantBody,
    success: BrowserProfileGrantSaved,
    error: managementErrors,
  }),
  HttpApiEndpoint.put("replace", "/grants/profiles/:id", {
    ...idParam,
    ...IfMatch,
    payload: BrowserProfileGrantBody,
    success: BrowserProfileGrantSaved,
    error: managementErrors,
  }),
  HttpApiEndpoint.delete("remove", "/grants/profiles/:id", {
    ...idParam,
    ...IfMatch,
    success: BrowserProfileGrantSaved,
    error: managementErrors,
  }),
) {}
