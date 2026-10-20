/**
 * `POST /webhooks/polar`: the billing provider's webhooks (#237), on the app host, public (no session or key: the
 * signature is the credential, checked by the provider, `polar.ts`). Commissary Cloud with Polar's settings only;
 * elsewhere it answers like a path the router does not know. New in the Workers port, no Go counterpart.
 *
 * A verified change of an org's subscription is applied to its Billing part (`BillingStore.applySubscription`, which
 * ignores what is late or repeated) and the isolate forgets what it cached of the org's billing, so the change applies
 * here at once and in other isolates within `BILLING_TTL_MS`. The answer is `200` as soon as that is stored; an org the
 * registry does not know (deleted) and events Billing does not act on are acknowledged and ignored; a Billing part that
 * cannot be reached answers `503` so Polar delivers the webhook again. An unsigned or wrongly signed webhook is `401`.
 */
import { Clock, Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { isHosted } from "@commissary/auth";
import { boundedBodyText, handled, jsonReply, OrgId, replyError } from "@commissary/core";
import { platformOf } from "@commissary/state";
import { forgetBilling } from "./cache.ts";
import { BillingEnv, callPart } from "./env.ts";
import { BillingProviders } from "./providers.ts";
import { routeNotFound } from "./routes.ts";

export const POLAR_WEBHOOK_PATH = "/webhooks/polar";

/** Polar's webhook bodies are a few kilobytes; anything far larger is not one. */
const MAX_WEBHOOK_BYTES = 256 * 1024;

const received = jsonReply(200, { received: true });

const isOrgId = Schema.is(OrgId);

const webhook = Effect.gen(function* () {
  const env = yield* BillingEnv;
  const provider = isHosted(env) ? (yield* BillingProviders)(env) : undefined;
  const verifyWebhook = provider?.verifyWebhook;

  if (verifyWebhook === undefined) return yield* routeNotFound;

  return yield* handled(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* boundedBodyText(MAX_WEBHOOK_BYTES);
      const now = yield* Clock.currentTimeMillis;

      const read = yield* verifyWebhook({ headers: request.headers, body }, now).pipe(
        Effect.catchTag("WebhookRefused", (refused) =>
          Effect.logWarning(`billing webhook refused: ${refused.message}`).pipe(
            Effect.andThen(Effect.fail(replyError(401, "invalid_signature"))),
          ),
        ),
      );

      if (read.kind === "ignored") return received;
      const { org, change } = read;

      const known = isOrgId(org)
        ? yield* Effect.tryPromise(async () => await platformOf(env).getOrgById(org)).pipe(
            Effect.catch((error) =>
              Effect.logError(`billing webhook: registry not reached: ${error.message}`).pipe(
                Effect.andThen(Effect.fail(replyError(503, "unavailable"))),
              ),
            ),
          )
        : undefined;

      if (known === undefined) {
        yield* Effect.logWarning("billing webhook for an org that does not exist; ignored");

        return received;
      }

      const changed = yield* callPart(env, known.id, "subscription", (part) =>
        part.applySubscription(change),
      ).pipe(
        Effect.catchTag("BillingPartUnavailable", (error) =>
          Effect.logError(error.message).pipe(
            Effect.andThen(Effect.fail(replyError(503, "unavailable"))),
          ),
        ),
      );

      if (changed) {
        forgetBilling(known.id);
        yield* Effect.logInfo(`billing: subscription ${change.status}`).pipe(
          Effect.annotateLogs({ org: known.id }),
        );
      }

      return received;
    }),
  );
});

export const BillingWebhookRoutes = HttpRouter.add("POST", POLAR_WEBHOOK_PATH, webhook);
