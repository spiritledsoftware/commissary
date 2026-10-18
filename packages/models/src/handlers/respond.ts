/**
 * Turning execution results into HTTP responses: error bodies per protocol, JSON bodies and SSE streams with the
 * bootstrap peek (an upstream failure before the first chunk still becomes a real HTTP error).
 *
 * Go source: sdk/api/handlers/handlers_errors.go (WriteErrorResponse, writeDirectErrorResponse),
 * sdk/api/handlers/claude/code_handlers.go (WriteErrorResponse), sdk/api/handlers/openai/openai_handlers.go
 * (handleStreamingResponse: first-chunk peek, SSE headers), sdk/api/handlers/stream_forwarder.go (ForwardStream),
 * sdk/api/handlers/handlers.go (StartNonStreamingKeepAlive).
 */
import { Data, Duration, Effect, Fiber, Pull, Result, type Scope, Stream } from "effect";
import { HttpServerResponse } from "effect/http";
import type { ExecutionError } from "../executor/errors.ts";
import { claudeErrorBody, openAIErrorBody } from "../http/errors.ts";
import {
  filterUpstreamHeaders,
  isCPAReservedResponseHeader,
  mergeUpstreamHeaders,
} from "../http/headers.ts";
import { isValidJson } from "@commissary/json";
import { systemOneErrorBody } from "@commissary/core";
import { parseUpstreamSystemOneError } from "@commissary/translation/systemone";
import { statusText } from "../http/status.ts";
import type { StreamOutput } from "./execute.ts";
import type { StreamFramer } from "./framing.ts";

/** Error body family of an entry protocol (`systemone`: TypeSafe's `detail` shape, ADR 0032). */
export type ErrorProtocol = "openai" | "claude" | "systemone";

export interface ErrorResponseOptions {
  /** `requests.passthrough-headers`: expose upstream error headers. */
  readonly passthroughHeaders: boolean;
}

/** Upstream headers a System One client may always see: TypeSafe's SDKs retry on them (`retry-after(-ms)`). */
const SYSTEM_ONE_RETRY_HEADERS = ["retry-after", "retry-after-ms"];

/**
 * A System One error (no Go counterpart, ADR 0032): every error, an upstream body in any provider's shape or
 * Commissary's own text, becomes TypeSafe's `{"detail":{"error_type","message"}}` with the status kept. The upstream's
 * `Retry-After` of a 429 or an overload (503/529) is passed through so the SDKs' retries work; other upstream headers
 * only with `passthrough-headers`.
 */
const systemOneErrorResponse = (
  error: ExecutionError,
  options: ErrorResponseOptions,
): HttpServerResponse.HttpServerResponse => {
  const status = error.status > 0 ? error.status : 500;
  const headers: Record<string, string> = {};
  const upstream = new Headers(error.headers ?? {});

  if (options.passthroughHeaders) {
    filterUpstreamHeaders(upstream).forEach((value, name) => {
      if (!isCPAReservedResponseHeader(name)) headers[name] = value;
    });
  }

  if (status === 429 || status === 503 || status === 529) {
    for (const name of SYSTEM_ONE_RETRY_HEADERS) {
      const value = upstream.get(name);

      if (value !== null) headers[name] = value;
    }
  }

  const retryAfter = error.safeHeaders?.["retry-after"] ?? error.safeHeaders?.["Retry-After"];

  if (retryAfter !== undefined) headers["retry-after"] ??= retryAfter;
  const parsed = parseUpstreamSystemOneError(status, error.message);
  const message = parsed.message !== "" ? parsed.message : statusText(status);
  headers["content-type"] = "application/json";

  return HttpServerResponse.text(systemOneErrorBody(status, message, parsed.error_type), {
    status,
    headers,
  });
};

/** `WriteErrorResponse` (OpenAI/Gemini/Interactions/Responses), the Claude variant and the System One shape. */
export const errorResponse = (
  protocol: ErrorProtocol,
  error: ExecutionError,
  options: ErrorResponseOptions,
): HttpServerResponse.HttpServerResponse => {
  if (protocol === "systemone") return systemOneErrorResponse(error, options);
  const status = error.status > 0 ? error.status : 500;
  const headers: Record<string, string> = {};

  if (error.direct === true) {
    if (error.headers !== undefined) {
      filterUpstreamHeaders(new Headers(error.headers)).forEach((value, name) => {
        if (!isCPAReservedResponseHeader(name)) headers[name] = value;
      });
    }

    headers["content-type"] ??= isValidJson(error.message)
      ? "application/json"
      : "text/plain; charset=utf-8";

    return HttpServerResponse.text(error.message, { status, headers });
  }

  const retryAfter = error.safeHeaders?.["retry-after"] ?? error.safeHeaders?.["Retry-After"];

  if (retryAfter !== undefined) headers["retry-after"] = retryAfter;

  if (options.passthroughHeaders && error.headers !== undefined) {
    for (const [name, value] of Object.entries(error.headers)) {
      if (!isCPAReservedResponseHeader(name)) headers[name.toLowerCase()] = value;
    }
  }

  const text = error.message.trim() !== "" ? error.message : statusText(status);

  const body =
    protocol === "claude"
      ? claudeErrorBody(status, text)
      : openAIErrorBody(status, text, error.terminalAuth === true ? { terminalAuth: true } : {});

  headers["content-type"] = "application/json";

  return HttpServerResponse.text(body, { status, headers });
};

