/**
 * In-memory credential pool: credentials (stored files + provider keys), runtime state, rotation cursors and
 * session affinity behind the `pick` / `report` operations of the ControlPlane Durable Object.
 *
 * Go counterpart: the `Manager` parts that register credentials and select them (sdk/cliproxy/auth/conductor*.go).
 * The class is free of Cloudflare types so it can be unit tested with a fake store and an injected clock. The
 * Durable Object guarantees single-threaded access, which replaces the Go mutexes.
 *
 * Deviation from Go: every report persists the whole runtime state, cooldowns included, whatever
 * `routing.cooldown.save-cooldown-status` says. The Durable Object is evicted after a short idle time (seconds in
 * workerd, minutes in production) and on deploys; an eviction is not an operator restart, and Go's in-process cooldowns
 * live as long as the process. Workers cannot tell an eviction from a deploy, so the flag has no effect
 * (docs/MIGRATION.md "Not applied on Workers").
 */
import type { Config } from "../config/schema.ts";
import { sessionAffinityTtlMs } from "../config/accessors.ts";
import type { Reach } from "../grants/reach.ts";
import type { JsonObject } from "@commissary/json";
import { resetCooldownState } from "./cooldown-reset.ts";
import { type StoredCredential, deriveFileCredential, sanitizeAliases } from "./derive.ts";
import { parseAuthFile, type ImportFailureReason } from "./import.ts";
import { type CooldownSettings, coolingDisabledFor, markResult } from "./cooldown/mark-result.ts";
import { shouldSkipCredentialCooldown } from "./cooldown/classify.ts";
import { type Credential, type CredentialState, emptyState } from "./model.ts";
import { MerklePrefixMatcher } from "../session-routing/matcher.ts";
import type { SpendPolicy } from "@commissary/state/spend";
import { SessionCache } from "./selection/affinity.ts";
import { spendLimitReached } from "./selection/failures.ts";
import { canonicalModelKey } from "./selection/model-name.ts";
import { rotateRoute } from "./selection/routing.ts";
import {
  knownPrefixes,
  selectCredential,
  type CredentialEntry,
  type SelectionSettings,
} from "./selection/pick.ts";
import { planRetry, type RetryPlan, type RetryQuery } from "./selection/retry.ts";
import { RotationState } from "./selection/strategies.ts";
import type {
  Lease,
  PickRequest,
  PickResult,
  ReportOutcome,
  ReportResult,
} from "./selection/types.ts";
import type { UpsertOptions, UpsertOutcome } from "./store.ts";
import { summarizeCredential, toSnapshot, type CredentialSummary } from "./summary.ts";
import { synthesizeConfigCredentials } from "./synthesize.ts";
import { type ModelSource, toModelSource } from "../registry/source.ts";

/** Storage the pool needs (implemented by `CredentialStore`; tests may fake it). */
export interface PoolStore {
  list(): StoredCredential[];
  get(id: string): StoredCredential | undefined;
  upsert(id: string, provider: string, metadata: JsonObject, options: UpsertOptions): UpsertOutcome;
  setDisabled(id: string, disabled: boolean): StoredCredential | undefined;
  remove(id: string): boolean;
  loadStates(): Map<string, CredentialState>;
  saveState(id: string, state: CredentialState): void;
  deleteState(id: string): void;
}

/**
 * Runs a batch's storage writes, typically in a storage transaction (`transactionSync`), and returns what `write`
 * returned; throwing rolls the batch back and the pool's in-memory state is left untouched.
 */
export type Commit = (write: () => string[]) => string[];

/** The config as seen by the pool: a version for cheap change detection plus the decoded document. */
export interface ConfigView {
  readonly version: number;
  readonly config: Config;
}

