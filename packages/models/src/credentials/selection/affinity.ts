/**
 * Session affinity: remembers which credential served a session so follow-up requests reuse it.
 *
 * Go source: sdk/cliproxy/auth/session_cache.go (`SessionCache`), selector.go (`SessionAffinitySelector.Pick/OnResult`,
 * `isSubagentSession`), home_session_alias.go (`isHierarchyParent`). Docs: credentials.md §6.9.
 * Differences: alias groups are replaced by independent keys, the LCP conversation matcher lives in
 * session-routing/matcher.ts (wired in pick.ts), and the
 * cache key additionally carries the caller scope so principals never share bindings.
 *
 * Guardian reviews (CLIProxyAPI 2f6f2924): every real selection is also recorded as a {@link SessionBinding} of its
 * session, with a sequence number that TTL refreshes do not change, so {@link SessionCache.latestSessionAuth} finds the
 * newest live selection of a session on any model.
 */

/** A real selection of a session: which provider served it, and its order among the selections of the cache. */
interface SessionBinding {
  readonly sessionKey: string;
  readonly provider: string;
  readonly sequence: number;
}

interface Entry {
  readonly authId: string;
  readonly expiresAt: number;
  readonly binding?: SessionBinding;
}

export const DEFAULT_AFFINITY_TTL_MS = 3_600_000;

export const DEFAULT_AFFINITY_CAPACITY = 65_536;

/** TTL cache `key -> credential id`. Every method takes the clock so tests control time. */
export class SessionCache {
  #entries = new Map<string, Entry>();
  /** Keys of the live selections of each session (`SessionBinding.sessionKey`). */
  readonly #sessions = new Map<string, Set<string>>();
  #sequence = 0;
  #ttlMs: number;
  readonly #capacity: number;

  constructor(
    ttlMs: number = DEFAULT_AFFINITY_TTL_MS,
    capacity: number = DEFAULT_AFFINITY_CAPACITY,
  ) {
    this.#ttlMs = ttlMs > 0 ? ttlMs : DEFAULT_AFFINITY_TTL_MS;
    this.#capacity = capacity > 0 ? capacity : DEFAULT_AFFINITY_CAPACITY;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** Applies a new TTL (config reload); existing bindings keep their deadlines. */
  setTtl(ttlMs: number): void {
    if (ttlMs > 0) this.#ttlMs = ttlMs;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Peek without refreshing. */
  get(key: string, now: number): string | undefined {
    const entry = this.#entries.get(key);

    if (entry === undefined) return undefined;

    if (now >= entry.expiresAt) {
      this.#delete(key);

      return undefined;
    }

    return entry.authId;
  }

  /** Lookup that extends the TTL on a hit. */
  getAndRefresh(key: string, now: number): string | undefined {
    const authId = this.get(key, now);

    if (authId !== undefined) this.#put(key, authId, now);

    return authId;
  }

  /** Binds `key` to `authId` and (re)starts its TTL. */
  set(key: string, authId: string, now: number): void {
    if (key === "" || authId === "") return;
    this.#put(key, authId, now);
  }

  /**
   * Binds `key` to `authId` as a real selection of the session `sessionKey` (`setSessionAliases`): it becomes the
   * session's newest binding, on `provider`.
   */
  setSelection(
    key: string,
    authId: string,
    now: number,
    sessionKey: string,
    provider: string,
  ): void {
    if (key === "" || authId === "") return;
    this.#put(key, authId, now, { sessionKey, provider, sequence: ++this.#sequence });
  }

  /**
   * `latestSessionAuth`: the credential of the newest live selection of `sessionKey` on one of `providers`, on any
   * model. Reads only: no TTL or eviction order changes.
   */
  latestSessionAuth(
    sessionKey: string,
    providers: ReadonlySet<string>,
    now: number,
  ): string | undefined {
    let latest: Entry | undefined;

    for (const key of this.#sessions.get(sessionKey) ?? []) {
      const entry = this.#entries.get(key);

      if (entry?.binding === undefined || now >= entry.expiresAt) continue;

      if (!providers.has(entry.binding.provider)) continue;

      if (latest?.binding === undefined || entry.binding.sequence > latest.binding.sequence)
        latest = entry;
    }

    return latest?.authId;
  }

  /** Extends the TTL only while `key` is still bound to `expectedAuthId`. */
  touch(key: string, expectedAuthId: string, now: number): boolean {
    const entry = this.#entries.get(key);

    if (entry === undefined || entry.authId !== expectedAuthId || now >= entry.expiresAt)
      return false;
    this.#put(key, expectedAuthId, now);

    return true;
  }

  /** Removes the binding only while it still points at `expectedAuthId`. */
  compareAndDelete(key: string, expectedAuthId: string): boolean {
    const entry = this.#entries.get(key);

    if (entry === undefined || entry.authId !== expectedAuthId) return false;
    this.#delete(key);

    return true;
  }

  /** Drops every binding of a credential (removed, replaced or disabled). */
  invalidateAuth(authId: string): void {
    for (const [key, entry] of this.#entries) if (entry.authId === authId) this.#delete(key);
  }

  /** Removes expired entries. */
  sweep(now: number): void {
    for (const [key, entry] of this.#entries) if (now >= entry.expiresAt) this.#delete(key);
  }

  #delete(key: string): void {
    const sessionKey = this.#entries.get(key)?.binding?.sessionKey;
    this.#entries.delete(key);

    if (sessionKey === undefined) return;
    const keys = this.#sessions.get(sessionKey);
    keys?.delete(key);

    if (keys?.size === 0) this.#sessions.delete(sessionKey);
  }

  /** Writes `key`; a write without a `binding` (a TTL refresh) keeps the one the entry had. */
  #put(key: string, authId: string, now: number, binding?: SessionBinding): void {
    const kept = binding ?? this.#entries.get(key)?.binding;
    // Re-insert so Map order tracks recency; the oldest entries are evicted first.
    this.#delete(key);
    this.#entries.set(key, {
      authId,
      expiresAt: now + this.#ttlMs,
      ...(kept === undefined ? {} : { binding: kept }),
    });

    if (kept !== undefined) {
      const keys = this.#sessions.get(kept.sessionKey) ?? new Set<string>();
      keys.add(key);
      this.#sessions.set(kept.sessionKey, keys);
    }

    if (this.#entries.size > this.#capacity) {
      this.sweep(now);

      for (const oldest of this.#entries.keys()) {
        if (this.#entries.size <= this.#capacity) break;
        this.#delete(oldest);
      }
    }
  }
}

/** `<callerScope>::<providers>::<sessionId>::<canonical model>`. */
export const affinityKey = (
  callerScope: string,
  provider: string,
  sessionId: string,
  model: string,
): string => [callerScope, provider, sessionId, model].join("::");

/** `isHierarchyParent`. */
const isHierarchyParent = (primary: string, fallback: string): boolean => {
  if (fallback === "" || primary === "" || primary === fallback) return false;

  if (primary.includes(":agent:")) return true;
  const index1 = primary.indexOf(":");
  const index2 = fallback.indexOf(":");

  if (index1 > 0 && index2 > 0 && primary.slice(0, index1) === fallback.slice(0, index2))
    return true;

  return index1 === -1 && index2 === -1;
};

/** `isSubagentSession`. */
export const isSubagentSession = (primaryId: string, fallbackId: string): boolean =>
  primaryId.includes(":agent:") || (fallbackId !== "" && isHierarchyParent(primaryId, fallbackId));
