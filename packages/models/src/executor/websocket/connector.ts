/**
 * Outbound (upstream) WebSocket connections for the Codex and xAI Responses transports.
 *
 * Go source: internal/runtime/executor/codex_websockets_connection.go (dialCodexWebsocket, buildCodexResponsesWebsocketURL,
 * codexResponsesWebsocketHandshakeTO), codex_websockets_errors.go (websocketHandshakeBody), xai_websockets_executor.go
 * (dialXAIWebsocket, buildXAIResponsesWebsocketURL).
 *
 * Workers dial WebSockets with `fetch(url, { headers: { Upgrade: "websocket" } })` and read `response.webSocket`
 * (`Sec-WebSocket-Extensions` and TLS settings are not controllable; permessage-deflate is the runtime's business). Every
 * open upstream socket counts towards the 6 simultaneous outbound connections of a Worker invocation, so sockets are only
 * kept open per execution session (one per downstream socket) and ephemeral sockets are closed after each turn.
 *
 * The connector is a service so tests can substitute in-memory sockets; executors read it with `Effect.serviceOption`
 * (defaulting to {@link fetchConnector}), which keeps `ExecutorServices` unchanged.
 */
import { Context, Data, Duration, Effect, Layer, Queue } from "effect";

/** Go `codexResponsesWebsocketHandshakeTO`. */
export const HANDSHAKE_TIMEOUT = Duration.seconds(30);

/** A frame (or lifecycle event) read from an upstream socket. */
export type UpstreamMessage = Data.TaggedEnum<{
  text: { readonly data: string };
  binary: {};
  close: { readonly code: number; readonly reason: string };
  error: { readonly message: string };
}>;

export const UpstreamMessage = Data.taggedEnum<UpstreamMessage>();

/** The upgrade was rejected (`status` > 0, with the response body) or the dial failed (`status` 0). */
export class HandshakeError extends Data.TaggedError("HandshakeError")<{
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly message: string;
}> {}

export class UpstreamSendError extends Data.TaggedError("UpstreamSendError")<{
  readonly message: string;
}> {}

/** One established upstream socket. Text frames only; a binary frame is a protocol violation for the caller. */
export interface UpstreamSocket {
  /** Handshake response headers. */
  readonly headers: Headers;
  readonly send: (text: string) => Effect.Effect<void, UpstreamSendError>;
  /** Frames in arrival order; a `close`/`error` message is the last one. */
  readonly messages: Queue.Dequeue<UpstreamMessage>;
  readonly close: (code?: number, reason?: string) => Effect.Effect<void>;
  readonly isOpen: () => boolean;
  /**
   * Registers a listener for the socket ending (close or error), whenever it happens. The returned function removes it.
   * Used to notice an upstream that drops an idle session socket.
   */
  readonly onEnd: (listener: (message: UpstreamMessage) => void) => () => void;
}

export interface UpstreamConnectRequest {
  /** `ws:`/`wss:` (or `http(s):`) URL. */
  readonly url: string;
  /** Handshake headers (the runtime adds the `Sec-WebSocket-*` ones). */
  readonly headers: Readonly<Record<string, string>>;
}

export class UpstreamWebSocketConnector extends Context.Service<
  UpstreamWebSocketConnector,
  {
    readonly connect: (
      request: UpstreamConnectRequest,
    ) => Effect.Effect<UpstreamSocket, HandshakeError>;
  }
>()("commissary/executor/UpstreamWebSocketConnector") {
  static readonly layerFetch = Layer.succeed(
    UpstreamWebSocketConnector,
    UpstreamWebSocketConnector.of(fetchConnector()),
  );
}

/** Go `buildCodexResponsesWebsocketURL` / `buildXAIResponsesWebsocketURL`: `http` -> `ws`, `https` -> `wss`. */
export const websocketUrl = (httpUrl: string): string => {
  const parsed = new URL(httpUrl.trim());

  switch (parsed.protocol) {
    case "http:":
      parsed.protocol = "ws:";
      break;
    case "https:":
      parsed.protocol = "wss:";
      break;
    case "ws:":
    case "wss:":
      break;
    default:
      throw new Error(
        `unsupported responses websocket URL scheme "${parsed.protocol.replace(/:$/, "")}"`,
      );
  }

  if (parsed.host === "") throw new Error("responses websocket URL host is empty");

  return parsed.toString();
};

const closeReasonOf = (event: { readonly code?: number; readonly reason?: string }) => ({
  code: event.code ?? 1005,
  reason: event.reason ?? "",
});

/**
 * Wraps an accepted Workers `WebSocket`. Messages are queued from the event listeners; text frames keep their order and
 * the terminal `close`/`error` message is delivered once.
 */
export const wrapWebSocket = (ws: WebSocket, headers: Headers): UpstreamSocket => {
  const messages = Effect.runSync(Queue.unbounded<UpstreamMessage>());
  const listeners = new Set<(message: UpstreamMessage) => void>();
  let open = true;
  let ended = false;

  const end = (message: UpstreamMessage) => {
    if (ended) return;
    ended = true;
    open = false;
    Queue.offerUnsafe(messages, message);

    for (const listener of listeners) listener(message);
  };

  ws.addEventListener("message", (event) => {
    const data = event.data;
    Queue.offerUnsafe(
      messages,
      typeof data === "string" ? UpstreamMessage.text({ data }) : UpstreamMessage.binary(),
    );
  });
  ws.addEventListener("close", (event) => end(UpstreamMessage.close(closeReasonOf(event))));
  ws.addEventListener("error", () => end(UpstreamMessage.error({ message: "websocket error" })));

  return {
    headers,
    send: (text) =>
      Effect.try({
        try: () => {
          if (!open) throw new Error("websocket is closed");
          ws.send(text);
        },
        catch: (error) =>
          new UpstreamSendError({
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
    messages,
    close: (code, reason) =>
      Effect.sync(() => {
        const wasOpen = open;
        open = false;

        if (!wasOpen) return;

        try {
          // 1005/1006 cannot be sent; default to a normal closure.
          ws.close(code ?? 1000, reason === undefined ? undefined : reason.slice(0, 120));
        } catch {
          // Already closing.
        }
      }),
    isOpen: () => open,
    onEnd: (listener) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
  };
};

/** The default connector: `fetch` with `Upgrade: websocket`. */
export function fetchConnector(): typeof UpstreamWebSocketConnector.Service {
  return {
    connect: (request) =>
      Effect.tryPromise({
        try: async () => {
          const url = request.url.replace(/^ws(s?):/i, "http$1:");

          // Checked by the outbound guard before dialling (`session.ts`); a redirect is not followed to an unchecked hop.
          const response = await fetch(url, {
            headers: { ...request.headers, upgrade: "websocket" },
            redirect: "manual",
          });

          const ws = response.webSocket;

          if (ws === undefined || ws === null) {
            const body = await response.text().catch(() => "");
            const headers: Record<string, string> = {};
            response.headers.forEach((value, name) => {
              headers[name] = value;
            });
            throw new HandshakeError({
              status: response.status,
              body,
              headers,
              message: `websocket upgrade rejected: ${response.status}`,
            });
          }

          ws.accept();

          return wrapWebSocket(ws, new Headers(response.headers));
        },
        catch: (cause) =>
          cause instanceof HandshakeError
            ? cause
            : new HandshakeError({
                status: 0,
                body: "",
                headers: {},
                message: cause instanceof Error ? cause.message : "websocket dial failed",
              }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: HANDSHAKE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new HandshakeError({
                status: 0,
                body: "",
                headers: {},
                message: "websocket handshake timed out",
              }),
            ),
        }),
      ),
  };
}
