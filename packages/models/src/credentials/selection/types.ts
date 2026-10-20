/**
 * Wire types of the selection RPC (`ControlPlane.pick` / `report`). Plain data only: they cross the Durable Object
 * RPC boundary. Requests are decoded with these schemas inside the DO; results are plain objects.
 */
import { Schema } from "effect";
import { SpendScope } from "@commissary/state/spend";
import { AuthKind, Credential, CredentialError } from "../model.ts";

const optional = Schema.optionalKey;

/** Session identity already extracted by the handler (header/body rules live in the pipeline slice). */
export const SessionRef = Schema.Struct({
  id: Schema.String,
  /** Parent/fork session; subagents may inherit the parent's credential. */
  parentId: optional(Schema.String),
  isFork: optional(Schema.Boolean),
  /** Hash of the caller (Access principal): bindings never cross scopes. */
  callerScope: optional(Schema.String),
});

export type SessionRef = typeof SessionRef.Type;

/** A prepared LCP request sequence (`session-routing/canonical.ts#prepareFingerprints`). */
export const LcpSequence = Schema.Struct({
  fingerprints: Schema.Array(Schema.String),
  minPrefixLength: Schema.Int,
  tailFingerprints: Schema.Array(Schema.String),
  envDigest: Schema.String,
});

export type LcpSequence = typeof LcpSequence.Type;

/** The session identity the selection settled on (explicit, LCP match or LCP binding), for usage records. */
export const ResolvedSession = Schema.Struct({
  id: Schema.String,
  parentId: optional(Schema.String),
  isFork: optional(Schema.Boolean),
  isCompaction: optional(Schema.Boolean),
  nodeKind: optional(Schema.String),
});

export type ResolvedSession = typeof ResolvedSession.Type;

export const PickRequest = Schema.Struct({
  /** Executor provider keys able to serve the model (from the model registry). */
  providers: Schema.Array(Schema.String),
  /** Model as requested by the client: may carry a `prefix/` and a `(thinking)` suffix. */
  model: Schema.String,
  /** Credential ids already tried in this round. */
  tried: optional(Schema.Array(Schema.String)),
  /**
   * Zero-based retry round. Credentials whose effective `request-retry` is below the round age out of it
   * (`requestRetryRoundExclusions`).
   */
  retryRound: optional(Schema.Int),
  /** `routing.retry.request-retry` as seen by the caller (per-credential `request_retry` overrides it). */
  requestRetry: optional(Schema.Int),
  /** Restrict selection to one credential (`pinned_auth_id`). */
  pinnedAuthId: optional(Schema.String),
  /**
   * The member the request is for. A private credential is a candidate only for the member that owns it; a request
   * without one (a service token) is served by shared credentials only.
   */
  memberId: optional(Schema.String),
  /** The API key the request came with: its Spend limits apply to whatever credential serves it. */
  apiKeyId: optional(Schema.String),
  /**
   * A shared agent's run (#227): the agent it acts as. Its reach is its definition, so every shared credential is a
   * candidate whatever the grants; without `memberId`, no private credential is.
   */
  agentId: optional(Schema.String),
  requireAuthKind: optional(AuthKind),
  /** Skip Codex credentials on the free plan. */
  disallowFreeCodex: optional(Schema.Boolean),
  /** Downstream WebSocket request: prefer Codex credentials with `websockets=true`. */
  preferWebsockets: optional(Schema.Boolean),
  /** Antigravity credits fallback: credentials in a quota cooldown stay selectable (disabled/expired ones do not). */
  ignoreCooldown: optional(Schema.Boolean),
  /** Explicit session identity (headers/body markers). Wins over `lcp` and `fallbackSession`. */
  session: optional(SessionRef),
  /** Conversation fingerprints for the LCP matcher; only used without an explicit `session`. */
  lcp: optional(Schema.Struct({ ...LcpSequence.fields, callerScope: Schema.String })),
  /** Derived content-hash / message-hash identity, used when the LCP matcher does not apply. */
  fallbackSession: optional(SessionRef),
});

export type PickRequest = typeof PickRequest.Type;

/** Routing outcome for the picked credential: requested model -> upstream model. */
export const ModelRouteSnapshot = Schema.Struct({
  requestedModel: Schema.String,
  routeModel: Schema.String,
  upstreamModel: Schema.String,
  upstreamModels: Schema.Array(Schema.String),
  originalAlias: Schema.String,
  forceMapping: Schema.Boolean,
  /** Key under which cooldown state for this request is tracked. */
  stateModel: Schema.String,
  /** Several upstream models share the alias: report each attempt under its upstream model (`ReportResult.model`). */
  pooled: Schema.Boolean,
});

