import { DurableObject } from "cloudflare:workers";
import type {
  Admission,
  ApiKeyVerdict,
  ClientsUseApiKeys,
  ManagementKeyVerdict,
  MembershipIndex,
  PrincipalRef,
  SsoAdmission,
} from "@commissary/auth";
import { type Actor, isHosted, platformAdminLists } from "@commissary/auth";
import { emailDomain, type IdpSettings } from "@commissary/auth/sso";
import type { OrgRole } from "@commissary/contract/members";
import {
  type ManagementKeyRecord,
  type ManagementKeyResult,
  ManagementKeyStore,
} from "./management-keys/store.ts";
import {
  type SsoDomain,
  type SsoResult,
  type SsoState,
  SsoStore,
  type StoredIdp,
} from "./sso/store.ts";
import { SessionInstanceStore } from "./session-state/instances.ts";
import type { OrgId } from "@commissary/core";
import { orgOfControlPlane } from "./org.ts";
import type { SecretCipher, Sealer } from "./secrets/cipher.ts";
import { OrgSecrets } from "./secrets/data-key.ts";
import { deploymentSecretsKeys } from "./secrets/deployment-keys.ts";
import {
  type AccountStanding,
  MemberStore,
  type MemberRecord,
  type MemberResult,
  type MembershipSettingsWire,
  type ServiceTokenRecord,
  type TeamRecord,
} from "./members/store.ts";
import {
  type MemberNotFound,
  type ApiKeyListing,
  type ApiKeyRecord,
  type ApiKeyResult,
  ApiKeyStore,
} from "./api-keys/store.ts";
import type { StateObjectEnv } from "./env.ts";
import { type SpendCredential, SpendService } from "./spend/service.ts";
import { SpendStore } from "./spend/store.ts";

/**
 * The org-wide ControlPlane as an area's part sees it from inside the Durable Object (#134 "How an area's ControlPlane
 * part works"): the org, its members and teams, its data key, its Spend limits, and the one alarm.
 */
export interface OrgCore {
  /** The org this object serves. */
  readonly org: OrgId;
  /** The org's data key: seals and opens the part's stored secrets once the object started. */
  readonly secrets: Sealer;
  /** Runs `body` in one storage transaction. */
  transaction<T>(body: () => T): T;
  /**
   * Makes the platform admins owners of `global` once (`MemberStore.seedPlatformAdmins`); a call that shows members
   * runs it first. Afterwards it is one row read.
   */
  seedPlatformAdmins(): void;
  /** A member with their role and teams. */
  member(id: string): MemberRecord | undefined;
  members(): ReadonlyArray<MemberRecord>;
  team(id: string): TeamRecord | undefined;
  teams(): ReadonlyArray<TeamRecord>;
  /** The ids of the teams `member` is in. */
  teamIdsOf(member: string): ReadonlyArray<string>;
  /** Whether the org lets members hold private credentials (a membership setting). */
  privateCredentials(): boolean;
  /** Whether the org lets members add private toolkits (a membership setting); read on every use. */
  privateToolkits(): boolean;
  /** Every member's live API keys at `now` (epoch ms). */
  apiKeys(now: number): ReadonlyArray<ApiKeyRecord>;
  /**
   * The org's Spend limits (ADR 0024): one service per object, which model attempts and tool calls are checked and
   * charged through (`ledger()`), and whose limits on a part's shared credentials the part forgets when they go.
   */
  readonly spend: SpendService;
  /**
   * The part's next wake-up (epoch ms, `null`: none) changed: the base sets the object's one alarm to the earliest
   * wake-up of any part.
   */
  wakeUpChanged(at: number | null): Promise<void>;
}

/**
 * What the org-wide base needs of an area's ControlPlane part, an `RpcTarget` constructed with the base's
 * {@link OrgCore} (`new ModelsPart(ctx, env, core)`). The part creates its own tables in its constructor; the base calls
 * the methods below inside the object only (workerd refuses `alarm` over RPC, on an `RpcTarget` too).
 */
