/**
 * `/v9/management/spend` (`SpendGroup` in @commissary/contract/spend): Spend limits and the org's calendar (issue #71).
 * Workers addition, no Go counterpart. The limits are the ControlPlane's org-wide base's (`@commissary/state/spend`):
 * model attempts and tool calls count toward them (#199), so their routes are the app Worker's, like the API keys'.
 *
 * Any member of the org may use `GET /spend` and the limit routes (`policy.ts`); the ControlPlane's
 * `SpendService` decides what the caller sees and writes: an org admin (or a platform admin) every limit, a plain
 * member the limits that bind them and limits on their own API keys. The calendar (`PATCH /spend/settings`) is
 * for org admins. An edit names the limit's revision in `If-Match`; a stale one is `409 conflict`.
 */
import { Effect, Schema } from "effect";
import { HttpRouter, type HttpServerResponse } from "effect/http";
import { AccessPrincipal, currentViewer } from "@commissary/auth";
import type {
  SpendEntry,
  SpendServiceErrorCode,
  SpendServiceResult,
} from "@commissary/state/spend";
import {
  CreateSpendLimit,
  type SpendLimitView,
  UpdateSpendLimit,
  UpdateSpendSettings,
} from "@commissary/contract/spend";
import { handled, ifMatch, jsonReply, type Reply, replyError } from "@commissary/core";
import { bodyJson, controlPlane } from "@commissary/state";

const BASE = "/v9/management";

const STATUS: Readonly<Record<SpendServiceErrorCode, readonly [number, string]>> = {
  invalid: [422, "invalid_limit"],
  conflict: [409, "conflict"],
  not_found: [404, "not_found"],
  exceeds_admin_limit: [422, "exceeds_admin_limit"],
  forbidden: [403, "forbidden"],
  subject_not_found: [404, "subject_not_found"],
};

const iso = (ms: number): string => new Date(ms).toISOString();

const view = (entry: SpendEntry): SpendLimitView => ({
  id: entry.id,
  kind: entry.kind,
  subject: entry.subject,
  label: entry.label,
  period: entry.period,
  amount_micros: entry.amountMicros,
  source: entry.source,
  revision: entry.revision,
  spent_micros: entry.spentMicros,
  remaining_micros: Math.max(0, entry.amountMicros - entry.spentMicros),
  period_start: iso(entry.periodStart),
  resets_at: iso(entry.resetsAt),
  editable: entry.editable,
  updated_at: iso(entry.updatedAt),
  updated_by: entry.updatedBy,
});

const orRefuse = <A>(result: SpendServiceResult<A>): Effect.Effect<A, Reply> => {
  if (result.ok) return Effect.succeed(result.value);
  const [status, code] = STATUS[result.error];

  return Effect.fail(replyError(status, code, { message: result.message }));
};

const decode = <S extends Schema.Decoder<unknown>>(schema: S) =>
  bodyJson.pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(() => replyError(400, "invalid body")),
      ),
    ),
  );

const idParam = Effect.gen(function* () {
  const { id } = yield* HttpRouter.params;

  return id ?? "";
});

const overview = Effect.gen(function* () {
  const viewer = yield* currentViewer;

  const spend = yield* controlPlane("spendOverview", (stub) => stub.spendOverview(viewer));

  return jsonReply(200, {
    time_zone: spend.settings.timeZone,
    week_start: spend.settings.weekStart,
    now: iso(spend.now),
    limits: spend.entries.map(view),
  });
});

const create = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const { principalId } = yield* AccessPrincipal;
  const input = yield* decode(CreateSpendLimit);

  const result = yield* controlPlane("createSpendLimit", (stub) =>
    stub.createSpendLimit(
      viewer,
      {
        kind: input.kind,
        subject: input.subject,
        period: input.period,
        amountMicros: input.amount_micros,
      },
      principalId,
    ),
  );

  return jsonReply(201, view(yield* orRefuse(result)));
});

const update = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const { principalId } = yield* AccessPrincipal;
  const id = yield* idParam;
  const revision = yield* ifMatch;
  const input = yield* decode(UpdateSpendLimit);

  const result = yield* controlPlane("updateSpendLimit", (stub) =>
    stub.updateSpendLimit(viewer, id, revision, input.amount_micros, principalId),
  );

  return jsonReply(200, view(yield* orRefuse(result)));
});

const remove = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const id = yield* idParam;
  const revision = yield* ifMatch;

  const result = yield* controlPlane("removeSpendLimit", (stub) =>
    stub.removeSpendLimit(viewer, id, revision),
  );

  return jsonReply(200, view(yield* orRefuse(result)));
});

const settings = Effect.gen(function* () {
  const input = yield* decode(UpdateSpendSettings);

  const result = yield* controlPlane("setSpendSettings", (stub) =>
    stub.setSpendSettings({
      ...(input.time_zone === undefined ? {} : { timeZone: input.time_zone }),
      ...(input.week_start === undefined ? {} : { weekStart: input.week_start }),
    }),
  );

  if (!result.ok) return yield* replyError(422, "invalid_settings", { message: result.message });

  return jsonReply(200, { time_zone: result.value.timeZone, week_start: result.value.weekStart });
});

const route = <R>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Reply, R>,
) => HttpRouter.route(method, `${BASE}${path}`, handled(handler));

export const spendRoutes = [
  route("GET", "/spend", overview),
  route("POST", "/spend/limits", create),
  route("PUT", "/spend/limits/:id", update),
  route("DELETE", "/spend/limits/:id", remove),
  route("PATCH", "/spend/settings", settings),
];
