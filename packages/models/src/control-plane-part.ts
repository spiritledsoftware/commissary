import { RpcTarget } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import {
  type ChannelRuleKind,
  type ConfigEntriesWire,
  ConfigStore,
  type ConfigSnapshotWire,
  type ImportResult,
  type KeyGroupChange,
  type PriceOverrideChange,
  type PriceOverridesWire,
  type SettingChange,
  type WriteResult,
} from "./config/store.ts";
import type { JsonObject } from "@commissary/json";
import { isTokenPayloadKey } from "./credentials/merge.ts";
import {
  CredentialPool,
  type ConfigView,
  type RefreshTarget,
  type UpsertResult,
} from "./credentials/pool.ts";
import { type Credential, type CredentialState, executorKey } from "./credentials/model.ts";
import {
  type Access,
  accessTo,
  FULL_ACCESS,
  isFullAccess,
  type Scope,
} from "./credentials/ownership.ts";
import {
  RefreshManager,
  type RefreshOptions,
  type RefreshResult,
  type RunSummary,
} from "./credentials/refresh/index.ts";
import { type RetryPlan, RetryQuery } from "./credentials/selection/retry.ts";
import {
  Lease,
  PickRequest,
  ReportResult,
  type PickResult,
  type ReportOutcome,
} from "./credentials/selection/types.ts";
import { CredentialStore } from "./credentials/store.ts";
import type { CredentialSummary } from "./credentials/summary.ts";
import type { ModelSource } from "./registry/source.ts";
import { reachOf } from "./grants/reach.ts";
import type { GrantChange, GrantSubject, GrantTable, GrantsWire } from "./grants/grant.ts";
import { GrantStore } from "./grants/store.ts";
import { type AuthIndexer, type AuthIndexKeyEnv, orgAuthIndexer } from "./management/auth-index.ts";
import {
  type ProviderKeyProbeTargetResult,
  buildProviderKeyProbeTarget,
} from "./management/provider-keys-probe.ts";
import { buildProviderKeysList } from "./management/provider-keys-view.ts";
import { locateKey } from "./management/provider-keys-write.ts";
import { PROVIDER_KEY_FAMILIES } from "./config/schema.ts";
import { configKeyIds } from "./credentials/key-ids.ts";
import { PrivateKeyStore } from "./credentials/private-keys.ts";
import {
  buildConfigCredentialEntry,
  buildCredentialEntry,
  buildLimitedEntry,
  ownerFields,
} from "./management/credential-entry.ts";
import {
  apiCallToken,
  findCredential,
  type CredentialMutation,
  type CredentialRef,
  type RefreshAllItem,
  type RefreshOneResult,
} from "./management/credential-ops.ts";
import { applyFieldPatch } from "./credentials/field-patch.ts";
import { type DevinStatusSummary, refreshDevinStatuses } from "./credentials/devin-status.ts";
import {
  type CallbackInput,
  type CallbackResult,
  makeOAuthService,
  type OAuthService,
  type StartInput,
  type StartResult,
  type StatusResult,
} from "./oauth/service.ts";
import { OAuthSessions, SqliteSessionTable } from "./oauth/session-store.ts";
import type {
  AccountResult,
  BatchAction,
  PendingResetClaim,
  QuotaReport,
  ResetGrantStatus,
} from "@commissary/contract/credentials";
import {
  isConfigQuotaProvider,
  isQuotaProvider,
  mergeQuotaReport,
  type QuotaOutcome,
} from "./quota/report.ts";
import type { Viewer } from "@commissary/auth";
import {
  CurrentOutboundPolicy,
  type OrgId,
  OutboundHttpClientLive,
  type OutboundPolicy,
  outboundPolicy,
} from "@commissary/core";
import { QuotaReportStore } from "./quota/store.ts";
import type {
  NewSpendLimit,
  SpendCredential,
  SpendEntry,
  SpendOverview,
  SpendResult,
  SpendService,
  SpendServiceResult,
  SpendSettings,
} from "@commissary/state/spend";
import {
  type ControlPlanePart,
  type LeaseSource,
  LeaseStore,
  type OrgCore,
  type SecretCipher,
  type TakeLease,
} from "@commissary/state";
import {
  type PutStatusResult,
  type ResetGrantMark,
  ResetGrantStore,
} from "./quota/reset-grant-store.ts";
import {
  beginClaim,
  type BeginClaim,
  type ClaimAnswer,
  type FreshClaim,
  holdsOrganization,
  openClaim,
  pendingClaimJson,
  settleClaim,
} from "./quota/reset-grants.ts";
import { buildQuotaTarget, type QuotaTargetResult } from "./quota/target.ts";

const decodePickRequest = Schema.decodeUnknownSync(PickRequest);

/**
 * Every table the part's stores create, which `wipe` drops (test/control-plane-split.test.ts checks the list against the
 * tables of a started object).
 */
const MODELS_TABLES = [
  "config_changes",
  "config_settings",
  "config_key_groups",
  "config_provider_keys",
  "config_model_aliases",
  "config_model_exclusions",
  "config_payload_rules",
  "config_price_overrides",
  "credentials",
  "credential_state",
  "credential_quota_report",
  "credential_reset_grants",
  "private_key_groups",
  "private_key_changes",
  "grants",
  "grant_state",
  "oauth_sessions",
  "quota_sweep_lease",
] as const;

/** The cron sweep re-reads a Claude account's reset grants at most this often (see `quotaProbeTarget`). */
const GRANT_SWEEP_TTL_MS = 6 * 60 * 60_000;

/** How long the cron sweep trusts a stored "not eligible" status (new grants can make the account eligible). */
const GRANT_INELIGIBLE_TTL_MS = 24 * 60 * 60_000;

/** The lease (`@commissary/state` `lease.ts`) that keeps one check of every quota at a time: `quota_sweep_lease`. */
const QUOTA_SWEEP_LEASE = "quota_sweep";

const decodeLease = Schema.decodeUnknownSync(Lease);

const decodeReportResult = Schema.decodeUnknownSync(ReportResult);

const decodeRetryQuery = Schema.decodeUnknownSync(RetryQuery);

const PROTECTED_KEYS = new Set([
  "type",
  "disabled",
  "api_key",
  "dca_token",
  "dca_expired",
  "dca_expires_at",
]);

/** Keys `patchCredentialMetadata` must not write: token lifecycle, identity of the provider, the disabled flag. */
const isProtectedMetadataKey = (key: string): boolean =>
  isTokenPayloadKey(key) || PROTECTED_KEYS.has(key);

/** Token refreshes one batch runs at once (each is an upstream call made by this object). */
const BATCH_REFRESH_CONCURRENCY = 4;

const NOT_FOUND: Omit<AccountResult, "name"> = {
  ok: false,
  error: "not_found",
  message: "auth file not found",
};

/** A batch named a provider key (by its `auth_index`, the name the Accounts page lists it under). */
const CONFIG_CREDENTIAL: Omit<AccountResult, "name"> = {
  ok: false,
  error: "config_credential",
  message: "provider keys are managed on the provider keys page",
};

/** The shape of an `auth_index` (`management/auth-index.ts`): only such names are looked up as one. */
const AUTH_INDEX_PATTERN = /^[0-9a-f]{16}$/;

const isDisablingPattern = (pattern: string): boolean => pattern.trim() === "*";

/** On the Accounts page: auth files, and provider keys whose provider reports quota with the key. */
const listed = ({ credential }: RefreshTarget): boolean =>
  credential.source === "file" ||
  (credential.source === "config" && isConfigQuotaProvider(executorKey(credential)));

/**
 * Whether `viewer` reaches a credential owned by `owner`: `full` for the operations of its owner (or of an org admin
 * on a shared credential), `reach` also for the ones an org admin has on a private credential (list, disable, remove).
 * The system (`FULL_ACCESS`: cron sweeps, internal callers) reaches everything.
 */
const reaches = (viewer: Scope, owner: string | undefined, need: "full" | "reach"): boolean => {
  const access = accessTo(owner, viewer);

  return need === "full" ? access === "full" : access !== "none";
};

/** The refusal of a name another owner's credential already holds: it must not say whose it is. */
const NAME_TAKEN = {
  ok: false,
  reason: "name_taken",
  message: "a credential with this name already exists",
} as const;

/**
 * A failed batch refresh as the panel shows it: a fixed reason per failure code plus the upstream status. The
 * refresher's own message is never passed on: it can quote the upstream body, which may echo the refresh token.
 */
