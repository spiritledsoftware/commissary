// Computer time (#224, ADR 0041): a sandbox session writes one usage record of its computer time when it closes, and an
// org admin's price per computer hour on the sandbox toolkit makes that time cost money, prorated, toward the member's,
// their teams', the org's and the API key's Spend limits, as browser time does (#214). With a limit used up, a running
// computer is stopped quietly at the session's next call, which goes on and says so, and only a command that would run
// on the computer is refused, while commands just-bash runs go on. The part and the sessions' objects read one TestClock, set before a session opens, so
// the computer time and its cost are exact; the computer is the test Worker's fake (`support/fake-computer.ts`), whose
// commands take no time.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Effect, type Schema } from "effect";
import { TestClock } from "effect/testing";
import type { NewSpendLimit } from "@commissary/state/spend";
import { refusedText } from "../src/mcp/endpoint.ts";
import { COMPUTER_STOPPED_NOTE } from "../src/sandbox/toolkit.ts";
import { deleteSessionRecords } from "../src/usage/record.ts";
import { SETTLE_RETRY_MS } from "../src/usage/session-close.ts";
import { testClockStart } from "./support/clock.ts";
import { fakeContainerOf, realContainerOrgs } from "./support/fake-container.ts";
import { spentAt } from "./support/spend.ts";
import { migrateUsageDb } from "./support/usage-db.ts";
import type { SandboxSession as TestSandboxSession } from "./worker.ts";

beforeAll(async () => {
  await migrateUsageDb();
});

const POLICY = { ownHosts: [], localDevelopment: false };

const OWNER = { role: "owner" as const, sensitive: false };

/** An hour's price that makes a millisecond of computer time cost one micro-USD. */
const MICRO_PER_MS = 3_600_000;

const MINUTE = 60_000;

const DAY = 24 * 60 * MINUTE;

/** A command just-bash lacks (`git`), which the session runs on the computer. */
const ON_COMPUTER = "git status";

/**
 * The test Worker's `SandboxSession` class (test/worker.ts) as loaded in the objects' isolate, reached through an
 * instance's constructor, whose statics set what new objects read the time from and which writes of theirs fail.
 */
const sessionClass = async (): Promise<typeof TestSandboxSession> =>
  await runInDurableObject(
    env.SANDBOX_SESSION.getByName(`test:${crypto.randomUUID()}`),
    // SAFETY: the test Worker binds `SANDBOX_SESSION` to its own `SandboxSession` (test/worker.ts).
    (instance) => instance.constructor as typeof TestSandboxSession,
  );

afterEach(async () => {
  const session = await sessionClass();

  session.clock = undefined;
  session.failRecords = 0;
  session.failReports = 0;
  session.before224 = false;
});

/**
 * An org on a deployment with the computer, whose sandbox toolkit everyone may use with the computer, at `hourPrice` per
 * computer hour when given, with an admin and alice, who calls with an API key of hers; its part and the sessions it
 * opens read the time from one `TestClock`.
 */
const computerOrg = async (hourPrice?: number) => {
  const name = crypto.randomUUID();
  const stub = env.COMPUTER_SANDBOX_CONTROL_PLANE.getByName(name);

  const member = async (email: string, role: string) => {
    const added = await stub.addMember({ email, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return { member: added.value.id, admin: role !== "member" };
  };

  const admin = await member("admin@example.com", "admin");
  const alice = await member("alice@example.com", "member");
  const key = await stub.createApiKey({ memberId: alice.member, name: "alice's" }, Date.now());

  if (!key.ok) throw new Error(key.message);
  const keyId = key.value.record.id;

  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));

  // Noon UTC ahead: its daily limits' day never ends within a test, and the sessions' alarms are never past.
  await Effect.runPromise(clock.setTime(testClockStart()));
  await runInDurableObject(stub, (instance) => instance.tools().useClock(clock));
  (await sessionClass()).clock = clock;

  const written = await stub.tools().writeGrant(
    {
      revision: 0,
      value: { subject: { kind: "everyone" }, toolkit: "sandbox", tools: { kind: "all" } },
    },
    "test",
  );

  if (!written.ok) throw new Error(written.message);

  const revision = async () =>
    (await stub.tools().listToolkits(admin)).toolkits.find((toolkit) => toolkit.id === "sandbox")
      ?.revision ?? 1;

  const allowed = await stub
    .tools()
    .updateToolkit(admin, "sandbox", await revision(), { computer: true }, "t", POLICY);

  if (!allowed.ok) throw new Error(allowed.message);

  const plane = {
    stub,
    name,
    admin,
    alice,
    keyId,
    principal: `key:${keyId}`,
    advance: (millis: number) => Effect.runPromise(clock.adjust(millis)),
    now: () => Effect.runPromise(clock.currentTimeMillis),
    /** Sets the price per computer hour (`null`: none). */
    price: async (price: number | null) => {
      const priced = await stub
        .tools()
        .updateToolkit(
          admin,
          "sandbox",
          await revision(),
          { computer_hour_price_micros: price },
          "t",
          POLICY,
        );

      if (!priced.ok) throw new Error(priced.message);
    },
    /** A call of `name` by alice, through her API key. */
    call: (tool: string, args: Schema.JsonObject = {}) =>
      stub
        .tools()
        .callTool(
          alice,
          { name: tool, arguments: args, principalId: `key:${keyId}`, apiKeyId: keyId },
          POLICY,
        ),
    /** A daily limit of `amountMicros` on `kind`'s subject. */
    limit: async (kind: NewSpendLimit["kind"], subject: string, amountMicros: number) => {
      const made = await stub.createSpendLimit(
        admin,
        { kind, subject, period: "day", amountMicros },
        "t",
      );

      if (!made.ok) throw new Error(made.message);
    },
    /** What the limit of `kind` has counted in its day at the clock. */
    spent: async (kind: NewSpendLimit["kind"] = "org") =>
      await spentAt(stub, kind, await Effect.runPromise(clock.currentTimeMillis)),
  };

  if (hourPrice !== undefined) await plane.price(hourPrice);

  return plane;
};

