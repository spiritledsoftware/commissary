/**
 * Retry planning: should another retry round start, and how long to wait for a cooldown?
 *
 * Go source: sdk/cliproxy/auth/conductor_selection.go (effectiveRequestRetryLimit, retryRoundAvailabilityForAuth,
 * retryAllowed, closestCooldownWaitWithAttempted, shouldRetryAfterErrorWithAttempted steps 3-5). Docs: credentials.md §7.1.
 * Pure: state, clock and settings are inputs. The Worker runs the loop (including the sleep); the ControlPlane only
 * answers this question because it owns the cooldown state of every credential.
 */
import { Schema } from "effect";
import type { Json } from "@commissary/json";
import type { SpendGate } from "@commissary/state/spend";
import type { Reach } from "../../grants/reach.ts";
import { isCredentialRetryRoundStatus } from "../cooldown/classify.ts";
import { MIN_QUOTA_COOLDOWN_MS } from "../cooldown/mark-result.ts";
import {
  AuthKind,
  type Credential,
  type CredentialError,
  type CredentialState,
  executorKey,
} from "../model.ts";
import { servesMember } from "../ownership.ts";
import { availabilityBlock, isBlockedForModel } from "./availability.ts";
import { grantedRoute } from "./grants.ts";
import { canonicalModelKey } from "./model-name.ts";
import { type ModelRoute, resolveModelRoute, type RoutingContext } from "./routing.ts";
import type { CredentialEntry } from "./pick.ts";

const optional = Schema.optionalKey;

export const RetryQuery = Schema.Struct({
  providers: Schema.Array(Schema.String),
  /** Route model as requested (may carry prefix and suffix). */
  model: Schema.String,
  /** Zero-based retry round that just failed. */
  round: Schema.Int,
  /** `routing.retry.request-retry` (per-credential `request_retry` overrides it). */
  requestRetry: Schema.Int,
  /** HTTP status of the error that ended the round (0 for transport errors). */
  status: Schema.Int,
  /** Credentials attempted in the round that just failed. */
  attempted: optional(Schema.Array(Schema.String)),
  /** `Retry-After` carried by the error, used when no credential gives a recovery time. */
  retryAfterMs: optional(Schema.Number),
  /** `routing.retry.max-retry-interval` in milliseconds; non-positive never waits. */
  maxWaitMs: Schema.Number,
  pinnedAuthId: optional(Schema.String),
  /** The member the request is for: private credentials of others do not keep a retry alive. */
  memberId: optional(Schema.String),
  /** A shared agent's run (#227): the agent it acts as, reaching every shared credential whatever the grants. */
  agentId: optional(Schema.String),
  requireAuthKind: optional(AuthKind),
  disallowFreeCodex: optional(Schema.Boolean),
});

export type RetryQuery = typeof RetryQuery.Type;

export type RetryPlan =
  /** `retryAfterMs`: how long until a credential recovers when that exceeded `maxWaitMs` (for `Retry-After`). */
  | { readonly retry: false; readonly retryAfterMs?: number }
  | { readonly retry: true; readonly waitMs: number };

const parseIntAny = (value: Json | undefined): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);

  if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) return Number(value.trim());

  return undefined;
};

/** `RequestRetryOverride` (negative values are ignored). */
export const requestRetryOverride = (
  credential: Pick<Credential, "metadata">,
): number | undefined => {
  for (const key of ["request_retry", "request-retry"]) {
    const parsed = parseIntAny(credential.metadata[key]);

    if (parsed !== undefined) return parsed < 0 ? undefined : parsed;
  }

  return undefined;
};

/** `effectiveRequestRetryLimit`. */
export const effectiveRequestRetry = (
  credential: Pick<Credential, "metadata">,
  defaultRetry: number,
): number => requestRetryOverride(credential) ?? Math.max(0, defaultRetry);

const retryRoundStateEligible = (
  error: CredentialError | undefined,
  quotaExceeded: boolean,
): boolean =>
  error === undefined ? quotaExceeded : isCredentialRetryRoundStatus(error.httpStatus ?? 0);

export interface RetryAvailability {
  readonly eligible: boolean;
  readonly next: number;
}

/**
 * `retryRoundAvailabilityForAuth`: a blocked credential is retry-eligible only with a known future recovery whose
 * last error opens retry rounds (or a quota flag without any error).
 */
export const retryRoundAvailability = (
  state: CredentialState,
  credential: Credential,
  model: string,
  now: number,
): RetryAvailability => {
  const block = isBlockedForModel(credential, state, model, now);

  if (!block.blocked) return { eligible: true, next: 0 };

  if (block.next === 0 || block.reason === "disabled") return { eligible: false, next: 0 };

  if (
    state.quota.exceeded &&
    state.quota.reason === "credential_quota" &&
    state.quota.nextRecoverAt > now
  ) {
    return { eligible: retryRoundStateEligible(state.lastError, true), next: block.next };
  }

  const key = canonicalModelKey(model);
  const states = Object.entries(state.modelStates);

  if (key !== "" && states.length > 0) {
    let matchedBlocked = false;

    for (const [stateModel, modelState] of states) {
      if (canonicalModelKey(stateModel) !== key) continue;

      if (modelState.status === "disabled") return { eligible: false, next: 0 };

      const stateBlock = availabilityBlock(
        modelState.unavailable,
        modelState.quota.exceeded,
        modelState.nextRetryAfter,
        modelState.quota.nextRecoverAt,
        now,
      );

      if (!stateBlock.blocked) continue;
      matchedBlocked = true;

      if (
        stateBlock.next === 0 ||
        !retryRoundStateEligible(modelState.lastError, modelState.quota.exceeded)
      ) {
        return { eligible: false, next: 0 };
      }
    }

    if (matchedBlocked) return { eligible: true, next: block.next };
  }

  if (!retryRoundStateEligible(state.lastError, state.quota.exceeded))
    return { eligible: false, next: 0 };

  return { eligible: true, next: block.next };
};

