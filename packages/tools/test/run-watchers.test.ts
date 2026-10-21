// A shared agent's run that no one started (#232, ADR 0040 "Who watches and steers") in the Tools part over RPC: its
// agent's watchers, as the Agents area answers them (a fake here, `RUN_WATCHERS_KEY` in test/worker.ts), are its
// caller. Under an approval rule of the caller its call waits for one of them (no longer `no_approver`), who sees and
// decides it; they watch the browser sessions the run opened (their Live View, the handoffs in them), which belong to
// no member; an org admin lists those sessions but watches none, and another member sees none. And how what a parked
// call waits on stands (`runWaitState`), as the run gateway asks it: an approval undecided, decided or expired by the
// part's clock, a handoff waiting or ended, and `gone` for what is not the run's. The run's parking itself is the app
// Worker's tests' (apps/app/test/agent-runs.test.ts).
import { env, runInDurableObject } from "cloudflare:test";
import { Effect, type Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCall, ToolCallOutcome } from "../src/control-plane-part.ts";
import { browserSessionStub } from "../src/browser/session-object.ts";
import { fakeBrowsers } from "./support/fake-sessions.ts";
import { RUN_WATCHERS_KEY } from "./worker.ts";

const POLICY = { ownHosts: [], localDevelopment: false };

const ALICE = { member: "m-alice", admin: false };

const BOB = { member: "m-bob", admin: false };

const ADMIN = { member: "m-admin", admin: true };

const RUN = "ar_unattended";

const REASON = "Sign in to example.com, then click Done.";

/** The reach of a shared agent's run that no one started: no member behind it. */
const REACH = {
  toolScope: [{ toolkit: "browser", tools: { kind: "all" as const } }],
  asAgent: true,
};

/** An org whose deployment has the browser, granted to all, and whose run {@link RUN} Bob watches. */
const org = async () => {
  const name = crypto.randomUUID();
  const stub = env.BROWSER_CONTROL_PLANE.getByName(name);

  const written = await stub.tools().writeGrant(
    {
      revision: 0,
      value: { subject: { kind: "everyone" }, toolkit: "browser", tools: { kind: "all" } },
    },
    "test",
  );

  if (!written.ok) throw new Error(written.message);
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.kv.put(RUN_WATCHERS_KEY + RUN, [BOB.member]),
  );

  return { name, stub };
};

type Org = Awaited<ReturnType<typeof org>>;

/** A call of `name` by the run {@link RUN}, from an endpoint that understands approvals and handoffs. */
const runCall = (
  plane: Org,
  name: string,
  args: Schema.JsonObject,
  more: Partial<ToolCall> = {},
): Promise<ToolCallOutcome> =>
  plane.stub.tools().callTool(
    { admin: false },
    {
      name,
      arguments: args,
      principalId: `run:${RUN}`,
      run: REACH,
      approvalOutcomes: true,
      handoffOutcomes: true,
      ...more,
    },
    POLICY,
  );

const textOf = (outcome: ToolCallOutcome): string => {
  if (outcome.outcome !== "result") throw new Error(`the call came to ${outcome.outcome}`);

  // SAFETY: the session tools answer text contents.
  return (outcome.result["content"] as ReadonlyArray<{ readonly text?: string }>)
    .map((content) => content.text ?? "")
    .join("\n");
};

/** The run's session at the fake web's sign-in page, and its browser at the provider. */
const runSession = async (plane: Org) => {
  const opened = textOf(await runCall(plane, "browser_open", { url: "https://example.com/login" }));
  const id = /Browser session (bs_[0-9a-f]{32}) is open/.exec(opened)?.[1];

  if (id === undefined) throw new Error(`no session opened: ${opened}`);

  return { id, browser: fakeBrowsers.opened.at(-1) ?? "" };
};

/** Puts the org's browser toolkit's write tools under an approval rule of the caller. */
const underApprovals = async (plane: Org) => {
  const current = (await plane.stub.tools().listToolkits(ADMIN)).toolkits.find(
    (toolkit) => toolkit.id === "browser",
  );

  const ruled = await plane.stub
    .tools()
    .updateToolkit(
      ADMIN,
      "browser",
      current?.revision ?? 0,
      { approval_rules: { writes: {} } },
      "test",
      POLICY,
    );

  if (!ruled.ok) throw new Error(ruled.message);
};

/** A `TestClock` at the real time, which the org's Tools part reads the time from from now on. */
const partClock = async (plane: Org) => {
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));

  await Effect.runPromise(clock.setTime(Date.now()));
  await runInDurableObject(plane.stub, (instance) => instance.tools().useClock(clock));

  return { adjust: (millis: number) => Effect.runPromise(clock.adjust(millis)) };
};

afterEach(() => {
  fakeBrowsers.failWatch = false;
});

