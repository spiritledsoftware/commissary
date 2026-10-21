// A browser session's handoff and the Browser sessions page (#216, ADR 0039, ADR 0044) in the Tools part over RPC, on a
// fake provider's browsers (test/support/fake-sessions.ts): `browser_ask_human` starts a handoff and answers so (the
// MCP endpoint reaches the person), the same call again waits until the person clicks Done or Failed, or until the
// handoff times out (TestClock), each call for at most 45 seconds before it answers that the handoff still waits, every
// call waiting on it answered alike (a call woken after a newer handoff started leaves that one be), an approval rule
// holding only the call that starts one (one let through as a wait starts none), and a declined elicitation declines
// it; while it waits no tool acts on the page, and the fields the person filled (typed into, even where the page kept
// the value; every field that is not empty where typing could not be marked; every text field on a page's odd answer)
// are masked from then on, as after a Live View. Only the session's member gets its Live View (a 60-second link, never
// in a tool result nor a log); an org admin lists and ends the org's sessions but watches none.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, type Schema } from "effect";
import { TestClock } from "effect/testing";
import type { ToolCall, ToolCallOutcome } from "../src/control-plane-part.ts";
import type { HandoffResult } from "../src/browser/provider.ts";
import {
  browserSessionStub,
  HANDOFF_WAIT_MS,
  LIVE_VIEW_EXPIRES_MS,
  MAX_MASKS,
  OUTCOME_KEPT_MS,
} from "../src/browser/session-object.ts";
import { MASK } from "../src/browser/session.ts";
import { HANDOFF_TIMEOUT_MS, IDLE_TIMEOUT_MS } from "../src/browser/session-tools.ts";
import { fakeBrowsers } from "./support/fake-sessions.ts";
import type { BrowserSession as TestBrowserSession } from "./worker.ts";

const POLICY = { ownHosts: [], localDevelopment: false };

const ALICE = { member: "m-alice", admin: false };

const BOB = { member: "m-bob", admin: false };

const ADMIN = { member: "m-admin", admin: true };

/** Alice's principal on the API host: her API key. */
const ALICES_KEY = "key:k-alice";

const REASON = "Sign in to example.com, then click Done.";

/** An org whose deployment has the browser, with the browser toolkit granted to all. */
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

  return { name, stub };
};

type Org = Awaited<ReturnType<typeof org>>;

/** What a call of `name` comes to, as Alice through her API key, from an endpoint that reaches a handoff's person. */
const outcomeOf = (
  plane: Org,
  name: string,
  args: Schema.JsonObject,
  more: Partial<ToolCall> = {},
  viewer = ALICE,
  principalId = ALICES_KEY,
): Promise<ToolCallOutcome> =>
  plane.stub
    .tools()
    .callTool(
      viewer,
      { name, arguments: args, principalId, handoffOutcomes: true, ...more },
      POLICY,
    );

/** The tool result of a call that came to one. */
const resultOf = (outcome: ToolCallOutcome): Schema.JsonObject => {
  if (outcome.outcome !== "result") throw new Error(`the call came to ${outcome.outcome}`);

  return outcome.result;
};

const call = async (plane: Org, name: string, args: Schema.JsonObject, viewer = ALICE) =>
  resultOf(await outcomeOf(plane, name, args, {}, viewer));

const textOf = (result: Schema.JsonObject): string =>
  // SAFETY: the session tools answer text contents, but for the screenshot's image.
  (result["content"] as ReadonlyArray<{ readonly text?: string }>)
    .map((content) => content.text ?? "")
    .join("\n");

/** Alice's session at the fake web's sign-in page, and its browser at the provider. */
const signInSession = async (plane: Org) => {
  const opened = textOf(await call(plane, "browser_open", { url: "https://example.com/login" }));

  const id = /Browser session (bs_[0-9a-f]{32}) is open/.exec(opened)?.[1];

  if (id === undefined) throw new Error(`no session opened: ${opened}`);

  return { id, browser: fakeBrowsers.opened.at(-1) ?? "" };
};

/** Asks a person to act in the session `id`: the call starts the handoff. */
const askHuman = async (plane: Org, id: string) => {
  const outcome = await outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });

  if (outcome.outcome !== "handoff") throw new Error(`the call came to ${outcome.outcome}`);

  return outcome;
};

