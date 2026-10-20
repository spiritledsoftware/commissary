// Triggers of hosted agents (#231, ADR 0040) in the Agents part over RPC: a schedule fires at its ticks in its time
// zone (`TestClock` drives the part's time), a tick fired again finds the run it started, and a tick while the agent is
// disabled is skipped; a webhook's secret is sealed at rest and proves a delivery as a bearer or an HMAC signature, and
// a delivery id fired again finds its run. A private agent's triggered runs count as started by its member, a shared
// agent's by no one.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { type Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import type { CreateTrigger } from "@commissary/contract/agent-triggers";
import { newOrgId } from "@commissary/core";
import { platformOf } from "@commissary/state";
import { agentBody } from "./testing.ts";
import { sweepRetiredSchedules } from "../src/org-deletion.ts";
import { deliveryKey, type WebhookProof } from "../src/triggers/webhook.ts";

const OWNER = { role: "owner" as const, sensitive: false };

const FOUND = { modelServed: true, unknownToolkits: [] };

const MODEL = "claude-sonnet-4";

/** Where the deployment's client API answers: the webhooks' URLs start here. */
const ORIGIN = "https://api.example.com";

/** A new org's ControlPlane with an org admin and two plain members, private agents on. */
const org = async () => {
  const id = newOrgId();
  const stub = env.CONTROL_PLANE.getByName(id);
  // Listed in the Platform registry: a schedule's alarm asks it whether the org still exists.
  const listed = await platformOf(env).createOrg({ slug: id, name: id, id }, Date.now());

  if (!listed.ok) throw new Error(listed.message);

  await stub.setMembershipSettings({ privateAgents: true });

  const member = async (name: string, role: string) => {
    const added = await stub.addMember({ email: `${name}@example.com`, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return { member: added.value.id, admin: role !== "member" };
  };

  return {
    id,
    stub,
    get agents() {
      return stub.agents();
    },
    admin: await member("admin", "admin"),
    alice: await member("alice", "member"),
    bob: await member("bob", "member"),
  };
};

type Org = Awaited<ReturnType<typeof org>>;

type Viewer = Org["alice"];

/** A `TestClock` at `at`, which the org's Agents part reads the time from from now on; `adjust` moves it. */
const testClock = async (o: Org, at: string) => {
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));

  await Effect.runPromise(clock.setTime(Date.parse(at)));
  await runInDurableObject(o.stub, (instance) => instance.agents().useClock(clock));

  return { adjust: (duration: Duration.Input) => Effect.runPromise(clock.adjust(duration)) };
};

const created = async (o: Org, viewer: Viewer, name: string, extra = {}) => {
  const result = await o.agents.createAgent(viewer, agentBody(name, MODEL, extra), FOUND, "test");

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);

  return result.value;
};

/** A call on `agentId`'s triggers as `viewer` makes it. */
const on = (viewer: Viewer, agentId: string) => ({ viewer, agentId, origin: ORIGIN, by: "test" });

/** A call on the trigger `triggerId` of `agentId` at `revision`. */
const onTrigger = (viewer: Viewer, agentId: string, triggerId: string, revision: number) => ({
  ...on(viewer, agentId),
  triggerId,
  revision,
});

const trigger = async (o: Org, viewer: Viewer, agent: string, input: CreateTrigger) => {
  const result = await o.agents.createTrigger(on(viewer, agent), input);

  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);

  return result.value;
};

/** Every day at 09:00 in Berlin: 08:00 UTC in winter (CET), 07:00 UTC in summer (CEST). */
const MORNING: CreateTrigger = {
  kind: "schedule",
  name: "Morning report",
  input: "Write the morning report.",
  schedule: { cron: "0 9 * * *", time_zone: "Europe/Berlin" },
};

