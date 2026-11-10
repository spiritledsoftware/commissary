/**
 * Codex stream bootstrap buffering helpers (`upstream.codex.stream-bootstrap-buffering` / `-timeout`).
 *
 * Go source: internal/runtime/executor/codex_executor_terminal.go (codexBootstrapMaxBufferedFrames/Bytes,
 * isCodexBootstrapBufferableEvent, isCodexBufferableOutputItem, isCodexEmptyContentList, isCodexEmptyPart,
 * newCodexBootstrapOverloadErr, isCodexOverloadBootstrapFailure) and internal/config/config_types.go
 * (StreamBootstrapTimeoutDuration).
 *
 * With buffering on, frames that carry nothing observable (handshake preamble, keepalives, empty `*.added` frames) are
 * held back until the first real event, so a capacity/rate-limit rejection smuggled into an HTTP 200 stream can fail
 * the attempt before the client sees anything and the conductor retries it on another credential.
 */
import { asString, get, isJsonArray, type Json, tryParseJson } from "@commissary/json";
import type { ExecutionError } from "../errors.ts";
import { isCodexModelCapacityError, newCodexStatusError } from "./errors.ts";

/** Upstream lines held back at most (the SSE executor charges one unit per line). */
export const BOOTSTRAP_MAX_BUFFERED_FRAMES = 48;

/** Bytes held back at most (upstream lines plus the chunks they translate into). */
export const BOOTSTRAP_MAX_BUFFERED_BYTES = 1 << 20;

const UNLIMITED_WORDS = new Set(["", "0", "none", "unlimited", "disabled", "off", "never"]);

const DURATION_UNITS = new Map<string, number>([
  ["ns", 1e-6],
  ["us", 1e-3],
  ["\u00b5s", 1e-3],
  ["\u03bcs", 1e-3],
  ["ms", 1],
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
]);

/** Go `time.ParseDuration` in milliseconds (`undefined` = invalid). */
const parseGoDurationMs = (raw: string): number | undefined => {
  let rest = raw;

  if (rest === "") return undefined;
  let sign = 1;

  if (rest[0] === "-" || rest[0] === "+") {
    if (rest[0] === "-") sign = -1;
    rest = rest.slice(1);
  }

  if (rest === "0") return 0;

  if (rest === "") return undefined;
  let total = 0;

  while (rest !== "") {
    const match = /^(\d*\.?\d*)(ns|us|\u00b5s|\u03bcs|ms|s|m|h)/.exec(rest);

    if (match === null || match[1] === undefined || match[1] === "" || match[1] === ".")
      return undefined;
    total += Number.parseFloat(match[1]) * (DURATION_UNITS.get(match[2] ?? "") ?? 0);
    rest = rest.slice(match[0].length);
  }

  return sign * total;
};

/**
 * `StreamBootstrapTimeoutDuration` in milliseconds: `0` (unlimited) for empty/`0`/`none`/`unlimited`/`disabled`/`off`/
 * `never` and for invalid text, a Go duration (`10s`, `500ms`) or whole seconds otherwise.
 */
export const bootstrapTimeoutMs = (raw: string): number => {
  const text = raw.trim();

  if (UNLIMITED_WORDS.has(text.toLowerCase())) return 0;
  const duration = parseGoDurationMs(text);

  if (duration !== undefined && duration >= 0) return duration;

  if (/^[+-]?\d+$/.test(text)) {
    const seconds = Number.parseInt(text, 10);

    if (seconds >= 0 && Number.isSafeInteger(seconds)) return seconds * 1000;
  }

  return 0;
};

const isEmptyContentList = (list: Json | undefined): boolean => {
  if (list === undefined || list === null) return true;

  // gjson `Array()` of a non-array value is a one-element list holding that value.
  for (const entry of isJsonArray(list) ? list : [list]) {
    switch (asString(get(entry, "type"))) {
      case "output_text":
      case "summary_text":
      case "text":
      case "reasoning_text":
        if (asString(get(entry, "text")) !== "") return false;
        break;
      case "refusal":
        if (asString(get(entry, "refusal")) !== "") return false;
        break;
      default:
        return false;
    }
  }

  return true;
};

const isBufferableOutputItem = (event: Json | undefined): boolean => {
  const item = get(event, "item");

  switch (asString(get(item, "type"))) {
    case "message":
      return isEmptyContentList(get(item, "content"));
    case "reasoning":
      if (asString(get(item, "encrypted_content")) !== "") return false;

      return isEmptyContentList(get(item, "summary")) && isEmptyContentList(get(item, "content"));
    case "function_call":
      return asString(get(item, "arguments")) === "";
    case "custom_tool_call":
      return asString(get(item, "input")) === "";
    default:
      return false;
  }
};

const isEmptyPart = (event: Json | undefined): boolean => {
  const part = get(event, "part");

  switch (asString(get(part, "type"))) {
    case "output_text":
    case "summary_text":
    case "text":
    case "reasoning_text":
      return asString(get(part, "text")) === "";
    case "refusal":
      return asString(get(part, "refusal")) === "";
    default:
      return false;
  }
};

/**
 * `isCodexBootstrapBufferableEvent`: nothing observable has happened yet. The list is closed on purpose: an unknown
 * frame releases the stream, so a rejection can never replay a tool call (and its side effects) on another credential.
 */
export const isBootstrapBufferableEvent = (
  eventType: string,
  payload: string,
  event: Json | undefined,
): boolean => {
  if (payload.trim() === "") return true;

  switch (eventType) {
    case "response.created":
    case "response.in_progress":
    case "codex.rate_limits":
    case "codex.response.metadata":
    case "response.metadata":
    case "keepalive":
      return true;
    case "response.output_item.added":
      return isBufferableOutputItem(event);
    case "response.content_part.added":
    case "response.reasoning_summary_part.added":
      return isEmptyPart(event);
    default:
      return false;
  }
};

/**
 * `isCodexOverloadBootstrapFailure`: a terminal failure inside an HTTP 200 stream that another credential may be able
 * to serve (capacity, overload, rate limit, retryable server error).
 */
export const isOverloadBootstrapFailure = (bodyText: string): boolean => {
  if (isCodexModelCapacityError(bodyText)) return true;
  const body = tryParseJson(bodyText);
  const lower = (path: string) => asString(get(body, path)).trim().toLowerCase();
  const errorType = lower("error.type");
  const errorCode = lower("error.code");
  const errorMessage = lower("error.message") !== "" ? lower("error.message") : lower("message");

  if (errorType === "service_unavailable_error" || errorCode === "server_is_overloaded")
    return true;

  if (errorType === "rate_limit_error" || errorCode === "rate_limit_exceeded") return true;

  return (
    (errorType === "server_error" || errorCode === "server_error") &&
    errorMessage.includes("you can retry your request")
  );
};

/** `newCodexBootstrapOverloadErr`: a buffered overload rejection with its real status (503). */
export const bootstrapOverloadError = (body: string, nowMs: number): ExecutionError =>
  newCodexStatusError(503, body, { modelLevelCooling: false, nowMs });

/** `grokbuild.IsGrokClientHeaders`: the User-Agent names a Grok client. */
export const isGrokClientHeaders = (headers: Headers): boolean => {
  const agent = (headers.get("user-agent") ?? "").toLowerCase();

  return agent.includes("grok-pager") || agent.includes("grok-shell");
};