/**
 * Availability of a credential for the routed model. Alias pools keep cooldown state per upstream model, so the
 * credential is as available as its best upstream model (Go only looks at the alias name here and discovers the
 * cooling pool when it filters the execution models).
 */
const routeAvailability = (
  state: CredentialState,
  credential: Credential,
  route: ModelRoute | undefined,
  now: number,
): { readonly eligible: boolean; readonly next: number } => {
  if (route === undefined) return retryRoundAvailability(state, credential, "", now);

  if (route.upstreamModels.length <= 1 && route.pooled !== true)
    return retryRoundAvailability(state, credential, route.selectionModel, now);
  let best: { readonly eligible: boolean; readonly next: number } | undefined;

  for (const upstream of route.upstreamModels) {
    const availability = retryRoundAvailability(state, credential, upstream, now);

    if (availability.eligible && availability.next === 0) return availability;

    if (
      best === undefined ||
      (availability.eligible && (!best.eligible || availability.next < best.next))
    ) {
      best = availability;
    }
  }

  return best ?? { eligible: false, next: 0 };
};

export interface RetryPlanInput {
  readonly credentials: ReadonlyArray<CredentialEntry>;
  readonly query: RetryQuery;
  readonly routing: RoutingContext;
  /** What the caller may use (their grants), as in `SelectionInput`. */
  readonly reach: Reach;
  /** `credential -> cooling disabled`. */
  readonly coolingDisabled: (credential: Credential) => boolean;
  readonly now: number;
  /** The Spend limits of the request's member (`@commissary/state/spend`): shared credentials may be out of reach until a period ends. */
  readonly spend?: SpendGate | undefined;
}

/** `shouldRetryAfterErrorWithAttempted` steps 3-5 (the caller has already checked the error class). */
export const planRetry = (input: RetryPlanInput): RetryPlan => {
  const { query, now } = input;

  const providers = new Set(
    query.providers.map((provider) => provider.trim().toLowerCase()).filter(Boolean),
  );

  if (providers.size === 0 || query.round < 0) return { retry: false };
  const attempted = new Set(query.attempted ?? []);
  const pinned = query.pinnedAuthId?.trim() ?? "";
  const maxWait = query.maxWaitMs;

  let allowed = false;
  let found = false;
  let minWait = 0;

  for (const { credential, state } of input.credentials) {
    if (credential.disabled || state.status === "disabled") continue;

    if (!servesMember(credential, query.memberId)) continue;

    if (input.spend?.sharedBlocked !== undefined && credential.owner === undefined) continue;

    if (pinned !== "" && credential.id !== pinned) continue;

    if (query.requireAuthKind !== undefined && credential.authKind !== query.requireAuthKind)
      continue;

    if (
      query.disallowFreeCodex === true &&
      credential.provider === "codex" &&
      (credential.attributes.plan_type ?? "").trim().toLowerCase() === "free"
    ) {
      continue;
    }

    if (!providers.has(executorKey(credential))) continue;

    const resolved =
      query.model === "" ? undefined : resolveModelRoute(credential, query.model, input.routing);

    if (query.model !== "" && resolved === undefined) continue;

    const route =
      resolved === undefined ? undefined : grantedRoute(credential, resolved, input.reach);

    if (resolved !== undefined && route === undefined) continue;

    if (query.round >= effectiveRequestRetry(credential, query.requestRetry)) continue;
    const availability = routeAvailability(state, credential, route, now);
    const { eligible } = availability;

    // A credential at its Spend limit is free again when its period ends.
    const next = Math.max(
      availability.next,
      input.spend?.credentials.get(credential.id)?.resetsAt ?? 0,
    );

    if (!eligible) continue;
    allowed = true;

    const wasAttempted = attempted.has(credential.id);

    if (!wasAttempted || input.coolingDisabled(credential) || query.status !== 429) {
      if (next === 0) {
        // Something is available right now.
        return { retry: true, waitMs: 0 };
      }

      const wait = next - now;

      if (wait < 0) continue;

      if (!found || wait < minWait) {
        minWait = wait;
        found = true;
      }

      continue;
    }

    // Already attempted in the round that just failed with 429: never an immediate retry.
    const wait = next === 0 ? MIN_QUOTA_COOLDOWN_MS : Math.max(next - now, MIN_QUOTA_COOLDOWN_MS);

    if (!found || wait < minWait) {
      minWait = wait;
      found = true;
    }
  }

  if (!allowed) return { retry: false };

  if (found) {
    if (minWait > 0 && (maxWait <= 0 || minWait > maxWait))
      return { retry: false, retryAfterMs: minWait };

    return { retry: true, waitMs: minWait };
  }

  const hint = query.retryAfterMs;

  if (hint !== undefined) {
    if (hint < 0 || (hint > 0 && (maxWait <= 0 || hint > maxWait))) return { retry: false };

    return { retry: true, waitMs: hint };
  }

  return { retry: true, waitMs: 0 };
};