/** Successful non-stream body; upstream headers are added without overriding Commissary's own. */
export const jsonResponse = (
  payload: string,
  upstream: Headers | undefined,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(payload, {
    headers: mergeUpstreamHeaders({ "content-type": "application/json" }, upstream),
  });

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "access-control-allow-origin": "*",
} as const;

export interface StreamResponseOptions {
  readonly framer: StreamFramer;
  readonly onError: (error: ExecutionError) => HttpServerResponse.HttpServerResponse;
  /** `requests.streaming.keepalive-seconds` (0 disables). */
  readonly keepAliveSeconds: number;
  /** Content type of the stream (Gemini `alt=json` streams are not SSE). */
  readonly contentType?: string;
}

type FirstPull = Data.TaggedEnum<{
  chunk: { readonly chunk: ReadonlyArray<string> };
  done: {};
  error: { readonly error: ExecutionError };
}>;

const FirstPull = Data.taggedEnum<FirstPull>();

/**
 * Runs a stream execution and answers with SSE. Must run inside the request scope: the remaining stream is pulled by
 * the response body, which keeps the scope open until it ends.
 */
export const streamResponse = Effect.fnUntraced(function* <R>(
  start: Effect.Effect<StreamOutput, ExecutionError, R>,
  options: StreamResponseOptions,
) {
  const started = yield* Effect.result(start);

  if (Result.isFailure(started)) return options.onError(started.failure);
  const output = started.success;
  const pull = yield* Stream.toPull(output.chunks);

  const first: FirstPull = yield* pull.pipe(
    Effect.map((chunk): FirstPull => FirstPull.chunk({ chunk })),
    Pull.catchDone(() => Effect.succeed<FirstPull>(FirstPull.done())),
    Effect.catch((error: ExecutionError) => Effect.succeed<FirstPull>(FirstPull.error({ error }))),
  );

  if (FirstPull.$is("error")(first)) return options.onError(first.error);

  const headers = mergeUpstreamHeaders(
    {
      ...SSE_HEADERS,
      ...(options.contentType !== undefined ? { "content-type": options.contentType } : {}),
    },
    output.headers,
  );

  const { framer } = options;

  if (FirstPull.$is("done")(first)) {
    return HttpServerResponse.stream(Stream.make(framer.emptyBody).pipe(Stream.encodeText), {
      headers,
    });
  }

  const rest = Stream.fromPull(Effect.succeed(pull));

  const framed = Stream.concat(Stream.fromIterable(first.chunk), rest).pipe(
    Stream.map(framer.chunk),
    Stream.concat(
      Stream.suspend(() => {
        const closeError = framer.closeError();

        return Stream.make(
          closeError === undefined ? framer.done() : framer.terminalError(closeError),
        );
      }),
    ),
    Stream.catch((error: ExecutionError) => Stream.make(framer.terminalError(error))),
  );

  const keepAlive = framer.keepAlive;

  const withKeepAlive =
    keepAlive !== undefined && options.keepAliveSeconds > 0
      ? Stream.merge(
          framed,
          Stream.tick(Duration.seconds(options.keepAliveSeconds)).pipe(
            Stream.drop(1),
            Stream.map(() => keepAlive),
          ),
          { haltStrategy: "left" },
        )
      : framed;

  const body = withKeepAlive.pipe(
    Stream.filter((text) => text !== ""),
    Stream.encodeText,
  );

  return HttpServerResponse.stream(body, { headers });
});

/**
 * `StartNonStreamingKeepAlive` (`requests.nonstream-keepalive-interval`): while a non-stream execution is pending, a blank
 * line is written every `intervalSeconds` so idle proxies keep the connection open. Like Go, nothing is committed before
 * the first interval elapses: a response that is ready in time keeps its real status and headers. After the first blank
 * line the answer is committed as `200 application/json` (Go has already flushed its headers): the final body, error
 * bodies included, follows the blank lines and upstream headers are dropped. Must run inside the request scope.
 */
export const withNonStreamKeepAlive = <E, R>(
  intervalSeconds: number,
  run: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | Scope.Scope> => {
  if (!(intervalSeconds > 0)) return run;

  return Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(run);
    const interval = Duration.seconds(intervalSeconds);

    const ready = yield* Effect.raceFirst(
      Fiber.join(fiber).pipe(Effect.map((response) => ({ done: true as const, response }))),
      Effect.sleep(interval).pipe(Effect.as({ done: false as const })),
    );

    if (ready.done) return ready.response;
    const blank = new Uint8Array([10]);

    const final = Stream.fromEffect(
      Effect.gen(function* () {
        const response = yield* Fiber.join(fiber);

        // The final body is emitted as one chunk so no blank line can interleave with it.
        return new Uint8Array(
          yield* Effect.promise(() => HttpServerResponse.toWeb(response).arrayBuffer()),
        );
      }),
    );

    const body = Stream.merge(Stream.tick(interval).pipe(Stream.map(() => blank)), final, {
      haltStrategy: "right",
    });

    return HttpServerResponse.stream(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
};