const REFRESH_REASONS = new Map([
  ["unauthorized", "the provider refused the refresh token"],
  ["disabled", "the account is disabled"],
  ["persist_failed", "the new tokens could not be stored"],
]);

const refreshFailure = (
  name: string,
  error: { readonly code: string; readonly httpStatus?: number },
): AccountResult => {
  const reason = REFRESH_REASONS.get(error.code) ?? "the token refresh failed";
  const status = error.httpStatus;

  return {
    name,
    ok: false,
    error: error.code === "unauthorized" ? "unauthorized" : "refresh_failed",
    message: status === undefined ? reason : `${reason} (HTTP ${status})`,
    ...(status === undefined ? {} : { status }),
  };
};

/** Stored under `recordQuotaReport`: the report, or why it was not stored. */
export type RecordQuotaResult =
  | { readonly kind: "stored"; readonly report: QuotaReport }
  | { readonly kind: "gone" }
  /** The credential's tokens changed during the check: the outcome says nothing about the new ones. */
  | { readonly kind: "stale" };

/** JSON object as it crosses the RPC boundary (the recursive `JsonObject` is too deep for the RPC stub types). */
type WireJsonObject = Record<string, Schema.MutableJson>;

/** Answer of the `settleResetGrantClaim` RPC: whether cooldowns were cleared, and the claim still open. */
export interface SettledResetGrantClaim {
  readonly cooldownCleared: boolean;
  readonly pending?: PendingResetClaim;
}

/** Answer of the `resetGrantTarget` RPC. */
export type ResetGrantTargetResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly token: string;
      /** The grant state the Worker's status read is based on (`reset-grant-store.ts`). */
      readonly mark: ResetGrantMark;
      readonly disabled: boolean;
      readonly pending?: PendingResetClaim;
      /** The request id of `pending`, which a resend names (`beginResetGrantClaim`); a nonce, not a secret. */
      readonly pendingRequestId?: string;
    }
  | { readonly ok: false; readonly error: "not_found" }
  | { readonly ok: false; readonly error: "unsupported"; readonly provider: string }
  | { readonly ok: false; readonly error: "unavailable"; readonly message: string };

export type SetDisabledResult =
  | { readonly ok: true; readonly via?: "config:excluded-models" }
  | {
      readonly ok: false;
      readonly error: "not_found" | "config_credential" | "compat_endpoint" | "invalid";
      readonly message?: string;
    };

/** What the Models part reads from the `env` it is constructed with. */
export interface ModelsPartEnv extends AuthIndexKeyEnv {
  /** Overrides the Meta key-mint endpoint (empty: default); refresh and OAuth logins. */
  readonly META_MINT_URL: string;
  /**
   * The deployment's own hosts (base, app, API and auth host, comma separated; empty on a preview and under
   * `alchemy dev`), which the outbound guard refuses when the object reaches a user-supplied `base_url` (Devin's
   * status).
   */
  readonly OWN_HOSTS: string;
}

/**
 * The Models part of an org's ControlPlane (#134 "How an area's ControlPlane part works", #148): the single writer for
 * the org's config, credentials, cooldown state and refresh scheduling, grants, Spend limits, quota reports, reset grants
 * and provider OAuth logins (see docs/ARCHITECTURE.md). An `RpcTarget` the composed `ControlPlane` constructs once per
 * object (`new ModelsPart(ctx, env, core)`); callers reach it as `stub.models().x(…)`, one pipelined round trip.
 *
 * Its stored secrets (auth files, config entries, private key groups) are sealed with the org's data key, which the
 * org-wide base opens when the object starts (`core.secrets`; `sealPlaintext` seals what was stored in plain text).
 *
 * Implements the config store, the credential store/selection (`pick`, `report`, credential management) and OAuth
 * token refresh (`alarm`, `refreshNow`, `ensureFresh`, `sweepRefresh`; see `refresh/manager.ts`). Methods are exposed
 * to the Worker through JS RPC and exchange plain data only.
 */
export class ModelsPart extends RpcTarget implements ControlPlanePart {
  readonly #ctx: DurableObjectState;
  /** The org-wide ControlPlane: the org, its members and teams, its data key and the one alarm. */
  readonly #core: OrgCore;
  readonly #credentials: CredentialStore;
  readonly #config: ConfigStore;
  readonly #pool: CredentialPool;
  readonly #refresh: RefreshManager;
  readonly #oauth: OAuthService;
  readonly #sessions: OAuthSessions;
  readonly #quota: QuotaReportStore;
  readonly #leases: LeaseStore;
  readonly #grants: ResetGrantStore;
  /** Which upstream models of which shared credentials each member may use (ADR 0023). */
  readonly #modelGrants: GrantStore;
  /** The members' private provider key groups (sealed rows of their own, never config entries). */
  readonly #privateKeys: PrivateKeyStore;
  /**
   * The org's Spend limits (issue #71), the org-wide base's (`core.spend`, which tool calls are charged through too):
   * what the management API does with them and the ledger the pool checks.
   */
  readonly #spend: SpendService;
  /** The org this object serves, from its name. */
  readonly #org: OrgId;
  /** The refresh alarm's next wake-up as last handed to the base (`null`: none). */
  #wakeUp: number | null = null;
  /**
   * The org's keyed `auth_index` (`orgAuthIndexer`, cached per isolate). Resolved per call so a refused key fails the
   * calls that need an index, not the Durable Object's constructor.
   */
  readonly #authIndex: AuthIndexer;
  /**
   * The outbound guard's policy (ADR 0044) for the user-supplied URLs the object reaches: no loopback; refuses the
   * OWN_HOSTS hosts.
   */
  readonly #outbound: OutboundPolicy;
  #configView: ConfigView | undefined;