describe("a schedule", () => {
  it("fires at its next tick in its time zone, and a tick fired again starts no second run", async () => {
    const o = await org();
    const clock = await testClock(o, "2026-03-27T08:30:00.000Z");
    const agent = await created(o, o.alice, "reporter");
    const schedule = await trigger(o, o.alice, agent.id, MORNING);

    // 09:00 in Berlin passed today (08:00 UTC); tomorrow's is still CET, and Sunday's is CEST.
    expect(schedule.schedule?.next_at).toBe("2026-03-28T08:00:00.000Z");
    const tick = Date.parse("2026-03-28T08:00:00.000Z");

    // Not before its tick: the alarm that woke early waits for it.
    expect(await o.agents.fireSchedule(schedule.id, tick)).toEqual({ kind: "early", next: tick });

    await clock.adjust("1 day");
    const fired = await o.agents.fireSchedule(schedule.id, tick);

    expect(fired).toMatchObject({
      kind: "fired",
      next: Date.parse("2026-03-29T07:00:00.000Z"),
      run: {
        created: true,
        input: "Write the morning report.",
        run: {
          trigger: "schedule",
          trigger_id: schedule.id,
          starter: { kind: "member", id: o.alice.member },
          state: "idle",
        },
      },
    });

    // A retried alarm fires the same tick again: the same run.
    const again = await o.agents.fireSchedule(schedule.id, tick);

    expect(again).toMatchObject({ kind: "fired", run: { created: false } });
    expect(again.kind === "fired" && again.run?.run.id).toBe(
      fired.kind === "fired" && fired.run?.run.id,
    );
    expect((await o.agents.listRuns(o.alice)).runs).toHaveLength(1);
  });
});

describe("a schedule's object", () => {
  // Ticks in the years ahead, so that no alarm the test sets fires by itself: the test runs each one.
  it("fires its tick at its alarm, starts the run's object, and waits for the next tick", async () => {
    const o = await org();
    const clock = await testClock(o, "2031-01-06T08:30:00.000Z");
    const agent = await created(o, o.alice, "reporter");
    const schedule = await trigger(o, o.alice, agent.id, MORNING);
    const object = env.AGENT_SCHEDULE.getByName(`${o.id}:${schedule.id}`);
    const alarm = () => runInDurableObject(object, (_instance, state) => state.storage.getAlarm());

    // Only the schedule it is named after.
    expect(await object.arm({ org: o.id, trigger: "trg_another" })).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await object.arm({ org: o.id, trigger: schedule.id })).toEqual({
      ok: true,
      value: { next: "2031-01-07T08:00:00.000Z" },
    });
    expect(await alarm()).toBe(Date.parse("2031-01-07T08:00:00.000Z"));

    // Woken before its tick: nothing starts, and the alarm stays.
    expect(await runDurableObjectAlarm(object)).toBe(true);
    expect((await o.agents.listRuns(o.alice)).runs).toEqual([]);
    expect(await alarm()).toBe(Date.parse("2031-01-07T08:00:00.000Z"));

    await clock.adjust("1 day");
    expect(await runDurableObjectAlarm(object)).toBe(true);

    const runs = (await o.agents.listRuns(o.alice)).runs;

    expect(runs).toMatchObject([{ trigger: "schedule", trigger_id: schedule.id }]);
    expect(await alarm()).toBe(Date.parse("2031-01-08T08:00:00.000Z"));

    // The run's object took the schedule's input as its first turn.
    const shown = await env.AGENT_RUN.getByName(`${o.id}:${runs[0]?.id}`).show();

    expect(shown).toMatchObject({ ok: true, value: { turns: [{ input: MORNING.input }] } });

    // Removed: the next alarm finds it gone and leaves no alarm behind.
    await o.agents.removeTrigger(onTrigger(o.alice, agent.id, schedule.id, schedule.revision));
    await clock.adjust("1 day");
    expect(await runDurableObjectAlarm(object)).toBe(true);
    expect(await alarm()).toBeNull();
    expect((await o.agents.listRuns(o.alice)).runs).toHaveLength(1);
  });
});

