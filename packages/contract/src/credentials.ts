/**
 * The `/v9/management/credentials` routes the panel uses (`packages/models/src/management/credentials-routes.ts`;
 * `packages/models/src/management/credential-entry.ts` builds each entry), the batch actions
 * (`packages/models/src/management/credentials-batch.ts`) and the quota checks (`packages/models/src/management/quota-routes.ts`).
 * Shared with the browser: imports `effect` only. Field names are the wire's (snake_case, like Go's auth-file list).
 *
 * Mutations answer with a status only (except refresh, the batch actions and the quota checks, which answer per
 * account): the panel re-reads the list afterwards.
 * There is no write versioning on credentials; `PATCH /credentials/fields` changes only the keys it names, so two
 * edits of different fields cannot overwrite each other.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

export const CredentialStatus = Schema.Literals([
  "unknown",
  "active",
  "pending",
  "refreshing",
  "error",
  "disabled",
]);

export type CredentialStatus = typeof CredentialStatus.Type;

/** One ten-minute bucket of the recent-requests ring, labelled `HH:MM-HH:MM` (UTC). */
export const RecentRequests = Schema.Struct({
  time: Schema.String,
  success: Schema.Number,
  failed: Schema.Number,
});

/** Last observed upstream quota headers (`signals`: canonical header name to value). */
export const QuotaObservation = Schema.Struct({
  observed_at: optional(Schema.String),
  signals: Schema.Record(Schema.String, Schema.String),
});

export type QuotaObservation = typeof QuotaObservation.Type;

/**
 * One allowance window from a provider's usage endpoint: `id` is stable per provider ("five_hour", "seven_day",
 * "seven_day_opus", "primary", "secondary", "daily", "weekly", "monthly", or a model bucket id), `label` is the
 * operator-facing name ("5-hour", "Weekly", "Weekly Opus"), `used_percent` is 0–100.
 */
export const QuotaWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  used_percent: Schema.Number,
  resets_at: optional(Schema.String),
  window_seconds: optional(Schema.Number),
});

export type QuotaWindow = typeof QuotaWindow.Type;

/**
 * The server-side quota check of one credential (`POST /credentials/quota`, and the scheduled sweep): `checked_at` is
 * the last attempt, `refreshed_at` the last success; `windows` and `plan` come from the last success; `error` is the
 * last attempt's failure (absent when it succeeded).
 */
export const QuotaReport = Schema.Struct({
  checked_at: Schema.String,
  refreshed_at: optional(Schema.String),
  plan: optional(Schema.String),
  windows: Schema.Array(QuotaWindow),
  error: optional(Schema.String),
});

export type QuotaReport = typeof QuotaReport.Type;

/**
 * One Claude reset grant (Anthropic's `cedar_ember` program, `packages/models/src/quota/reset-grants.ts`): a bundle of resets, each
 * of which sets the usage windows in `clears` (`five_hour`, `seven_day`, …) back to empty. `label` is Anthropic's
 * display text, sanitised (empty when none); times are ISO instants.
 */
export const ResetGrant = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  resets_total: Schema.Int,
  resets_left: Schema.Int,
  starts_at: optional(Schema.String),
  ends_at: optional(Schema.String),
  clears: Schema.Array(Schema.String),
  paused: Schema.Boolean,
  usable_now: Schema.Boolean,
  use_requires_limit: Schema.Boolean,
});

export type ResetGrant = typeof ResetGrant.Type;

/**
 * Why no reset can be claimed now: the account is not eligible, Anthropic's cooldown between resets is running, no
 * grant has resets left (or all have expired or not started), the remaining ones are paused or not usable yet, or
 * they need a limit to be reached first and the account is not at one.
 */
export const ResetGrantBlocker = Schema.Literals([
  "ineligible",
  "cooldown",
  "none_left",
  "unusable",
  "not_limited",
]);

export type ResetGrantBlocker = typeof ResetGrantBlocker.Type;

/**
 * A Claude account's reset grants as Anthropic reported them at `checked_at`. `claimable` is the grant a claim would
 * spend at that time (Anthropic's `next_grant_id` when usable, else the lowest usable id); without it, `blocked_by`
 * says why. Known `ineligible_reason`s are passed on, others read `unknown`.
 */
