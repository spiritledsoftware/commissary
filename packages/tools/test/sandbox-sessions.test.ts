// The sandbox toolkit's open sessions on its page in the panel (#225, ADR 0041): a member lists their own, with when each
// opened, its network and whether its computer runs, and ends any of them; an org admin also lists the org's others and
// ends any, and nobody is shown a file. Real `SandboxSession` objects, with the test Worker's fake computer, whose time
// the part and the objects read from one `TestClock`; a fake second provider (no computer, nothing to wait for) where a
// test needs sessions the provider cannot be asked about, or many.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SandboxSessionsList } from "@commissary/contract/sandbox-sessions";
import { SETTLE_RETRY_MS } from "../src/usage/session-close.ts";
import { testClockStart } from "./support/clock.ts";
import { spentAt } from "./support/spend.ts";
import { migrateUsageDb } from "./support/usage-db.ts";
import type { SandboxSession as TestSandboxSession } from "./worker.ts";

beforeAll(async () => {
  await migrateUsageDb();
});

const POLICY = { ownHosts: [], localDevelopment: false };

const OWNER = { role: "owner" as const, sensitive: false };

const MINUTE = 60_000;

/** A command just-bash lacks (`git`), which the session runs on the computer. */
const ON_COMPUTER = "git status";

const sessionClass = async (): Promise<typeof TestSandboxSession> =>
  await runInDurableObject(
    env.SANDBOX_SESSION.getByName(`test:${crypto.randomUUID()}`),
    // SAFETY: the test Worker binds `SANDBOX_SESSION` to its own `SandboxSession` (test/worker.ts).
    (instance) => instance.constructor as typeof TestSandboxSession,
  );

afterEach(async () => {
  (await sessionClass()).clock = undefined;
});

/**
 * An org on a deployment with the computer: an admin, alice (with an API key) and bob; everyone may use the sandbox.
 * With `fake`, on the deployment whose provider is the fake one: no computer, and no clock but the real one.
 */
const org = async (fake = false) => {
  const name = crypto.randomUUID();

  const stub = fake
    ? env.OTHER_SANDBOX_CONTROL_PLANE.getByName(name)
    : env.COMPUTER_SANDBOX_CONTROL_PLANE.getByName(name);

  const member = async (email: string, role: string) => {
    const added = await stub.addMember({ email, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return { member: added.value.id, admin: role !== "member" };
  };

  const admin = await member("admin@example.com", "admin");
  const alice = await member("alice@example.com", "member");
  const bob = await member("bob@example.com", "member");
  const key = await stub.createApiKey({ memberId: alice.member, name: "alice's" }, Date.now());

  if (!key.ok) throw new Error(key.message);
  const keyId = key.value.record.id;
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));

  if (!fake) {
    await Effect.runPromise(clock.setTime(testClockStart()));
    await runInDurableObject(stub, (instance) => instance.tools().useClock(clock));
    (await sessionClass()).clock = clock;
  }

  const granted = await stub.tools().writeGrant(
    {
      revision: 0,
      value: { subject: { kind: "everyone" }, toolkit: "sandbox", tools: { kind: "all" } },
    },
    "test",
  );

  if (!granted.ok) throw new Error(granted.message);

  const revision = async () =>
    (await stub.tools().listToolkits(admin)).toolkits.find((toolkit) => toolkit.id === "sandbox")
      ?.revision ?? 1;

  const allowed = await stub
    .tools()
    .updateToolkit(
      admin,
      "sandbox",
      await revision(),
      fake ? { network: { kind: "open" } } : { computer: true, network: { kind: "open" } },
      "t",
      POLICY,
    );

  if (!allowed.ok) throw new Error(allowed.message);

  /** A call of `tool` by `viewer`, as a person signed in (or, for alice with `viaKey`, through her API key). */
  const call = async (
    viewer: typeof alice,
    tool: string,
    args: Schema.JsonObject = {},
    viaKey = false,
  ) => {
    const outcome = await stub
      .tools()
      .callTool(
        viewer,
        viaKey
          ? { name: tool, arguments: args, principalId: `key:${keyId}`, apiKeyId: keyId }
          : { name: tool, arguments: args, principalId: `user:${viewer.member}@example.com` },
        POLICY,
      );

    if (outcome.outcome !== "result") throw new Error(`the call came to ${outcome.outcome}`);

    return outcome.result;
  };

  const open = async (
    viewer: typeof alice,
    args: Schema.JsonObject = {},
    viaKey = false,
  ): Promise<string> => {
    const result = await call(viewer, "sandbox_open", args, viaKey);

    // SAFETY: `sandbox_open` answers the session in its structured content.
    return (result["structuredContent"] as { session: string }).session;
  };

  const listed = async (viewer: typeof alice) =>
    Schema.decodeSync(SandboxSessionsList)(await stub.tools().listSandboxSessions(viewer));

  return {
    stub,
    name,
    admin,
    alice,
    bob,
    call,
    open,
    revision,
    now: () => Effect.runPromise(clock.currentTimeMillis),
    advance: (millis: number) => Effect.runPromise(clock.adjust(millis)),
    listed,
    list: async (viewer: typeof alice) => (await listed(viewer)).sessions,
  };
};

