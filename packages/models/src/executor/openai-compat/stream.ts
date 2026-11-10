/**
 * OpenAI-compatible upstream SSE reader: frame assembly, error detection and per-frame translation.
 *
 * Go source: internal/runtime/executor/openai_compat_executor.go (ExecuteStream scan loop and processFrame,
 * openAICompatErrorEvent, openAICompatStreamDataError). Pure state machine: feed upstream lines with `push`, call
 * `end` at EOF; every step reports the client chunks to emit, an optional terminal error and whether to stop reading.
 */
import { asInt, get, type Json, tryParseJson } from "@commissary/json";
import { Formats, type Format } from "@commissary/translation/formats";
import type { ResponseContext, TranslatorRegistry } from "@commissary/translation";
import { ErrorCode } from "../../credentials/cooldown/classify.ts";
import { chunkHasFinishReason } from "../../handlers/framing.ts";
import { ExecutionError } from "../errors.ts";

/** Go `helps.ApplyPatchUpstreamErrorMessage` (retained tool-input translation failure). */
export const TOOL_INPUT_ERROR_MESSAGE =
  "Invalid apply_patch tool arguments received from upstream.";

export interface StreamStep {
  readonly chunks: ReadonlyArray<string>;
  readonly error?: ExecutionError;
  /** Whether the error carries a raw upstream error payload (logged/recorded without the body). */
  readonly payloadError?: boolean;
  /** Stop reading the upstream (terminal `[DONE]` or failure). */
  readonly stop: boolean;
}

const NONE: StreamStep = { chunks: [], stop: false };

export const isOpenAICompatErrorEvent = (event: string): boolean => {
  const lower = event.toLowerCase();

  return lower === "error" || lower === "response.error" || lower === "response.failed";
};

const STATUS_PATHS = [
  "status",
  "status_code",
  "error.status",
  "error.status_code",
  "response.error.status",
  "response.error.status_code",
] as const;

/** `openAICompatStreamDataError`: a data payload that reports an upstream error. */
export const openAICompatStreamDataError = (
  payload: string,
  event: string,
): ExecutionError | undefined => {
  if (payload === "") return undefined;
  const parsed: Json | undefined = tryParseJson(payload);

  if (parsed === undefined) return undefined;
  const type = get(parsed, "type");
  const typeLower = typeof type === "string" ? type.toLowerCase() : "";

  const hasError = ["error", "response.error"].some((path) => {
    const node = get(parsed, path);

    return node !== undefined && node !== null;
  });

  const hasTopLevelErrorFields =
    get(parsed, "code") !== undefined && get(parsed, "message") !== undefined;

  if (
    !hasError &&
    typeLower !== "error" &&
    typeLower !== "response.error" &&
    typeLower !== "response.failed" &&
    !isOpenAICompatErrorEvent(event) &&
    !hasTopLevelErrorFields
  ) {
    return undefined;
  }

  let status = 0;

  for (const path of STATUS_PATHS) {
    status = asInt(get(parsed, path));

    if (status >= 400 && status <= 599) break;
  }

  if (status < 400 || status > 599) status = 502;

  return new ExecutionError({ status, message: payload });
};

const gatewayError = (message: string) => new ExecutionError({ status: 502, message });

export interface OpenAICompatStreamOptions {
  readonly registry: TranslatorRegistry;
  /** Client protocol of the response. */
  readonly responseFormat: Format;
  /** Provider format of the upstream (`openai`). */
  readonly providerFormat: Format;
  readonly context: ResponseContext;
  /** Called with each complete, valid upstream data frame before translation (TTFT token-event observation). */
  readonly onFrame?: (payload: string) => void;
}

export class OpenAICompatStreamReader {
  #event = "";
  #data: string[] = [];
  #seenDone = false;
  #sawFinishReason = false;
  #failed = false;

  constructor(readonly options: OpenAICompatStreamOptions) {}

  get finished(): boolean {
    return this.#seenDone || this.#failed;
  }

