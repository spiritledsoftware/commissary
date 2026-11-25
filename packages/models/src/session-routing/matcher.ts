/**
 * LCP conversation matcher: remembers which credential served a conversation so follow-up requests (the same
 * messages plus new turns) reuse it without an explicit session marker.
 *
 * Go source: sdk/cliproxy/session/lcp.go (`MerklePrefixMatcher`: Match/Bind/Touch/RemoveFingerprintsBefore/
 * InvalidateAuth/LookupSession, compaction and fork detection, rolling Merkle prefix keys) and the namespace helpers of
 * sdk/cliproxy/auth/selector.go (`lcpAffinityNamespace`, `canonicalLCPProvider`). Every method takes the clock so tests
 * control time; there is no locking because a Durable Object runs one operation at a time. Docs: credentials.md §6.9.
 */
import { createHash } from "node:crypto";
import { MAX_COMPACTION_PROBE_WINDOW } from "./canonical.ts";

const DEFAULT_TTL_MS = 3_600_000;

const DEFAULT_MAX_TURNS = 1024;

const DEFAULT_MAX_GROUPS = 4096;

const DEFAULT_MAX_PREFIXES = 262_144;

const MIN_COMPACTION_OVERLAP_TURNS = 2;

const MAX_TAILS_PER_KEY = 16;

export interface MatcherConfig {
  readonly ttlMs?: number;
  readonly maxTurns?: number;
  readonly maxGroups?: number;
  /** Bounds group-to-prefix index entries, not just groups. */
  readonly maxPrefixes?: number;
}

/** A prepared request sequence (`PrepareExt`); empty `tailFingerprints`/`envDigest` fall back like Go. */
export interface Sequence {
  readonly fingerprints: ReadonlyArray<string>;
  readonly minPrefixLength: number;
  readonly tailFingerprints?: ReadonlyArray<string>;
  readonly envDigest?: string;
}

export interface MatchResult {
  readonly authId: string;
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly prefixLength: number;
  readonly isFork: boolean;
  readonly isCompaction: boolean;
  readonly nodeKind: string;
  readonly accessNumber: number;
}

export interface BindResult {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly isFork: boolean;
  readonly isCompaction: boolean;
  readonly nodeKind: string;
  readonly accessNumber: number;
}

interface Group {
  key: string;
  namespace: string;
  authId: string;
  sessionId: string;
  parentSessionId: string;
  minPrefixLength: number;
  isFork: boolean;
  isCompaction: boolean;
  nodeKind: string;
  environmentDigest: string;
  fingerprints: string[];
  tailFingerprints: string[];
  prefixKeys: string[];
  expiresAt: number;
  lastAccessNumber: number;
}

interface Namespace {
  readonly groups: Map<string, Group>;
  readonly prefixes: Map<string, Map<string, Group>>;
  readonly tails: Map<string, Set<Group>>;
}

const sha256 = (...chunks: Array<string | Uint8Array>): Buffer => {
  const hash = createHash("sha256");

  for (const chunk of chunks) hash.update(chunk);

  return hash.digest();
};

/** `rollingPrefixKeys`: `<n>:<hex of sha256(previous 0 fingerprint)>`. */
export const rollingPrefixKeys = (fingerprints: ReadonlyArray<string>): string[] => {
  const keys: string[] = [];
  let previous: Buffer = Buffer.alloc(32);
  fingerprints.forEach((fingerprint, index) => {
    previous = sha256(previous, "\0", fingerprint);
    keys.push(`${index + 1}:${previous.toString("hex")}`);
  });

  return keys;
};

const sequenceKey = (fingerprints: ReadonlyArray<string>): string =>
  rollingPrefixKeys(fingerprints).at(-1) ?? "";

const newLcpSessionId = (namespace: string, firstPrefix: string): string =>
  `lcp:v1:${sha256(`cli-proxy-api:lcp-session:v1\0${namespace}\0${firstPrefix}`).toString("hex")}`;

const newCompactionSessionId = (
  namespace: string,
  parentSessionId: string,
  seqKey: string,
): string =>
  `lcp:v1:${sha256(`cli-proxy-api:lcp-compaction-session:v1\0${namespace}\0${parentSessionId}\0${seqKey}`).toString("hex")}`;

