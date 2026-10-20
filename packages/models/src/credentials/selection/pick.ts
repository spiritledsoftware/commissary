/**
 * Credential selection: candidate set -> availability -> priority tier -> strategy, optionally wrapped by session
 * affinity. Pure and deterministic given its inputs (state, runtime cursors and the clock are parameters).
 *
 * Go source: sdk/cliproxy/auth/conductor_selection.go (`pickNextMixedLegacy`), selector.go (`getAvailableAuths*`,
 * `collectAvailableByPriority`, `RoundRobinSelector`, `FillFirstSelector`, `WeightedRoundRobinSelector`,
 * `SessionAffinitySelector.Pick`). Docs: credentials.md §6.1-6.5, §6.9.
 *
 * Multiple providers are selected from one ID-sorted union (the Go "mixed" legacy path); the scheduler fast path's
 * per-provider slot cursor is not reproduced.
 */
import type { Json } from "@commissary/json";
import type { SpendGate } from "@commissary/state/spend";
import type { RoutingStrategy } from "../../config/schema.ts";
import { boundSessionIdentity } from "../../session-routing/identity.ts";
import { lcpNamespace, type MerklePrefixMatcher } from "../../session-routing/matcher.ts";
import type { Reach } from "../../grants/reach.ts";
import { type Credential, type CredentialState, executorKey } from "../model.ts";
import { affinityKey, isSubagentSession, type SessionCache } from "./affinity.ts";
import { servesMember } from "../ownership.ts";
import { isBlockedForModel } from "./availability.ts";
import {
  authNotFound,
  authUnavailable,
  modelCooldown,
  modelNotFound,
  providerNotFound,
} from "./failures.ts";
import { grantedRoute } from "./grants.ts";
import { canonicalModelKey } from "./model-name.ts";
import { effectiveRequestRetry } from "./retry.ts";
import { resolveModelRoute, type ModelRoute, type RoutingContext } from "./routing.ts";
import type { RotationState } from "./strategies.ts";
import type { Lease, PickFailure, PickRequest, ResolvedSession } from "./types.ts";

export interface CredentialEntry {
  readonly credential: Credential;
  readonly state: CredentialState;
}

export interface SelectionSettings extends Omit<RoutingContext, "knownPrefixes"> {
  readonly strategy: RoutingStrategy;
  readonly sessionAffinity: boolean;
  /** `routing.session-affinity-subagents`: subagents inherit the parent's credential. */
  readonly sessionAffinitySubagents: boolean;
}

export interface SelectionRuntime {
  readonly rotation: RotationState;
  readonly affinity: SessionCache;
  /** LCP conversation matcher; without it requests with no explicit session are never bound by content. */
  readonly lcp?: MerklePrefixMatcher;
}

export interface SelectionInput {
  readonly credentials: ReadonlyArray<CredentialEntry>;
  readonly request: PickRequest;
  readonly settings: SelectionSettings;
  readonly runtime: SelectionRuntime;
  /**
   * What the caller may use (their grants): shared credentials and upstream models outside it are no candidates. There
   * is no default, so a caller of selection states it (`ALLOW_ALL` is a decision, not an omission).
   */
  readonly reach: Reach;
  readonly now: number;
  /** What the Spend limits say about this request (`@commissary/state/spend`); absent: nothing limits it. */
  readonly spend?: SpendGate;
}

export type SelectionOutcome =
  | {
      readonly ok: true;
      readonly entry: CredentialEntry;
      readonly route: ModelRoute;
      /** Affinity cache keys bound by this pick (for `report`). */
      readonly affinityKeys: ReadonlyArray<string>;
      /** LCP binding of this pick (for `report`) and the session identity it produced. */
      readonly lcp?: NonNullable<Lease["lcp"]>;
      readonly session?: ResolvedSession;
    }
  | { readonly ok: false; readonly failure: PickFailure };

interface Candidate {
  readonly entry: CredentialEntry;
  readonly route: ModelRoute;
  readonly id: string;
  readonly weight: number;
  readonly priority: number;
}

