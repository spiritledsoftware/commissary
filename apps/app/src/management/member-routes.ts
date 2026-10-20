/**
 * `/v9/management/members`, `/membership`, `/teams` and `/service-tokens` (`MembersGroup` in
 * @commissary/contract/members): an org's members, teams and service tokens (ADR 0022). Workers addition, no Go
 * counterpart.
 *
 * The Access gate lets only org admins in (`policy.ts`); the ControlPlane checks each write against the actor's
 * role (`@commissary/state`'s `MemberStore`, `@commissary/auth` `roles.ts`): org admins manage plain members, org owners everyone and every role,
 * and a service token gets a role above member only from a service token that is an org owner, or a platform admin
 * (ADR 0006's rule per org). Changing auto-join is for org owners. After a change of who belongs to the org, the
 * Platform registry's index is brought up to date (`@commissary/auth` `syncOrgIndex`).
 */
import { managementKeyForbidden } from "./management-key-routes.ts";
import { Effect, Schema } from "effect";
import { HttpRouter, type HttpServerResponse } from "effect/http";
import {
  type AccessIdentity,
  AccessPrincipal,
  type Actor,
  holdsSensitivePowers,
  roleAtLeast,
  syncOrgIndex,
} from "@commissary/auth";
import {
  controlPlane,
  type MemberErrorCode,
  type MemberRecord,
  type MemberResult,
  type MembershipSettingsWire,
  type ServiceTokenRecord,
  type StateEnv,
  type TeamRecord,
  bodyJson,
} from "@commissary/state";
import { AgentsEnv } from "@commissary/agents/api";
import { sweepRetiredSchedules } from "@commissary/agents/management";
import {
  CurrentOrg,
  GLOBAL_ORG,
  type OrgId,
  handled,
  jsonReply,
  type Reply,
  replyError,
} from "@commissary/core";
import {
  AddMember,
  AddTeamMember,
  type MemberView,
  type MembershipSettings,
  UpdateMembershipSettings,
  RegisterServiceToken,
  type ServiceTokenView,
  TeamName,
  type TeamView,
  UpdateMember,
  UpdateServiceToken,
} from "@commissary/contract/members";
import { registry } from "./org-routes.ts";

const BASE = "/v9/management";

const STATUS: Readonly<Record<MemberErrorCode, number>> = {
  invalid_email: 422,
  invalid_role: 422,
  invalid_name: 422,
  invalid_client_id: 422,
  member_exists: 409,
  team_exists: 409,
  service_token_exists: 409,
  last_owner: 409,
  member_not_found: 404,
  team_not_found: 404,
  service_token_not_found: 404,
  owner_required: 403,
  admin_required: 403,
  service_token_owner_required: 403,
};

/** The value of a store result, or its refusal as the response the contract names. */
const orRefuse = <A>(result: MemberResult<A>): Effect.Effect<A, Reply> =>
  result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(replyError(STATUS[result.error], result.error, { message: result.message }));

const iso = (ms: number): string => new Date(ms).toISOString();

const memberView = (member: MemberRecord): MemberView => ({
  id: member.id,
  email: member.email,
  role: member.role,
  added_at: iso(member.addedAt),
  teams: [...member.teams],
});

const teamView = (team: TeamRecord): TeamView => ({
  id: team.id,
  name: team.name,
  created_at: iso(team.createdAt),
  members: [...team.members],
});

const tokenView = (token: ServiceTokenRecord): ServiceTokenView => ({
  client_id: token.clientId,
  name: token.name,
  role: token.role,
  added_at: iso(token.addedAt),
});

/** Who acts: their role in the org (the gate admitted them) and whether they hold the sensitive powers. */
const actorOf = (identity: AccessIdentity): Actor => ({
  role: identity.role ?? "member",
  sensitive: holdsSensitivePowers(identity),
});

const caller = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  return { identity, actor: actorOf(identity) };
});

/** The request body decoded with `schema`; `400 invalid body` otherwise. */
const body = <S extends Schema.Decoder<unknown>>(schema: S) =>
  bodyJson.pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(() => replyError(400, "invalid body")),
      ),
    ),
  );

const param = (name: string) =>
  HttpRouter.params.pipe(
    Effect.flatMap((params) => {
      const value = params[name];

      return value === undefined || value === ""
        ? Effect.fail(replyError(400, "invalid path"))
        : Effect.succeed(value);
    }),
  );

/** After a change of who belongs to the org: the registry's index follows (failures are logged). */
const reindex = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  yield* syncOrgIndex(identity.org);
});

// --- members ---------------------------------------------------------------------------------------------------------

const listMembers = Effect.gen(function* () {
  const members = yield* controlPlane("listMembers", (stub) => stub.listMembers());

  return jsonReply(200, { members: members.map(memberView) });
});