const extractTail = (fingerprints: ReadonlyArray<string>): string[] =>
  fingerprints.slice(Math.max(0, fingerprints.length - MAX_COMPACTION_PROBE_WINDOW));

/** `fallbackEnvironmentDigest` / `environmentDigest` (identical bytes): digest of the system-turn fingerprints. */
const fallbackEnvDigest = (
  fingerprints: ReadonlyArray<string>,
  minPrefixLength: number,
): string => {
  if (minPrefixLength <= 1 || fingerprints.length === 0) return "";
  const count = Math.min(minPrefixLength - 1, fingerprints.length);
  const hash = createHash("sha256");

  for (let index = 0; index < count; index += 1) {
    // SAFETY: index < count <= fingerprints.length.
    const fingerprint = fingerprints[index] as string;
    hash.update(`${Buffer.byteLength(fingerprint)}:`);
    hash.update(fingerprint);
    hash.update("\0");
  }

  return hash.digest("hex");
};

const equalStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const isPrefixOf = (prefix: ReadonlyArray<string>, full: ReadonlyArray<string>): boolean => {
  if (full.length < prefix.length) return false;

  for (let index = 0; index < prefix.length; index += 1)
    if (prefix[index] !== full[index]) return false;

  return true;
};

const calculateOverlap = (
  cand: ReadonlyArray<string>,
  parent: ReadonlyArray<string>,
  candEnd: number,
  parentEnd: number,
): number => {
  let overlap = 0;

  while (
    overlap < MAX_COMPACTION_PROBE_WINDOW &&
    candEnd - overlap >= 0 &&
    parentEnd - overlap >= 0 &&
    cand[candEnd - overlap] === parent[parentEnd - overlap]
  ) {
    overlap += 1;
  }

  return overlap;
};

const isCompactionOverlap = (
  fullCandLen: number,
  candTailLen: number,
  candEnd: number,
  fullParentLen: number,
  parentTailLen: number,
  parentEnd: number,
  overlap: number,
  minPrefixLength: number,
  bestLength: number,
): boolean => {
  const candStartInTail = candEnd - overlap + 1;
  const parentStart = fullParentLen - 1 - (parentTailLen - 1 - parentEnd) - overlap + 1;
  const allowedStart = Math.max(minPrefixLength, bestLength + 1);

  if (candStartInTail > 0) {
    const candStartInFull = fullCandLen - 1 - (candTailLen - 1 - candEnd) - overlap + 1;

    if (candStartInFull > allowedStart) return false;
  }

  // History reduction: early candidate turns were collapsed into a summary, or early parent turns were truncated.
  return candEnd - overlap + 1 > 0 || parentStart > 0;
};

const isAncestorSession = (ns: Namespace, ancestorId: string, descendantId: string): boolean => {
  if (ancestorId === "" || descendantId === "" || ancestorId === descendantId) return false;
  let current = descendantId;

  for (let depth = 0; depth < 32; depth += 1) {
    let parentId = "";

    for (const group of ns.groups.values()) {
      if (group.sessionId === current && group.parentSessionId !== "") {
        parentId = group.parentSessionId;
        break;
      }
    }

    if (parentId === "") break;

    if (parentId === ancestorId) return true;
    current = parentId;
  }

  return false;
};

const tailKeyOf = (group: Group): string | undefined => {
  const tails = group.tailFingerprints.length === 0 ? group.fingerprints : group.tailFingerprints;

  return tails.length >= MIN_COMPACTION_OVERLAP_TURNS
    ? `${tails[tails.length - 2] ?? ""}\0${tails[tails.length - 1] ?? ""}`
    : undefined;
};

/** Bounded in-memory LCP index (`MerklePrefixMatcher`). */
export class MerklePrefixMatcher {
  #ttlMs: number;
  readonly #maxTurns: number;
  readonly #maxGroups: number;
  readonly #maxPrefixes: number;
  #namespaces = new Map<string, Namespace>();
  /** Least recently used first (Set preserves insertion order). */
  #lru = new Set<Group>();
  #groupCount = 0;
  #prefixCount = 0;
  #accessCounter = 0;
  #operations = 0;

