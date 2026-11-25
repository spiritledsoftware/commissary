/**
 * One entry of `GET /v9/management/credentials` (the panel's "auth files" list).
 *
 * Go source: internal/api/handlers/management/auth_files.go (`buildAuthFileEntryLocked`, `quotaObservationPayload`,
 * `extractCodexIDTokenClaims`, `reconcileAuthFileCooldownState`), sdk/cliproxy/auth/cooldown_view.go
 * (`CooldownSnapshotForAuth`) and types.go (`RecentRequestsSnapshot`). Pure: no secrets are included (the Codex
 * `id_token` is reduced to a few claims), so the result can leave the ControlPlane Durable Object.
 *
 * Differences: auth files are listed, plus the provider keys whose provider reports quota with the key itself
 * (`CONFIG_QUOTA_PROVIDERS`, OpenCode Go; Go lists no provider keys, its panel shows them on the providers page
 * only) as `source: "config"` entries ({@link buildConfigCredentialEntry}); `recent_requests` come from the
 * credential's recent-requests ring; cooldown reasons are reduced to the quota reason or the last error class.
 * `quota_report` is the stored server-side quota check and `reset_grants` the last Claude reset grant status read
 * (src/quota, Workers additions with no Go counterpart). The account's own routing fields (`prefix`, `disable_cooling`,
 * `headers`, `excluded_models`, `model_aliases`) are a Workers addition for the control panel: the effective prefix,
 * every header value masked except safe headers and pure client copies (`maskHeaders`, as on the provider keys page), and
 * the account's own exclusions and aliases, without the channel rules.
 */
import { isJsonObject, type Json, type JsonObject } from "@commissary/json";
import { decodeJwtClaims } from "../credentials/expiry.ts";
import {
  type RecentBucket,
  RECENT_BUCKET_MS,
  recentRequestsSnapshot,
} from "../credentials/cooldown/recent-requests.ts";
import { coolingOverride } from "../credentials/cooldown/mark-result.ts";
import { aliasesFromMetadata, extractHeaders, ownExclusions } from "../credentials/derive.ts";
import type { Credential, CredentialState } from "../credentials/model.ts";
import { redactSecrets } from "../credentials/redact.ts";
import { maskHeaders, maskSecret } from "../credentials/summary.ts";
import { DEFAULT_WEIGHT } from "../credentials/weight.ts";
import { quotaReportJson } from "../quota/report.ts";
import { resetGrantStatusJson } from "../quota/reset-grants.ts";
import type { AuthIndexer } from "./auth-index.ts";
import type { QuotaReport, ResetGrantStatus } from "@commissary/contract/credentials";

const BUCKET_MS = RECENT_BUCKET_MS;

const iso = (ms: number): string => new Date(ms).toISOString();

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

const pad = (value: number): string => String(value).padStart(2, "0");

const clock = (ms: number): string =>
  `${pad(new Date(ms).getUTCHours())}:${pad(new Date(ms).getUTCMinutes())}`;

/** `RecentRequestsSnapshot`: 20 ten-minute buckets, oldest first, labelled `HH:MM-HH:MM` (UTC). */
export const recentRequestBuckets = (
  ring: ReadonlyArray<RecentBucket> | undefined,
  now: number,
): Array<{ time: string; success: number; failed: number }> =>
  recentRequestsSnapshot(ring, now).map((entry) => ({
    time: `${clock(entry.start)}-${clock(entry.start + BUCKET_MS)}`,
    success: entry.success,
    failed: entry.failed,
  }));

/** Codex `id_token` claims the panel shows (plan type and subscription window); the hub API reads the plan too. */
export const codexClaims = (
  credential: Pick<Credential, "provider" | "metadata">,
): JsonObject | undefined => {
  if (credential.provider !== "codex") return undefined;
  const token = text(credential.metadata.id_token);

  if (token === "") return undefined;
  const auth = decodeJwtClaims(token)?.["https://api.openai.com/auth"];

  if (!isJsonObject(auth)) return undefined;
  const out: JsonObject = {};
  const account = text(auth.chatgpt_account_id);

  if (account !== "") out.chatgpt_account_id = account;
  const plan = text(auth.chatgpt_plan_type);

  if (plan !== "") out.plan_type = plan;

  for (const key of [
    "chatgpt_subscription_active_start",
    "chatgpt_subscription_active_until",
  ] as const) {
    const value = auth[key];

    if (value !== undefined && value !== null) out[key] = value;
  }

  return Object.keys(out).length === 0 ? undefined : out;
};