const addMember = Effect.gen(function* () {
  const { identity, actor } = yield* caller;
  const input = yield* body(AddMember);

  const result = yield* controlPlane("addMember", (stub) =>
    stub.addMember(
      { email: input.email, role: input.role ?? "member" },
      actor,
      identity.principalId,
    ),
  );

  const member = yield* orRefuse(result);
  yield* reindex;

  return jsonReply(201, memberView(member));
});

const updateMember = Effect.gen(function* () {
  const { actor } = yield* caller;
  const id = yield* param("id");
  const input = yield* body(UpdateMember);

  const result = yield* controlPlane("setMemberRole", (stub) =>
    stub.setMemberRole(id, input.role, actor),
  );

  return jsonReply(200, memberView(yield* orRefuse(result)));
});

const removeMember = Effect.gen(function* () {
  const { actor } = yield* caller;
  const id = yield* param("id");
  const result = yield* controlPlane("removeMember", (stub) => stub.removeMember(id, actor));

  yield* orRefuse(result);
  // Their API keys went with them (ADR 0027); the Workers that cached one refuse it within the cache lifetime.
  yield* reindex;
  // So did their private agents' schedules: their objects, which the ControlPlane cannot reach, are deleted now.
  yield* sweepRetiredSchedules(yield* AgentsEnv, yield* CurrentOrg);

  return jsonReply(200, { status: "ok" });
});

/** `access_clients` exists in `global` only: an Access sign-in on a client API route names no org, so it reaches no other. */
const settingsView = (settings: MembershipSettingsWire, org: OrgId): MembershipSettings => ({
  auto_join: settings.autoJoin,
  private_credentials: settings.privateCredentials,
  private_toolkits: settings.privateToolkits,
  private_agents: settings.privateAgents,
  ...(org === GLOBAL_ORG ? { access_clients: settings.accessClients } : {}),
});

const membershipSettings = Effect.gen(function* () {
  const { org } = yield* AccessPrincipal;
  const settings = yield* controlPlane("membershipSettings", (stub) => stub.membershipSettings());

  return jsonReply(200, settingsView(settings, org));
});

const updateMembershipSettings = Effect.gen(function* () {
  const { identity, actor } = yield* caller;
  const input = yield* body(UpdateMembershipSettings);

  if (
    input.auto_join === undefined &&
    input.private_credentials === undefined &&
    input.private_toolkits === undefined &&
    input.private_agents === undefined &&
    input.access_clients === undefined
  )
    return yield* replyError(400, "invalid body");

  if (
    (input.auto_join !== undefined || input.access_clients !== undefined) &&
    !roleAtLeast(actor.role, "owner")
  )
    return yield* replyError(403, "owner_required", {
      message: "only an org owner can change who may join the org and how clients sign in",
    });

  if (input.access_clients !== undefined && identity.org !== GLOBAL_ORG)
    return yield* replyError(422, "access_clients_global_only", {
      message:
        "only the first org takes Access sign-ins on the client API; this org takes API keys only",
    });

  const settings = yield* controlPlane("setMembershipSettings", (stub) =>
    stub.setMembershipSettings({
      ...(input.auto_join === undefined ? {} : { autoJoin: input.auto_join }),
      ...(input.private_credentials === undefined
        ? {}
        : { privateCredentials: input.private_credentials }),
      ...(input.private_toolkits === undefined ? {} : { privateToolkits: input.private_toolkits }),
      ...(input.private_agents === undefined ? {} : { privateAgents: input.private_agents }),
      ...(input.access_clients === undefined ? {} : { accessClients: input.access_clients }),
    }),
  );

  return jsonReply(200, settingsView(settings, identity.org));
});

// --- teams -----------------------------------------------------------------------------------------------------------

const listTeams = Effect.gen(function* () {
  const teams = yield* controlPlane("listTeams", (stub) => stub.listTeams());

  return jsonReply(200, { teams: teams.map(teamView) });
});

const createTeam = Effect.gen(function* () {
  const input = yield* body(TeamName);
  const result = yield* controlPlane("createTeam", (stub) => stub.createTeam(input.name));

  return jsonReply(201, teamView(yield* orRefuse(result)));
});

const renameTeam = Effect.gen(function* () {
  const id = yield* param("id");
  const input = yield* body(TeamName);
  const result = yield* controlPlane("renameTeam", (stub) => stub.renameTeam(id, input.name));

  return jsonReply(200, teamView(yield* orRefuse(result)));
});

const deleteTeam = Effect.gen(function* () {
  const id = yield* param("id");
  const result = yield* controlPlane("deleteTeam", (stub) => stub.deleteTeam(id));

  yield* orRefuse(result);

  return jsonReply(200, { status: "ok" });
});

