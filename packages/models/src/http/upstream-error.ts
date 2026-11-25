/**
 * Upstream error classification shared by the Codex executor (terminal failures) and the Responses stream framer.
 *
 * Go source: internal/runtime/executor/codex_executor_terminal.go (`codexTerminalFailureStatus` type/code table,
 * `codexTerminalErrorBody` image_generation guidance), sdk/api/handlers/openai/openai_responses_handlers.go
 * (`responsesSSEPayloadErrorStatus`, `responsesAnnotateImageGenerationComplexityPayload`).
 */
import { asString, get, type Json } from "@commissary/json";

/**
 * Policy blocks (Go 1f76e479): request faults the caller must change, never retried elsewhere, each with the official
 * copy for an upstream error that names only its code (`openAIResponsesPolicyFallbackMessage`; none for the content
 * policy codes). `@commissary/translation`'s Codex -> Claude stream translator keeps a mirror of this table.
 */
const POLICY_BLOCKS: ReadonlyMap<string, string | undefined> = new Map([
  ["bio_policy", "This content was flagged for possible biological risk."],
  ["cyber_policy", "This request has been flagged for possible cybersecurity risk."],
  ["cyber_policy_violation", "This request has been flagged for possible cybersecurity risk."],
  [
    "misalignment_policy_violation",
    "This request was blocked due to a misalignment policy violation.",
  ],
  ["invalid_prompt", "Invalid request."],
  ["content_policy_violation", undefined],
  ["image_content_policy_violation", undefined],
]);

/** The policy block codes, lowercase. */
export const POLICY_BLOCK_CODES: ReadonlyArray<string> = [...POLICY_BLOCKS.keys()];

/** The code (any case, surrounding space ignored) is a policy block. */
export const isPolicyBlockCode = (code: string): boolean =>
  POLICY_BLOCKS.has(code.trim().toLowerCase());

/** The official message of a policy block code; `undefined` for other codes and blocks without one. */
export const policyBlockMessage = (code: string): string | undefined =>
  POLICY_BLOCKS.get(code.trim().toLowerCase());

/** Stream event types that name the event, not the error's own type (`error`, `response.failed`, `response.error`). */
export const ERROR_EVENT_TYPES: ReadonlySet<string> = new Set([
  "error",
  "response.failed",
  "response.error",
]);

/** The HTTP status implied by an upstream error's `type` and `code` (502 when neither is recognised). */
export const statusFromErrorTypeAndCode = (rawType: string, rawCode: string): number => {
  const type = rawType.trim().toLowerCase();
  const code = rawCode.trim().toLowerCase();

  if (isPolicyBlockCode(code)) return 400;

  if (type === "not_found_error" || code === "not_found" || code === "model_not_found") return 404;

  if (type === "authentication_error" || code === "invalid_api_key" || code === "unauthorized")
    return 401;

  if (type === "permission_error" || code === "forbidden" || code === "permission_denied")
    return 403;

  if (type === "rate_limit_error" || code === "rate_limit_exceeded") return 429;

  if (
    type === "invalid_request_error" ||
    type === "bad_request_error" ||
    type === "image_generation_user_error" ||
    code === "invalid_value" ||
    code === "invalid_request_error"
  )
    return 400;

  return 502;
};

/**
 * 8fb60326: an `image_generation_user_error` about `complexity` gets remediation guidance appended. Returns the new
 * message, or `undefined` when the error needs none.
 */
export const annotateImageGenerationError = (error: Json | undefined): string | undefined => {
  if (asString(get(error, "type")).trim().toLowerCase() !== "image_generation_user_error")
    return undefined;
  const message = asString(get(error, "message")).trim();
  const param = asString(get(error, "param")).trim().toLowerCase();

  if (
    (param !== "complexity" && !message.toLowerCase().includes("complexity")) ||
    message.includes("/v1/images/generations")
  )
    return undefined;

  return `${message} (Set tool_choice to {"type":"image_generation"}, use a compatible Responses model such as gpt-5.4-mini, or call /v1/images/generations directly.)`;
};
