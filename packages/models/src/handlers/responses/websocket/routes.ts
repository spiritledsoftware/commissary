/**
 * `GET /v1/responses` (also unprefixed `/responses`) and `GET /backend-api/codex/responses` with `Upgrade: websocket`: the inbound Responses WebSocket.
 *
 * Go source: sdk/api/handlers/openai/openai_responses_websocket.go (ResponsesWebsocket, responsesWebsocketUpgrader,
 * websocketUpgradeHeaders), internal/api/server_routes.go (route table).
 *
 * Architecture decision (docs/ARCHITECTURE.md, "Responses WebSocket"): the socket lives in the Worker
 * invocation that accepted it (`WebSocketPair`, `server.accept()`), not in a Durable Object. Per-socket state (previous
 * response chaining, tool caches, the upstream execution sessions) is plain memory of that invocation and dies with the
 * socket, exactly like the goroutine-per-connection state in Go. A Durable Object with the hibernation API would add
 * nothing here: the outbound upstream WebSocket and the running turn keep the object awake anyway, and outbound sockets
 * cannot hibernate. The Access gate has already authenticated the upgrade request (the principal is captured for the
 * socket's lifetime); the gate's `RequestReauthorizer`, when it provides one, authenticates every client frame again
 * (CLIProxyAPI b9bb031d), so a key revoked after the upgrade stops working on the live socket.
 */
import { type Cause, Effect, Option, Queue, Result, type Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  type AccessRefusal,
  accessRefusal,
  AccessPrincipal,
  RequestReauthorizer,
} from "@commissary/auth";
import { invalidRequestBody } from "../../../http/errors.ts";
import { ExecutionError } from "../../../executor/errors.ts";
import { executeStream, type ExecutionInput, hasAlternativeTarget } from "../../execute.ts";
import { currentConfig } from "../../request.ts";
import { prepareCodexResponsesRequest } from "../codex-prepare.ts";
import { downstreamSessionKey, defaultToolCaches } from "./tool-cache.ts";
import { type SocketIO, runResponsesSocket } from "./socket.ts";

type TurnServices = Exclude<Effect.Services<ReturnType<typeof executeStream>>, Scope.Scope>;

const TURN_STATE_HEADER = "x-codex-turn-state";

/** Decodes a client frame: text, or UTF-8 bytes (Go reads text and binary frames alike). */
const frameText = (data: string | ArrayBuffer | ArrayBufferView): string | undefined => {
  if (typeof data === "string") return data;

  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);

  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);

  return undefined;
};

/** What a refused frame is answered with: the refusal's status and message, and its `Retry-After` when rate limited. */
export const refusalToExecutionError = (refusal: AccessRefusal): ExecutionError =>
  new ExecutionError({
    status: refusal.status,
    message: refusal.message,
    ...(refusal.retryAfterSeconds === undefined
      ? {}
      : { safeHeaders: { "retry-after": String(refusal.retryAfterSeconds) } }),
  });

/** Accepts the upgrade and starts the socket fiber. Requires the per-request services of the turn (see header). */
export const handleResponsesSocket = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const headers = new Headers(request.headers);

  if ((headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return HttpServerResponse.text(invalidRequestBody("websocket upgrade required"), {
      status: 400,
      contentType: "application/json",
    });
  }

  const identity = yield* AccessPrincipal;
  const reauthorizer = yield* Effect.serviceOption(RequestReauthorizer);
  const services = yield* Effect.context<TurnServices>();
  // `upstream.codex.response-steering`; an unreadable config surfaces from the turn itself.
  const config = yield* Effect.result(currentConfig);
  const steering = Result.isSuccess(config) && config.success.upstream.codex["response-steering"];

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const raw = yield* Queue.unbounded<string, Cause.Done>();
  const sessionId = crypto.randomUUID();

  const io: SocketIO = {
    send: (text) => {
      try {
        server.send(text);
      } catch {
        // The client is gone; the close listener ends the session.
      }
    },
    close: (code, reason) => {
      try {
        server.close(code, reason);
      } catch {
        // Already closed.
      }
    },
  };

  const program = runResponsesSocket<TurnServices>(
    {
      io,
      sessionId,
      headers,
      toolSessionKey: downstreamSessionKey(headers, identity.callerScope),
      toolCaches: defaultToolCaches,
      steering,
      ...(Option.isSome(reauthorizer)
        ? {
            authorize: reauthorizer.value.pipe(
              Effect.result,
              Effect.flatMap((result) =>
                Result.isSuccess(result)
                  ? Effect.succeed(undefined)
                  : Effect.map(accessRefusal(result.failure), refusalToExecutionError),
              ),
            ),
          }
        : {}),
      prepare: (payload) => prepareCodexResponsesRequest(payload, headers, true, false),
      execute: (input: Omit<ExecutionInput, "request">) => executeStream({ ...input, request }),
      hasAlternative: (input: Omit<ExecutionInput, "request">, excludedId: string) =>
        hasAlternativeTarget({ ...input, request }, excludedId),
    },
    raw,
  );

  const fiber = Effect.runForkWith(services)(program);
  server.addEventListener("message", (event) => {
    const text = frameText(event.data);

    if (text !== undefined) Queue.offerUnsafe(raw, text);
  });

  const ended = () => {
    // A turn in flight is interrupted (reported as a client abort); an idle loop just ends.
    fiber.interruptUnsafe();
    Effect.runFork(Queue.end(raw));
  };

  server.addEventListener("close", ended);
  server.addEventListener("error", ended);

  const responseHeaders = new Headers();
  // Keep the same sticky turn-state across reconnects when provided by the client.
  const turnState = (headers.get(TURN_STATE_HEADER) ?? "").trim();

  if (turnState !== "") responseHeaders.set(TURN_STATE_HEADER, turnState);

  return HttpServerResponse.raw(
    new Response(null, { status: 101, webSocket: client, headers: responseHeaders }),
    {
      status: 101,
    },
  );
});