  constructor(config: MatcherConfig = {}) {
    this.#ttlMs = config.ttlMs !== undefined && config.ttlMs > 0 ? config.ttlMs : DEFAULT_TTL_MS;
    this.#maxTurns =
      config.maxTurns !== undefined && config.maxTurns > 0 ? config.maxTurns : DEFAULT_MAX_TURNS;
    this.#maxGroups =
      config.maxGroups !== undefined && config.maxGroups > 0
        ? config.maxGroups
        : DEFAULT_MAX_GROUPS;

    const prefixes =
      config.maxPrefixes !== undefined && config.maxPrefixes > 0
        ? config.maxPrefixes
        : DEFAULT_MAX_PREFIXES;

    this.#maxPrefixes = Math.max(prefixes, this.#maxTurns);
  }

  /** Applies a new TTL (config reload); existing groups keep their deadlines. */
  setTtl(ttlMs: number): void {
    if (ttlMs > 0) this.#ttlMs = ttlMs;
  }

  get groupCount(): number {
    return this.#groupCount;
  }

  /** `MatchFingerprintsWithContext`: the longest known prefix (or compaction continuation) of the sequence. */
  match(namespace: string, sequence: Sequence, now: number): MatchResult | undefined {
    if (namespace === "") return undefined;
    const prepared = this.#prepare(sequence);

    if (prepared === undefined) return undefined;
    this.#tick(now);

    return this.#match(namespace, prepared, now);
  }

  /** `BindFingerprintsWithContext`: records the sequence for `authId` and returns its session identity. */
  bind(namespace: string, sequence: Sequence, authId: string, now: number): BindResult | undefined {
    if (namespace.trim() === "" || authId.trim() === "") return undefined;
    const prepared = this.#prepare(sequence);

    if (prepared === undefined) return undefined;
    this.#tick(now);

    return this.#bind(namespace, prepared, authId.trim(), now);
  }

  /** `TouchFingerprintsWithContext`: refreshes an existing sequence or binds a new extension. */
  touch(namespace: string, sequence: Sequence, authId: string, now: number): boolean {
    if (namespace.trim() === "" || authId.trim() === "") return false;
    const prepared = this.#prepare(sequence);

    if (prepared === undefined) return false;
    this.#tick(now);

    return this.#touch(namespace, prepared, authId.trim(), now);
  }

