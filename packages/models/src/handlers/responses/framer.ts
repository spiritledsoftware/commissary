/**
 * Responses SSE frame assembler (downstream framing for `/v1/responses`).
 *
 * Go source: sdk/api/handlers/openai/openai_responses_handlers.go (responsesSSEFramer and its helpers,
 * responsesStreamErrorText, sanitizeResponsesStreamErrorMessage, isCodexResponsesClientRequest). Executor chunks may
 * be single lines or partial frames: they are buffered into complete frames; private events (`responsesapi.*`,
 * `codex.*`, and `response.metadata` for non-Codex clients) are filtered; JSON split across chunk boundaries is
 * recovered and field names split mid-token are held back (ae65e26d); error payloads become one normalised `error`/`response.failed` frame; an empty
 * `response.output` of the final `response.completed` is rebuilt from the `response.output_item.done` items; nothing
 * is written after a terminal event. The stream ends with a bare newline and no `[DONE]`.
 */
import { ExecutionError } from "../../executor/errors.ts";
import { responsesStreamErrorChunk, responsesStreamFailedChunk } from "../../http/errors.ts";
import { SSE_KEEP_ALIVE } from "@commissary/translation/sse";
import { statusText } from "../../http/status.ts";
import {
  asInt,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  set,
  tryParseJson,
} from "@commissary/json";
import type { StreamFramer } from "../framing.ts";

const ERROR_EVENTS = new Set(["response.failed", "response.error", "error"]);

const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.done",
  "response.error",
  "error",
]);

const ERROR_MESSAGE_LIMIT = 2048;

const ERROR_FIELD_LIMIT = 256;

const SENSITIVE_VALUE =
  /((?:"?(?:api[_-]?key|access[_-]?token|token|authorization|secret)"?)\s*[=:]\s*"?)([^\s"&,;}]+)/gi;

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

const truncate = (text: string, limit: number): string => {
  const characters = Array.from(text);

  return characters.length <= limit ? text : `${characters.slice(0, limit).join("")}…`;
};

const redact = (text: string): string =>
  text.replace(SENSITIVE_VALUE, "$1[REDACTED]").replace(BEARER, "Bearer [REDACTED]");

const sanitizeEventName = (name: string): string =>
  truncate(redact(name.trim()), ERROR_FIELD_LIMIT);

const isSensitiveKey = (key: string): boolean => {
  const k = key.trim().toLowerCase().replaceAll("-", "_");

  if (
    k.includes("tokens") ||
    k.includes("token_count") ||
    k.includes("token_limit") ||
    k.includes("token_usage")
  ) {
    return false;
  }

  if (
    [
      "authorization",
      "secret",
      "password",
      "passwd",
      "api_key",
      "apikey",
      "token",
      "access_token",
      "refresh_token",
      "id_token",
      "auth_token",
      "session_token",
      "api_token",
      "client_secret",
      "client_key",
    ].includes(k)
  ) {
    return true;
  }

  return (
    k.endsWith("_secret") ||
    k.endsWith("_password") ||
    k.endsWith("_api_key") ||
    k.endsWith("_token")
  );
};

const sanitizeNode = (value: Json): Json => {
  if (typeof value === "string") return truncate(redact(value), ERROR_MESSAGE_LIMIT);

  if (isJsonArray(value)) return value.map(sanitizeNode);

  if (isJsonObject(value)) {
    const out: Record<string, Json> = {};

    for (const [key, item] of Object.entries(value))
      out[key] = isSensitiveKey(key) ? "[REDACTED]" : sanitizeNode(item);

    return out;
  }

  return value;
};

/** `responsesStreamErrorText`: redacted/truncated error text; JSON bodies keep only their (sanitised) `error`. */
export const responsesStreamErrorText = (text: string, status: number): string => {
  const trimmed = (text.trim() !== "" ? text : statusText(status)).trim();
  const root = tryParseJson(trimmed);

  if (root === undefined) return truncate(redact(trimmed), ERROR_MESSAGE_LIMIT);

  if (isJsonObject(root)) {
    let errorNode = root["error"];

    if (!isJsonObject(errorNode)) {
      const response = root["response"];
      errorNode = isJsonObject(response) ? response["error"] : undefined;
    }

    if (isJsonObject(errorNode)) {
      const sequenceNumber = root["sequence_number"];

      const out = {
        error: sanitizeNode(errorNode),
        ...(sequenceNumber === undefined ? {} : { sequence_number: sequenceNumber }),
      };

      return JSON.stringify(out);
    }
  }

  return JSON.stringify(sanitizeNode(root));
};