const boundSessionId = boundSessionIdentity;

/** The identity an LCP match/binding settled on (`sessionId`/`parentSessionId`/fork/compaction flags). */
const resolved = (value: {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly isFork: boolean;
  readonly isCompaction: boolean;
  readonly nodeKind: string;
}): ResolvedSession => ({
  id: value.sessionId,
  ...(value.parentSessionId === "" ? {} : { parentId: value.parentSessionId }),
  ...(value.isFork ? { isFork: true } : {}),
  ...(value.isCompaction && !value.isFork ? { isCompaction: true } : {}),
  ...(value.nodeKind === "" ? {} : { nodeKind: value.nodeKind }),
});

const truthy = (value: Json | undefined): boolean =>
  value === true || (typeof value === "string" && value.toLowerCase() === "true");

/** Prefix set of enabled credentials: `team-a/gpt-5` only belongs to credentials registered under `team-a`. */
export const knownPrefixes = (credentials: ReadonlyArray<CredentialEntry>): ReadonlySet<string> => {
  const out = new Set<string>();

  for (const { credential } of credentials) {
    if (!credential.disabled && credential.prefix !== undefined && credential.prefix !== "")
      out.add(credential.prefix);
  }

  return out;
};

const highestPriority = (candidates: ReadonlyArray<Candidate>): Candidate[] => {
  let best = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) if (candidate.priority > best) best = candidate.priority;

  return candidates.filter((candidate) => candidate.priority === best);
};

