/**
 * Claude upstream SSE reader: event assembly (Claude -> Claude passthrough), per-line translation for other client
 * formats, tool name / usage / replay observation and completion tracking.
 *
 * Go source: internal/runtime/executor/claude_executor_stream.go (ExecuteStream goroutine, validateClaudeStreamingResponse),
 * claude_executor_diagnostics.go (observeClaudeSSEEvent). Go 4f2e5270: an `error` event or EOF before `message_stop` fails the
 * stream with 502 (usage and cooldown record it).
 */
import { get, tryParseJson } from "@commissary/json";
import { str, type ResponseContext, type TranslatorRegistry } from "@commissary/translation";
import type { Format } from "@commissary/translation/formats";
import { responseModelOf, ssePayloadObject, type UsageDetail } from "../../usage/record.ts";
import { ExecutionError } from "../errors.ts";
import { ensureResponsesUsageDetails } from "../codex/output.ts";
import { AliasRestoreError, restoreToolNamesInStreamLine } from "./mcp-alias.ts";
import { ClaudeEventObserver } from "./sse-events.ts";
import { ReplayStreamAccumulator } from "./thinking-replay.ts";
import { mergeUsage, parseClaudeStreamUsage } from "./usage.ts";

/** Go `helps.ApplyPatchUpstreamErrorMessage` (retained tool-input translation failure). */
export const TOOL_INPUT_ERROR_MESSAGE =
  "Invalid apply_patch tool arguments received from upstream.";

export interface ClaudeStreamStep {
  readonly chunks: ReadonlyArray<string>;
  readonly error?: ExecutionError;
  readonly stop: boolean;
}

export interface ClaudeStreamOptions {
  readonly registry: TranslatorRegistry;
  readonly responseFormat: Format;
  readonly context: ResponseContext;
  readonly reverseMap: ReadonlyMap<string, string>;
  /** Per-line rewrite after tool-name restoring (Kimi restores the requested model name). */
  readonly restoreLine?: (line: string) => string;
  readonly onUsage: (detail: UsageDetail) => void;
  readonly onResponseModel: (model: string | undefined) => void;
}

export class ClaudeStreamReader {
  readonly #event: string[] = [];
  readonly #events = new ClaudeEventObserver();
  readonly accumulator = new ReplayStreamAccumulator();
  #usage: UsageDetail | undefined;
  #done = false;
  messageId = "";

  constructor(readonly options: ClaudeStreamOptions) {}

  get finished(): boolean {
    return this.#done;
  }

  /** A `message_stop` (or a bare completed `message`) arrived. */
  get completed(): boolean {
    return this.#events.completed;
  }

  #observe(line: string): void {
    this.#events.observeLine(line);

    if (this.#events.bareMessageId !== "") this.messageId = this.#events.bareMessageId;
    const payload = ssePayloadObject(line);

    if (payload === undefined) return;

    if (str(get(payload, "type")) === "message_start") {
      const id = str(get(payload, "message.id")).trim();

      if (id !== "") this.messageId = id;
    }

    this.options.onResponseModel(responseModelOf(payload));
    const usage = parseClaudeStreamUsage(line);

    if (usage !== undefined) {
      this.#usage = mergeUsage(this.#usage, usage);
      this.options.onUsage(this.#usage);
    }

    this.accumulator.observe(line);
  }

  /** Go `observeClaudeSSEEvent`: an upstream `error` event becomes a 502 carrying its payload. */
  #streamError(): ExecutionError | undefined {
    const payload = this.#events.errorPayload;

    return payload === undefined
      ? undefined
      : new ExecutionError({ status: 502, message: payload });
  }

  #fail(error: ExecutionError, chunks: ReadonlyArray<string> = []): ClaudeStreamStep {
    this.#done = true;