const quotaReason = (reason: string | undefined): string => {
  if (reason === "credential_quota" || reason === "quota") return reason;

  return reason === "cloudflare challenge" ? "cloudflare_challenge" : "unknown";
};

const cooldownView = (
  scope: "credential" | "model",
  modelKey: string,
  next: number,
  now: number,
  state: Pick<CredentialState, "quota" | "lastError">,
): JsonObject => {
  const reason = state.quota.exceeded
    ? quotaReason(state.quota.reason)
    : state.lastError?.code?.trim() || "unknown";

  const status = state.lastError?.httpStatus;

  return {
    scope,
    ...(scope === "model" ? { model_key: modelKey } : {}),
    reason,
    retry_at: iso(next),
    remaining_seconds: Math.ceil((next - now) / 1000),
    ...(reason === "quota" || reason === "cloudflare_challenge"
      ? { backoff_level: state.quota.backoffLevel }
      : {}),
    ...(status !== undefined && status >= 400 && status <= 599 ? { http_status: status } : {}),
  };
};

/** `CooldownSnapshotForAuth`: unexpired credential-wide and per-model retry timers. */
export const cooldownSnapshot = (state: CredentialState, now: number): JsonObject[] => {
  const views: JsonObject[] = [];

  const credentialNext =
    state.quota.exceeded && state.quota.nextRecoverAt > now ? state.quota.nextRecoverAt : 0;

  if (state.quota.exceeded && state.quota.reason === "credential_quota" && credentialNext > 0) {
    views.push(cooldownView("credential", "", credentialNext, now, state));
  } else if (Object.keys(state.modelStates).length === 0) {
    const next = Math.max(
      state.unavailable ? state.nextRetryAfter : 0,
      state.quota.exceeded ? state.quota.nextRecoverAt : 0,
    );

    if (next > now) views.push(cooldownView("credential", "", next, now, state));
  }

  for (const model of Object.keys(state.modelStates).toSorted()) {
    const modelState = state.modelStates[model];

    if (modelState === undefined || model.trim() === "") continue;

    const next = Math.max(
      modelState.unavailable ? modelState.nextRetryAfter : 0,
      modelState.quota.exceeded ? modelState.quota.nextRecoverAt : 0,
    );

    if (next > now) views.push(cooldownView("model", model, next, now, modelState));
  }

  return views;
};

const integer = (value: Json | undefined): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);

  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return Number(value.trim());

  return undefined;
};

const websockets = (credential: Credential): boolean | undefined => {
  const raw =
    credential.attributes.websockets?.trim().toLowerCase() ?? credential.metadata.websockets;

  if (raw === true || raw === "true" || raw === "1") return true;

  if (raw === false || raw === "false" || raw === "0") return false;

  return undefined;
};

/** A config key's place in `api-keys`: its family and group index (the panel's `/keys/<family>/<index>`). */
export interface ConfigKeyGroup {
  readonly family: string;
  readonly index: number;
}

const isDisablingPattern = (pattern: string): boolean => pattern.trim() === "*";

/**
 * Builds the panel entry of a provider key listed on the Accounts page (`source: "config"`).
 *
 * The credential id is an unsalted hash of the key (`credentials/synthesize.ts`), so it is never sent: the entry's `id`
 * and `name` are the keyed `auth_index`, which is what the quota check, the cron sweep's results and the panel address
 * the account by. Nothing secret is included: the key appears only as its masked preview (`account`, `[redacted]
 * …abcd`), headers are left out and the status message is scrubbed like the provider keys page's last error. `disabled` is
 * the provider keys page's reading (`*` in the key's `excluded-models`, the only way a config key is disabled); `key_group`
 * is where the key is edited. The file-only fields (size, file times, note, weight, routing fields) are absent.
 */
