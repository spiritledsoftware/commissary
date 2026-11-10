/**
 * Anthropic unified rate-limit header parsing and upstream error classification.
 *
 * Go source: internal/runtime/executor/helps/claude_ratelimit.go (ClaudeHeadersIndicateUnifiedRateLimitRejection,
 * isOverageOrFableOnlyRejection, ParseClaudeRateLimitReset), claude_executor_request.go
 * (classifyClaudeUpstreamErrorWithCooling, claudeBodyIndicatesFastModeCredits), claude_executor_fast_error.go.
 * ParseClaudeRateLimitResetForError (upstream db1bab01) and the omitted-5h Fable-only branch (0130d6f3) are ported.
 */
import { randomInt } from "node:crypto";
import { asString, get, tryParseJson } from "@commissary/json";
import { ExecutionError, headersRecord } from "../errors.ts";

const FUZZ_MIN_SECONDS = 1;

const FUZZ_MAX_SECONDS = 30;

const MAX_WINDOW_MS = 7 * 24 * 3600_000 + 3600_000;

const h = (headers: Headers, name: string): string => headers.get(name) ?? "";

const lower = (value: string): string => value.trim().toLowerCase();

const windowAllowed = (status: string): boolean =>
  status === "allowed" || status === "allowed_warning";

const utilizationHealthy = (raw: string): boolean => {
  const text = raw.trim();

  if (text === "") return false;
  const value = Number(text);

  return Number.isFinite(value) && value >= 0 && value < 1;
};

const overageOrFableOnlyRejection = (
  headers: Headers,
  unifiedStatus: string,
  status5h: string,
  status7d: string,
  status7dOI: string,
): boolean => {
  if (status5h === "rejected" || status7d === "rejected") return false;
  const overageStatus = lower(h(headers, "anthropic-ratelimit-unified-overage-status"));
  const disabledReason = h(headers, "anthropic-ratelimit-unified-overage-disabled-reason").trim();
  const claim = lower(h(headers, "anthropic-ratelimit-unified-representative-claim"));

  const overageRejected =
    status7dOI === "rejected" ||
    overageStatus === "rejected" ||
    disabledReason !== "" ||
    claim.includes("overage");

  if (!overageRejected) return false;
  const shared5hAllowed = windowAllowed(status5h);
  const shared7dAllowed = windowAllowed(status7d);

  if (shared5hAllowed && shared7dAllowed) return true;

  if (
    shared7dAllowed &&
    status5h === "" &&
    utilizationHealthy(h(headers, "anthropic-ratelimit-unified-5h-utilization"))
  )
    return true;

  // A rejected Fable-only response omits 5h utilization altogether when the 5h window is unused; a present but
  // empty or malformed value stays credential-scoped.
  if (
    shared7dAllowed &&
    status5h === "" &&
    unifiedStatus === "rejected" &&
    !headers.has("anthropic-ratelimit-unified-5h-utilization")
  )
    return true;

  if (
    shared5hAllowed &&
    status7d === "" &&
    utilizationHealthy(h(headers, "anthropic-ratelimit-unified-7d-utilization"))
  )
    return true;

  if (
    unifiedStatus === "rejected" &&
    status5h === "" &&
    status7d === "" &&
    claim.includes("overage")
  ) {
    const util5h = h(headers, "anthropic-ratelimit-unified-5h-utilization");
    const util7d = h(headers, "anthropic-ratelimit-unified-7d-utilization");

    if (
      (util5h.trim() === "" || utilizationHealthy(util5h)) &&
      (util7d.trim() === "" || utilizationHealthy(util7d))
    )
      return true;
  }

  return false;
};

/** `ClaudeHeadersIndicateUnifiedRateLimitRejection`: the whole credential is rate limited. */
export const headersIndicateUnifiedRejection = (headers: Headers): boolean => {
  const unified = lower(h(headers, "anthropic-ratelimit-unified-status"));
  const status5h = lower(h(headers, "anthropic-ratelimit-unified-5h-status"));

  if (status5h === "rejected") return true;
  const status7d = lower(h(headers, "anthropic-ratelimit-unified-7d-status"));

  if (status7d === "rejected") return true;

  if (unified !== "rejected") return false;
  const status7dOI = lower(h(headers, "anthropic-ratelimit-unified-7d_oi-status"));

  return !overageOrFableOnlyRejection(headers, unified, status5h, status7d, status7dOI);
};