export type ModelRouteSnapshot = typeof ModelRouteSnapshot.Type;

/**
 * Everything an executor needs: the credential including token metadata (never log it), resolved base URL and
 * headers. Produced per pick; do not cache across requests (tokens rotate).
 */
export const CredentialSnapshot = Schema.Struct({
  ...Credential.fields,
  /** `attributes.base_url` (config) or `metadata.base_url` (auth file); absent when the provider default applies. */
  baseUrl: optional(Schema.String),
  /** Executor key used for the lookup (`kimi.com` -> `kimi`, compat -> `openai-compatible-<name>`). */
  executor: Schema.String,
});

export type CredentialSnapshot = typeof CredentialSnapshot.Type;

export const Lease = Schema.Struct({
  id: Schema.String,
  credentialId: Schema.String,
  credentialVersion: Schema.Int,
  provider: Schema.String,
  /** Model key for cooldown state (canonical, no thinking suffix). */
  model: Schema.String,
  issuedAt: Schema.Number,
  /** Opaque session-affinity cache keys bound by this pick. */
  affinityKeys: optional(Schema.Array(Schema.String)),
  /** The Spend scopes with a limit that the attempt's Cost is charged to (`ReportResult.costMicros`); absent: none. */
  spend: optional(Schema.Array(SpendScope)),
  /** LCP binding made by this pick: the sequence to refresh on success or drop on failure (`generation` guards races). */
  lcp: optional(
    Schema.Struct({
      namespace: Schema.String,
      generation: Schema.Number,
      sequence: LcpSequence,
    }),
  ),
});

export type Lease = typeof Lease.Type;

export const PickFailureCode = Schema.Literals([
  "provider_not_found",
  "auth_not_found",
  "auth_unavailable",
  "model_cooldown",
  "model_not_found",
  "spend_limit_reached",
]);

export type PickFailureCode = typeof PickFailureCode.Type;

/** Why nothing could be picked (mirrors the Go selector errors, credentials.md §6.5). */
export const PickFailure = Schema.Struct({
  code: PickFailureCode,
  message: Schema.String,
  /** 429 for `model_cooldown` and `spend_limit_reached`, 400 for `model_not_found`, 503 for `auth_unavailable` with a known recovery; unset otherwise. */
  httpStatus: optional(Schema.Int),
  retryable: Schema.Boolean,
  /** Seconds until the earliest cooldown ends (also the `Retry-After` header value). */
  retryAfterSeconds: optional(Schema.Int),
  /** JSON error body for `model_cooldown`, `spend_limit_reached` (`{"error":{"code":"model_cooldown",...}}`) and `model_not_found`. */
  body: optional(Schema.String),
});

export type PickFailure = typeof PickFailure.Type;

export type PickResult =
  | {
      readonly ok: true;
      readonly credential: CredentialSnapshot;
      readonly route: ModelRouteSnapshot;
      readonly lease: Lease;
      /** Set when the LCP matcher decided the session identity. */
      readonly session?: ResolvedSession;
    }
  | { readonly ok: false; readonly failure: PickFailure };

/** Outcome of one upstream attempt, reported back with the lease. */
export const ReportResult = Schema.Struct({
  success: Schema.Boolean,
  httpStatus: optional(Schema.Int),
  /** Error code: `request_scoped`, `connection_lifecycle`, `transient_transport` and `force_cooldown` are special. */
  error: optional(CredentialError),
  /** Shorthand for `error.code = request_scoped`: the failure is the request's fault, no cooldown, bindings kept. */
  requestScoped: optional(Schema.Boolean),
  /** Upstream `Retry-After` in milliseconds, if any. */
  retryAfterMs: optional(Schema.Number),
  /** The failure is tied to the whole credential (Anthropic 5h/7d window, Codex `usage_limit_reached`). */
  credentialScoped: optional(Schema.Boolean),
  /** Cooldown state key when it differs from the lease's model (pooled aliases report the upstream model). */
  model: optional(Schema.String),
  /** Upstream response headers for the passive quota snapshot (claude, codex, devin). */
  headers: optional(Schema.Record(Schema.String, Schema.String)),
  /** Skip the passive quota snapshot (token counting). */
  skipQuotaObservation: optional(Schema.Boolean),
  /** Count the request but never touch availability (`responses/compact` request faults). */
  availabilityNeutral: optional(Schema.Boolean),
  /** What the attempt cost in micro-USD; charged to the Spend scopes of the lease (none when it has none). */
  costMicros: optional(Schema.Number),
});

export type ReportResult = typeof ReportResult.Type;

export type ReportOutcome =
  | { readonly ok: true; readonly applied: boolean }
  | { readonly ok: false; readonly error: "unknown_credential" };