  /**
   * `RemoveFingerprintsBefore`: removes the exact sequence while it is still bound to `authId` and was not refreshed
   * after `maxGeneration` (0 = unconditionally).
   */
  removeBefore(
    namespace: string,
    fingerprintsInput: ReadonlyArray<string>,
    authId: string,
    maxGeneration: number,
    now: number,
  ): boolean {
    if (namespace === "" || authId === "" || fingerprintsInput.length === 0) return false;

    const fingerprints =
      fingerprintsInput.length > this.#maxTurns
        ? fingerprintsInput.slice(0, this.#maxTurns)
        : fingerprintsInput;

    this.#tick(now);
    const ns = this.#namespaces.get(namespace);

    if (ns === undefined) return false;
    const key = sequenceKey(fingerprints);
    const group = ns.groups.get(key);

    if (group === undefined || group.authId !== authId) return false;

    // A newer concurrent request refreshed the entry: keep the active binding.
    if (maxGeneration > 0 && group.lastAccessNumber > maxGeneration) return false;
    this.#removeGroup(group);

    return true;
  }

  /** `InvalidateAuth`: drops every binding of a credential. */
  invalidateAuth(authId: string): void {
    if (authId === "") return;

    for (const ns of this.#namespaces.values()) {
      for (const group of ns.groups.values()) if (group.authId === authId) this.#removeGroup(group);
    }
  }

  /** `Clear`. The access counter keeps growing so in-flight generations cannot evict newer bindings. */
  clear(): void {
    this.#namespaces = new Map();
    this.#lru = new Set();
    this.#groupCount = 0;
    this.#prefixCount = 0;
  }

  /** `LookupSession`: the credentials bound to an LCP session id, without side effects except expiry cleanup. */
  lookupSession(
    sessionId: string,
    now: number,
  ): { readonly authIds: string[]; readonly namespace: string } | undefined {
    if (sessionId === "") return undefined;
    const expired: Group[] = [];
    const active: Group[] = [];

    for (const ns of this.#namespaces.values()) {
      for (const group of ns.groups.values()) {
        if (group.sessionId !== sessionId) continue;

        if (now < group.expiresAt) active.push(group);
        else expired.push(group);
      }
    }

    for (const group of expired) this.#removeGroup(group);
    const first = active[0];

    if (first === undefined) return undefined;

    const authIds = [
      ...new Set(active.flatMap((group) => (group.authId === "" ? [] : [group.authId]))),
    ].toSorted();

    return authIds.length === 0 ? undefined : { authIds, namespace: first.namespace };
  }

  // --- internals -------------------------------------------------------------------------------------------

  /** Fills defaults and bounds the sequence (`sanitizeFingerprints`). */
  #prepare(sequence: Sequence): Required<Sequence> | undefined {
    const tailFingerprints =
      sequence.tailFingerprints === undefined || sequence.tailFingerprints.length === 0
        ? extractTail(sequence.fingerprints)
        : sequence.tailFingerprints;

    const envDigest =
      sequence.envDigest === undefined || sequence.envDigest === ""
        ? fallbackEnvDigest(sequence.fingerprints, sequence.minPrefixLength)
        : sequence.envDigest;

    let fingerprints = sequence.fingerprints;
    const min = sequence.minPrefixLength;

    if (fingerprints.length === 0 || min <= 0 || min > fingerprints.length) return undefined;

    if (fingerprints.length > this.#maxTurns) {
      fingerprints = fingerprints.slice(0, this.#maxTurns);

      if (min > fingerprints.length) return undefined;
    }

    return { fingerprints, minPrefixLength: min, tailFingerprints, envDigest };
  }

  #tick(now: number): void {
    this.#operations += 1;

    if (this.#operations % 128 === 0) this.#cleanup(now);
  }

  #cleanup(now: number): void {
    for (const ns of this.#namespaces.values()) {
      for (const group of ns.groups.values()) if (now >= group.expiresAt) this.#removeGroup(group);
    }
  }

  #namespace(name: string): Namespace {
    let ns = this.#namespaces.get(name);

    if (ns === undefined) {
      ns = { groups: new Map(), prefixes: new Map(), tails: new Map() };
      this.#namespaces.set(name, ns);
    }

