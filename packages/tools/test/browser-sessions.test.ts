// The browser toolkit's interactive sessions (#213, ADR 0039) in the Tools part over RPC, on a fake provider's browsers
// (test/support/fake-sessions.ts): a client opens a session and drives it across separate stateless calls; a session is
// its org's, member's and principal's only; it closes when asked, after ten idle minutes (its object's alarm, driven by
// TestClock) and when the provider ends its browser, and then answers that it is closed; the provider's refusal at its
// account's limit is a clear tool error; and a password field's value is in neither a snapshot nor a screenshot.
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, type Schema } from "effect";
import { TestClock } from "effect/testing";
import { browserSessionStub, CLOSED_KEPT_MS } from "../src/browser/session-object.ts";
import { MASK } from "../src/browser/session.ts";
import { IDLE_TIMEOUT_MS } from "../src/browser/session-tools.ts";
import { fakeBrowsers } from "./support/fake-sessions.ts";

const POLICY = { ownHosts: [], localDevelopment: false };

const ALICE = { member: "m-alice", admin: false };

const BOB = { member: "m-bob", admin: false };

/** Alice's principal on the API host: her API key. */
const ALICES_KEY = "key:k-alice";

const SESSION_TOOLS = [
  "browser_open",
  "browser_navigate",
  "browser_navigate_back",
  "browser_navigate_forward",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_select_option",
  "browser_hover",
  "browser_wait_for",
  "browser_take_screenshot",
  "browser_tab_list",
  "browser_tab_new",
  "browser_tab_select",
  "browser_close",
  "browser_profile_list",
  "browser_ask_human",
];

const READS = new Set([
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_tab_list",
  "browser_profile_list",
]);

afterEach(() => {
  fakeBrowsers.refuseNew = false;
});

/** An org whose deployment has the browser (or the other browser provider), with the browser toolkit granted to all. */
const org = async (namespace = env.BROWSER_CONTROL_PLANE) => {
  const name = crypto.randomUUID();
  const stub = namespace.getByName(name);

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

interface Caller {
  readonly viewer: typeof ALICE;
  readonly principal: string | undefined;
}

const alice: Caller = { viewer: ALICE, principal: ALICES_KEY };

/** The result of a call of the tool `name`, as `caller`. */
const call = async (
  plane: Org,
  caller: Caller,
  name: string,
  args: Schema.JsonObject = {},
): Promise<Schema.JsonObject> => {
  const outcome = await plane.stub
    .tools()
    .callTool(caller.viewer, { name, arguments: args, principalId: caller.principal }, POLICY);

  if (outcome.outcome !== "result") throw new Error(`the call came to ${outcome.outcome}`);

  return outcome.result;
};

/** The text of a result's contents. */
const textOf = (result: Schema.JsonObject): string =>
  // SAFETY: the session tools answer text contents, but for the screenshot's image.
  (result["content"] as ReadonlyArray<{ readonly text?: string }>)
    .map((content) => content.text ?? "")
    .join("\n");

/** Opens a session as `caller`; its id. */
const open = async (plane: Org, caller: Caller = alice, args: Schema.JsonObject = {}) => {
  const result = await call(plane, caller, "browser_open", args);
  const id = /Browser session (bs_[0-9a-f]{32}) is open/.exec(textOf(result))?.[1];

  if (id === undefined) throw new Error(`no session opened: ${textOf(result)}`);

  return id;
};

/** A `TestClock` at the real time, which the session's object reads the time from from now on. */
const sessionClock = async (plane: Org, id: string) => {
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));

  await Effect.runPromise(clock.setTime(Date.now()));
  await runInDurableObject(browserSessionStub(env.BROWSER_SESSIONS, plane.name, id), (instance) =>
    instance.useClock(clock),
  );

  return { adjust: (millis: number) => Effect.runPromise(clock.adjust(millis)) };
};

const runAlarm = (plane: Org, id: string) =>
  runDurableObjectAlarm(browserSessionStub(env.BROWSER_SESSIONS, plane.name, id));

/** What a call answers with a session id that is not the caller's. */
const unknown = (session: string) => ({
  content: [
    { type: "text", text: `Unknown browser session ${session}. Open one with browser_open.` },
  ],
  isError: true,
});

