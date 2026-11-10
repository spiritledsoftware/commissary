// Upstream execution sessions (retained sockets, locking, idle deadline, redial) with in-memory sockets and TestClock.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Predicate, Queue, Scope } from "effect";
import { TestClock } from "effect/testing";
import { ExecutionError } from "../../src/executor/errors.ts";
import {
  HandshakeError,
  type UpstreamMessage,
  type UpstreamSocket,
  UpstreamSendError,
  UpstreamWebSocketConnector,
} from "../../src/executor/websocket/connector.ts";
import {
  openTurn,
  type OpenTurnInput,
  UpstreamSessionStore,
} from "../../src/executor/websocket/session.ts";
import { Frames } from "../support/upstream-message.ts";

interface FakeSocket {
  readonly socket: UpstreamSocket;
  readonly sent: string[];
  closed: { code: number | undefined; reason: string | undefined } | undefined;
  failNextSend: boolean;
  readonly push: (message: UpstreamMessage) => void;
}

const fakeSocket = (): FakeSocket => {
  const messages = Effect.runSync(Queue.unbounded<UpstreamMessage>());
  const listeners = new Set<(message: UpstreamMessage) => void>();

  let open = true;

  const socket: UpstreamSocket = {
    headers: new Headers(),
    send: (text) =>
      Effect.suspend(() => {
        if (fake.failNextSend || !open) {
          fake.failNextSend = false;

          return Effect.fail(new UpstreamSendError({ message: "boom" }));
        }

        fake.sent.push(text);

        return Effect.void;
      }),
    messages,
    close: (code, reason) =>
      Effect.sync(() => {
        open = false;
        fake.closed = { code, reason };
      }),
    isOpen: () => open,
    onEnd: (listener) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
  };

  const fake: FakeSocket = {
    sent: [],
    closed: undefined,
    failNextSend: false,
    push: (message) => {
      Queue.offerUnsafe(messages, message);

      if (Predicate.isTagged(message, "close") || Predicate.isTagged(message, "error")) {
        open = false;

        for (const listener of listeners) listener(message);
      }
    },
    socket,
  };

  return fake;
};

/** Connector that hands out the given sockets in order and records dials. */
const connector = (sockets: FakeSocket[], dials: Array<{ url: string }> = []) => {
  let index = 0;

  return Layer.succeed(
    UpstreamWebSocketConnector,
    UpstreamWebSocketConnector.of({
      connect: (request) =>
        Effect.suspend(() => {
          dials.push({ url: request.url });
          const next = sockets[index++];

          return next === undefined
            ? Effect.fail(
                new HandshakeError({
                  status: 503,
                  body: "busy",
                  headers: {},
                  message: "no more sockets",
                }),
              )
            : Effect.succeed(next.socket);
        }),
    }),
  );
};

const input = (
  store: UpstreamSessionStore,
  overrides: Partial<OpenTurnInput> = {},
): OpenTurnInput => ({
  store,
  sessionId: "session-1",
  authId: "auth-1",
  url: "wss://upstream.test/responses",
  headers: {},
  frame: () => '{"type":"response.create"}',
  requireUpstream: false,
  label: "codex",
  classifyHandshake: (status, body) =>
    new ExecutionError({ status, message: `classified:${body}` }),
  ...overrides,
});

const text = (data: string): UpstreamMessage => Frames.text({ data });

