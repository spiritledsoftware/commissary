/**
 * Credential selection contract between the request pipeline and the credential store.
 *
 * Go source: sdk/cliproxy/auth/conductor_execution.go (pickNextMixed, MarkResult), sdk/cliproxy/auth/types.go (Auth).
 * The production implementation (`control-plane-picker.ts`) is a thin adapter over the ControlPlane Durable Object
 * RPC (`pick`, `report`, `planRetry`): the DO is the single writer for cursors, cooldowns, quota state and session
 * affinity. `static-picker.ts` is a config-only stand-in used by tests.
 *
 * Contract:
 *  - `pick` chooses one credential able to serve `model` for one of `providers` (in preference order), honouring
 *    `excludedIds` (credentials already tried in this round), `retryRound` (credentials age out of later rounds),
 *    `pinnedId`, session affinity (`session` within `callerScope`), priorities/weights and cooldowns. It returns an
 *    immutable snapshot, the per-credential model route and a lease. It fails with an `ExecutionError` whose `code`
 *    is `provider_not_found`, `auth_not_found`, `auth_unavailable`, `model_cooldown` or `spend_limit_reached` (429 with
 *    `Retry-After`; the second is a Spend limit, which no other credential or round changes).
 *  - `report` must be called exactly once per attempt with the lease so cooldown/quota bookkeeping and affinity stay
 *    consistent. It never fails (bookkeeping errors are logged by the implementation).
 *  - `planRetry` answers whether another retry round is worthwhile and how long to wait first.
 *  - Snapshots must be treated as read-only; secrets in `attributes`/`metadata` must never be logged.
 */
import { Context, type Effect } from "effect";
import type { JsonObject } from "@commissary/json";
import type { RetryPlan, RetryQuery } from "../credentials/selection/retry.ts";
import type { Lease, ReportResult, ResolvedSession } from "../credentials/selection/types.ts";
import type { LcpPrepared } from "../session-routing/canonical.ts";
import type { CurrentOrg } from "@commissary/core";
import type { ExecutionError } from "./errors.ts";
import type { ModelsEnv } from "../env.ts";

/** Read-only view of one credential (Go `cliproxyauth.Auth`). */
export interface CredentialSnapshot {
  /** Stable credential id (never derived from a secret in clear text). */
  readonly id: string;
  /** Provider / executor key, e.g. `claude`, `codex`, `gemini`, `openai-compatible-openrouter`. */
  readonly provider: string;
  /** `apikey` for configured keys, `oauth` for login credentials. */
  readonly kind: "apikey" | "oauth";
  /** Account label for logs and usage (e.g. compat entry name, email). */
  readonly label?: string;
  /** Model namespace prefix (`team-a` in `team-a/gpt-5`); stripped before execution. */
  readonly prefix?: string;
  /** Bumped when token/key material changes (a refresh); results are reported against it. */
  readonly credentialVersion?: number;
  /** A private credential (ADR 0023): the usage it earns is its owner's alone to read. */
  readonly private?: boolean;
  /**
   * String attributes as in Go: `base_url`, `api_key`, `compat_name`, `provider_key`, `config_index`, `priority`,
   * `weight`, `header:<Name>` (custom upstream headers), ...
   */
  readonly attributes: Readonly<Record<string, string>>;
  /** Provider metadata (OAuth tokens, account ids, `disable_cooling`, `request_retry`, ...). */
  readonly metadata: JsonObject;
}

/** Session identity extracted by the handler (see `handlers/session.ts`). */
export interface PickSession {
  readonly id: string;
  readonly parentId?: string;
  readonly isFork?: boolean;
}

export interface PickRequest {
  /** Candidate providers in preference order (from model resolution). */
  readonly providers: ReadonlyArray<string>;
  /** Route model as resolved by the handler: may carry a credential prefix and a `(thinking)` suffix. */
  readonly model: string;
  /** Caller isolation scope (`AccessPrincipal.callerScope`). */
  readonly callerScope: string;
  /** The member the request is for: their private credentials are candidates, no one else's (ADR 0023). */
  readonly memberId?: string;
  /** The API key the request came with: its Spend limits apply to whatever credential serves it (issue #71). */
  readonly apiKeyId?: string;
  /**
   * The shared agent whose run the request is (#227, ADR 0040): it acts as the agent, whose reach is its definition,
   * so the org's shared credentials serve it whatever the grants (no member: no private credential).
   */
  readonly agentId?: string;
  /** Session identity for affinity/stickiness, when the request carries one. */
  readonly session?: PickSession;
  /** Conversation fingerprints for the LCP matcher (requests without an explicit `session`). */
  readonly lcp?: LcpPrepared;
  /** Derived content-hash / message-hash identity, used when the LCP matcher does not apply. */
  readonly fallbackSession?: PickSession;
  /** Credentials already tried in this retry round. */
  readonly excludedIds?: ReadonlyArray<string>;
  /** Zero-based retry round (credentials whose own `request-retry` is below it are skipped). */
  readonly retryRound?: number;
  /** `routing.retry.request-retry`; per-credential `request_retry` overrides it. */
  readonly requestRetry?: number;
  /** Require this credential (e.g. video retrieval bound to the creating credential). */
  readonly pinnedId?: string;
  /** Select as if for this model while executing `model` (Interactions agents, Go `auth_selection_model`). */
  readonly selectionModel?: string;
  /** Exclude free-plan credentials (Codex image tools). */
  readonly disallowFreeAuth?: boolean;
  /** Downstream WebSocket request: prefer Codex credentials with `websockets=true`. */
  readonly preferWebsockets?: boolean;
  /** Antigravity credits fallback: cooling credentials stay selectable (credits are billed outside the model quota). */
  readonly ignoreCooldown?: boolean;
}

/** Routing of the requested model through the picked credential. */
export interface PickedRoute {
  readonly requestedModel: string;
  /** The model without this credential's prefix. */
  readonly routeModel: string;
  /** Upstream models to try in order (alias pools are rotated and exclude cooling models); never empty. */
  readonly upstreamModels: ReadonlyArray<string>;
  /** Model name clients should see in responses (the request, or the configured alias with `force-mapping`). */
  readonly originalAlias: string;
  readonly forceMapping: boolean;
  /** Key under which cooldown state for the selection is tracked. */
  readonly stateModel: string;
  /** Several upstream models share the alias: each attempt is reported under its upstream model. */
  readonly pooled: boolean;
}

export interface PickResult {
  readonly credential: CredentialSnapshot;
  readonly route: PickedRoute;
  /** Opaque lease to pass back to `report`. */
  readonly lease: Lease;
  /** Lease id for logs. */
  readonly leaseId: string;
  /** The session identity the LCP matcher settled on (usage `session_id`/`parent_session_id`). */
  readonly session?: ResolvedSession;
}

/** Outcome of one upstream attempt (the wire type of `ControlPlane.report`). */
export type AttemptResult = ReportResult;

export class CredentialPicker extends Context.Service<
  CredentialPicker,
  {
    readonly pick: (
      request: PickRequest,
    ) => Effect.Effect<PickResult, ExecutionError, ModelsEnv | CurrentOrg>;
    readonly report: (
      lease: Lease,
      result: AttemptResult,
    ) => Effect.Effect<void, never, ModelsEnv | CurrentOrg>;
    readonly planRetry: (
      query: RetryQuery,
    ) => Effect.Effect<RetryPlan, never, ModelsEnv | CurrentOrg>;
  }
>()("commissary/executor/CredentialPicker") {}
