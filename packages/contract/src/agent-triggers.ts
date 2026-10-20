/**
 * Triggers of a hosted agent (`/v9/management/agents/:id/triggers`; `packages/agents/src/management/trigger-routes.ts`;
 * ADR 0040, #231): what starts runs of an agent besides chat. A **trigger** belongs to one agent and has a kind, a name,
 * whether it is enabled, and an input; schedules and webhooks are the kinds configured on an agent (chat, and the agents
 * toolkit's calls, are always on for whoever may use the agent). Shared with the browser: imports `effect`, `./config.ts`
 * and `./errors.ts` only.
 *
 * - A **schedule** has a cron expression (five fields: minute, hour, day of month, month, day of week) and an IANA time
 *   zone, and a fixed input. Each tick starts a run; a tick while the agent or the trigger is disabled is skipped, not
 *   caught up.
 * - A **webhook** has an unguessable URL on the API host (`url`) and a secret of its own, shown once when it is created
 *   or rotated (`secret`). A delivery proves itself with `Authorization: Bearer <secret>` or with
 *   `X-Commissary-Delivery: <id>`, `X-Commissary-Timestamp: <unix seconds>` and `X-Commissary-Signature: sha256=<hex>`
 *   (HMAC-SHA256 of `<id>.<timestamp>.<raw body>` under the secret; the timestamp within five minutes of now). It names
 *   its id in `X-Commissary-Delivery` (or, as a bearer, Standard Webhooks' `Webhook-Id`), so a resent delivery starts
 *   no second run. Its input
 *   is `input` with `{{body}}` replaced by the body, or the body alone without one.
 *
 * Only the agent's manager (a private agent's member, an org admin for a shared agent) sees and changes its triggers.
 * A run a trigger starts records its trigger kind and its trigger (`trigger`, `trigger_id` of a run): a private agent's
 * counts as started by its member, a shared agent's as started by no one. Writes name the trigger's revision in
 * `If-Match`. Without the deployment's Agents area (the `LOADER` binding) every route here answers 404.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Revision } from "./config.ts";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/**
 * The trigger kinds configured on an agent (GLOSSARY "Trigger kind"). A later kind (email; another service's events,
 * listening through a toolkit's credential) adds its literal here and its fields to {@link CreateTrigger}.
 */
export const ConfiguredTriggerKind = Schema.Literals(["schedule", "webhook"]);

export type ConfiguredTriggerKind = typeof ConfiguredTriggerKind.Type;

/** What `{{body}}` in a webhook's input is replaced with. */
export const WEBHOOK_BODY_PLACEHOLDER = "{{body}}";

/** The most a webhook delivery's body may be: 1 MiB (`413 body_too_large` above). */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** A schedule: a five-field cron expression, read in an IANA time zone (`Europe/Berlin`, `UTC`). */
export const TriggerSchedule = Schema.Struct({
  cron: Schema.String,
  time_zone: Schema.String,
});

export type TriggerSchedule = typeof TriggerSchedule.Type;

/** A trigger as its agent's manager sees it. */
export const TriggerView = Schema.Struct({
  id: Schema.String,
  agent_id: Schema.String,
  kind: ConfiguredTriggerKind,
  /** 1 to 100 characters. */
  name: Schema.String,
  enabled: Schema.Boolean,
  /** A schedule's fixed input, or a webhook's template (none: the body alone). */
  input: optional(Schema.String),
  /** A schedule's, with its next tick (none while the trigger or its agent is disabled). */
  schedule: optional(
    Schema.Struct({ ...TriggerSchedule.fields, next_at: optional(Schema.String) }),
  ),
  /** A webhook's URL, where deliveries are sent. */
  webhook: optional(Schema.Struct({ url: Schema.String })),
  revision: Revision,
  created_at: Schema.String,
  updated_at: Schema.String,
});

export type TriggerView = typeof TriggerView.Type;

/** `GET /agents/:id/triggers`: the agent's triggers, oldest first. */
export const TriggersList = Schema.Struct({ triggers: Schema.Array(TriggerView) });

