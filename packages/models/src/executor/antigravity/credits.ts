/**
 * Google One AI credits: request mutation, balance probe and the fallback candidate rules.
 *
 * Go source: internal/runtime/executor/antigravity_executor_credits.go (`injectEnabledCreditTypes`,
 * `updateAntigravityCreditsBalanceForTask`), sdk/cliproxy/auth/conductor_home.go (`tryAntigravityCreditsExecute`,
 * `shouldAttemptAntigravityCreditsFallback`, `isAntigravityCreditsQuota429`, `isAntigravityCreditsCapacity503` and
 * their phrase helpers). The config gate is `quota-exceeded.antigravity-credits`
 * (`oauth.providers.antigravity.antigravity-credits`); only Claude models use credits.
 */
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Config } from "../../config/schema.ts";
import {
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  set,
  tryParseJson,
} from "@commissary/json";
import {
  ErrorCode,
  isCloudflareChallengeError,
  isRequestInvalidError,
  isTosViolationError,
} from "../../credentials/cooldown/classify.ts";
import { classifiable } from "../classify.ts";
import type { ExecutionError } from "../errors.ts";
import { readBoundedText } from "../helps/bounded-body.ts";
import { applyCustomHeaders } from "../helps/custom-headers.ts";
import type { CredentialSnapshot } from "../picker.ts";
import { requestBaseUrl } from "./envelope.ts";
import { SHORT_QUOTA_COOLDOWN_THRESHOLD_MS } from "./errors.ts";
import { type AntigravityState, type CreditsRecord } from "./state.ts";

/** `antigravityCreditsRetryEnabled`. */
export const creditsEnabled = (config: Config): boolean =>
  config.oauth.providers.antigravity["antigravity-credits"];

/** Credits only apply to Claude models (`route model contains claude`). */
export const creditsModel = (model: string): boolean => model.toLowerCase().includes("claude");

/** `injectEnabledCreditTypes`: `"enabledCreditTypes":["GOOGLE_ONE_AI"]` on the final body. */
export const injectEnabledCreditTypes = (payload: Json): Json =>
  set(payload, "enabledCreditTypes", ["GOOGLE_ONE_AI"]);

const SELECTION_CODES = new Set(["auth_not_found", "auth_unavailable", "model_cooldown"]);

const RATE_LIMIT_CODES = new Set([
  "rate_limit_exceeded",
  "rate_limited",
  "rate_limit",
  "too_many_requests",
  "throttled",
]);

const QUOTA_CODES = new Set([
  "quota_exhausted",
  "quota_exceeded",
  "usage_limit_reached",
  "insufficient_quota",
  "resource_exhausted",
  "credit_balance_too_low",
]);

const POSITIVE_QUOTA_CODES = new Set([
  ...QUOTA_CODES,
  "quota",
  "credential_quota",
  "model_cooldown",
]);

const CAPACITY_REASONS = new Set([
  "MODEL_CAPACITY_EXHAUSTED",
  "CAPACITY_EXHAUSTED",
  "QUOTA_EXHAUSTED",
  "RESOURCE_EXHAUSTED",
]);

const CODE_PATHS = [
  "error.code",
  "error.type",
  "code",
  "type",
  "response.error.code",
  "response.error.type",
];

const DETAIL_PATHS = ["error.details", "details", "response.error.details"];

const scalar = (root: Json | undefined, path: string): string => {
  const value = get(root, path);

  return isJsonObject(value) || isJsonArray(value) ? "" : asString(value).trim();
};

const reasonsAt = (root: Json | undefined, path: string): ReadonlyArray<string> => {
  const details = get(root, path);

  return isJsonArray(details)
    ? details.map((detail) => asString(get(detail, "reason")).trim().toUpperCase())
    : [];
};

/** `looksLikeHTMLErrorBody`. */
const looksLikeHtml = (lowerBody: string): boolean => {
  const trimmed = lowerBody.trim();

  if (trimmed === "") return false;

  if (
    trimmed.startsWith("<") &&
    ["<!doctype", "<html", "<head", "<body", "<title"].some((tag) => trimmed.includes(tag))
  )
    return true;

  return trimmed.includes("<!doctype html") || trimmed.includes("<html");
};

const TEXT_RETRY =
  /\b(?:retry(?:\s+again)?|try\s+again|wait|resets?|reset)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:milliseconds?|msecs?|ms|seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h)\s*)+)/i;

