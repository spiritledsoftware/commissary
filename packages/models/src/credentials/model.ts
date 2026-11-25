/**
 * Credential model: the Workers counterpart of Go `coreauth.Auth` (sdk/cliproxy/auth/types.go).
 *
 * Two shapes are used:
 *  - `Credential`: the immutable, derived record that selection and executors work with. It is built from the stored
 *    auth-file JSON (`derive.ts`) or synthesised from provider keys (`synthesize.ts`); it is never persisted itself.
 *  - `CredentialState`: mutable runtime state (status, cooldowns, quota, counters) kept per credential id. The Go
 *    `Auth.Status/Unavailable/NextRetryAfter/Quota/ModelStates/LastError` fields live here. The cooldown state
 *    machine itself belongs to the retry/cooldown slice; selection only reads it (`selection/availability.ts`).
 *
 * All timestamps are epoch milliseconds; `0` means "unset" (Go zero time).
 */
import { Schema } from "effect";
import { ModelEntry, OAuthModelAlias } from "../config/schema.ts";
import { RecentBucket } from "./cooldown/recent-requests.ts";

const optional = Schema.optionalKey;

const StringMap = Schema.Record(Schema.String, Schema.String);

/** `Auth.AuthKind()` (classification.go). Credentials without any recognisable kind (key-less compat) omit it. */
export const AuthKind = Schema.Literals(["oauth", "apikey"]);

export type AuthKind = typeof AuthKind.Type;

/** Where a credential came from: an imported auth JSON file or an `api-keys` config entry. */
export const CredentialSource = Schema.Literals(["file", "config"]);

export type CredentialSource = typeof CredentialSource.Type;

