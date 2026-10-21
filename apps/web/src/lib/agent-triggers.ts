// The triggers of an agent's page (#233, ADR 0040, #231): schedules (a five-field cron expression read in a time zone,
// with a readable preview and the next runs) and webhooks (a URL, a secret shown once, an input template with
// `{{body}}`), as the form edits them, what is wrong with a draft, and the bodies a draft becomes. The cron expression
// is read as the server reads it (Effect's `Cron`, five fields, an IANA zone), so what the preview shows is what runs.
// Pure: no DOM, tested in test/agent-triggers.test.ts.
import { Cron, DateTime, Option, Result } from "effect";
import {
  type CreatedTrigger,
  type CreateTrigger,
  type TriggerView,
  type UpdateTrigger,
  WEBHOOK_BODY_PLACEHOLDER,
} from "@commissary/contract/agent-triggers";
import { asSentence } from "./failure.ts";
import type { Outcome } from "./use-action.ts";

export { WEBHOOK_BODY_PLACEHOLDER };

/** The most a trigger's name is. */
export const MAX_NAME = 100;

/** The most a trigger's input is. */
export const MAX_INPUT = 65_536;

// ---------------------------------------------------------------------------------------------------------------
// Cron

/** What a schedule starts as: a few expressions the form offers. */
export const CRON_PRESETS: ReadonlyArray<{ readonly label: string; readonly cron: string }> = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 09:00", cron: "0 9 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 09:00", cron: "0 9 * * 1" },
  { label: "The first of the month", cron: "0 9 1 * *" },
];

const MAX_TEXT = 200;

/** Why a schedule cannot be read, or the cron it is. */
export type ScheduleRead =
  | { readonly ok: true; readonly cron: Cron.Cron }
  | { readonly ok: false; readonly field: "cron" | "timeZone"; readonly problem: string };

/** `cron` read in `timeZone` as the server reads it (`packages/agents/src/triggers/schedule.ts`). */
export const readSchedule = (cron: string, timeZone: string): ScheduleRead => {
  const fields = cron.trim().split(/\s+/);

  if (cron.trim() === "" || cron.length > MAX_TEXT || fields.length !== 5)
    return {
      ok: false,
      field: "cron",
      problem:
        "Five fields: minute, hour, day of month, month and day of week, such as 0 9 * * 1-5.",
    };

  const zone = timeZone.length > MAX_TEXT ? Option.none() : DateTime.zoneMakeNamed(timeZone.trim());

  if (Option.isNone(zone))
    return {
      ok: false,
      field: "timeZone",
      problem: "Type an IANA time zone name such as Europe/Berlin or UTC.",
    };

  const parsed = Cron.parse(cron, zone.value);

  if (Result.isFailure(parsed))
    return {
      ok: false,
      field: "cron",
      problem: `Not a cron expression: ${parsed.failure.message}.`,
    };

  try {
    Cron.next(parsed.success, 0);
  } catch {
    return { ok: false, field: "cron", problem: "No date matches this expression." };
  }

  return { ok: true, cron: parsed.success };
};

/** The next `count` runs of a schedule after `now` (epoch ms), as epoch ms. */
export const nextRuns = (cron: Cron.Cron, now: number, count: number): ReadonlyArray<number> => {
  const runs: Array<number> = [];
  let after = now;

  for (let index = 0; index < count; index += 1) {
    try {
      const at = Cron.next(cron, after).getTime();

      runs.push(at);
      after = at;
    } catch {
      break;
    }
  }

  return runs;
};

/** A run's time in the schedule's own zone, which its row names: "Thu 13 Aug, 09:00". */
export const runText = (epochMs: number, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(epochMs);
  } catch {
    return new Date(epochMs).toISOString();
  }
};

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const NAMES: ReadonlyMap<string, number> = new Map([
  ["sun", 0],
  ["mon", 1],
  ["tue", 2],
  ["wed", 3],
  ["thu", 4],
  ["fri", 5],
  ["sat", 6],
]);

const plain = (field: string): number | undefined => {
  if (!/^\d{1,2}$/.test(field)) return undefined;

  return Number(field);
};

const clock = (hour: number, minute: number): string =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

const ordinal = (day: number): string => {
  const rest = day % 100;

  if (rest >= 11 && rest <= 13) return `${day}th`;

  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
};