export interface PoolOptions {
  readonly store: PoolStore;
  /** Returns the current config; called on every operation, so it must be cheap when nothing changed. */
  readonly config: () => ConfigView;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Adjusts the credential handed to executors by `pick` (never persisted), e.g. cached Vertex access tokens. */
  readonly decorate?: (credential: Credential) => Credential;
  /**
   * What a member may use of the shared credentials (their grants, ADR 0023); `undefined`: a request without a member.
   * Called on every pick and retry plan, so it must be cheap. Required: a pool without grants would serve everything,
   * so building one states that (`ALLOW_ALL`).
   */
  readonly reach: (member: string | undefined) => Reach;
  /**
   * Whether the org lets members use private credentials (`membership.private_credentials`). Off: every private
   * credential is disabled (kept, not deleted) until it is on again; call {@link CredentialPool.invalidate} when it
   * changes. Default on.
   */
  readonly privateCredentials?: () => boolean;
  /**
   * The private provider key groups of every member (`private-keys.ts`) with the counter that moves when they change; each
   * owner's config yields credentials that carry the owner. Called on every operation, so it must be cheap.
   */
  readonly privateKeys?: () => {
    readonly version: number;
    readonly configs: ReadonlyArray<{ readonly owner: string; readonly config: Config }>;
  };
  /**
   * The org's Spend limits (issue #71): `pick` refuses or narrows the selection by them and tags the lease with the
   * scopes to charge, `report` charges the attempt's cost to them. Absent: nothing is limited.
   */
  readonly spend?: SpendPolicy;
}

/** A stored (auth file) credential with its runtime state: the unit the refresh manager works on. */
export interface RefreshTarget {
  readonly credential: Credential;
  readonly state: CredentialState;
}

export interface RefreshCommit {
  /** Complete new auth-file metadata; omitted when only the runtime state changes. */
  readonly metadata?: JsonObject;
  readonly state?: CredentialState;
}

export type UpsertResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly provider: string;
      readonly created: boolean;
      readonly credentialVersion: number;
      readonly credentialsChanged: boolean;
    }
  | { readonly ok: false; readonly reason: ImportFailureReason; readonly message: string };

interface View {
  readonly configVersion: number;
  readonly privateVersion: number;
  readonly settings: SelectionSettings;
  readonly cooldown: CooldownSettings;
  readonly credentials: ReadonlyMap<string, Credential>;
}

/** Rotates alias pools: successive requests start on different upstream models. */
const POOL_OFFSET_WRAP = 2_000_000_000;

export class CredentialPool {
  readonly #store: PoolStore;
  readonly #config: () => ConfigView;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #decorate: (credential: Credential) => Credential;
  readonly #reach: PoolOptions["reach"];
  readonly #privateCredentials: () => boolean;
  readonly #privateKeys: NonNullable<PoolOptions["privateKeys"]>;
  readonly #spend: SpendPolicy | undefined;
  readonly #rotation = new RotationState();
  readonly #affinity = new SessionCache();
  readonly #lcp = new MerklePrefixMatcher();
  readonly #poolOffsets = new Map<string, number>();
  readonly #states: Map<string, CredentialState>;
  #view: View | undefined;

  constructor(options: PoolOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#decorate = options.decorate ?? ((credential) => credential);
    this.#reach = options.reach;
    this.#privateCredentials = options.privateCredentials ?? (() => true);
    this.#privateKeys = options.privateKeys ?? (() => ({ version: 0, configs: [] }));
    this.#spend = options.spend;
    this.#states = options.store.loadStates();
  }

  /** Rebuilds the derived credential set when the config or the stored credentials changed. */
  #current(): View {
    const { version, config } = this.#config();
    const privateKeys = this.#privateKeys();

    if (
      this.#view !== undefined &&
      this.#view.configVersion === version &&
      this.#view.privateVersion === privateKeys.version
    )
      return this.#view;
    const now = this.#now();
    const credentials = new Map<string, Credential>();

    const privateAllowed = this.#privateCredentials();

    for (const stored of this.#store.list()) {
      const credential = deriveFileCredential(stored, { config });

      // The org turned private credentials off: they stay stored but are not used until it turns them on again.
      credentials.set(
        stored.id,
        stored.owner !== undefined && !privateAllowed
          ? { ...credential, disabled: true }
          : credential,
      );
    }

    for (const credential of synthesizeConfigCredentials(config, now))
      credentials.set(credential.id, credential);

    // A member's private provider keys: their credentials carry the owner, and are disabled like private accounts.
    for (const { owner, config: ownerConfig } of privateKeys.configs)
      for (const credential of synthesizeConfigCredentials(ownerConfig, now))
        credentials.set(credential.id, {
          ...credential,
          owner,
          ...(privateAllowed ? {} : { disabled: true }),
        });

    // Config credentials are content-addressed: state of ids that disappeared (rotated keys) is garbage.
    for (const id of this.#states.keys()) {
      if (!credentials.has(id)) {
        this.#states.delete(id);
        this.#store.deleteState(id);
        this.#invalidateBindings(id);
      }
    }