/** Selects one credential for `request`, or explains why none is selectable. */
export const selectCredential = (input: SelectionInput): SelectionOutcome => {
  const { request, settings, runtime, now } = input;

  const providers = new Set(
    request.providers.map((provider) => provider.trim().toLowerCase()).filter(Boolean),
  );

  if (providers.size === 0) return { ok: false, failure: providerNotFound() };

  const routing: RoutingContext = { ...settings, knownPrefixes: knownPrefixes(input.credentials) };
  const tried = new Set(request.tried ?? []);
  const pinned = request.pinnedAuthId?.trim() ?? "";
  const round = request.retryRound ?? 0;
  let poolCooldownUntil = 0;
  let withheldByGrants = 0;

  // 1. Candidate set.
  const all: Candidate[] = [];

  for (const entry of input.credentials) {
    const { credential } = entry;

    if (credential.disabled) continue;

    if (!servesMember(credential, request.memberId)) continue;

    // A member, team or org limit without room: only the member's private credentials may serve.
    if (input.spend?.sharedBlocked !== undefined && credential.owner === undefined) continue;

    if (pinned !== "" && credential.id !== pinned) continue;

    if (request.requireAuthKind !== undefined && credential.authKind !== request.requireAuthKind)
      continue;

    if (
      request.disallowFreeCodex === true &&
      credential.provider === "codex" &&
      (credential.attributes.plan_type ?? "").trim().toLowerCase() === "free"
    ) {
      continue;
    }

    if (!providers.has(executorKey(credential))) continue;

    if (tried.has(credential.id)) continue;

    // Credentials age out of later retry rounds once their own `request-retry` budget is spent.
    if (round > 0 && effectiveRequestRetry(credential, request.requestRetry ?? 0) < round) continue;
    let route = resolveModelRoute(credential, request.model, routing);

    if (route === undefined) continue;

    // Grants come before cooling, tiers, strategy and affinity: none of them may see a model the caller cannot use.
    const granted = grantedRoute(credential, route, input.reach);

    if (granted === undefined) {
      withheldByGrants += 1;
      continue;
    }

    route = granted;

    if (route.upstreamModels.length > 1 || route.pooled === true) {
      // Alias pools skip upstream models that are cooling (`filterExecutionModels`); a credential without any usable
      // upstream model is not a candidate.
      let poolNext = 0;

      const usable = route.upstreamModels.filter((upstream) => {
        const block = isBlockedForModel(credential, entry.state, upstream, now);

        if (block.blocked && block.next > now && (poolNext === 0 || block.next < poolNext))
          poolNext = block.next;

        return !block.blocked;
      });

      const [firstUsable] = usable;

      if (firstUsable === undefined) {
        if (poolNext !== 0 && (poolCooldownUntil === 0 || poolNext < poolCooldownUntil))
          poolCooldownUntil = poolNext;
        continue;
      }

      route = {
        ...route,
        pooled: true,
        upstreamModel: firstUsable,
        upstreamModels: usable,
      };
    }

    all.push({
      entry,
      route,
      id: credential.id,
      weight: credential.weight,
      priority: credential.priority,
    });
  }

  all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (all.length === 0) {
    if (poolCooldownUntil !== 0) {
      const provider = providers.size === 1 ? [...providers][0] : "";

      return {
        ok: false,
        failure: modelCooldown(request.model, provider ?? "", poolCooldownUntil - now),
      };
    }

    // Candidates that exist but are not the caller's to use answer like a model nobody serves.
    if (withheldByGrants > 0) return { ok: false, failure: modelNotFound(request.model) };

    return { ok: false, failure: authNotFound() };
  }

  // Weighted round-robin ignores credentials with a non-positive weight before availability is evaluated.
  const weighted = settings.strategy === "weighted-round-robin";
  const pool = weighted ? all.filter((candidate) => candidate.weight > 0) : all;

  if (pool.length === 0) return { ok: false, failure: authNotFound("no auth candidates") };

  // 2. Availability across all tiers.
  const available: Candidate[] = [];
  let cooldownCount = 0;
  let earliest = 0;

  for (const candidate of pool) {
    // A shared credential at its own Spend limit is skipped like an unavailable one, until its period ends.
    const held = input.spend?.credentials.get(candidate.id);

    if (held !== undefined) {
      if (earliest === 0 || held.resetsAt < earliest) earliest = held.resetsAt;
      continue;
    }

    const block = isBlockedForModel(
      candidate.entry.credential,
      candidate.entry.state,
      candidate.route.selectionModel,
      now,
    );

    // The credits fallback may use credentials that are cooling down because their model quota is exhausted.
    if (!block.blocked || (request.ignoreCooldown === true && block.reason === "cooldown")) {
      available.push(candidate);
      continue;
    }

    if (block.reason === "cooldown") cooldownCount += 1;

    if (
      block.reason !== "disabled" &&
      block.next > now &&
      (earliest === 0 || block.next < earliest)
    )
      earliest = block.next;
  }

  if (available.length === 0) {
    if (cooldownCount === pool.length && earliest !== 0) {
      const provider = providers.size === 1 ? [...providers][0] : "";

      return { ok: false, failure: modelCooldown(request.model, provider ?? "", earliest - now) };
    }

    return { ok: false, failure: authUnavailable(earliest, now) };
  }

  // 3. Priority tier + strategy (+ optional Codex websocket preference).
  const providerLabel = [...providers].toSorted().join(",");
  const modelKey = canonicalModelKey(request.model);
  const rotationKey = `${providerLabel}:${modelKey}`;

  const strategyPick = (candidates: ReadonlyArray<Candidate>): Candidate | undefined => {
    let list = candidates;

    if (request.preferWebsockets === true && providers.has("codex")) {
      const websockets = list.filter(
        ({ entry }) =>
          truthy(entry.credential.attributes.websockets) ||
          truthy(entry.credential.metadata.websockets),
      );

      if (websockets.length > 0) list = websockets;
    }

    switch (settings.strategy) {
      case "fill-first":
        return runtime.rotation.fillFirst(list);
      case "weighted-round-robin":
        return runtime.rotation.weightedRoundRobin(rotationKey, list);
      default:
        return runtime.rotation.roundRobin(rotationKey, list);
    }
  };

  const fallbackTier = highestPriority(available);

  const done = (
    picked: Candidate | undefined,
    affinityKeys: ReadonlyArray<string>,
  ): SelectionOutcome =>
    picked === undefined
      ? { ok: false, failure: authNotFound("no auth available with positive weight") }
      : { ok: true, entry: picked.entry, route: picked.route, affinityKeys };

  // 4. Session affinity: a binding outranks priority, an unavailable binding falls back to the highest tier.
  if (!settings.sessionAffinity) return done(strategyPick(fallbackTier), []);
  const explicit = (request.session?.id.trim() ?? "") === "" ? undefined : request.session;

  const find = (authId: string | undefined): Candidate | undefined =>
    authId === undefined ? undefined : available.find((candidate) => candidate.id === authId);

  // Explicit harness identities are absolute authority; the LCP matcher only sees requests without one.
  const lcpRequest = explicit === undefined ? request.lcp : undefined;

  const lcpName =
    runtime.lcp === undefined || lcpRequest === undefined
      ? ""
      : lcpNamespace(
          providers.size === 1 ? ([...providers][0] ?? "mixed") : "mixed",
          modelKey,
          lcpRequest.callerScope,
        );

  if (runtime.lcp !== undefined && lcpRequest !== undefined && lcpName !== "") {
    const matcher = runtime.lcp;

    const sequence = {
      fingerprints: lcpRequest.fingerprints,
      minPrefixLength: lcpRequest.minPrefixLength,
      tailFingerprints: lcpRequest.tailFingerprints,
      envDigest: lcpRequest.envDigest,
    };

    const lcpDone = (
      picked: Candidate,
      generation: number,
      identity: Parameters<typeof resolved>[0],
    ): SelectionOutcome => ({
      ok: true,
      entry: picked.entry,
      route: picked.route,
      affinityKeys: [],
      lcp: { namespace: lcpName, generation, sequence },
      session: resolved(identity),
    });

    const matched = matcher.match(lcpName, sequence, now);
    const matchedCandidate = matched === undefined ? undefined : find(matched.authId);

    if (matched !== undefined && matchedCandidate !== undefined) {
      return lcpDone(matchedCandidate, matched.accessNumber, matched);
    }

    // No (usable) match: the strategy picks among the highest tier and the sequence is bound to that credential.
    const fresh = strategyPick(fallbackTier);

    if (fresh === undefined) return done(undefined, []);
    const binding = matcher.bind(lcpName, sequence, fresh.id, now);

    return binding === undefined ? done(fresh, []) : lcpDone(fresh, binding.accessNumber, binding);
  }

  const session = explicit ?? request.fallbackSession;
  const sessionId = session?.id.trim() ?? "";

  if (sessionId === "") return done(strategyPick(fallbackTier), []);

  const scope = session?.callerScope ?? "";
  const primaryId = boundSessionId(sessionId);
  const parentRaw = session?.parentId?.trim() ?? "";
  const parentId = parentRaw === "" ? "" : boundSessionId(parentRaw);
  const cacheKey = affinityKey(scope, providerLabel, primaryId, modelKey);

  const fallbackKey =
    parentId !== "" && parentId !== primaryId
      ? affinityKey(scope, providerLabel, parentId, modelKey)
      : undefined;

  const isFork = session?.isFork === true;
  const isSubagent = !isFork && isSubagentSession(primaryId, parentId);

  const bind = (authId: string): string[] => {
    runtime.affinity.set(cacheKey, authId, now);

    if (fallbackKey !== undefined && !isSubagent && !isFork) {
      runtime.affinity.set(fallbackKey, authId, now);

      return [cacheKey, fallbackKey];
    }

    return [cacheKey];
  };

  const cachedId = runtime.affinity.getAndRefresh(cacheKey, now);
  const bound = find(cachedId);

  if (bound !== undefined) return done(bound, bind(bound.id));

  // A stale binding is re-picked straight away; the parent alias is only consulted without a binding.
  if (
    cachedId === undefined &&
    fallbackKey !== undefined &&
    (!isSubagent || settings.sessionAffinitySubagents)
  ) {
    const inherited = find(runtime.affinity.get(fallbackKey, now));

    if (inherited !== undefined) return done(inherited, bind(inherited.id));
  }

  const picked = strategyPick(fallbackTier);

  return done(picked, picked === undefined ? [] : bind(picked.id));
};
