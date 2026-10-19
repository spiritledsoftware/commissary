/**
 * Refresh manager: scheduling, single-writer refresh, request-time refresh and Vertex token minting.
 *
 * Go counterpart: sdk/cliproxy/auth/auto_refresh_loop.go + conductor_refresh.go (`refreshAuthForRequestAtEpoch`,
 * `tryRefreshAfterUnauthorized`, `ForceRefreshAuth`, `markRejectedAccessToken`, `UpdateRefreshedAuth`) and the
 * `RequestAuthPreparer` implementations. Docs: credentials.md §9-11, docs/ARCHITECTURE.md.
 *
 * The class is free of Cloudflare types: the Durable Object supplies the host (credential pool), the alarm scheduler
 * and the clock, tests supply fakes. Because the Durable Object is the only writer, the Go mutexes/singleflight map to:
 *  - `#inflight`: one refresh per credential at a time; concurrent callers (alarm, 401s, management) share its outcome;
 *  - one alarm multiplexed over all credentials: `rearm()` sets it to the minimum of `nextRefreshCheckAt`;
 *  - persistence (`host.commitRefresh`) is synchronous and happens before any caller sees the new token.
 */
import { Effect, type Layer } from "effect";
import type { HttpClient } from "effect/http";
import { CurrentOutboundPolicy, type OutboundPolicy } from "@commissary/core";
import type { JsonObject } from "@commissary/json";
import { accessTokenExpiry, accessTokenOf } from "../expiry.ts";
import { credentialsChanged } from "../merge.ts";
import { type Credential, executorKey } from "../model.ts";
import type { RefreshCommit, RefreshTarget } from "../pool.ts";
import { redactSecrets } from "../redact.ts";
import { hasUnauthorizedFailure } from "../selection/availability.ts";
import type { CredentialSnapshot } from "../selection/types.ts";
import { toSnapshot } from "../summary.ts";
import { refreshError, type RefreshError } from "./error.ts";
import { rfc3339 } from "./http.ts";
import { metaNeedsMint } from "./meta.ts";
import { applyRefreshFailure, applyRefreshSuccess } from "./outcome.ts";
import { refreshProtocolFor } from "./registry.ts";
import {
  ANTIGRAVITY_REQUEST_SAFETY_MS,
  hasRefreshCredential,
  isTerminalRefreshState,
  nextRefreshCheckAt,
  shouldRefresh,
  type RefreshSubject,
} from "./schedule.ts";
import { mergeRefreshedMetadata } from "./three-way.ts";
import type { RefreshEffect } from "./types.ts";
import { mintVertexToken, VertexTokenCache, type VertexToken } from "./vertex.ts";

/** Credential store the manager works on (implemented by `CredentialPool`). */
export interface RefreshHost {
  refreshTargets(): ReadonlyArray<RefreshTarget>;
  refreshTarget(id: string): RefreshTarget | undefined;
  commitRefresh(id: string, change: RefreshCommit): RefreshTarget | undefined;
}

/** The single Durable Object alarm. */
export interface AlarmScheduler {
  set(at: number): Promise<void>;
  clear(): Promise<void>;
}

export interface RefreshManagerOptions {
  readonly host: RefreshHost;
  readonly alarm: AlarmScheduler;
  /**
   * Transport of every upstream call: in production the global `fetch` behind the outbound guard
   * (`OutboundHttpClientLive`), since a Vertex service account names its own `token_uri` (ADR 0044).
   */
  readonly http: Layer.Layer<HttpClient.HttpClient>;
  /** The outbound guard's policy for the refreshes (default: no loopback, no own hosts known). */
  readonly outbound?: OutboundPolicy;
  readonly now?: () => number;
  /** Concurrent refreshes per alarm run (`oauth.auth-auto-refresh-workers`, default 16). */
  readonly workers?: () => number;
  /** Sleep before retry `attempt` of Claude/Codex refreshes; Go sleeps `attempt` seconds. */
  readonly retryDelayMs?: (attempt: number) => number;
  /** Upper bound of one refresh including retries (credential acquisition only; see `REQUEST_TIMEOUT`). */
  readonly timeoutMs?: number;
  /** `META_MINT_URL` override of the Meta key-mint endpoint. */
  readonly metaMintUrl?: string;
}

export type RefreshFailureCode =
  | "not_found"
  | "not_refreshable"
  | "unauthorized"
  | "disabled"
  | "refresh_failed"
  | "persist_failed";

