// Browser time (#214, ADR 0039): a Quick Action's call carries the browser milliseconds Browser Run reports, a browser
// session writes one usage record of its browser time when it closes, and an org admin's price per browser hour on the
// browser toolkit makes that time cost money, prorated, toward the member's, their teams', the org's and the API key's
// Spend limits as priced tool calls do: a call that would use browser time is refused once a limit it counts toward has
// no room, and an open session is then closed. The part and the sessions' objects read one TestClock, set before a
// session opens, so the browser time and its cost are exact.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Effect, type Schema } from "effect";
import { TestClock } from "effect/testing";
import type { NewSpendLimit } from "@commissary/state/spend";
import {
  type BrowserSessionNamespace,
  browserSessions,
  browserSessionStub,
  SETTLE_RETRY_MS,
} from "../src/browser/session-object.ts";
import { IDLE_TIMEOUT_MS } from "../src/browser/session-tools.ts";
import { refusedText } from "../src/mcp/endpoint.ts";
import { deleteBrowserSessionRecords } from "../src/usage/record.ts";
import { migrateUsageDb } from "./support/usage-db.ts";
import type { BrowserSession as TestBrowserSession } from "./worker.ts";

beforeAll(async () => {
  await migrateUsageDb();
});

const POLICY = { ownHosts: [], localDevelopment: false };

const OWNER = { role: "owner" as const, sensitive: false };

/** An hour's price that makes a millisecond of browser time cost one micro-USD. */
const MICRO_PER_MS = 3_600_000;

/**
 * The test Worker's `BrowserSession` class (test/worker.ts) as loaded in the objects' isolate, reached through an
 * instance's constructor, whose statics set what new objects read the time from and which writes of theirs fail.
 */
const sessionClass = async (): Promise<typeof TestBrowserSession> => {
  const stub = env.BROWSER_SESSIONS.getByName(`test:${crypto.randomUUID()}`);

  return await runInDurableObject(
    stub,
    // SAFETY: the test Worker binds `BROWSER_SESSIONS` to its own `BrowserSession` (test/worker.ts).
    (instance) => instance.constructor as typeof TestBrowserSession,
  );
};

afterEach(async () => {
  const session = await sessionClass();

  session.clock = undefined;
  session.failRecords = 0;
  session.failReports = 0;
});

/**
 * An org whose browser toolkit everyone may use, at `hourPrice` per browser hour when given, with an admin and alice,
 * who calls with an API key of hers; its part and the sessions it opens read the time from one `TestClock`.
 */