type Org = Awaited<ReturnType<typeof computerOrg>>;

/** The text of a tool result's first content. */
const textOf = (result: Schema.JsonObject): string =>
  // SAFETY: the sandbox tools answer text contents.
  (result["content"] as ReadonlyArray<{ readonly text: string }>)[0]?.text ?? "";

/** Opens a session with the computer as alice; its id. */
const openSession = async (org: Org) => {
  const opened = await org.call("sandbox_open", { computer: true });

  if (opened.outcome !== "result") throw new Error(`the call came to ${opened.outcome}`);

  // SAFETY: `sandbox_open` answers the session in its structured content.
  return (opened.result["structuredContent"] as { session: string }).session;
};

/** A command in the session `session` by alice. */
const bash = (org: Org, session: string, command: string) =>
  org.call("sandbox_bash", { session, command });

/** When the alarm of the org's session `id` is set for. */
const alarmAt = (org: Org, id: string) =>
  runInDurableObject(env.SANDBOX_SESSION.getByName(`${org.name}:${id}`), (_instance, state) =>
    state.storage.getAlarm(),
  );

/** Runs the alarm of the org's session `id`. */
const alarmOf = (org: Org, id: string) =>
  runDurableObjectAlarm(env.SANDBOX_SESSION.getByName(`${org.name}:${id}`));