describe("a schedule's tick", () => {
  it("of a shared agent starts a run no one started, whose turns check no starter", async () => {
    const o = await org();
    const clock = await testClock(o, "2026-03-27T08:30:00.000Z");
    const agent = await created(o, o.admin, "support", { subject: { kind: "everyone" } });
    const schedule = await trigger(o, o.admin, agent.id, MORNING);

    await clock.adjust("1 day");
    const fired = await o.agents.fireSchedule(schedule.id, Date.parse("2026-03-28T08:00:00.000Z"));

    if (fired.kind !== "fired" || fired.run === undefined) throw new Error("no run");
    expect(fired.run.run.trigger).toBe("schedule");
    expect(fired.run.run.starter).toBeUndefined();

    // Its turns act as the agent, with no starter behind them.
    const turn = await o.agents.beginTurn(fired.run.run.id);

    expect(turn).toMatchObject({ ok: true, value: { actsAs: { kind: "agent" } } });
    expect(turn.ok && turn.value.starter).toBeUndefined();
    expect(await o.agents.turnContext(fired.run.run.id)).toMatchObject({ ok: true });

    // No member started it: none lists it as theirs.
    expect((await o.agents.listRuns(o.admin)).runs).toEqual([]);
  });

  it("while the agent is disabled is skipped, not caught up; a disabled trigger has no next tick", async () => {
    const o = await org();
    const clock = await testClock(o, "2026-03-27T08:30:00.000Z");
    const agent = await created(o, o.alice, "reporter");
    const schedule = await trigger(o, o.alice, agent.id, MORNING);

    expect(
      (await o.agents.updateAgent(o.alice, agent.id, 1, { enabled: false }, {}, "test")).ok,
    ).toBe(true);
    await clock.adjust("1 day");

    expect(
      await o.agents.fireSchedule(schedule.id, Date.parse("2026-03-28T08:00:00.000Z")),
    ).toEqual({ kind: "fired", next: Date.parse("2026-03-29T07:00:00.000Z") });

    // Enabled again: the next tick starts a run, and the skipped one is not started late.
    await o.agents.updateAgent(o.alice, agent.id, 2, { enabled: true }, {}, "test");
    expect((await o.agents.armSchedule(schedule.id)).kind).toBe("armed");
    expect((await o.agents.listRuns(o.alice)).runs).toEqual([]);

    const disabled = await o.agents.updateTrigger(
      onTrigger(o.alice, agent.id, schedule.id, schedule.revision),
      { enabled: false },
    );

    expect(disabled).toMatchObject({ ok: true, value: { enabled: false } });
    expect(await o.agents.armSchedule(schedule.id)).toEqual({ kind: "armed", next: null });

    // Removed: its object learns it is gone.
    await o.agents.removeTrigger(onTrigger(o.alice, agent.id, schedule.id, schedule.revision + 1));
    expect(await o.agents.armSchedule(schedule.id)).toEqual({ kind: "gone" });
  });
});

/** The sealed secret column of a trigger, as SQLite holds it. */
const storedSecret = async (o: Org, id: string) =>
  runInDurableObject(
    o.stub,
    (_instance, state) =>
      state.storage.sql
        .exec<{ secret: string | null }>(`SELECT secret FROM agent_triggers WHERE id = ?`, id)
        .toArray()[0]?.secret,
  );

/**
 * A delivery's signature proof: its id `delivery`, and `sha256=<hex>` of `<delivery>.<timestamp>.<body>` under `secret`,
 * signed at `at` (epoch ms).
 */
const signed = async (secret: string, body: Uint8Array, at: number, delivery = "delivery-1") => {
  const timestamp = String(Math.floor(at / 1000));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const message = new Uint8Array([
    ...new TextEncoder().encode(`${delivery}.${timestamp}.`),
    ...body,
  ]);

  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const hex = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return { signature: `sha256=${hex}`, timestamp, delivery };
};

const HOOK: CreateTrigger = {
  kind: "webhook",
  name: "Issues",
  input: "A new issue: {{body}}",
};