describe("the sandbox toolkit's open sessions", () => {
  it("lists a member's own sessions with when each opened, how, its network and its computer, oldest first", async () => {
    const plane = await org();
    const hosts = { kind: "hosts", hosts: ["example.com"], presets: ["package_registries"] };
    const first = await plane.open(plane.alice, { network: hosts });

    await plane.advance(1_000);
    const second = await plane.open(plane.alice, { computer: true }, true);

    await plane.advance(MINUTE);

    const listed = await plane.list(plane.alice);

    expect(listed.map((session) => session.id)).toEqual([first, second]);
    expect(listed[0]).toMatchObject({
      own: true,
      opened_by: "person",
      member: { member_id: plane.alice.member, email: "alice@example.com" },
      network: hosts,
      computer: "off",
    });
    expect(listed[1]).toMatchObject({
      opened_by: "api_key",
      network: { kind: "none" },
      computer: "stopped",
    });
    expect(listed[0]?.opened_at).toBe(new Date(testClockStart()).toISOString());
  });

  it("says whether the computer runs: from the command that starts it until its idle minutes pass", async () => {
    const plane = await org();
    const id = await plane.open(plane.alice, { computer: true });

    expect((await plane.list(plane.alice))[0]?.computer).toBe("stopped");

    await plane.call(plane.alice, "sandbox_bash", { session: id, command: ON_COMPUTER });
    expect((await plane.list(plane.alice))[0]?.computer).toBe("running");

    await plane.advance(11 * MINUTE);
    expect((await plane.list(plane.alice))[0]?.computer).toBe("stopped");
  });

  it("shows a member their own sessions only, and an org admin the others' too, with no file in any", async () => {
    const plane = await org();
    const alices = await plane.open(plane.alice);

    await plane.advance(1_000);
    const bobs = await plane.open(plane.bob);

    await plane.call(plane.alice, "sandbox_write", {
      session: alices,
      path: "secret-plans.txt",
      content: "the launch is on friday",
    });

    expect((await plane.list(plane.bob)).map((session) => session.id)).toEqual([bobs]);
    expect((await plane.list(plane.alice)).map((session) => session.id)).toEqual([alices]);

    const seen = await plane.list(plane.admin);

    expect(seen.map((session) => [session.id, session.own])).toEqual([
      [alices, false],
      [bobs, false],
    ]);
    expect(seen[0]?.member).toEqual({ member_id: plane.alice.member, email: "alice@example.com" });

    // Nothing of a file is in what anyone is told.
    for (const viewer of [plane.alice, plane.bob, plane.admin])
      expect(JSON.stringify(await plane.stub.tools().listSandboxSessions(viewer))).not.toMatch(
        /secret-plans|launch|friday/,
      );
  });

  it("leaves out a session that closed, and shows an agent run's as the run's", async () => {
    const plane = await org();
    const closed = await plane.open(plane.alice);
    const kept = await plane.open(plane.alice);

    await plane.call(plane.alice, "sandbox_close", { session: closed });
    await plane.advance(1_000);

    const outcome = await plane.stub.tools().callTool(
      plane.alice,
      {
        name: "sandbox_open",
        arguments: {},
        principalId: "run:run_1",
        run: {
          toolScope: [{ toolkit: "sandbox", tools: { kind: "all" as const } }],
          asAgent: false,
        },
        runSession: true,
      },
      POLICY,
    );

    if (outcome.outcome !== "result") throw new Error(`the call came to ${outcome.outcome}`);

    const listed = await plane.list(plane.alice);

    expect(listed.map((session) => session.opened_by)).toEqual(["person", "agent_run"]);
    expect(listed[0]?.id).toBe(kept);
  });

  it("lets a member end their own session: it closes, its files go, and its calls find no such session", async () => {
    const plane = await org();
    const id = await plane.open(plane.alice);

    await plane.call(plane.alice, "sandbox_write", { session: id, path: "a.txt", content: "x" });

    expect(await plane.stub.tools().endSandboxSession(plane.alice, id)).toEqual({
      ok: true,
      value: { id, ended: true },
    });
    expect(await plane.list(plane.alice)).toEqual([]);

    const after = await plane.call(plane.alice, "sandbox_read", { session: id, path: "a.txt" });

    expect(after["isError"]).toBe(true);
    expect(after["structuredContent"]).toMatchObject({ reason: "unknown_session" });

    // It is ended once: the second time there is no such session.
    expect(await plane.stub.tools().endSandboxSession(plane.alice, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("lets an org admin end another member's session, and no member end one that is not theirs", async () => {
    const plane = await org();
    const id = await plane.open(plane.alice);

    expect(await plane.stub.tools().endSandboxSession(plane.bob, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await plane.list(plane.alice)).toHaveLength(1);

    expect(await plane.stub.tools().endSandboxSession(plane.admin, id)).toMatchObject({
      ok: true,
    });
    expect(await plane.list(plane.admin)).toEqual([]);
    expect(await plane.stub.tools().endSandboxSession(plane.admin, "sbx_nothing")).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("writes the ended session's record, with the computer time it ran", async () => {
    const plane = await org();
    const id = await plane.open(plane.alice, { computer: true });

    await plane.call(plane.alice, "sandbox_bash", { session: id, command: ON_COMPUTER });
    await plane.advance(MINUTE);
    await plane.stub.tools().endSandboxSession(plane.alice, id);

    const record = await env.USAGE.prepare(
      `SELECT computer_ms FROM usage_records WHERE request_id = ?`,
    )
      .bind(id)
      .first<{ computer_ms: number }>();

    expect(record?.computer_ms).toBe(MINUTE);
  });

  it("charges the computer's time once when a member ends the session, and nothing more later", async () => {
    const plane = await org();

    const price = await plane.stub.tools().updateToolkit(
      plane.admin,
      "sandbox",
      await plane.revision(),
      // One micro per millisecond.
      { computer_hour_price_micros: 3_600_000 },
      "t",
      POLICY,
    );

    if (!price.ok) throw new Error(price.message);

    const limit = await plane.stub.createSpendLimit(
      plane.admin,
      { kind: "org", subject: "", period: "day", amountMicros: 10_000_000 },
      "t",
    );

    if (!limit.ok) throw new Error(limit.message);

    const spent = async () => await spentAt(plane.stub, "org", await plane.now());

    const records = async (id: string) =>
      await env.USAGE.prepare(
        `SELECT COUNT(*) AS n, MAX(cost_micros) AS cost FROM usage_records WHERE request_id = ?`,
      )
        .bind(id)
        .first<{ n: number; cost: number }>();

    const id = await plane.open(plane.alice, { computer: true });

    await plane.call(plane.alice, "sandbox_bash", { session: id, command: ON_COMPUTER });
    await plane.advance(MINUTE);

    expect(await plane.stub.tools().endSandboxSession(plane.alice, id)).toMatchObject({
      ok: true,
    });
    expect(await spent()).toBe(MINUTE);
    expect(await records(id)).toEqual({ n: 1, cost: MINUTE });

    // Ending it again finds no session, and the session's own alarm, run late, has nothing left to report.
    expect(await plane.stub.tools().endSandboxSession(plane.alice, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    await plane.advance(SETTLE_RETRY_MS + 11 * MINUTE);
    await runDurableObjectAlarm(env.SANDBOX_SESSION.getByName(`${plane.name}:${id}`));
    expect(await spent()).toBe(MINUTE);
    expect(await records(id)).toEqual({ n: 1, cost: MINUTE });
  });

  it("keeps a shared agent run's session from a member, and shows it to an org admin as the run's, who may end it", async () => {
    const plane = await org();

    const outcome = await plane.stub.tools().callTool(
      { admin: false },
      {
        name: "sandbox_open",
        arguments: {},
        principalId: "run:ar_1",
        run: {
          toolScope: [{ toolkit: "sandbox", tools: { kind: "all" as const } }],
          asAgent: true,
          starterMember: "m_starter",
          usage: { agentId: "ag_shared", runId: "ar_1", starter: "member:m_starter" },
        },
        runSession: true,
      },
      POLICY,
    );

    if (outcome.outcome !== "result") throw new Error(`the call came to ${outcome.outcome}`);
    // SAFETY: `sandbox_open` answers the session in its structured content.
    const id = (outcome.result["structuredContent"] as { session: string }).session;

    expect(await plane.list(plane.alice)).toEqual([]);
    expect(await plane.stub.tools().endSandboxSession(plane.alice, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });

    expect(await plane.list(plane.admin)).toMatchObject([
      { id, member: null, opened_by: "agent_run", own: false },
    ]);
    expect(await plane.stub.tools().endSandboxSession(plane.admin, id)).toMatchObject({
      ok: true,
    });
    expect(await plane.list(plane.admin)).toEqual([]);
  });
});

describe("the sandbox toolkit's open sessions, with a provider that may not answer", () => {
  it("lists the oldest 200 of the org's for an admin, and tells them more are open", async () => {
    const plane = await org(true);

    for (let each = 0; each < 201; each += 1) await plane.open(plane.bob);

    const alices = await plane.open(plane.alice);

    // Bob's crowd does not push alice's session out of her list.
    expect(await plane.listed(plane.alice)).toMatchObject({
      sessions: [{ id: alices }],
      truncated: false,
    });

    const seen = await plane.listed(plane.admin);

    expect(seen.sessions).toHaveLength(200);
    expect(seen.truncated).toBe(true);
    expect(seen.sessions.map((session) => session.id)).not.toContain(alices);
    expect((await plane.listed(plane.bob)).truncated).toBe(true);
  });

  it("lists a session it cannot be asked about without its network and computer, and forgets one it does not know", async () => {
    const plane = await org(true);
    const silent = await plane.open(plane.alice);
    const lost = await plane.open(plane.alice);
    const fine = await plane.open(plane.alice);

    await plane.call(plane.alice, "sandbox_write", {
      session: silent,
      path: "unreachable",
      content: "",
    });
    await plane.call(plane.alice, "sandbox_write", {
      session: lost,
      path: "vanished",
      content: "",
    });

    const listed = await plane.list(plane.alice);

    expect(listed.map((session) => session.id)).toEqual([silent, fine]);
    expect(listed[0]).not.toHaveProperty("network");
    expect(listed[0]).not.toHaveProperty("computer");
    expect(listed[1]).toMatchObject({ network: { kind: "none" }, computer: "off" });

    const rows = (id: string) =>
      runInDurableObject(
        plane.stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sandbox_sessions WHERE id = ?`, id)
            .one().n,
      );

    expect(await rows(lost)).toBe(0);
    expect(await rows(silent)).toBe(1);
  });

  it("answers sandbox_failed when the provider cannot end a session, which stays open", async () => {
    const plane = await org(true);
    const id = await plane.open(plane.alice);

    await plane.call(plane.alice, "sandbox_write", {
      session: id,
      path: "unreachable",
      content: "",
    });

    expect(await plane.stub.tools().endSandboxSession(plane.alice, id)).toMatchObject({
      ok: false,
      error: "sandbox_failed",
    });
    expect((await plane.list(plane.alice)).map((session) => session.id)).toEqual([id]);
  });
});