describe("an approval of a run no one started", () => {
  it("waits for the run's watchers, who see and decide it; the same call then goes through", async () => {
    const plane = await org();
    const { id } = await runSession(plane);

    await underApprovals(plane);
    const asked = await runCall(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    if (asked.outcome !== "pending") throw new Error(`the call came to ${asked.outcome}`);
    expect(asked.approval.approver).toEqual({ kind: "caller" });
    const approval = asked.approval.id;

    expect(await plane.stub.tools().runWaitState(RUN, { kind: "approval", id: approval })).toBe(
      "waiting",
    );
    // Another run's wait on it is not its own.
    expect(
      await plane.stub.tools().runWaitState("ar_other", { kind: "approval", id: approval }),
    ).toBe("gone");

    // Its watcher sees it with its arguments and decides it; no other member, and an org admin decides none.
    expect(await plane.stub.tools().getApproval(BOB, approval)).toMatchObject({
      ok: true,
      value: { id: approval },
    });
    expect((await plane.stub.tools().listApprovals(BOB)).approvals).toHaveLength(1);
    expect(await plane.stub.tools().getApproval(ALICE, approval)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(
      await plane.stub.tools().decideApproval(ALICE, approval, "approve", "user:alice"),
    ).toMatchObject({ ok: false, error: "not_found" });
    expect(
      await plane.stub.tools().decideApproval(ADMIN, approval, "approve", "user:admin"),
    ).toMatchObject({ ok: false, error: "not_found" });
    expect(
      await plane.stub.tools().decideApproval(BOB, approval, "approve", "user:bob"),
    ).toMatchObject({ ok: true, value: { status: "approved" } });

    expect(await plane.stub.tools().runWaitState(RUN, { kind: "approval", id: approval })).toBe(
      "ready",
    );

    // The run makes the same call again: it goes through, and starts the handoff.
    expect(
      await runCall(plane, "browser_ask_human", { sessionId: id, reason: REASON }),
    ).toMatchObject({ outcome: "handoff", sessionId: id });
  });

  it("expires after its hour by the part's clock", async () => {
    const plane = await org();
    const { id } = await runSession(plane);

    await underApprovals(plane);
    const clock = await partClock(plane);
    const asked = await runCall(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    if (asked.outcome !== "pending") throw new Error(`the call came to ${asked.outcome}`);
    const waiting = { kind: "approval" as const, id: asked.approval.id };

    await clock.adjust(59 * 60_000);
    expect(await plane.stub.tools().runWaitState(RUN, waiting)).toBe("waiting");

    await clock.adjust(2 * 60_000);
    expect(await plane.stub.tools().runWaitState(RUN, waiting)).toBe("expired");
    expect(await plane.stub.tools().runWaitState(RUN, { kind: "approval", id: "ap_none" })).toBe(
      "gone",
    );
  });
});

describe("a browser session of a run no one started", () => {
  it("is its run's watchers' to watch, an org admin's to list, and no other member's", async () => {
    const plane = await org();
    const { id, browser } = await runSession(plane);

    const asked = await runCall(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    if (asked.outcome !== "handoff") throw new Error(`the call came to ${asked.outcome}`);

    expect((await plane.stub.tools().listBrowserSessions(BOB)).sessions).toMatchObject([
      { id, own: false, watchable: true, handoff: { until: new Date(asked.until).toISOString() } },
    ]);
    expect((await plane.stub.tools().listBrowserSessions(ALICE)).sessions).toEqual([]);
    expect((await plane.stub.tools().listBrowserSessions(ADMIN)).sessions).toMatchObject([
      { id, watchable: false, handoff: null },
    ]);

    expect(await plane.stub.tools().browserLiveView(BOB, id)).toMatchObject({ ok: true });
    expect(await plane.stub.tools().browserLiveView(ADMIN, id)).toMatchObject({
      ok: false,
      error: "forbidden",
    });

    // The session's page tells its watcher what the handoff asks; an org admin, who watches none, learns nothing of it.
    expect(await plane.stub.tools().browserSession(BOB, id)).toMatchObject({
      ok: true,
      value: { member: null, watchable: true, handoff: { reason: REASON } },
    });
    expect(await plane.stub.tools().browserSession(ADMIN, id)).toMatchObject({
      ok: true,
      value: { member: null, watchable: false, handoff: null },
    });
    expect(await plane.stub.tools().browserLiveView(ALICE, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });

    // The handoff the run's call waits on, until its person ends it.
    const handoff = { kind: "handoff" as const, id };

    expect(await plane.stub.tools().runWaitState(RUN, handoff)).toBe("waiting");
    expect(await plane.stub.tools().runWaitState("ar_other", handoff)).toBe("gone");

    await runInDurableObject(browserSessionStub(env.BROWSER_SESSIONS, plane.name, id), () =>
      fakeBrowsers.completeHandoff(browser, { success: true }),
    );

    expect(await plane.stub.tools().runWaitState(RUN, handoff)).toBe("ready");
  });

  it("has no approver for a run's call whose run no one watches", async () => {
    const plane = await org();
    const { id } = await runSession(plane);

    await underApprovals(plane);
    await runInDurableObject(plane.stub, (_instance, state) =>
      state.storage.kv.put(RUN_WATCHERS_KEY + RUN, []),
    );

    expect(
      await runCall(plane, "browser_ask_human", { sessionId: id, reason: REASON }),
    ).toMatchObject({ outcome: "not_approved", reason: "no_approver" });
  });

  it("follows the run's watchers as the Agents area answers them", async () => {
    const plane = await org();
    const { id } = await runSession(plane);

    await runInDurableObject(plane.stub, (_instance, state) =>
      state.storage.kv.put(RUN_WATCHERS_KEY + RUN, [ALICE.member]),
    );

    expect(await plane.stub.tools().browserLiveView(ALICE, id)).toMatchObject({ ok: true });
    expect(await plane.stub.tools().browserLiveView(BOB, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });
});