const browserOrg = async (hourPrice?: number) => {
  const name = crypto.randomUUID();
  const stub = env.BROWSER_CONTROL_PLANE.getByName(name);

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

  await Effect.runPromise(clock.setTime(Date.now()));
  await runInDurableObject(stub, (instance) => instance.tools().useClock(clock));
  (await sessionClass()).clock = clock;

  const written = await stub.tools().writeGrant(
    {
      revision: 0,
      value: { subject: { kind: "everyone" }, toolkit: "browser", tools: { kind: "all" } },
    },
    "test",
  );

  if (!written.ok) throw new Error(written.message);

  const plane = {
    stub,
    name,
    admin,
    alice,
    keyId,
    principal: `key:${keyId}`,
    advance: (millis: number) => Effect.runPromise(clock.adjust(millis)),
    now: () => Effect.runPromise(clock.currentTimeMillis),
    /** Sets the price per browser hour (`null`: none). */
    price: async (price: number | null) => {
      const current = (await stub.tools().listToolkits(admin)).toolkits.find(
        (toolkit) => toolkit.id === "browser",
      );

      const priced = await stub
        .tools()
        .updateToolkit(
          admin,
          "browser",
          current?.revision ?? 1,
          { browser_hour_price_micros: price },
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
    /** What the limit of `kind` has counted today. */
    spent: async (kind: NewSpendLimit["kind"] = "org") =>
      (await stub.spendOverview(admin)).entries.find((entry) => entry.kind === kind)?.spentMicros,
  };

  if (hourPrice !== undefined) await plane.price(hourPrice);

  return plane;
};

type Org = Awaited<ReturnType<typeof browserOrg>>;

const PAGE = { url: "https://example.com/" };

/** The text of a tool result's contents. */
const textOf = (result: Schema.JsonObject): string =>
  // SAFETY: the session tools answer text contents, but for the screenshot's image.
  (result["content"] as ReadonlyArray<{ readonly text?: string }>)
    .map((content) => content.text ?? "")
    .join("\n");

/** Opens a session as alice; its id. */
const openSession = async (org: Org, args: Schema.JsonObject = {}) => {
  const opened = await org.call("browser_open", args);

  if (opened.outcome !== "result") throw new Error(`the call came to ${opened.outcome}`);
  const id = /Browser session (bs_[0-9a-f]{32}) is open/.exec(textOf(opened.result))?.[1];

  if (id === undefined) throw new Error(`no session opened: ${textOf(opened.result)}`);

  return id;
};

/** Runs the alarm of the org's session `id`. */
const alarmOf = (org: Org, id: string) =>
  runDurableObjectAlarm(browserSessionStub(env.BROWSER_SESSIONS, org.name, id));

/** The usage record of the browser session `id`, if it wrote one. */
const sessionRecord = async (id: string) =>
  await env.USAGE.prepare(`SELECT * FROM usage_records WHERE request_id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();

/** The ids of the org's browser sessions its part logs as open. */
const loggedSessions = (org: Org) =>
  runInDurableObject(org.stub, (_instance, state) =>
    state.storage.sql
      .exec<{ id: string }>(`SELECT id FROM browser_sessions ORDER BY id`)
      .toArray()
      .map((row) => row.id),
  );

describe("the price per browser hour", () => {
  it("is an org admin's to set on the browser toolkit, read back on it, and cleared with null", async () => {
    const org = await browserOrg();
    const tools = org.stub.tools();

    expect(
      await tools.updateToolkit(
        org.admin,
        "browser",
        1,
        { browser_hour_price_micros: 90_000 },
        "test",
        POLICY,
      ),
    ).toMatchObject({ ok: true, value: { revision: 2, browser_hour_price_micros: 90_000 } });
    expect((await tools.listToolkits(org.alice)).toolkits[0]).toMatchObject({
      id: "browser",
      browser_hour_price_micros: 90_000,
    });

    for (const price of [-1, 1.5, 2 ** 60])
      expect(
        await tools.updateToolkit(
          org.admin,
          "browser",
          2,
          { browser_hour_price_micros: price },
          "test",
          POLICY,
        ),
      ).toMatchObject({ ok: false, error: "invalid" });

    expect(
      await tools.updateToolkit(
        org.alice,
        "browser",
        2,
        { browser_hour_price_micros: 1 },
        "test",
        POLICY,
      ),
    ).toMatchObject({ ok: false, error: "forbidden" });

    const cleared = await tools.updateToolkit(
      org.admin,
      "browser",
      2,
      { browser_hour_price_micros: null },
      "test",
      POLICY,
    );

    expect(cleared).toMatchObject({ ok: true, value: { revision: 3 } });
    expect(cleared.ok && "browser_hour_price_micros" in cleared.value).toBe(false);
  });

  it("belongs to the browser toolkit only: the sandbox toolkit refuses one", async () => {
    const tools = env.SANDBOX_CONTROL_PLANE.getByName(crypto.randomUUID()).tools();

    expect(
      await tools.updateToolkit(
        { member: "m-admin", admin: true },
        "sandbox",
        1,
        { browser_hour_price_micros: 1 },
        "test",
        POLICY,
      ),
    ).toMatchObject({ ok: false, error: "built_in" });
  });
});

describe("a Quick Action", () => {
  it("carries the browser milliseconds Browser Run reports, which cost nothing without a price", async () => {
    const org = await browserOrg();

    await org.limit("org", "", 0);

    // Free browser time goes ahead whatever the limits, as a free call does.
    expect(await org.call("browser_markdown", PAGE)).toMatchObject({
      outcome: "result",
      usage: { toolkitId: "browser", toolId: "browser:markdown", browserMs: 1_500, costMicros: 0 },
    });
    // A page Browser Run could not load still used the browser.
    expect(
      await org.call("browser_markdown", { url: "https://unreachable.invalid/" }),
    ).toMatchObject({
      outcome: "result",
      result: { isError: true },
      usage: { browserMs: 1_500, costMicros: 0 },
    });
  });

  it("costs its browser time at the price per browser hour, prorated, besides the tool's price per call", async () => {
    const org = await browserOrg(MICRO_PER_MS);

    await org.stub
      .tools()
      .setOverride(org.admin, "browser", 0, { tool: "links", price_micros: 100 }, "t");
    await org.limit("org", "", 1_000_000);

    expect(await org.call("browser_markdown", PAGE)).toMatchObject({
      outcome: "result",
      usage: { browserMs: 1_500, costMicros: 1_500 },
    });
    expect(await org.call("browser_links", PAGE)).toMatchObject({
      outcome: "result",
      usage: { browserMs: 1_500, costMicros: 1_600 },
    });
    expect(await org.spent()).toBe(3_100);
  });

  it("is refused once a limit it counts toward has no room, though its tool has no price per call", async () => {
    const org = await browserOrg(MICRO_PER_MS);

    await org.limit("org", "", 0);

    expect(await org.call("browser_markdown", PAGE)).toMatchObject({
      outcome: "refused",
      refusal: { kind: "org", period: "day" },
      usage: { costMicros: 0 },
    });
    expect(await org.spent()).toBe(0);
  });
});

describe("a browser session", () => {
  it("writes one usage record of its browser time when it closes, naming no tool and no page", async () => {
    const org = await browserOrg();
    const openedAt = await org.now();
    const id = await openSession(org, { url: "https://example.com/login" });

    expect(await loggedSessions(org)).toEqual([id]);
    await org.advance(60_000);
    expect(await org.call("browser_snapshot", { sessionId: id })).toMatchObject({
      outcome: "result",
      usage: { toolId: "browser:snapshot", costMicros: 0 },
    });
    expect(await sessionRecord(id)).toBeNull();

    await org.advance(30_000);
    await org.call("browser_close", { sessionId: id });
    // Closing again writes nothing more.
    await org.call("browser_close", { sessionId: id });

    const record = await sessionRecord(id);

    expect(record).toMatchObject({
      org_id: org.name,
      principal_id: org.principal,
      member_id: org.alice.member,
      area: "tools",
      toolkit_id: "browser",
      tool_id: null,
      tool_outcome: null,
      auth_type: "shared",
      private: 0,
      requested_at: openedAt,
      browser_ms: 90_000,
      cost_micros: 0,
      browser_profile_id: null,
    });
    expect(JSON.stringify(record)).not.toContain("example.com");
    expect(
      (
        await env.USAGE.prepare(`SELECT COUNT(*) AS n FROM usage_records WHERE request_id = ?`)
          .bind(id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    // The part forgets a session once it is closed.
    expect(await loggedSessions(org)).toEqual([]);
  });

  it("charges its browser time with each call, at the price per browser hour, and its record holds the whole cost", async () => {
    const org = await browserOrg(MICRO_PER_MS);

    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);

    expect(await org.spent()).toBe(0);
    await org.advance(60_000);

    // The call's own record costs its price per call (none); the session's time is the session's record's.
    expect(await org.call("browser_navigate", { sessionId: id, url: PAGE.url })).toMatchObject({
      outcome: "result",
      usage: { costMicros: 0 },
    });
    expect(await org.spent()).toBe(60_000);

    await org.advance(30_000);
    await org.call("browser_close", { sessionId: id });

    expect(await org.spent()).toBe(90_000);
    expect(await sessionRecord(id)).toMatchObject({ browser_ms: 90_000, cost_micros: 90_000 });
  });

  it("costs the stretch before a price change at the old price, and the new one from the next call on", async () => {
    const org = await browserOrg(MICRO_PER_MS);
    const id = await openSession(org);

    await org.advance(10_000);
    await org.price(2 * MICRO_PER_MS);
    await org.advance(10_000);
    // The twenty seconds since the opening, at the price the opening passed.
    await org.call("browser_snapshot", { sessionId: id });
    expect(await sessionRecord(id)).toBeNull();
    await org.advance(10_000);
    // Ten seconds at the new price.
    await org.call("browser_close", { sessionId: id });

    expect(await sessionRecord(id)).toMatchObject({ browser_ms: 30_000, cost_micros: 40_000 });
  });

  it("closed by its alarm after its idle minutes, reports the close with the browser time since its last call", async () => {
    const org = await browserOrg(MICRO_PER_MS);

    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);

    await org.advance(IDLE_TIMEOUT_MS);
    expect(await alarmOf(org, id)).toBe(true);

    expect(await sessionRecord(id)).toMatchObject({
      browser_ms: IDLE_TIMEOUT_MS,
      cost_micros: IDLE_TIMEOUT_MS,
    });
    expect(await org.spent()).toBe(IDLE_TIMEOUT_MS);
    expect(await loggedSessions(org)).toEqual([]);
  });

  it("closed by its alarm, writes its record and reports its close on a later alarm when they failed, once each", async () => {
    const org = await browserOrg(MICRO_PER_MS);

    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);
    const session = await sessionClass();

    session.failRecords = 1;
    session.failReports = 1;
    await org.advance(IDLE_TIMEOUT_MS);
    await alarmOf(org, id);

    // Closed, but nothing written or charged yet.
    expect(await sessionRecord(id)).toBeNull();
    expect(await org.spent()).toBe(0);
    const snapshot = await org.call("browser_snapshot", { sessionId: id });

    expect(snapshot.outcome === "result" && textOf(snapshot.result)).toMatch(/is closed/);

    await org.advance(SETTLE_RETRY_MS);
    await alarmOf(org, id);

    expect(await sessionRecord(id)).toMatchObject({
      browser_ms: IDLE_TIMEOUT_MS,
      cost_micros: IDLE_TIMEOUT_MS,
    });
    expect(await org.spent()).toBe(IDLE_TIMEOUT_MS);

    // Nothing is left to do: the next alarm charges nothing more.
    await org.advance(SETTLE_RETRY_MS);
    await alarmOf(org, id);
    expect(await org.spent()).toBe(IDLE_TIMEOUT_MS);
  });

  it("costs nothing without a price, and goes on whatever the limits", async () => {
    const org = await browserOrg();

    await org.limit("org", "", 0);
    const id = await openSession(org);

    await org.advance(60_000);
    expect(await org.call("browser_snapshot", { sessionId: id })).toMatchObject({
      outcome: "result",
    });
    await org.call("browser_close", { sessionId: id });

    expect(await sessionRecord(id)).toMatchObject({ browser_ms: 60_000, cost_micros: 0 });
    expect(await org.spent()).toBe(0);
  });

  it("opened from a browser profile, names it on its record, and is charged when it closes with a save", async () => {
    const org = await browserOrg(MICRO_PER_MS);

    await org.limit("org", "", 10_000_000);

    const profile = await org.stub
      .tools()
      .createProfile(org.admin, { name: "work" }, "user:admin@example.com");

    if (!profile.ok) throw new Error(profile.message);

    const granted = await org.stub
      .tools()
      .writeProfileGrant(
        { revision: 0, value: { subject: { kind: "everyone" }, profile: profile.value.id } },
        "test",
      );

    if (!granted.ok) throw new Error(granted.message);

    const id = await openSession(org, { profile: "work" });

    await org.advance(45_000);

    // Alice may not save into a shared profile: the session closes all the same, and its last stretch is charged.
    expect(await org.call("browser_close", { sessionId: id, save: true })).toMatchObject({
      outcome: "result",
      result: { isError: true },
    });
    expect(await sessionRecord(id)).toMatchObject({
      browser_profile_id: profile.value.id,
      browser_ms: 45_000,
      cost_micros: 45_000,
    });
    expect(await org.spent()).toBe(45_000);
  });

  it("is refused once a limit its time counts toward has no room, and an open one is closed with a tool error", async () => {
    const org = await browserOrg(MICRO_PER_MS);

    await org.limit("org", "", 100_000);
    const id = await openSession(org);

    // The session's time uses the limit up.
    await org.advance(200_000);
    expect(await org.call("browser_snapshot", { sessionId: id })).toMatchObject({
      outcome: "result",
    });

    await org.advance(5_000);
    const refused = await org.call("browser_snapshot", { sessionId: id });

    expect(refused).toMatchObject({
      outcome: "refused",
      refusal: { kind: "org" },
      sessionClosed: true,
    });
    // Its last stretch is charged as it closes.
    expect(await org.spent()).toBe(205_000);
    expect(await sessionRecord(id)).toMatchObject({ browser_ms: 205_000, cost_micros: 205_000 });

    // What the client is told.
    if (refused.outcome !== "refused") throw new Error("not refused");
    expect(refusedText("browser_snapshot", refused)).toMatch(
      /browser_snapshot was not called, and the browser session is closed: its browser time counts toward the limit\.$/,
    );
    const { sessionClosed: _closed, ...open } = refused;

    expect(refusedText("browser_snapshot", open)).toMatch(/browser_snapshot was not called\.$/);

    // It answers that it is closed from then on, to a call that ends nothing too.
    const closed = await org.call("browser_close", { sessionId: id });

    expect(closed.outcome === "result" && textOf(closed.result)).toMatch(/is closed/);
    expect(closed.outcome === "result" && closed.result["isError"]).toBe(true);

    // And no new session opens, while a tool that reaches no browser still answers.
    expect(await org.call("browser_open", {})).toMatchObject({ outcome: "refused" });
    expect(await org.call("browser_profile_list", {})).toMatchObject({
      outcome: "result",
      usage: { costMicros: 0 },
    });
  });

  for (const kind of ["member", "team", "key"] as const)
    it(`counts toward the ${kind} limits of its opener, which refuse it once full`, async () => {
      const org = await browserOrg(MICRO_PER_MS);

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

      await org.advance(60_000);
      await org.call("browser_snapshot", { sessionId: id });
      expect(await org.spent(kind)).toBe(60_000);

      expect(await org.call("browser_snapshot", { sessionId: id })).toMatchObject({
        outcome: "refused",
        refusal: { kind },
        sessionClosed: true,
      });
    });
});

describe("an agent run's browser session (#228)", () => {
  const run = (usage: { readonly agentId: string; readonly private?: boolean }) => ({
    toolScope: [{ toolkit: "browser", tools: { kind: "all" as const } }],
    asAgent: usage.private !== true,
    starterMember: "m_starter",
    usage: { ...usage, runId: "ar_1", starter: "member:m_starter" },
  });

  /** A call of `tool` by an agent run: a shared agent's has no member, a private agent's acts as alice. */
  const runCall = (
    org: Org,
    reach: ReturnType<typeof run>,
    tool: string,
    args: Schema.JsonObject = {},
  ) =>
    org.stub
      .tools()
      .callTool(
        reach.asAgent ? { admin: false } : org.alice,
        { name: tool, arguments: args, principalId: "run:ar_1", run: reach },
        POLICY,
      );

  const opened = async (org: Org, reach: ReturnType<typeof run>) => {
    const answer = await runCall(org, reach, "browser_open");

    if (answer.outcome !== "result") throw new Error(`the call came to ${answer.outcome}`);
    const id = /Browser session (bs_[0-9a-f]{32}) is open/.exec(textOf(answer.result))?.[1];

    if (id === undefined) throw new Error(`no session opened: ${textOf(answer.result)}`);

    return id;
  };

  it("names the run's agent, the run and its starter on its record, and logs a shared agent for its charges", async () => {
    const org = await browserOrg(MICRO_PER_MS);
    const reach = run({ agentId: "ag_shared" });

    await org.limit("org", "", 10_000_000);
    const id = await opened(org, reach);

    expect(
      await runInDurableObject(org.stub, (_instance, state) =>
        state.storage.sql
          .exec<{ agent: string | null }>(`SELECT agent FROM browser_sessions WHERE id = ?`, id)
          .toArray(),
      ),
    ).toEqual([{ agent: "ag_shared" }]);

    await org.advance(IDLE_TIMEOUT_MS);
    await alarmOf(org, id);

    expect(await sessionRecord(id)).toMatchObject({
      principal_id: "run:ar_1",
      member_id: null,
      private: 0,
      agent_id: "ag_shared",
      run_id: "ar_1",
      starter: "member:m_starter",
      browser_ms: IDLE_TIMEOUT_MS,
    });
    expect(await org.spent()).toBe(IDLE_TIMEOUT_MS);
  });

  it("of a private agent writes a private record, its member's alone", async () => {
    const org = await browserOrg(MICRO_PER_MS);
    const reach = run({ agentId: "ag_mine", private: true });
    const id = await opened(org, reach);

    await runCall(org, reach, "browser_close", { sessionId: id });

    expect(await sessionRecord(id)).toMatchObject({
      member_id: org.alice.member,
      private: 1,
      agent_id: "ag_mine",
      run_id: "ar_1",
    });
  });
});

describe("a session object", () => {
  it("answers a Tools part from before browser time the bare tool result it expects, and meters none of its calls", async () => {
    const org = await browserOrg(MICRO_PER_MS);
    const id = `bs_${"1".repeat(32)}`;
    const object = browserSessionStub(env.BROWSER_SESSIONS, org.name, id);
    const caller = { org: org.name, member: org.alice.member, principal: org.principal };

    const opened = await object.open(caller, id, "browser-run", PAGE.url);

    expect(opened).not.toHaveProperty("result");
    expect(textOf(opened as Schema.JsonObject)).toMatch(/is open/);

    await org.advance(60_000);
    const listed = await object.operate(caller, id, { tool: "tab_list", args: { sessionId: id } });

    expect(textOf(listed as Schema.JsonObject)).toContain(PAGE.url);
    expect(await object.close(caller, id, false)).toEqual({ kind: "closed" });

    // Its time is recorded, and costs nothing: no call charged it.
    expect(await sessionRecord(id)).toMatchObject({ browser_ms: 60_000, cost_micros: 0 });
  });

  it("from before browser time is taken by a Tools part from #214 on as one that used none", async () => {
    const bare = { content: [{ type: "text", text: "Browser session is open." }] };

    // SAFETY: the part reaches only `getByName(...).open`/`operate` here.
    const namespace = {
      getByName: () => ({ open: async () => bare, operate: async () => bare }),
    } as unknown as BrowserSessionNamespace;

    const sessions = browserSessions(namespace);
    const caller = { org: "o", member: undefined, principal: "key:k" };

    expect(
      await sessions.open(caller, "browser-run", undefined, { hourPriceMicros: MICRO_PER_MS }),
    ).toEqual({ result: bare, id: expect.stringMatching(/^bs_/) });
    expect(
      await sessions.operate(
        caller,
        { tool: "tab_list", args: { sessionId: `bs_${"2".repeat(32)}` } },
        { hourPriceMicros: MICRO_PER_MS },
      ),
    ).toEqual({ result: bare });
  });
});

describe("the org's deletion", () => {
  it("deletes its open browser sessions without a record or a charge, then any session record", async () => {
    const org = await browserOrg(MICRO_PER_MS);

    await org.limit("org", "", 10_000_000);
    const id = await openSession(org);

    await org.advance(60_000);
    expect(await org.stub.tools().purgeBrowserSessions(20)).toEqual({ purged: 1, remaining: 0 });
    expect(await loggedSessions(org)).toEqual([]);

    // Nothing is left of it: no alarm closes it later, writes a record or reports to the ControlPlane.
    expect(await alarmOf(org, id)).toBe(false);
    expect(await sessionRecord(id)).toBeNull();
    expect(await org.spent()).toBe(0);

    // A session record written before the step reached it goes with the step's last call.
    const other = await openSession(org);

    await org.call("browser_close", { sessionId: other });
    expect(await sessionRecord(other)).not.toBeNull();
    await deleteBrowserSessionRecords(env.USAGE, org.name);
    expect(await sessionRecord(other)).toBeNull();
  });
});
