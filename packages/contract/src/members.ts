/**
 * An org's members, teams and service tokens (ADR 0022; `apps/app/src/management/member-routes.ts`, the ControlPlane's
 * `MemberStore` in `packages/state/src/members`). Workers addition, no Go counterpart. Shared with the browser: imports
 * `effect` only.
 *
 * Every route here is for org admins of the org the request addresses; changing a member's role is for org owners, and
 * giving a service token a role above plain member needs a service token that is an org owner, or a platform admin
 * (ADR 0006's rule per org). The permission matrix is in `docs/ACCESS.md`.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";

/** What a member, or a service token, may do in its org (`packages/auth/src/roles.ts`). */
export const OrgRole = Schema.Literals(["owner", "admin", "member"]);

export type OrgRole = typeof OrgRole.Type;

/** A person who belongs to the org. */
export const MemberView = Schema.Struct({
  /** Permanent while the person stays a member; names them in usage filters (`member=<id>`). */
  id: Schema.String,
  /** Lowercased; what Access signs them in with. */
  email: Schema.String,
  role: OrgRole,
  /** ISO time they were added. */
  added_at: Schema.String,
  /** Ids of the teams they are on. */
  teams: Schema.Array(Schema.String),
});

export type MemberView = typeof MemberView.Type;

export const MemberList = Schema.Struct({ members: Schema.Array(MemberView) });

export type MemberList = typeof MemberList.Type;

/** `POST /members`: the person gets access the next time they sign in; no email is sent. `role` defaults to `member`. */
export const AddMember = Schema.Struct({ email: Schema.String, role: Schema.optionalKey(OrgRole) });

export type AddMember = typeof AddMember.Type;

/** `PATCH /members/:id`. */
export const UpdateMember = Schema.Struct({ role: OrgRole });

export type UpdateMember = typeof UpdateMember.Type;

/** A named group of members within the org. */
export const TeamView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  created_at: Schema.String,
  /** Ids of its members. */
  members: Schema.Array(Schema.String),
});

export type TeamView = typeof TeamView.Type;

export const TeamList = Schema.Struct({ teams: Schema.Array(TeamView) });

export type TeamList = typeof TeamList.Type;

/** `POST /teams` and `PATCH /teams/:id`: 1 to 100 characters, unique in the org regardless of case. */
export const TeamName = Schema.Struct({ name: Schema.String });

export type TeamName = typeof TeamName.Type;

/** `POST /teams/:id/members`. */
export const AddTeamMember = Schema.Struct({ member_id: Schema.String });

export type AddTeamMember = typeof AddTeamMember.Type;

/** An Access service token registered to the org with a role, for scripts that use the management API. */
export const ServiceTokenView = Schema.Struct({
  /** The token's Client ID (`….access`), as Access signs it in (`common_name`). */
  client_id: Schema.String,
  name: Schema.String,
  role: OrgRole,
  added_at: Schema.String,
});

export type ServiceTokenView = typeof ServiceTokenView.Type;

export const ServiceTokenList = Schema.Struct({ service_tokens: Schema.Array(ServiceTokenView) });

export type ServiceTokenList = typeof ServiceTokenList.Type;

/** `POST /service-tokens`: a token belongs to one org (`409 service_token_taken` when another org has it). */
export const RegisterServiceToken = Schema.Struct({
  client_id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  /** `member` when left out. */
  role: Schema.optionalKey(OrgRole),
});

export type RegisterServiceToken = typeof RegisterServiceToken.Type;

/** `PATCH /service-tokens/:clientId`. */
export const UpdateServiceToken = Schema.Struct({ role: OrgRole });

export type UpdateServiceToken = typeof UpdateServiceToken.Type;

/**
 * `GET|PATCH /membership`: `auto_join` lets every person Access admits join the org as a plain member on their first
 * request (and admits unregistered service tokens as plain members without storing them). On for `global`, off for new
 * orgs. `private_credentials` lets plain members connect private credentials, and keeps the ones they connected in use
 * (ADR 0023): on for `global`, chosen when an org is created; turning it off disables the private credentials without
 * deleting them. `private_toolkits` lets members add private toolkits, and keeps the ones they added served (ADR 0038),
 * with the same defaults as `private_credentials`; turning it off keeps the private toolkits but serves none of them
 * until it is on again. `private_agents` lets members create private agents, and keeps the ones they created usable
 * (#226, ADR 0040), with the same defaults and the same off behaviour as `private_toolkits` (an org from before it
 * takes its `private_toolkits` value, `global` on). `access_clients` lets the client API accept an Access sign-in
 * (`Cf-Access-Jwt-Assertion` or `cf-access-token`) instead of an API key, for clients set up before API keys
 * (`docs/MIGRATION.md`). An Access sign-in names no org, so it only ever reaches `global`: the setting exists there
 * only (on by default), and other orgs take API keys alone. Changing `auto_join` and `access_clients` is for org
 * owners, `private_credentials`, `private_toolkits` and `private_agents` for org admins.
 */