  #fail(
    error: ExecutionError,
    chunks: ReadonlyArray<string> = [],
    payloadError = false,
  ): StreamStep {
    this.#failed = true;

    return { chunks, error, payloadError, stop: true };
  }

  #translate(line: string): ReadonlyArray<string> {
    const { registry, responseFormat, providerFormat, context } = this.options;

    return registry.translateStream(responseFormat, providerFormat, context, line);
  }

  #processFrame(): StreamStep {
    const event = this.#event;
    const dataLines = this.#data;
    this.#event = "";
    this.#data = [];

    if (dataLines.length === 0) {
      return isOpenAICompatErrorEvent(event)
        ? this.#fail(gatewayError("upstream error event ended without data"))
        : NONE;
    }

    if (dataLines.length > 1 && dataLines.some((line) => line.trim() === "[DONE]")) {
      return this.#fail(gatewayError("upstream stream ended with incomplete data before [DONE]"));
    }

    const payload = dataLines.join("\n").trim();
    const isDone = payload === "[DONE]";

    if (isDone && isOpenAICompatErrorEvent(event)) {
      return this.#fail(gatewayError("upstream error event ended before [DONE]"));
    }

    if (!isDone) {
      if (tryParseJson(payload) === undefined) {
        return this.#fail(gatewayError("upstream stream ended with incomplete SSE data frame"));
      }

      const dataError = openAICompatStreamDataError(payload, event);

      if (dataError !== undefined) return this.#fail(dataError, [], true);

      // Go `openAICompatChunkHasFinishReason` (4f2e5270).
      if (!this.#sawFinishReason && chunkHasFinishReason(payload)) this.#sawFinishReason = true;
    }

    this.options.onFrame?.(payload);
    const chunks = this.#translate(`data: ${payload}`);

    if (this.options.context.state.toolInputError !== undefined) {
      return this.#fail(gatewayError(TOOL_INPUT_ERROR_MESSAGE), chunks);
    }

    if (isDone) {
      this.#seenDone = true;

      return { chunks, stop: true };
    }

    return { chunks, stop: false };
  }

  /** Feeds one upstream line (without terminator). */
  push(line: string): StreamStep {
    if (this.finished) return { chunks: [], stop: true };
    const trimmed = line.trim();

    if (trimmed === "") return this.#processFrame();

    if (trimmed.startsWith("data:")) {
      this.#data.push(trimmed.slice(5).trim());

      return NONE;
    }

    if (trimmed.startsWith("event:")) {
      this.#event = trimmed.slice(6).trim();

      return NONE;
    }

    if (trimmed.startsWith(":") || trimmed.startsWith("id:") || trimmed.startsWith("retry:"))
      return NONE;

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      // A bare JSON body inside a 200 stream is an upstream error document.
      return this.#fail(gatewayError(trimmed), [], true);
    }

    return NONE;
  }

  /** Clean EOF: flushes a pending frame and synthesises the terminal `[DONE]` translation when allowed. */
  end(): StreamStep {
    const chunks: string[] = [];

    if (!this.finished && this.#data.length > 0) {
      const step = this.#processFrame();
      chunks.push(...step.chunks);

      if (step.error !== undefined) return { ...step, chunks };
    }

    if (this.#failed || this.#seenDone) return { chunks, stop: true };
    const { responseFormat, context } = this.options;

    if (responseFormat === Formats.OpenAIResponse) {
      if (context.state.canFinalize === true) {
        const finals = this.#translate("data: [DONE]");
        chunks.push(...finals);

        if (finals.length > 0) {
          this.#seenDone = true;

          return { chunks, stop: true };
        }
      }

      // Without a translator-confirmed terminal state a Responses stream that ends without [DONE] failed.
      return this.#fail(
        new ExecutionError({
          status: 502,
          message: "upstream stream closed before [DONE]",
          code: ErrorCode.streamTruncated,
        }),
        chunks,
      );
    }

    // A Claude client would otherwise get a clean `message_stop` for a truncated stream (Go 4f2e5270).
    if (responseFormat === Formats.Claude && !this.#sawFinishReason)
      return this.#fail(
        new ExecutionError({
          status: 502,
          message: "upstream stream closed before finish_reason",
          code: ErrorCode.streamTruncated,
        }),
        chunks,
      );

    // Other protocols tolerate providers that omit [DONE].
    chunks.push(...this.#translate("data: [DONE]"));

    if (context.state.toolInputError !== undefined)
      return this.#fail(gatewayError(TOOL_INPUT_ERROR_MESSAGE), chunks);
    this.#seenDone = true;

    return { chunks, stop: true };
  }
}