/**
 * The person ends the handoff in the session `id` (Done, or Failed): the provider's event reaches the session's object
 * on its own connection, so the fake's runs in the object's context, as Browser Run's does.
 */
const complete = (plane: Org, id: string, browser: string, result: HandoffResult) =>
  runInDurableObject(browserSessionStub(env.BROWSER_SESSIONS, plane.name, id), () =>
    fakeBrowsers.completeHandoff(browser, result),
  );

/** A `TestClock` at the real time, which the session's object reads the time from from now on. */
const sessionClock = async (plane: Org, id: string) => {
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));

  await Effect.runPromise(clock.setTime(Date.now()));
  await runInDurableObject(browserSessionStub(env.BROWSER_SESSIONS, plane.name, id), (instance) =>
    instance.useClock(clock),
  );

  return { adjust: (millis: number) => Effect.runPromise(clock.adjust(millis)) };
};

/**
 * Puts the org's browser toolkit under an approval rule for its write tools, and answers `browser_ask_human` calls in
 * the session `id` whose caller is asked to approve on a form (`ask`), and one that starts a handoff, approved
 * (`start`).
 */
const underApprovals = async (plane: Org, id: string) => {
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

  const ask = (more: Partial<ToolCall> = {}) =>
    outcomeOf(
      plane,
      "browser_ask_human",
      { sessionId: id, reason: REASON },
      { approvalForm: {}, ...more },
    );

  const start = async () => {
    const asked = await ask();

    if (asked.outcome !== "approve") throw new Error(`the call came to ${asked.outcome}`);

    return await ask({ approvalForm: { answer: "accept", requestState: asked.requestState } });
  };

  return { ask, start };
};

/** A moment for calls on their way to reach the session's object. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 150));

/** The snapshot of the session `id`, as Alice's model takes it. */
const snapshotOf = async (plane: Org, id: string) =>
  textOf(await call(plane, "browser_snapshot", { sessionId: id }));

afterEach(() => {
  fakeBrowsers.failWatch = false;
  fakeBrowsers.failLiveView = undefined;
  fakeBrowsers.filledOverride = undefined;
  fakeBrowsers.filledGate = undefined;
  vi.restoreAllMocks();
});

