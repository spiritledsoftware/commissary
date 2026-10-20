/**
 * Webhook triggers' deliveries on the API Worker (#231, ADR 0040): `POST /agent-webhooks/<org>/<trigger>`, a client API
 * path (`AGENT_WEBHOOK_PREFIX`) open to anyone, which proves itself with the trigger's secret instead of an API key.
 *
 * In this order, so a request that proves nothing costs little: a malformed address answers `401` before the body is
 * read; the Platform registry must know the org (as for an API key, so a made-up org id never instantiates a
 * ControlPlane), else `401`; on Commissary Cloud every delivery to a known org, proven or not, counts against the org's
 * webhook bucket (`limits.attempt`, the API Worker's `limitWebhookAttempts`: the size of its ceiling, apart from it)
 * before the org's ControlPlane is asked anything, so a flood of unproven deliveries is refused there (`429`) instead of
 * loading it, and never uses up the ceiling the org's API keys count against; the body is at most 1 MiB (`413
 * body_too_large`); then the ControlPlane checks the proof (the secret is sealed there and never leaves it):
 * `Authorization: Bearer <secret>`, or `X-Commissary-Delivery: <id>`, `X-Commissary-Timestamp: <unix seconds>` and
 * `X-Commissary-Signature: sha256=<hex>`, an HMAC-SHA256 of `<id>.<timestamp>.<raw body>` under the secret, the
 * timestamp within five minutes of now. An unknown trigger and a wrong or stale proof answer the same `401`. A proven
 * delivery counts against the org's request-rate ceiling (`limits.proven`, its `limitClientRate`), as an API key's
 * request does.
 *
 * Its run is keyed by its delivery id (`X-Commissary-Delivery`, which a signature signs, or Standard Webhooks'
 * `Webhook-Id`), else by its body's hash and minute, so a delivery sent again finds the run it started (a bearer
 * delivery without an id: identical bodies within a minute are one delivery, and a retry in the next minute starts a
 * second run). The run's first turn is the trigger's template
 * with `{{body}}` replaced by the body, or the body alone. It answers `202` with the run's id once the run's object took
 * that turn, and never waits for the run's answer. A disabled trigger or agent answers `409`.
 */
import { Clock, Effect, Result, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { accessErrorResponse, orgExists, refusalResponse } from "@commissary/auth";
import { MAX_WEBHOOK_BODY_BYTES } from "@commissary/contract/agent-triggers";
import {
  AGENT_WEBHOOK_PREFIX,
  jsonReply,
  OrgId,
  type RateLimitedError,
  Reply,
  replyError,
} from "@commissary/core";
import { callControlPlane, controlPlaneOf } from "@commissary/state";
import { type AgentsControlPlaneStub, AgentsEnv, agentRunOf } from "../env.ts";
import type { RunsResult } from "../runs/runs.ts";
import { isTriggerId } from "./store.ts";
import {
  DELIVERY_ID_HEADERS,
  deliveryKey,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  webhookInput,
} from "./webhook.ts";

const isOrgId = Schema.is(OrgId);

/** The one answer to a delivery that does not prove itself, whatever was wrong. */
const UNAUTHORIZED = refusalResponse(401, "Unauthorized");

const tooLarge = replyError(413, "body_too_large", {
  message: `a webhook delivery's body is at most ${MAX_WEBHOOK_BODY_BYTES} bytes`,
});

/** The raw body, at most {@link MAX_WEBHOOK_BODY_BYTES}: a larger one is refused before or while it is read. */
const boundedBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  if (Number(request.headers["content-length"] ?? 0) > MAX_WEBHOOK_BODY_BYTES)
    return yield* Effect.fail(tooLarge);

  const chunks: Array<Uint8Array> = [];
  let read = 0;

  yield* request.stream.pipe(
    Stream.mapError(() => replyError(400, "invalid body")),
    Stream.runForEach((chunk) => {
      read += chunk.byteLength;

      if (read > MAX_WEBHOOK_BODY_BYTES) return Effect.fail(tooLarge);
      chunks.push(chunk);

      return Effect.void;
    }),
  );

  const body = new Uint8Array(read);
  let at = 0;

  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }

  return body;
});

/**
 * What a refused start of the run answers: a disabled trigger or agent `409`; a trigger removed since the delivery was
 * proven `401`, as an unknown one.
 */
