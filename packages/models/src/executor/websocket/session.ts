/**
 * Upstream execution sessions: one retained socket per downstream Responses socket, with request locking, idle read
 * deadlines, a transparent redial on send failure and ephemeral sockets for requests without a session.
 *
 * Go source: internal/runtime/executor/codex_websockets_session.go (codexWebsocketSession, ensureUpstreamConn,
 * invalidateUpstreamConn, existingWebsocketSessionConn, detachMismatchedWebsocketSessionConn, CloseExecutionSession,
 * InterruptExecutionSession), codex_websockets_execute.go / codex_websockets_stream.go (send retry, read loop),
 * codex_websockets_errors.go (mapCodexWebsocketReadError), codex_websockets_connection.go (idle timeout).
 *
 * Upstream socket loss (CLIProxyAPI f73e66ac, sdk/cliproxy/executor/websocket.go UpstreamWebsocketTurnError): a session
 * socket that drops (close 1006 or a socket error) fails the running request with a request-scoped 502
 * `upstream_websocket_lost` (never replayed, never failed over, no cooldown); the session remembers the loss (`lost`) so a
 * continuation that needed the socket is answered 409 `previous_response_not_found` instead of asking for an HTTP replay.
 * The downstream handler keeps its client socket open for all three (`handlers/responses/websocket/socket.ts`).
 *
 * Differences from Go: there is no reader goroutine; a turn pulls frames from the socket's message queue under the idle
 * deadline (`Effect.timeout`, so tests drive it with `TestClock`). A socket that drops while idle is noticed through
 * `onEnd` and only marks the session `lost`. A turn that is released before its terminal event (client interrupt,
 * error) invalidates the socket so late frames of the abandoned response can never reach the next turn. A failed send
 * is redialled once (Go treats it as a loss: on Workers a `send` that throws has queued nothing). Per-credential
 * `proxy-url` is not supported on Workers, so a session target is `(credential id, url)`.
 */
import { Duration, Effect, Option, Queue, Result, Scope, Semaphore } from "effect";
import { checkOutboundUrl, CurrentOutboundPolicy } from "@commissary/core";
import {
  type AbandonedOperation,
  ExecutionError,
  outboundRefusedError,
  withErrorFields,
} from "../errors.ts";
import {
  HandshakeError,
  UpstreamMessage,
  type UpstreamSocket,
  UpstreamWebSocketConnector,
  fetchConnector,
} from "./connector.ts";

/** Go `codexResponsesWebsocketIdleTimeout`. */
export const IDLE_TIMEOUT = Duration.minutes(5);

/** Go `UpstreamWebsocketReplayRequiredError`: the continuation needs the live socket, which is gone. */
export const REPLAY_REQUIRED_CODE = "upstream_websocket_replay_required";

export const replayRequiredError = (): ExecutionError =>
  new ExecutionError({
    status: 426,
    code: REPLAY_REQUIRED_CODE,
    message: "upstream websocket session is unavailable; replay the request with full input",
    requestScoped: true,
  });

export const isReplayRequired = (error: { readonly code?: string | undefined }): boolean =>
  error.code === REPLAY_REQUIRED_CODE;

/** `mapCodexWebsocketReadError` for close code 1009 (message too big): request-scoped 413. */
export const messageTooBigError = (): ExecutionError =>
  new ExecutionError({
    status: 413,
    message:
      '{"error":{"message":"upstream websocket message too big","type":"invalid_request_error","code":"message_too_big"}}',
    requestScoped: true,
  });

export const UPSTREAM_LOST_CODE = "upstream_websocket_lost";

export const UPSTREAM_NOT_SENT_CODE = "upstream_websocket_not_sent";

export const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

/** `UpstreamWebsocketTurnError` (loss): the upstream socket dropped; the request is never replayed. */
export const upstreamLostError = (): ExecutionError =>
  new ExecutionError({
    status: 502,
    code: UPSTREAM_LOST_CODE,
    message:
      '{"error":{"message":"Upstream websocket disconnected. The turn was not replayed and its outcome may be unknown. Send a new response.create with full conversation input without previous_response_id.","type":"server_error","code":"upstream_websocket_lost"}}',
    requestScoped: true,
  });

