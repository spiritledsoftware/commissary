// The agent page's triggers (src/lib/agent-triggers.ts, #233): a cron expression read as the server reads it, its words
// and next runs, the drafts of schedules and webhooks, and the bodies they become.
import { describe, expect, it } from "vitest";
import type { TriggerView } from "@commissary/contract/agent-triggers";
import {
  createTriggerBody,
  describeCron,
  draftOfTrigger,
  emptyTrigger,
  hasTriggerChanges,
  nextRuns,
  nextText,
  readSchedule,
  revealOf,
  runText,
  scheduleText,
  sortTriggers,
  triggerProblem,
  updateTriggerPatch,
  validateTrigger,
} from "../src/lib/agent-triggers.ts";

const T = "2026-08-12T10:00:00.000Z";

const schedule: TriggerView = {
  id: "tr_1",
  agent_id: "ag_1",
  kind: "schedule",
  name: "Morning digest",
  enabled: true,
  input: "Summarise yesterday",
  schedule: {
    cron: "0 9 * * 1-5",
    time_zone: "Europe/Berlin",
    next_at: "2026-08-13T07:00:00.000Z",
  },
  revision: 2,
  created_at: T,
  updated_at: T,
};

const webhook: TriggerView = {
  id: "tr_2",
  agent_id: "ag_1",
  kind: "webhook",
  name: "Sentry alerts",
  enabled: true,
  input: "An alert: {{body}}",
  webhook: { url: "https://api.example.com/hooks/abc" },
  revision: 1,
  created_at: T,
  updated_at: T,
};

describe("reading a schedule", () => {
  it("accepts five fields in an IANA zone, and finds the runs the server would", () => {
    const read = readSchedule("0 9 * * 1-5", "Europe/Berlin");

    expect(read.ok).toBe(true);

    if (!read.ok) return;

    // 2026-08-12 is a Wednesday: the next 09:00 in Berlin (UTC+2) is the 13th, then the Friday, then Monday the 17th.
    const runs = nextRuns(read.cron, Date.parse("2026-08-12T10:00:00Z"), 3);

    expect(runs.map((at) => new Date(at).toISOString())).toEqual([
      "2026-08-13T07:00:00.000Z",
      "2026-08-14T07:00:00.000Z",
      "2026-08-17T07:00:00.000Z",
    ]);
  });

  it("refuses the wrong number of fields, a bad expression, an unknown zone and a date that never comes", () => {
    expect(readSchedule("0 9 * *", "UTC")).toMatchObject({ ok: false, field: "cron" });
    expect(readSchedule("0 9 * * * *", "UTC")).toMatchObject({ ok: false, field: "cron" });
    expect(readSchedule("61 9 * * *", "UTC")).toMatchObject({ ok: false, field: "cron" });
    expect(readSchedule("0 9 * * *", "Mars/Olympus")).toMatchObject({
      ok: false,
      field: "timeZone",
    });
    expect(readSchedule("0 0 30 2 *", "UTC")).toMatchObject({ ok: false, field: "cron" });
    expect(readSchedule("", "UTC")).toMatchObject({ ok: false, field: "cron" });
  });

  it("shows a run in the schedule's own zone", () => {
    expect(runText(Date.parse("2026-08-13T07:00:00Z"), "Europe/Berlin")).toBe("Thu 13 Aug, 09:00");
    expect(runText(Date.parse("2026-08-13T07:00:00Z"), "UTC")).toBe("Thu 13 Aug, 07:00");
  });
});

describe("a cron expression in words", () => {
  it("says the usual shapes", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 * * * *")).toBe("Every hour, on the hour");
    expect(describeCron("30 * * * *")).toBe("Every hour at 30 past");
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00");
    expect(describeCron("5 18 * * 1-5")).toBe("Every weekday at 18:05");
    expect(describeCron("0 9 * * 1")).toBe("Every Monday at 09:00");
    expect(describeCron("0 9 * * mon,wed")).toBe("Every Monday, Wednesday at 09:00");
    expect(describeCron("0 9 * * 6-7")).toBe("Every Saturday to Sunday at 09:00");
    expect(describeCron("0 9 1 * *")).toBe("On the 1st of every month at 09:00");
    expect(describeCron("0 9 22 * *")).toBe("On the 22nd of every month at 09:00");
    expect(describeCron("0 9 3 12 *")).toBe("Every December on the 3rd at 09:00");
  });

  it("does not guess at the unusual, and shows the expression instead", () => {
    expect(describeCron("0,30 9-17 * * 1-5")).toBeUndefined();
    expect(describeCron("0 9 1 * 1")).toBeUndefined();
    expect(describeCron("nonsense")).toBeUndefined();
    expect(scheduleText({ cron: "0 9 * * *", time_zone: "UTC" })).toBe("Every day at 09:00 · UTC");
    expect(scheduleText({ cron: "0,30 9-17 * * 1-5", time_zone: "UTC" })).toBe(
      "Cron 0,30 9-17 * * 1-5 · UTC",
    );
  });
});