export interface ControlPlanePart {
  /** Seals what the part stored in plain text before its secrets were sealed; answers how many values it sealed. */
  sealPlaintext(cipher: SecretCipher): number;
  /** Runs what is due at `now` (epoch ms); answers the part's next wake-up (`null`: none). */
  alarm(now: number): Promise<number | null>;
  /** Deletes the part's tables: the org was deleted (`wipeOrg`). */
  wipe(): void;
  /**
   * A member left the org (`left`, deleting their account) or an org admin removed them (`removed`): zero data retention
   * (ADR 0027), the part deletes everything of theirs. Their API keys are gone already ({@link apiKeysDeleted}).
   */
  memberLeft(member: string, how: "left" | "removed"): Promise<void>;
  teamDeleted(team: string): void;
  /** A member joined or left a team. */
  teamMembersChanged(): void;
  /** API keys were deleted (revoked, expired, or their member left). */
  apiKeysDeleted(ids: ReadonlyArray<string>): void;
  /** The org turned private credentials off or on. */
  privateCredentialsChanged(): void;
  /** The part's shared credentials a Spend limit may name (none for a part without credentials). */
  spendCredentials(): ReadonlyArray<SpendCredential>;
}

/** The areas' parts of a ControlPlane, by name. */
export type ControlPlaneParts = Readonly<Record<string, ControlPlanePart>>;

/** How the composed ControlPlane constructs each of its parts, by name. */
export type PartFactories<P> = { readonly [K in keyof P]: (core: OrgCore) => P[K] };

/**
 * The org-wide ControlPlane (#134, #148): one Durable Object per org (`controlPlaneOf(env, org)`, named by the org id;
 * ADR 0021), the single writer for the org's members, teams, service tokens, membership index and settings, API keys,
 * management keys, single sign-on, `SessionState` instances, Spend limits (#199: model attempts and tool calls count
 * toward the same ones) and data key. The `ControlPlane` a Worker binds is this
 * base composed with the areas' parts (`composeControlPlane`, `compose.ts`), each an `RpcTarget` with its own tables
 * that callers reach through a method of the composed class (`stub.models().x()`).
 *
 * The org's stored secrets are sealed with its data key (`secrets/`), which it opens when it starts, in
 * `blockConcurrencyWhile`: on the first start it creates the key and seals what was stored in plain text (the parts'
 * `sealPlaintext`), after a rotation it wraps the key under the new `SECRETS_KEY`, and when the stage's secrets key is
 * missing, refused or opens no data key it does not start at all (every call that reads a secret fails with the
 * reason).
 *
 * The object has one alarm: the base sets it to the earliest wake-up of any part and, when it fires, calls the parts
 * that are due. Methods are exposed to the Worker through JS RPC and exchange plain data only.
 */
export class OrgControlPlane<P extends ControlPlaneParts> extends DurableObject<StateObjectEnv> {
  /** The org's data key: seals and opens the stored secrets once the object started. */
  readonly #secrets = new OrgSecrets();
  readonly #members: MemberStore;
  readonly #apiKeys: ApiKeyStore;
  /** The `SessionState` instances of the org, so deleting the org can wipe them (`session-state/instances.ts`). */
  readonly #sessionInstances: SessionInstanceStore;
  readonly #managementKeys: ManagementKeyStore;
  /** The org's single sign-on on Commissary Cloud (issue #76): its identity provider and email domains. */
  readonly #sso: SsoStore;
  /** The org's Spend limits (ADR 0024), for every area (`OrgCore.spend`). */
  readonly #spend: SpendService;
  /** The org this object serves, from its name. */
  readonly #org: OrgId;
  /** Set when the org was deleted: the storage is gone (`wipeOrg`), so the stores must not be used again. */
  #wiped = false;
  /**
   * The next wake-up each part last asked for, by name (`null`: none). A part missing here has not said since the
   * object started: the alarm calls it, and the alarm already set stands for it.
   */
  readonly #wakeUps = new Map<string, number | null>();
  /** The areas' parts, by name; an own property, so not reachable over RPC (the composed class exposes each). */
  protected readonly parts: P;
  /**
   * Settles once the org's data key is open, or failed to open (the stores then throw the reason). Only callers that
   * construct the object themselves (tests) wait on it; RPC calls wait on the input gate.
   */
  readonly started: Promise<void>;