describe("a webhook", () => {
  it("keeps its secret sealed, shows it once, and takes a delivery proven by bearer or signature", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "triage");
    const hook = await trigger(o, o.alice, agent.id, HOOK);
    const secret = hook.secret ?? "";
    const body = new TextEncoder().encode('{"title":"broken"}');

    expect(secret).toMatch(/^whsec_/);
    expect(hook.webhook?.url).toBe(`${ORIGIN}/agent-webhooks/${o.id}/${hook.id}`);

    // Sealed at rest, and never listed again.
    const stored = await storedSecret(o, hook.id);

    expect(stored).toMatch(/^enc:/);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(secret.slice("whsec_".length));
    expect(JSON.stringify(await o.agents.listTriggers(on(o.alice, agent.id)))).not.toContain(
      secret,
    );

    const proven = async (id: string, proof: WebhookProof) =>
      (await o.agents.verifyWebhook(id, proof, body)).proven;

    expect(
      await o.agents.verifyWebhook(hook.id, { authorization: `Bearer ${secret}` }, body),
    ).toEqual({ proven: true, template: "A new issue: {{body}}" });
    expect(await proven(hook.id, await signed(secret, body, Date.now()))).toBe(true);
    expect(await proven(hook.id, { authorization: `Bearer ${secret}x` })).toBe(false);
    expect(await proven(hook.id, await signed("whsec_wrong", body, Date.now()))).toBe(false);
    // A signature without its timestamp or its delivery id, under another delivery id, or of another body, proves
    // nothing.
    const now = await signed(secret, body, Date.now());

    expect(await proven(hook.id, { signature: now.signature, timestamp: now.timestamp })).toBe(
      false,
    );
    expect(await proven(hook.id, { ...now, delivery: "delivery-2" })).toBe(false);
    expect(
      await proven(hook.id, { signature: (await signed(secret, body, Date.now())).signature }),
    ).toBe(false);
    expect(
      await o.agents.verifyWebhook(
        hook.id,
        await signed(secret, body, Date.now()),
        new TextEncoder().encode("{}"),
      ),
    ).toEqual({ proven: false });
    expect(await proven("trg_unknown", { authorization: `Bearer ${secret}` })).toBe(false);

    // A rotation: the new secret proves deliveries, the old one no longer does.
    const rotated = await o.agents.rotateTriggerSecret(
      onTrigger(o.alice, agent.id, hook.id, hook.revision),
    );

    if (!rotated.ok) throw new Error(rotated.message);
    expect(rotated.value.secret).not.toBe(secret);
    expect(await proven(hook.id, { authorization: `Bearer ${secret}` })).toBe(false);
    expect(await proven(hook.id, { authorization: `Bearer ${rotated.value.secret}` })).toBe(true);
  });

  it("starts one run per delivery id, its member's for a private agent, no one's for a shared one", async () => {
    const o = await org();
    const mine = await created(o, o.alice, "triage");
    const shared = await created(o, o.admin, "intake", { subject: { kind: "everyone" } });
    const privateHook = await trigger(o, o.alice, mine.id, HOOK);
    const sharedHook = await trigger(o, o.admin, shared.id, { kind: "webhook", name: "Raw" });

    const first = await o.agents.startWebhookRun(privateHook.id, "webhook:id:delivery-1");
    const again = await o.agents.startWebhookRun(privateHook.id, "webhook:id:delivery-1");

    expect(first).toMatchObject({
      ok: true,
      value: {
        created: true,
        run: {
          trigger: "webhook",
          trigger_id: privateHook.id,
          starter: { kind: "member", id: o.alice.member },
        },
      },
    });
    expect(again).toMatchObject({ ok: true, value: { created: false } });
    expect(again.ok && again.value.run.id).toBe(first.ok && first.value.run.id);

    const raw = await o.agents.startWebhookRun(sharedHook.id, "webhook:id:delivery-1");

    expect(raw).toMatchObject({ ok: true, value: { created: true } });
    expect(raw.ok && raw.value.run.starter).toBeUndefined();
  });

  it("starts nothing while it or its agent is disabled", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "triage");
    const hook = await trigger(o, o.alice, agent.id, { ...HOOK, enabled: false });

    expect(await o.agents.startWebhookRun(hook.id, "webhook:id:1")).toMatchObject({
      ok: false,
      error: "trigger_disabled",
    });

    await o.agents.updateTrigger(onTrigger(o.alice, agent.id, hook.id, 1), { enabled: true });
    await o.agents.updateAgent(o.alice, agent.id, 1, { enabled: false }, {}, "test");

    expect(await o.agents.startWebhookRun(hook.id, "webhook:id:1")).toMatchObject({
      ok: false,
      error: "agent_disabled",
    });
    expect((await o.agents.listRuns(o.alice)).runs).toEqual([]);
  });
});

