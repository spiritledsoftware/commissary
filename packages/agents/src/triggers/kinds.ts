/**
 * What each configured trigger kind (#231) brings, in one table ({@link TRIGGER_KINDS}): whether its input is required,
 * whether it has a secret or a Durable Object of its own, its stored config from what a creation or an edit names, and
 * its own fields in a view and in the org export. `Triggers` (`triggers.ts`) reads the kind's rules from here and knows
 * no kind by name but in the ways in: a schedule's alarm and a webhook's deliveries.
 */
import type {
  ConfiguredTriggerKind,
  TriggerSchedule,
  TriggerView,
} from "@commissary/contract/agent-triggers";
import { Result } from "effect";
import { iso, ok, type Refusable, refuse } from "../result.ts";
import { nextTick, parseSchedule, type ScheduleSpec } from "./schedule.ts";
import type { TriggerConfig } from "./store.ts";

/** What a creation or an edit names of a kind's own fields: a schedule's schedule. */
export interface KindFields {
  readonly schedule?: TriggerSchedule | undefined;
}

/** What a view of a trigger needs beyond its config. */
export interface ViewContext {
  /** Whether it is live: it and its agent enabled (a schedule shows its next tick then). */
  readonly live: boolean;
  /** Epoch ms. */
  readonly now: number;
  /** A webhook's URL. */
  readonly url: string;
}

/** A trigger's own fields in the org export: never a secret. */
export interface KindExport {
  readonly schedule?: { readonly cron: string; readonly time_zone: string };
}

export interface TriggerKindRules {
  /** Whether its input is required (a schedule's message) rather than optional (a webhook's template). */
  readonly inputRequired: boolean;
  /** Why an empty input is refused. */
  readonly emptyInput: string;
  /** Whether it has a secret (a webhook's), made on creation and rotated on demand. */
  readonly secret: boolean;
  /** Whether it has a Durable Object of its own (a schedule's, `schedule-object.ts`). */
  readonly object: boolean;
  /** Its config from `fields` (over `current`, an edit's), or why they are refused. */
  readonly config: (
    fields: KindFields,
    current: TriggerConfig | undefined,
  ) => Refusable<"invalid", TriggerConfig>;
  /** Its own fields in a view. */
  readonly view: (
    config: TriggerConfig,
    context: ViewContext,
  ) => Pick<TriggerView, "schedule" | "webhook">;
  /** Its own fields in the org export. */
  readonly exported: (config: TriggerConfig) => KindExport;
}

/** A schedule config's spec; `undefined` for another kind's. */
export const scheduleSpec = (config: TriggerConfig): ScheduleSpec | undefined =>
  config.kind === "schedule" ? { cron: config.cron, timeZone: config.timeZone } : undefined;

/** A schedule as stored, or why it is refused. */
const scheduleConfig = (schedule: TriggerSchedule): Refusable<"invalid", TriggerConfig> => {
  const spec = { cron: schedule.cron.trim(), timeZone: schedule.time_zone.trim() };
  const parsed = parseSchedule(spec);

  return Result.isFailure(parsed)
    ? refuse("invalid", parsed.failure)
    : ok({ kind: "schedule", cron: spec.cron, timeZone: spec.timeZone });
};

export const TRIGGER_KINDS = {
  schedule: {
    inputRequired: true,
    emptyInput: "a schedule's input is not empty",
    secret: false,
    object: true,
    config: (fields, current) => {
      if (fields.schedule !== undefined) return scheduleConfig(fields.schedule);

      return current?.kind === "schedule"
        ? ok(current)
        : refuse("invalid", "a schedule names its schedule");
    },
    view: (config, { live, now }) => {
      const spec = scheduleSpec(config);

      if (spec === undefined) return {};
      const next = live ? nextTick(spec, now) : undefined;

      return {
        schedule: {
          cron: spec.cron,
          time_zone: spec.timeZone,
          ...(next === undefined ? {} : { next_at: iso(next) }),
        },
      };
    },
    exported: (config) => {
      const spec = scheduleSpec(config);

      return spec === undefined ? {} : { schedule: { cron: spec.cron, time_zone: spec.timeZone } };
    },
  },
  webhook: {
    inputRequired: false,
    emptyInput: "a webhook's input template, when it has one, is not empty",
    secret: true,
    object: false,
    config: (fields) =>
      fields.schedule === undefined
        ? ok({ kind: "webhook" })
        : refuse("invalid", "only a schedule has a schedule"),
    view: (_config, { url }) => ({ webhook: { url } }),
    exported: () => ({}),
  },
} as const satisfies { readonly [K in ConfiguredTriggerKind]: TriggerKindRules };
