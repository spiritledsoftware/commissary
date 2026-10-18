/**
 * What a usage record keeps of a failed attempt (ADR 0027): the status code and the error's type and code, never its
 * body. An upstream error body can echo prompt text, so it is read here only to pick out two short identifiers
 * (`error.type`, `error.code`, Gemini's `error.status`) and is then dropped. A value that is not a short identifier
 * (letters, digits and `_ . : -`) is dropped as well: a type or code never carries free text.
 *
 * New in the Workers port; the Go usage record keeps the body (`Fail.Body`), which the export no longer carries.
 */
import { get, isJsonObject, type Json, tryParseJson } from "@commissary/json";

/** The identifying part of a failure; the status code is the record's own. */
export interface FailureDetail {
  /** The error's type (`rate_limit_error`, `RESOURCE_EXHAUSTED`). */
  readonly type?: string;
  /** The error's code (`insufficient_quota`, `auth_unavailable`, `429`). */
  readonly code?: string;
}

/** What a record stores of a failure. */
export interface UsageFailure extends FailureDetail {
  readonly statusCode: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** `value` when it is a short identifier (a number counts by its digits), else `undefined`. */
const identifier = (value: Json | undefined): string | undefined => {
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : undefined;

  return text !== undefined && IDENTIFIER.test(text) ? text : undefined;
};

const firstIdentifier = (
  node: Json | undefined,
  ...paths: ReadonlyArray<string>
): string | undefined => {
  for (const path of paths) {
    const found = identifier(get(node, path));

    if (found !== undefined) return found;
  }

  return undefined;
};

/**
 * The type and code of an error: `code` is the one Commissary itself gave it (`auth_not_found`, ...), which wins over
 * the upstream's; `message` is the upstream body for an upstream HTTP error, read for its `error.type` and
 * `error.code` (OpenAI, Claude, Codex), `error.status` (Gemini) or `detail.error_type` (System One) and not kept.
 */
export const failureDetail = (error: {
  readonly message: string;
  readonly code?: string | undefined;
}): FailureDetail => {
  const body = tryParseJson(error.message);
  const parsed = isJsonObject(body) ? body : undefined;

  const type = firstIdentifier(
    parsed,
    "error.type",
    "error.status",
    // TypeSafe's and SubQ's System One errors (ADR 0032).
    "detail.error_type",
    "type",
    "error",
  );

  const code = identifier(error.code) ?? firstIdentifier(parsed, "error.code", "code");

  return {
    ...(type === undefined || type === "error" ? {} : { type }),
    ...(code === undefined ? {} : { code }),
  };
};