    return ns;
  }

  #nextAccess(): number {
    this.#accessCounter += 1;

    return this.#accessCounter;
  }

  #moveToBack(group: Group): void {
    if (this.#lru.delete(group)) this.#lru.add(group);
  }

  #touch(namespace: string, seq: Required<Sequence>, authId: string, now: number): boolean {
    const ns = this.#namespace(namespace);
    const key = sequenceKey(seq.fingerprints);
    const existing = ns.groups.get(key);

    if (existing === undefined) {
      this.#bind(namespace, seq, authId, now);

      return true;
    }

    if (now >= existing.expiresAt) {
      this.#removeGroup(existing);
      this.#bind(namespace, seq, authId, now);

      return true;
    }

    if (existing.authId !== authId) {
      // A delayed success must not overwrite a binding that failed over to another credential.
      if (existing.authId !== "home-pending" && existing.authId !== "") return false;
      existing.authId = authId;
    }

    existing.expiresAt = now + this.#ttlMs;
    existing.lastAccessNumber = this.#nextAccess();
    existing.environmentDigest = seq.envDigest;

    if (
      seq.tailFingerprints.length > 0 &&
      !equalStrings(existing.tailFingerprints, seq.tailFingerprints)
    ) {
      this.#removeGroup(existing);
      existing.tailFingerprints = [...seq.tailFingerprints];
      this.#addGroup(existing);
    }

    this.#moveToBack(existing);

    return true;
  }

  #bind(namespace: string, seq: Required<Sequence>, authIdInput: string, now: number): BindResult {
    let authId = authIdInput;
    const { fingerprints, minPrefixLength, envDigest } = seq;
    const tailFingerprints = [...seq.tailFingerprints];
    const ns = this.#namespace(namespace);
    const key = sequenceKey(fingerprints);
    const existing = ns.groups.get(key);

    if (existing !== undefined) {
      if (now < existing.expiresAt) {
        const { sessionId, parentSessionId, isFork, isCompaction, nodeKind, prefixKeys } = existing;
        this.#removeGroup(existing);

        const rebound: Group = {
          key,
          namespace,
          authId,
          sessionId,
          parentSessionId,
          minPrefixLength,
          isFork,
          isCompaction,
          nodeKind,
          environmentDigest: envDigest,
          fingerprints: [...fingerprints],
          tailFingerprints,
          prefixKeys,
          expiresAt: now + this.#ttlMs,
          lastAccessNumber: this.#nextAccess(),
        };

        this.#addGroup(rebound);

        return {
          sessionId,
          parentSessionId,
          isFork,
          isCompaction,
          nodeKind,
          accessNumber: rebound.lastAccessNumber,
        };
      }

      this.#removeGroup(existing);
    }

    let sessionId = "";
    let parentSessionId = "";
    let isFork = false;
    let isCompaction = false;
    let nodeKind = "";
    const matched = this.#match(namespace, seq, now);

    if (matched !== undefined) {
      sessionId = matched.sessionId;
      parentSessionId = matched.parentSessionId;
      isFork = matched.isFork;
      isCompaction = matched.isCompaction;
      nodeKind = matched.nodeKind;

      if (isCompaction && matched.authId !== "" && authId === "") authId = matched.authId;
    }

    const prefixKeys = rollingPrefixKeys(fingerprints);

    if (sessionId === "") {
      const targetIndex =
        minPrefixLength > 0 && minPrefixLength <= prefixKeys.length ? minPrefixLength - 1 : 0;

      sessionId = newLcpSessionId(namespace, prefixKeys[targetIndex] ?? "");
    }

    const created: Group = {
      key,
      namespace,
      authId,
      sessionId,
      parentSessionId,
      minPrefixLength,
      isFork,
      isCompaction,
      nodeKind,
      environmentDigest: envDigest,
      fingerprints: [...fingerprints],
      tailFingerprints,
      prefixKeys,
      expiresAt: now + this.#ttlMs,
      lastAccessNumber: this.#nextAccess(),
    };

    this.#addGroup(created);

    return {
      sessionId,
      parentSessionId,
      isFork,
      isCompaction,
      nodeKind,
      accessNumber: created.lastAccessNumber,
    };
  }

  #addGroup(group: Group): void {
    const ns = this.#namespace(group.namespace);

    if (group.prefixKeys.length === 0) group.prefixKeys = rollingPrefixKeys(group.fingerprints);
    ns.groups.set(group.key, group);

    for (const prefix of group.prefixKeys) {
      let bucket = ns.prefixes.get(prefix);

      if (bucket === undefined) {
        bucket = new Map();
        ns.prefixes.set(prefix, bucket);
      }

      bucket.set(group.key, group);
    }

    const tailKey = tailKeyOf(group);

    if (tailKey !== undefined) {
      let bucket = ns.tails.get(tailKey);

      if (bucket === undefined) {
        bucket = new Set();
        ns.tails.set(tailKey, bucket);
      }

      bucket.add(group);
    }

    group.lastAccessNumber = this.#nextAccess();
    this.#lru.add(group);
    this.#groupCount += 1;
    this.#prefixCount += group.prefixKeys.length;

    while (this.#groupCount > this.#maxGroups || this.#prefixCount > this.#maxPrefixes) {
      const oldest = this.#lru.values().next();

      if (oldest.done === true) break;
      this.#removeGroup(oldest.value);
    }
  }

  #removeGroup(group: Group): void {
    const ns = this.#namespaces.get(group.namespace);

    if (ns !== undefined) {
      if (ns.groups.get(group.key) === group) ns.groups.delete(group.key);

      for (const prefix of group.prefixKeys) {
        const bucket = ns.prefixes.get(prefix);

        if (bucket === undefined) continue;
        bucket.delete(group.key);

        if (bucket.size === 0) ns.prefixes.delete(prefix);
      }

      const tailKey = tailKeyOf(group);

      if (tailKey !== undefined) {
        const bucket = ns.tails.get(tailKey);

        if (bucket !== undefined) {
          bucket.delete(group);

          if (bucket.size === 0) ns.tails.delete(tailKey);
        }
      }

      if (ns.groups.size === 0) this.#namespaces.delete(group.namespace);
    }

    this.#lru.delete(group);

    if (this.#groupCount > 0) this.#groupCount -= 1;
    this.#prefixCount =
      this.#prefixCount >= group.prefixKeys.length
        ? this.#prefixCount - group.prefixKeys.length
        : 0;
  }

  #newestMatchingGroup(
    bucket: Map<string, Group> | undefined,
    fingerprints: ReadonlyArray<string>,
    now: number,
  ): Group | undefined {
    if (bucket === undefined) return undefined;
    let best: Group | undefined;

    for (const group of bucket.values()) {
      if (now >= group.expiresAt || group.minPrefixLength > fingerprints.length) continue;

      if (!isPrefixOf(fingerprints, group.fingerprints)) continue;

      // Prefer the longest known trajectory so an exact prefix on an earlier turn does not mask a deeper fork;
      // ties go to the most recently accessed group.
      if (
        best === undefined ||
        group.fingerprints.length > best.fingerprints.length ||
        (group.fingerprints.length === best.fingerprints.length &&
          (group.lastAccessNumber > best.lastAccessNumber ||
            (group.lastAccessNumber === best.lastAccessNumber && group.expiresAt > best.expiresAt)))
      ) {
        best = group;
      }
    }

    return best;
  }

  #match(namespace: string, seq: Required<Sequence>, now: number): MatchResult | undefined {
    const ns = this.#namespaces.get(namespace);
    const { fingerprints, minPrefixLength } = seq;

    if (
      ns === undefined ||
      fingerprints.length === 0 ||
      minPrefixLength <= 0 ||
      minPrefixLength > fingerprints.length
    ) {
      return undefined;
    }

    const prefixKeys = rollingPrefixKeys(fingerprints);
    let low = minPrefixLength;
    let high = fingerprints.length;
    let best: Group | undefined;
    let bestLength = 0;

    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);

      const candidate = this.#newestMatchingGroup(
        // SAFETY: 1 <= middle <= bestLength bounds; prefixKeys has one entry per fingerprint.
        ns.prefixes.get(prefixKeys[middle - 1] as string),
        fingerprints.slice(0, middle),
        now,
      );

      if (candidate === undefined) {
        high = middle - 1;
        continue;
      }

      best = candidate;
      bestLength = middle;
      low = middle + 1;
    }

    if (best === undefined) return this.#matchCompaction(ns, namespace, seq, 0, now);

    best.expiresAt = now + this.#ttlMs;
    best.lastAccessNumber = this.#nextAccess();
    this.#moveToBack(best);

    let sessionId = best.sessionId;
    let parentSessionId = best.parentSessionId;
    let isFork = false;
    let nodeKind = best.nodeKind;

    // A true fork: the common prefix is shorter than the matched trajectory and the request extends past it.
    if (bestLength < best.fingerprints.length && fingerprints.length > bestLength) {
      // An in-place compaction milestone preserves a trailing subsequence of the parent trajectory.
      const compaction = this.#matchCompaction(ns, namespace, seq, bestLength, now);

      if (compaction !== undefined) return compaction;
      isFork = true;
      nodeKind = "fork";
      // SAFETY: 0 < bestLength < fingerprints.length and prefixKeys has one entry per fingerprint.
      parentSessionId = newLcpSessionId(namespace, prefixKeys[bestLength - 1] as string);
      // SAFETY: bestLength < fingerprints.length and prefixKeys has one entry per fingerprint.
      sessionId = newLcpSessionId(namespace, prefixKeys[bestLength] as string);
    }

    return {
      authId: best.authId,
      sessionId,
      parentSessionId,
      prefixLength: bestLength,
      isFork,
      isCompaction: best.isCompaction && !isFork,
      nodeKind,
      accessNumber: best.lastAccessNumber,
    };
  }

  #matchCompaction(
    ns: Namespace,
    namespace: string,
    seq: Required<Sequence>,
    bestLength: number,
    now: number,
  ): MatchResult | undefined {
    const { fingerprints, minPrefixLength, envDigest } = seq;

    const candTail =
      seq.tailFingerprints.length === 0 ? extractTail(fingerprints) : seq.tailFingerprints;

    const n = candTail.length;

    if (n < MIN_COMPACTION_OVERLAP_TURNS) return undefined;

    let maxCandidates: Group[] = [];
    let bestOverlap = 0;
    let hasOverflow = false;

    for (let candEnd = n - 1; candEnd >= MIN_COMPACTION_OVERLAP_TURNS - 1; candEnd -= 1) {
      // SAFETY: candEnd >= MIN_COMPACTION_OVERLAP_TURNS - 1 and candEnd < n = candTail.length.
      const tailKey = `${candTail[candEnd - 1] as string}\0${candTail[candEnd] as string}`;
      const candidateGroups = ns.tails.get(tailKey);

      if (candidateGroups === undefined || candidateGroups.size === 0) continue;
      // Lazily prune expired entries and count the live ones.
      let activeCount = 0;

      for (const group of candidateGroups) {
        if (now >= group.expiresAt) candidateGroups.delete(group);
        else activeCount += 1;
      }

      if (candidateGroups.size === 0) {
        ns.tails.delete(tailKey);
        continue;
      }

      if (activeCount > MAX_TAILS_PER_KEY) {
        hasOverflow = true;
        continue;
      }

      for (const group of candidateGroups) {
        if (group.environmentDigest !== envDigest) continue;

        const tails =
          group.tailFingerprints.length === 0 ? group.fingerprints : group.tailFingerprints;

        const tailLength = tails.length;

        if (tailLength < MIN_COMPACTION_OVERLAP_TURNS) continue;
        const overlap = calculateOverlap(candTail, tails, candEnd, tailLength - 1);

        if (
          overlap >= MIN_COMPACTION_OVERLAP_TURNS &&
          isCompactionOverlap(
            fingerprints.length,
            candTail.length,
            candEnd,
            group.fingerprints.length,
            tailLength,
            tailLength - 1,
            overlap,
            minPrefixLength,
            bestLength,
          )
        ) {
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            maxCandidates = [group];
          } else if (
            overlap === bestOverlap &&
            !maxCandidates.some((existing) => existing.sessionId === group.sessionId)
          ) {
            maxCandidates.push(group);
          }
        }
      }
    }

    if (hasOverflow || maxCandidates.length === 0) return undefined;

    // Ancestors of other candidates are not leaves; several distinct leaves are ambiguous.
    const leaves = maxCandidates.filter(
      (c1) =>
        !maxCandidates.some(
          (c2) =>
            c1.sessionId !== c2.sessionId && isAncestorSession(ns, c1.sessionId, c2.sessionId),
        ),
    );

    if (leaves.length !== 1) return undefined;
    // SAFETY: leaves.length === 1 was checked above.
    const best = leaves[0] as Group;
    best.expiresAt = now + this.#ttlMs;
    best.lastAccessNumber = this.#nextAccess();
    this.#moveToBack(best);

    return {
      authId: best.authId,
      sessionId: newCompactionSessionId(namespace, best.sessionId, sequenceKey(fingerprints)),
      parentSessionId: best.sessionId,
      prefixLength: bestOverlap,
      isFork: false,
      isCompaction: true,
      nodeKind: "compaction",
      accessNumber: best.lastAccessNumber,
    };
  }
}

/** `canonicalLCPProvider`. */
export const canonicalLcpProvider = (provider: string): string => {
  const value = provider.trim().toLowerCase();

  switch (value) {
    // Vertex and AI Studio keep namespaces of their own (CLIProxyAPI 3b20ee22).
    case "google":
    case "gemini":
      return "gemini";
    case "codex":
    case "openai":
      return "openai";
    case "claude":
    case "anthropic":
      return "claude";
    default:
      return value;
  }
};

/** `lcpAffinityNamespace`: empty without a provider or caller scope (no LCP binding then). */
export const lcpNamespace = (provider: string, model: string, callerScope: string): string => {
  const canonical = canonicalLcpProvider(provider);
  const scope = callerScope.trim();

  if (canonical === "" || scope === "") return "";

  return ["lcp:v1", canonical, model, scope].join("::");
};