  constructor(ctx: DurableObjectState, env: StateObjectEnv, parts: PartFactories<P>) {
    super(ctx, env);
    this.#org = orgOfControlPlane(ctx.id);
    const transaction = <T>(body: () => T): T => ctx.storage.transactionSync(body);

    this.#members = new MemberStore(
      ctx.storage.sql,
      this.#org,
      transaction,
      Date.now,
      !isHosted(env),
    );
    this.#apiKeys = new ApiKeyStore(ctx.storage.sql, this.#org, (ids) => {
      // A deleted key takes its Spend limits and counters along.
      for (const id of ids) this.#spend.forget("key", id);

      for (const part of this.#partList()) part.apiKeysDeleted(ids);
    });
    this.#sessionInstances = new SessionInstanceStore(ctx.storage.sql);
    this.#managementKeys = new ManagementKeyStore(ctx.storage.sql, this.#org);
    this.#sso = new SsoStore(ctx.storage.sql, this.#secrets);
    this.#spend = new SpendService(new SpendStore(ctx.storage.sql), {
      members: () => this.#members.members(),
      teams: () => this.#members.teams(),
      teamsOf: (memberId) => this.#members.member(memberId)?.teams ?? [],
      keys: () => this.#apiKeys.list(undefined, Date.now()),
      credentials: () => this.#partList().flatMap((part) => part.spendCredentials()),
    });

    const built: Partial<Record<string, ControlPlanePart>> = {};

    for (const [name, make] of Object.entries<(core: OrgCore) => ControlPlanePart>(parts))
      built[name] = make(this.#core(name, transaction));
    // SAFETY: `built` holds one part for each name of `parts`, made by that name's factory.
    this.parts = built as P;

    // No call reaches a store before the data key is open; a failure fails every call with the reason until the
    // object restarts (a deploy with a working SECRETS_KEY restarts it).
    this.started = ctx.blockConcurrencyWhile(() =>
      this.#secrets.start({
        sql: ctx.storage.sql,
        transaction,
        org: this.#org,
        keys: () => deploymentSecretsKeys(env),
        sealStored: (cipher) =>
          this.#partList().reduce((sealed, part) => sealed + part.sealPlaintext(cipher), 0),
      }),
    );
  }

  /** The view of the part `name`. */
  #core(name: string, transaction: <T>(body: () => T) => T): OrgCore {
    return {
      org: this.#org,
      secrets: this.#secrets,
      transaction,
      seedPlatformAdmins: () => this.#seedPlatformAdmins(),
      member: (id) => this.#members.member(id),
      members: () => this.#members.members(),
      team: (id) => this.#members.team(id),
      teams: () => this.#members.teams(),
      teamIdsOf: (member) => this.#members.teamIdsOf(member),
      privateCredentials: () => this.#members.privateCredentials(),
      privateToolkits: () => this.#members.privateToolkits(),
      apiKeys: (now) => this.#apiKeys.list(undefined, now),
      spend: this.#spend,
      wakeUpChanged: async (at) => {
        this.#wakeUps.set(name, at);
        await this.#setAlarm();
      },
    };
  }

  #partList(): ReadonlyArray<ControlPlanePart> {
    return Object.values(this.parts);
  }

  // --- the one alarm ---------------------------------------------------------------------------------------------

  /** Durable Object alarm: calls the parts that are due, then sets the alarm to the earliest next wake-up. */
  override async alarm(): Promise<void> {
    const now = Date.now();

    for (const [name, part] of Object.entries(this.parts)) {
      const at = this.#wakeUps.get(name);

      if (at === undefined || (at !== null && at <= now))
        this.#wakeUps.set(name, await part.alarm(now));
    }

    await this.#setAlarm();
  }

  /** Sets the alarm to the earliest wake-up of any part, or deletes it when no part has one. */
  async #setAlarm(): Promise<void> {
    let next: number | null = null;
    let unknown = false;

    for (const name of Object.keys(this.parts)) {
      const at = this.#wakeUps.get(name);

      if (at === undefined) unknown = true;
      else if (at !== null && (next === null || at < next)) next = at;
    }

    // A part that has not said since the start may still need the alarm already set.
    const set = unknown ? await this.ctx.storage.getAlarm() : null;

    if (set !== null && (next === null || set < next)) next = set;

    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  // --- members, teams and service tokens (ADR 0022, `members/store.ts`) ------------------------------------------

  /**
   * Makes the platform admins owners of `global` once (`MemberStore.seedPlatformAdmins`). Checked on every call that
   * reads members or the config, so it runs before either is used; afterwards it is one row read.
   */
  #seedPlatformAdmins(): void {
    if (this.#members.platformAdminsSeeded()) return;

    this.#members.seedPlatformAdmins(platformAdminLists(this.env).adminEmails);
  }

  /**
   * The role of a principal in the org (`MemberStore.admit`); `autoJoin` lets a person join when the org allows it.
   * `client`: the request is for a client API route, where an Access sign-in is accepted only while the org's
   * `accessClients` setting is on; otherwise the answer is {@link ClientsUseApiKeys} and nobody joins.
   */
  admit(
    principal: PrincipalRef,
    autoJoin: boolean,
    client = false,
  ): Admission | ClientsUseApiKeys | undefined {
    this.#seedPlatformAdmins();

    if (client && !this.#apiKeys.accessClients()) return { apiKeysOnly: true };

    return this.#members.admit(principal, autoJoin);
  }

  listMembers(): ReadonlyArray<MemberRecord> {
    this.#seedPlatformAdmins();

    return this.#members.members();
  }

  addMember(
    input: { readonly email: string; readonly role: string },
    actor: Actor,
    by: string,
  ): MemberResult<MemberRecord> {
    this.#seedPlatformAdmins();

    return this.#members.addMember(input, actor, by);
  }

  setMemberRole(id: string, role: string, actor: Actor): MemberResult<MemberRecord> {
    this.#seedPlatformAdmins();

    return this.#members.setMemberRole(id, role, actor);
  }

  async removeMember(id: string, actor: Actor): Promise<MemberResult<{ readonly email: string }>> {
    this.#seedPlatformAdmins();

    const removed = this.#members.removeMember(id, actor);

    // Grants that named the member go with them (the part's `memberLeft`): whoever joins again under that email is a
    // new member.
    if (removed.ok) await this.#deleteMemberData(id, "removed");

    return removed;
  }

  /** A person's place in the org (`MemberStore.standingOf`), for deleting their account. */
  accountStanding(email: string): AccountStanding {
    this.#seedPlatformAdmins();

    return this.#members.standingOf(email);
  }

  /**
   * A person who deletes their account leaves the org with all their data here, and no note of their removal is kept
   * (`MemberStore.leave`). Answers whether they were a member.
   */
  async leaveOrg(email: string): Promise<{ readonly left: boolean }> {
    this.#seedPlatformAdmins();
    const id = this.#members.leave(email);

    if (id === undefined) return { left: false };
    await this.#deleteMemberData(id, "left");

    return { left: true };
  }

  /**
   * Zero data retention (ADR 0027): a member who leaves the org takes with them everything of theirs here: API keys,
   * the Spend limits on them and their keys, and what each part holds of theirs (`ControlPlanePart.memberLeft`). Other members' data stays.
   */
  async #deleteMemberData(member: string, how: "left" | "removed"): Promise<void> {
    this.#apiKeys.removeMemberKeys(member);
    this.#spend.forget("member", member);

    for (const part of this.#partList()) await part.memberLeft(member, how);
  }

  membershipSettings(): MembershipSettingsWire {
    this.#seedPlatformAdmins();

    return {
      autoJoin: this.#members.autoJoin(),
      privateCredentials: this.#members.privateCredentials(),
      privateToolkits: this.#members.privateToolkits(),
      accessClients: this.#apiKeys.accessClients(),
    };
  }

  /**
   * Changes the settings named; the others keep their value. `privateCredentials` turns every private credential off
   * or on again at once; `privateToolkits` stops serving every private toolkit (kept, not deleted) or serves them again,
   * which the Tools part reads on every use.
   */
  setMembershipSettings(settings: Partial<MembershipSettingsWire>): MembershipSettingsWire {
    this.#seedPlatformAdmins();

    if (settings.autoJoin !== undefined) this.#members.setAutoJoin(settings.autoJoin);

    if (
      settings.privateCredentials !== undefined &&
      settings.privateCredentials !== this.#members.privateCredentials()
    ) {
      this.#members.setPrivateCredentials(settings.privateCredentials);

      for (const part of this.#partList()) part.privateCredentialsChanged();
    }

    if (settings.privateToolkits !== undefined)
      this.#members.setPrivateToolkits(settings.privateToolkits);

    if (settings.accessClients !== undefined)
      this.#apiKeys.setAccessClients(settings.accessClients);

    return this.membershipSettings();
  }

  // --- org deletion (ADR 0027) ----------------------------------------------------------------------------------------

  /** A `SessionState` instance of this org tells where it holds entries until `expiresAt` (epoch ms). */
  registerSessionInstance(name: string, now: number, expiresAt: number): void {
    if (!this.#wiped) this.#sessionInstances.register(name, now, expiresAt);
  }

  /** Up to `limit` names of this org's `SessionState` instances that may still hold entries at `now`. */
  sessionInstances(now: number, limit: number): ReadonlyArray<string> {
    return this.#wiped ? [] : this.#sessionInstances.list(now, limit);
  }

  /** The instances named were wiped; forgets them. */
  forgetSessionInstances(names: ReadonlyArray<string>): void {
    if (!this.#wiped) this.#sessionInstances.forget(names);
  }

  /**
   * Deletes everything this object stores, tables included: the org was deleted (the Worker's org deletion, ADR 0027).
   * Each part deletes its tables (`wipe`), then the rest of the storage goes, the alarm with it. Nothing reaches this id
   * afterwards (the Platform registry no longer lists the org, and a new org takes a new id); the object itself is
   * evicted when idle and, if ever started again, finds an empty org. Until then the object answers the calls a repeated
   * deletion makes (`sessionInstances`, `wipeOrg`) as an empty org does, and no other.
   */
  async wipeOrg(): Promise<void> {
    if (!this.#wiped) for (const part of this.#partList()) part.wipe();
    this.#wiped = true;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.sync();
  }

  // --- API keys (ADR 0022, `api-keys/store.ts`) -----------------------------------------------------------------

  /** The org's API keys, or one member's, with the email of the member each belongs to. */
  listApiKeys(memberId: string | undefined, now: number): ReadonlyArray<ApiKeyListing> {
    this.#seedPlatformAdmins();
    const emails = new Map(this.#members.members().map((member) => [member.id, member.email]));

    return this.#apiKeys.list(memberId, now).map((key) => ({
      ...key,
      ...(emails.has(key.memberId) ? { memberEmail: emails.get(key.memberId) } : {}),
    }));
  }

  /** Issues a key to a member of the org; the answer carries the whole key, shown this once. `now`: epoch ms. */
  createApiKey(
    input: { readonly memberId: string; readonly name: string; readonly expiresAt?: number },
    now: number,
  ): ApiKeyResult<{ readonly record: ApiKeyRecord; readonly key: string }> | MemberNotFound {
    this.#seedPlatformAdmins();

    if (this.#members.member(input.memberId) === undefined)
      return { ok: false, error: "member_not_found", message: "no member has this id" };

    return this.#apiKeys.create(input, now);
  }

  /** Deletes the keys that have expired at `now` in every member's name (the cron sweep); answers how many. */
  purgeExpiredApiKeys(now: number): number {
    this.#seedPlatformAdmins();

    return this.#apiKeys.purgeExpired(now);
  }

  /** Revokes a key by deleting it; `memberId` limits the call to that member's keys (`ApiKeyStore.revoke`). */
  revokeApiKey(id: string, now: number, memberId?: string): ApiKeyResult<ApiKeyRecord> {
    this.#seedPlatformAdmins();

    return this.#apiKeys.revoke(id, now, memberId);
  }

  /**
   * Checks a presented API key (its id and the SHA-256 of the whole key) at `now`: the key must be live and its
   * member still in the org, whose role the answer carries. Asked on every request the Worker has not verified
   * within its cache's short lifetime.
   */
  verifyApiKey(keyId: string, hash: string, now: number): ApiKeyVerdict {
    this.#seedPlatformAdmins();
    const checked = this.#apiKeys.check(keyId, hash, now);

    if (!checked.ok) return checked;
    const member = this.#members.member(checked.memberId);

    if (member === undefined) return { ok: false, reason: "unknown" };

    return {
      ok: true,
      memberId: member.id,
      email: member.email,
      role: member.role,
      ...(checked.expiresAt === undefined ? {} : { expiresAt: checked.expiresAt }),
    };
  }

  // --- management keys (ADR 0026, `management-keys/store.ts`) ----------------------------------------------------

  listManagementKeys(): ReadonlyArray<ManagementKeyRecord> {
    return this.#managementKeys.list();
  }

  /** Issues a management key (the Worker checked the role); the answer carries the whole key, shown this once. */
  createManagementKey(
    input: {
      readonly name: string;
      readonly role: OrgRole;
      readonly createdBy: string;
      readonly ownerEmail?: string;
    },
    now: number,
  ): ManagementKeyResult<{ readonly record: ManagementKeyRecord; readonly key: string }> {
    return this.#managementKeys.create(input, now);
  }

  revokeManagementKey(id: string): ManagementKeyResult<ManagementKeyRecord> {
    return this.#managementKeys.revoke(id);
  }

  /** Checks a presented management key (its id and the SHA-256 of the whole key) at `now`. */
  verifyManagementKey(keyId: string, hash: string, now: number): ManagementKeyVerdict {
    return this.#managementKeys.check(keyId, hash, now);
  }

  // --- single sign-on (issue #76, `sso/store.ts`; hosted proxies) --------------------------------------------------

  /** The identity provider (with its secret: the Worker hands it to Better Auth) and the domains. */
  ssoState(): SsoState {
    return this.#sso.state();
  }

  setSsoProvider(settings: IdpSettings, by: string, now: number): SsoResult<StoredIdp> {
    return this.#sso.setProvider(settings, by, now);
  }

  removeSsoProvider(): SsoResult<StoredIdp> {
    return this.#sso.removeProvider();
  }

  addSsoDomain(domain: string, now: number): SsoResult<SsoDomain> {
    return this.#sso.addDomain(domain, now);
  }

  ssoDomain(domain: string): SsoResult<SsoDomain> {
    return this.#sso.domain(domain);
  }

  markSsoDomainVerified(domain: string, now: number): SsoResult<SsoDomain> {
    return this.#sso.markVerified(domain, now);
  }

  setSsoDomainRequired(domain: string, required: boolean): SsoResult<SsoDomain> {
    return this.#sso.setRequired(domain, required);
  }

  removeSsoDomain(domain: string): SsoResult<SsoDomain> {
    return this.#sso.removeDomain(domain);
  }

  /**
   * A person the org's identity provider signed in: their email's domain must be one the org verified, with the provider
   * still set; they are a member then, joining now if they were not (`MemberStore.joinThroughSso`). Refused for someone
   * an org admin removed, until they are added back.
   */
  admitThroughSso(email: string): SsoAdmission {
    this.#seedPlatformAdmins();
    const domain = emailDomain(email);

    if (this.#sso.provider() === undefined) return { ok: false, error: "provider_missing" };

    if (
      domain === undefined ||
      !this.#sso
        .domains()
        .some((found) => found.domain === domain && found.verifiedAt !== undefined)
    )
      return { ok: false, error: "domain_unverified" };
    const admission = this.#members.joinThroughSso(email);

    return admission === undefined
      ? { ok: false, error: "removed" }
      : { ok: true, joined: admission.joined, indexStale: admission.indexStale };
  }

  listTeams(): ReadonlyArray<TeamRecord> {
    this.#seedPlatformAdmins();

    return this.#members.teams();
  }

  createTeam(name: string): MemberResult<TeamRecord> {
    this.#seedPlatformAdmins();

    return this.#members.createTeam(name);
  }

  renameTeam(id: string, name: string): MemberResult<TeamRecord> {
    this.#seedPlatformAdmins();

    return this.#members.renameTeam(id, name);
  }

  deleteTeam(id: string): MemberResult<true> {
    this.#seedPlatformAdmins();

    const deleted = this.#members.deleteTeam(id);

    if (deleted.ok) {
      this.#spend.forget("team", id);

      for (const part of this.#partList()) part.teamDeleted(id);
    }

    return deleted;
  }

  addTeamMember(teamId: string, memberId: string): MemberResult<TeamRecord> {
    this.#seedPlatformAdmins();

    const added = this.#members.addTeamMember(teamId, memberId);

    if (added.ok) for (const part of this.#partList()) part.teamMembersChanged();

    return added;
  }

  removeTeamMember(teamId: string, memberId: string): MemberResult<TeamRecord> {
    this.#seedPlatformAdmins();

    const removed = this.#members.removeTeamMember(teamId, memberId);

    if (removed.ok) for (const part of this.#partList()) part.teamMembersChanged();

    return removed;
  }

  /** The member ids of a team, `undefined` for an unknown team (usage filters). */
  teamMemberIds(teamId: string): ReadonlyArray<string> | undefined {
    this.#seedPlatformAdmins();

    return this.#members.teamMemberIds(teamId);
  }

  listServiceTokens(): ReadonlyArray<ServiceTokenRecord> {
    this.#seedPlatformAdmins();

    return this.#members.serviceTokens();
  }

  registerServiceToken(
    input: { readonly clientId: string; readonly name?: string | undefined; readonly role: string },
    actor: Actor,
    by: string,
  ): MemberResult<ServiceTokenRecord> {
    this.#seedPlatformAdmins();

    return this.#members.registerToken(input, actor, by);
  }

  setServiceTokenRole(
    clientId: string,
    role: string,
    actor: Actor,
  ): MemberResult<ServiceTokenRecord> {
    this.#seedPlatformAdmins();

    return this.#members.setTokenRole(clientId, role, actor);
  }

  removeServiceToken(clientId: string, actor: Actor): MemberResult<true> {
    this.#seedPlatformAdmins();

    return this.#members.removeToken(clientId, actor);
  }

  /** Undoes a registration another org won (`MemberStore.withdrawToken`). */
  withdrawServiceToken(clientId: string): void {
    this.#seedPlatformAdmins();
    this.#members.withdrawToken(clientId);
  }

  /** Who the Platform registry should index for the org, and whether it has caught up (`syncOrgIndex`). */
  membershipIndex(): MembershipIndex {
    this.#seedPlatformAdmins();

    return this.#members.index();
  }

  /** The Platform registry holds the index of `counter`. */
  markIndexSynced(counter: number): void {
    this.#members.markIndexSynced(counter);
  }
}

/** An org's ControlPlane as `@commissary/state` sees it: the org-wide base, whatever parts the Worker composed. */
export type StateControlPlane = OrgControlPlane<ControlPlaneParts>;