/** `isCodexResponsesClientRequest`: official Codex clients get `response.failed` as the failure event. */
export const isCodexResponsesClient = (headers: Headers): boolean => {
  const userAgent = (headers.get("user-agent") ?? "").trim();

  if (
    userAgent.startsWith("Codex Desktop/") ||
    userAgent.startsWith("codex-tui/") ||
    userAgent === "codex_cli_rs" ||
    userAgent.startsWith("codex_cli_rs/") ||
    userAgent.startsWith("codex_exec/")
  ) {
    return true;
  }

  const originator = (headers.get("originator") ?? "").trim().toLowerCase();

  return (
    ["codex desktop", "codex-tui", "codex_cli_rs"].includes(originator) ||
    ["codex desktop/", "codex-tui/", "codex_cli_rs/"].some((prefix) =>
      originator.startsWith(prefix),
    )
  );
};

const frameLength = (chunk: string): number => {
  if (chunk === "") return 0;
  const lf = chunk.indexOf("\n\n");
  const crlf = chunk.indexOf("\r\n\r\n");

  if (lf < 0) return crlf < 0 ? 0 : crlf + 4;

  if (crlf < 0) return lf + 2;

  return lf < crlf ? lf + 2 : crlf + 4;
};

const hasField = (chunk: string, prefix: string): boolean =>
  chunk.split("\n").some((line) => line.trim().startsWith(prefix));

const dataPayload = (frame: string): string | undefined => {
  const parts: string[] = [];

  for (const line of frame.split("\n")) {
    const trimmed = line.replace(/\r+$/, "").trim();

    if (trimmed.startsWith("data:")) parts.push(trimmed.slice(5).trim());
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
};

const eventName = (frame: string): string => {
  for (const line of frame.split("\n")) {
    const trimmed = line.replace(/\r+$/, "").trim();

    if (trimmed.startsWith("event:")) return trimmed.slice(6).trim();
  }

  return "";
};

const dataLinesValid = (chunk: string): boolean => {
  const payload = dataPayload(chunk);

  if (payload === undefined) return true;
  const trimmed = payload.trim();

  return trimmed === "" || trimmed === "[DONE]" || tryParseJson(trimmed) !== undefined;
};

const needsMoreData = (chunk: string): boolean => {
  const trimmed = chunk.trim();

  return trimmed !== "" && hasField(trimmed, "event:") && !hasField(trimmed, "data:");
};

const canEmitWithoutDelimiter = (chunk: string): boolean => {
  const trimmed = chunk.trim();

  if (
    trimmed === "" ||
    needsMoreData(trimmed) ||
    !hasField(trimmed, "event:") ||
    !hasField(trimmed, "data:")
  ) {
    return false;
  }

  return dataLinesValid(trimmed);
};

const canFlushWithoutDelimiter = (chunk: string): boolean => {
  const trimmed = chunk.trim();

  return trimmed !== "" && hasField(trimmed, "data:") && dataLinesValid(trimmed);
};

const startsNewDataFrame = (pending: string, chunk: string): boolean => {
  const trimmed = pending.trim();

  if (
    trimmed === "" ||
    hasField(trimmed, "event:") ||
    !hasField(trimmed, "data:") ||
    !dataLinesValid(trimmed)
  ) {
    return false;
  }

  return chunk.replace(/^[ \t\r\n]+/, "").startsWith("data:");
};

const needsLineBreak = (pending: string, chunk: string): boolean => {
  if (pending === "" || chunk === "") return false;

  if (pending.endsWith("\n") || pending.endsWith("\r")) return false;

  if (chunk[0] === "\n" || chunk[0] === "\r") return false;
  const trimmed = chunk.replace(/^[ \t]+/, "");

  if (trimmed === "") return false;

  return (
    ["data:", "event:", "id:", "retry:", ":"].some((prefix) => trimmed.startsWith(prefix)) &&
    !dataEndsInsideJsonString(pending)
  );
};

/**
 * `responsesSSEDataEndsInsideJSONString`: a chunk boundary inside a JSON string is not a line break, even when the next
 * chunk starts with something that looks like an SSE field.
 */
const dataEndsInsideJsonString = (chunk: string): boolean => {
  const payload = dataPayload(chunk)?.trim();

  if (payload === undefined || payload === "" || !'{["'.includes(payload.charAt(0))) return false;
  let inString = false;
  let escaped = false;

  for (const char of payload) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString && char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') inString = !inString;
  }

  return inString;
};