export type TriggersList = typeof TriggersList.Type;

/** `POST /agents/:id/triggers` of a schedule: its fixed input is required. */
export const CreateScheduleTrigger = Schema.Struct({
  kind: Schema.Literal("schedule"),
  name: Schema.String,
  /** Default: enabled. */
  enabled: optional(Schema.Boolean),
  /** At most 65,536 characters. */
  input: Schema.String,
  schedule: TriggerSchedule,
});

/** `POST /agents/:id/triggers` of a webhook: its input template is optional. */
export const CreateWebhookTrigger = Schema.Struct({
  kind: Schema.Literal("webhook"),
  name: Schema.String,
  enabled: optional(Schema.Boolean),
  /** At most 65,536 characters; `{{body}}` is replaced by the delivery's body. */
  input: optional(Schema.String),
});

export const CreateTrigger = Schema.Union([CreateScheduleTrigger, CreateWebhookTrigger]);

export type CreateTrigger = typeof CreateTrigger.Type;

/**
 * `PATCH /agents/:id/triggers/:trigger`: the fields to change (at least one). `input: null` clears a webhook's template;
 * `schedule` is a schedule's only.
 */
export const UpdateTrigger = Schema.Struct({
  name: optional(Schema.String),
  enabled: optional(Schema.Boolean),
  input: optional(Schema.NullOr(Schema.String)),
  schedule: optional(TriggerSchedule),
});

export type UpdateTrigger = typeof UpdateTrigger.Type;

/** A created trigger, or a webhook whose secret was rotated: a webhook's secret is shown here, and never again. */
export const CreatedTrigger = Schema.Struct({
  ...TriggerView.fields,
  secret: optional(Schema.String),
});

export type CreatedTrigger = typeof CreatedTrigger.Type;

export const RemovedTrigger = Schema.Struct({ id: Schema.String, removed: Schema.Literal(true) });

export type RemovedTrigger = typeof RemovedTrigger.Type;

/** `202` of a webhook delivery: the run it started, or the one its delivery id started before. */
export const WebhookDelivered = Schema.Struct({ run: Schema.String });

export type WebhookDelivered = typeof WebhookDelivered.Type;

const IfMatch = { headers: Schema.Struct({ "if-match": Schema.String }) };

const triggerParams = { params: { id: Schema.String, trigger: Schema.String } };

export class AgentTriggersGroup extends HttpApiGroup.make("agentTriggers").add(
  /** `404 not_found` for an agent the caller does not manage. */
  HttpApiEndpoint.get("list", "/agents/:id/triggers", {
    params: { id: Schema.String },
    success: TriggersList,
    error: managementErrors,
  }),
  /**
   * `422 invalid` (a name, an input, a cron expression or a time zone), `404 not_found` for an agent the caller does not
   * manage, `403 forbidden` for an org admin's view of another member's private agent.
   */
  HttpApiEndpoint.post("create", "/agents/:id/triggers", {
    params: { id: Schema.String },
    payload: CreateTrigger,
    success: CreatedTrigger.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /** As `create`'s refusals, and `409 conflict` for a stale revision. */
  HttpApiEndpoint.patch("update", "/agents/:id/triggers/:trigger", {
    ...triggerParams,
    ...IfMatch,
    payload: UpdateTrigger,
    success: TriggerView,
    error: managementErrors,
  }),
  HttpApiEndpoint.delete("remove", "/agents/:id/triggers/:trigger", {
    ...triggerParams,
    ...IfMatch,
    success: RemovedTrigger,
    error: managementErrors,
  }),
  /** A webhook's new secret, shown once; the old one stops working at once. `422 invalid` for a schedule. */
  HttpApiEndpoint.post("rotateSecret", "/agents/:id/triggers/:trigger/secret", {
    ...triggerParams,
    ...IfMatch,
    success: CreatedTrigger,
    error: managementErrors,
  }),
) {}