describe("managing triggers", () => {
  it("is for the agent's manager only, and refuses a schedule that is not one", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "reporter");

    expect(await o.agents.createTrigger(on(o.bob, agent.id), MORNING)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await o.agents.listTriggers(on(o.admin, agent.id))).toMatchObject({
      ok: false,
      error: "forbidden",
    });

    const refused = async (schedule: { cron: string; time_zone: string }) =>
      await o.agents.createTrigger(on(o.alice, agent.id), { ...MORNING, schedule });

    expect(await refused({ cron: "0 0 9 * * *", time_zone: "UTC" })).toMatchObject({
      error: "invalid",
    });
    expect(await refused({ cron: "0 9 * * *", time_zone: "Mars/Olympus" })).toMatchObject({
      error: "invalid",
    });
    expect(await refused({ cron: "0 0 30 2 *", time_zone: "UTC" })).toMatchObject({
      error: "invalid",
    });
    expect(
      await o.agents.createTrigger(on(o.alice, agent.id), { ...MORNING, input: " " }),
    ).toMatchObject({ error: "invalid" });

    // Removing the agent removes its triggers.
    const schedule = await trigger(o, o.alice, agent.id, MORNING);

    await o.agents.removeAgent(o.alice, agent.id, 1);
    expect(await o.agents.armSchedule(schedule.id)).toEqual({ kind: "gone" });
  });
});

describe("a webhook's signature", () => {
  it("proves a delivery within five minutes of its timestamp, either way, and never after", async () => {
    const o = await org();
    const at = Date.parse("2026-05-04T10:00:00.000Z");
    const clock = await testClock(o, "2026-05-04T10:00:00.000Z");
    const agent = await created(o, o.alice, "triage");
    const hook = await trigger(o, o.alice, agent.id, HOOK);
    const secret = hook.secret ?? "";
    const body = new TextEncoder().encode('{"title":"late"}');

    const proven = async (proof: WebhookProof) =>
      (await o.agents.verifyWebhook(hook.id, proof, body)).proven;

    // Signed now, four minutes ahead (a sender's clock running fast) and four minutes ago.
    const captured = await signed(secret, body, at);

    expect(await proven(captured)).toBe(true);
    expect(await proven(await signed(secret, body, at + 4 * 60_000))).toBe(true);
    expect(await proven(await signed(secret, body, at - 4 * 60_000))).toBe(true);
    expect(await proven(await signed(secret, body, at + 6 * 60_000))).toBe(false);

    // The captured delivery, replayed six minutes later (under its own delivery id), proves nothing.
    await clock.adjust("6 minutes");
    expect(await proven(captured)).toBe(false);
    expect(await proven(await signed(secret, body, at + 6 * 60_000))).toBe(true);

    // A bearer has no timestamp: the secret itself.
    expect(await proven({ authorization: `Bearer ${secret}` })).toBe(true);
  });
});