/** `responsesSSEChunkField`: the field name a chunk starts with; `partial` while the name is still incomplete. */
interface ChunkField {
  readonly name: string;
  readonly complete: boolean;
  readonly partial: boolean;
}

const chunkField = (chunk: string): ChunkField => {
  if (chunk === "") return { name: "", complete: false, partial: false };

  for (let i = 0; i < chunk.length; i++) {
    const char = chunk.charAt(i);

    if (char === ":" || char === "\n" || char === "\r")
      return { name: chunk.slice(0, i), complete: true, partial: false };

    if (!/[A-Za-z0-9\-_.]/.test(char)) return { name: "", complete: false, partial: false };
  }

  return { name: "", complete: false, partial: true };
};

/** `responsesSSEHasEmptyEventData`: an `event:` with an empty `data:` so far; the payload may still be arriving. */
const hasEmptyEventData = (chunk: string): boolean => {
  if (!hasField(chunk, "event:")) return false;
  const payload = dataPayload(chunk);

  return payload !== undefined && payload.trim() === "";
};

const trimLeftBlank = (text: string): string => text.replace(/^[ \t\r\n]+/, "");

const lastLine = (text: string): string => text.slice(text.lastIndexOf("\n") + 1).trim();

const isValidJson = (text: string): boolean => tryParseJson(text) !== undefined;

/** gjson reads `type` even from a truncated object; the filter must not let a malformed private frame through. */
const lenientPayloadType = (payload: string): string =>
  /^\s*\{[^]*?"type"\s*:\s*"([^"\\]*)"/.exec(payload)?.[1] ?? "";

/** `writeResponsesSSEChunk`'s trailing separator. */
const terminate = (frame: string): string => {
  if (frame === "" || frame.endsWith("\n\n") || frame.endsWith("\r\n\r\n")) return frame;

  if (frame.endsWith("\r\n")) return `${frame}\r\n`;

  return frame.endsWith("\n") ? `${frame}\n` : `${frame}\n\n`;
};

const payloadHasError = (payload: Json): boolean => {
  for (const path of ["error", "response.error"]) {
    const value = get(payload, path);

    if (value !== undefined && value !== null) return true;
  }

  return get(payload, "code") !== undefined && get(payload, "message") !== undefined;
};

const payloadErrorStatus = (payload: Json): number => {
  for (const path of [
    "status",
    "status_code",
    "error.status",
    "error.status_code",
    "response.error.status",
    "response.error.status_code",
  ]) {
    const candidate = asInt(get(payload, path));

    if (candidate >= 400 && candidate <= 599) return candidate;
  }

  return 502;
};

export interface ResponsesFramerOptions {
  readonly codexClient: boolean;
}