  constructor(ctx: DurableObjectState, env: ModelsPartEnv, core: OrgCore) {
    super();
    this.#ctx = ctx;
    this.#core = core;
    this.#org = core.org;
    this.#authIndex = (credentialId) => orgAuthIndexer(env, this.#org)(credentialId);
    this.#outbound = outboundPolicy({ hosts: [env.OWN_HOSTS] });
    const transaction = <T>(body: () => T): T => core.transaction(body);

    this.#credentials = new CredentialStore(ctx.storage.sql, core.secrets);
    this.#config = new ConfigStore(ctx.storage.sql, this.#org, transaction, core.secrets);
    this.#modelGrants = new GrantStore(ctx.storage.sql, transaction);
    this.#privateKeys = new PrivateKeyStore(ctx.storage.sql, transaction, core.secrets);
    this.#quota = new QuotaReportStore(ctx.storage.sql);
    this.#leases = new LeaseStore(ctx.storage.sql, () => Date.now());
    this.#spend = core.spend;

    this.#grants = new ResetGrantStore(ctx.storage.sql);
    this.#pool = new CredentialPool({
      store: this.#credentials,
      config: () => this.#currentConfig(),
      privateCredentials: () => core.privateCredentials(),
      privateKeys: () => this.#privateKeys.owners(),
      reach: (member) =>
        reachOf(this.#modelGrants.entries(), {
          member,
          teams: member === undefined ? [] : core.teamIdsOf(member),
        }),
      decorate: (credential) => this.#refresh.decorate(credential),
      spend: this.#spend.ledger(),
    });
    this.#refresh = new RefreshManager({
      host: this.#pool,
      // The object's one alarm belongs to the org-wide base, which sets it to the earliest wake-up of its parts.
      alarm: {
        set: (at) => this.#wakeUpAt(at),
        clear: () => this.#wakeUpAt(null),
      },
      // A Vertex service account names its own `token_uri`: refreshes go through the outbound guard (ADR 0044).
      http: OutboundHttpClientLive,
      outbound: this.#outbound,
      metaMintUrl: env.META_MINT_URL,
      workers: () => this.#currentConfig().config.oauth["auth-auto-refresh-workers"],
    });
    this.#sessions = new OAuthSessions(new SqliteSessionTable(ctx.storage.sql));
    this.#oauth = makeOAuthService({
      org: this.#org,
      metaMintUrl: env.META_MINT_URL,
      sessions: this.#sessions,
      sink: {
        get: (name, owner) => {
          const target = this.#pool.refreshTarget(name);

          return target !== undefined && target.credential.owner === owner
            ? target.credential.metadata
            : undefined;
        },
        list: (owner) =>
          this.#pool
            .refreshTargets()
            .filter(({ credential }) => credential.owner === owner)
            .map(({ credential }) => ({
              id: credential.id,
              type: typeof credential.metadata.type === "string" ? credential.metadata.type : "",
              metadata: credential.metadata,
            })),
        save: async (name, metadata, owner) => {
          if (this.#ownerClash(name, owner)) return { ok: false, message: NAME_TAKEN.message };
          const result = this.#upsert(name, metadata, false, owner);

          if (!result.ok) return { ok: false, message: result.message };
          await this.#rearm();

          return { ok: true };
        },
        remove: async (id) => {
          await this.removeCredential(id, FULL_ACCESS);
        },
      },
    });
  }

  // --- the org-wide base's calls (`ControlPlanePart`, `@commissary/state`) ------------------------------------

  /** Seals the auth files and config entries stored in plain text before encryption (the object's first start). */
  sealPlaintext(cipher: SecretCipher): number {
    return this.#credentials.sealPlaintext(cipher) + this.#config.sealPlaintext(cipher);
  }

  /** The object's alarm: refreshes due credentials; answers when the next one is due. */
  async alarm(_now: number): Promise<number | null> {
    await this.#refresh.onAlarm();

    return this.#wakeUp;
  }

  /** The refresh deadlines moved: tells the base when to wake this part next. */
  async #wakeUpAt(at: number | null): Promise<void> {
    this.#wakeUp = at;
    await this.#core.wakeUpChanged(at);
  }

  /** Deletes the part's tables (their indexes go with them): the org was deleted (`wipeOrg`). */
  wipe(): void {
    for (const table of MODELS_TABLES) this.#ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  /**
   * Zero data retention (ADR 0027): a member who leaves the org takes with them everything of theirs here: private
   * accounts (with their cooldown and quota state), private provider key groups and the OAuth logins they started (the base
   * forgets their Spend limits). Shared credentials and other members' data stay. A member an org admin removed also takes the grants
   * that named them: whoever joins again under that email is a new member.
   */
  async memberLeft(member: string, how: "left" | "removed"): Promise<void> {
    const accounts = this.#pool
      .entries()
      .filter(({ credential }) => credential.owner === member)
      .map(({ credential }) => credential.id);

    const removed = this.#removeMany(accounts);

    this.#privateKeys.removeOwner(member);
    this.#sessions.deleteOwned(member);
    this.#pool.invalidate();

    if (removed.length > 0) await this.#rearm();

    if (how === "removed") this.#modelGrants.forget({ kind: "member", id: member });
  }

  /** Grants that named the team go with it (the base forgets its Spend limits). */
  teamDeleted(team: string): void {
    this.#modelGrants.forget({ kind: "team", id: team });
  }

  /** Who is in which team moved: the members' reach changes with it. */
  teamMembersChanged(): void {
    this.#modelGrants.membershipChanged();
  }

  /** The base forgets a deleted key's Spend limits and counters. */
  apiKeysDeleted(): void {}

  /** The shared credentials, named by their keyed `auth_index`: what a credential's Spend limit names. */
  spendCredentials(): ReadonlyArray<SpendCredential> {
    return this.#pool.entries().flatMap(({ credential }) =>
      credential.owner === undefined
        ? [
            {
              kind: "credential" as const,
              id: credential.id,
              publicId: this.#authIndex(credential.id),
              label: `${credential.provider}: ${credential.label}`,
            },
          ]
        : [],
    );
  }

  /** Every private credential turns off or on again at once. */
  privateCredentialsChanged(): void {
    this.#pool.invalidate();
  }

  /** The config the entries make up, re-assembled only when the change counter moved. */
  #currentConfig(): ConfigView {
    const { version, config } = this.#config.current();
    const cached = this.#configView;

    if (cached !== undefined && cached.version === version) return cached;
    this.#configView = { version, config };

    return this.#configView;
  }

  /**
   * The assembled config document. Pass the version (change counter) already cached by the caller to get a cheap
   * `unchanged: true` answer instead of the full document.
   */
  getConfig(sinceVersion?: number): ConfigSnapshotWire {
    return this.#config.snapshot(sinceVersion);
  }

  /** The assembled config document with the revision of every entry (what the management routes edit). */
  configEntries(): ConfigEntriesWire {
    return this.#config.entries();
  }

  /** The org's price overrides with their revisions (`ConfigStore.priceOverrides`) and the version they were read at. */
  priceOverrideEntries(): PriceOverridesWire {
    return {
      version: this.#config.version(),
      overrides: this.#config.priceOverrides(),
    };
  }

  /** Creates, replaces or deletes (`value: null`) one price override at the revision it names. */
  writePriceOverride(
    change: PriceOverrideChange,
    by: string,
  ): WriteResult<{ readonly id: string; readonly revision: number }> {
    return this.#config.writePriceOverride(change, by);
  }

  /** Writes settings entries, each at the revision it names (`config/store.ts`); `by` is the writing principal. */
  writeSettings(
    changes: ReadonlyArray<SettingChange>,
    by: string,
  ): WriteResult<{ readonly revisions: Readonly<Record<string, number>> }> {
    return this.#config.writeSettings(changes, by);
  }

  /** Writes or deletes (`value: null`) one channel's model aliases or exclusions at the revision it names. */
  writeChannelRule(
    kind: ChannelRuleKind,
    channel: string,
    revision: number,
    value: Schema.MutableJson | null,
    by: string,
  ): WriteResult<{ readonly revision: number }> {
    return this.#config.writeChannelRule(kind, channel, revision, value, by);
  }

  /** Writes or deletes one key group with its provider keys at the revision it names. */
  writeKeyGroup(
    change: KeyGroupChange,
    by: string,
  ): WriteResult<{ readonly id: string; readonly revision: number }> {
    return this.#config.writeKeyGroup(change, by);
  }

  /**
   * Replaces every config entry with a Go config document (YAML or JSON, v8 or legacy layout) in one transaction and
   * answers the not-applied keys it dropped; `basedOn` is the change counter the caller checked it against
   * (`conflict` when another write landed since).
   */
  importConfig(text: string, by: string, basedOn?: number): ImportResult {
    return this.#config.importDocument(text, by, basedOn);
  }

  // --- Spend limits (issue #71, `@commissary/state/spend`) -------------------------------------------------------------------

  /** The limits `viewer` sees with their Spend so far, and the org's calendar. */
  spendOverview(viewer: Viewer): SpendOverview {
    this.#core.seedPlatformAdmins();

    return this.#spend.overview(viewer);
  }

  createSpendLimit(
    viewer: Viewer,
    input: NewSpendLimit,
    by: string,
  ): SpendServiceResult<SpendEntry> {
    this.#core.seedPlatformAdmins();

    return this.#spend.create(viewer, input, by);
  }

  updateSpendLimit(
    viewer: Viewer,
    id: string,
    revision: number,
    amountMicros: number,
    by: string,
  ): SpendServiceResult<SpendEntry> {
    this.#core.seedPlatformAdmins();

    return this.#spend.update(viewer, id, revision, amountMicros, by);
  }

  removeSpendLimit(viewer: Viewer, id: string, revision: number): SpendServiceResult<SpendEntry> {
    this.#core.seedPlatformAdmins();

    return this.#spend.remove(viewer, id, revision);
  }

  /** Sets the org's time zone and first day of the week; counters of periods that begin differently start over. */
  setSpendSettings(settings: {
    readonly timeZone?: string | undefined;
    readonly weekStart?: string | undefined;
  }): SpendResult<SpendSettings> {
    this.#core.seedPlatformAdmins();

    return this.#spend.setSettings(settings);
  }

  // --- grants (ADR 0023, `grants/store.ts`) -----------------------------------------------------------------------

  /** The org's grants with their revisions and the counter they were read at (what the management routes edit). */
  grantEntries(): GrantsWire {
    return this.#modelGrants.wire();
  }

  /**
   * Creates, replaces or deletes (`value: null`) one grant at the revision it names. A grant for a member or team the org
   * does not have is refused: it would name nobody.
   */
  writeGrant(
    change: GrantChange,
    by: string,
  ): WriteResult<{ readonly id: string; readonly revision: number }> {
    this.#core.seedPlatformAdmins();

    return this.#modelGrants.write(change, by, (subject) => this.#missingSubject(subject));
  }

  #missingSubject(subject: GrantSubject): string | undefined {
    if (subject.kind === "member")
      return this.#core.member(subject.id) === undefined ? "no such member" : undefined;

    if (subject.kind === "team")
      return this.#core.team(subject.id) === undefined ? "no such team" : undefined;

    return undefined;
  }

  /** Everything the Worker needs to compute any member's reach: the grants and who is in each team. */
  grantTable(): GrantTable {
    this.#core.seedPlatformAdmins();

    return {
      version: this.#modelGrants.version(),
      grants: this.#modelGrants.entries(),
      teams: this.#core.teams().map((team) => ({ id: team.id, members: team.members })),
    };
  }

  /**
   * Selects a credential for `request` (candidate set, availability, priority tiers, strategy, session affinity) and
   * returns everything the executor needs plus a lease to hand back to {@link report}. A failure to select is a
   * structured result (`ok: false`), not an exception.
   */
  pick(request: PickRequest): PickResult {
    return this.#pool.pick(decodePickRequest(request));
  }

  /**
   * Reports the outcome of the attempt that used `lease` (counters, cooldown/quota state machine, session affinity).
   */
  report(lease: Lease, result: ReportResult): ReportOutcome {
    return this.#pool.report(decodeLease(lease), decodeReportResult(result));
  }

  /**
   * What the model registry needs from the credentials `scope` reaches (provider, prefix, exclusions, aliases, model
   * state, owner); no secrets. The registry reads them as `FULL_ACCESS` and narrows them itself per caller.
   */
  listModelSources(scope: Scope): ModelSource[] {
    return this.#pool.modelSources().filter((source) => reaches(scope, source.owner, "reach"));
  }

  /**
   * After a failed retry round: should another round start and how long should the Worker wait first?
   * (`request-retry`, cooldown recovery times, `max-retry-interval`; credentials.md §7.1.)
   */
  planRetry(query: RetryQuery): RetryPlan {
    return this.#pool.planRetry(decodeRetryQuery(query));
  }

  /** The credentials `scope` reaches, with runtime state; token material is redacted. */
  listCredentials(scope: Scope): CredentialSummary[] {
    return this.#pool.list().filter((summary) => {
      const target = this.#pool.refreshTarget(summary.id);

      return target === undefined || reaches(scope, target.credential.owner, "reach");
    });
  }

  /**
   * Creates or replaces the auth file `name` (parsed object or JSON text). `mergeExisting` (default true) carries user
   * settings of the previous file over, as a re-login does.
   */
  async upsertCredential(
    name: string,
    content: string | JsonObject,
    options?: { mergeExisting?: boolean; owner?: string },
  ): Promise<UpsertResult> {
    const result = this.#upsert(name, content, options?.mergeExisting ?? true, options?.owner);

    if (result.ok) await this.#rearm();

    return result;
  }

  /**
   * Imports a Go auth JSON file verbatim (an existing credential of the same name is replaced; `mergeExisting` keeps
   * its user settings like a re-login).
   */
  async importAuthFile(
    name: string,
    content: string | JsonObject,
    options: { readonly mergeExisting?: boolean; readonly private?: boolean },
    viewer: Scope,
  ): Promise<UpsertResult> {
    const owner = this.#importOwner(viewer, options.private === true);

    if (!owner.ok) return owner.failure;

    if (this.#ownerClash(name, owner.owner)) return NAME_TAKEN;
    const result = this.#upsert(name, content, options.mergeExisting === true, owner.owner);

    if (result.ok) await this.#rearm();

    return result;
  }

  /**
   * Who owns a credential `viewer` imports: an org admin imports for the org unless they ask for a private one, a plain
   * member always for themselves, and only while the org lets members hold private credentials. The system: shared.
   */
  #importOwner(
    viewer: Scope,
    wantPrivate: boolean,
  ):
    | { readonly ok: true; readonly owner: string | undefined }
    | { readonly ok: false; readonly failure: UpsertResult & { readonly ok: false } } {
    if (isFullAccess(viewer) || (viewer.admin && !wantPrivate))
      return { ok: true, owner: undefined };

    if (viewer.member === undefined) {
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "forbidden",
          message: "only a member can hold a private credential",
        },
      };
    }

    if (!this.#core.privateCredentials()) {
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "forbidden",
          message: "private credentials are turned off for this org",
        },
      };
    }

    return { ok: true, owner: viewer.member };
  }

  /** Whether auth file `name` is stored under another owner than `owner` (a name belongs to one credential). */
  #ownerClash(name: string, owner: string | undefined): boolean {
    const existing = this.#pool.refreshTarget(name);

    return existing !== undefined && existing.credential.owner !== owner;
  }

  /** Removes a stored credential and its runtime state. */
  async removeCredential(id: string, scope: Scope): Promise<{ readonly removed: boolean }> {
    if (!this.#reaches(id, scope, "reach")) return { removed: false };
    const removed = this.#pool.remove(id);

    if (removed) {
      this.#refresh.forget(id);
      this.#quota.delete(id);
      this.#grants.forget(id);
      await this.#rearm();
    }

    return { removed };
  }

  /** Removes several stored credentials; returns the ids that existed. */
  async removeCredentials(ids: ReadonlyArray<string>, viewer: Scope): Promise<string[]> {
    const removed = this.#removeMany(this.#reachable(ids, viewer, "reach"));

    if (removed.length > 0) await this.#rearm();

    return removed;
  }

  /** The names of `ids` that are no stored credential or that `viewer` reaches (a hidden one is as good as absent). */
  #reachable(ids: ReadonlyArray<string>, viewer: Scope, need: "full" | "reach"): string[] {
    return ids.filter((id) => {
      const target = this.#pool.refreshTarget(id);

      return target === undefined || reaches(viewer, target.credential.owner, need);
    });
  }

  /** Whether `scope` reaches the stored credential `id` (an unknown one is nobody's to refuse). */
  #reaches(id: string, scope: Scope, need: "full" | "reach"): boolean {
    const target = this.#pool.refreshTarget(id);

    return target === undefined || reaches(scope, target.credential.owner, need);
  }

  /** The entries of the credential pool `viewer` reaches. */
  #scope(viewer: Scope, need: "full" | "reach"): RefreshTarget[] {
    return this.#pool.entries().filter(({ credential }) => reaches(viewer, credential.owner, need));
  }

  /**
   * Removes stored credentials in one storage transaction, clearing what {@link removeCredential} clears for each:
   * the credential with its runtime (cooldown) state and session bindings, its quota report, its reset grants (a claim
   * in flight is kept, `ResetGrantStore.forget`), and the refresher's in-memory state. The caller re-arms the refresh alarm once.
   */
  #removeMany(ids: ReadonlyArray<string>): string[] {
    const removed = this.#pool.removeMany(ids, (write) =>
      this.#core.transaction(() => {
        const gone = write();

        for (const id of gone) {
          this.#quota.delete(id);
          this.#grants.forget(id);
          this.#spend.forget("credential", id);
        }

        return gone;
      }),
    );

    for (const id of removed) this.#refresh.forget(id);

    return removed;
  }

  /** Disables or re-enables a stored credential (persisted as `disabled` in its file JSON). */
  async setCredentialDisabled(
    id: string,
    disabled: boolean,
    scope: Scope,
  ): Promise<SetDisabledResult> {
    if (!this.#reaches(id, scope, "reach")) return { ok: false, error: "not_found" };
    const result = this.#pool.setDisabled(id, disabled);

    if (result !== "ok") return { ok: false, error: result };
    await this.#rearm();

    return { ok: true };
  }

  // --- token refresh (refresh/manager.ts) ----------------------------------------------------------------------

  /**
   * Request-time refresh after the upstream answered 401 (`tryRefreshAfterUnauthorized`): pass the access token that
   * was rejected so concurrent 401s share one refresh and an already replaced token is not refreshed again. On success
   * the executor retries once with `credential.metadata.access_token`. Never throws: failures are structured.
   */
  refreshNow(credentialId: string, rejectedAccessToken?: string): Promise<RefreshResult> {
    const options: RefreshOptions =
      rejectedAccessToken === undefined ? {} : { rejectedAccessToken };

    return this.#refresh.refreshNow(credentialId, options);
  }

  /** Manual refresh (management): ignores the terminal-unauthorized gating. */
  forceRefresh(credentialId: string): Promise<RefreshResult> {
    return this.#refresh.refreshNow(credentialId, { force: true });
  }

  /**
   * Returns the credential ready to use: a cached/minted Vertex service-account token, a minted Meta key, or a
   * refreshed OAuth token when the stored one is missing/expired (Antigravity: within 5 min). Executors call it when
   * the picked snapshot has no usable `metadata.access_token`.
   */
  ensureFresh(credentialId: string): Promise<RefreshResult> {
    return this.#refresh.ensureFresh(credentialId);
  }

  /** Cron safety sweep: refreshes what is overdue and re-arms a lost alarm. */
  sweepRefresh(): Promise<RunSummary> {
    return this.#refresh.sweep();
  }

  /** Cron task `devin-user-status`: `GetUserStatus` profile and quota signals of every stored Devin credential. */
  async refreshDevinStatus(): Promise<DevinStatusSummary> {
    const summary = await Effect.runPromise(
      // A Devin credential's `base_url` is user-supplied: reached behind the outbound guard (ADR 0044).
      refreshDevinStatuses(this.#pool).pipe(
        Effect.provide(OutboundHttpClientLive),
        Effect.provideService(CurrentOutboundPolicy, this.#outbound),
      ),
    );

    if (summary.refreshed > 0) await this.#rearm();

    return summary;
  }

  /**
   * Merges non-token settings into a stored credential's file (`UpdatePreparedAuth`: request preparation results such
   * as Antigravity `project_id` or Claude profile fields). `null` deletes a key. Token material, `type` and
   * `disabled` cannot be written here.
   */
  async patchCredentialMetadata(
    credentialId: string,
    patch: JsonObject,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: "not_found" | "forbidden_key" }
  > {
    const target = this.#pool.refreshTarget(credentialId);

    if (target === undefined) return { ok: false, error: "not_found" };

    if (Object.keys(patch).some(isProtectedMetadataKey))
      return { ok: false, error: "forbidden_key" };
    const metadata: JsonObject = { ...target.credential.metadata };

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete metadata[key];
      else metadata[key] = value;
    }

    this.#pool.commitRefresh(credentialId, { metadata });
    await this.#rearm();

    return { ok: true };
  }

  // --- management API (src/management) -------------------------------------------------------------------------

  /**
   * Panel entries of all stored auth files, plus the provider keys whose provider reports quota with the key
   * (`CONFIG_QUOTA_PROVIDERS`, listed by their `auth_index`, `buildConfigCredentialEntry`). No secrets.
   */
  listCredentialEntries(viewer: Scope): WireJsonObject[] {
    const now = Date.now();
    const reports = this.#quota.all();
    const grants = this.#grants.statuses();
    const entries = this.#pool.entries();

    const ids = entries.some(({ credential }) => credential.source === "config")
      ? configKeyIds(this.#currentConfig().config)
      : undefined;

    return entries.filter(listed).flatMap(({ credential, state }) => {
      const access = accessTo(credential.owner, viewer);

      if (access === "none") return [];

      // An org admin sees that a private credential exists, nothing of its use or standing.
      if (access === "limited") {
        return [buildLimitedEntry(credential, this.#ownerEmail(credential), this.#authIndex)];
      }

      const entry = this.#fullEntry(credential, state, now, ids, reports, grants);

      return credential.owner === undefined
        ? [entry]
        : [{ ...entry, ...ownerFields(credential.owner, this.#ownerEmail(credential)) }];
    });
  }

  #ownerEmail(credential: Credential): string | undefined {
    return credential.owner === undefined ? undefined : this.#core.member(credential.owner)?.email;
  }

  #fullEntry(
    credential: Credential,
    state: CredentialState,
    now: number,
    ids: ReturnType<typeof configKeyIds> | undefined,
    reports: ReadonlyMap<string, QuotaReport>,
    grants: ReadonlyMap<string, ResetGrantStatus>,
  ): WireJsonObject {
    if (credential.source === "config") {
      const position = ids === undefined ? undefined : locateKey(ids, credential.id);

      return buildConfigCredentialEntry(
        credential,
        state,
        now,
        this.#authIndex,
        position === undefined ? undefined : { family: position.family, index: position.group },
        reports.get(credential.id),
      );
    }

    return buildCredentialEntry(
      credential,
      state,
      now,
      this.#authIndex,
      reports.get(credential.id),
      grants.get(credential.id),
    );
  }

  /**
   * The listed config account (`CONFIG_QUOTA_PROVIDERS`) whose listed name, its keyed `auth_index`, is `name`. An index
   * reveals nothing about the key, so resolving one confirms no guess.
   */
  #configAccount(name: string, viewer: Scope): RefreshTarget | undefined {
    const index = name.trim().toLowerCase();

    if (!AUTH_INDEX_PATTERN.test(index)) return undefined;

    return this.#scope(viewer, "full").find(
      ({ credential }) =>
        credential.source === "config" &&
        isConfigQuotaProvider(executorKey(credential)) &&
        this.#authIndex(credential.id) === index,
    );
  }

  /**
   * Whether `name` is the `auth_index` of a provider key: the management routes answer a file-only operation on one
   * (delete, download, refresh, field edits) with a clear refusal instead of "not found".
   */
  isConfigKey(name: string, viewer: Scope): boolean {
    const index = name.trim().toLowerCase();

    if (!AUTH_INDEX_PATTERN.test(index)) return false;

    return (
      findCredential(this.#scope(viewer, "reach"), { authIndex: index }, this.#authIndex)
        ?.credential.source === "config"
    );
  }

  /**
   * What `viewer` may do with the credential `name` (an auth file id): `full`, `limited` (an org admin on a private
   * one) or `none` (absent, or private to someone else); `private` tells the owner's case apart.
   */
  credentialAccess(
    name: string,
    viewer: Viewer,
  ): { readonly access: Access; readonly private: boolean } {
    const target = this.#pool.refreshTarget(name);

    return target === undefined
      ? { access: "none", private: false }
      : {
          access: accessTo(target.credential.owner, viewer),
          private: target.credential.owner !== undefined,
        };
  }

  /** The stored auth file verbatim, for download (only to a viewer with full access to it). */
  getCredentialFile(name: string, viewer: Scope): WireJsonObject | undefined {
    const target = this.#pool.refreshTarget(name);

    return target !== undefined && reaches(viewer, target.credential.owner, "full")
      ? target.credential.metadata
      : undefined;
  }

  /** Edits fields of a stored auth file (`PATCH /credentials/fields`); see `field-patch.ts`. */
  async patchCredentialFields(
    ref: CredentialRef,
    fields: WireJsonObject,
    viewer: Scope,
  ): Promise<CredentialMutation> {
    const target = findCredential(this.#scope(viewer, "full"), ref, this.#authIndex);

    if (target === undefined || target.credential.source !== "file") {
      return { ok: false, error: "not_found", message: "auth file not found" };
    }

    const patched = applyFieldPatch(target.credential.metadata, fields);

    if (!patched.ok) {
      return {
        ok: false,
        error: "invalid",
        message: patched.message,
        ...(patched.path === undefined ? {} : { path: patched.path }),
      };
    }

    this.#pool.commitRefresh(target.credential.id, { metadata: patched.metadata });
    await this.#rearm();

    return { ok: true, id: target.credential.id };
  }

  /**
   * Enables/disables a credential addressed by file name and/or `auth_index`. A provider key is disabled by
   * adding `*` to its `excluded-models` in the config (Go `toggleConfigAPIKeyExcludedAll`); the credential id and
   * `auth_index` stay the same (`excluded-models` is not part of the identity).
   */
  async setCredentialDisabledByRef(
    ref: CredentialRef,
    disabled: boolean,
    by: string,
    viewer: Scope,
  ): Promise<SetDisabledResult> {
    const target = findCredential(this.#scope(viewer, "reach"), ref, this.#authIndex);

    if (target === undefined) return { ok: false, error: "not_found" };

    if (target.credential.source === "config")
      return this.#setConfigKeyDisabled(target.credential, disabled, by);

    return await this.setCredentialDisabled(target.credential.id, disabled, viewer);
  }

  #setConfigKeyDisabled(credential: Credential, disabled: boolean, by: string): SetDisabledResult {
    // Go has no compat loop in config_apikey_disable.go: an endpoint is disabled as a whole (`disabled` on its group).
    if (credential.attributes.compat_name !== undefined)
      return { ok: false, error: "compat_endpoint" };

    // A private key is not in the org's config: its owner's sealed group holds it.
    if (credential.owner !== undefined) {
      return this.#privateKeys.setKeyExcludedAll(credential.id, disabled) === undefined
        ? { ok: false, error: "not_found" }
        : { ok: true, via: "config:excluded-models" };
    }

    const stored = this.#config.setKeyExcludedAll(credential.id, disabled, by);

    if (stored.ok) return { ok: true, via: "config:excluded-models" };

    return stored.error === "not_found"
      ? { ok: false, error: "not_found" }
      : { ok: false, error: "invalid", message: stored.message };
  }

  // --- provider keys page (src/management/provider-keys-*.ts) ------------------------------------------------------------

  /** The `api-keys` groups with runtime state: one snapshot of config version and credential pool (no secrets). */
  providerKeysView(viewer: Scope): WireJsonObject {
    const { version, config } = this.#currentConfig();
    const { groups } = this.#config.entries().revisions;
    const entries = this.#pool.entries();
    const now = Date.now();

    // Shared groups are for org admins (and internal callers); everyone else sees none of them.
    const view =
      isFullAccess(viewer) || viewer.admin
        ? buildProviderKeysList(version, groups, config, entries, now, this.#authIndex)
        : buildProviderKeysList(
            version,
            {},
            this.#privateKeys.configOf("").config,
            entries,
            now,
            this.#authIndex,
          );

    if (isFullAccess(viewer)) return view;

    // The viewer's own private groups in full; an org admin also sees that other members' exist (ADR 0023).
    if (viewer.member !== undefined) {
      const mine = this.#privateKeys.configOf(viewer.member);

      view.own =
        buildProviderKeysList(version, mine.revisions, mine.config, entries, now, this.#authIndex)
          .families ?? {};
    }

    if (viewer.admin) view.others = this.#limitedKeyGroups(viewer.member, entries);

    return view;
  }

  /** What an org admin sees of the private key groups of other members: that each exists, nothing of its use. */
  #limitedKeyGroups(
    viewer: string | undefined,
    entries: ReadonlyArray<RefreshTarget>,
  ): WireJsonObject[] {
    const credentials = new Map(entries.map(({ credential }) => [credential.id, credential]));

    return this.#privateKeys.owners().configs.flatMap((owned) => {
      if (owned.owner === viewer) return [];
      const ids = configKeyIds(owned.config, { includeDisabledGroups: true });
      const email = this.#core.member(owned.owner)?.email;

      return PROVIDER_KEY_FAMILIES.flatMap((family) =>
        owned.config["api-keys"][family].flatMap((group, index): WireJsonObject[] => {
          if (group.id === undefined) return [];

          const first = ids[family][index]?.keys
            .map((id) => (id === undefined ? undefined : credentials.get(id)))
            .find((credential) => credential !== undefined);

          return [
            {
              id: group.id,
              revision: owned.revisions[group.id] ?? 0,
              family,
              provider: first?.provider ?? family,
              label: first?.label ?? family,
              limited: true,
              ...ownerFields(owned.owner, email),
            },
          ];
        }),
      );
    });
  }

  /**
   * The private key groups of the viewer as a config document, for the Worker to check a write against (the same way
   * it checks one against the org's config); refused unless the viewer is a member and the org allows private
   * credentials.
   */
  privateKeyConfig(viewer: Viewer):
    | {
        readonly ok: true;
        readonly version: number;
        readonly document: string;
        readonly revisions: Readonly<Record<string, number>>;
      }
    | { readonly ok: false; readonly error: "forbidden"; readonly message: string } {
    const refused = this.#privateKeyRefusal(viewer);

    if (refused !== undefined) return refused;
    const mine = this.#privateKeys.configOf(viewer.member ?? "");

    return {
      ok: true,
      version: mine.version,
      document: JSON.stringify(mine.document),
      revisions: mine.revisions,
    };
  }

  #privateKeyRefusal(
    viewer: Viewer,
  ): { readonly ok: false; readonly error: "forbidden"; readonly message: string } | undefined {
    if (viewer.member === undefined)
      return { ok: false, error: "forbidden", message: "private credentials belong to members" };

    return this.#core.privateCredentials()
      ? undefined
      : {
          ok: false,
          error: "forbidden",
          message: "private credentials are turned off for this org",
        };
  }

  /**
   * Writes or deletes one private key group of the viewer at the revision it names. An org admin may also delete a
   * member's private group (`group: null`), whatever the org setting says; nothing else of another member's.
   */
  writePrivateKeyGroup(
    change: KeyGroupChange,
    by: string,
    viewer: Viewer,
  ):
    | WriteResult<{ readonly id: string; readonly revision: number }>
    | { readonly ok: false; readonly error: "forbidden"; readonly message: string } {
    const owner = change.id === undefined ? undefined : this.#privateKeys.ownerOf(change.id);

    // Deleting a private group is for its owner at any time, and for org admins (ADR 0023).
    if (change.group === null && owner !== undefined && (viewer.admin || owner === viewer.member))
      return this.#privateKeys.write(owner, change, by);

    const refused = this.#privateKeyRefusal(viewer);

    if (refused !== undefined) return refused;

    return this.#privateKeys.write(viewer.member ?? "", change, by);
  }

  /**
   * The id of the live credential (auth file or config key) whose `auth_index` is `authIndex`, for the usage filter
   * (`resolveAuthIds`): it narrows D1 to that id without scanning the distinct ids. Internal: never sent to a client.
   */
  credentialIdOfAuthIndex(authIndex: string, viewer: Scope): string | undefined {
    return findCredential(this.#scope(viewer, "full"), { authIndex }, this.#authIndex)?.credential
      .id;
  }

  /**
   * What the Worker needs to probe a provider key (`POST /provider-keys/probe`): the family, base URL, headers and the
   * key itself. Carries the secret: the Worker uses it for the upstream call only and never returns it.
   */
  providerKeyProbeTarget(authIndex: string, viewer: Scope): ProviderKeyProbeTargetResult {
    const target = findCredential(this.#scope(viewer, "full"), { authIndex }, this.#authIndex);

    const probe =
      target?.credential.source === "config"
        ? buildProviderKeyProbeTarget(target.credential)
        : undefined;

    return probe === undefined ? { ok: false, error: "not_found" } : { ok: true, target: probe };
  }

  /** Clears quota/cooldown state (`POST /routing/cooldown/reset`). */
  resetCredentialCooldown(
    ref: CredentialRef,
    viewer: Scope,
  ):
    | { readonly ok: true; readonly authIndex: string; readonly models: ReadonlyArray<string> }
    | { readonly ok: false } {
    const target = findCredential(this.#scope(viewer, "full"), ref, this.#authIndex);
    const reset = target === undefined ? undefined : this.#pool.resetCooldown(target.credential.id);

    return target === undefined || reset === undefined
      ? { ok: false }
      : { ok: true, authIndex: this.#authIndex(target.credential.id), models: reset.models };
  }

  /** Manual refresh of one auth file (`POST /credentials/refresh`). */
  async refreshCredential(ref: CredentialRef, viewer: Scope): Promise<RefreshOneResult> {
    const target = findCredential(this.#scope(viewer, "full"), ref, this.#authIndex);

    if (target === undefined || target.credential.source !== "file")
      return { ok: false, error: "not_found" };
    const id = target.credential.id;
    const result = await this.#refresh.refreshNow(id, { force: true });

    if (!result.ok && result.error.code !== "not_refreshable") {
      return { ok: false, error: "refresh_failed", message: result.error.message };
    }

    const current = this.#pool.entry(id);

    if (current === undefined) return { ok: false, error: "not_found" };

    return {
      ok: true,
      refreshed: result.ok && result.refreshed,
      entry: buildCredentialEntry(
        current.credential,
        current.state,
        Date.now(),
        this.#authIndex,
        this.#quota.get(id),
        this.#grants.status(id),
      ),
    };
  }

  /** Manual refresh of every refreshable auth file (`all=true`). */
  async refreshAllCredentials(viewer: Scope): Promise<RefreshAllItem[]> {
    const results = await Promise.all(
      this.#pool
        .refreshTargets()
        .filter(({ credential }) => reaches(viewer, credential.owner, "full"))
        .map(async ({ credential }) => ({
          id: credential.id,
          result: await this.#refresh.refreshNow(credential.id, { force: true }),
        })),
    );

    const items: RefreshAllItem[] = [];

    for (const { id, result } of results) {
      if (result.ok) items.push({ id, success: true });
      // Credentials without a refresh token are not part of a refresh run.
      else if (result.error.code !== "not_refreshable")
        items.push({ id, success: false, error: result.error.message });
    }

    return items;
  }

  /**
   * One batch action over auth files named by id (`POST /credentials/batch`, src/management/credentials-batch.ts):
   * one result per name, in order. Every name is resolved against one snapshot of the stored credentials.
   *
   * Enable, disable and delete apply every name in one synchronous pass inside a storage transaction (nothing
   * interleaves, and a failure leaves no half-applied batch), dropping the pool's derived view once, then re-arm the
   * refresh alarm once. A batch delete clears exactly what a single delete clears: the credential with its runtime
   * (cooldown) state and session bindings, its quota report and the refresher's in-memory state. A name that is no
   * longer stored is already deleted, so a delete answers it `ok`, a provider key's id included: answering it
   * `not_found` would confirm a guessed config id, i.e. a guessed provider key (`auth-index.ts`). Enable, disable and
   * refresh answer every name that is no stored auth file `not_found`, config ids or not.
   *
   * Refresh forces each refresh with at most {@link BATCH_REFRESH_CONCURRENCY} upstream calls at a time; an account
   * without a refresh token is `skipped`, and a failure carries a fixed reason (`refreshFailure`).
   */
  async batchCredentials(
    action: BatchAction,
    names: ReadonlyArray<string>,
    viewer: Scope,
  ): Promise<AccountResult[]> {
    // Refreshing needs full access; an org admin may also enable, disable and delete a private credential.
    const need = action === "refresh" ? "full" : "reach";

    const stored = new Set(
      this.#pool
        .refreshTargets()
        .filter(({ credential }) => reaches(viewer, credential.owner, need))
        .map(({ credential }) => credential.id),
    );

    // Provider keys listed on the Accounts page by their `auth_index` (public, so a clear answer confirms nothing).
    const configKeys = new Set(
      names.filter((name) => !stored.has(name) && this.isConfigKey(name, viewer)),
    );

    if (action === "refresh") {
      return await Effect.runPromise(
        Effect.forEach(
          names,
          (name) =>
            stored.has(name)
              ? Effect.promise(() => this.#refreshForBatch(name))
              : Effect.succeed<AccountResult>({
                  name,
                  ...(configKeys.has(name) ? CONFIG_CREDENTIAL : NOT_FOUND),
                }),
          { concurrency: BATCH_REFRESH_CONCURRENCY },
        ),
      );
    }

    const known = names.filter((name) => stored.has(name));

    const applied = new Set(
      action === "delete"
        ? this.#removeMany(known)
        : this.#pool.setDisabledMany(known, action === "disable", (write) =>
            this.#core.transaction(write),
          ),
    );

    if (applied.size > 0) await this.#rearm();

    return names.map((name): AccountResult => {
      if (applied.has(name)) return { name, ok: true };

      if (configKeys.has(name)) return { name, ...CONFIG_CREDENTIAL };

      // Gone already (here or in a concurrent call), or never an auth file: no auth file of that name is stored, as a
      // delete asked. A config id reads like any other such name, so the reply does not confirm a guessed key.
      if (action === "delete") return { name, ok: true };

      return { name, ...NOT_FOUND };
    });
  }

  async #refreshForBatch(name: string): Promise<AccountResult> {
    const result = await this.#refresh.refreshNow(name, { force: true });

    if (result.ok) return { name, ok: true };

    if (result.error.code === "not_found") return { name, ...NOT_FOUND };

    if (result.error.code === "not_refreshable") {
      return {
        name,
        ok: false,
        skipped: true,
        error: "not_refreshable",
        message: "the account has no refresh token",
      };
    }

    return refreshFailure(name, result.error);
  }

  // --- quota check (src/quota) ----------------------------------------------------------------------------------

  /**
   * What the Worker needs to probe the usage endpoint of an auth file (`POST /credentials/quota`, cron `quota-check`):
   * the provider and the token of the credential refreshed when needed, with the `credentialVersion` the token belongs
   * to (handed back with the outcome, see {@link recordQuotaReport}). Carries token material: the Worker uses it for
   * the upstream call only. A Claude target carries the grant `grantsMark`; in a sweep (`sweep`) it skips the reset
   * grant read while the stored status is under `GRANT_SWEEP_TTL_MS` old, or under `GRANT_INELIGIBLE_TTL_MS` old when
   * it says the account is not eligible.
   */
  async quotaProbeTarget(
    ref: CredentialRef,
    options: { readonly sweep?: boolean },
    viewer: Scope,
  ): Promise<QuotaTargetResult> {
    const target =
      findCredential(this.#scope(viewer, "full"), ref, this.#authIndex) ??
      (ref.name === undefined ||
      (ref.authIndex !== undefined &&
        ref.authIndex.trim().toLowerCase() !== ref.name.trim().toLowerCase())
        ? undefined
        : this.#configAccount(ref.name, viewer));

    if (target === undefined || !listed(target)) return { ok: false, error: "not_found" };
    const provider = executorKey(target.credential);

    if (!isQuotaProvider(provider)) return { ok: false, error: "unsupported", provider };
    const id = target.credential.id;

    // A config key needs no refresh: the target is built from the pool's credential, named by its `auth_index`.
    if (target.credential.source === "config") {
      const built = buildQuotaTarget(target.credential, provider);
      const credentialVersion = target.credential.credentialVersion;
      const handle = this.#authIndex(id);

      if (!built.ok) return built.error === "unavailable" ? { ...built, credentialVersion } : built;

      return { ok: true, target: { ...built.target, handle, credentialVersion } };
    }

    const fresh = await this.#refresh.ensureFresh(id);

    if (!fresh.ok) {
      return {
        ok: false,
        error: "unavailable",
        id,
        message: "token refresh failed",
        credentialVersion: target.credential.credentialVersion,
      };
    }

    const built = buildQuotaTarget(fresh.credential, provider);
    const credentialVersion = fresh.credential.credentialVersion;

    if (!built.ok) return built.error === "unavailable" ? { ...built, credentialVersion } : built;

    if (provider !== "claude")
      return { ok: true, target: { ...built.target, handle: id, credentialVersion } };
    const stored = this.#grants.status(id);

    const skip =
      options?.sweep === true &&
      stored !== undefined &&
      Date.now() - Date.parse(stored.checked_at) <
        (stored.eligible ? GRANT_SWEEP_TTL_MS : GRANT_INELIGIBLE_TTL_MS);

    return {
      ok: true,
      target: {
        ...built.target,
        handle: id,
        credentialVersion,
        ...(skip ? { skipResetGrants: true } : {}),
      },
      grantsMark: this.#grants.mark(id),
    };
  }

  /**
   * Stores the result of one quota check made at `checkedAtMs` with the tokens of `credentialVersion`: `gone` when the
   * credential was deleted meanwhile, `stale` (nothing stored) when its tokens changed meanwhile (a re-login), as a
   * refresh result is dropped. `sweepLease`: the check is part of a sweep, whose lease this renews.
   */
  recordQuotaReport(
    id: string,
    outcome: QuotaOutcome,
    checkedAtMs: number,
    options: {
      readonly credentialVersion?: number;
      readonly sweepLease?: string;
      readonly grantsMark?: ResetGrantMark;
    } = {},
  ): RecordQuotaResult {
    if (options.sweepLease !== undefined) this.#leases.renew(options.sweepLease);
    const current = this.#pool.entry(id);

    if (current === undefined) return { kind: "gone" };

    if (
      options.credentialVersion !== undefined &&
      current.credential.credentialVersion !== options.credentialVersion
    )
      return { kind: "stale" };

    const report = mergeQuotaReport(
      this.#quota.get(id),
      outcome,
      new Date(checkedAtMs).toISOString(),
    );

    this.#quota.put(id, report);

    // A stale outcome returned above stores no grant status either; the grant mark guards against re-logins and claims.
    if (outcome.ok && outcome.resetGrants !== undefined && options.grantsMark !== undefined)
      this.#grants.putStatus(id, outcome.resetGrants, options.grantsMark);

    return { kind: "stored", report };
  }

  // --- Claude reset grants (src/quota/reset-grant-flow.ts) ------------------------------------------------------

  /**
   * What the Worker needs to read or claim the reset grants of a Claude auth file: the fresh OAuth token and the claim
   * that can still be resent, the grant `mark` its status read is based on and whether the account is disabled.
   * Carries token material: the Worker uses it for the upstream calls only.
   */
  async resetGrantTarget(ref: CredentialRef, viewer: Scope): Promise<ResetGrantTargetResult> {
    const target = findCredential(this.#scope(viewer, "full"), ref, this.#authIndex);

    if (target === undefined || target.credential.source !== "file")
      return { ok: false, error: "not_found" };
    const provider = executorKey(target.credential);

    if (provider !== "claude") return { ok: false, error: "unsupported", provider };
    const id = target.credential.id;
    const fresh = await this.#refresh.ensureFresh(id);

    if (!fresh.ok) return { ok: false, error: "unavailable", message: "token refresh failed" };
    const token = apiCallToken(fresh.credential);

    if (token === "")
      return { ok: false, error: "unavailable", message: "credential has no access token" };
    const now = Date.now();
    const open = openClaim(this.#grants.claim(id), now);

    return {
      ok: true,
      id,
      token,
      mark: this.#grants.mark(id),
      disabled: target.credential.disabled,
      ...(open === undefined
        ? {}
        : { pending: pendingClaimJson(open, now), pendingRequestId: open.request_id }),
    };
  }

  /**
   * Stores a reset grant status read under `mark` (`ResetGrantStore.putStatus`); `gone` when the credential was
   * removed.
   */
  recordResetGrantStatus(
    id: string,
    status: ResetGrantStatus,
    mark: ResetGrantMark,
  ): PutStatusResult | "gone" {
    if (this.#pool.entry(id) === undefined) return "gone";

    return this.#grants.putStatus(id, status, mark);
  }

  /**
   * Starts a claim (`reset-grants.ts` `beginClaim`): resends the open claim of `organization` whose request id is
   * `resend`, or starts `fresh` when nothing happened to the grants since `mark` was handed out. Serialized here, so
   * two tabs or admins never send two claims of one account at once, nor two auth files of one organization. Refused
   * for a disabled account and when the credential was replaced or removed since `mark` (`changed`).
   */
  beginResetGrantClaim(
    id: string,
    organization: string,
    fresh: FreshClaim | undefined,
    mark: ResetGrantMark,
    resend?: string,
  ):
    | BeginClaim
    | {
        readonly ok: false;
        readonly error: "not_found" | "disabled" | "changed" | "busy_removed";
      } {
    const entry = this.#pool.entry(id);

    if (entry === undefined) return { ok: false, error: "not_found" };

    if (entry.credential.disabled) return { ok: false, error: "disabled" };
    const current = this.#grants.mark(id);

    if (current.generation !== mark.generation) return { ok: false, error: "changed" };

    const now = Date.now();
    const others = [...this.#grants.claims()].filter(([other]) => other !== id);
    const own = this.#grants.claim(id);

    const started = beginClaim(
      own,
      {
        organization,
        fresh,
        resend,
        current: current.claimSeq === mark.claimSeq,
        others: others.map(([, journal]) => journal),
      },
      now,
    );

    if (started.ok) this.#grants.putClaim(id, started.journal);
    else if (
      started.error === "busy" &&
      !(own !== undefined && own.in_flight_until > now) &&
      others.some(
        ([other, journal]) =>
          this.#pool.entry(other) === undefined && holdsOrganization(journal, organization, now),
      )
    )
      // Held by the claim of a removed auth file: its journal outlived the file (`ResetGrantStore.forget`).
      return { ok: false, error: "busy_removed" };

    return started;
  }

  /**
   * Records Anthropic's answer to the claim `requestId`, also after the credential was removed or re-logged (its journal
   * outlives `forget` while in flight). When it spent a reset the account's cooldowns are cleared (`resetCooldown`, as
   * `POST /routing/cooldown/reset`): the windows that made it cool down were reset upstream.
   */
  settleResetGrantClaim(
    id: string,
    requestId: string,
    answer: ClaimAnswer,
  ): SettledResetGrantClaim {
    const settled = settleClaim(this.#grants.claim(id), requestId, answer);

    this.#grants.putClaim(id, settled.journal);

    if (this.#pool.entry(id) === undefined) return { cooldownCleared: false };
    const cleared = settled.spent && this.#pool.resetCooldown(id) !== undefined;
    const now = Date.now();
    const open = openClaim(settled.journal, now);

    return {
      cooldownCleared: cleared,
      ...(open === undefined ? {} : { pending: pendingClaimJson(open, now) }),
    };
  }

  /**
   * Listed names of the enabled accounts whose provider has a usage endpoint (cron `quota-check`, "Check all
   * quotas"): auth file names, and the `auth_index` of each listed provider key without `*` in its
   * `excluded-models` ({@link quotaProbeTarget} resolves both). Reports of credentials that no longer exist (a config
   * key whose identity changed with an edit, its id being content-addressed) are dropped here.
   */
  quotaCheckTargets(viewer: Scope): string[] {
    const entries = this.#pool.entries();

    this.#quota.retain(new Set(entries.map(({ credential }) => credential.id)));

    return entries
      .filter((entry) => {
        if (!reaches(viewer, entry.credential.owner, "full")) return false;

        const { credential } = entry;

        if (!listed(entry) || !isQuotaProvider(executorKey(credential))) return false;

        return credential.source === "config"
          ? !credential.excludedModels.some(isDisablingPattern)
          : !credential.disabled;
      })
      .map(({ credential }) =>
        credential.source === "config" ? this.#authIndex(credential.id) : credential.id,
      );
  }

  /**
   * Takes the lease of a check of every quota (`quota_sweep`, `@commissary/state` `lease.ts`) at this object's own
   * time; refused while a live sweep holds it.
   */
  takeQuotaSweepLease(source: LeaseSource): TakeLease {
    return this.#leases.take(QUOTA_SWEEP_LEASE, source);
  }

  /** Marks the sweep holding `token` alive; `false` when it no longer holds the lease. */
  renewQuotaSweepLease(token: string): boolean {
    return this.#leases.renew(token);
  }

  /** Gives back the lease taken with `token` (a lease taken over meanwhile is left alone). */
  releaseQuotaSweepLease(token: string): void {
    this.#leases.release(token);
  }

  // --- provider OAuth logins (src/oauth) ------------------------------------------------------------------------

  /** Starts a provider login (`GET /oauth/auth-url`): returns the URL to open and the session `state`. */
  oauthStart(input: StartInput, viewer: Scope, wantPrivate = false): Promise<StartResult> {
    const owner = this.#importOwner(viewer, wantPrivate);

    if (!owner.ok) return Promise.resolve({ ok: false, status: 403, error: owner.failure.message });

    return this.#runOAuth(this.#oauth.start({ ...input, owner: owner.owner }));
  }

  /** Whether `viewer` may follow the login `state` (its starter, or an org admin for a shared login); unknown states pass. */
  #sessionReachable(state: string, viewer: Scope): boolean {
    const session = this.#sessions.get(state, Date.now());

    return session === undefined || reaches(viewer, session.owner, "full");
  }

  /** `GET /oauth/status`: pending/ok/error; for device logins each call advances the upstream poll when due. */
  oauthStatus(state: string, viewer: Scope): Promise<StatusResult> {
    if (!this.#sessionReachable(state, viewer))
      return Promise.resolve({ status: "error", error: "unknown or expired state" });

    return this.#runOAuth(this.#oauth.status(state));
  }

  /** Completes a callback login from a pasted/redirected `code` + `state` (management and public browser routes). */
  oauthCallback(input: CallbackInput, viewer: Scope): Promise<CallbackResult> {
    if (!this.#sessionReachable(input.state.trim(), viewer))
      return Promise.resolve({ ok: false, status: 404, error: "unknown or expired state" });

    return this.#runOAuth(this.#oauth.callback(input));
  }

  /** `DELETE /oauth/session`: cancels a pending login. */
  oauthCancel(state: string, viewer: Scope): Promise<{ readonly cancelled: boolean }> {
    if (!this.#sessionReachable(state, viewer)) return Promise.resolve({ cancelled: false });

    return Effect.runPromise(this.#oauth.cancel(state));
  }

  #runOAuth<A>(effect: Effect.Effect<A, never, HttpClient.HttpClient>): Promise<A> {
    return Effect.runPromise(effect.pipe(Effect.provide(FetchHttpClient.layer)));
  }

  /**
   * Stores an auth file. Replacing the token material of an existing credential (a re-login, possibly into another
   * account) drops its quota report and reset grants, which described the previous tokens.
   */
  #upsert(
    name: string,
    content: string | JsonObject,
    mergeExisting: boolean,
    owner?: string,
  ): UpsertResult {
    const result = this.#pool.upsert(name, content, {
      mergeExisting,
      ...(owner === undefined ? {} : { owner }),
    });

    if (result.ok && result.credentialsChanged && !result.created) {
      this.#quota.delete(result.id);
      this.#grants.forget(result.id);
    }

    return result;
  }

  /** Credential changes move refresh deadlines; a failure to re-arm must never fail the management call. */
  async #rearm(): Promise<void> {
    await this.#refresh.rearm().catch(() => undefined);
  }
}