export type RefreshResult =
  | {
      readonly ok: true;
      /** `false` when another refresh had already replaced the rejected token or the credential changed meanwhile. */
      readonly refreshed: boolean;
      readonly credential: CredentialSnapshot;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: RefreshFailureCode;
        readonly message: string;
        readonly httpStatus?: number;
      };
      /** The credential needs a new login (terminal 401 / disabled invalid grant): do not retry. */
      readonly terminal: boolean;
    };

export interface RefreshOptions {
  /** Access token the upstream answered 401 for (`tryRefreshAfterUnauthorized`). */
  readonly rejectedAccessToken?: string;
  /** Manual refresh: ignore the terminal-unauthorized gating (`ForceRefreshAuth`). */
  readonly force?: boolean;
}

export interface RunSummary {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
}

const DEFAULT_WORKERS = 16;

/** Cap of one whole refresh: three attempts of 30 s plus the retry sleeps (each HTTP call has its own 30 s bound). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** A credential whose refresh is running is looked at again after this long (Go `refreshPendingBackoff`). */
const PENDING_RECHECK_MS = 60_000;

/** After an alarm run a credential that is still due signals a bug: never spin faster than this. */
export const ANOMALY_REARM_MS = 30_000;

const defaultRetryDelay = (attempt: number): number => attempt * 1000;

type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: RefreshError };

const subjectOf = (credential: Credential): RefreshSubject & { readonly disabled: boolean } => ({
  provider: credential.provider,
  metadata: credential.metadata,
  attributes: credential.attributes,
  disabled: credential.disabled,
});

const failure = (
  code: RefreshFailureCode,
  message: string,
  extra: { readonly httpStatus?: number | undefined; readonly terminal?: boolean } = {},
): RefreshResult => ({
  ok: false,
  error: {
    code,
    message,
    ...(extra.httpStatus === undefined ? {} : { httpStatus: extra.httpStatus }),
  },
  terminal: extra.terminal === true,
});

export class RefreshManager {
  readonly #host: RefreshHost;
  readonly #alarm: AlarmScheduler;
  readonly #http: Layer.Layer<HttpClient.HttpClient>;
  readonly #outbound: OutboundPolicy | undefined;
  readonly #now: () => number;
  readonly #workers: () => number;
  readonly #retryDelayMs: (attempt: number) => number;
  readonly #metaMintUrl: string | undefined;
  readonly #timeoutMs: number;
  readonly #inflight = new Map<string, Promise<RefreshResult>>();
  readonly #vertexInflight = new Map<string, Promise<Outcome<VertexToken>>>();
  readonly #vertexTokens = new VertexTokenCache();
  /** Refresh tokens the upstream asked us to leave alone (Claude 429 `Retry-After`), by credential id. */
  readonly #blockedUntil = new Map<string, number>();