/** `UpstreamWebsocketTurnError` (FullContextRequired): a continuation that refers to a socket that was lost. */
export const previousResponseNotFoundError = (): ExecutionError =>
  new ExecutionError({
    status: 409,
    code: PREVIOUS_RESPONSE_NOT_FOUND_CODE,
    message:
      '{"error":{"message":"Previous response is not available on this websocket; resend the full conversation input without previous_response_id","type":"invalid_request_error","code":"previous_response_not_found","param":"previous_response_id"}}',
    requestScoped: true,
  });

/** `UpstreamWebsocketTurnError` (NotSent): an operation that was never written upstream. */
export const notSentError = (): ExecutionError =>
  new ExecutionError({
    status: 502,
    code: UPSTREAM_NOT_SENT_CODE,
    message:
      '{"error":{"message":"Operation was not sent because the upstream websocket was lost. Send a new response.create with full conversation input.","type":"invalid_request_error","code":"upstream_websocket_not_sent"}}',
    requestScoped: true,
  });

export type { AbandonedOperation };

export const withAbandoned = (
  error: ExecutionError,
  operations: ReadonlyArray<AbandonedOperation>,
): ExecutionError =>
  operations.length === 0 ? error : withErrorFields(error, { abandoned: operations });

export const abandonedOf = (error: ExecutionError): ReadonlyArray<AbandonedOperation> =>
  error.abandoned ?? [];

/** `IsUpstreamWebsocketTurnError`: an error the client socket survives (the downstream handler does not close it). */
export const isUpstreamTurnError = (error: { readonly code?: string | undefined }): boolean =>
  error.code === UPSTREAM_LOST_CODE ||
  error.code === UPSTREAM_NOT_SENT_CODE ||
  error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;

export const isUpstreamLost = (error: { readonly code?: string | undefined }): boolean =>
  error.code === UPSTREAM_LOST_CODE;

const transient = (message: string): ExecutionError =>
  new ExecutionError({ status: 500, code: "transient_transport", message });

export interface UpstreamSession {
  readonly id: string;
  readonly lock: Semaphore.Semaphore;
  socket: UpstreamSocket | undefined;
  authId: string;
  url: string;
  active: boolean;
  /** Removes the idle-drop watcher of the current socket. */
  unwatch: (() => void) | undefined;
  /**
   * The upstream socket dropped (not invalidated by us) and none was dialled since: a continuation that needed it is
   * answered 409 `previous_response_not_found` instead of "replay over HTTP".
   */
  lost: boolean;
  closed: boolean;
}

const newSession = (id: string): UpstreamSession => ({
  id,
  lock: Semaphore.makeUnsafe(1),
  socket: undefined,
  authId: "",
  url: "",
  active: false,
  unwatch: undefined,
  lost: false,
  closed: false,
});

/** Go `codexWebsocketSessionStore` (one per provider, per isolate). */
export class UpstreamSessionStore {
  private readonly sessions = new Map<string, UpstreamSession>();

  get(id: string): UpstreamSession {
    let session = this.sessions.get(id);

    if (session === undefined) {
      session = newSession(id);
      this.sessions.set(id, session);
    }

    return session;
  }

  peek(id: string): UpstreamSession | undefined {
    return this.sessions.get(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Ids of the sessions that exist (tests and diagnostics). */
  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /** Detaches and closes the session's socket (`invalidateUpstreamConn`); the session itself stays. */
  invalidate(
    session: UpstreamSession,
    socket: UpstreamSocket | undefined = session.socket,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (socket === undefined) return Effect.void;

      if (session.socket === socket) {
        session.unwatch?.();
        session.unwatch = undefined;
        session.socket = undefined;
      }

      return socket.close(1000, "invalidated");
    });
  }

  /** Go `CloseExecutionSession`. */
  close(id: string, reason = "session_closed"): Effect.Effect<void> {
    return Effect.suspend(() => {
      const session = this.sessions.get(id);

      if (session === undefined) return Effect.void;
      this.sessions.delete(id);
      session.closed = true;
      const socket = session.socket;
      session.unwatch?.();
      session.unwatch = undefined;
      session.socket = undefined;

      return socket === undefined ? Effect.void : socket.close(1000, reason);
    });
  }