export const buildConfigCredentialEntry = (
  credential: Credential,
  state: CredentialState,
  now: number,
  authIndex: AuthIndexer,
  keyGroup: ConfigKeyGroup | undefined,
  quotaReport?: QuotaReport,
): JsonObject => {
  const index = authIndex(credential.id);
  const disabled = credential.excludedModels.some(isDisablingPattern);
  const cooldowns = cooldownSnapshot(state, now);
  const blocked = state.unavailable || cooldowns.length > 0;
  const nextRetry = state.nextRetryAfter > now ? state.nextRetryAfter : 0;
  const key = credential.attributes.api_key?.trim() ?? "";

  // The status message is the last upstream error: scrubbed of the key and token-shaped text like the provider keys page.
  const scrub = (message: string): string =>
    redactSecrets(key === "" ? message : message.replaceAll(key, "[redacted]"));

  const entry: JsonObject = {
    id: index,
    auth_index: index,
    name: index,
    type: credential.provider,
    provider: credential.provider,
    label: credential.label,
    status: disabled ? "disabled" : blocked && state.status === "active" ? "error" : state.status,
    status_message: scrub(state.statusMessage ?? ""),
    disabled,
    unavailable: blocked,
    runtime_only: false,
    source: "config",
    size: 0,
    success: state.success,
    failed: state.failed,
    recent_requests: recentRequestBuckets(state.recentRequests, now),
    quota: {
      ...(state.quota.observedAt === undefined ? {} : { observed_at: iso(state.quota.observedAt) }),
      signals: { ...state.quota.signals },
    },
    supports_quota: true,
    account_type: "api_key",
    ...(key === "" ? {} : { account: maskSecret(key) }),
    ...(credential.priority === 0 ? {} : { priority: credential.priority }),
    ...(credential.prefix === undefined ? {} : { prefix: credential.prefix }),
    ...(nextRetry > 0 ? { next_retry_after: iso(nextRetry) } : {}),
    ...(keyGroup === undefined
      ? {}
      : { key_group: { family: keyGroup.family, index: keyGroup.index } }),
    cooldowns,
  };

  if (quotaReport !== undefined) entry.quota_report = quotaReportJson(quotaReport);

  return entry;
};

/** The ownership fields of a private credential's entry: who owns it. */
export const ownerFields = (owner: string, email: string | undefined): JsonObject => ({
  private: true,
  owner: { member_id: owner, ...(email === undefined ? {} : { email }) },
});

/**
 * What an org admin sees of another member's private credential (ADR 0023): that it exists, its provider, owner and
 * label, and whether it is disabled (they may disable or remove it). Nothing of its use, models, standing or quota.
 */
export const buildLimitedEntry = (
  credential: Credential,
  ownerEmail: string | undefined,
  authIndex: AuthIndexer,
): JsonObject => {
  const index = authIndex(credential.id);
  const name = credential.source === "config" ? index : credential.id;

  return {
    id: name,
    auth_index: index,
    name,
    type: credential.provider,
    provider: credential.provider,
    label: credential.label,
    source: credential.source,
    disabled: credential.disabled || credential.excludedModels.some(isDisablingPattern),
    limited: true,
    ...ownerFields(credential.owner ?? "", ownerEmail),
  };
};

/**
 * Builds the panel entry of an auth-file credential. `now` is epoch milliseconds; `authIndex` is the deployment's
 * indexer; `quotaReport` is the credential's last quota check, when there was one, and `resetGrants` its last reset
 * grant status (Claude).
 */