/** A day-of-week field as words ("Monday", "Monday to Friday", "Monday, Wednesday"), or `undefined` when it is too odd. */
const weekdays = (field: string): string | undefined => {
  const lower = field.toLowerCase();

  const day = (text: string): number | undefined => {
    const number = plain(text) ?? NAMES.get(text);

    return number === undefined ? undefined : number % 7;
  };

  const range = /^([a-z0-9]+)-([a-z0-9]+)$/.exec(lower);

  if (range !== null) {
    const from = day(range[1] ?? "");
    const to = day(range[2] ?? "");

    return from === undefined || to === undefined
      ? undefined
      : from === 1 && to === 5
        ? "weekday"
        : `${DAYS[from]} to ${DAYS[to]}`;
  }

  const days = lower.split(",").map(day);

  if (days.some((each) => each === undefined) || days.length === 0) return undefined;

  return days.map((each) => DAYS[each ?? 0]).join(", ");
};

/**
 * A cron expression in words for the usual shapes ("Every day at 09:00", "Every weekday at 09:00", "Every 15 minutes");
 * `undefined` for one it will not guess at, which the form then shows with its next runs only.
 */
export const describeCron = (cron: string): string | undefined => {
  const fields = cron.trim().split(/\s+/);

  if (fields.length !== 5) return undefined;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;

  if (fields.every((field) => field === "*")) return "Every minute";

  const step = /^\*\/(\d{1,2})$/.exec(minute);

  if (step !== null && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*")
    return step[1] === "1" ? "Every minute" : `Every ${step[1]} minutes`;

  const atMinute = plain(minute);

  if (atMinute === undefined || atMinute > 59) return undefined;

  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*")
    return atMinute === 0 ? "Every hour, on the hour" : `Every hour at ${atMinute} past`;

  const atHour = plain(hour);

  if (atHour === undefined || atHour > 23) return undefined;

  const at = clock(atHour, atMinute);

  if (dayOfMonth === "*" && month === "*") {
    if (dayOfWeek === "*") return `Every day at ${at}`;
    const days = weekdays(dayOfWeek);

    return days === undefined ? undefined : `Every ${days} at ${at}`;
  }

  const day = plain(dayOfMonth);

  if (day !== undefined && day >= 1 && day <= 31 && dayOfWeek === "*") {
    if (month === "*") return `On the ${ordinal(day)} of every month at ${at}`;
    const named = plain(month);

    return named !== undefined && named >= 1 && named <= 12
      ? `Every ${MONTHS[named - 1]} on the ${ordinal(day)} at ${at}`
      : undefined;
  }

  return undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// The draft

export type TriggerKindChoice = "schedule" | "webhook";

export const TRIGGER_KINDS: ReadonlyArray<{
  readonly id: TriggerKindChoice;
  readonly label: string;
}> = [
  { id: "schedule", label: "Schedule" },
  { id: "webhook", label: "Webhook" },
];

/** A trigger as the form edits it. */
export interface TriggerDraft {
  readonly kind: TriggerKindChoice;
  readonly name: string;
  readonly enabled: boolean;
  /** A schedule's fixed input, or a webhook's template (empty: the body alone). */
  readonly input: string;
  readonly cron: string;
  readonly timeZone: string;
}

/** The browser's own time zone, or UTC where it will not say. */
export const localZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const emptyTrigger = (kind: TriggerKindChoice, timeZone: string): TriggerDraft => ({
  kind,
  name: "",
  enabled: true,
  input: "",
  cron: kind === "schedule" ? "0 9 * * 1-5" : "",
  timeZone,
});

export const draftOfTrigger = (trigger: TriggerView): TriggerDraft => ({
  kind: trigger.kind,
  name: trigger.name,
  enabled: trigger.enabled,
  input: trigger.input ?? "",
  cron: trigger.schedule?.cron ?? "",
  timeZone: trigger.schedule?.time_zone ?? "UTC",
});

export interface TriggerErrors {
  name?: string;
  input?: string;
  cron?: string;
  timeZone?: string;
}

export const hasTriggerErrors = (errors: TriggerErrors): boolean => Object.keys(errors).length > 0;

export const validateTrigger = (draft: TriggerDraft): TriggerErrors => {
  const errors: TriggerErrors = {};
  const name = draft.name.trim();

  if (name === "") errors.name = "A trigger needs a name.";
  else if (name.length > MAX_NAME) errors.name = `At most ${MAX_NAME} characters.`;

  if (draft.input.length > MAX_INPUT)
    errors.input = `At most ${MAX_INPUT.toLocaleString("en")} characters.`;

  if (draft.kind === "schedule") {
    if (draft.input.trim() === "")
      errors.input = "A schedule needs the input each run starts with.";

    const read = readSchedule(draft.cron, draft.timeZone);

    if (!read.ok) errors[read.field] = read.problem;
  }

  return errors;
};

/** What adding a trigger sends. */
export const createTriggerBody = (draft: TriggerDraft): CreateTrigger =>
  draft.kind === "schedule"
    ? {
        kind: "schedule",
        name: draft.name.trim(),
        enabled: draft.enabled,
        input: draft.input,
        schedule: { cron: draft.cron.trim(), time_zone: draft.timeZone.trim() },
      }
    : {
        kind: "webhook",
        name: draft.name.trim(),
        enabled: draft.enabled,
        ...(draft.input === "" ? {} : { input: draft.input }),
      };

/** What editing a trigger sends: only what differs from the stored trigger. */
export const updateTriggerPatch = (trigger: TriggerView, draft: TriggerDraft): UpdateTrigger => {
  const patch: { -readonly [K in keyof UpdateTrigger]: UpdateTrigger[K] } = {};
  const name = draft.name.trim();

  if (name !== trigger.name) patch.name = name;

  if (draft.enabled !== trigger.enabled) patch.enabled = draft.enabled;

  if (draft.input !== (trigger.input ?? ""))
    patch.input = draft.input === "" && trigger.kind === "webhook" ? null : draft.input;

  if (
    trigger.kind === "schedule" &&
    (draft.cron.trim() !== trigger.schedule?.cron ||
      draft.timeZone.trim() !== trigger.schedule?.time_zone)
  )
    patch.schedule = { cron: draft.cron.trim(), time_zone: draft.timeZone.trim() };

  return patch;
};

export const hasTriggerChanges = (patch: UpdateTrigger): boolean => Object.keys(patch).length > 0;

// ---------------------------------------------------------------------------------------------------------------
// Reading triggers

/** A webhook's secret, shown once: the server answers it when the webhook is created or its secret rotated. */
export interface Reveal {
  readonly name: string;
  readonly url: string;
  readonly secret: string;
  /** The secret replaced an older one, which has stopped working. */
  readonly rotated: boolean;
}

/** What to show once of a created or rotated trigger: a webhook's URL and secret; a schedule has none. */
export const revealOf = (created: CreatedTrigger, rotated: boolean): Reveal | undefined =>
  created.secret === undefined || created.webhook === undefined
    ? undefined
    : { name: created.name, url: created.webhook.url, secret: created.secret, rotated };

/** Chat and MCP: always on for whoever may use the agent, never configured. */
export const ALWAYS_ON: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly text: string;
}> = [
  {
    id: "chat",
    name: "Chat",
    text: "Whoever may use the agent starts a conversation with it.",
  },
  {
    id: "mcp",
    name: "MCP",
    text: "Clients and other agents start it through the agents toolkit.",
  },
];

/** Schedules before webhooks, each oldest first as the server lists them. */
export const sortTriggers = (triggers: ReadonlyArray<TriggerView>): ReadonlyArray<TriggerView> => [
  ...triggers.filter((t) => t.kind === "schedule"),
  ...triggers.filter((t) => t.kind === "webhook"),
];

/** A schedule in words and its zone: "Every weekday at 09:00 · Europe/Berlin", or the expression when it is unusual. */
export const scheduleText = (schedule: {
  readonly cron: string;
  readonly time_zone: string;
}): string => `${describeCron(schedule.cron) ?? `Cron ${schedule.cron}`} · ${schedule.time_zone}`;

/** When a trigger runs next, or why it does not. */
export const nextText = (trigger: TriggerView, agentEnabled: boolean): string => {
  if (trigger.kind !== "schedule") return "";

  if (!agentEnabled) return "Skipped while the agent is disabled";

  if (!trigger.enabled) return "Skipped while disabled";

  if (trigger.schedule?.next_at === undefined) return "No run is left";

  return `Next ${runText(Date.parse(trigger.schedule.next_at), trigger.schedule.time_zone)}`;
};

/** How a trigger's request proves itself: the two ways of the webhook (ADR 0040). */
export const WEBHOOK_PROOFS: ReadonlyArray<{ readonly name: string; readonly text: string }> = [
  { name: "Bearer secret", text: "Authorization: Bearer <secret>" },
  {
    name: "Signed body",
    text: "X-Commissary-Delivery: <id>, X-Commissary-Timestamp: <unix seconds>, X-Commissary-Signature: sha256=<HMAC-SHA256 of id.timestamp.body under the secret>",
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Refused writes

export const triggerProblem = (
  error: string | undefined,
  message: string,
  detail?: string,
): string => {
  switch (error) {
    case "conflict":
      return "Someone changed this trigger since you loaded it. Reload to see the current one.";
    case "not_found":
      return "This trigger is gone. Reload to see the current list.";
    case "forbidden":
      return "Only the agent's manager changes its triggers.";
    default:
      return detail === undefined ? message : asSentence(detail);
  }
};

export const triggerProblemOf = <A>(outcome: Outcome<A>): string | undefined =>
  outcome.ok ? undefined : triggerProblem(outcome.error, outcome.message, outcome.detail);