export const ResetGrantStatus = Schema.Struct({
  checked_at: Schema.String,
  eligible: Schema.Boolean,
  ineligible_reason: optional(Schema.String),
  at_limit: Schema.Boolean,
  cooldown_until: optional(Schema.String),
  weekly_resets_at: optional(Schema.String),
  next_grant_id: optional(Schema.String),
  grants: Schema.Array(ResetGrant),
  claimable: optional(Schema.String),
  blocked_by: optional(ResetGrantBlocker),
});

export type ResetGrantStatus = typeof ResetGrantStatus.Type;

/**
 * A claim sent to Anthropic that got no definite answer. Claiming again before `retry_until` resends the same request
 * (same grant and request id) instead of spending another reset. `in_flight`: a request of it is running now (another
 * tab or admin); it cannot be resent until that one is answered.
 */
export const PendingResetClaim = Schema.Struct({
  grant_id: Schema.String,
  started_at: Schema.String,
  retry_until: Schema.String,
  in_flight: Schema.Boolean,
});

export type PendingResetClaim = typeof PendingResetClaim.Type;

/**
 * The answer to one claim: Anthropic's `result` (`reset`, `already_used`, `not_limited`, `cooldown`, `ineligible`,
 * `unavailable`), its refusals by status (`rate_limited` 429, `auth_error` 401/403), `unknown` when no definite
 * answer came back (a reset may have been spent), `not_confirmed` when an unanswered claim's status read hints that it
 * landed but the account is still at a limit (no request was sent and nothing proves a reset; the claim stays open and
 * the next attempt resends it), or
 * `none_available` when nothing could be claimed and no request was sent.
 */
export const ResetGrantOutcome = Schema.Literals([
  "reset",
  "already_used",
  "not_limited",
  "cooldown",
  "ineligible",
  "unavailable",
  "rate_limited",
  "auth_error",
  "unknown",
  "not_confirmed",
  "none_available",
]);

export type ResetGrantOutcome = typeof ResetGrantOutcome.Type;

/** `GET /credentials/reset-grants`: the live status (also stored as the entry's `reset_grants`). */
export const ResetGrantsView = Schema.Struct({
  status: Schema.Literal("ok"),
  grants: ResetGrantStatus,
  pending_claim: optional(PendingResetClaim),
});

export type ResetGrantsView = typeof ResetGrantsView.Type;

/**
 * `POST /credentials/reset-grants/claim`. `retried`: the claim resent an unanswered one. `cooldown_cleared`: Commissary
 * cleared the account's cooldowns after a reset. `report`: the quota check made after a reset (with fresh `grants`
 * in the entry); `grants`: the status the claim was decided on otherwise. `pending_claim` is set while an `unknown`
 * outcome can be retried. `warning`: Anthropic answered but Commissary could not record the answer (the outcome is
 * still Anthropic's).
 */
export const ResetGrantClaim = Schema.Struct({
  status: Schema.Literal("ok"),
  outcome: ResetGrantOutcome,
  retried: Schema.Boolean,
  cooldown_cleared: Schema.Boolean,
  grants: optional(ResetGrantStatus),
  report: optional(QuotaReport),
  pending_claim: optional(PendingResetClaim),
  warning: optional(Schema.String),
});

export type ResetGrantClaim = typeof ResetGrantClaim.Type;

/** An unexpired retry timer of the credential or one of its models. */
export const Cooldown = Schema.Struct({
  scope: Schema.Literals(["credential", "model"]),
  model_key: optional(Schema.String),
  reason: Schema.String,
  retry_at: Schema.String,
  remaining_seconds: Schema.Number,
  backoff_level: optional(Schema.Number),
  http_status: optional(Schema.Number),
});

export type Cooldown = typeof Cooldown.Type;

/** Claims of a Codex credential's id token (no secrets). */
export const IdTokenClaims = Schema.Struct({
  chatgpt_account_id: optional(Schema.String),
  plan_type: optional(Schema.String),
  chatgpt_subscription_active_start: optional(Schema.String),
  chatgpt_subscription_active_until: optional(Schema.String),
});

/** One of the account's own model aliases (`model_aliases` in its file; the config's alias wire keys). */
export const CredentialModelAlias = Schema.Struct({
  /** Upstream model name. */
  name: Schema.String,
  /** The id clients call instead. */
  alias: Schema.String,
  /** Keep the original id next to the alias. */
  fork: optional(Schema.Boolean),
  "force-mapping": optional(Schema.Boolean),
  "display-name": optional(Schema.String),
});

export type CredentialModelAlias = typeof CredentialModelAlias.Type;

/** The member a private credential belongs to. */
export const CredentialOwner = Schema.Struct({
  member_id: Schema.String,
  email: optional(Schema.String),
});