const refusal = (result: Extract<RunsResult<unknown>, { ok: false }>): Reply => {
  switch (result.error) {
    case "agent_disabled":
    case "trigger_disabled":
      return replyError(409, result.error, { message: result.message });
    case "not_found":
      return new Reply({ response: UNAUTHORIZED });
    default:
      return replyError(502, "run unavailable", { message: result.message });
  }
};

/** How the route counts deliveries (nothing on a self-hosted Commissary). */
export interface WebhookLimits<R> {
  /** Every delivery to a known org, before its proof is checked: the org's webhook bucket. */
  readonly attempt: (org: OrgId) => Effect.Effect<void, RateLimitedError, R>;
  /** A proven delivery: the org's request-rate ceiling, with its API keys' requests. */
  readonly proven: (org: OrgId) => Effect.Effect<void, RateLimitedError, R>;
}

/** The webhook delivery route, counting deliveries with `limits` (the API Worker's, from Billing). */
export const webhookRoutes = <R>(limits: WebhookLimits<R>) =>
  HttpRouter.add(
    "POST",
    `${AGENT_WEBHOOK_PREFIX}/:org/:trigger`,
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const org = params["org"] ?? "";
      const trigger = params["trigger"] ?? "";

      if (!isOrgId(org) || !isTriggerId(trigger)) return UNAUTHORIZED;
      const now = yield* Clock.currentTimeMillis;

      // As for an API key: a made-up org id never instantiates a ControlPlane (the registry's answer is cached).
      const exists = yield* orgExists(org, now).pipe(
        Effect.mapError(() => replyError(503, "unavailable")),
      );

      if (!exists) return UNAUTHORIZED;

      // Every delivery to the org counts against its webhook bucket, before its ControlPlane is asked to check the proof.
      const attempted = yield* Effect.result(limits.attempt(org));

      if (Result.isFailure(attempted)) return yield* accessErrorResponse(attempted.failure);
      const body = yield* boundedBody;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const env = yield* AgentsEnv;
      const stub: AgentsControlPlaneStub = controlPlaneOf(env, org);

      const check = yield* callControlPlane("verifyWebhook", stub, (cp) =>
        cp.agents().verifyWebhook(
          trigger,
          {
            authorization: request.headers["authorization"],
            signature: request.headers[SIGNATURE_HEADER],
            timestamp: request.headers[TIMESTAMP_HEADER],
            delivery: request.headers[DELIVERY_ID_HEADERS[0]],
          },
          body,
        ),
      );

      if (!check.proven) return UNAUTHORIZED;

      // Proven: the delivery is the org's own, and counts against its ceiling.
      const limited = yield* Effect.result(limits.proven(org));

      if (Result.isFailure(limited)) return yield* accessErrorResponse(limited.failure);

      const input = webhookInput(check.template, new TextDecoder().decode(body));

      if (input.trim() === "")
        return yield* Effect.fail(
          replyError(422, "invalid", { message: "the delivery's input is empty: send a body" }),
        );

      const key = deliveryKey(request.headers, body, now);

      const started = yield* callControlPlane("startWebhookRun", stub, (cp) =>
        cp.agents().startWebhookRun(trigger, key),
      );

      if (!started.ok) return yield* Effect.fail(refusal(started));
      const { run, created } = started.value;

      // The run's first turn; a delivery sent again finds it (the object keys the start), and a run that already ended
      // (its first start failed) stays ended.
      const first = yield* callControlPlane(
        "agent run start",
        agentRunOf(env, org, run.id),
        (object) => object.start({ org, id: run.id }, input),
      ).pipe(
        Effect.tapError(() =>
          created
            ? callControlPlane("abandonTriggeredRun", stub, (cp) =>
                cp.agents().abandonTriggeredRun(run.id),
              ).pipe(Effect.ignore)
            : Effect.void,
        ),
      );

      if (!first.ok && first.error !== "run_ended")
        return yield* Effect.fail(replyError(502, "run unavailable", { message: first.message }));

      return jsonReply(202, { run: run.id });
    }).pipe(
      Effect.catch((reply: Reply) => Effect.succeed(reply.response)),
      Effect.map((response) => HttpServerResponse.setHeader(response, "cache-control", "no-store")),
    ),
  );