describe("a trigger's draft", () => {
  it("needs a name; a schedule also needs its input and a readable cron and zone", () => {
    expect(validateTrigger(emptyTrigger("schedule", "UTC"))).toEqual({
      name: "A trigger needs a name.",
      input: "A schedule needs the input each run starts with.",
    });

    expect(
      validateTrigger({ ...emptyTrigger("schedule", "Nowhere/Land"), name: "x", input: "go" }),
    ).toHaveProperty("timeZone");

    expect(
      validateTrigger({ ...emptyTrigger("schedule", "UTC"), name: "x", input: "go", cron: "9 *" }),
    ).toHaveProperty("cron");

    expect(validateTrigger({ ...emptyTrigger("schedule", "UTC"), name: "x", input: "go" })).toEqual(
      {},
    );
  });

  it("lets a webhook have no template: the body alone is the input", () => {
    expect(validateTrigger({ ...emptyTrigger("webhook", "UTC"), name: "Alerts" })).toEqual({});
    expect(validateTrigger({ ...emptyTrigger("webhook", "UTC"), name: " " })).toEqual({
      name: "A trigger needs a name.",
    });
  });

  it("becomes the body the server takes", () => {
    expect(
      createTriggerBody({
        ...emptyTrigger("schedule", "Europe/Berlin"),
        name: " Digest ",
        input: "Go",
        cron: " 0 9 * * 1-5 ",
      }),
    ).toEqual({
      kind: "schedule",
      name: "Digest",
      enabled: true,
      input: "Go",
      schedule: { cron: "0 9 * * 1-5", time_zone: "Europe/Berlin" },
    });

    expect(createTriggerBody({ ...emptyTrigger("webhook", "UTC"), name: "Alerts" })).toEqual({
      kind: "webhook",
      name: "Alerts",
      enabled: true,
    });

    expect(
      createTriggerBody({
        ...emptyTrigger("webhook", "UTC"),
        name: "Alerts",
        input: "Alert: {{body}}",
      }),
    ).toMatchObject({ input: "Alert: {{body}}" });
  });

  it("sends only what an edit changed, and clears a webhook's template with null", () => {
    expect(hasTriggerChanges(updateTriggerPatch(schedule, draftOfTrigger(schedule)))).toBe(false);

    expect(
      updateTriggerPatch(schedule, { ...draftOfTrigger(schedule), name: "Digest", enabled: false }),
    ).toEqual({ name: "Digest", enabled: false });

    expect(updateTriggerPatch(schedule, { ...draftOfTrigger(schedule), timeZone: "UTC" })).toEqual({
      schedule: { cron: "0 9 * * 1-5", time_zone: "UTC" },
    });

    expect(updateTriggerPatch(webhook, { ...draftOfTrigger(webhook), input: "" })).toEqual({
      input: null,
    });
  });
});

describe("reading triggers", () => {
  it("lists schedules before webhooks", () => {
    expect(sortTriggers([webhook, schedule]).map((trigger) => trigger.id)).toEqual([
      "tr_1",
      "tr_2",
    ]);
  });

  it("says when a schedule runs next, or why it does not", () => {
    expect(nextText(schedule, true)).toBe("Next Thu 13 Aug, 09:00");
    expect(nextText(schedule, false)).toBe("Skipped while the agent is disabled");
    expect(nextText({ ...schedule, enabled: false }, true)).toBe("Skipped while disabled");
    expect(nextText({ ...schedule, schedule: { cron: "0 9 * * *", time_zone: "UTC" } }, true)).toBe(
      "No run is left",
    );
    expect(nextText(webhook, true)).toBe("");
  });

  it("explains a refused write by its code", () => {
    expect(triggerProblem("conflict", "x")).toContain("Reload");
    expect(triggerProblem("invalid", "x", "a schedule's cron expression is invalid")).toBe(
      "A schedule's cron expression is invalid.",
    );
  });
});

describe("the secret shown once", () => {
  const created = {
    ...webhook,
    secret: "whsec_abc",
  };

  it("reveals a created webhook's URL and secret", () => {
    expect(revealOf(created, false)).toEqual({
      name: webhook.name,
      url: webhook.webhook?.url,
      secret: "whsec_abc",
      rotated: false,
    });
  });

  it("marks a rotated secret as replacing an older one", () => {
    expect(revealOf(created, true)?.rotated).toBe(true);
  });

  it("reveals nothing for a schedule, or a webhook the server sent no secret for", () => {
    expect(revealOf({ ...schedule }, false)).toBeUndefined();
    expect(revealOf({ ...webhook }, true)).toBeUndefined();
  });
});
