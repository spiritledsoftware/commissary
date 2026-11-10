/**
 * Frame helpers of the Responses WebSocket: JSON payloads of execution chunks, terminal error frames and the close codes
 * mirrored from upstream failures.
 *
 * Go source: sdk/api/handlers/openai/openai_responses_websocket_forward.go (websocketJSONPayloadsFromChunk,
 * buildResponsesWebsocketErrorPayload, shouldExposeResponsesUpstreamError, collectResponsesWebsocketOutputItem,
 * restoreResponsesWebsocketCompletionOutput, responseCompletedOutputFromPayload, recordPendingToolCallIDsFromPayload,
 * completeResponsesWebsocketLocalInterrupt), openai_responses_websocket.go (websocketClosePayloadForUpstreamError,
 * truncateWebsocketCloseReason), openai_responses_websocket_timeline.go (responsesWebsocketErrorMessageFromPayload).
 */
import { statusText } from "../../../http/status.ts";
import { openAIErrorBody } from "../../../http/errors.ts";
import { isRequestInvalid } from "../../../executor/classify.ts";
import { ExecutionError } from "../../../executor/errors.ts";
import { isReplayRequired } from "../../../executor/websocket/session.ts";
import {
  asInt,
  asString,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { isCompleteToolCall } from "./tool-cache.ts";
import { isToolCallType } from "./normalize.ts";

/** Close reasons are limited to 123 bytes by the protocol. */
export const CLOSE_REASON_MAX_BYTES = 123;

export const HTTP_REPLAY_CLOSE_REASON = "upstream requires HTTP replay";

/** `CloseServiceRestart`: the client replays its full input on a new socket. */
export const CLOSE_SERVICE_RESTART = 1012;

export const CLOSE_MESSAGE_TOO_BIG = 1009;

/** `truncateWebsocketCloseReason`: at most `maxBytes` UTF-8 bytes, never splitting a character. */
export const truncateCloseReason = (reason: string, maxBytes = CLOSE_REASON_MAX_BYTES): string => {
  const encoder = new TextEncoder();

  if (encoder.encode(reason).length <= maxBytes) return reason;
  let out = "";
  let used = 0;

  for (const char of reason) {
    const size = encoder.encode(char).length;

    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }

  return out;
};

/** `websocketJSONPayloadsFromChunk`: JSON objects of an execution chunk (SSE framed or bare). */
export const payloadsFromChunk = (chunk: string): JsonObject[] => {
  const out: JsonObject[] = [];

  for (const raw of chunk.split("\n")) {
    let line = raw.trim();

    if (line === "" || line.startsWith("event:")) continue;

    if (line.startsWith("data:")) line = line.slice("data:".length).trim();

    if (line === "" || line === "[DONE]") continue;
    const parsed = tryParseJson(line);

    if (isJsonObject(parsed)) out.push(parsed);
  }

  if (out.length > 0) return out;
  let whole = chunk.trim();

  if (whole.startsWith("data:")) whole = whole.slice("data:".length).trim();

  if (whole !== "" && whole !== "[DONE]") {
    const parsed = tryParseJson(whole);

    if (isJsonObject(parsed)) out.push(parsed);
  }

  return out;
};

// --- errors --------------------------------------------------------------------------------------------------------

const QUOTA_OR_COOLDOWN_TYPES = new Set(["usage_limit_reached", "model_cooldown"]);

const QUOTA_PATHS = [
  "error.type",
  "type",
  "response.error.type",
  "body.error.type",
  "error.code",
  "code",
  "response.error.code",
  "body.error.code",
] as const;

/** `isResponsesWebsocketQuotaOrCooldownError`: a quota (`usage_limit_reached`) or model cooldown (`model_cooldown`) failure. */
export const isQuotaOrCooldownError = (
  error: Pick<ExecutionError, "message" | "code">,
): boolean => {
  if (error.code?.trim().toLowerCase() === "model_cooldown") return true;
  const body = tryParseJson(error.message.trim());

  return (
    isJsonObject(body) &&
    QUOTA_PATHS.some((path) =>
      QUOTA_OR_COOLDOWN_TYPES.has(asString(get(body, path)).trim().toLowerCase()),
    )
  );
};

/**
 * `shouldExposeResponsesUpstreamError`: request-shape and terminal auth failures, and terminal 429, quota and model
 * cooldown failures (credential failover is exhausted by then) reach the client; the rest only closes the socket.
 */
export const shouldExposeError = (error: ExecutionError): boolean =>
  error.terminalAuth === true ||
  error.status === 429 ||
  isQuotaOrCooldownError(error) ||
  isRequestInvalid(error);

/** `http.CanonicalHeaderKey`: `retry-after` -> `Retry-After`. */
const canonicalHeader = (name: string): string =>
  name
    .trim()
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join("-");

/**
 * The frame's top-level `headers`: the error's safe headers (the trusted `Retry-After` of a cooldown) plus the raw
 * upstream ones, which never override a trusted `Retry-After`. Names are canonical-cased.
 */
const frameHeaders = (error: Pick<ExecutionError, "headers" | "safeHeaders">) => {
  const out: Record<string, string> = {};
  let trusted = false;

  for (const [name, value] of Object.entries(error.safeHeaders ?? {})) {
    if (name.trim() === "" || value.trim() === "") continue;
    out[canonicalHeader(name)] = value;

    if (canonicalHeader(name) === "Retry-After") trusted = true;
  }

  for (const [name, value] of Object.entries(error.headers ?? {})) {
    if (name.trim() === "" || value.trim() === "") continue;

    if (trusted && canonicalHeader(name) === "Retry-After") continue;
    out[canonicalHeader(name)] = value;
  }

  return out;
};

/** `buildResponsesWebsocketErrorPayload`. */
export const buildErrorPayload = (
  error: Pick<
    ExecutionError,
    "status" | "message" | "headers" | "safeHeaders" | "terminalAuth" | "code"
  >,
): JsonObject => {
  let status = error.status > 0 ? error.status : 500;

  // A quota or cooldown failure with a 5xx (or no) status is still a 429 for the client.
  if ((error.status <= 0 || status >= 500) && isQuotaOrCooldownError(error)) status = 429;
  const text = error.message.trim() !== "" ? error.message : statusText(status);

  const body = tryParseJson(
    openAIErrorBody(status, text, error.terminalAuth === true ? { terminalAuth: true } : {}),
  );

  const payload: JsonObject = { type: "error", status };
  const headers = frameHeaders(error);

  if (Object.keys(headers).length > 0) payload["headers"] = headers;
  const errorNode = get(body, "error");
  payload["error"] =
    errorNode !== undefined ? errorNode : (body ?? { type: "server_error", message: text });

  return payload;
};

/** `responsesWebsocketErrorMessageFromPayload`: an `error` event delivered inside the stream. */
export const errorFromPayload = (payload: JsonObject): ExecutionError => {
  let status = asInt(get(payload, "status"));

  if (status <= 0) status = asInt(get(payload, "status_code"));

  if (status <= 0) status = 500;

  return new ExecutionError({ status, message: JSON.stringify(payload) });
};

/** `websocketClosePayloadForUpstreamError`: close code and reason that mirror an upstream transport failure. */
export const closeForUpstreamError = (
  error: ExecutionError,
): { readonly code: number; readonly reason: string } | undefined => {
  if (isReplayRequired(error)) {
    return { code: CLOSE_SERVICE_RESTART, reason: truncateCloseReason(HTTP_REPLAY_CLOSE_REASON) };
  }

  if (error.status !== 413) return undefined;
  const parsed = tryParseJson(error.message);

  if (asString(get(parsed, "error.code")) !== "message_too_big") return undefined;
  const reason = asString(get(parsed, "error.message")).trim();

  return {
    code: CLOSE_MESSAGE_TOO_BIG,
    reason: truncateCloseReason(reason === "" ? "message too big" : reason),
  };
};

// --- response output bookkeeping -------------------------------------------------------------------------------

/** Output items of the running response (`response.output_item.done`), by `output_index` or in arrival order. */
export class OutputCollector {
  byIndex = new Map<number, JsonObject>();
  fallback: JsonObject[] = [];
  pendingToolCallIds = new Set<string>();

  reset(): void {
    this.byIndex = new Map();
    this.fallback = [];
    this.pendingToolCallIds = new Set();
  }

  /** `collectResponsesWebsocketOutputItem`. */
  collect(payload: JsonObject): void {
    if (asString(payload["type"]) !== "response.output_item.done") return;
    const item = payload["item"];

    if (!isJsonObject(item)) return;
    const index = payload["output_index"];

    if (index !== undefined) this.byIndex.set(asInt(index), cloneJson(item));
    else this.fallback.push(cloneJson(item));
  }

  private collected(): JsonObject[] {
    const indexed = [...this.byIndex.entries()].toSorted(([a], [b]) => a - b);

    return [...indexed.map(([, item]) => item), ...this.fallback];
  }

  /** `responseCompletedOutputFromPayload`. */
  completedOutput(payload: Json): Json[] {
    const output = get(payload, "response.output");

    if (isJsonArray(output) && output.length > 0) return cloneJson(output);

    return this.collected().filter(
      (item) => !isToolCallType(asString(item["type"])) || isCompleteToolCall(item),
    );
  }

  /** `restoreResponsesWebsocketCompletionOutput` (in place): rebuilds or reconciles `response.output`. */
  restoreCompletionOutput(payload: JsonObject): JsonObject {
    const output = get(payload, "response.output");
    const response = payload["response"];

    if (isJsonArray(output) && output.length > 0) {
      // Reconcile tool calls with the complete items seen while streaming.
      const complete = new Map<string, JsonObject>();

      for (const item of this.collected())
        if (isCompleteToolCall(item)) complete.set(asString(item["call_id"]).trim(), item);

      if (complete.size === 0) return payload;

      for (const [index, item] of output.entries()) {
        if (!isToolCallType(asString(get(item, "type")))) continue;
        const collected = complete.get(asString(get(item, "call_id")).trim());

        if (collected !== undefined && JSON.stringify(collected) !== JSON.stringify(item))
          output[index] = cloneJson(collected);
      }

      return payload;
    }

    if (this.byIndex.size === 0 && this.fallback.length === 0) return payload;

    if (isJsonObject(response)) response["output"] = this.completedOutput(payload);

    return payload;
  }

  /** `recordPendingToolCallIDsFromPayload`. */
  recordPending(payload: JsonObject): void {
    this.updatePending(payload["item"]);
    const output = get(payload, "response.output");

    if (isJsonArray(output)) for (const item of output) this.updatePending(item);
  }

  private updatePending(item: Json | undefined): void {
    switch (asString(get(item, "type")).trim()) {
      case "function_call":
      case "custom_tool_call":
        if (isCompleteToolCall(item)) this.pendingToolCallIds.add(asString(item["call_id"]).trim());
        break;
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = asString(get(item, "call_id")).trim();

        if (callId !== "") this.pendingToolCallIds.delete(callId);
        break;
      }
    }
  }

  pending(): string[] {
    return [...this.pendingToolCallIds]
      .flatMap((id) => {
        const trimmed = id.trim();

        return trimmed === "" ? [] : [trimmed];
      })
      .toSorted();
  }

  /** `completeResponsesWebsocketLocalInterrupt`: the `response.incomplete` that acknowledges a local interrupt. */
  interruptedPayload(responseId: string): JsonObject {
    return {
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "interrupted" },
        id: responseId,
        output: this.completedOutput({ response: { output: [] } }),
      },
    };
  }
}

export const isCompletionEvent = (eventType: string): boolean =>
  eventType === "response.completed" || eventType === "response.done";