describe("upstream execution sessions", () => {
  it.effect(
    "fails a silent upstream after the five minute idle deadline and detaches the socket",
    () =>
      Effect.gen(function* () {
        const store = new UpstreamSessionStore();
        const socket = fakeSocket();
        const scope = yield* Scope.make();

        const turn = yield* openTurn(input(store)).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(connector([socket])),
        );

        const fiber = yield* turn.read.pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("299 seconds");
        assert.isUndefined(fiber.pollUnsafe());
        yield* TestClock.adjust("1 second");
        const error = yield* Fiber.join(fiber);
        assert.strictEqual(error.code, "transient_transport");
        assert.include(error.message, "idle timeout");
        assert.isDefined(socket.closed);
        assert.isUndefined(store.peek("session-1")?.socket);
      }),
  );

  it.effect("reuses the retained socket for the next turn once the previous one completed", () =>
    Effect.gen(function* () {
      const store = new UpstreamSessionStore();
      const socket = fakeSocket();
      const dials: Array<{ url: string }> = [];
      const layer = connector([socket], dials);

      for (const frame of ["one", "two"]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const turn = yield* openTurn(input(store, { frame: () => frame }));
            socket.push(text(' {"type":"response.completed"} '));
            assert.strictEqual(yield* turn.read, '{"type":"response.completed"}');
            turn.complete();
          }),
        ).pipe(Effect.provide(layer));
      }

      assert.deepStrictEqual(socket.sent, ["one", "two"]);
      assert.lengthOf(dials, 1);
      assert.isUndefined(socket.closed);
    }),
  );

  it.effect("never reuses a socket whose turn ended before the terminal event", () =>
    Effect.gen(function* () {
      const store = new UpstreamSessionStore();
      const first = fakeSocket();
      const second = fakeSocket();
      const layer = connector([first, second]);
      yield* Effect.scoped(openTurn(input(store))).pipe(Effect.provide(layer));
      assert.isDefined(first.closed);
      yield* Effect.scoped(openTurn(input(store))).pipe(Effect.provide(layer));
      assert.lengthOf(second.sent, 1);
    }),
  );

  it.effect("redials once when the send fails on the retained socket", () =>
    Effect.gen(function* () {
      const store = new UpstreamSessionStore();
      const first = fakeSocket();
      const second = fakeSocket();
      const dials: Array<{ url: string }> = [];
      const layer = connector([first, second], dials);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const turn = yield* openTurn(input(store));
          turn.complete();
        }),
      ).pipe(Effect.provide(layer));
      first.failNextSend = true;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const turn = yield* openTurn(input(store));
          second.push(text("{}"));
          assert.strictEqual(yield* turn.read, "{}");
          turn.complete();
        }),
      ).pipe(Effect.provide(layer));
      assert.lengthOf(dials, 2);
      assert.isDefined(first.closed);
      assert.lengthOf(second.sent, 1);
    }),
  );

  it.effect(
    "asks the client to replay when a continuation has no live socket and answers 409 when its send fails",
    () =>
      Effect.gen(function* () {
        const store = new UpstreamSessionStore();

        const missing = yield* Effect.scoped(
          openTurn(input(store, { requireUpstream: true })),
        ).pipe(Effect.provide(connector([])), Effect.flip);

        assert.strictEqual(missing.code, "upstream_websocket_replay_required");
        assert.strictEqual(missing.status, 426);
        assert.isTrue(missing.requestScoped);

        const socket = fakeSocket();
        const layer = connector([socket]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const turn = yield* openTurn(input(store));
            turn.complete();
          }),
        ).pipe(Effect.provide(layer));
        socket.failNextSend = true;

        const failed = yield* Effect.scoped(openTurn(input(store, { requireUpstream: true }))).pipe(
          Effect.provide(layer),
          Effect.flip,
        );

        // The retained socket turned out dead: the continuation's response is gone with it.
        assert.strictEqual(failed.code, "previous_response_not_found");
        assert.isDefined(socket.closed);
      }),
  );

  it.effect("dials a new socket when the credential or URL changes", () =>
    Effect.gen(function* () {
      const store = new UpstreamSessionStore();
      const first = fakeSocket();
      const second = fakeSocket();
      const dials: Array<{ url: string }> = [];
      const layer = connector([first, second], dials);

      const run = (overrides: Partial<OpenTurnInput>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const turn = yield* openTurn(input(store, overrides));
            turn.complete();
          }),
        ).pipe(Effect.provide(layer));

      yield* run({});
      yield* run({ authId: "auth-2" });
      assert.lengthOf(dials, 2);
      assert.isDefined(first.closed);
      assert.strictEqual(store.peek("session-1")?.authId, "auth-2");
    }),
  );

  it.effect(
    "maps close 1009 to a request-scoped 413, binary frames and other closes to transient errors",
    () =>
      Effect.gen(function* () {
        const read = (message: UpstreamMessage) =>
          Effect.gen(function* () {
            const socket = fakeSocket();
            const store = new UpstreamSessionStore();

            return yield* Effect.scoped(
              Effect.gen(function* () {
                const turn = yield* openTurn(input(store));
                socket.push(message);

                return yield* Effect.flip(turn.read);
              }),
            ).pipe(Effect.provide(connector([socket])));
          });

        const tooBig = yield* read(Frames.close({ code: 1009, reason: "too big" }));
        assert.strictEqual(tooBig.status, 413);
        assert.isTrue(tooBig.requestScoped);
        assert.include(tooBig.message, "message_too_big");
        const binary = yield* read(Frames.binary());
        assert.include(binary.message, "unexpected binary message");
        const goingAway = yield* read(Frames.close({ code: 1001, reason: "bye" }));
        assert.strictEqual(goingAway.code, "transient_transport");
        assert.strictEqual(goingAway.status, 500);
      }),
  );

  it.effect(
    "fails a request on a session socket that drops (close 1006 or a socket error) with a request-scoped 502 loss",
    () =>
      Effect.gen(function* () {
        const dropWith = (message: UpstreamMessage, sessionId: string | undefined) =>
          Effect.gen(function* () {
            const socket = fakeSocket();
            const store = new UpstreamSessionStore();

            const error = yield* Effect.scoped(
              Effect.gen(function* () {
                const turn = yield* openTurn(input(store, { sessionId }));
                socket.push(message);

                return yield* Effect.flip(turn.read);
              }),
            ).pipe(Effect.provide(connector([socket])));

            return { error, lost: store.peek("session-1")?.lost };
          });

        const closed = yield* dropWith(Frames.close({ code: 1006, reason: "" }), "session-1");
        assert.strictEqual(closed.error.code, "upstream_websocket_lost");
        assert.strictEqual(closed.error.status, 502);
        assert.isTrue(closed.error.requestScoped);
        assert.include(closed.error.message, "upstream_websocket_lost");
        assert.isTrue(closed.lost);

        const errored = yield* dropWith(Frames.error({ message: "boom" }), "session-1");
        assert.strictEqual(errored.error.code, "upstream_websocket_lost");

        // An ephemeral socket belongs to no downstream socket: nothing to keep alive, today's transient error.
        const ephemeral = yield* dropWith(Frames.close({ code: 1006, reason: "" }), undefined);
        assert.strictEqual(ephemeral.error.code, "transient_transport");
      }),
  );

  it.effect(
    "answers a continuation 409 when its socket was lost, 426 when we detached it, and a redial clears the loss",
    () =>
      Effect.gen(function* () {
        const store = new UpstreamSessionStore();
        const first = fakeSocket();
        const second = fakeSocket();
        const layer = connector([first, second]);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const turn = yield* openTurn(input(store));
            turn.complete();
          }),
        ).pipe(Effect.provide(layer));

        first.push(Frames.close({ code: 1006, reason: "" }));
        assert.isTrue(store.peek("session-1")?.lost);

        const continuation = yield* Effect.scoped(
          openTurn(input(store, { requireUpstream: true })),
        ).pipe(Effect.provide(layer), Effect.flip);

        assert.strictEqual(continuation.status, 409);
        assert.strictEqual(continuation.code, "previous_response_not_found");
        assert.isTrue(continuation.requestScoped);

        // A full create redials on the same session, which clears the loss.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const turn = yield* openTurn(input(store));
            turn.complete();
          }),
        ).pipe(Effect.provide(layer));
        assert.isFalse(store.peek("session-1")?.lost);

        // A socket we detach ourselves is not lost: the continuation asks for an HTTP replay as before.
        const session = store.get("session-1");
        yield* store.invalidate(session);

        const replay = yield* Effect.scoped(openTurn(input(store, { requireUpstream: true }))).pipe(
          Effect.provide(layer),
          Effect.flip,
        );

        assert.strictEqual(replay.code, "upstream_websocket_replay_required");
      }),
  );

  it.effect("classifies a rejected upgrade and reports transport failures as transient", () =>
    Effect.gen(function* () {
      const store = new UpstreamSessionStore();

      const rejected = yield* Effect.scoped(openTurn(input(store))).pipe(
        Effect.provide(connector([])),
        Effect.flip,
      );

      assert.strictEqual(rejected.status, 503);
      assert.strictEqual(rejected.message, "classified:busy");

      const unreachable = yield* Effect.scoped(openTurn(input(store))).pipe(
        Effect.provide(
          Layer.succeed(
            UpstreamWebSocketConnector,
            UpstreamWebSocketConnector.of({
              connect: () =>
                Effect.fail(
                  new HandshakeError({ status: 0, body: "", headers: {}, message: "dns" }),
                ),
            }),
          ),
        ),
        Effect.flip,
      );

      assert.strictEqual(unreachable.code, "transient_transport");
    }),
  );

  it.effect(
    "drops frames that arrived while the session was idle and remembers an idle drop as a loss",
    () =>
      Effect.gen(function* () {
        const store = new UpstreamSessionStore();
        const socket = fakeSocket();
        const layer = connector([socket]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const turn = yield* openTurn(input(store));
            turn.complete();
          }),
        ).pipe(Effect.provide(layer));
        socket.push(text("stale"));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const turn = yield* openTurn(input(store));
            socket.push(text("fresh"));
            assert.strictEqual(yield* turn.read, "fresh");
            turn.complete();
          }),
        ).pipe(Effect.provide(layer));
        socket.push(Frames.close({ code: 1001, reason: "bye" }));
        assert.isTrue(store.peek("session-1")?.lost);
        assert.isUndefined(store.peek("session-1")?.socket);
      }),
  );

  it.effect("serialises requests of one session and closes ephemeral sockets after the turn", () =>
    Effect.gen(function* () {
      const store = new UpstreamSessionStore();
      const socket = fakeSocket();
      const layer = connector([socket, fakeSocket()]);
      const scope = yield* Scope.make();
      yield* openTurn(input(store)).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(layer),
      );

      const second = yield* Effect.scoped(openTurn(input(store))).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );

      yield* TestClock.adjust(1000);
      assert.isUndefined(second.pollUnsafe());
      yield* Scope.close(scope, Exit.void);
      yield* Fiber.join(second);

      const ephemeral = fakeSocket();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const turn = yield* openTurn(input(store, { sessionId: undefined }));
          turn.complete();
        }),
      ).pipe(Effect.provide(connector([ephemeral])));
      assert.isDefined(ephemeral.closed);
    }),
  );
});
