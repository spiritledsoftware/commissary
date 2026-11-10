/**
 * Responses API routes: `POST /v1/responses`, `POST /v1/responses/compact`, the Codex aliases under
 * `/backend-api/codex/*` and the unprefixed `/responses` aliases (entry protocol `openai-response`). Difference: Go
 * has no unprefixed aliases; see handlers/openai/routes.ts for why they exist.
 *
 * Go source: sdk/api/handlers/openai/openai_responses_handlers.go (Responses, Compact, handleNonStreamingResponse,
 * handleStreamingResponse), internal/api/server_routes.go (route table). The websocket variants (`GET /v1/responses`,
 * `GET /backend-api/codex/responses`) are in websocket/. Codex multi-agent-v2 tool preparation and orphan delegation rewriting run in `codex-prepare.ts`.
 */
import { Effect, Result } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { routeServices } from "@commissary/core";
import type { ExecutionError } from "../../executor/errors.ts";
import { invalidRequestBody } from "../../http/errors.ts";
import { asString, del, get, type Json } from "@commissary/json";
import { Formats } from "@commissary/translation/formats";
import { executeNonStream, executeStream, type ExecutionInput } from "../execute.ts";
import { currentConfig, type ClientApiServices, readRequestBody } from "../request.ts";
import { errorResponse, jsonResponse, streamResponse } from "../respond.ts";
import { prepareCodexResponsesRequest } from "./codex-prepare.ts";
import { isCodexResponsesClient, responsesFramer } from "./framer.ts";
import { handleResponsesSocket } from "./websocket/routes.ts";

const badRequest = (message: string, status = 400): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(invalidRequestBody(message), { status, contentType: "application/json" });

const handle = (compact: boolean) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const configResult = yield* Effect.result(currentConfig);

    if (Result.isFailure(configResult))
      return errorResponse("openai", configResult.failure, { passthroughHeaders: false });
    const config = configResult.success;

    const onError = (error: ExecutionError) =>
      errorResponse("openai", error, {
        passthroughHeaders: config.requests["passthrough-headers"],
      });

    const read = yield* Effect.result(readRequestBody(request));

    if (Result.isFailure(read)) return badRequest(read.failure.message, read.failure.status);
    let body: Json | undefined = read.success.json;

    if (body === undefined) return badRequest("request body is not valid JSON");

    // Official Codex clients: collaboration tools (not for compaction) and orphan delegations.
    yield* prepareCodexResponsesRequest(body, request.headers, !compact, true);
    const streamField = get(body, "stream");

    if (compact) {
      if (streamField === true) {
        return HttpServerResponse.text(
          JSON.stringify({
            error: {
              message: "Streaming not supported for compact responses",
              type: "invalid_request_error",
            },
          }),
          { status: 400, contentType: "application/json" },
        );
      }

      if (streamField !== undefined) body = del(body, "stream");
    }

    const input: ExecutionInput = {
      entryProtocol: Formats.OpenAIResponse,
      model: asString(get(body, "model")),
      body,
      alt: compact ? "responses/compact" : "",
      request,
    };

    if (!compact && streamField === true) {
      return yield* streamResponse(executeStream(input), {
        framer: responsesFramer({
          codexClient: isCodexResponsesClient(new Headers(request.headers)),
        }),
        onError,
        keepAliveSeconds: config.requests.streaming["keepalive-seconds"],
      });
    }

    const result = yield* Effect.result(executeNonStream(input));

    if (Result.isFailure(result)) return onError(result.failure);

    return jsonResponse(result.success.payload, result.success.headers);
  });

const ROUTES = [
  ["/v1/responses", false],
  ["/v1/responses/compact", true],
  ["/responses", false],
  ["/responses/compact", true],
  ["/backend-api/codex/responses", false],
  ["/backend-api/codex/responses/compact", true],
] as const;

const SOCKET_ROUTES = ["/v1/responses", "/responses", "/backend-api/codex/responses"] as const;

/** Route layer; requires the {@link ClientApiServices} and `AccessPrincipal` (see `handlers/layer.ts`). */
export const ResponsesRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* routeServices<ClientApiServices>();

    for (const [path, compact] of ROUTES)
      yield* router.add("POST", path, Effect.provide(handle(compact), services));

    // The Responses WebSocket (`Upgrade: websocket`), see websocket/routes.ts.
    for (const path of SOCKET_ROUTES)
      yield* router.add("GET", path, Effect.provide(handleResponsesSocket, services));
  }),
);