describe("browser sessions", () => {
  it("are tools of the browser toolkit after its Quick Actions, which read only to snapshot, screenshot, list tabs and list profiles", async () => {
    const plane = await org();
    const tools = await plane.stub.tools().clientTools(ALICE);
    const sessionTools = tools.filter((tool) => SESSION_TOOLS.includes(tool.name));

    expect(sessionTools.map((tool) => tool.name)).toEqual(SESSION_TOOLS.toSorted());

    for (const tool of sessionTools)
      expect([tool.name, tool.toolClass]).toEqual([
        tool.name,
        READS.has(tool.name) ? "read" : "write",
      ]);

    expect(tools.find((tool) => tool.name === "browser_click")?.inputSchema).toMatchObject({
      type: "object",
      required: ["sessionId", "ref"],
    });
  });

  it("no tool runs JavaScript in the page: none takes a script, a function or an expression", async () => {
    const plane = await org();
    const tools = await plane.stub.tools().clientTools(ALICE);

    for (const tool of tools) {
      expect(tool.name).not.toMatch(/evaluate|script|run_code|javascript/i);

      // SAFETY: an input schema's `properties` is an object of JSON schemas.
      const properties = (tool.inputSchema?.["properties"] ?? {}) as Record<
        string,
        Schema.JsonObject
      >;

      for (const [name, property] of Object.entries(properties)) {
        if (!/script|function|expression|code|js/i.test(name)) continue;
        // Only the Quick Actions' switch of the page's own script, a boolean.
        expect([name, property["type"]]).toEqual(["javaScriptEnabled", "boolean"]);
      }
    }
  });

  it("are opened, navigated, snapshotted, typed into, clicked and closed across separate calls", async () => {
    const plane = await org();
    const id = await open(plane);

    expect(
      textOf(
        await call(plane, alice, "browser_navigate", {
          sessionId: id,
          url: "https://example.com/login",
        }),
      ),
    ).toBe("- Page URL: https://example.com/login\n- Page Title: Sign in");

    const before = textOf(await call(plane, alice, "browser_snapshot", { sessionId: id }));

    expect(before).toContain('- textbox "Username" [ref=e2]');
    expect(before).toContain('- button "Sign in" [ref=e4]');

    await call(plane, alice, "browser_type", { sessionId: id, ref: "e2", text: "alice" });
    await call(plane, alice, "browser_type", { sessionId: id, ref: "e3", text: "hunter2" });

    const typed = textOf(await call(plane, alice, "browser_snapshot", { sessionId: id }));

    expect(typed).toContain('- textbox "Username" [ref=e2]: alice');
    expect(typed).toContain(
      `- textbox "Password" [ref=e3]:\n  - /placeholder: Your password\n  - text: ${MASK}`,
    );
    expect(typed).not.toContain("hunter2");

    const clicked = textOf(await call(plane, alice, "browser_click", { sessionId: id, ref: "e4" }));

    expect(clicked).toBe(
      "- Page URL: https://example.com/welcome?user=alice\n- Page Title: Welcome",
    );
    expect(textOf(await call(plane, alice, "browser_snapshot", { sessionId: id }))).toContain(
      '- heading "Welcome, alice"',
    );

    expect(await call(plane, alice, "browser_close", { sessionId: id })).toEqual({
      content: [{ type: "text", text: `Browser session ${id} is closed.` }],
    });
    expect(fakeBrowsers.isOpen(fakeBrowsers.opened.at(-1) ?? "")).toBe(false);

    expect(await call(plane, alice, "browser_snapshot", { sessionId: id })).toEqual({
      content: [
        {
          type: "text",
          text: `Browser session ${id} is closed (it was closed). Open a new one with browser_open.`,
        },
      ],
      isError: true,
    });
  });

  it("open at a page when asked, and go back and forward", async () => {
    const plane = await org();
    const result = await call(plane, alice, "browser_open", { url: "https://example.com/" });

    expect(textOf(result)).toContain("- Page URL: https://example.com/\n- Page Title: Page at");
    const id = /(bs_[0-9a-f]{32})/.exec(textOf(result))?.[1] ?? "";

    await call(plane, alice, "browser_click", { sessionId: id, ref: "e2" });

    expect(textOf(await call(plane, alice, "browser_navigate_back", { sessionId: id }))).toContain(
      "- Page URL: https://example.com/\n",
    );
    expect(
      textOf(await call(plane, alice, "browser_navigate_forward", { sessionId: id })),
    ).toContain("- Page URL: https://example.com/next\n");
  });

  it("never show a password field's value in a screenshot", async () => {
    const plane = await org();
    const id = await open(plane, alice, { url: "https://example.com/login" });

    await call(plane, alice, "browser_type", { sessionId: id, ref: "e2", text: "alice" });
    await call(plane, alice, "browser_type", { sessionId: id, ref: "e3", text: "hunter2" });

    const shot = await call(plane, alice, "browser_take_screenshot", { sessionId: id });

    expect(shot).toMatchObject({ content: [{ type: "image", mimeType: "image/png" }] });
    // SAFETY: a screenshot is one image content.
    const [image] = shot["content"] as ReadonlyArray<{ readonly data: string }>;
    const painted = atob(image?.data ?? "");

    expect(painted).toContain("Username: alice");
    expect(painted).not.toContain("hunter2");
  });

  it("mask the fields a handoff filled once told to, with the fields the browser gives no ref and the URLs' queries", async () => {
    const plane = await org();
    const id = await open(plane, alice, { url: "https://example.com/code" });

    await call(plane, alice, "browser_type", { sessionId: id, ref: "e1", text: "908172" });

    // Nothing on the page is masked yet: it is shown as it is.
    const unmasked = textOf(await call(plane, alice, "browser_snapshot", { sessionId: id }));

    expect(unmasked).toContain('- textbox "One-time code" [ref=e1]: 908172');
    expect(unmasked).toContain('- textbox "PIN": 4321');

    const session = browserSessionStub(env.BROWSER_SESSIONS, plane.name, id);
    const owner = { org: plane.name, member: ALICE.member, principal: ALICES_KEY };

    expect(await session.maskFields({ ...owner, member: BOB.member }, ['[name="otp"]'])).toBe(
      false,
    );
    // CSS only: a selector of another engine is refused.
    expect(await session.maskFields(owner, ["xpath=//input"])).toBe(false);
    expect(await session.maskFields(owner, ['[name="otp"]'])).toBe(true);

    const masked = textOf(await call(plane, alice, "browser_snapshot", { sessionId: id }));

    expect(masked).toContain(`- textbox "One-time code" [ref=e1]: ${MASK}`);
    expect(masked).toContain(`- textbox "PIN": ${MASK}`);
    expect(masked).not.toContain("908172");
    expect(masked).not.toContain("4321");

    const shot = await call(plane, alice, "browser_take_screenshot", { sessionId: id });
    // SAFETY: a screenshot is one image content.
    const [image] = shot["content"] as ReadonlyArray<{ readonly data: string }>;

    expect(atob(image?.data ?? "")).not.toContain("908172");

    // A form sent with GET carries its fields in the next address: once a handoff marked fields, queries are masked.
    expect(
      textOf(
        await call(plane, alice, "browser_navigate", {
          sessionId: id,
          url: "https://example.com/welcome?user=alice&otp=908172",
        }),
      ),
    ).toBe(
      `- Page URL: https://example.com/welcome?user=${MASK}&otp=${MASK}\n- Page Title: Welcome`,
    );
    expect(textOf(await call(plane, alice, "browser_tab_list", { sessionId: id }))).toBe(
      `- 0: Welcome (https://example.com/welcome?user=${MASK}&otp=${MASK}) [current]`,
    );
  });

  it("wait for CSS selectors only, refusing those that could probe a field's value", async () => {
    const plane = await org();
    const id = await open(plane, alice, { url: "https://example.com/login" });

    await call(plane, alice, "browser_type", { sessionId: id, ref: "e3", text: "hunter2" });

    for (const selector of [
      '[value^="a"]',
      '[name="password"][VALUE^="h"]',
      "form:has([value*=hunter])",
      'input[name="password"]',
      "textarea[placeholder]",
      "xpath=//input",
      "//input[@type='password']",
      'internal:attr=[name="password"]',
      "text=hunter2",
      "css=h1",
      "h1 >> input",
      "[v\\61lue^=a]",
      "[val/**/ue^=a]",
    ])
      expect(
        await call(plane, alice, "browser_wait_for", { sessionId: id, selector, timeout: 10 }),
        selector,
      ).toMatchObject({
        isError: true,
        content: [{ text: expect.stringMatching(/^Invalid arguments: /) }],
      });

    expect(
      await call(plane, alice, "browser_wait_for", { sessionId: id, selector: "h1", timeout: 10 }),
    ).not.toHaveProperty("isError");
  });

  it("select options, hover, press keys and wait for text or a selector", async () => {
    const plane = await org();
    const id = await open(plane, alice, { url: "https://example.com/code" });

    await call(plane, alice, "browser_select_option", { sessionId: id, ref: "e2", values: ["de"] });

    expect(textOf(await call(plane, alice, "browser_snapshot", { sessionId: id }))).toContain(
      '- option "de" [selected]',
    );
    expect(
      await call(plane, alice, "browser_hover", { sessionId: id, ref: "e1" }),
    ).not.toHaveProperty("isError");
    expect(
      await call(plane, alice, "browser_press_key", { sessionId: id, key: "Enter" }),
    ).not.toHaveProperty("isError");
    expect(
      await call(plane, alice, "browser_wait_for", { sessionId: id, text: "One-time code" }),
    ).not.toHaveProperty("isError");
    expect(
      await call(plane, alice, "browser_wait_for", { sessionId: id, selector: '[name="otp"]' }),
    ).not.toHaveProperty("isError");
    expect(
      await call(plane, alice, "browser_wait_for", { sessionId: id, text: "Nowhere", timeout: 10 }),
    ).toEqual({ content: [{ type: "text", text: "Timeout 10ms exceeded" }], isError: true });
    expect(
      await call(plane, alice, "browser_wait_for", { sessionId: id, text: "a", selector: "b" }),
    ).toMatchObject({
      isError: true,
      content: [{ text: expect.stringMatching(/^Invalid arguments: /) }],
    });
    expect(await call(plane, alice, "browser_click", { sessionId: id, ref: "e99" })).toEqual({
      content: [{ type: "text", text: "Ref e99 not found in the current page" }],
      isError: true,
    });
  });

  it("open, list and switch tabs", async () => {
    const plane = await org();
    const id = await open(plane, alice, { url: "https://example.com/one" });

    expect(
      textOf(
        await call(plane, alice, "browser_tab_new", {
          sessionId: id,
          url: "https://example.com/two",
        }),
      ),
    ).toBe("- Page URL: https://example.com/two\n- Page Title: Page at https://example.com/two");

    expect(textOf(await call(plane, alice, "browser_tab_list", { sessionId: id }))).toBe(
      [
        "- 0: Page at https://example.com/one (https://example.com/one)",
        "- 1: Page at https://example.com/two (https://example.com/two) [current]",
      ].join("\n"),
    );

    await call(plane, alice, "browser_tab_select", { sessionId: id, index: 0 });

    expect(textOf(await call(plane, alice, "browser_snapshot", { sessionId: id }))).toContain(
      "- Page URL: https://example.com/one\n",
    );
    expect(
      await call(plane, alice, "browser_tab_select", { sessionId: id, index: 5 }),
    ).toMatchObject({ isError: true });
  });

  it("answer another member, another API key of the same member and another org as an id that does not exist", async () => {
    const plane = await org();
    const id = await open(plane);
    const never = `bs_${"0".repeat(32)}`;

    expect(await call(plane, alice, "browser_snapshot", { sessionId: never })).toEqual(
      unknown(never),
    );
    expect(await call(plane, alice, "browser_snapshot", { sessionId: "not-a-session" })).toEqual(
      unknown("not-a-session"),
    );
    expect(
      await call(plane, { viewer: BOB, principal: ALICES_KEY }, "browser_snapshot", {
        sessionId: id,
      }),
    ).toEqual(unknown(id));
    expect(
      await call(plane, { viewer: ALICE, principal: "key:k-alice-other" }, "browser_close", {
        sessionId: id,
      }),
    ).toEqual(unknown(id));
    expect(
      await call(
        plane,
        { viewer: ALICE, principal: "user:alice@example.com" },
        "browser_snapshot",
        {
          sessionId: id,
        },
      ),
    ).toEqual(unknown(id));

    const other = await org();

    expect(await call(other, alice, "browser_snapshot", { sessionId: id })).toEqual(unknown(id));

    // The owner's session is untouched by them all.
    expect(await call(plane, alice, "browser_snapshot", { sessionId: id })).not.toHaveProperty(
      "isError",
    );
  });

  it("close after ten idle minutes, which later calls answer, and are forgotten a day later", async () => {
    const plane = await org();
    const id = await open(plane);
    const clock = await sessionClock(plane, id);
    const browser = fakeBrowsers.opened.at(-1) ?? "";

    await clock.adjust(IDLE_TIMEOUT_MS - 1_000);
    expect(await runAlarm(plane, id)).toBe(true);
    expect(fakeBrowsers.isOpen(browser)).toBe(true);

    // A call keeps it open for another ten minutes from then.
    await call(plane, alice, "browser_tab_list", { sessionId: id });
    await clock.adjust(IDLE_TIMEOUT_MS - 1_000);
    expect(await runAlarm(plane, id)).toBe(true);
    expect(fakeBrowsers.isOpen(browser)).toBe(true);

    await clock.adjust(1_000);
    expect(await runAlarm(plane, id)).toBe(true);
    expect(fakeBrowsers.isOpen(browser)).toBe(false);

    expect(await call(plane, alice, "browser_snapshot", { sessionId: id })).toEqual({
      content: [
        {
          type: "text",
          text: `Browser session ${id} is closed (it was idle for 10 minutes). Open a new one with browser_open.`,
        },
      ],
      isError: true,
    });

    await clock.adjust(CLOSED_KEPT_MS);
    expect(await runAlarm(plane, id)).toBe(true);
    expect(textOf(await call(plane, alice, "browser_snapshot", { sessionId: id }))).toBe(
      `Unknown browser session ${id}. Open one with browser_open.`,
    );
  });

  it("answer as closed once the provider ended the browser, not with the provider's failure", async () => {
    const plane = await org();
    const id = await open(plane);

    fakeBrowsers.end(fakeBrowsers.opened.at(-1) ?? "");

    const closed = {
      content: [
        {
          type: "text",
          text: `Browser session ${id} is closed (the browser provider ended its browser). Open a new one with browser_open.`,
        },
      ],
      isError: true,
    };

    expect(await call(plane, alice, "browser_snapshot", { sessionId: id })).toEqual(closed);
    expect(
      await call(plane, alice, "browser_navigate", { sessionId: id, url: "https://a.example/" }),
    ).toEqual(closed);
  });

  it("refuse a call without a principal, which could own no session", async () => {
    const plane = await org();
    const id = await open(plane);
    const anonymous = { viewer: ALICE, principal: undefined };

    const refused = {
      content: [
        {
          type: "text",
          text: "Browser sessions need a caller with an identity: an API key or a signed-in person.",
        },
      ],
      isError: true,
    };

    expect(await call(plane, anonymous, "browser_open")).toEqual(refused);
    expect(await call(plane, anonymous, "browser_snapshot", { sessionId: id })).toEqual(refused);
  });

  it("reach the browser again when the connection dropped or the object restarted, in the same tab", async () => {
    const plane = await org();
    const id = await open(plane, alice, { url: "https://example.com/one" });
    const browser = fakeBrowsers.opened.at(-1) ?? "";

    await call(plane, alice, "browser_tab_new", { sessionId: id, url: "https://example.com/two" });

    const tabs = [
      "- 0: Page at https://example.com/one (https://example.com/one)",
      "- 1: Page at https://example.com/two (https://example.com/two) [current]",
    ].join("\n");

    fakeBrowsers.drop(browser);
    expect(textOf(await call(plane, alice, "browser_tab_list", { sessionId: id }))).toBe(tabs);

    await evictDurableObject(browserSessionStub(env.BROWSER_SESSIONS, plane.name, id));
    fakeBrowsers.drop(browser);
    expect(textOf(await call(plane, alice, "browser_snapshot", { sessionId: id }))).toContain(
      "- Page URL: https://example.com/two\n",
    );
    expect(textOf(await call(plane, alice, "browser_tab_list", { sessionId: id }))).toBe(tabs);
    expect(fakeBrowsers.isOpen(browser)).toBe(true);
  });

  it("keep the provider the session opened on, from the browser toolkit's source", async () => {
    for (const [namespace, source] of [
      [env.BROWSER_CONTROL_PLANE, "browser-run"],
      [env.OTHER_BROWSER_CONTROL_PLANE, "other-browser"],
    ] as const) {
      const plane = await org(namespace);
      const id = await open(plane);

      const stored = await runInDurableObject(
        browserSessionStub(env.BROWSER_SESSIONS, plane.name, id),
        (_instance, state) => state.storage.kv.get<{ readonly source: string }>("session"),
      );

      expect(stored?.source).toBe(source);
    }
  });

  it("answer the provider's refusal at its account's limit as a tool error", async () => {
    const plane = await org();

    fakeBrowsers.refuseNew = true;

    expect(await call(plane, alice, "browser_open")).toEqual({
      content: [{ type: "text", text: "The fake browser is at its account's limit." }],
      isError: true,
    });
  });

  it("answer the provider's failures in a call as tool errors and stay open", async () => {
    const plane = await org();
    const id = await open(plane);

    expect(
      await call(plane, alice, "browser_navigate", {
        sessionId: id,
        url: "https://unreachable.invalid/",
      }),
    ).toEqual({
      content: [
        { type: "text", text: "net::ERR_NAME_NOT_RESOLVED at https://unreachable.invalid/" },
      ],
      isError: true,
    });
    expect(await call(plane, alice, "browser_tab_list", { sessionId: id })).not.toHaveProperty(
      "isError",
    );
  });
});
