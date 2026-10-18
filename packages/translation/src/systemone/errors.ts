/**
 * Upstream System One error bodies read into TypeSafe's terms (ADR 0032): every `/v1/systemone` error reaches the
 * client as `{"detail":{"error_type","message"}}` (built by `systemOneErrorBody` in `@commissary/core`). Workers
 * addition, no Go counterpart. The shapes the providers answer:
 *
 * - TypeSafe and SubQ: `{"detail":{"error_type","message"}}`; a validation failure may carry FastAPI's
 *   `{"detail":[{"loc","msg","type"}]}` or a plain `{"detail":"..."}`.
 * - OpenCode Zen: its own `{"type":"error","error":{"type","message"}}`, a relayed failure
 *   `{"error":{"type","message"}}` (messages start "Upstream request failed: "), or TypeSafe's `detail` verbatim.
 * - Commissary's own errors: the OpenAI shape `{"error":{"message","type","code"}}` or plain text.
 *
 * Only TypeSafe's `error_type` is kept: the other shapes' types are another vocabulary (`AuthError`, `server_error`,
 * `invalid_request_error`), so the caller derives one from the status instead.
 */
import { isJsonArray, isJsonObject, type Json, tryParseJson } from "@commissary/json";

/** Longest message taken from a body that is not JSON (an HTML error page, a proxy's text). */
const MAX_TEXT_MESSAGE = 500;

export interface SystemOneError {
  /** TypeSafe's `error_type` when the body carried one; otherwise the caller picks one from the status. */
  readonly error_type?: string;
  /** The message; empty when the body said nothing usable (the caller falls back to the status text). */
  readonly message: string;
}

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

/** FastAPI validation details: `loc: msg` per entry. */
const validationMessage = (details: ReadonlyArray<Json>): string =>
  details
    .flatMap((entry) => {
      if (!isJsonObject(entry)) return [];
      const msg = text(entry["msg"]) || text(entry["message"]);
      const loc = isJsonArray(entry["loc"]) ? entry["loc"].map(String).join(".") : "";

      return msg === "" ? [] : [loc === "" ? msg : `${loc}: ${msg}`];
    })
    .join("; ");

/** Reads an upstream (or Commissary) error body; `status` only matters for FastAPI validation lists (422). */
export const parseUpstreamSystemOneError = (status: number, body: string): SystemOneError => {
  const trimmed = body.trim();
  const parsed = tryParseJson(trimmed);

  if (!isJsonObject(parsed)) {
    return {
      message:
        trimmed.length > MAX_TEXT_MESSAGE ? `${trimmed.slice(0, MAX_TEXT_MESSAGE)}…` : trimmed,
    };
  }

  const detail = parsed["detail"];

  if (isJsonObject(detail)) {
    const type = text(detail["error_type"]);

    return {
      ...(type === "" ? {} : { error_type: type }),
      message: text(detail["message"]) || text(detail["msg"]),
    };
  }

  if (typeof detail === "string") return { message: detail.trim() };

  if (isJsonArray(detail))
    return {
      ...(status === 422 ? { error_type: "validation_error" } : {}),
      message: validationMessage(detail),
    };

  const error = parsed["error"];

  if (isJsonObject(error)) return { message: text(error["message"]) };

  if (typeof error === "string") return { message: error.trim() };

  return { message: text(parsed["message"]) };
};