    const oauthModelAlias: Record<string, ReturnType<typeof sanitizeAliases>> = {};

    for (const [channel, aliases] of Object.entries(config.oauth["model-alias"])) {
      oauthModelAlias[channel.trim().toLowerCase()] = sanitizeAliases(aliases);
    }

    const ttl = sessionAffinityTtlMs(config);
    this.#affinity.setTtl(ttl);
    this.#lcp.setTtl(ttl);
    this.#view = {
      configVersion: version,
      privateVersion: privateKeys.version,
      credentials,
      settings: {
        strategy: config.routing.strategy,
        sessionAffinity: config.routing["session-affinity"],
        sessionAffinitySubagents: config.routing["session-affinity-subagents"],
        forceModelPrefix: config.routing["force-model-prefix"],
        oauthModelAlias,
      },
      cooldown: {
        disableCooling: config.routing.cooldown["disable-cooling"],
        transientErrorCooldownSeconds: config.routing.cooldown["transient-error-cooldown-seconds"],
      },
    };

    return this.#view;
  }

  /** Session-affinity and LCP bindings of a credential that was removed, replaced or disabled. */
  #invalidateBindings(id: string): void {
    this.#affinity.invalidateAuth(id);
    this.#lcp.invalidateAuth(id);
  }

  /** Drops the derived view so the next operation re-reads the store (after a credential write). */
  #invalidate(): void {
    this.#view = undefined;
  }

  /** The org setting on private credentials changed: derive the credentials again. */
  invalidate(): void {
    this.#invalidate();
  }

  #state(id: string): CredentialState {
    return this.#states.get(id) ?? emptyState();
  }

  /** Model-registration view of every credential (no secrets): see `registry/source.ts`. */
  modelSources(): ModelSource[] {
    const view = this.#current();

    return [...view.credentials.values()].map((credential) =>
      toModelSource(credential, this.#state(credential.id)),
    );
  }

  pick(request: PickRequest): PickResult {
    const view = this.#current();
    const now = this.#now();
    const entries: CredentialEntry[] = [];

    for (const credential of view.credentials.values())
      entries.push({ credential, state: this.#state(credential.id) });

    const caller = { memberId: request.memberId, apiKeyId: request.apiKeyId };
    const gate = this.#spend?.gate(caller, now);

    // A limit of the request's API key without room refuses it whatever credential would serve: no cooldown, no failover.
    if (gate?.refuse !== undefined)
      return { ok: false, failure: spendLimitReached(gate.refuse, now) };

    const outcome = selectCredential({
      credentials: entries,
      request,
      settings: view.settings,
      runtime: { rotation: this.#rotation, affinity: this.#affinity, lcp: this.#lcp },
      reach: this.#reach(request.memberId),
      now,
      ...(gate === undefined ? {} : { spend: gate }),
    });

    if (!outcome.ok) {
      // Shared credentials were kept away by a member, team or org limit: that is why nothing could serve the request.
      if (gate?.sharedBlocked !== undefined && outcome.failure.code !== "provider_not_found")
        return { ok: false, failure: spendLimitReached(gate.sharedBlocked, now) };

      return outcome;
    }

    const { credential } = outcome.entry;
    let route = outcome.route;

    if (route.upstreamModels.length > 1) {
      const key = `${credential.id}|${route.routeModel.toLowerCase()}`;
      const offset = this.#poolOffsets.get(key) ?? 0;
      this.#poolOffsets.set(key, (offset + 1) % POOL_OFFSET_WRAP);
      route = rotateRoute(route, offset);
    }

    const stateModel = canonicalModelKey(route.selectionModel);

    const spend =
      this.#spend?.scopes(caller, { id: credential.id, shared: credential.owner === undefined }) ??
      [];

    const lease: Lease = {
      id: this.#newId(),
      credentialId: credential.id,
      credentialVersion: credential.credentialVersion,
      provider: credential.provider,
      model: stateModel,
      issuedAt: now,
      ...(outcome.affinityKeys.length === 0 ? {} : { affinityKeys: outcome.affinityKeys }),
      ...(outcome.lcp === undefined ? {} : { lcp: outcome.lcp }),
      ...(spend.length === 0 ? {} : { spend }),
    };

    return {
      ok: true,
      credential: toSnapshot(this.#decorate(credential)),
      route: {
        requestedModel: route.requestedModel,
        routeModel: route.routeModel,
        upstreamModel: route.upstreamModel,
        upstreamModels: route.upstreamModels,
        originalAlias: route.originalAlias,
        forceMapping: route.forceMapping,
        stateModel,
        pooled: route.pooled === true,
      },
      lease,
      ...(outcome.session === undefined ? {} : { session: outcome.session }),
    };
  }

  /**
   * Records the outcome of an attempt: counters, last error, the cooldown/quota state machine (`markResult`) and
   * session-affinity effects.
   */
  report(lease: Lease, result: ReportResult): ReportOutcome {
    // What the attempt cost is spent whatever became of the credential meanwhile (removed, replaced, stale lease).
    if (lease.spend !== undefined && result.costMicros !== undefined)
      this.#spend?.charge(lease.spend, result.costMicros, this.#now());

    const view = this.#current();
    const credential = view.credentials.get(lease.credentialId);

    if (credential === undefined) return { ok: false, error: "unknown_credential" };

    // A result for credentials that changed in the meantime says nothing about the new material.
    if (lease.credentialVersion < credential.credentialVersion) return { ok: true, applied: false };

    const now = this.#now();
    const previous = this.#state(credential.id);

    const next = markResult({
      credential,
      state: previous,
      now,
      model: result.model ?? lease.model,
      result,
      settings: view.cooldown,
    });

    this.#states.set(credential.id, next);
    this.#store.saveState(credential.id, next);

    if (result.success) {
      for (const key of lease.affinityKeys ?? []) this.#affinity.touch(key, credential.id, now);

      // A successful extension is recorded (or refreshed) as an LCP sequence of its own.
      if (lease.lcp !== undefined)
        this.#lcp.touch(lease.lcp.namespace, lease.lcp.sequence, credential.id, now);
    } else if (
      next.lastError !== undefined &&
      !shouldSkipCredentialCooldown(this.#affinityError(result, next))
    ) {
      for (const key of lease.affinityKeys ?? [])
        this.#affinity.compareAndDelete(key, credential.id);

      // Credential-attributed failures drop only the sequence that was attempted, unless a newer request refreshed it.
      if (lease.lcp !== undefined) {
        this.#lcp.removeBefore(
          lease.lcp.namespace,
          lease.lcp.sequence.fingerprints,
          credential.id,
          lease.lcp.generation,
          now,
        );
      }
    }

    return { ok: true, applied: true };
  }

  /** Stored credentials (never provider keys: they have no tokens) with their runtime state. */
  refreshTargets(): RefreshTarget[] {
    const targets: RefreshTarget[] = [];

    for (const credential of this.#current().credentials.values()) {
      if (credential.source === "file")
        targets.push({ credential, state: this.#state(credential.id) });
    }

    return targets;
  }

  refreshTarget(id: string): RefreshTarget | undefined {
    const credential = this.#current().credentials.get(id);

    return credential === undefined || credential.source !== "file"
      ? undefined
      : { credential, state: this.#state(id) };
  }

  /**
   * Persists a refresh result: new auth-file metadata (token changes bump `credentialVersion`, session bindings and
   * runtime state are kept) and/or the runtime state. Synchronous, so the write is durable before the caller returns.
   */
  commitRefresh(id: string, change: RefreshCommit): RefreshTarget | undefined {
    const stored = this.#store.get(id);

    if (stored === undefined) return undefined;

    if (change.metadata !== undefined) {
      this.#store.upsert(id, stored.provider, change.metadata, { mergeExisting: false });
      this.#invalidate();
    }

    if (change.state !== undefined) {
      this.#states.set(id, change.state);
      this.#store.saveState(id, change.state);
    }

    return this.refreshTarget(id);
  }

  /** The error as the affinity selector sees it: request-scoped and transport failures keep bindings. */
  #affinityError(result: ReportResult, state: CredentialState) {
    const error = state.lastError;

    return {
      status: result.error?.httpStatus ?? result.httpStatus ?? 0,
      message: error?.message ?? "",
      code: result.requestScoped === true ? "request_scoped" : result.error?.code,
    };
  }

  /** Should another retry round start, and after how long? (credentials.md §7.1 steps 3-5). */
  planRetry(query: RetryQuery): RetryPlan {
    const view = this.#current();
    const entries: CredentialEntry[] = [];

    for (const credential of view.credentials.values())
      entries.push({ credential, state: this.#state(credential.id) });

    const now = this.#now();

    return planRetry({
      credentials: entries,
      query,
      routing: { ...view.settings, knownPrefixes: knownPrefixes(entries) },
      reach: this.#reach(query.memberId),
      coolingDisabled: (credential) => coolingDisabledFor(credential, view.cooldown),
      now,
      spend: this.#spend?.gate({ memberId: query.memberId }, now),
    });
  }

  /** Every credential (stored files and provider keys) with its runtime state, ordered by id (management views). */
  entries(): RefreshTarget[] {
    return [...this.#current().credentials.values()]
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((credential) => ({ credential, state: this.#state(credential.id) }));
  }

  entry(id: string): RefreshTarget | undefined {
    const credential = this.#current().credentials.get(id);

    return credential === undefined ? undefined : { credential, state: this.#state(id) };
  }

  /** Clears the cooldown/quota timers of one credential (management "reset cooldown"); `undefined` when unknown. */
  resetCooldown(id: string): { readonly models: ReadonlyArray<string> } | undefined {
    const target = this.entry(id);

    if (target === undefined) return undefined;
    const reset = resetCooldownState(target.state, this.#now());
    this.#states.set(id, reset.state);
    this.#store.saveState(id, reset.state);

    return { models: reset.models };
  }

  list(): CredentialSummary[] {
    const view = this.#current();

    return [...view.credentials.values()]
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((credential) => summarizeCredential(credential, this.#state(credential.id)));
  }

  /** Imports/updates one auth file. `mergeExisting` keeps user settings of the previous file (re-login). */
  upsert(
    name: string,
    content: string | JsonObject,
    options: { readonly mergeExisting: boolean; readonly owner?: string | undefined },
  ): UpsertResult {
    const parsed = parseAuthFile(name, content);

    if (!parsed.ok) return parsed;
    const outcome = this.#store.upsert(parsed.id, parsed.provider, parsed.metadata, options);
    this.#invalidate();

    // Replaced material starts a fresh life: stale tokens must not keep a cooldown or a session binding.
    if (outcome.credentialsChanged && !outcome.created) {
      this.#states.delete(parsed.id);
      this.#store.deleteState(parsed.id);
      this.#invalidateBindings(parsed.id);
    }

    return {
      ok: true,
      id: parsed.id,
      provider: outcome.record.provider,
      created: outcome.created,
      credentialVersion: outcome.record.credentialVersion,
      credentialsChanged: outcome.credentialsChanged,
    };
  }

  remove(id: string): boolean {
    const removed = this.#store.remove(id);

    if (removed) {
      this.#states.delete(id);
      this.#invalidateBindings(id);
      this.#invalidate();
    }

    return removed;
  }

  /**
   * Removes several stored credentials with their runtime state and session bindings, dropping the derived view once
   * (a batch delete); returns the ids that existed. `commit` runs the storage writes (the caller's transaction, which
   * may add its own writes); the in-memory state changes only once it returned, so a transaction that rolls back
   * (throws) leaves the pool as it was.
   */
  removeMany(ids: ReadonlyArray<string>, commit: Commit = (write) => write()): string[] {
    const removed = commit(() => ids.filter((id) => this.#store.remove(id)));

    for (const id of removed) {
      this.#states.delete(id);
      this.#invalidateBindings(id);
    }

    if (removed.length > 0) this.#invalidate();

    return removed;
  }

  /**
   * Disables or enables several stored credentials, dropping the derived view once (a batch); returns the ids that are
   * stored auth files (the others are left alone). `commit`: as in {@link removeMany}.
   */
  setDisabledMany(
    ids: ReadonlyArray<string>,
    disabled: boolean,
    commit: Commit = (write) => write(),
  ): string[] {
    const applied = commit(() =>
      ids.filter((id) => this.#store.setDisabled(id, disabled) !== undefined),
    );

    if (disabled) for (const id of applied) this.#invalidateBindings(id);

    if (applied.length > 0) this.#invalidate();

    return applied;
  }

  /** Disables/enables a stored credential. Provider keys are disabled by removing them from the config. */
  setDisabled(id: string, disabled: boolean): "ok" | "not_found" | "config_credential" {
    if (this.#store.get(id) === undefined) {
      return this.#current().credentials.has(id) ? "config_credential" : "not_found";
    }

    this.#store.setDisabled(id, disabled);

    if (disabled) this.#invalidateBindings(id);
    this.#invalidate();

    return "ok";
  }
}