describe("browser_ask_human", () => {
  it("is a write tool of the browser toolkit that takes the session and what the person should do", async () => {
    const plane = await org();
    const tools = await plane.stub.tools().clientTools(ALICE);
    const tool = tools.find((each) => each.name === "browser_ask_human");

    expect(tool?.toolClass).toBe("write");
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      required: ["sessionId", "reason"],
    });
  });

  it("starts a handoff with the reason as the instructions; the same call again waits until the person clicks Done, and the fields they filled are masked from then on", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);
    const before = Date.now();
    const started = await askHuman(plane, id);

    expect(started.sessionId).toBe(id);
    expect(started.until).toBeGreaterThanOrEqual(before + HANDOFF_TIMEOUT_MS);
    expect(fakeBrowsers.handoff(browser)).toEqual({
      instructions: REASON,
      timeout: HANDOFF_TIMEOUT_MS,
    });

    // While the person acts, no tool acts on the page: a snapshot would show what they type.
    const busy = await call(plane, "browser_snapshot", { sessionId: id });

    expect(busy["isError"]).toBe(true);
    expect(textOf(busy)).toContain(`A person is acting in browser session ${id}`);

    fakeBrowsers.fill(browser, "user", "alice-the-person");
    fakeBrowsers.fill(browser, "password", "hunter2");

    const waiting = outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    await complete(plane, id, browser, { success: true });

    const done = resultOf(await waiting);

    expect(done["isError"]).not.toBe(true);
    expect(done["structuredContent"]).toEqual({ outcome: "done" });
    expect(textOf(done)).toContain(`The person clicked Done in browser session ${id}`);

    const snapshot = textOf(await call(plane, "browser_snapshot", { sessionId: id }));

    expect(snapshot).toContain(`- textbox "Username" [ref=e2]: ${MASK}`);
    expect(snapshot).not.toContain("alice-the-person");
    expect(snapshot).not.toContain("hunter2");

    const screenshot = await call(plane, "browser_take_screenshot", { sessionId: id });

    // SAFETY: the fake's screenshot is the page's text, base64 in an image content.
    const image = (screenshot["content"] as ReadonlyArray<{ readonly data: string }>)[0]?.data;

    expect(atob(image ?? "")).not.toContain("alice-the-person");

    // Once the form is sent the field has gone with its page, but its value in the next address is masked.
    const sent = textOf(await call(plane, "browser_click", { sessionId: id, ref: "e4" }));

    expect(sent).toContain(`- Page URL: https://example.com/welcome?user=${MASK}`);
  });

  it("answers Failed with the person's reason, alike for two minutes, and a later call asks anew", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);
    const clock = await sessionClock(plane, id);

    await askHuman(plane, id);
    await complete(plane, id, browser, { success: false, reason: "no such account" });

    const failed = await call(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    expect(failed["structuredContent"]).toEqual({ outcome: "failed", reason: "no such account" });
    expect(textOf(failed)).toBe(
      `The person clicked Failed in browser session ${id} (no such account).`,
    );

    // A client's retry within two minutes of the first answer gets the same.
    await clock.adjust(OUTCOME_KEPT_MS - 1_000);
    expect(
      (await call(plane, "browser_ask_human", { sessionId: id, reason: REASON }))[
        "structuredContent"
      ],
    ).toEqual({ outcome: "failed", reason: "no such account" });

    // After that the next call asks a person again.
    await clock.adjust(1_000);
    expect((await askHuman(plane, id)).sessionId).toBe(id);
    expect(fakeBrowsers.handoff(browser)).toEqual({
      instructions: REASON,
      timeout: HANDOFF_TIMEOUT_MS,
    });
  });

  it("answers every call waiting on the handoff alike when the person clicks Done", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);

    await askHuman(plane, id);

    const first = outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });
    const second = outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    await complete(plane, id, browser, { success: true });

    for (const answer of await Promise.all([first, second]))
      expect(resultOf(answer)["structuredContent"]).toEqual({ outcome: "done" });
  });

  it("answers after a while that the handoff still waits, until when, so that the client calls again", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);
    const started = await askHuman(plane, id);

    // A call waits HANDOFF_WAIT_MS of the live clock: this object's, 100 milliseconds.
    expect(HANDOFF_WAIT_MS).toBe(45_000);
    await runInDurableObject(browserSessionStub(env.BROWSER_SESSIONS, plane.name, id), (instance) =>
      // SAFETY: the test Worker binds `BROWSER_SESSIONS` to its own `BrowserSession` (test/worker.ts).
      (instance as unknown as TestBrowserSession).waitOnHandoffFor(100),
    );

    const still = await call(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    expect(still["isError"]).not.toBe(true);
    expect(textOf(still)).toBe(
      `A person is still asked to act in browser session ${id}, until ${new Date(started.until).toISOString()}. ` +
        `Call browser_ask_human again with the same sessionId to keep waiting for them.`,
    );
    expect(fakeBrowsers.handoff(browser)).toBeDefined();
    expect((await plane.stub.tools().listBrowserSessions(ALICE)).sessions).toMatchObject([
      { id, handoff: { until: new Date(started.until).toISOString() } },
    ]);

    // The client calls again, and the person clicks Done meanwhile.
    const waiting = outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    await complete(plane, id, browser, { success: true });
    expect(resultOf(await waiting)["structuredContent"]).toEqual({ outcome: "done" });
  });

  it("times out after thirty minutes when nobody finishes, and the session stays open past its idle minutes meanwhile", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);
    const clock = await sessionClock(plane, id);

    await askHuman(plane, id);

    // Its idle minutes pass while the person has not acted: the alarm keeps it open, asking about the handoff.
    await clock.adjust(IDLE_TIMEOUT_MS + 1_000);
    expect(
      await runDurableObjectAlarm(browserSessionStub(env.BROWSER_SESSIONS, plane.name, id)),
    ).toBe(true);
    expect(fakeBrowsers.isOpen(browser)).toBe(true);

    const waiting = outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    await clock.adjust(HANDOFF_TIMEOUT_MS);

    const timedOut = resultOf(await waiting);

    expect(timedOut["structuredContent"]).toEqual({ outcome: "timed_out" });
    expect(textOf(timedOut)).toBe(
      `Nobody finished the handoff in browser session ${id} within 30 minutes: it timed out.`,
    );
    expect(fakeBrowsers.isOpen(browser)).toBe(true);
  });

  it("declines the handoff when the person declined the client's elicitation", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);

    await askHuman(plane, id);

    const declined = resultOf(
      await outcomeOf(
        plane,
        "browser_ask_human",
        { sessionId: id, reason: REASON },
        { handoffAnswer: "decline" },
      ),
    );

    expect(declined["structuredContent"]).toEqual({ outcome: "declined" });
    expect(fakeBrowsers.handoff(browser)).toBeUndefined();

    // The page is the model's again.
    expect(await call(plane, "browser_tab_list", { sessionId: id })).not.toHaveProperty("isError");
  });

  it("answers an endpoint from before handoffs in words, without a link", async () => {
    const plane = await org();
    const { id } = await signInSession(plane);

    const outcome = await outcomeOf(
      plane,
      "browser_ask_human",
      { sessionId: id, reason: REASON },
      { handoffOutcomes: undefined },
    );

    expect(textOf(resultOf(outcome))).toContain(
      `A person is asked to act in browser session ${id}, on its page in the panel`,
    );
  });

  it("masks a field the person typed into even when the page kept its value (a controlled input)", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);

    await askHuman(plane, id);
    expect(fakeBrowsers.watching(browser)).toBe(true);
    fakeBrowsers.fill(browser, "user", "alice-controlled", true);

    const waiting = outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    await complete(plane, id, browser, { success: true });
    expect(resultOf(await waiting)["structuredContent"]).toEqual({ outcome: "done" });
    expect(fakeBrowsers.watching(browser)).toBe(false);

    const snapshot = await snapshotOf(plane, id);

    expect(snapshot).toContain(`- textbox "Username" [ref=e2]: ${MASK}`);
    expect(snapshot).not.toContain("alice-controlled");
  });

  it("masks every field that is not empty when what the person types could not be marked", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);

    fakeBrowsers.failWatch = true;
    await askHuman(plane, id);
    expect(fakeBrowsers.watching(browser)).toBe(false);
    fakeBrowsers.fill(browser, "user", "alice-unmarked", true);

    const waiting = outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    await complete(plane, id, browser, { success: true });
    expect(resultOf(await waiting)["structuredContent"]).toEqual({ outcome: "done" });

    const snapshot = await snapshotOf(plane, id);

    expect(snapshot).toContain(`- textbox "Username" [ref=e2]: ${MASK}`);
    expect(snapshot).not.toContain("alice-unmarked");
  });

  it("masks every text field when the page answers anything but a list of selectors for the fields filled", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);

    // The model typed this one itself; the page's odd answer leaves no telling it from what the person typed.
    await call(plane, "browser_type", { sessionId: id, ref: "e2", text: "typed-by-the-model" });
    await askHuman(plane, id);
    fakeBrowsers.fill(browser, "password", "hunter2");
    fakeBrowsers.filledOverride = { selectors: 'input[name="nothing"]' };

    const waiting = outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    await complete(plane, id, browser, { success: true });
    expect(resultOf(await waiting)["structuredContent"]).toEqual({ outcome: "done" });

    const snapshot = await snapshotOf(plane, id);

    expect(snapshot).toContain(`- textbox "Username" [ref=e2]: ${MASK}`);
    expect(snapshot).not.toContain("typed-by-the-model");
    expect(snapshot).not.toContain("hunter2");
  });

  it("answers a call woken by a handoff's end with it, and leaves a newer handoff waiting", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);
    const stub = browserSessionStub(env.BROWSER_SESSIONS, plane.name, id);

    await askHuman(plane, id);

    const waiting = outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    await pause();

    // The handoff's end holds the object's turn (reading what was filled) while two calls queue behind it: another
    // tool, which drops the outcome, and a new handoff. The waiting call is woken after them.
    let release = () => {};

    fakeBrowsers.filledGate = new Promise<void>((resolve) => (release = resolve));
    await complete(plane, id, browser, { success: true });

    const snapshot = call(plane, "browser_snapshot", { sessionId: id });

    await pause();

    const second = outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    await pause();
    await runInDurableObject(stub, () => release());

    expect(resultOf(await waiting)["structuredContent"]).toEqual({ outcome: "done" });
    expect(textOf(await snapshot)).not.toContain("A person is acting");
    expect((await second).outcome).toBe("handoff");

    // The new handoff still waits for its person.
    expect(fakeBrowsers.handoff(browser)).toBeDefined();
    expect(textOf(await call(plane, "browser_snapshot", { sessionId: id }))).toContain(
      `A person is acting in browser session ${id}`,
    );
  });

  it("is held by an approval rule only when it starts a handoff: its waits and a decline go through", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);

    const { ask, start } = await underApprovals(plane, id);

    expect((await start()).outcome).toBe("handoff");

    // Waiting on it, and its answer kept for the client's retry: no approval asked.
    const waiting = ask({ handoffAnswer: "accept" });

    await complete(plane, id, browser, { success: true });
    expect(resultOf(await waiting)["structuredContent"]).toEqual({ outcome: "done" });
    expect(resultOf(await ask())["structuredContent"]).toEqual({ outcome: "done" });

    // Another tool drops the outcome: the next handoff is approved again, and the person's decline lands.
    await snapshotOf(plane, id);
    expect((await ask()).outcome).toBe("approve");
    expect((await start()).outcome).toBe("handoff");
    expect(resultOf(await ask({ handoffAnswer: "decline" }))["structuredContent"]).toEqual({
      outcome: "declined",
    });
    expect(fakeBrowsers.handoff(browser)).toBeUndefined();
  });

  it("starts no handoff for a call let through its approvals as a wait, when the handoff went meanwhile", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);
    const stub = browserSessionStub(env.BROWSER_SESSIONS, plane.name, id);
    const { ask, start } = await underApprovals(plane, id);

    expect((await start()).outcome).toBe("handoff");

    // The handoff's end holds the object's turn while it still waits in storage: another tool queues (it will drop the
    // outcome), then an ask the Tools part lets through its approvals as one that continues the handoff.
    let release = () => {};

    fakeBrowsers.filledGate = new Promise<void>((resolve) => (release = resolve));
    await complete(plane, id, browser, { success: true });

    const snapshot = call(plane, "browser_snapshot", { sessionId: id });

    await pause();

    const asked = ask();

    await pause();
    await runInDurableObject(stub, () => release());
    await snapshot;

    // It answers that no handoff waits, and starts none: a new one is approved first.
    expect(textOf(resultOf(await asked))).toBe(
      `No handoff waits in browser session ${id}: ask a person to act in it with browser_ask_human.`,
    );
    expect(fakeBrowsers.handoff(browser)).toBeUndefined();
    expect((await ask()).outcome).toBe("approve");
  });

  it("is the session's owner's only", async () => {
    const plane = await org();
    const { id } = await signInSession(plane);

    const bobs = resultOf(
      await outcomeOf(
        plane,
        "browser_ask_human",
        { sessionId: id, reason: REASON },
        {},
        BOB,
        "key:k-bob",
      ),
    );

    expect(textOf(bobs)).toBe(`Unknown browser session ${id}. Open one with browser_open.`);
  });
});