/** The usage record of the session `id`, if it wrote one. */
const sessionRecord = async (id: string) =>
  await env.USAGE.prepare(`SELECT * FROM usage_records WHERE request_id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();

/** The ids of the org's sandbox sessions its part keeps. */
const keptSessions = (org: Org) =>
  runInDurableObject(org.stub, (_instance, state) =>
    state.storage.sql
      .exec<{ id: string }>(`SELECT id FROM sandbox_sessions ORDER BY id`)
      .toArray()
      .map((row) => row.id),
  );

describe("the price per computer hour", () => {
  it("is an org admin's to set on the sandbox toolkit, read back on it, and cleared with null", async () => {
    const org = await computerOrg();
    const tools = org.stub.tools();
    const revision = (await tools.listToolkits(org.admin)).toolkits[0]?.revision ?? 0;

    expect(
      await tools.updateToolkit(
        org.admin,
        "sandbox",
        revision,
        { computer_hour_price_micros: 150_000 },
        "test",
        POLICY,
      ),
    ).toMatchObject({ ok: true, value: { computer_hour_price_micros: 150_000 } });
    expect((await tools.listToolkits(org.alice)).toolkits[0]).toMatchObject({
      id: "sandbox",
      computer_hour_price_micros: 150_000,
    });
    expect((await tools.listToolkits(org.alice)).toolkits[0]).not.toHaveProperty(
      "browser_hour_price_micros",
    );
    // The org export carries it, as the view shows it.
    expect(
      (await tools.exportToolkits(org.admin)).find((toolkit) => toolkit.name === "sandbox"),
    ).toMatchObject({ computer_hour_price_micros: 150_000 });

    for (const price of [-1, 1.5, 2 ** 60])
      expect(
        await tools.updateToolkit(
          org.admin,
          "sandbox",
          revision + 1,
          { computer_hour_price_micros: price },
          "test",
          POLICY,
        ),
      ).toMatchObject({ ok: false, error: "invalid" });

    expect(
      await tools.updateToolkit(
        org.alice,
        "sandbox",
        revision + 1,
        { computer_hour_price_micros: 1 },
        "test",
        POLICY,
      ),
    ).toMatchObject({ ok: false, error: "forbidden" });

    const cleared = await tools.updateToolkit(
      org.admin,
      "sandbox",
      revision + 1,
      { computer_hour_price_micros: null },
      "test",
      POLICY,
    );

    expect(cleared).toMatchObject({ ok: true, value: { revision: revision + 2 } });
    expect(cleared.ok && "computer_hour_price_micros" in cleared.value).toBe(false);
  });

  it("belongs to the sandbox toolkit only: the browser toolkit refuses one, and takes its own", async () => {
    const tools = env.BROWSER_CONTROL_PLANE.getByName(crypto.randomUUID()).tools();
    const admin = { member: "m-admin", admin: true };

    expect(
      await tools.updateToolkit(
        admin,
        "browser",
        1,
        { computer_hour_price_micros: 1 },
        "test",
        POLICY,
      ),
    ).toMatchObject({ ok: false, error: "built_in" });
    expect(
      await tools.updateToolkit(
        admin,
        "browser",
        1,
        { browser_hour_price_micros: 1 },
        "test",
        POLICY,
      ),
    ).toMatchObject({ ok: true, value: { browser_hour_price_micros: 1 } });
  });
});

describe("a sandbox session", () => {
  it("writes one usage record of its computer time when it closes, holding no command, path or output", async () => {
    const org = await computerOrg();
    const openedAt = await org.now();
    const id = await openSession(org);

    await org.advance(MINUTE);
    // The computer starts with the command, which takes no time.
    expect(await bash(org, id, `${ON_COMPUTER} --short`)).toMatchObject({
      outcome: "result",
      usage: { toolId: "sandbox:bash", costMicros: 0 },
    });
    await org.advance(4 * MINUTE);
    await org.call("sandbox_write", { session: id, path: "notes/secret.txt", content: "hidden" });
    expect(await sessionRecord(id)).toBeNull();

    // It stopped ten idle minutes after its command; the session closes later.
    await org.advance(20 * MINUTE);
    await org.call("sandbox_close", { session: id });
    // Closing again writes nothing more.
    await org.call("sandbox_close", { session: id });

    const record = await sessionRecord(id);

    expect(record).toMatchObject({
      org_id: org.name,
      principal_id: org.principal,
      member_id: org.alice.member,
      area: "tools",
      toolkit_id: "sandbox",
      tool_id: null,
      tool_outcome: null,
      auth_type: "shared",
      private: 0,
      requested_at: openedAt,
      computer_ms: 10 * MINUTE,
      cost_micros: 0,
      browser_ms: null,
    });

    for (const content of ["git status", "--short", "notes", "secret", "hidden", "workspace"])
      expect(JSON.stringify(record)).not.toContain(content);

    expect(
      (
        await env.USAGE.prepare(`SELECT COUNT(*) AS n FROM usage_records WHERE request_id = ?`)
          .bind(id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(await keptSessions(org)).toEqual([]);
  });

  it("that never used the computer records none, at no cost", async () => {
    const org = await computerOrg(MICRO_PER_MS);
    const id = await openSession(org);

    await org.advance(30 * MINUTE);
    await bash(org, id, "echo hello > hello.txt && cat hello.txt");
    await org.call("sandbox_close", { session: id });

    expect(await sessionRecord(id)).toMatchObject({ computer_ms: 0, cost_micros: 0 });
  });

  it("charges its computer time with each call, at the price per computer hour, and its record holds the whole", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);

    await org.advance(MINUTE);
    await bash(org, id, ON_COMPUTER);
    expect(await org.spent()).toBe(0);

    // The call's own record costs its price per call (none); the computer's time is the session's record's.
    await org.advance(4 * MINUTE);
    expect(await org.call("sandbox_list", { session: id })).toMatchObject({
      outcome: "result",
      usage: { costMicros: 0 },
    });
    expect(await org.spent()).toBe(4 * MINUTE);

    await org.advance(20 * MINUTE);
    await org.call("sandbox_close", { session: id });

    expect(await org.spent()).toBe(10 * MINUTE);
    expect(await sessionRecord(id)).toMatchObject({
      computer_ms: 10 * MINUTE,
      cost_micros: 10 * MINUTE,
    });
  });

  it("costs the stretch before a price change at the old price, and the new one from the next call on", async () => {
    const org = await computerOrg(MICRO_PER_MS);
    const id = await openSession(org);

    await bash(org, id, ON_COMPUTER);
    await org.advance(2 * MINUTE);
    await org.price(2 * MICRO_PER_MS);
    await org.advance(2 * MINUTE);
    // Four minutes at the price the command's call passed.
    await org.call("sandbox_list", { session: id });
    await org.advance(MINUTE);
    // One at the new one.
    await org.call("sandbox_close", { session: id });

    expect(await sessionRecord(id)).toMatchObject({
      computer_ms: 5 * MINUTE,
      cost_micros: 6 * MINUTE,
    });
  });

  it("meters its computer's run when its idle minutes are over, and reports it then, without waiting for a call", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);
    const startedAt = await org.now();

    await bash(org, id, ON_COMPUTER);
    // The object wakes up when the computer stops: ten idle minutes after its command.
    expect(await alarmAt(org, id)).toBe(startedAt + 10 * MINUTE);
    await org.advance(10 * MINUTE);
    expect(await alarmOf(org, id)).toBe(true);

    expect(await org.spent()).toBe(10 * MINUTE);
    expect(await sessionRecord(id)).toBeNull();
    expect(await keptSessions(org)).toEqual([id]);
    // Then not before the session is idle for a day.
    expect(await alarmAt(org, id)).toBe(startedAt + DAY);

    // The close charges nothing more: the run was charged.
    await org.advance(10 * MINUTE);
    await org.call("sandbox_close", { session: id });
    expect(await org.spent()).toBe(10 * MINUTE);
    expect(await sessionRecord(id)).toMatchObject({
      computer_ms: 10 * MINUTE,
      cost_micros: 10 * MINUTE,
    });
  });

  it("whose report of its computer's run failed has it answered by the next call, or reported again, once each", async () => {
    const org = await computerOrg(MICRO_PER_MS);
    const session = await sessionClass();

    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);

    await bash(org, id, ON_COMPUTER);
    await org.advance(10 * MINUTE);
    session.failReports = 1;
    await alarmOf(org, id);
    expect(await org.spent()).toBe(0);

    // The next call answers it, and the alarm, tried again, reports nothing more.
    await org.call("sandbox_list", { session: id });
    expect(await org.spent()).toBe(10 * MINUTE);
    await alarmOf(org, id);
    expect(await org.spent()).toBe(10 * MINUTE);

    // Or the alarm reports it, tried again soon.
    await bash(org, id, ON_COMPUTER);
    await org.advance(10 * MINUTE);
    session.failReports = 1;
    await alarmOf(org, id);
    expect(await org.spent()).toBe(10 * MINUTE);
    expect(await alarmAt(org, id)).toBe((await org.now()) + SETTLE_RETRY_MS);
    await org.advance(SETTLE_RETRY_MS);
    await alarmOf(org, id);
    expect(await org.spent()).toBe(20 * MINUTE);

    await org.call("sandbox_close", { session: id });
    expect(await org.spent()).toBe(20 * MINUTE);
    expect(await sessionRecord(id)).toMatchObject({
      computer_ms: 20 * MINUTE,
      cost_micros: 20 * MINUTE,
    });
  });

  it("closed by its alarm after a day, reports the close with the computer time no call charged", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);

    await bash(org, id, ON_COMPUTER);
    // A day on, the alarm closes the session; the run it did not report yet goes with the close.
    await org.advance(DAY);
    expect(await alarmOf(org, id)).toBe(true);

    expect(await sessionRecord(id)).toMatchObject({
      computer_ms: 10 * MINUTE,
      cost_micros: 10 * MINUTE,
    });
    expect(await org.spent()).toBe(10 * MINUTE);
    expect(await keptSessions(org)).toEqual([]);
  });

  it("closed by its alarm, writes its record and reports its close on a later alarm when they failed, once each", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);
    const session = await sessionClass();

    await bash(org, id, ON_COMPUTER);
    session.failRecords = 1;
    session.failReports = 1;
    await org.advance(DAY);
    await alarmOf(org, id);

    // Closed, but nothing written or charged yet.
    expect(await sessionRecord(id)).toBeNull();
    expect(await org.spent()).toBe(0);
    expect(await keptSessions(org)).toEqual([id]);
    const listed = await org.call("sandbox_list", { session: id });

    expect(listed.outcome === "result" && textOf(listed.result)).toMatch(/is closed/);

    await org.advance(SETTLE_RETRY_MS);
    await alarmOf(org, id);

    expect(await sessionRecord(id)).toMatchObject({ computer_ms: 10 * MINUTE });
    expect(await org.spent()).toBe(10 * MINUTE);

    // Nothing is left to do: the next alarm charges nothing more, and the note goes.
    await org.advance(SETTLE_RETRY_MS);
    await alarmOf(org, id);
    expect(await org.spent()).toBe(10 * MINUTE);
  });

  it("costs nothing without a price, and goes on whatever the limits", async () => {
    const org = await computerOrg();

    await org.limit("org", "", 0);
    const id = await openSession(org);

    await org.advance(MINUTE);
    expect(await bash(org, id, ON_COMPUTER)).toMatchObject({ outcome: "result" });
    await org.advance(MINUTE);
    expect(await bash(org, id, ON_COMPUTER)).toMatchObject({ outcome: "result" });
    await org.call("sandbox_close", { session: id });

    expect(await sessionRecord(id)).toMatchObject({ computer_ms: MINUTE, cost_micros: 0 });
    expect(await org.spent()).toBe(0);
  });

  it("once a limit its time counts toward has no room: stops a running computer quietly at the next call, which goes on, and refuses only the computer", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.limit("org", "", 100_000);
    const id = await openSession(org);

    await bash(org, id, ON_COMPUTER);
    // The computer's time uses the limit up.
    await org.advance(200_000);
    expect(await org.call("sandbox_list", { session: id })).toMatchObject({ outcome: "result" });
    expect(await org.spent()).toBe(200_000);

    // A command just-bash runs, while the computer runs: the computer is stopped, and the command runs, saying so.
    await org.advance(5_000);
    const echoed = await bash(org, id, "echo still here");

    expect(echoed).toMatchObject({ outcome: "result", usage: { toolId: "sandbox:bash" } });

    if (echoed.outcome !== "result") throw new Error("not a result");
    expect(textOf(echoed.result)).toBe(`still here\n\n\n${COMPUTER_STOPPED_NOTE}`);
    expect(echoed.result["structuredContent"]).toMatchObject({ note: COMPUTER_STOPPED_NOTE });
    // Its last stretch is charged as it stops.
    expect(await org.spent()).toBe(205_000);

    // Commands just-bash runs go on, free, with nothing more to say.
    await org.advance(MINUTE);
    const listed = await org.call("sandbox_list", { session: id });

    expect(listed.outcome === "result" && JSON.stringify(listed.result)).not.toContain(
      "computer was stopped",
    );
    expect(
      await org.call("sandbox_write", { session: id, path: "a.txt", content: "a" }),
    ).toMatchObject({ outcome: "result" });

    // A command that needs the computer is refused, and starts none.
    const refused = await bash(org, id, ON_COMPUTER);

    expect(refused).toMatchObject({ outcome: "refused", refusal: { kind: "org" } });

    if (refused.outcome !== "refused") throw new Error("not refused");
    expect(refused.computer).toBe("needed");
    expect(refusedText("sandbox_bash", refused)).toMatch(
      /sandbox_bash was not called: it would run on the sandbox session's computer, whose time counts toward the limit\./,
    );

    await org.advance(30 * MINUTE);
    await org.call("sandbox_close", { session: id });

    expect(await org.spent()).toBe(205_000);
    expect(await sessionRecord(id)).toMatchObject({
      computer_ms: 205_000,
      cost_micros: 205_000,
    });
  });

  it("once a limit has no room, says after a file tool's result that the call stopped the running computer", async () => {
    const calls: ReadonlyArray<readonly [string, (session: string) => Schema.JsonObject, string]> =
      [
        ["sandbox_read", (session) => ({ session, path: "a.txt" }), "a"],
        [
          "sandbox_write",
          (session) => ({ session, path: "b.txt", content: "b" }),
          "Successfully wrote",
        ],
        [
          "sandbox_edit",
          (session) => ({ session, path: "a.txt", edits: [{ oldText: "a", newText: "c" }] }),
          "Successfully replaced 1 block(s)",
        ],
      ];

    for (const [tool, args, answer] of calls) {
      const org = await computerOrg(MICRO_PER_MS);

      await org.limit("org", "", 100_000);
      const id = await openSession(org);

      await org.call("sandbox_write", { session: id, path: "a.txt", content: "a" });
      await bash(org, id, ON_COMPUTER);
      // The computer's time uses the limit up.
      await org.advance(200_000);
      await org.call("sandbox_list", { session: id });
      const called = await org.call(tool, args(id));

      if (called.outcome !== "result") throw new Error(`${tool} came to ${called.outcome}`);

      // SAFETY: the sandbox tools answer text contents.
      const texts = (called.result["content"] as ReadonlyArray<{ readonly text: string }>).map(
        (content) => content.text,
      );

      expect([tool, texts[0]]).toEqual([tool, expect.stringContaining(answer)]);
      expect([tool, texts.at(-1)]).toEqual([tool, COMPUTER_STOPPED_NOTE]);
      expect(await org.spent()).toBe(200_000);
    }
  });

  it("refuses a command that needs the computer, saying the computer it found running is stopped", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.limit("org", "", 100_000);
    const id = await openSession(org);

    await bash(org, id, ON_COMPUTER);
    await org.advance(200_000);
    await org.call("sandbox_list", { session: id });
    const refused = await bash(org, id, ON_COMPUTER);

    if (refused.outcome !== "refused") throw new Error(`the call came to ${refused.outcome}`);
    expect(refused).toMatchObject({ computer: "needed", computerStopped: true });
    expect(refusedText("sandbox_bash", refused)).toMatch(
      /it would run on the sandbox session's computer, whose time counts toward the limit, and the computer, which was running, is stopped\./,
    );
    // Its run is charged as it stops, and no more after.
    expect(await org.spent()).toBe(200_000);
    await org.advance(MINUTE);
    await org.call("sandbox_close", { session: id });
    expect(await sessionRecord(id)).toMatchObject({ computer_ms: 200_000 });
  });

  it("stops a running computer when a limit refuses a call of a priced tool in it", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.stub
      .tools()
      .setOverride(org.admin, "sandbox", 0, { tool: "read", price_micros: 100 }, "t");
    await org.limit("org", "", 60_000);
    const id = await openSession(org);

    await bash(org, id, ON_COMPUTER);
    await org.advance(MINUTE);
    await org.call("sandbox_write", { session: id, path: "a.txt", content: "a" });
    expect(await org.spent()).toBe(MINUTE);

    await org.advance(MINUTE);
    expect(await org.call("sandbox_read", { session: id, path: "a.txt" })).toMatchObject({
      outcome: "refused",
      computer: "stopped",
    });
    expect(await org.spent()).toBe(2 * MINUTE);

    await org.advance(MINUTE);
    await org.call("sandbox_close", { session: id });
    expect(await sessionRecord(id)).toMatchObject({ computer_ms: 2 * MINUTE });
  });

  it("adds no computer time for a command whose computer Cloudflare refused to start", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    // The real container backend, over a fake container that Cloudflare's limit refuses.
    realContainerOrgs.add(org.name);
    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);

    await runInDurableObject(
      env.SANDBOX_SESSION.getByName(`${org.name}:${id}`),
      (_instance, state) => {
        fakeContainerOf(state.id.toString()).startFails =
          "There is no Container instance that can be provided to this Durable Object, try again later";
      },
    );

    const failed = await bash(org, id, ON_COMPUTER);

    expect(failed.outcome === "result" && textOf(failed.result)).toMatch(
      /Cloudflare refused to start the computer/,
    );

    // No computer ran: its idle minutes cost nothing either.
    await org.advance(30 * MINUTE);
    await org.call("sandbox_list", { session: id });
    expect(await org.spent()).toBe(0);
    await org.call("sandbox_close", { session: id });
    expect(await sessionRecord(id)).toMatchObject({ computer_ms: 0, cost_micros: 0 });
  });

  it("stops a running computer when a limit refuses a priced sandbox_close, and its idle day goes on", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.stub
      .tools()
      .setOverride(org.admin, "sandbox", 0, { tool: "close", price_micros: 100 }, "t");
    await org.limit("org", "", 60_000);
    const id = await openSession(org);
    const object = env.SANDBOX_SESSION.getByName(`${org.name}:${id}`);
    const alarm = () => runInDurableObject(object, (_instance, state) => state.storage.getAlarm());

    await bash(org, id, ON_COMPUTER);
    await org.advance(MINUTE);
    await org.call("sandbox_list", { session: id });
    expect(await org.spent()).toBe(MINUTE);
    const idleUntil = await alarm();

    await org.advance(MINUTE);
    expect(await org.call("sandbox_close", { session: id })).toMatchObject({
      outcome: "refused",
      computer: "stopped",
    });
    expect(await org.spent()).toBe(2 * MINUTE);
    // The refused call is no use of the session: it closes when it would have, and the part keeps it.
    expect(await alarm()).toBe(idleUntil);
    expect(await keptSessions(org)).toEqual([id]);

    // Stopped, its computer adds nothing more; its alarm closes it a day on.
    await org.advance(DAY);
    await alarmOf(org, id);
    expect(await sessionRecord(id)).toMatchObject({ computer_ms: 2 * MINUTE });
  });

  it("refuses a priced sandbox_bash once a limit has no room, a command just-bash runs too", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.stub
      .tools()
      .setOverride(org.admin, "sandbox", 0, { tool: "bash", price_micros: 100 }, "t");
    await org.limit("org", "", 0);
    const id = await openSession(org);
    const refused = await bash(org, id, "echo hello");

    expect(refused).toMatchObject({ outcome: "refused", refusal: { kind: "org" } });
    // No computer ran, so none was stopped.
    expect(refused).not.toHaveProperty("computer");
  });

  it("with a limit used up before its computer started, refuses the computer and runs just-bash's commands", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.limit("org", "", 0);
    const id = await openSession(org);

    expect(await bash(org, id, ON_COMPUTER)).toMatchObject({
      outcome: "refused",
      computer: "needed",
    });

    const echoed = await bash(org, id, "echo still here");

    expect(echoed.outcome === "result" && textOf(echoed.result)).toBe("still here\n");
    await org.advance(30 * MINUTE);
    await org.call("sandbox_close", { session: id });
    expect(await sessionRecord(id)).toMatchObject({ computer_ms: 0, cost_micros: 0 });
  });

  for (const kind of ["member", "team", "key"] as const)
    it(`counts toward the ${kind} limits of its opener, which stop it once full`, async () => {
      const org = await computerOrg(MICRO_PER_MS);

      const subject = async () => {
        if (kind === "member") return org.alice.member;

        if (kind === "key") return org.keyId;
        const team = await org.stub.createTeam("ops");

        if (!team.ok) throw new Error(team.message);
        await org.stub.addTeamMember(team.value.id, org.alice.member);

        return team.value.id;
      };

      await org.limit(kind, await subject(), 50_000);
      const id = await openSession(org);

      await bash(org, id, ON_COMPUTER);
      await org.advance(MINUTE);
      await org.call("sandbox_list", { session: id });
      expect(await org.spent(kind)).toBe(MINUTE);

      // Full: the next call stops the computer, saying so after its result, and the computer is refused.
      const listed = await org.call("sandbox_list", { session: id });

      expect(listed.outcome === "result" && JSON.stringify(listed.result)).toContain(
        COMPUTER_STOPPED_NOTE,
      );
      expect(await bash(org, id, ON_COMPUTER)).toMatchObject({
        outcome: "refused",
        refusal: { kind },
        computer: "needed",
      });
    });
});

describe("an agent run's sandbox session (#228)", () => {
  const reach = {
    toolScope: [{ toolkit: "sandbox", tools: { kind: "all" as const } }],
    asAgent: true,
    starterMember: "m_starter",
    usage: { agentId: "ag_shared", runId: "ar_1", starter: "member:m_starter" },
  };

  /** A call of `tool` by the shared agent's run, which has no member; `sandbox_open` opens the run's own session. */
  const runCall = (org: Org, tool: string, args: Schema.JsonObject = {}) =>
    org.stub.tools().callTool(
      { admin: false },
      {
        name: tool,
        arguments: args,
        principalId: "run:ar_1",
        run: reach,
        ...(tool === "sandbox_open" ? { runSession: true as const } : {}),
      },
      POLICY,
    );

  it("counts its computer time toward the agent's own limit, per call and from its alarm, and its records name the run", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.limit("agent", "ag_shared", 10_000_000);
    const opened = await runCall(org, "sandbox_open", { computer: true });

    if (opened.outcome !== "result") throw new Error(`the call came to ${opened.outcome}`);
    // SAFETY: `sandbox_open` answers the session in its structured content.
    const id = (opened.result["structuredContent"] as { session: string }).session;

    // The part keeps the agent its alarm's close charges.
    expect(
      await runInDurableObject(org.stub, (_instance, state) =>
        state.storage.sql
          .exec<{ agent: string | null }>(`SELECT agent FROM sandbox_sessions WHERE id = ?`, id)
          .toArray(),
      ),
    ).toEqual([{ agent: "ag_shared" }]);

    const startedAt = await org.now();

    await runCall(org, "sandbox_bash", { session: id, command: ON_COMPUTER });
    await org.advance(MINUTE);
    await runCall(org, "sandbox_list", { session: id });
    expect(await org.spent("agent")).toBe(MINUTE);

    // The alarm reports the rest of the run when the computer stops, charged to the agent the part logged, and the
    // run's session records that stretch then (#230); its close writes no record of its own.
    await org.advance(30 * MINUTE);
    await alarmOf(org, id);
    expect(await org.spent("agent")).toBe(10 * MINUTE);
    await runCall(org, "sandbox_close", { session: id });
    expect(await sessionRecord(id)).toBeNull();
    expect(await sessionRecord(`${id}:${startedAt}`)).toMatchObject({
      principal_id: "run:ar_1",
      member_id: null,
      private: 0,
      agent_id: "ag_shared",
      run_id: "ar_1",
      starter: "member:m_starter",
      requested_at: startedAt,
      computer_ms: 10 * MINUTE,
      cost_micros: 10 * MINUTE,
    });
  });
});

/** A command of the run `ar_1`'s gated call `ticket`. */
const exec = (org: Org, ticket: string, command: string) =>
  org.stub.tools().runSandboxOperation("ar_1", ticket, { op: "exec", command, timeoutMs: 10_000 });

/** What a path is, by the run `ar_1`'s gated call `ticket`. */
const stat = (org: Org, ticket: string) =>
  org.stub.tools().runSandboxOperation("ar_1", ticket, { op: "stat", path: "/workspace/a" });

describe("an agent run's gated sandbox calls (#230)", () => {
  const reach = {
    toolScope: [{ toolkit: "sandbox", tools: { kind: "all" as const } }],
    asAgent: true,
    starterMember: "m_starter",
    usage: { agentId: "ag_shared", runId: "ar_1", starter: "member:m_starter" },
  };

  /** A call of `tool` by the shared agent's run; `executes`: gated for the run to execute (its ticket's id). */
  const runCall = (org: Org, tool: string, args: Schema.JsonObject, executes = false) =>
    org.stub.tools().callTool(
      { admin: false },
      {
        name: tool,
        arguments: args,
        principalId: "run:ar_1",
        run: reach,
        ...(executes ? { executes: true as const } : {}),
        ...(tool === "sandbox_open" ? { runSession: true as const } : {}),
      },
      POLICY,
    );

  /** The run's session, opened with the computer. */
  const runSession = async (org: Org) => {
    const opened = await runCall(org, "sandbox_open", { computer: true });

    if (opened.outcome !== "result") throw new Error(`the call came to ${opened.outcome}`);

    // SAFETY: `sandbox_open` answers the session in its structured content.
    return (opened.result["structuredContent"] as { session: string }).session;
  };

  /** Gates the run's call of `tool` in `session`: its ticket. */
  const gate = async (org: Org, session: string, tool: string) => {
    const gated = await runCall(org, tool, { session }, true);

    if (gated.outcome !== "gated") throw new Error(`the call came to ${gated.outcome}`);

    return gated.ticket.id;
  };

  it("meter each operation's computer time, charged at once to the agent, and the session records each stretch as it stops", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.limit("agent", "ag_shared", 10_000_000);
    const id = await runSession(org);
    const firstAt = await org.now();
    const command = await gate(org, id, "sandbox_bash");

    expect(await exec(org, command, ON_COMPUTER)).toMatchObject({ ok: true });
    await org.advance(MINUTE);

    // Another call's operation answers the minute since, charged to the agent; the call's ticket holds its price only.
    const read = await gate(org, id, "sandbox_read");

    expect(await stat(org, read)).toEqual({ ok: true, value: null });
    expect(await org.spent("agent")).toBe(MINUTE);
    expect(await org.stub.tools().settleRunSandboxCall("ar_1", command)).toMatchObject({
      costMicros: 0,
      agent: "ag_shared",
    });
    expect((await org.stub.tools().settleRunSandboxCall("ar_1", read))?.refusal).toBeUndefined();

    // The computer stops ten idle minutes after its command: the alarm charges the rest and records the stretch.
    await org.advance(30 * MINUTE);
    await alarmOf(org, id);
    expect(await org.spent("agent")).toBe(10 * MINUTE);
    expect(await sessionRecord(`${id}:${firstAt}`)).toMatchObject({
      principal_id: "run:ar_1",
      agent_id: "ag_shared",
      run_id: "ar_1",
      tool_id: null,
      requested_at: firstAt,
      computer_ms: 10 * MINUTE,
      cost_micros: 10 * MINUTE,
    });
    // With nothing left to do, a run's session has no alarm: no idle day ends it.
    expect(await alarmAt(org, id)).toBeNull();

    // A second stretch, still running when the run is deleted: the purge stops it, charges it and records it.
    const secondAt = await org.now();

    expect(await exec(org, await gate(org, id, "sandbox_bash"), ON_COMPUTER)).toMatchObject({
      ok: true,
    });
    await org.advance(2 * MINUTE);
    expect(await org.stub.tools().purgeRunSandboxSessions(["ar_1"])).toEqual(["ar_1"]);
    expect(await org.spent("agent")).toBe(12 * MINUTE);
    expect(await sessionRecord(`${id}:${secondAt}`)).toMatchObject({
      requested_at: secondAt,
      computer_ms: 2 * MINUTE,
      cost_micros: 2 * MINUTE,
    });
    // The session writes no record of its own.
    expect(await sessionRecord(id)).toBeNull();
    expect(await keptSessions(org)).toEqual([]);
  });

  it("record a stretch that ended before the next call as its own, and try a record that failed again from the alarm", async () => {
    const org = await computerOrg(MICRO_PER_MS);
    const session = await sessionClass();
    const id = await runSession(org);
    const firstAt = await org.now();

    await exec(org, await gate(org, id, "sandbox_bash"), ON_COMPUTER);
    // The next command comes after the computer stopped, before its alarm: the first stretch is recorded first.
    await org.advance(15 * MINUTE);
    const secondAt = await org.now();

    // Its record fails, and fails again as the call ends.
    session.failRecords = 2;
    await exec(org, await gate(org, id, "sandbox_bash"), ON_COMPUTER);
    expect(await sessionRecord(`${id}:${firstAt}`)).toBeNull();
    expect(await alarmAt(org, id)).toBe(secondAt + SETTLE_RETRY_MS);

    await org.advance(SETTLE_RETRY_MS);
    await alarmOf(org, id);
    expect(await sessionRecord(`${id}:${firstAt}`)).toMatchObject({ computer_ms: 10 * MINUTE });

    await org.advance(30 * MINUTE);
    await alarmOf(org, id);
    expect(await sessionRecord(`${id}:${secondAt}`)).toMatchObject({ computer_ms: 10 * MINUTE });
  });

  it("once a limit has no room, stop a running computer with a note, and refuse only a command that needs it, which ends the turn", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.limit("agent", "ag_shared", 100_000);
    const id = await runSession(org);
    const startedAt = await org.now();

    await exec(org, await gate(org, id, "sandbox_bash"), ON_COMPUTER);
    await org.advance(200_000);
    // The computer's time uses the limit up.
    expect(await stat(org, await gate(org, id, "sandbox_read"))).toMatchObject({ ok: true });
    expect(await org.spent("agent")).toBe(200_000);

    // A call that does not need the computer goes on: the computer is stopped, and the model is told.
    await org.advance(5_000);
    const read = await gate(org, id, "sandbox_read");

    expect(await stat(org, read)).toEqual({ ok: true, value: null, note: COMPUTER_STOPPED_NOTE });
    expect(await org.spent("agent")).toBe(205_000);
    expect(await sessionRecord(`${id}:${startedAt}`)).toMatchObject({
      computer_ms: 205_000,
      cost_micros: 205_000,
    });
    expect(await stat(org, read)).toEqual({ ok: true, value: null });
    expect((await org.stub.tools().settleRunSandboxCall("ar_1", read))?.refusal).toBeUndefined();

    // A command just-bash runs runs; one that needs the computer is refused, and settling the call answers the refusal.
    const command = await gate(org, id, "sandbox_bash");

    expect(await exec(org, command, "echo still here")).toMatchObject({
      ok: true,
      value: { stdout: "still here\n" },
    });
    expect(await exec(org, command, ON_COMPUTER)).toMatchObject({ ok: false, reason: "failed" });
    expect(await org.stub.tools().settleRunSandboxCall("ar_1", command)).toMatchObject({
      refusal: { kind: "agent" },
    });
    expect(await org.spent("agent")).toBe(205_000);
  });

  it("charge a priced tool's price as the call is gated, which its ticket holds, and refuse it once a limit has no room", async () => {
    const org = await computerOrg();

    await org.stub
      .tools()
      .setOverride(org.admin, "sandbox", 0, { tool: "bash", price_micros: 100 }, "t");
    await org.limit("agent", "ag_shared", 150);
    const id = await runSession(org);
    const command = await gate(org, id, "sandbox_bash");

    expect(await org.spent("agent")).toBe(100);
    expect(await org.stub.tools().settleRunSandboxCall("ar_1", command)).toMatchObject({
      costMicros: 100,
      agent: "ag_shared",
    });

    // The limit's room is used: the next call is refused at its gate, with no ticket and no charge.
    await gate(org, id, "sandbox_bash");
    expect(await org.spent("agent")).toBe(200);
    expect(await runCall(org, "sandbox_bash", { session: id }, true)).toMatchObject({
      outcome: "refused",
      refusal: { kind: "agent" },
    });
    expect(await org.spent("agent")).toBe(200);
  });
});

describe("a member's leaving", () => {
  it("settles their open session as a close does: charges its computer time, writes its record, then deletes it", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);

    await bash(org, id, ON_COMPUTER);
    await org.advance(MINUTE);
    await runInDurableObject(org.stub, async (instance) => {
      await instance.tools().memberLeft(org.alice.member);
    });

    expect(await org.spent()).toBe(MINUTE);
    expect(await sessionRecord(id)).toMatchObject({ computer_ms: MINUTE, cost_micros: MINUTE });
    expect(await keptSessions(org)).toEqual([]);
    // Nothing of it is left, and no alarm wakes it.
    expect(
      await runInDurableObject(
        env.SANDBOX_SESSION.getByName(`${org.name}:${id}`),
        (_instance, state) => [...state.storage.kv.list()].map(([key]) => key),
      ),
    ).toEqual([]);
    expect(await alarmOf(org, id)).toBe(false);
  });

  it("reaches a session whose last call failed in the sandbox, as that call was a use of it", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    // The real container backend, over a fake container that Cloudflare's limit refuses.
    realContainerOrgs.add(org.name);
    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);

    await runInDurableObject(
      env.SANDBOX_SESSION.getByName(`${org.name}:${id}`),
      (_instance, state) => {
        fakeContainerOf(state.id.toString()).startFails =
          "There is no Container instance that can be provided to this Durable Object, try again later";
      },
    );
    // Its only call after it opened fails, half a day on; the member leaves more than a day after it opened.
    await org.advance(DAY / 2);
    expect(await bash(org, id, ON_COMPUTER)).toMatchObject({ outcome: "result" });
    await org.advance(DAY * 0.75);
    await runInDurableObject(org.stub, async (instance) => {
      await instance.tools().memberLeft(org.alice.member);
    });

    expect(await keptSessions(org)).toEqual([]);
    expect(await sessionRecord(id)).toMatchObject({ computer_ms: 0, cost_micros: 0 });
    expect(
      await runInDurableObject(
        env.SANDBOX_SESSION.getByName(`${org.name}:${id}`),
        (_instance, state) => [...state.storage.kv.list()].map(([key]) => key),
      ),
    ).toEqual([]);
  });

  it("keeps the closed note of a session whose record could not be written, for its alarm to write once", async () => {
    const org = await computerOrg(MICRO_PER_MS);
    const session = await sessionClass();

    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);

    await bash(org, id, ON_COMPUTER);
    await org.advance(MINUTE);
    session.failRecords = 1;
    await runInDurableObject(org.stub, async (instance) => {
      await instance.tools().memberLeft(org.alice.member);
    });

    // Charged and forgotten by the part; its files gone, its note kept with the record.
    expect(await org.spent()).toBe(MINUTE);
    expect(await keptSessions(org)).toEqual([]);
    expect(await sessionRecord(id)).toBeNull();
    expect(
      await runInDurableObject(
        env.SANDBOX_SESSION.getByName(`${org.name}:${id}`),
        (_instance, state) => [...state.storage.kv.list()].map(([key]) => key),
      ),
    ).toEqual(["sandbox:session"]);

    await org.advance(SETTLE_RETRY_MS);
    await alarmOf(org, id);
    expect(await sessionRecord(id)).toMatchObject({ computer_ms: MINUTE, cost_micros: MINUTE });
    expect(await org.spent()).toBe(MINUTE);

    // A second leaving finds it closed: nothing more is charged or written.
    await runInDurableObject(org.stub, async (instance) => {
      await instance.tools().memberLeft(org.alice.member);
    });
    expect(await org.spent()).toBe(MINUTE);
  });
});

describe("the org's deletion", () => {
  it("deletes its open sandbox sessions without a record or a charge, then any sandbox session record", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);

    await bash(org, id, ON_COMPUTER);
    await org.advance(MINUTE);
    expect(await org.stub.tools().purgeSandboxSessions(20)).toEqual({ purged: 1, remaining: 0 });

    // Nothing is left of it: no alarm closes it later, writes a record or reports to the ControlPlane.
    expect(await alarmOf(org, id)).toBe(false);
    expect(await sessionRecord(id)).toBeNull();
    expect(await org.spent()).toBe(0);

    // A session record written before the step reached it goes with the step's last call.
    const other = await openSession(org);

    await org.call("sandbox_close", { session: other });
    expect(await sessionRecord(other)).not.toBeNull();
    await deleteSessionRecords(env.USAGE, org.name);
    expect(await sessionRecord(other)).toBeNull();
  });
});

describe("a session object", () => {
  it("opened by a Tools part from before computer time meters nothing and writes no record", async () => {
    const org = await computerOrg(MICRO_PER_MS);
    const id = `sbx_${"1".repeat(32)}`;
    const object = env.SANDBOX_SESSION.getByName(`${org.name}:${id}`);
    const caller = { org: org.name, owner: org.principal, now: await org.now() };

    expect(
      await object.open(caller, { network: { kind: "none" }, computer: true }, POLICY),
    ).toEqual({ ok: true, value: null });
    const ran = await object.run(caller, ON_COMPUTER, 10_000);

    expect(ran).not.toHaveProperty("computerTime");
    await org.advance(MINUTE);
    expect(await object.close(caller)).toEqual({ ok: true, value: null });
    expect(await sessionRecord(id)).toBeNull();
  });

  it("from before computer time, under a part from #224 on: meters and charges nothing, and stops nothing", async () => {
    const org = await computerOrg(MICRO_PER_MS);

    (await sessionClass()).before224 = true;
    await org.stub
      .tools()
      .setOverride(org.admin, "sandbox", 0, { tool: "read", price_micros: 100 }, "t");
    await org.limit("org", "", 0);
    const id = await openSession(org);

    // It takes no word of the limit: its computer runs, and answers no time to charge.
    expect(await bash(org, id, ON_COMPUTER)).toMatchObject({
      outcome: "result",
      usage: { costMicros: 0 },
    });
    await org.advance(MINUTE);

    // A priced call refused: the object has no `stopForLimit`, so no computer is said to stop.
    const refused = await org.call("sandbox_read", { session: id, path: "a.txt" });

    expect(refused).toMatchObject({ outcome: "refused" });
    expect(refused).not.toHaveProperty("computer");
    await org.call("sandbox_close", { session: id });
    expect(await org.spent()).toBe(0);
    expect(await sessionRecord(id)).toBeNull();
  });
});