const DURATION_PART =
  /(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h)/gi;

const unitMs = (unit: string): number | undefined => {
  if (/^(?:ms|msecs?|milliseconds?)$/.test(unit)) return 1;

  if (/^(?:s|secs?|seconds?)$/.test(unit)) return 1000;

  if (/^(?:m|mins?|minutes?)$/.test(unit)) return 60_000;

  if (/^(?:h|hrs?|hours?)$/.test(unit)) return 3_600_000;

  return undefined;
};

/** `parseAntigravityTextRetryHintDuration`: "retry in 1m30s" and the like, in ms. */
const textRetryHintMs = (lowerBody: string): number | undefined => {
  const match = TEXT_RETRY.exec(lowerBody);

  if (match?.[1] === undefined) return undefined;
  let total = 0;
  let parts = 0;

  for (const part of match[1].matchAll(DURATION_PART)) {
    const value = Number.parseFloat(part[1] ?? "");
    const unit = unitMs((part[2] ?? "").toLowerCase());

    parts += 1;

    if (!Number.isFinite(value) || value < 0 || unit === undefined) continue;
    total += value * unit;
  }

  return parts === 0 ? undefined : total;
};

/** `hasAntigravityShortRetryHint`. */
const shortRetryHint = (retryAfterMs: number | undefined, lowerBody: string): boolean => {
  if (retryAfterMs !== undefined && retryAfterMs < SHORT_QUOTA_COOLDOWN_THRESHOLD_MS) return true;
  const hinted = textRetryHintMs(lowerBody);

  return hinted !== undefined && hinted < SHORT_QUOTA_COOLDOWN_THRESHOLD_MS;
};

const RATE_LIMIT_PHRASES = [
  "per-minute",
  "per minute",
  "per-second",
  "per second",
  "requests per",
  "tokens per",
  "rate limit",
  "rate_limit",
  "rate-limit",
  "throttl",
];

/** `hasAntigravityRateLimitPhrase`. */
const rateLimitPhrase = (lowerBody: string): boolean =>
  /\b(?:rpm|tpm)\b/i.test(lowerBody) ||
  RATE_LIMIT_PHRASES.some((marker) => lowerBody.includes(marker));

const QUOTA_PHRASES = [
  "quota exhausted",
  "quota_exhausted",
  "quota exceeded",
  "quota_exceeded",
  "exhausted your quota",
  "exceeded your quota",
  "quota has been exhausted",
  "out of quota",
  "quota limit",
  "insufficient quota",
  "insufficient_quota",
  "insufficient_g1_credits_balance",
  "usage limit reached",
  "usage_limit_reached",
  "credit balance too low",
  "credit_balance_too_low",
];

/** `hasExplicitAntigravityQuotaPhrase`. */
const quotaPhrase = (lowerText: string): boolean =>
  (lowerText.includes("resource has been exhausted") && lowerText.includes("quota")) ||
  QUOTA_PHRASES.some((marker) => lowerText.includes(marker));

/** `hasPositiveQuotaErrorMetadata`. */
const positiveQuotaMetadata = (error: ExecutionError): boolean =>
  error.credentialScoped === true ||
  error.modelCooldown === true ||
  POSITIVE_QUOTA_CODES.has((error.code ?? "").trim().toLowerCase());

const isTransientRateLimit = (error: ExecutionError): boolean =>
  error.credentialScoped !== true && error.code === ErrorCode.transientRateLimit;

/** Whether a long-enough retry delay makes a rate limit a quota matter (`antigravityCreditsShortCooldownThreshold`). */
const longRetry = (retryAfterMs: number | undefined): boolean =>
  retryAfterMs !== undefined && retryAfterMs >= SHORT_QUOTA_COOLDOWN_THRESHOLD_MS;