export const buildCredentialEntry = (
  credential: Credential,
  state: CredentialState,
  now: number,
  authIndex: AuthIndexer,
  quotaReport?: QuotaReport,
  resetGrants?: ResetGrantStatus,
): JsonObject => {
  const { metadata } = credential;
  const disabled = credential.disabled;
  const cooldowns = cooldownSnapshot(state, now);
  const blocked = state.unavailable || cooldowns.length > 0;
  const nextRetry = state.nextRetryAfter > now ? state.nextRetryAfter : 0;

  const entry: JsonObject = {
    id: credential.id,
    auth_index: authIndex(credential.id),
    name: credential.id,
    type: credential.provider,
    provider: credential.provider,
    label: credential.label,
    status: disabled ? "disabled" : blocked && state.status === "active" ? "error" : state.status,
    status_message: state.statusMessage ?? "",
    disabled,
    unavailable: blocked,
    runtime_only: false,
    source: "file",
    size: new TextEncoder().encode(JSON.stringify(metadata)).length,
    success: state.success,
    failed: state.failed,
    recent_requests: recentRequestBuckets(state.recentRequests, now),
    quota: {
      ...(state.quota.observedAt === undefined ? {} : { observed_at: iso(state.quota.observedAt) }),
      signals: { ...state.quota.signals },
    },
  };

  const modelQuotas: JsonObject = {};

  for (const [model, modelState] of Object.entries(state.modelStates)) {
    if (
      modelState.quota.observedAt === undefined &&
      Object.keys(modelState.quota.signals ?? {}).length === 0
    )
      continue;
    modelQuotas[model] = {
      ...(modelState.quota.observedAt === undefined
        ? {}
        : { observed_at: iso(modelState.quota.observedAt) }),
      signals: { ...modelState.quota.signals },
    };
  }

  if (Object.keys(modelQuotas).length > 0) entry.model_quotas = modelQuotas;

  if (metadata.quota_probe !== undefined && metadata.quota_probe !== null) {
    entry.supports_quota = true;
    entry.quota_probe = metadata.quota_probe;
  }

  const email = text(metadata.email);

  if (email !== "") entry.email = email;
  const projectId = text(metadata.project_id);

  if (projectId !== "") entry.project_id = projectId;

  // The appeal link of a credential a TOS_VIOLATION deactivated, for the operator (CLIProxyAPI 5a351d95).
  const appealUrl = text(metadata.tos_appeal_url);
  const appealText = text(metadata.tos_appeal_url_text);

  if (appealUrl !== "") entry.tos_appeal_url = appealUrl;

  if (appealText !== "") entry.tos_appeal_url_text = appealText;
  entry.account_type = "oauth";

  if (email !== "") entry.account = email;

  if (credential.createdAt > 0) entry.created_at = iso(credential.createdAt);

  if (credential.updatedAt > 0) {
    entry.modtime = iso(credential.updatedAt);
    entry.updated_at = iso(credential.updatedAt);
  }

  const lastRefresh = text(metadata.last_refresh);

  if (lastRefresh !== "") entry.last_refresh = lastRefresh;

  if (nextRetry > 0) entry.next_retry_after = iso(nextRetry);
  const claims = codexClaims(credential);

  if (claims !== undefined) entry.id_token = claims;

  const priority = integer(metadata.priority);

  if (priority !== undefined) entry.priority = priority;
  const note = text(metadata.note);

  if (note !== "") entry.note = note;

  if (Object.hasOwn(metadata, "weight") || credential.weight !== DEFAULT_WEIGHT)
    entry.weight = credential.weight;
  const ws = websockets(credential);

  if (ws !== undefined) entry.websockets = ws;
  const retry = integer(metadata.request_retry);

  if (retry !== undefined && retry >= 0) entry.request_retry = retry;

  // The prefix selection uses (outer slashes dropped, one with an inner slash ignored), not the raw metadata.
  if (credential.prefix !== undefined) entry.prefix = credential.prefix;
  const cooling = coolingOverride(metadata);

  if (cooling !== undefined) entry.disable_cooling = cooling;
  // Secret-looking header values leave masked, like the provider keys page; writing the mask back keeps them.
  const headers = maskHeaders(extractHeaders(metadata.headers));

  if (Object.keys(headers).length > 0) entry.headers = headers;
  const excluded = ownExclusions(metadata.excluded_models);

  if (excluded.length > 0) entry.excluded_models = excluded;
  const aliases = aliasesFromMetadata(metadata.model_aliases);

  if (aliases.length > 0) entry.model_aliases = aliases.map((alias) => ({ ...alias }));
  entry.cooldowns = cooldowns;

  if (quotaReport !== undefined) entry.quota_report = quotaReportJson(quotaReport);

  if (resetGrants !== undefined) entry.reset_grants = resetGrantStatusJson(resetGrants);

  return entry;
};