  /** Go `InterruptExecutionSession`: writes a control frame to the socket of a running request, nothing else. */
  interrupt(id: string, payload: string): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      const session = this.sessions.get(id);
      const socket = session?.socket;

      if (session === undefined || socket === undefined || !session.active || !socket.isOpen()) {
        return Effect.succeed(false);
      }

      return socket.send(payload).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    });
  }
}

export const codexSessionStore = new UpstreamSessionStore();

export const xaiSessionStore = new UpstreamSessionStore();

export interface OpenTurnInput {
  readonly store: UpstreamSessionStore;
  /** Downstream socket id; `undefined` = ephemeral socket (closed after the turn). */
  readonly sessionId: string | undefined;
  readonly authId: string;
  /** `ws:`/`wss:` URL. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Serialised first frame (rebuilt for the retry after a send failure). */
  readonly frame: () => string;
  /** Go `RequiredUpstreamWebsocket`: only the live socket of this session will do. */
  readonly requireUpstream: boolean;
  /** Maps a rejected upgrade to the executor's error type (provider specific). */
  readonly classifyHandshake: (
    status: number,
    body: string,
    headers: Record<string, string>,
  ) => ExecutionError;
  /** Provider name for messages. */
  readonly label: string;
  readonly idle?: Duration.Input;
}

export interface Turn {
  /** Handshake response headers of the socket that serves the turn (empty for a reused socket). */
  readonly headers: Headers;
  /** Next non-empty text frame, trimmed, under the idle deadline. Failures invalidate the socket. */
  readonly read: Effect.Effect<string, ExecutionError>;
  /** Writes a further frame to the turn's socket (full-duplex steering). */
  readonly send: (text: string) => Effect.Effect<void, ExecutionError>;
  /** Detaches the socket so it is not reused (`invalidateUpstreamConn`). */
  readonly invalidate: Effect.Effect<void>;
  /** The terminal event was delivered: the socket may be reused by the next turn. */
  readonly complete: () => void;
}

const handshakeToError = (input: OpenTurnInput, error: HandshakeError): ExecutionError => {
  if (error.status > 0)
    return input.classifyHandshake(error.status, error.body, { ...error.headers });

  return transient(`${input.label} websocket dial failed: ${error.message}`);
};

const targetMatches = (session: UpstreamSession, authId: string, url: string): boolean =>
  session.authId === authId && session.url === url;

/**
 * Opens a turn: takes the session lock for the scope, makes sure a socket to the target exists (reusing the retained
 * one, redialling after a target change or drop) and sends the first frame.
 */