/** `isAntigravityCreditsQuota429` (CLIProxyAPI e0a1e93d): a 429 that exhausted the free quota, not a rate limit. */
export const isCreditsQuota429 = (error: ExecutionError): boolean => {
  if (isTransientRateLimit(error) || isCloudflareChallengeError(classifiable(error))) return false;
  const body = error.message.trim();
  const lowerBody = body.toLowerCase();

  if (looksLikeHtml(lowerBody)) return false;
  const retryAfterMs = error.retryAfterMs;
  const code = (error.code ?? "").trim().toLowerCase();
  const root = tryParseJson(body);

  if (root === undefined) {
    if (shortRetryHint(retryAfterMs, lowerBody) || rateLimitPhrase(lowerBody)) return false;

    if (RATE_LIMIT_CODES.has(code)) return longRetry(retryAfterMs);

    return positiveQuotaMetadata(error) || quotaPhrase(lowerBody);
  }

  const reasons = DETAIL_PATHS.flatMap((path) => reasonsAt(root, path));

  if (reasons.includes("RATE_LIMIT_EXCEEDED")) return longRetry(retryAfterMs);

  if (
    RATE_LIMIT_CODES.has(code) ||
    CODE_PATHS.some((path) => RATE_LIMIT_CODES.has(scalar(root, path).toLowerCase()))
  )
    return longRetry(retryAfterMs);

  const message = ["error.message", "message", "response.error.message"]
    .flatMap((path) => {
      const text = scalar(root, path).toLowerCase();

      return text === "" ? [] : [text];
    })
    .join("\n");

  if (shortRetryHint(retryAfterMs, message) || rateLimitPhrase(message)) return false;

  if (reasons.includes("QUOTA_EXHAUSTED") || reasons.includes("INSUFFICIENT_G1_CREDITS_BALANCE"))
    return true;

  if (CODE_PATHS.some((path) => QUOTA_CODES.has(scalar(root, path).toLowerCase()))) return true;

  if (positiveQuotaMetadata(error)) return true;

  if (scalar(root, "error.status").toUpperCase() === "RESOURCE_EXHAUSTED")
    return retryAfterMs === undefined ? quotaPhrase(message) : longRetry(retryAfterMs);

  return quotaPhrase(message);
};

const NO_CREDITS_503_CODES = new Set([
  "home_kv_unavailable",
  "home_unavailable",
  "home_fallback_unsupported",
  "thread_auth_unavailable",
  "manager_unavailable",
  "session_auth_retry",
]);

const CAPACITY_503_CODES = new Set([
  "model_capacity_exhausted",
  "capacity_exhausted",
  "quota_exhausted",
  "resource_exhausted",
]);

const CAPACITY_PHRASES = [
  "model_capacity_exhausted",
  "no capacity available",
  "capacity exhausted",
  "capacity_exhausted",
  "quota exhausted",
  "quota_exhausted",
  "resource_exhausted",
];

/** `isAntigravityCreditsCapacity503` (CLIProxyAPI e0a1e93d): a 503 that names exhausted capacity or quota. */
export const isCreditsCapacity503 = (error: ExecutionError): boolean => {
  const body = error.message.trim();
  const lowerBody = body.toLowerCase();

  if (looksLikeHtml(lowerBody) || lowerBody.includes("tos_violation")) return false;
  const code = (error.code ?? "").trim().toLowerCase();

  if (NO_CREDITS_503_CODES.has(code)) return false;

  if (CAPACITY_503_CODES.has(code)) return true;
  const root = tryParseJson(body);

  if (root !== undefined) {
    if (reasonsAt(root, "error.details").some((reason) => CAPACITY_REASONS.has(reason)))
      return true;

    if (
      ["error.status", "error.code", "error.type", "code", "type"].some((path) =>
        CAPACITY_REASONS.has(scalar(root, path).toUpperCase()),
      )
    )
      return true;
  }

  return CAPACITY_PHRASES.some((phrase) => lowerBody.includes(phrase));
};

/**
 * `shouldAttemptAntigravityCreditsFallback`: the rotation ended with a quota or capacity failure, or with nothing left
 * to pick. A request fault, a terminal auth failure, a transient rate limit or a TOS_VIOLATION never spends credits; a
 * 429 must be a quota exhaustion and a 503 a capacity one (CLIProxyAPI e0a1e93d, 5a351d95).
 */
export const shouldAttemptCreditsFallback = (error: ExecutionError): boolean => {
  // The selection's own failures (Go reports them with status 0).
  if (SELECTION_CODES.has(error.code ?? "")) return true;

  if (
    error.requestScoped === true ||
    error.terminalAuth === true ||
    isRequestInvalidError(classifiable(error)) ||
    isTransientRateLimit(error) ||
    isTosViolationError(classifiable(error))
  )
    return false;

  if (error.status === 429) return isCreditsQuota429(error);

  if (error.status === 503) return isCreditsCapacity503(error);

  return false;
};