/**
 * One account of the credential list. `source` is `"file"` for an auth file (`id` and `name` are the file name) or
 * `"config"` for a provider key whose provider reports quota with the key (OpenCode Go): `id` and `name` are then its
 * keyed `auth_index` (the content-addressed credential id is never sent), `account` the masked key, `supports_quota`
 * true, and `key_group` where it is edited. A config account takes the quota check, the cooldown reset and the
 * `auth_index` filters; the file-only operations (delete, download, field edits, token refresh, batch actions) answer
 * `409 config_credential` (a batch: that `error` per account).
 */
export const CredentialEntry = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  name: Schema.String,
  type: Schema.String,
  provider: Schema.String,
  label: Schema.String,
  status: CredentialStatus,
  status_message: Schema.String,
  disabled: Schema.Boolean,
  unavailable: Schema.Boolean,
  runtime_only: Schema.Boolean,
  source: Schema.String,
  size: Schema.Number,
  success: Schema.Number,
  failed: Schema.Number,
  recent_requests: Schema.Array(RecentRequests),
  quota: QuotaObservation,
  model_quotas: optional(Schema.Record(Schema.String, QuotaObservation)),
  quota_report: optional(QuotaReport),
  /** Claude only: the last reset grant status read by the quota check or `GET /credentials/reset-grants`. */
  reset_grants: optional(ResetGrantStatus),
  supports_quota: optional(Schema.Boolean),
  email: optional(Schema.String),
  account: optional(Schema.String),
  account_type: optional(Schema.String),
  project_id: optional(Schema.String),
  /** Antigravity: the appeal link of a credential a TOS_VIOLATION deactivated, and its link text. */
  tos_appeal_url: optional(Schema.String),
  tos_appeal_url_text: optional(Schema.String),
  id_token: optional(IdTokenClaims),
  created_at: optional(Schema.String),
  updated_at: optional(Schema.String),
  last_refresh: optional(Schema.String),
  next_retry_after: optional(Schema.String),
  priority: optional(Schema.Number),
  note: optional(Schema.String),
  weight: optional(Schema.Number),
  request_retry: optional(Schema.Number),
  websockets: optional(Schema.Boolean),
  /** Model prefix: clients reach this account alone as `<prefix>/<model>`. */
  prefix: optional(Schema.String),
  /** The account's own cooling switch; absent when the routing setting applies. */
  disable_cooling: optional(Schema.Boolean),
  /**
   * Extra upstream request headers. Values whose names look secret are masked (`[redacted]…abcd`, `REDACTED_PREFIX`
   * in `provider-keys.ts`); sending the mask back for the same header keeps the stored value.
   */
  headers: optional(Schema.Record(Schema.String, Schema.String)),
  /** The account's own exclusions (lower-case names or `*` patterns), without the channel rules. */
  excluded_models: optional(Schema.Array(Schema.String)),
  /** The account's own aliases, before the channel rules. */
  model_aliases: optional(Schema.Array(CredentialModelAlias)),
  cooldowns: Schema.Array(Cooldown),
  /**
   * `source: "config"` only: where the provider key is edited, the group `index` of `family` under `api-keys` (the
   * panel's `/keys/<family>/<index>`).
   */
  key_group: optional(Schema.Struct({ family: Schema.String, index: Schema.Int })),
  /** A private account (ADR 0023): used only for its owner's requests; `owner` says whose. Absent: a shared one. */
  private: optional(Schema.Boolean),
  owner: optional(CredentialOwner),
});

export type CredentialEntry = typeof CredentialEntry.Type;

/**
 * What an org admin sees of another member's private account (ADR 0023): that it exists, its provider, owner and
 * label, and whether it is disabled (an org admin may disable or remove it). Nothing of its use, models, standing or
 * quota, and it cannot be downloaded.
 */
export const LimitedCredentialEntry = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  name: Schema.String,
  type: Schema.String,
  provider: Schema.String,
  label: Schema.String,
  source: Schema.String,
  disabled: Schema.Boolean,
  limited: Schema.Literal(true),
  private: Schema.Literal(true),
  owner: CredentialOwner,
});

export type LimitedCredentialEntry = typeof LimitedCredentialEntry.Type;

/**
 * `GET /credentials`: `files` are the accounts the caller manages (shared ones for org admins, the caller's own
 * private ones); `others` (org admins only) lists the other members' private accounts, existence only.
 */