export const MembershipSettings = Schema.Struct({
  auto_join: Schema.Boolean,
  private_credentials: Schema.Boolean,
  private_toolkits: Schema.Boolean,
  private_agents: Schema.Boolean,
  /** `global` only. */
  access_clients: Schema.optionalKey(Schema.Boolean),
});

export type MembershipSettings = typeof MembershipSettings.Type;

/**
 * `PATCH /membership`: the settings to change (at least one). `access_clients` in an org other than `global` answers
 * `422 access_clients_global_only`.
 */
export const UpdateMembershipSettings = Schema.Struct({
  auto_join: Schema.optionalKey(Schema.Boolean),
  private_credentials: Schema.optionalKey(Schema.Boolean),
  private_toolkits: Schema.optionalKey(Schema.Boolean),
  private_agents: Schema.optionalKey(Schema.Boolean),
  access_clients: Schema.optionalKey(Schema.Boolean),
});

export type UpdateMembershipSettings = typeof UpdateMembershipSettings.Type;

const idParam = { params: { id: Schema.String } };

const memberParams = { params: { id: Schema.String, memberId: Schema.String } };

const clientIdParam = { params: { clientId: Schema.String } };

const Removed = Schema.Struct({ status: Schema.Literal("ok") });

export class MembersGroup extends HttpApiGroup.make("members")
  .add(
    HttpApiEndpoint.get("list", "/members", { success: MemberList, error: managementErrors }),
    /** `409 member_exists`, `422 invalid_email`, `403 owner_required` for a role above member. */
    HttpApiEndpoint.post("add", "/members", {
      payload: AddMember,
      success: MemberView.pipe(HttpApiSchema.status(201)),
      error: managementErrors,
    }),
    /** Org owners only (`403 owner_required`); `409 last_owner` when it would leave the org without an owner. */
    HttpApiEndpoint.patch("update", "/members/:id", {
      ...idParam,
      payload: UpdateMember,
      success: MemberView,
      error: managementErrors,
    }),
    /** Removing an org admin or owner is for org owners; the person loses access on their next request. */
    HttpApiEndpoint.delete("remove", "/members/:id", {
      ...idParam,
      success: Removed,
      error: managementErrors,
    }),
    HttpApiEndpoint.get("settings", "/membership", {
      success: MembershipSettings,
      error: managementErrors,
    }),
    HttpApiEndpoint.patch("updateSettings", "/membership", {
      payload: UpdateMembershipSettings,
      success: MembershipSettings,
      error: managementErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("teams", "/teams", { success: TeamList, error: managementErrors }),
    /** `409 team_exists`, `422 invalid_name`. */
    HttpApiEndpoint.post("createTeam", "/teams", {
      payload: TeamName,
      success: TeamView.pipe(HttpApiSchema.status(201)),
      error: managementErrors,
    }),
    HttpApiEndpoint.patch("renameTeam", "/teams/:id", {
      ...idParam,
      payload: TeamName,
      success: TeamView,
      error: managementErrors,
    }),
    HttpApiEndpoint.delete("deleteTeam", "/teams/:id", {
      ...idParam,
      success: Removed,
      error: managementErrors,
    }),
    HttpApiEndpoint.post("addTeamMember", "/teams/:id/members", {
      ...idParam,
      payload: AddTeamMember,
      success: TeamView,
      error: managementErrors,
    }),
    HttpApiEndpoint.delete("removeTeamMember", "/teams/:id/members/:memberId", {
      ...memberParams,
      success: TeamView,
      error: managementErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("serviceTokens", "/service-tokens", {
      success: ServiceTokenList,
      error: managementErrors,
    }),
    /**
     * A role above member needs a service token that is an org owner, or a platform admin
     * (`403 service_token_owner_required`).
     */
    HttpApiEndpoint.post("registerServiceToken", "/service-tokens", {
      payload: RegisterServiceToken,
      success: ServiceTokenView.pipe(HttpApiSchema.status(201)),
      error: managementErrors,
    }),
    HttpApiEndpoint.patch("updateServiceToken", "/service-tokens/:clientId", {
      ...clientIdParam,
      payload: UpdateServiceToken,
      success: ServiceTokenView,
      error: managementErrors,
    }),
    HttpApiEndpoint.delete("removeServiceToken", "/service-tokens/:clientId", {
      ...clientIdParam,
      success: Removed,
      error: managementErrors,
    }),
  ) {}