const parseUnixOrTimestamp = (raw: string): number | undefined => {
  const text = raw.trim();

  if (text === "") return undefined;
  const seconds = Number(text);

  if (text !== "" && Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(text);

  return Number.isNaN(date) ? undefined : date;
};

const parseRetryAfter = (raw: string, now: number): number | undefined => {
  const text = raw.trim();

  if (text === "") return undefined;
  const seconds = Number(text);

  if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1000;
  const date = Date.parse(text);

  return Number.isNaN(date) ? undefined : date;
};

/**
 * `ParseClaudeRateLimitReset`: cooldown in ms (latest rejected window deadline plus 1-30 s fuzz), `undefined` when
 * the generic backoff should be used.
 */
export const parseRateLimitResetMs = (
  headers: Headers,
  now: number,
  fuzzSeconds: () => number = () => randomInt(FUZZ_MIN_SECONDS, FUZZ_MAX_SECONDS + 1),
): number | undefined => {
  const unified = lower(h(headers, "anthropic-ratelimit-unified-status"));
  const status5h = lower(h(headers, "anthropic-ratelimit-unified-5h-status"));
  const status7d = lower(h(headers, "anthropic-ratelimit-unified-7d-status"));
  const status7dOI = lower(h(headers, "anthropic-ratelimit-unified-7d_oi-status"));
  const overageOnly = overageOrFableOnlyRejection(headers, unified, status5h, status7d, status7dOI);
  const deadlines: number[] = [];

  const push = (value: number | undefined): void => {
    if (value !== undefined && value > now) deadlines.push(value);
  };

  if (!overageOnly) {
    const retryAfter = h(headers, "retry-after");

    if (retryAfter !== "") push(parseRetryAfter(retryAfter, now));
  }

  if (status5h === "rejected")
    push(parseUnixOrTimestamp(h(headers, "anthropic-ratelimit-unified-5h-reset")));

  if (status7d === "rejected")
    push(parseUnixOrTimestamp(h(headers, "anthropic-ratelimit-unified-7d-reset")));

  if (status7dOI === "rejected" && !overageOnly)
    push(parseUnixOrTimestamp(h(headers, "anthropic-ratelimit-unified-7d_oi-reset")));

  const unifiedRejected =
    !overageOnly &&
    (unified === "rejected" ||
      status5h === "rejected" ||
      status7d === "rejected" ||
      status7dOI === "rejected" ||
      (unified === "" && !windowAllowed(status5h) && !windowAllowed(status7d)));

  if (unifiedRejected) {
    const raw = h(headers, "anthropic-ratelimit-unified-reset");

    if (raw !== "") {
      const claim = lower(h(headers, "anthropic-ratelimit-unified-representative-claim"));

      const overageReset = parseUnixOrTimestamp(
        h(headers, "anthropic-ratelimit-unified-overage-reset"),
      );

      const unifiedReset = parseUnixOrTimestamp(raw);

      const overageBoundary =
        claim.includes("overage") &&
        unifiedReset !== undefined &&
        overageReset !== undefined &&
        unifiedReset === overageReset;

      if (!overageBoundary) push(unifiedReset);
    }
  }

  const kept = deadlines.filter((deadline) => deadline > now && deadline - now <= MAX_WINDOW_MS);

  if (kept.length === 0) return undefined;
  const latest = Math.max(...kept);

  return latest - now + fuzzSeconds() * 1000;
};

const QUOTA_STATUS_HEADERS = [
  "anthropic-ratelimit-unified-status",
  "anthropic-ratelimit-unified-5h-status",
  "anthropic-ratelimit-unified-7d-status",
  "anthropic-ratelimit-unified-7d_oi-status",
  "anthropic-ratelimit-unified-overage-status",
];

const PER_MINUTE_MESSAGES = new Set([
  "this request would exceed the requests per minute rate limit. please try again later.",
  "this request would exceed the input tokens per minute rate limit. please try again later.",
  "this request would exceed the output tokens per minute rate limit. please try again later.",
]);

/** `claudeBodyIsExplicitPerMinuteRateLimit`: the body is exactly one complete per-minute message (no substring match). */
const bodyIsExplicitPerMinuteRateLimit = (body: string): boolean => {
  const parsed = tryParseJson(body);

  return (
    asString(get(parsed, "error.type")) === "rate_limit_error" &&
    PER_MINUTE_MESSAGES.has(lower(asString(get(parsed, "error.message"))))
  );
};

/**
 * `ParseClaudeRateLimitResetForError`: `parseRateLimitResetMs` with one body-aware exception. An explicit per-minute
 * error carries no quota window, so the unclassified unified reset must not stretch its short Retry-After into an
 * hours-long cooldown. Applies only when no status header declares a quota window and Retry-After is a usable value.
 * `fuzzSeconds` is injectable so tests can pin the 1-30 s fuzz, as in `parseRateLimitResetMs`.
 * (Go also rejects repeated or differently cased Retry-After keys as ambiguous; `Headers` merges them, so a repeated
 * value fails to parse and falls back to the conservative result.)
 */
export const parseRateLimitResetForError = (
  headers: Headers,
  body: string,
  now: number,
  fuzzSeconds?: () => number,
): number | undefined => {
  const conservative = () => parseRateLimitResetMs(headers, now, fuzzSeconds);

  if (
    !bodyIsExplicitPerMinuteRateLimit(body) ||
    QUOTA_STATUS_HEADERS.some((name) => h(headers, name).trim() !== "")
  )
    return conservative();
  const retryAt = parseRetryAfter(h(headers, "retry-after"), now);

  if (retryAt === undefined || retryAt <= now || retryAt - now > MAX_WINDOW_MS)
    return conservative();
  const narrowed = new Headers(headers);

  narrowed.delete("anthropic-ratelimit-unified-reset");

  return parseRateLimitResetMs(narrowed, now, fuzzSeconds);
};

/** `claudeBodyIndicatesFastModeCredits`. */
export const bodyIndicatesFastModeCredits = (body: string): boolean => {
  const parsed = tryParseJson(body);
  let message = lower(asString(get(parsed, "error.message")));

  if (message === "") message = body.toLowerCase();

  return (
    message.includes("fast request rejected") ||
    (message.includes("fast") &&
      (message.includes("usage credits") || message.includes("credits are required")))
  );
};

/** `classifyClaudeUpstreamErrorWithCooling`. */
export const classifyUpstreamError = (
  status: number,
  headers: Headers,
  body: string,
  modelLevelCooling: boolean,
  now: number,
): ExecutionError => {
  const retryAfterMs =
    status >= 400 && status < 600 ? parseRateLimitResetForError(headers, body, now) : undefined;

  const base = {
    status,
    message: body,
    headers: headersRecord(headers),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };

  if (status === 429) {
    if (!modelLevelCooling && headersIndicateUnifiedRejection(headers)) {
      return new ExecutionError({ ...base, credentialScoped: true });
    }

    if (bodyIndicatesFastModeCredits(body))
      return new ExecutionError({ ...base, requestScoped: true });

    return new ExecutionError({ ...base, credentialScoped: false });
  }

  return new ExecutionError(base);
};