export const openTurn = (input: OpenTurnInput): Effect.Effect<Turn, ExecutionError, Scope.Scope> =>
  Effect.gen(function* () {
    const connector = Option.getOrElse(
      yield* Effect.serviceOption(UpstreamWebSocketConnector),
      fetchConnector,
    );

    const { store } = input;
    const ephemeral = input.sessionId === undefined;
    const session = ephemeral ? newSession("ephemeral") : store.get(input.sessionId);
    let completed = false;

    if (!ephemeral)
      yield* Effect.acquireRelease(Semaphore.take(session.lock, 1), () =>
        Semaphore.release(session.lock, 1),
      );
    session.active = true;
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        session.active = false;

        // A turn that did not reach its terminal event leaves frames in flight: never reuse that socket.
        return ephemeral || !completed ? store.invalidate(session) : Effect.void;
      }),
    );

    // A socket that ends while it is still the session's was dropped by the upstream (ours are detached first). A running
    // request reports it through `read`; between requests it is only remembered (`lost`).
    const watch = (socket: UpstreamSocket) => {
      session.unwatch = socket.onEnd(() => {
        if (session.socket !== socket) return;
        session.socket = undefined;
        session.unwatch = undefined;
        session.lost = true;
      });
    };

    /** `ensureUpstreamConn`. */
    const ensure = Effect.gen(function* () {
      if (
        session.socket !== undefined &&
        (!session.socket.isOpen() || !targetMatches(session, input.authId, input.url))
      ) {
        yield* store.invalidate(session);
      }

      if (session.socket !== undefined) return { socket: session.socket, headers: new Headers() };

      // The outbound guard (ADR 0044) checks the address as the `fetch` that dials it sees it (`wss:` as `https:`); the
      // upgrade is not redirected.
      const checked = checkOutboundUrl(
        input.url.replace(/^ws(s?):/i, "http$1:"),
        yield* CurrentOutboundPolicy,
      );

      if (Result.isFailure(checked)) return yield* outboundRefusedError(checked.failure);

      const socket = yield* connector
        .connect({ url: input.url, headers: input.headers })
        .pipe(Effect.mapError((error) => handshakeToError(input, error)));

      session.socket = socket;
      session.authId = input.authId;
      session.url = input.url;
      session.lost = false;
      watch(socket);

      return { socket, headers: socket.headers };
    });

    let current: UpstreamSocket;
    let headers: Headers;

    if (input.requireUpstream) {
      const existing = session.socket;

      if (
        existing === undefined ||
        !existing.isOpen() ||
        !targetMatches(session, input.authId, input.url)
      ) {
        // A socket that was lost (not replaced) is answered like Go: the client resends the full conversation.
        return yield* session.lost ? previousResponseNotFoundError() : replayRequiredError();
      }

      current = existing;
      headers = new Headers();
    } else {
      const opened = yield* ensure;
      current = opened.socket;
      headers = opened.headers;
    }

    // Frames that arrived while the session was idle belong to no request.
    yield* Queue.clear(current.messages);

    const sent = yield* Effect.result(current.send(input.frame()));

    if (Result.isFailure(sent)) {
      yield* store.invalidate(session, current);

      // Retry once on a fresh socket (the upstream may close between sequential requests); a continuation cannot: the
      // socket it refers to is gone.
      if (input.requireUpstream) {
        session.lost = true;

        return yield* previousResponseNotFoundError();
      }

      if (ephemeral) return yield* transient(`${input.label} websocket send failed`);
      const reopened = yield* ensure;
      current = reopened.socket;
      headers = reopened.headers;
      const retry = yield* Effect.result(current.send(input.frame()));

      if (Result.isFailure(retry)) {
        yield* store.invalidate(session, current);

        return yield* transient(`${input.label} websocket send failed`);
      }
    }

    const socket = current;
    const idle = input.idle ?? IDLE_TIMEOUT;
    const invalidate = store.invalidate(session, socket);

    const lost = (): ExecutionError => {
      session.lost = true;

      return upstreamLostError();
    };

    const read: Effect.Effect<string, ExecutionError> = Effect.gen(function* () {
      while (true) {
        const message = yield* Queue.take(socket.messages).pipe(
          Effect.timeoutOrElse({
            duration: idle,
            orElse: () => Effect.fail(transient(`${input.label} websocket idle timeout`)),
          }),
        );

        const text = yield* UpstreamMessage.$match(message, {
          text: ({ data }) => Effect.succeed(data.trim()),
          binary: () =>
            Effect.fail(transient(`${input.label} websockets executor: unexpected binary message`)),
          close: ({ code }) =>
            Effect.fail(
              code === 1009
                ? messageTooBigError()
                : code === 1006 && !ephemeral
                  ? lost()
                  : transient(`${input.label} upstream websocket closed (${code})`),
            ),
          error: () =>
            Effect.fail(ephemeral ? transient(`${input.label} upstream websocket error`) : lost()),
        });

        if (text !== "") return text;
      }
    }).pipe(Effect.tapError(() => invalidate));

    const send = (text: string): Effect.Effect<void, ExecutionError> =>
      socket
        .send(text)
        .pipe(
          Effect.mapError(() =>
            ephemeral ? transient(`${input.label} websocket send failed`) : lost(),
          ),
        );

    return {
      headers,
      read,
      send,
      invalidate,
      complete: () => void (completed = true),
    } satisfies Turn;
  });