export const CredentialList = Schema.Struct({
  observed_at: optional(Schema.String),
  files: Schema.Array(CredentialEntry),
  others: optional(Schema.Array(LimitedCredentialEntry)),
});

const Ok = Schema.Struct({ status: Schema.Literal("ok") });

/**
 * The editable fields the panel sends; `null` clears a field (the routing default applies again). `headers` merges
 * into the stored ones: an empty value removes a header, the masked value of a header keeps it. A refused value
 * answers `422` with the field's name in `path`.
 */
export const CredentialFieldsPatch = Schema.Struct({
  name: Schema.String,
  priority: optional(Schema.NullOr(Schema.Int)),
  note: optional(Schema.NullOr(Schema.String)),
  weight: optional(Schema.NullOr(Schema.Int)),
  request_retry: optional(Schema.NullOr(Schema.Int)),
  prefix: optional(Schema.NullOr(Schema.String)),
  disable_cooling: optional(Schema.NullOr(Schema.Boolean)),
  websockets: optional(Schema.NullOr(Schema.Boolean)),
  headers: optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  excluded_models: optional(Schema.NullOr(Schema.Array(Schema.String))),
  model_aliases: optional(Schema.NullOr(Schema.Array(CredentialModelAlias))),
});

export type CredentialFieldsPatch = typeof CredentialFieldsPatch.Type;

/**
 * What a batch applies to every account it names (`POST /credentials/batch`). A `delete` of a name that is not stored
 * (already deleted, or never there) answers `ok: true`, like a delete that just happened: what was asked for holds.
 * A provider key named by its `auth_index` (as the list names it) answers `config_credential`: it cannot be changed
 * here.
 */
export const BatchAction = Schema.Literals(["enable", "disable", "refresh", "delete"]);

export type BatchAction = typeof BatchAction.Type;

/** Most accounts one batch request may name; the panel sends larger selections in several requests. */
export const MAX_BATCH_NAMES = 100;

/**
 * Most accounts one `refresh` batch may name: each is an upstream token call the ControlPlane makes (four at a time),
 * so a refresh request is kept short. The panel splits a larger selection by it.
 */
export const MAX_BATCH_REFRESH_NAMES = 20;

/** The most names a batch of `action` may carry. */
export const batchLimit = (action: BatchAction): number =>
  action === "refresh" ? MAX_BATCH_REFRESH_NAMES : MAX_BATCH_NAMES;

/**
 * One account's outcome in a batch or a check of every quota. `error` is a code (`not_found`, `refresh_failed`,
 * `unauthorized`, `check_failed`, `stale`, `unavailable`, `not_refreshable`, `config_credential`), `message` a fixed
 * reason and `status` the upstream HTTP status when there was one; none of them ever carries a token or an upstream body. `skipped` (with `ok:
 * false`, `error: "not_refreshable"`): the action did not apply to the account (a refresh of an account without a
 * refresh token); it counts as neither succeeded nor failed.
 */
export const AccountResult = Schema.Struct({
  name: Schema.String,
  ok: Schema.Boolean,
  skipped: optional(Schema.Boolean),
  error: optional(Schema.String),
  message: optional(Schema.String),
  status: optional(Schema.Number),
});

export type AccountResult = typeof AccountResult.Type;

export const BatchResult = Schema.Struct({
  action: BatchAction,
  /** One per distinct name, in the order sent. */
  results: Schema.Array(AccountResult),
  succeeded: Schema.Number,
  failed: Schema.Number,
  skipped: Schema.Number,
});

export type BatchResult = typeof BatchResult.Type;

export const QuotaSweepResult = Schema.Struct({
  started_at: Schema.String,
  finished_at: Schema.String,
  /** One per enabled account whose provider reports quota; a failed check keeps the account's last figures. */
  results: Schema.Array(AccountResult),
  checked: Schema.Number,
  failed: Schema.Number,
});

export type QuotaSweepResult = typeof QuotaSweepResult.Type;

export const CredentialModel = Schema.Struct({
  id: Schema.String,
  display_name: optional(Schema.String),
  type: optional(Schema.String),
  owned_by: optional(Schema.String),
});