    return { chunks, error, stop: true };
  }

  /** Feeds one upstream line (without terminator). */
  push(line: string): ClaudeStreamStep {
    if (this.#done) return { chunks: [], stop: true };
    this.#observe(line);
    let restored = line;

    try {
      restored = restoreToolNamesInStreamLine(line, this.options.reverseMap);

      if (this.options.restoreLine !== undefined) restored = this.options.restoreLine(restored);
    } catch (error) {
      if (error instanceof AliasRestoreError) {
        return this.#fail(
          new ExecutionError({
            status: 500,
            message: `restore Claude OAuth tool name from streaming response: ${error.message}`,
            requestScoped: true,
          }),
        );
      }

      throw error;
    }

    const { registry, responseFormat, context } = this.options;
    let chunks: ReadonlyArray<string>;

    if (responseFormat === "claude") {
      this.#event.push(`${restored}\n`);

      if (restored.trim() !== "") return { chunks: [], stop: false };
      chunks = [this.#event.join("")];
      this.#event.length = 0;
    } else {
      const translated = registry.translateStream(responseFormat, "claude", context, restored);

      if (context.state.toolInputError !== undefined) {
        return this.#fail(
          new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE }),
          translated,
        );
      }

      // Go `EnsureResponsesUsageDetails` on every translated Responses chunk.
      chunks =
        responseFormat === "openai-response"
          ? translated.map((chunk) => ensureResponsesUsageDetails(chunk))
          : translated;
    }

    const error = this.#streamError();

    if (error !== undefined && !this.completed) return this.#fail(error, chunks);

    if (this.completed && (responseFormat !== "claude" || restored.trim() === ""))
      this.#done = true;

    return { chunks, stop: this.completed };
  }

  /** EOF: flushes a pending passthrough event, then fails a stream that ended without `message_stop`. */
  end(): ClaudeStreamStep {
    const chunks: string[] = [];
    this.#events.flush();

    if (this.#event.length > 0 && !this.#done) {
      chunks.push(this.#event.join(""));
      this.#event.length = 0;
    }

    if (this.options.responseFormat !== "claude") {
      // Go `EndApplyPatchStream`: a patch-enabled stream that ends before its terminator fails with the failure frame.
      const { state } = this.options.context;

      if (state.toolInputError === undefined && state.finalizeToolInput !== undefined) {
        chunks.push(...state.finalizeToolInput());
      }

      if (state.toolInputError !== undefined) {
        return this.#fail(
          new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE }),
          chunks,
        );
      }
    }

    if (!this.completed) {
      return this.#fail(
        this.#streamError() ??
          new ExecutionError({
            status: 502,
            message: "upstream stream closed before message_stop",
          }),
        chunks,
      );
    }

    this.#done = true;

    return { chunks, stop: true };
  }
}

/**
 * `validateClaudeStreamingResponse`: a fully buffered SSE body must hold data, a `message_start` with id and model, a
 * `message_delta` and no `error` event. Returns the failure message.
 */
export const validateClaudeStreamingResponse = (data: string): string | undefined => {
  let hasData = false;
  let hasMessageStart = false;
  let hasMessageDelta = false;

  for (const raw of data.split("\n")) {
    const line = raw.trim();

    if (line === "" || !line.startsWith("data:")) continue;
    const payloadText = line.slice(5).trim();

    if (payloadText === "" || payloadText === "[DONE]") continue;
    hasData = true;
    const payload = tryParseJson(payloadText);

    if (payload === undefined) return "claude executor: upstream returned malformed stream data";

    switch (str(get(payload, "type"))) {
      case "error": {
        const message =
          str(get(payload, "error.message")).trim() ||
          str(get(payload, "error.type")).trim() ||
          "unknown upstream error";

        return `claude executor: upstream returned error event: ${message}`;
      }

      case "message_start":
        if (
          str(get(payload, "message.id")).trim() === "" ||
          str(get(payload, "message.model")).trim() === ""
        ) {
          return "claude executor: upstream stream message_start is missing id or model";
        }

        hasMessageStart = true;
        break;
      case "message_delta":
        hasMessageDelta = true;
    }
  }

  if (!hasData) return "claude executor: upstream returned empty stream response";

  if (!hasMessageStart) return "claude executor: upstream stream response is missing message_start";

  if (!hasMessageDelta)
    return "claude executor: upstream stream response ended before message completion";

  return undefined;
};