/** Responses stream framer; stateful, one per request. */
export const responsesFramer = (options: ResponsesFramerOptions): StreamFramer => {
  let pending = "";
  // Held back while a chunk boundary may split an SSE field name (`data` | `: {...}`) after an empty `event:` frame.
  let nextFramePrefix = "";
  let nextFieldSuffix = "";
  // Offsets in `pending` of the newlines this framer inserted at chunk boundaries; recovery removes them again.
  let syntheticBreaks: number[] = [];
  const outputItems = new Map<number, string>();
  const outputOrder: number[] = [];
  const unindexed: string[] = [];
  let lastEvent = "";
  let terminalEvent = "";
  let dataFrames = 0;
  // `closeError` runs before `done`/`terminalError`; frames it flushes are delivered with the next write.
  let pendingFlush = "";

  const shouldFilterPrivateEvent = (streamEvent: string, payloadType: string): boolean => {
    const check = (raw: string): boolean => {
      const name = raw.trim();

      if (name === "" || ERROR_EVENTS.has(name)) return false;

      if (name.startsWith("responsesapi.")) return true;

      if (options.codexClient) return name === "codex.rate_limits";

      // `response.metadata` carries the Codex backend's prompt-moderation flags: not a public Responses event, and
      // clients that parse a closed event list fail the turn on it. Codex clients still receive it.
      return name.startsWith("codex.") || name === "response.metadata";
    };

    return check(streamEvent) || check(payloadType);
  };

  const repairErrorPayload = (payload: Json): string => {
    const status = payloadErrorStatus(payload);
    const text = responsesStreamErrorText(JSON.stringify(payload), status);
    const failureEvent = options.codexClient ? "response.failed" : "error";
    terminalEvent = failureEvent;
    let seq = 0;
    const payloadSeq = get(payload, "sequence_number");
    const textSeq = get(tryParseJson(text), "sequence_number");

    if (payloadSeq !== undefined) seq = asInt(payloadSeq);
    else if (textSeq !== undefined) seq = asInt(textSeq);
    else if (dataFrames > 0) seq = dataFrames - 1;

    return failureEvent === "response.failed"
      ? `event: response.failed\ndata: ${responsesStreamFailedChunk(status, text, seq)}\n\n`
      : `event: error\ndata: ${responsesStreamErrorChunk(status, text, seq)}\n\n`;
  };

  const recordOutputItem = (payload: Json): void => {
    const item = get(payload, "item");

    if (!isJsonObject(item) || asString(item["type"]) === "") return;
    const outputIndex = get(payload, "output_index");

    if (outputIndex !== undefined) {
      const index = asInt(outputIndex);

      if (!outputItems.has(index)) outputOrder.push(index);
      outputItems.set(index, JSON.stringify(item));

      return;
    }

    unindexed.push(JSON.stringify(item));
  };

  /** Rebuilds an empty `response.output` from the recorded items. */
  const repairCompleted = (payload: Json): Json | undefined => {
    if (outputOrder.length === 0 && unindexed.length === 0) return undefined;
    const output = get(payload, "response.output");

    if (output !== undefined && (!isJsonArray(output) || output.length > 0)) return undefined;

    const items = [
      ...outputOrder.toSorted((a, b) => a - b).map((index) => outputItems.get(index) ?? ""),
      ...unindexed,
    ].flatMap((item) => {
      if (item === "") return [];
      const parsed: Json = JSON.parse(item);

      return [parsed];
    });

    return set(payload, "response.output", items);
  };

  const frameWithData = (frame: string, payload: string): string => {
    let out = "";

    for (const line of frame.split("\n")) {
      const clean = line.replace(/\r+$/, "");
      const trimmed = clean.trim();

      if (trimmed === "" || trimmed.startsWith("data:")) continue;
      out += `${clean}\n`;
    }

    for (const line of payload.split("\n")) out += `data: ${line}\n`;

    return `${out}\n`;
  };

  const repairFrame = (frame: string): string => {
    const payloadText = dataPayload(frame);
    const streamEvent = eventName(frame);

    if (streamEvent !== "" && shouldFilterPrivateEvent(streamEvent, "")) return "";

    if (payloadText === undefined || payloadText === "") return frame;

    if (payloadText === "[DONE]") {
      dataFrames++;

      return frame;
    }

    const payload = tryParseJson(payloadText);

    if (payload === undefined)
      return shouldFilterPrivateEvent(streamEvent, lenientPayloadType(payloadText)) ? "" : frame;
    const payloadType = asString(get(payload, "type"));

    if (shouldFilterPrivateEvent(streamEvent, payloadType)) return "";
    dataFrames++;

    if (ERROR_EVENTS.has(payloadType) || payloadHasError(payload)) {
      if (payloadType !== "") lastEvent = sanitizeEventName(payloadType);

      return repairErrorPayload(payload);
    }

    let eventType = payloadType;

    if (TERMINAL_EVENTS.has(streamEvent)) eventType = streamEvent;
    else if (eventType === "") eventType = streamEvent;

    if (eventType !== "") lastEvent = sanitizeEventName(eventType);

    if (ERROR_EVENTS.has(eventType)) return repairErrorPayload(payload);

    if (TERMINAL_EVENTS.has(eventType)) terminalEvent = eventType;

    if (eventType === "response.output_item.done") recordOutputItem(payload);
    else if (eventType === "response.completed") {
      const repaired = repairCompleted(payload);

      if (repaired !== undefined) return frameWithData(frame, JSON.stringify(repaired));
    }

    return frame;
  };

  /** `responsesSSERecoverJSONFrame`: undo chunk-boundary newlines that split a JSON payload across `data:` lines. */
  const recoverJsonFrame = (frame: string): string => {
    if (syntheticBreaks.length === 0) return frame;
    const payload = dataPayload(frame);

    if (payload !== undefined && isValidJson(payload)) return frame;

    const positions = syntheticBreaks.filter(
      (pos) => pos >= 0 && pos < frame.length && frame[pos] === "\n",
    );

    const attempt = (candidate: string): string | undefined => {
      const recovered = dataPayload(candidate);

      return recovered !== undefined && isValidJson(recovered)
        ? frameWithData(candidate, recovered)
        : undefined;
    };

    for (const pos of positions.slice(0, 8)) {
      const recovered = attempt(frame.slice(0, pos) + frame.slice(pos + 1));

      if (recovered !== undefined) return recovered;
    }

    if (positions.length > 1) {
      let candidate = "";
      let start = 0;

      for (const pos of positions) {
        candidate += frame.slice(start, pos);
        start = pos + 1;
      }

      const recovered = attempt(candidate + frame.slice(start));

      if (recovered !== undefined) return recovered;
    }

    return frame;
  };

  const consumeBreaks = (consumed: number): void => {
    syntheticBreaks = syntheticBreaks.filter((pos) => pos >= consumed).map((pos) => pos - consumed);
  };

  const appendChunk = (chunk: string): void => {
    if (needsLineBreak(pending, chunk)) {
      syntheticBreaks.push(pending.length);
      pending += "\n";
    }

    pending += chunk;
  };

  const resetPending = (): void => {
    pending = "";
    syntheticBreaks = [];
  };

  const writeFrame = (frame: string): string => terminate(repairFrame(recoverJsonFrame(frame)));

  const flush = (): string => {
    let out = "";

    if (nextFieldSuffix !== "") {
      if (needsLineBreak(nextFramePrefix, nextFieldSuffix)) nextFramePrefix += "\n";
      nextFramePrefix += nextFieldSuffix;
      nextFieldSuffix = "";
    }

    if (nextFramePrefix !== "") {
      const trimmed = trimLeftBlank(nextFramePrefix);

      if (chunkField(trimmed).partial && !"data".startsWith(trimmed)) {
        out += writeFrame(pending);
        resetPending();
      }

      appendChunk(nextFramePrefix);
      nextFramePrefix = "";
    }

    if (pending === "" || terminalEvent !== "") return out;

    if (pending.trim() === "") {
      resetPending();

      return out;
    }

    const frame = recoverJsonFrame(pending);

    if (!canFlushWithoutDelimiter(frame)) {
      resetPending();

      return out;
    }

    const written = writeFrame(frame);
    resetPending();

    return out + written;
  };

  return {
    chunk: (input) => {
      if (input === "" || terminalEvent !== "") return "";
      let chunk = input;
      let out = "";

      if (nextFieldSuffix !== "") {
        const trimmed = trimLeftBlank(chunk);
        const tail = lastLine(nextFramePrefix);

        if (chunkField(trimmed).complete && tail !== "" && !tail.startsWith("data:")) {
          nextFramePrefix += nextFieldSuffix;
          nextFieldSuffix = "";
        } else {
          nextFieldSuffix += chunk;

          if (chunkField(trimLeftBlank(nextFieldSuffix)).partial) return "";
          chunk = nextFieldSuffix;
          nextFieldSuffix = "";
        }
      }

      if (nextFramePrefix !== "") {
        const payload = dataPayload(nextFramePrefix);
        const parsed = payload === undefined ? undefined : tryParseJson(payload);

        if (
          parsed !== undefined &&
          asString(get(parsed, "type")) === "" &&
          !hasField(nextFramePrefix, "event:") &&
          frameLength(nextFramePrefix) === 0
        ) {
          const trimmed = trimLeftBlank(chunk);
          const field = chunkField(trimmed);
          const tail = lastLine(nextFramePrefix);
          let complete = field.complete;

          if (complete && chunkField(tail).partial) {
            const joined = chunkField(tail + trimmed);
            const known = ["event", "data", "id", "retry"];

            if (
              joined.complete &&
              (known.includes(joined.name) || (field.name !== "" && !known.includes(field.name)))
            )
              complete = false;
          }

          const newFieldPrefix =
            tail.startsWith("data:") ||
            ["event:", "data:", "id:", "retry:"].some(
              (prefix) => trimmed.length < prefix.length && prefix.startsWith(trimmed),
            );

          if (field.partial && newFieldPrefix) {
            nextFieldSuffix += chunk;

            return "";
          }

          if (
            complete &&
            !nextFramePrefix.endsWith("\n") &&
            !nextFramePrefix.endsWith("\r") &&
            chunk[0] !== "\n" &&
            chunk[0] !== "\r"
          )
            nextFramePrefix += "\n";
        }

        chunk = nextFramePrefix + chunk;
        nextFramePrefix = "";
      }

      if (hasEmptyEventData(pending)) {
        const trimmed = trimLeftBlank(chunk);
        const field = chunkField(trimmed);

        if (field.partial) {
          nextFramePrefix += chunk;

          return "";
        }

        let newFrame = field.complete && field.name !== "data";

        if (field.complete && field.name === "data") {
          const payload = dataPayload(trimmed) ?? "";
          const valid = isValidJson(payload);
          const complete = frameLength(trimmed) !== 0;

          if (!valid && payload !== "[DONE]" && !complete) {
            nextFramePrefix += chunk;

            return "";
          }

          const hasEvent = hasField(trimmed, "event:");

          if (valid && hasEvent && eventName(trimmed) === "" && !complete) {
            nextFramePrefix += chunk;

            return "";
          }

          newFrame =
            payload === "[DONE]" ||
            (valid && (asString(get(tryParseJson(payload), "type")) !== "" || hasEvent));

          if (valid && !newFrame && !complete) {
            nextFramePrefix += chunk;

            return "";
          }
        }

        if (newFrame) {
          out += writeFrame(pending);
          resetPending();

          if (terminalEvent !== "") return out;
        }
      }

      if (startsNewDataFrame(pending, chunk)) {
        out += writeFrame(pending);
        resetPending();

        if (terminalEvent !== "") return out;
      }

      appendChunk(chunk);

      for (;;) {
        const length = frameLength(pending);

        if (length === 0) break;
        const frame = pending.slice(0, length);
        out += writeFrame(frame);
        pending = pending.slice(length);
        consumeBreaks(length);

        if (terminalEvent !== "") {
          resetPending();

          return out;
        }
      }

      if (pending.trim() === "") {
        resetPending();

        return out;
      }

      if (hasEmptyEventData(pending) || !canEmitWithoutDelimiter(pending)) return out;
      const frame = pending;
      const written = writeFrame(frame);
      resetPending();

      return out + written;
    },
    terminalError: (error) => {
      let out = pendingFlush + flush();
      pendingFlush = "";

      if (terminalEvent !== "") return out;
      const status = error.status > 0 ? error.status : 500;
      const text = responsesStreamErrorText(error.message, status);
      const seq = get(tryParseJson(text), "sequence_number");
      const sequence = seq !== undefined ? asInt(seq) : dataFrames;
      out += options.codexClient
        ? `event: response.failed\ndata: ${responsesStreamFailedChunk(status, text, sequence)}\n\n`
        : `event: error\ndata: ${responsesStreamErrorChunk(status, text, sequence)}\n\n`;
      terminalEvent = options.codexClient ? "response.failed" : "error";

      return out;
    },
    closeError: () => {
      const flushed = flush();

      if (flushed !== "") pendingFlush += flushed;

      if (terminalEvent !== "") return undefined;

      return new ExecutionError({
        status: 502,
        message:
          dataFrames === 0
            ? "upstream stream closed before first payload"
            : `upstream stream closed before a terminal event (last event: ${lastEvent === "" ? "none" : lastEvent})`,
      });
    },
    done: () => {
      const out = pendingFlush + flush();
      pendingFlush = "";

      return `${out}\n`;
    },
    emptyBody: "\n",
    keepAlive: SSE_KEEP_ALIVE,
  };
};
