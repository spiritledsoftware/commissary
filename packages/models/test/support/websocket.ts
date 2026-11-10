// Test helpers for the WebSocket transports: an in-memory upstream (real `WebSocketPair`s behind the executor's
// connector service) and a client-side socket wrapper that queues messages.
import { Effect, Layer } from "effect";
import {
  HandshakeError,
  UpstreamWebSocketConnector,
  wrapWebSocket,
} from "../../src/executor/websocket/connector.ts";
import type { Json } from "@commissary/json";

/** One accepted upstream connection as seen by the mock server. */
export interface UpstreamConnection {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Text frames Commissary sent. */
  readonly received: string[];
  readonly server: WebSocket;
  closed: { code: number; reason: string } | undefined;
  /** Resolves the next frame Commissary sends (consumed in order). */
  readonly next: () => Promise<string>;
  /**
   * The connection drops without a closing handshake: Commissary's side sees a close with code 1006 (a Worker's
   * `close()` cannot send it).
   */
  readonly drop: () => void;
}

export interface MockUpstreamOptions {
  /** Called for each established connection (attach behaviour, e.g. reply to frames). */
  readonly onConnection?: (connection: UpstreamConnection) => void;
  /** Reject the upgrade with this status/body instead of connecting. */
  readonly reject?: (
    url: string,
  ) => { status: number; body?: string; headers?: Record<string, string> } | undefined;
}

export interface MockUpstream {
  readonly connections: UpstreamConnection[];
  /** Every dial attempt (also rejected ones). */
  readonly dials: Array<{ url: string; headers: Readonly<Record<string, string>> }>;
  readonly layer: Layer.Layer<UpstreamWebSocketConnector>;
}

export const mockUpstream = (options: MockUpstreamOptions = {}): MockUpstream => {
  const connections: UpstreamConnection[] = [];
  const dials: MockUpstream["dials"] = [];

  const layer = Layer.succeed(
    UpstreamWebSocketConnector,
    UpstreamWebSocketConnector.of({
      connect: (request) =>
        Effect.suspend(() => {
          dials.push({ url: request.url, headers: { ...request.headers } });
          const rejection = options.reject?.(request.url);

          if (rejection !== undefined) {
            return Effect.fail(
              new HandshakeError({
                status: rejection.status,
                body: rejection.body ?? "",
                headers: rejection.headers ?? {},
                message: "rejected",
              }),
            );
          }

          const pair = new WebSocketPair();
          const serverSide = pair[0];
          const server = pair[1];
          server.accept();
          serverSide.accept();
          const received: string[] = [];
          const queue: string[] = [];
          const waiting: Array<(frame: string) => void> = [];

          const connection: UpstreamConnection = {
            url: request.url,
            headers: { ...request.headers },
            received,
            server,
            closed: undefined,
            next: () =>
              queue.length > 0
                ? Promise.resolve(queue.shift() as string)
                : new Promise<string>((resolve) => waiting.push(resolve)),
            drop: () =>
              serverSide.dispatchEvent(
                new CloseEvent("close", { code: 1006, reason: "", wasClean: false }),
              ),
          };

          server.addEventListener("message", (event) => {
            const text = String(event.data);
            received.push(text);
            const waiter = waiting.shift();

            if (waiter !== undefined) waiter(text);
            else queue.push(text);
          });
          server.addEventListener("close", (event) => {
            connection.closed = {
              code: event.code,
              reason: event.reason,
            };
          });
          connections.push(connection);
          options.onConnection?.(connection);

          return Effect.succeed(wrapWebSocket(serverSide, new Headers({ "x-upstream": "mock" })));
        }),
    }),
  );

  return { connections, dials, layer };
};

/** A client-side socket (the `webSocket` of Commissary's 101 response) with queued messages. */
export interface TestClient {
  readonly send: (value: Json) => void;
  readonly next: () => Promise<string>;
  readonly nextJson: () => Promise<Record<string, unknown>>;
  /** Reads JSON frames until one has this `type`. */
  readonly until: (type: string) => Promise<Record<string, unknown>>;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly close: (code?: number) => void;
  readonly messages: string[];
}

export const connectClient = (response: Response): TestClient => {
  const ws = response.webSocket;

  if (ws === null || ws === undefined)
    throw new Error(`no websocket in response (status ${response.status})`);
  ws.accept();
  const messages: string[] = [];
  const queue: string[] = [];
  const waiting: Array<(frame: string) => void> = [];
  let resolveClosed: (value: { code: number; reason: string }) => void = () => undefined;

  const closed = new Promise<{ code: number; reason: string }>(
    (resolve) => (resolveClosed = resolve),
  );

  ws.addEventListener("message", (event) => {
    const text = String(event.data);
    messages.push(text);
    const waiter = waiting.shift();

    if (waiter !== undefined) waiter(text);
    else queue.push(text);
  });
  ws.addEventListener("close", (event) =>
    resolveClosed({ code: event.code, reason: event.reason }),
  );

  const next = () =>
    queue.length > 0
      ? Promise.resolve(queue.shift() as string)
      : new Promise<string>((resolve) => waiting.push(resolve));

  const nextJson = async () => JSON.parse(await next()) as Record<string, unknown>;

  return {
    send: (value) => ws.send(typeof value === "string" ? value : JSON.stringify(value)),
    next,
    nextJson,
    until: async (type) => {
      while (true) {
        const frame = await nextJson();

        if (frame["type"] === type) return frame;
      }
    },
    closed,
    close: (code = 1000) => ws.close(code, ""),
    messages,
  };
};

/** The error object of an error frame. */
export const errorOf = (frame: Record<string, unknown>) =>
  frame["error"] as { code?: string; event_id?: string; message?: string; type?: string };

/** Polls (event-loop turns, no fixed delay) until the condition holds. */
export const eventually = async (condition: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 2000 && !condition(); turn++)
    await new Promise((resolve) => setTimeout(resolve, 0));

  if (!condition()) throw new Error("condition not met");
};

/**
 * A round trip through the handler's reader fiber, which reads the client socket frame by frame: a `response.interrupt`
 * without `response_id` is answered at once with a 400. When it returns, every frame sent before it has been read and
 * queued, and nothing the earlier frames could still write remains to be written by the reader. Returns the frames that
 * arrived in between (the sentinel's own 400 excluded).
 */
export const settled = async (client: TestClient): Promise<string[]> => {
  const before = client.messages.length;
  client.send({ type: "response.interrupt" });
  await client.until("error");

  return client.messages.slice(before, -1);
};

/** Scripted upstream: `script(frame, index, send, connection)` answers each frame Commissary writes to a connection. */
export const scripted =
  (
    script: (
      frame: Record<string, unknown>,
      index: number,
      send: (event: Json) => void,
      connection: UpstreamConnection,
    ) => void,
  ) =>
  (connection: UpstreamConnection): void => {
    void (async () => {
      for (let index = 0; ; index++) {
        const text = await connection.next();
        script(
          JSON.parse(text) as Record<string, unknown>,
          index,
          (event) =>
            connection.server.send(typeof event === "string" ? event : JSON.stringify(event)),
          connection,
        );
      }
    })();
  };