describe("a delivery's key", () => {
  it("is its delivery id, else its body's hash and minute: one minute's same body is one delivery", async () => {
    const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
    const now = () => clock.currentTimeMillisUnsafe();
    const body = new TextEncoder().encode('{"event":"push"}');

    await Effect.runPromise(clock.setTime(Date.parse("2026-05-04T10:00:01.000Z")));
    const first = deliveryKey({}, body, now());

    // Later in the same minute: the same delivery.
    await Effect.runPromise(clock.adjust("58 seconds"));
    expect(deliveryKey({}, body, now())).toBe(first);
    expect(deliveryKey({}, new TextEncoder().encode("{}"), now())).not.toBe(first);

    // Across the minute's boundary, a retry is another delivery: senders name their delivery id.
    await Effect.runPromise(clock.adjust("2 seconds"));
    expect(deliveryKey({}, body, now())).not.toBe(first);

    // A delivery id names it whatever the time: Commissary's first, then Standard Webhooks'; others are not read.
    const named = deliveryKey(
      { "x-commissary-delivery": "d-1", "webhook-id": "msg_1" },
      body,
      now(),
    );

    expect(named).toBe("webhook:id:d-1");
    expect(deliveryKey({ "webhook-id": "msg_1" }, body, now())).toBe("webhook:id:msg_1");
    expect(deliveryKey({ "x-github-delivery": "gh-1" }, body, now())).not.toContain("gh-1");
  });
});

describe("the org export", () => {
  it("lists an agent's triggers: what each is, never a webhook's secret", async () => {
    const o = await org();
    const agent = await created(o, o.alice, "reporter");
    const hook = await trigger(o, o.alice, agent.id, HOOK);

    await trigger(o, o.alice, agent.id, MORNING);
    const exported = await o.agents.exportAgents(o.alice);

    expect(exported).toMatchObject([
      {
        name: "reporter",
        triggers: [
          { kind: "webhook", name: "Issues", enabled: true, input: HOOK.input },
          {
            kind: "schedule",
            name: "Morning report",
            input: MORNING.input,
            schedule: { cron: "0 9 * * *", time_zone: "Europe/Berlin" },
          },
        ],
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain(hook.secret ?? "whsec_");
    expect(JSON.stringify(exported)).not.toContain(hook.id);
  });
});

describe("a schedule's object, once its schedule is gone", () => {
  const armed = async (o: Org, viewer: Viewer, agentId: string) => {
    const schedule = await trigger(o, viewer, agentId, MORNING);
    const object = env.AGENT_SCHEDULE.getByName(`${o.id}:${schedule.id}`);

    expect((await object.arm({ org: o.id, trigger: schedule.id })).ok).toBe(true);

    return {
      schedule,
      object,
      stored: () =>
        runInDurableObject(object, async (_instance, state) => ({
          alarm: await state.storage.getAlarm(),
          keys: [...state.storage.kv.list()].length,
        })),
    };
  };

  it("is found and deleted by the sweep after its member left the org", async () => {
    const o = await org();
    await testClock(o, "2031-01-06T08:30:00.000Z");
    const agent = await created(o, o.alice, "reporter");
    const { schedule, stored } = await armed(o, o.alice, agent.id);

    expect(await o.agents.retiredSchedules(20)).toEqual([]);
    expect((await stored()).alarm).not.toBeNull();

    // Alice leaves: her agent and its schedule go, its object stays until the sweep.
    await o.stub.removeMember(o.alice.member, OWNER);
    expect(await o.agents.retiredSchedules(20)).toEqual([schedule.id]);

    await Effect.runPromise(sweepRetiredSchedules(env, o.id));
    expect(await stored()).toEqual({ alarm: null, keys: 0 });
    expect(await o.agents.retiredSchedules(20)).toEqual([]);
    expect(await o.agents.scheduleObjectsPage(20)).toEqual([]);
  });

  it("of a deleted org deletes itself at its alarm without reaching the org's ControlPlane", async () => {
    const o = await org();
    const clock = await testClock(o, "2031-01-06T08:30:00.000Z");
    const agent = await created(o, o.alice, "reporter");
    const { object, stored } = await armed(o, o.alice, agent.id);

    // The org leaves the Platform registry (the last step of its deletion) with its schedule still in its ControlPlane.
    expect((await platformOf(env).deleteOrg(o.id)).ok).toBe(true);
    await clock.adjust("1 day");

    expect(await runDurableObjectAlarm(object)).toBe(true);
    expect(await stored()).toEqual({ alarm: null, keys: 0 });
    // The tick was due, yet no run started: its ControlPlane was not asked.
    expect((await o.agents.listRuns(o.alice)).runs).toEqual([]);
  });
});