/** Outcome of {@link parseCreditsReply}: `known` is false when nothing may be published (invalid JSON). */
export interface CreditsReply {
  readonly record: CreditsRecord | undefined;
  readonly known: boolean;
}

/** A credit amount as Go's `strconv.ParseFloat` reads it: `undefined` when invalid or not finite. */
const parseAmount = (raw: string): number | undefined => {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return undefined;
  const value = Number(raw);

  return Number.isFinite(value) ? value : undefined;
};

/**
 * Parses a `loadCodeAssist` reply into a credits record (CLIProxyAPI 737ba4c6, 8e5a98e8). The first GOOGLE_ONE_AI
 * entry with a valid amount wins; a missing, null or blank `minimumCreditAmountForUsage` is `0`, an invalid or negative
 * one skips the entry. Without a usable entry the balance is known and unavailable (`0 / 0`).
 */
export const parseCreditsReply = (body: Json | undefined, now: number): CreditsReply => {
  if (body === undefined) return { record: undefined, known: false };
  const paidTierId = asString(get(body, "paidTier.id")).trim();
  const credits = get(body, "paidTier.availableCredits");

  for (const credit of isJsonArray(credits) ? credits : []) {
    if (asString(get(credit, "creditType")).toUpperCase() !== "GOOGLE_ONE_AI") continue;
    const creditAmount = parseAmount(asString(get(credit, "creditAmount")).trim());

    if (creditAmount === undefined) continue;
    const rawMin = get(credit, "minimumCreditAmountForUsage");
    const minText = rawMin === null ? "" : asString(rawMin).trim();
    const minCreditAmount = minText === "" ? 0 : parseAmount(minText);

    if (minCreditAmount === undefined || minCreditAmount < 0) continue;

    return { record: { creditAmount, minCreditAmount, paidTierId, updatedAt: now }, known: true };
  }

  return {
    record: { creditAmount: 0, minCreditAmount: 0, paidTierId, updatedAt: now },
    known: true,
  };
};

/** `antigravityLoadCodeAssistMaxResponseBytes`. */
const LOAD_CODE_ASSIST_MAX_BYTES = 1 << 20;

/** What a credits probe saw besides the balance: a 403 body, for the TOS_VIOLATION bookkeeping. */
export type CreditsProbeForbidden = (body: string) => Effect.Effect<void>;

/**
 * The credits balance probe (`POST loadCodeAssist`, `updateAntigravityCreditsBalanceForTask`); failures are silent
 * like Go. It sends the credential's custom headers without a session id (CLIProxyAPI 81b5bce4; Workers derives the
 * `Host` from the URL), reads at most 1 MiB, publishes nothing for an oversized or invalid reply, and hands a 403 body
 * to `forbidden` so a TOS_VIOLATION arms the pool pause (CLIProxyAPI acb56c6c). The key is the credential's credits
 * scope (`antigravityCreditsScope`).
 */
export const probeCredits = (
  credential: CredentialSnapshot,
  scope: string,
  accessToken: string,
  userAgent: string,
  state: AntigravityState,
  now: number,
  forbidden: CreditsProbeForbidden = () => Effect.void,
): Effect.Effect<void, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (accessToken === "") return;
    const client = yield* HttpClient.HttpClient;
    const url = `${requestBaseUrl(credential.attributes, credential.metadata)}/v1internal:loadCodeAssist`;

    const headers = applyCustomHeaders(
      {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": userAgent,
      },
      credential,
      new Headers(),
      "",
    );

    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyText(
        JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
        "application/json",
      ),
    );

    const response = yield* client.execute(request).pipe(Effect.timeout("5 seconds"));
    const { text, overflow } = yield* readBoundedText(response, LOAD_CODE_ASSIST_MAX_BYTES);

    if (response.status < 200 || response.status >= 300) {
      if (response.status === 403 && !overflow) yield* forbidden(text);

      return;
    }

    if (overflow) return;
    const { record } = parseCreditsReply(tryParseJson(text), now);

    if (record !== undefined) yield* Effect.promise(() => state.setCredits(scope, record));
  }).pipe(Effect.catchCause(() => Effect.void));