  constructor(options: RefreshManagerOptions) {
    this.#host = options.host;
    this.#alarm = options.alarm;
    this.#http = options.http;
    this.#outbound = options.outbound;
    this.#now = options.now ?? Date.now;
    this.#workers = options.workers ?? (() => DEFAULT_WORKERS);
    this.#retryDelayMs = options.retryDelayMs ?? defaultRetryDelay;
    this.#metaMintUrl = options.metaMintUrl;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // --- scheduling -----------------------------------------------------------------------------------------------

  /**
   * Earliest time any credential needs attention (epoch ms, may be in the past), or `undefined` when nothing is
   * scheduled. Credentials being refreshed right now are looked at again after {@link PENDING_RECHECK_MS}.
   */
  nextDueAt(): number | undefined {
    const now = this.#now();
    let next: number | undefined;

    for (const target of this.#host.refreshTargets()) {
      const at = this.#inflight.has(target.credential.id)
        ? now + PENDING_RECHECK_MS
        : nextRefreshCheckAt(now, subjectOf(target.credential), target.state);

      if (at !== undefined && (next === undefined || at < next)) next = at;
    }

    return next;
  }

  /**
   * Points the single alarm at {@link nextDueAt} (or clears it). A credential that is due right now fires the alarm
   * after `dueDelayMs` (0 = immediately; the alarm handler passes a floor so a persistent failure cannot spin).
   */
  async rearm(dueDelayMs = 0): Promise<number | undefined> {
    const next = this.nextDueAt();

    if (next === undefined) {
      await this.#alarm.clear();

      return undefined;
    }

    const now = this.#now();
    const at = next <= now ? now + dueDelayMs : next;
    await this.#alarm.set(at);

    return at;
  }

  /** Refreshes every credential that is due now (bounded concurrency). Never throws. */
  async runDue(): Promise<RunSummary> {
    const now = this.#now();

    const due = this.#host
      .refreshTargets()
      .filter((target) => shouldRefresh(now, subjectOf(target.credential), target.state))
      .map((target) => target.credential.id);

    let succeeded = 0;
    let failed = 0;
    const queue = [...due];

    const worker = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const result = await this.#start(id, false).catch(() =>
          failure("refresh_failed", "refresh failed unexpectedly"),
        );

        if (result.ok) succeeded += 1;
        else failed += 1;
      }
    };

    const workers = Math.max(1, Math.min(this.#workers() || DEFAULT_WORKERS, queue.length));
    await Promise.all(Array.from({ length: queue.length === 0 ? 0 : workers }, worker));

    return { attempted: due.length, succeeded, failed };
  }

  /** Alarm handler body: refresh what is due, then re-arm (also when something threw). */
  async onAlarm(): Promise<RunSummary> {
    try {
      return await this.runDue();
    } finally {
      await this.rearm(ANOMALY_REARM_MS).catch(() => undefined);
    }
  }

  /** Cron safety net: same as an alarm, additionally repairs a lost or never-set alarm. */
  sweep(): Promise<RunSummary> {
    return this.onAlarm();
  }

  /** Drops in-memory state of a removed credential. */
  forget(id: string): void {
    this.#blockedUntil.delete(id);
    this.#vertexTokens.delete(id);
  }

  // --- request-time refresh -------------------------------------------------------------------------------------

  /**
   * Refreshes one credential now (`refreshAuthForRequest`). Concurrent callers share one upstream call. With
   * `rejectedAccessToken` (a 401 happened) the token is remembered as rejected and, when somebody already replaced it,
   * the current credential is returned without another upstream call.
   */
  async refreshNow(id: string, options: RefreshOptions = {}): Promise<RefreshResult> {
    const rejected = options.rejectedAccessToken?.trim() ?? "";
    const target = this.#host.refreshTarget(id);

    if (target === undefined) return failure("not_found", "credential not found");

    if (rejected !== "") this.#markRejected(target, rejected);

    const joined = this.#inflight.get(id);

    if (joined === undefined && rejected !== "") {
      const current = accessTokenOf(target.credential.metadata);

      if (current !== "" && current !== rejected) return this.#unchanged(target);
    }

    const result = await (joined ?? this.#start(id, options.force === true, rejected));

    if (joined === undefined) await this.rearm().catch(() => undefined);

    return result;
  }

  /**
   * Makes sure the credential can be used right now (`RequestAuthPreparer` for tokens):
   *  - Vertex: returns a cached or freshly minted service-account access token;
   *  - Meta: mints the provider key when only a DCA token is stored;
   *  - OAuth providers: refreshes when the access token is missing, expired, rejected, or (Antigravity) within 5 min.
   * The snapshot's `metadata.access_token` is then usable as is.
   */
  async ensureFresh(id: string): Promise<RefreshResult> {
    const target = this.#host.refreshTarget(id);

    if (target === undefined) return failure("not_found", "credential not found");
    const { credential, state } = target;
    const executor = executorKey(credential);

    if (executor === "vertex") return this.#ensureVertex(credential);

    const now = this.#now();
    let needsRefresh = false;

    if (executor === "meta") {
      needsRefresh = metaNeedsMint(credential.metadata);
    } else if (hasRefreshCredential(subjectOf(credential))) {
      const expiry = accessTokenExpiry(credential.metadata, state.rejectedAccessToken);
      const safety = credential.provider === "antigravity" ? ANTIGRAVITY_REQUEST_SAFETY_MS : 0;
      needsRefresh =
        accessTokenOf(credential.metadata) === "" ||
        (expiry !== undefined && expiry <= now + safety);
    }

    return needsRefresh ? this.refreshNow(id) : this.#unchanged(target);
  }

  /** Snapshot decorator for `pick`: injects a still-valid cached Vertex token (never persisted). */
  decorate = (credential: Credential): Credential => {
    if (executorKey(credential) !== "vertex") return credential;
    const token = this.#vertexTokens.get(credential.id, this.#fingerprint(credential), this.#now());

    return token === undefined ? credential : this.#withToken(credential, token);
  };

  // --- internals ------------------------------------------------------------------------------------------------

  #unchanged(target: RefreshTarget): RefreshResult {
    return { ok: true, refreshed: false, credential: toSnapshot(this.decorate(target.credential)) };
  }

  /** `markRejectedAccessToken`: only when the token carries no expiry information of its own. */
  #markRejected(target: RefreshTarget, token: string): void {
    const { credential, state } = target;

    if (accessTokenOf(credential.metadata) !== token || state.rejectedAccessToken === token) return;

    if (accessTokenExpiry(credential.metadata) !== undefined) return;
    this.#host.commitRefresh(credential.id, {
      state: { ...state, rejectedAccessToken: token, updatedAt: this.#now() },
    });
  }

  /** Starts (or joins) the refresh of `id`. */
  #start(id: string, force: boolean, failedAccessToken = ""): Promise<RefreshResult> {
    const running = this.#inflight.get(id);

    if (running !== undefined) return running;

    const promise = this.#execute(id, force, failedAccessToken)
      .catch((): RefreshResult => failure("refresh_failed", "refresh failed unexpectedly"))
      .finally(() => {
        this.#inflight.delete(id);
      });

    this.#inflight.set(id, promise);

    return promise;
  }

  async #run<A>(effect: RefreshEffect<A>): Promise<Outcome<A>> {
    const bounded = effect.pipe(
      Effect.timeoutOrElse({
        duration: `${this.#timeoutMs} millis`,
        orElse: () => Effect.fail(refreshError({ message: "refresh timed out" })),
      }),
      Effect.map((value): Outcome<A> => ({ ok: true, value })),
      Effect.catch((error) => Effect.succeed<Outcome<A>>({ ok: false, error })),
      Effect.provide(this.#http),
    );

    const guarded =
      this.#outbound === undefined
        ? bounded
        : bounded.pipe(Effect.provideService(CurrentOutboundPolicy, this.#outbound));

    try {
      return await Effect.runPromise(guarded);
    } catch {
      return { ok: false, error: refreshError({ message: "refresh failed unexpectedly" }) };
    }
  }

  async #execute(id: string, force: boolean, failedAccessToken: string): Promise<RefreshResult> {
    const target = this.#host.refreshTarget(id);

    if (target === undefined) return failure("not_found", "credential not found");
    const { credential, state: baseState } = target;
    const subject = subjectOf(credential);

    if (!hasRefreshCredential(subject))
      return failure("not_refreshable", "credential has no refresh token");
    const executor = executorKey(credential);
    const protocol = refreshProtocolFor(executor);

    if (protocol === undefined)
      return failure("not_refreshable", `provider ${executor} has no token refresh`);

    if (!force && isTerminalRefreshState(baseState, credential.disabled)) {
      return hasUnauthorizedFailure(baseState)
        ? failure("unauthorized", "credential is unauthorized: log in again", {
            httpStatus: 401,
            terminal: true,
          })
        : failure("disabled", "credential is disabled with an invalid grant", { terminal: true });
    }

    const now = this.#now();
    const blockedUntil = this.#blockedUntil.get(id) ?? 0;

    const effect: RefreshEffect<JsonObject> =
      blockedUntil > now
        ? Effect.fail(
            refreshError({
              message: `refresh temporarily blocked until ${rfc3339(blockedUntil)}`,
              status: 429,
            }),
          )
        : protocol({
            provider: executor,
            metadata: structuredClone(credential.metadata),
            attributes: credential.attributes,
            now,
            retryDelayMs: this.#retryDelayMs,
            metaMintUrl: this.#metaMintUrl,
          });

    const outcome = await this.#run(effect);
    const finishedAt = this.#now();

    const current = this.#host.refreshTarget(id);

    if (current === undefined) return failure("not_found", "credential was removed during refresh");

    // Material replaced while the refresh ran (re-login, re-import): the outcome describes the old tokens.
    const replaced =
      current.credential.credentialVersion !== credential.credentialVersion ||
      credentialsChanged(credential.metadata, current.credential.metadata);

    if (!outcome.ok) {
      const error = outcome.error;

      if (error.blockMs !== undefined) this.#blockedUntil.set(id, finishedAt + error.blockMs);
      this.#logFailure(executor, error);

      if (replaced) return this.#unchanged(current);
      const currentToken = accessTokenOf(current.credential.metadata);

      const result = applyRefreshFailure(current.state, {
        now: finishedAt,
        message: redactSecrets(error.message),
        status: error.status,
        disabled: current.credential.disabled,
        hasValidAccessToken: this.#hasValidAccessToken(current, finishedAt),
        // Only the token the upstream actually rejected (its expiry no longer proves it is usable).
        accessTokenRejected: failedAccessToken !== "" && currentToken === failedAccessToken,
        force,
        tokenExpiry: accessTokenExpiry(
          current.credential.metadata,
          current.state.rejectedAccessToken,
        ),
      });

      let committed = current;

      try {
        committed = this.#host.commitRefresh(id, { state: result.state }) ?? current;
      } catch {
        return failure("persist_failed", "refresh failed and its state could not be saved");
      }

      const terminal = isTerminalRefreshState(committed.state, committed.credential.disabled);

      return failure(
        terminal && hasUnauthorizedFailure(committed.state) ? "unauthorized" : "refresh_failed",
        redactSecrets(error.message),
        { httpStatus: error.status, terminal },
      );
    }

    if (replaced) return this.#unchanged(current);

    const merged = mergeRefreshedMetadata(
      credential.metadata,
      current.credential.metadata,
      outcome.value,
    );

    // Ineffective-refresh guard: a refresh that leaves the credential due again must not be retried in a tight loop.
    const probe = {
      ...subjectOf(current.credential),
      metadata: merged,
      disabled: current.credential.disabled,
    };

    const { rejectedAccessToken: _rejected, ...probeState } = current.state;
    const stillDue = shouldRefresh(finishedAt, probe, { ...probeState, nextRefreshAfter: 0 });

    const nextState = applyRefreshSuccess(
      baseState,
      current.state,
      finishedAt,
      stillDue,
      current.credential.disabled,
    );

    try {
      const committed = this.#host.commitRefresh(id, { metadata: merged, state: nextState });

      if (committed === undefined)
        return failure("not_found", "credential was removed during refresh");
      this.#blockedUntil.delete(id);

      return {
        ok: true,
        refreshed: true,
        credential: toSnapshot(this.decorate(committed.credential)),
      };
    } catch {
      // Go: "persist refreshed auth failed". The rotated token is lost; the next refresh will report invalid_grant.
      return failure("persist_failed", "refreshed tokens could not be saved");
    }
  }

  #hasValidAccessToken(target: RefreshTarget, now: number): boolean {
    if (accessTokenOf(target.credential.metadata) === "") return false;
    const expiry = accessTokenExpiry(target.credential.metadata, target.state.rejectedAccessToken);

    return expiry === undefined || expiry > now;
  }

  #logFailure(provider: string, error: RefreshError): void {
    // Never the message: upstream bodies may echo token material.
    Effect.runSync(
      Effect.logWarning("credential refresh failed").pipe(
        Effect.annotateLogs({ provider, status: String(error.status ?? "none") }),
      ),
    );
  }

  // --- Vertex ---------------------------------------------------------------------------------------------------

  #fingerprint(credential: Credential): string {
    return `${credential.credentialVersion}:${credential.updatedAt}`;
  }

  #withToken(credential: Credential, token: VertexToken): Credential {
    return {
      ...credential,
      metadata: {
        ...credential.metadata,
        access_token: token.accessToken,
        expired: rfc3339(token.expiresAt),
      },
    };
  }

  async #ensureVertex(credential: Credential): Promise<RefreshResult> {
    const fingerprint = this.#fingerprint(credential);
    const cached = this.#vertexTokens.get(credential.id, fingerprint, this.#now());

    if (cached !== undefined) return this.#vertexSnapshot(credential, cached, false);

    let pending = this.#vertexInflight.get(credential.id);

    if (pending === undefined) {
      pending = this.#run(mintVertexToken(credential.metadata, this.#now())).finally(() => {
        this.#vertexInflight.delete(credential.id);
      });
      this.#vertexInflight.set(credential.id, pending);
    }

    const outcome = await pending;

    if (!outcome.ok) {
      this.#logFailure("vertex", outcome.error);

      return failure("refresh_failed", redactSecrets(outcome.error.message), {
        httpStatus: outcome.error.status,
      });
    }

    this.#vertexTokens.set(credential.id, fingerprint, outcome.value);

    return this.#vertexSnapshot(credential, outcome.value, true);
  }

  #vertexSnapshot(credential: Credential, token: VertexToken, refreshed: boolean): RefreshResult {
    return { ok: true, refreshed, credential: toSnapshot(this.#withToken(credential, token)) };
  }
}