export class CredentialsGroup extends HttpApiGroup.make("credentials").add(
  HttpApiEndpoint.get("list", "/credentials", {
    success: CredentialList,
    error: managementErrors,
  }),
  /**
   * Enable or disable one credential, by auth file `name` and/or `auth_index`. A provider key is addressed by its
   * `auth_index` only (`KeyRuntime.auth_index`) and is disabled by adding `*` to its `excluded-models` (`via`, as Go
   * answers); its `auth_index` stays the same. OpenAI-compatible keys answer 409: disable the endpoint (the group's
   * `disabled`) instead.
   */
  HttpApiEndpoint.patch("setDisabled", "/credentials/status", {
    payload: Schema.Struct({
      name: optional(Schema.String),
      auth_index: optional(Schema.String),
      disabled: Schema.Boolean,
    }),
    success: Schema.Struct({
      status: Schema.Literal("ok"),
      disabled: Schema.Boolean,
      via: optional(Schema.Literal("config:excluded-models")),
      excluded_pattern: optional(Schema.String),
    }),
    error: managementErrors,
  }),
  HttpApiEndpoint.patch("patchFields", "/credentials/fields", {
    payload: CredentialFieldsPatch,
    success: Ok,
    error: managementErrors,
  }),
  /** Refresh one credential's tokens now; answers the fresh entry. */
  HttpApiEndpoint.post("refresh", "/credentials/refresh", {
    payload: Schema.Struct({ name: Schema.String }),
    success: Schema.Struct({ ok: Schema.Literal(true), auth: CredentialEntry }),
    error: managementErrors,
  }),
  /** Clear the credential's and its models' retry timers. */
  HttpApiEndpoint.post("resetCooldown", "/routing/cooldown/reset", {
    payload: Schema.Struct({ auth_index: Schema.String }),
    success: Schema.Struct({
      status: Schema.Literal("ok"),
      auth_index: Schema.String,
      models: Schema.Array(Schema.String),
    }),
    error: managementErrors,
  }),
  HttpApiEndpoint.delete("remove", "/credentials", {
    query: { name: Schema.String },
    success: Ok,
    error: managementErrors,
  }),
  /**
   * Add or replace one auth file (`name` ends in `.json`; the body is the file's JSON text). `private=true` makes it
   * the caller's private account (ADR 0023); a plain member's upload is always private.
   */
  HttpApiEndpoint.post("upload", "/credentials", {
    query: { name: Schema.String, private: optional(Schema.Literal("true")) },
    payload: Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/json" })),
    success: Ok,
    error: managementErrors,
  }),
  /** The models this credential can serve. */
  HttpApiEndpoint.get("models", "/credentials/models", {
    query: { name: Schema.String },
    success: Schema.Struct({ models: Schema.Array(CredentialModel) }),
    error: managementErrors,
  }),
  /**
   * Ask the provider's usage endpoint for this credential's allowance now (server side; no tokens leave). `name` is the
   * listed name: the auth file name, or a config account's `auth_index`.
   */
  HttpApiEndpoint.post("checkQuota", "/credentials/quota", {
    payload: Schema.Struct({ name: Schema.String }),
    success: Schema.Struct({ status: Schema.Literal("ok"), report: QuotaReport }),
    error: managementErrors,
  }),
  /**
   * Enable, disable, refresh the tokens of or delete several accounts (auth files) at once; answers each account's
   * outcome, so some may succeed while others fail. At most {@link MAX_BATCH_NAMES} names, {@link
   * MAX_BATCH_REFRESH_NAMES} for `refresh` (`400` beyond).
   */
  HttpApiEndpoint.post("batch", "/credentials/batch", {
    payload: Schema.Struct({ action: BatchAction, names: Schema.Array(Schema.String) }),
    success: BatchResult,
    error: managementErrors,
  }),
  /**
   * Check the quota of every enabled account that reports it, a few at a time, and answer each outcome. `409
   * quota_check_running` while another check of every account (the scheduled one included) is under way.
   */
  HttpApiEndpoint.post("checkAllQuotas", "/credentials/quota/all", {
    success: QuotaSweepResult,
    error: managementErrors,
  }),
  /** A Claude account's reset grants, read from Anthropic now (server side). `422` for other providers. */
  HttpApiEndpoint.get("resetGrants", "/credentials/reset-grants", {
    query: { auth_index: Schema.String },
    success: ResetGrantsView,
    error: managementErrors,
  }),
  /**
   * Spend one reset of a Claude account (the server picks the grant). `409` while another claim of the account runs,
   * `502` when the status could not be read (nothing was sent).
   */
  HttpApiEndpoint.post("claimResetGrant", "/credentials/reset-grants/claim", {
    payload: Schema.Struct({ auth_index: Schema.String }),
    success: ResetGrantClaim,
    error: managementErrors,
  }),
) {}
