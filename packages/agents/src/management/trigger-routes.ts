/**
 * Triggers of hosted agents on the management API (`AgentTriggersGroup` in `@commissary/contract/agent-triggers`, #231,
 * ADR 0040): list an agent's triggers, add one, edit it (enabling and disabling it among the edits), remove it, and
 * rotate a webhook's secret, which the answer shows once. Only the agent's manager reaches them (the Agents part
 * decides: a private agent's member, an org admin for a shared agent).
 *
 * A schedule's ticks are its own object's alarms (`AGENT_SCHEDULE`, `triggers/schedule-object.ts`), which this Worker
 * reaches by the API Worker's script name: adding a schedule, enabling it or changing its schedule arms its object with
 * the next tick, and removing it deletes the object (`sweepRetiredSchedules`, which also deletes the objects of
 * schedules gone with their agent or member). A schedule whose object cannot be armed is not added (the route
 * removes it again and answers `502`); an edit whose arming fails answers `502` and is kept, to be armed by the next
 * edit or enabling. A webhook's URL is on the API host (`API_DOMAIN`), or on this request's host where the client API
 * answers on the app host (zone routes).
 *
 * Like every Agents route, each answers 404 without the deployment's Dynamic Workers binding (`LOADER`).
 */
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { AccessPrincipal, currentViewer } from "@commissary/auth";
import { CreateTrigger, UpdateTrigger } from "@commissary/contract/agent-triggers";
import { CurrentOrg, ifMatch, jsonReply, replyError } from "@commissary/core";
import { callControlPlane } from "@commissary/state";
import { agentScheduleOf, agentsControlPlane, AgentsEnv } from "../env.ts";
import { sweepRetiredSchedules } from "../org-deletion.ts";
import type { TriggerRequest, TriggersErrorCode, TriggersRequest } from "../triggers/triggers.ts";
import { decode, orRefuseWith, param, route } from "./http.ts";

const orRefuse = orRefuseWith<TriggersErrorCode>({
  invalid: 422,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
});

/** Where webhooks' URLs start: the API host, else this request's origin (the client API's zone routes). */
const clientApiOrigin = Effect.gen(function* () {
  const host = (yield* AgentsEnv).API_DOMAIN?.trim().toLowerCase() ?? "";

  if (host !== "") return `https://${host}`;
  const request = yield* HttpServerRequest.HttpServerRequest;

  return new URL(request.originalUrl, `https://${request.headers["host"] ?? "localhost"}`).origin;
});

/** Arms the schedule `trigger`'s object with its next tick (none while disabled); a failure answers `502`. */
const arm = (trigger: string) =>
  Effect.gen(function* () {
    const org = yield* CurrentOrg;
    const stub = agentScheduleOf(yield* AgentsEnv, org, trigger);

    return yield* callControlPlane("agent schedule arm", stub, (object) =>
      object.arm({ org, trigger }),
    );
  });

const NOT_ARMED = replyError(502, "schedule_not_armed", {
  message: "the schedule's object could not be reached: edit or enable the trigger again",
});

/** The call on the agent the path names, as the caller makes it. */
const triggersRequest = Effect.gen(function* () {
  return {
    viewer: yield* currentViewer,
    agentId: yield* param("id"),
    origin: yield* clientApiOrigin,
    by: (yield* AccessPrincipal).principalId,
  } satisfies TriggersRequest;
});

/** The call on the trigger the path names, at the revision `If-Match` names. */
const triggerRequest = Effect.gen(function* () {
  return {
    ...(yield* triggersRequest),
    triggerId: yield* param("trigger"),
    revision: yield* ifMatch,
  } satisfies TriggerRequest;
});

/** Deletes the objects of the org's schedules that are gone (best effort: `sweepRetiredSchedules`). */
const sweep = Effect.gen(function* () {
  yield* sweepRetiredSchedules(yield* AgentsEnv, yield* CurrentOrg);
});

const list = Effect.gen(function* () {
  const request = yield* triggersRequest;

  return jsonReply(
    200,
    yield* orRefuse(
      yield* agentsControlPlane("listTriggers", (stub) => stub.agents().listTriggers(request)),
    ),
  );
});

const create = Effect.gen(function* () {
  const request = yield* triggersRequest;
  const input = yield* decode(CreateTrigger);

  const created = yield* orRefuse(
    yield* agentsControlPlane("createTrigger", (stub) =>
      stub.agents().createTrigger(request, input),
    ),
  );

  if (created.kind === "schedule") {
    // A schedule that never ticks would look added: it is removed again, and nothing was added.
    const armed = yield* arm(created.id).pipe(Effect.option);

    if (Option.isNone(armed) || !armed.value.ok) {
      yield* agentsControlPlane("removeTrigger", (stub) =>
        stub.agents().removeTrigger({
          ...request,
          triggerId: created.id,
          revision: created.revision,
        }),
      ).pipe(Effect.ignore);
      yield* sweep;

      return yield* NOT_ARMED;
    }
  }

  return jsonReply(201, created);
});

const update = Effect.gen(function* () {
  const request = yield* triggerRequest;
  const input = yield* decode(UpdateTrigger);

  const updated = yield* orRefuse(
    yield* agentsControlPlane("updateTrigger", (stub) =>
      stub.agents().updateTrigger(request, input),
    ),
  );

  if (
    updated.kind === "schedule" &&
    (input.enabled !== undefined || input.schedule !== undefined)
  ) {
    const armed = yield* arm(request.triggerId).pipe(Effect.option);

    if (Option.isNone(armed) || !armed.value.ok) return yield* NOT_ARMED;
  }

  return jsonReply(200, updated);
});

const remove = Effect.gen(function* () {
  const request = yield* triggerRequest;

  const removed = yield* orRefuse(
    yield* agentsControlPlane("removeTrigger", (stub) => stub.agents().removeTrigger(request)),
  );

  // Its object would find it gone at its next alarm; deleted now, it keeps nothing until then.
  if (removed.kind === "schedule") yield* sweep;

  return jsonReply(200, { id: removed.id, removed: removed.removed });
});

const rotate = Effect.gen(function* () {
  const request = yield* triggerRequest;

  return jsonReply(
    200,
    yield* orRefuse(
      yield* agentsControlPlane("rotateTriggerSecret", (stub) =>
        stub.agents().rotateTriggerSecret(request),
      ),
    ),
  );
});

/** The trigger routes (mounted by `managementRoutes`, `routes.ts`). */
export const triggerRoutes = HttpRouter.addAll([
  route("GET", "/agents/:id/triggers", list),
  route("POST", "/agents/:id/triggers", create),
  route("PATCH", "/agents/:id/triggers/:trigger", update),
  route("DELETE", "/agents/:id/triggers/:trigger", remove),
  route("POST", "/agents/:id/triggers/:trigger/secret", rotate),
]);
