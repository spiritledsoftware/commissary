/**
 * `GET /v9/management/routing/models`: which credentials serve each model clients can call, and the channel rules
 * (aliases, exclusions, write-ins) that shape it. No Go counterpart (the Go panel has no such view); see `routingView`.
 *
 * Built from a fresh registry snapshot (`ModelRegistry.fresh`: config re-read, no 5 s cache), so a rule edit shows on
 * the next read. The cost is one config check, one `listModelSources` RPC and a pure pass over the credentials, plus
 * the `configEntries` RPC for the revision of each channel's rules. The revisions are read first: when a write lands
 * in between, the view shows newer rules than its revisions, and an edit of that channel answers 409 (re-read) rather
 * than overwriting a change the view did not show.
 */
import { Clock, Effect } from "effect";
import { AccessPrincipal } from "@commissary/auth";
import { routingView } from "../registry/routing-view.ts";
import { ModelRegistry } from "../registry/service.ts";
import { currentAuthIndexer } from "./auth-index.ts";
import { handled, jsonReply, replyError } from "@commissary/core";
import { modelsControlPlane } from "../env.ts";

const routingModels = Effect.gen(function* () {
  const registry = yield* ModelRegistry;

  const entries = yield* modelsControlPlane("configEntries", (stub) =>
    stub.models().configEntries(),
  );

  const snapshot = yield* registry.fresh.pipe(
    Effect.catch((error) =>
      Effect.logError(`routing/models: registry build failed: ${error.message}`).pipe(
        Effect.andThen(Effect.fail(replyError(502, "model registry unavailable"))),
      ),
    ),
  );

  const now = yield* Clock.currentTimeMillis;
  const identity = yield* AccessPrincipal;

  return jsonReply(200, {
    // An org admin sees no model of another member's private credential (ADR 0023).
    ...routingView(snapshot.visibleTo(identity.memberId), now, yield* currentAuthIndexer),
    revisions: {
      aliases: entries.revisions.aliases,
      exclusions: entries.revisions.exclusions,
      write_ins: entries.revisions.writeIns,
    },
  });
});

export const routingModelsHandler = handled(routingModels);