const addTeamMember = Effect.gen(function* () {
  const id = yield* param("id");
  const input = yield* body(AddTeamMember);

  const result = yield* controlPlane("addTeamMember", (stub) =>
    stub.addTeamMember(id, input.member_id),
  );

  return jsonReply(200, teamView(yield* orRefuse(result)));
});

const removeTeamMember = Effect.gen(function* () {
  const id = yield* param("id");
  const memberId = yield* param("memberId");

  const result = yield* controlPlane("removeTeamMember", (stub) =>
    stub.removeTeamMember(id, memberId),
  );

  return jsonReply(200, teamView(yield* orRefuse(result)));
});

// --- service tokens --------------------------------------------------------------------------------------------------

const listServiceTokens = Effect.gen(function* () {
  const tokens = yield* controlPlane("listServiceTokens", (stub) => stub.listServiceTokens());

  return jsonReply(200, { service_tokens: tokens.map(tokenView) });
});

const tokenTaken = () =>
  replyError(409, "service_token_taken", {
    message: "this service token is registered to another org; a token belongs to one org",
  });

/** Whether the registry indexes the service token for an org other than the caller's. */
const takenElsewhere = (
  clientId: string,
): Effect.Effect<boolean, Reply, StateEnv | AccessPrincipal> =>
  Effect.gen(function* () {
    const identity = yield* AccessPrincipal;

    const holder = yield* registry("orgOfServiceToken", (stub) =>
      stub.orgOfServiceToken(clientId.trim()),
    );

    return holder !== undefined && holder.id !== identity.org;
  });

/**
 * A service token belongs to one org: `409 service_token_taken` when the registry indexes it for another. The check
 * runs again once the registration is indexed, because two orgs may register the same token at once: the registry
 * indexes it for the first, and the other org's registration is withdrawn.
 */
const registerServiceToken = Effect.gen(function* () {
  const { identity, actor } = yield* caller;

  if (identity.principal.kind === "mkey") return yield* managementKeyForbidden();
  const input = yield* body(RegisterServiceToken);

  if (yield* takenElsewhere(input.client_id)) return yield* tokenTaken();

  const result = yield* controlPlane("registerServiceToken", (stub) =>
    stub.registerServiceToken(
      { clientId: input.client_id, name: input.name, role: input.role ?? "member" },
      actor,
      identity.principalId,
    ),
  );

  const token = yield* orRefuse(result);
  yield* reindex;

  if (yield* takenElsewhere(token.clientId)) {
    yield* controlPlane("withdrawServiceToken", (stub) =>
      stub.withdrawServiceToken(token.clientId),
    );
    yield* reindex;

    return yield* tokenTaken();
  }

  return jsonReply(201, tokenView(token));
});

const updateServiceToken = Effect.gen(function* () {
  const { identity, actor } = yield* caller;

  if (identity.principal.kind === "mkey") return yield* managementKeyForbidden();
  const clientId = yield* param("clientId");
  const input = yield* body(UpdateServiceToken);

  const result = yield* controlPlane("setServiceTokenRole", (stub) =>
    stub.setServiceTokenRole(clientId, input.role, actor),
  );

  return jsonReply(200, tokenView(yield* orRefuse(result)));
});

const removeServiceToken = Effect.gen(function* () {
  const { actor } = yield* caller;
  const clientId = yield* param("clientId");

  const result = yield* controlPlane("removeServiceToken", (stub) =>
    stub.removeServiceToken(clientId, actor),
  );

  yield* orRefuse(result);
  yield* reindex;

  return jsonReply(200, { status: "ok" });
});

const route = <R>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Reply, R>,
) => HttpRouter.route(method, `${BASE}${path}`, handled(handler));

export const memberRoutes = [
  route("GET", "/members", listMembers),
  route("POST", "/members", addMember),
  route("PATCH", "/members/:id", updateMember),
  route("DELETE", "/members/:id", removeMember),
  route("GET", "/membership", membershipSettings),
  route("PATCH", "/membership", updateMembershipSettings),
  route("GET", "/teams", listTeams),
  route("POST", "/teams", createTeam),
  route("PATCH", "/teams/:id", renameTeam),
  route("DELETE", "/teams/:id", deleteTeam),
  route("POST", "/teams/:id/members", addTeamMember),
  route("DELETE", "/teams/:id/members/:memberId", removeTeamMember),
  route("GET", "/service-tokens", listServiceTokens),
  route("POST", "/service-tokens", registerServiceToken),
  route("PATCH", "/service-tokens/:clientId", updateServiceToken),
  route("DELETE", "/service-tokens/:clientId", removeServiceToken),
];