describe("the Browser sessions page", () => {
  it("lists a member's own sessions with the handoff that waits for them, and an org admin every session, with whose it is", async () => {
    const plane = await org();
    const { id } = await signInSession(plane);
    const started = await askHuman(plane, id);

    const own = await plane.stub.tools().listBrowserSessions(ALICE);

    expect(own.sessions).toEqual([
      {
        id,
        opened_at: expect.any(String),
        member: { member_id: ALICE.member },
        opened_by: "api_key",
        own: true,
        watchable: true,
        profile: null,
        handoff: { until: new Date(started.until).toISOString() },
      },
    ]);

    expect((await plane.stub.tools().listBrowserSessions(BOB)).sessions).toEqual([]);

    const admins = await plane.stub.tools().listBrowserSessions(ADMIN);

    expect(admins.sessions).toMatchObject([
      { id, own: false, watchable: false, member: { member_id: ALICE.member }, handoff: null },
    ]);

    // The session's page tells its member what they are asked; an org admin sees no handoff.
    const page = await plane.stub.tools().browserSession(ALICE, id);

    expect(page.ok && page.value.handoff).toEqual({
      until: new Date(started.until).toISOString(),
      reason: REASON,
    });

    const adminPage = await plane.stub.tools().browserSession(ADMIN, id);

    expect(adminPage.ok && adminPage.value.handoff).toBeNull();
    expect(await plane.stub.tools().browserSession(BOB, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("mints a Live View for the session's member only, which connects within 60 seconds and is in no tool result", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);
    const before = Date.now();
    const minted = await plane.stub.tools().browserLiveView(ALICE, id);

    if (!minted.ok) throw new Error(minted.message);
    expect(minted.value.url).toMatch(/^https:\/\/live\.browser\.run\/ui\/view\?mode=tab&/);
    expect(fakeBrowsers.liveViews.at(-1)).toEqual({ browser, expiresInMs: LIVE_VIEW_EXPIRES_MS });
    expect(LIVE_VIEW_EXPIRES_MS).toBe(60_000);

    const expires = Date.parse(minted.value.expires_at);

    expect(expires).toBeGreaterThanOrEqual(before + 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 60_000);

    // An org admin sees the session but may not watch it; another member does not see it at all.
    expect(await plane.stub.tools().browserLiveView(ADMIN, id)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await plane.stub.tools().browserLiveView(BOB, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(fakeBrowsers.liveViews.filter((each) => each.browser === browser)).toHaveLength(1);

    // No tool's answer carries a Live View link, a handoff's included.
    const started = await askHuman(plane, id);

    const answers = [
      JSON.stringify(started),
      JSON.stringify(await call(plane, "browser_tab_list", { sessionId: id })),
    ];

    await complete(plane, id, browser, { success: true });
    answers.push(
      JSON.stringify(await call(plane, "browser_ask_human", { sessionId: id, reason: REASON })),
    );

    for (const answer of answers) expect(answer).not.toContain("live.browser.run");
  });

  it("lets an org admin end a member's session, whose calls then answer that it is closed", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);

    expect(await plane.stub.tools().endBrowserSession(BOB, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await plane.stub.tools().endBrowserSession(ADMIN, id)).toEqual({
      ok: true,
      value: { id, ended: true },
    });
    expect(fakeBrowsers.isOpen(browser)).toBe(false);
    expect(await call(plane, "browser_snapshot", { sessionId: id })).toEqual({
      content: [
        {
          type: "text",
          text: `Browser session ${id} is closed (it was ended in the panel). Open a new one with browser_open.`,
        },
      ],
      isError: true,
    });
    expect((await plane.stub.tools().listBrowserSessions(ADMIN)).sessions).toEqual([]);
    expect(await plane.stub.tools().browserLiveView(ALICE, id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("lets a member end their own session, a waiting handoff's call answering that it closed", async () => {
    const plane = await org();
    const { id } = await signInSession(plane);

    await askHuman(plane, id);
    const waiting = outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    expect((await plane.stub.tools().endBrowserSession(ALICE, id)).ok).toBe(true);
    expect(textOf(resultOf(await waiting))).toBe(
      `Browser session ${id} is closed (it was ended in the panel). Open a new one with browser_open.`,
    );
  });

  it("forgets a handoff that ended without a call hearing it, and one another tool dropped", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);

    await askHuman(plane, id);
    await complete(plane, id, browser, { success: true });

    // The person clicked Done, and the client has not called since: the list asks the session.
    expect((await plane.stub.tools().listBrowserSessions(ALICE)).sessions).toMatchObject([
      { id, handoff: null },
    ]);

    // Another tool acting on the page drops how it ended; then the session asks anew.
    await snapshotOf(plane, id);
    await askHuman(plane, id);
    expect((await plane.stub.tools().listBrowserSessions(ALICE)).sessions).toMatchObject([
      { id, handoff: { until: expect.any(String) } },
    ]);
    await complete(plane, id, browser, { success: false, reason: "gave up" });
    await snapshotOf(plane, id);
    expect((await plane.stub.tools().listBrowserSessions(ALICE)).sessions).toMatchObject([
      { id, handoff: null },
    ]);
  });

  it("marks what the member types in a Live View for the session's life, and masks it before each next call acts", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);

    expect((await plane.stub.tools().browserLiveView(ALICE, id)).ok).toBe(true);
    expect(fakeBrowsers.watching(browser)).toBe(true);

    // A call before they type: the frame stays open after it, past its link's minute.
    expect(await snapshotOf(plane, id)).toContain(`- textbox "Username" [ref=e2]`);
    expect(fakeBrowsers.watching(browser)).toBe(true);

    // A controlled input: only the mark tells the member typed into it.
    fakeBrowsers.fill(browser, "user", "alice-in-live-view", true);

    const snapshot = await snapshotOf(plane, id);

    expect(snapshot).toContain(`- textbox "Username" [ref=e2]: ${MASK}`);
    expect(snapshot).not.toContain("alice-in-live-view");
    expect(fakeBrowsers.watching(browser)).toBe(true);

    // The address the form goes to is masked too.
    const sent = textOf(await call(plane, "browser_click", { sessionId: id, ref: "e4" }));

    expect(sent).toContain(`- Page URL: https://example.com/welcome?user=${MASK}`);
  });

  it("masks what the member types while a call reads the page, at that read", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);
    const stub = browserSessionStub(env.BROWSER_SESSIONS, plane.name, id);

    expect((await plane.stub.tools().browserLiveView(ALICE, id)).ok).toBe(true);

    // The call's filled-field step has read the page; the member types before its snapshot is taken.
    let release = () => {};

    fakeBrowsers.filledGate = new Promise<void>((resolve) => (release = resolve));

    const snapshot = snapshotOf(plane, id);

    await pause();
    fakeBrowsers.fill(browser, "user", "typed-mid-call", true);
    await runInDurableObject(stub, () => release());

    const read = await snapshot;

    expect(read).toContain(`- textbox "Username" [ref=e2]: ${MASK}`);
    expect(read).not.toContain("typed-mid-call");
  });

  it("masks every field that takes text once its masks pass their cap", async () => {
    const plane = await org();
    const { id } = await signInSession(plane);

    await call(plane, "browser_type", { sessionId: id, ref: "e2", text: "visible-name" });
    expect(await snapshotOf(plane, id)).toContain("visible-name");

    const masked = await browserSessionStub(env.BROWSER_SESSIONS, plane.name, id).maskFields(
      { org: plane.name, member: ALICE.member, principal: ALICES_KEY },
      Array.from({ length: MAX_MASKS + 1 }, (_, index) => `input[name="f${index}"]`),
    );

    expect(masked).toBe(true);
    expect(await snapshotOf(plane, id)).toContain(`- textbox "Username" [ref=e2]: ${MASK}`);
  });

  it("masks every field that is not empty after a Live View whose typing could not be marked", async () => {
    const plane = await org();
    const { id, browser } = await signInSession(plane);

    fakeBrowsers.failWatch = true;
    expect((await plane.stub.tools().browserLiveView(ALICE, id)).ok).toBe(true);
    fakeBrowsers.fill(browser, "user", "alice-unmarked", true);

    const snapshot = await snapshotOf(plane, id);

    expect(snapshot).toContain(`- textbox "Username" [ref=e2]: ${MASK}`);
    expect(snapshot).not.toContain("alice-unmarked");
  });

  it("logs no Live View link, nor answers one when minting fails", async () => {
    const plane = await org();
    const logged: Array<string> = [];

    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...args: Array<unknown>) => {
        logged.push(args.map((arg) => String(arg)).join(" "));
      });

    const { id, browser } = await signInSession(plane);

    expect((await plane.stub.tools().browserLiveView(ALICE, id)).ok).toBe(true);

    fakeBrowsers.failLiveView =
      "could not reach https://live.browser.run/ui/view?jwt=secret-leaked";
    const failed = await plane.stub.tools().browserLiveView(ALICE, id);

    expect(failed).toMatchObject({ ok: false, error: "browser_failed" });
    expect(JSON.stringify(failed)).not.toContain("live.browser.run");
    fakeBrowsers.failLiveView = undefined;

    await askHuman(plane, id);
    const waiting = outcomeOf(plane, "browser_ask_human", { sessionId: id, reason: REASON });

    await complete(plane, id, browser, { success: true });
    await waiting;

    for (const line of logged) {
      expect(line).not.toContain("live.browser.run");
      expect(line).not.toContain("jwt=");
    }
  });
});