export const Credential = Schema.Struct({
  /** File credentials: the auth file name (relative path). Config credentials: `<kind>:<12 hex>[-n]` (§4.3). */
  id: Schema.String,
  /** Lower-case provider key (`claude`, `codex`, `openai-compatible-<name>`, ...). See `executorKey`. */
  provider: Schema.String,
  source: CredentialSource,
  authKind: optional(AuthKind),
  label: Schema.String,
  /** Model namespace (`team-a/gpt-5`), without slashes. */
  prefix: optional(Schema.String),
  disabled: Schema.Boolean,
  /** The member a private credential belongs to; absent for a shared credential (ADR 0023). */
  owner: optional(Schema.String),
  /** Higher is preferred; only the highest available tier is selectable. */
  priority: Schema.Int,
  /** Weighted round-robin weight; `0` excludes the credential under that strategy. */
  weight: Schema.Int,
  /** Routing/exec attributes (`api_key`, `base_url`, `auth_kind`, `plan_type`, ...). Never contains `header:*`. */
  attributes: StringMap,
  /** Token material and user flags: for file credentials the whole (normalised) auth JSON. */
  metadata: Schema.Record(Schema.String, Schema.MutableJson),
  /** Extra upstream request headers (Go `header:<Name>` attributes). */
  headers: StringMap,
  /** Stored but not honoured on Workers (no outbound proxies). */
  proxyUrl: optional(Schema.String),
  /** Lower-cased exclusion patterns (`*` wildcards): per credential plus, for OAuth, the global provider list. */
  excludedModels: Schema.Array(Schema.String),
  /** Per-account OAuth model aliases (sanitised). Global aliases come from the config at selection time. */
  modelAliases: Schema.Array(OAuthModelAlias),
  /** Provider keys only: the `models:` list of the owning entry (replaces the provider catalogue). */
  models: optional(Schema.Array(ModelEntry)),
  /** Bumped whenever token/api-key material changes; stale results are ignored by `report`. */
  credentialVersion: Schema.Int,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export type Credential = typeof Credential.Type;

export const CredentialError = Schema.Struct({
  code: optional(Schema.String),
  message: Schema.String,
  retryable: Schema.Boolean,
  httpStatus: optional(Schema.Int),
});

export type CredentialError = typeof CredentialError.Type;

export const CredentialStatus = Schema.Literals([
  "unknown",
  "active",
  "pending",
  "refreshing",
  "error",
  "disabled",
]);

export type CredentialStatus = typeof CredentialStatus.Type;

/** Go `QuotaState`. `reason`: `quota`, `credential_quota` or `cloudflare challenge`. */
export const QuotaState = Schema.Struct({
  exceeded: Schema.Boolean,
  reason: optional(Schema.String),
  nextRecoverAt: Schema.Number,
  backoffLevel: Schema.Int,
  observedAt: optional(Schema.Number),
  signals: optional(StringMap),
  /**
   * The rejected Claude unified-quota headers of the response that recorded this cooldown (cb70eacf), kept apart from
   * the passive `signals` so a later observation cannot overwrite them.
   */
  cooldownSignals: optional(StringMap),
  /** A cooldown was recorded from a response (with or without `cooldownSignals`): `signals` no longer stand in. */
  cooldownEvaluated: optional(Schema.Boolean),
});

export type QuotaState = typeof QuotaState.Type;

/** Go `ModelState`: per-(credential, model) cooldown state. */
export const ModelState = Schema.Struct({
  status: CredentialStatus,
  statusMessage: optional(Schema.String),
  unavailable: Schema.Boolean,
  nextRetryAfter: Schema.Number,
  /**
   * Deadline of an explicit `force_cooldown` (a `stop-and-cooldown` action, Go `forceCooldownUntil`, CLIProxyAPI
   * 9d7d012b): later failures never shorten the cooldown below it, whatever they write.
   */
  forcedUntil: optional(Schema.Number),
  lastError: optional(CredentialError),
  quota: QuotaState,
  updatedAt: Schema.Number,
});

export type ModelState = typeof ModelState.Type;

/** Runtime state of one credential (Go `Auth` runtime fields). */
export const CredentialState = Schema.Struct({
  status: CredentialStatus,
  statusMessage: optional(Schema.String),
  unavailable: Schema.Boolean,
  nextRetryAfter: Schema.Number,
  /**
   * Deadline of an explicit `force_cooldown` (a `stop-and-cooldown` action, Go `forceCooldownUntil`, CLIProxyAPI
   * 9d7d012b): later failures never shorten the cooldown below it, whatever they write.
   */
  forcedUntil: optional(Schema.Number),
  quota: QuotaState,
  lastError: optional(CredentialError),
  modelStates: Schema.Record(Schema.String, ModelState),
  nextRefreshAfter: Schema.Number,
  refreshFailures: Schema.Int,
  /** Access token the upstream rejected; forces an immediate refresh until the token changes. */
  rejectedAccessToken: optional(Schema.String),
  success: Schema.Int,
  failed: Schema.Int,
  /** Recent-requests ring (20 x 10 min), see `cooldown/recent-requests.ts`. */
  recentRequests: optional(Schema.Array(RecentBucket)),
  updatedAt: Schema.Number,
});

export type CredentialState = typeof CredentialState.Type;

export const emptyQuota = (): QuotaState => ({
  exceeded: false,
  nextRecoverAt: 0,
  backoffLevel: 0,
});

export const emptyState = (): CredentialState => ({
  status: "active",
  unavailable: false,
  nextRetryAfter: 0,
  quota: emptyQuota(),
  modelStates: {},
  nextRefreshAfter: 0,
  refreshFailures: 0,
  success: 0,
  failed: 0,
  updatedAt: 0,
});

/**
 * Executor key of a credential (`executorKeyFromAuth`, conductor_execution.go:1794): the provider key used to look up
 * the executor and matched against `PickRequest.providers`.
 */
export const executorKey = (
  credential: Pick<Credential, "provider" | "label" | "attributes">,
): string => {
  const compatName = credential.attributes.compat_name?.trim() ?? "";

  if (compatName !== "")
    return openAICompatibleProviderKey(credential.attributes.provider_key?.trim() || compatName);
  const provider = credential.provider.trim().toLowerCase();

  if (provider === "openai-compatibility")
    return openAICompatibleProviderKey(credential.label.trim());

  if (provider === "kimi.com") return "kimi";

  if (provider === "kimi.ai") return "kimi-ai";

  return provider;
};

/** `util.OpenAICompatibleProviderKey` (internal/util/provider.go). */
export const openAICompatibleProviderKey = (name: string): string => {
  const key = name.trim().toLowerCase();

  if (key === "" || key === "openai-compatibility" || key.startsWith("openai-compatible-"))
    return key || "openai-compatibility";

  return `openai-compatible-${key}`;
};
