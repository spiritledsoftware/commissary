// What Commissary Cloud's plans count of Tools, and limit (#241, ADR 0042), over the real Billing part in the same
// ControlPlane object (`PLANS_ON`, test/worker.ts): each tool call counts once with requests, whatever its toolkit and
// outcome, and a call refused before any work does not; browser time and computer time count toward browser and
// computer hours, from calls and from sessions' alarms; a Free org out of browser hours still makes tool calls; the
// Free plan has no computer, so a command that would run on one is refused while just-bash's run; and the ceilings on
// concurrent browser sessions and computers refuse opening one more, but for agent runs'. The part and the sessions'
// objects read one TestClock.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Effect, type Schema } from "effect";
import { TestClock } from "effect/testing";
import { browserSessionStub } from "../src/browser/session-object.ts";
import { IDLE_TIMEOUT_MS } from "../src/browser/session-tools.ts";
import { COMPUTER_IDLE_MS } from "../src/sandbox/cloudflare/computer.ts";
import { BillingEnv } from "@commissary/billing/api";
import { CurrentOrg, type OrgId } from "@commissary/core";
import { ToolsEnv } from "../src/env.ts";
import { planLimitMeta } from "../src/mcp/endpoint.ts";
import { settleRunToolCall } from "../src/mcp/run-calls.ts";
import { COMPUTER_STOPPED_BY_PLAN_NOTE } from "../src/sandbox/toolkit.ts";
import { fakeHttpServer } from "./support/http-server.ts";
import { fakeMcpServer, serveFakeMcpServers } from "./support/mcp-server.ts";
import { testClockStart } from "./support/clock.ts";
import { migrateUsageDb } from "./support/usage-db.ts";
import { PLANS_ON } from "./worker.ts";
import type {
  BrowserSession as TestBrowserSession,
  SandboxSession as TestSandboxSession,
} from "./worker.ts";

serveFakeMcpServers();

beforeAll(async () => {
  await migrateUsageDb();
});

const POLICY = { ownHosts: [], localDevelopment: false };

const OWNER = { role: "owner" as const, sensitive: false };

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

/** A command just-bash lacks (`git`), which the session runs on the computer. */
const ON_COMPUTER = "git status";

const sessionClass = async (): Promise<typeof TestBrowserSession> =>
  await runInDurableObject(
    env.BROWSER_SESSIONS.getByName(`test:${crypto.randomUUID()}`),
    // SAFETY: the test Worker binds `BROWSER_SESSIONS` to its own `BrowserSession` (test/worker.ts).
    (instance) => instance.constructor as typeof TestBrowserSession,
  );

const computerSessionClass = async (): Promise<typeof TestSandboxSession> =>
  await runInDurableObject(
    env.SANDBOX_SESSION.getByName(`test:${crypto.randomUUID()}`),
    // SAFETY: the test Worker binds `SANDBOX_SESSION` to its own `SandboxSession` (test/worker.ts).
    (instance) => instance.constructor as typeof TestSandboxSession,
  );

afterEach(async () => {
  (await sessionClass()).clock = undefined;
  (await computerSessionClass()).clock = undefined;
});

type Plane = typeof env.BROWSER_CONTROL_PLANE | typeof env.COMPUTER_SANDBOX_CONTROL_PLANE;

/**
 * An org of `namespace` with plans on, whose `toolkit` everyone may use, with an admin and alice, who calls with an API
 * key of hers; on `plan`. Its part and the sessions' objects read one `TestClock`.
 */
const planOrg = async (
  namespace: Plane,
  toolkit: "browser" | "sandbox",
  plan: "free" | "payg" = "free",
) => {
  const name = crypto.randomUUID();
  const stub = namespace.getByName(name);

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

  await Effect.runPromise(clock.setTime(testClockStart()));
  await runInDurableObject(stub, (instance, state) => {
    instance.tools().useClock(clock);
    state.storage.kv.put(PLANS_ON, true);
  });
  (await sessionClass()).clock = clock;
  (await computerSessionClass()).clock = clock;

  const written = await stub.tools().writeGrant(
    {
      revision: 0,
      value: { subject: { kind: "everyone" }, toolkit, tools: { kind: "all" } },
    },
    "test",
  );

  if (!written.ok) throw new Error(written.message);

  if (toolkit === "sandbox") {
    const toolkits = (await stub.tools().listToolkits(admin)).toolkits;
    const revision = toolkits.find((entry) => entry.id === "sandbox")?.revision ?? 1;

    const allowed = await stub
      .tools()
      .updateToolkit(admin, "sandbox", revision, { computer: true }, "t", POLICY);

    if (!allowed.ok) throw new Error(allowed.message);
  }

  const billing = () => stub.billing();

  if (plan === "payg") await billing().setPlan("payg");

  const plane = {
    stub,
    name,
    admin,
    alice,
    principal: `key:${keyId}`,
    advance: (millis: number) => Effect.runPromise(clock.adjust(millis)),
    now: () => Effect.runPromise(clock.currentTimeMillis),
    /** What the org used this month, per unit. */
    used: async () =>
      (await billing().usage(await Effect.runPromise(clock.currentTimeMillis))).used,
    /** Sets what the org used of `unit` this month, as a month of use would have. */
    seed: async (unit: "requests" | "browserHours" | "computerHours", amount: number) => {
      const now = await Effect.runPromise(clock.currentTimeMillis);
      const start = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);

      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO billing_usage (month_start, unit, amount) VALUES (?, ?, ?)
           ON CONFLICT (month_start, unit) DO UPDATE SET amount = excluded.amount`,
          start,
          unit,
          amount,
        );
      });
    },
    /** Sets the price per browser hour of the browser toolkit. */
    price: async (price: number) => {
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
    /** A daily Spend limit of `amountMicros` on the org. */
    limit: async (amountMicros: number) => {
      const made = await stub.createSpendLimit(
        admin,
        { kind: "org", subject: "", period: "day", amountMicros },
        "t",
      );

      if (!made.ok) throw new Error(made.message);
    },
    /** A call by alice through her API key, which understands the plan's outcome. */
    call: (tool: string, args: Schema.JsonObject = {}) =>
      stub.tools().callTool(
        alice,
        {
          name: tool,
          arguments: args,
          principalId: `key:${keyId}`,
          apiKeyId: keyId,
          planOutcomes: true,
        },
        POLICY,
      ),
  };

  return plane;
};

type Org = Awaited<ReturnType<typeof planOrg>>;

const browserOrg = (plan: "free" | "payg" = "free") =>
  planOrg(env.BROWSER_CONTROL_PLANE, "browser", plan);

const computerOrg = (plan: "free" | "payg" = "free") =>
  planOrg(env.COMPUTER_SANDBOX_CONTROL_PLANE, "sandbox", plan);

const PAGE = { url: "https://example.com/" };

const textOf = (result: Schema.JsonObject): string =>
  // SAFETY: the tools answer text contents.
  (result["content"] as ReadonlyArray<{ readonly text?: string }>)
    .map((content) => content.text ?? "")
    .join("\n");

/** Opens a browser session as alice, answering the whole outcome. */
const openBrowser = (org: Org) => org.call("browser_open");

const sessionIdOf = (outcome: Awaited<ReturnType<Org["call"]>>): string => {
  if (outcome.outcome !== "result") throw new Error(`the call came to ${outcome.outcome}`);

  const id = /Browser session (bs_[0-9a-f]{32}) is open/.exec(textOf(outcome.result))?.[1];

  if (id === undefined) throw new Error(`no session opened: ${textOf(outcome.result)}`);

  return id;
};

describe("tool calls", () => {
  it("count once with requests, whatever the tool, and the browser time they used counts as browser hours", async () => {
    const org = await browserOrg();

    expect(await org.call("browser_markdown", PAGE)).toMatchObject({ outcome: "result" });
    expect(
      await org.call("browser_markdown", { url: "https://unreachable.invalid/" }),
    ).toMatchObject({ outcome: "result", result: { isError: true } });

    const used = await org.used();

    // A failed call counts too, and each Quick Action's 1.5 seconds of browser time.
    expect(used.requests).toBe(2);
    expect(used.browserHours).toBeCloseTo(3_000 / HOUR, 9);
  });

  it("do not count when the tool is unknown, or before any work (a refused call is taken back)", async () => {
    const org = await browserOrg();

    expect(await org.call("browser_nothing")).toMatchObject({ outcome: "unknown" });
    expect((await org.used()).requests).toBe(0);
  });

  it("are refused when a Free org used up its 25,000 requests and tool calls, and then count nothing", async () => {
    const org = await browserOrg();

    // 20,000 requests and 4,999 tool calls: one more tool call uses up the free usage.
    await org.seed("requests", 25_000 - 1);

    expect(await org.call("browser_profile_list")).toMatchObject({ outcome: "result" });
    expect((await org.used()).requests).toBe(25_000);

    const refused = await org.call("browser_profile_list");

    expect(refused).toMatchObject({
      outcome: "plan_limited",
      refusal: { limit: "requests", allowed: 25_000, pastDue: false },
    });
    expect((await org.used()).requests).toBe(25_000);

    // A caller that does not know the outcome gets a failed call, as before.
    expect(
      await org.stub
        .tools()
        .callTool(org.alice, { name: "browser_profile_list", principalId: org.principal }, POLICY),
    ).toMatchObject({ outcome: "failed" });
  });

  it("are served past 25,000 on Pay as you go, which bills them", async () => {
    const org = await browserOrg("payg");

    await org.seed("requests", 25_000);

    expect(await org.call("browser_profile_list")).toMatchObject({ outcome: "result" });
    expect((await org.used()).requests).toBe(25_001);
  });

  it("are refused on Pay as you go once the billing cap is reached", async () => {
    const org = await browserOrg("payg");

    await org.stub.billing().setBillingCap(0);
    await org.seed("requests", 25_000);

    expect(await org.call("browser_profile_list")).toMatchObject({
      outcome: "plan_limited",
      refusal: { limit: "billing_cap", allowed: 0 },
    });
  });

  it("count nothing where the deployment has no plans, as on a self-hosted Commissary", async () => {
    const org = await browserOrg();

    await runInDurableObject(org.stub, (_instance, state) => state.storage.kv.delete(PLANS_ON));

    expect(await org.call("browser_markdown", PAGE)).toMatchObject({ outcome: "result" });
    expect((await org.used()).requests).toBe(0);
  });
});

describe("browser hours", () => {
  it("refuse a Free org's browser use past 1 hour, while its other tool calls go on", async () => {
    const org = await browserOrg();

    await org.seed("browserHours", 1);

    expect(await org.call("browser_markdown", PAGE)).toMatchObject({
      outcome: "plan_limited",
      refusal: { limit: "browser_hours", allowed: 1 },
    });
    expect(await openBrowser(org)).toMatchObject({
      outcome: "plan_limited",
      refusal: { limit: "browser_hours" },
    });
    // A tool that reaches no browser is a tool call like any other.
    expect(await org.call("browser_profile_list")).toMatchObject({ outcome: "result" });
    expect(await org.used()).toMatchObject({ requests: 1, browserHours: 1 });
  });

  it("count a session's time from its calls and from its close", async () => {
    const org = await browserOrg();
    const id = sessionIdOf(await openBrowser(org));

    await org.advance(30 * MINUTE);
    expect(await org.call("browser_snapshot", { sessionId: id })).toMatchObject({
      outcome: "result",
    });
    await org.advance(15 * MINUTE);
    expect(await org.call("browser_close", { sessionId: id })).toMatchObject({
      outcome: "result",
    });

    expect((await org.used()).browserHours).toBeCloseTo(0.75, 6);
  });

  it("count the stretch after a session's last call when its alarm closes it", async () => {
    const org = await browserOrg();
    const id = sessionIdOf(await openBrowser(org));

    await org.advance(IDLE_TIMEOUT_MS + MINUTE);
    await runDurableObjectAlarm(browserSessionStub(env.BROWSER_SESSIONS, org.name, id));

    expect((await org.used()).browserHours).toBeCloseTo((IDLE_TIMEOUT_MS + MINUTE) / HOUR, 6);
  });

  it("count the stretch after a session's last call when its member ends it from the panel", async () => {
    const org = await browserOrg();
    const id = sessionIdOf(await openBrowser(org));

    await org.advance(MINUTE);
    expect(await org.stub.tools().endBrowserSession(org.alice, id)).toMatchObject({ ok: true });

    expect((await org.used()).browserHours).toBeCloseTo(MINUTE / HOUR, 6);
  });

  it("close the session a call over the limit names", async () => {
    const org = await browserOrg();
    const id = sessionIdOf(await openBrowser(org));

    await org.seed("browserHours", 1);

    expect(await org.call("browser_snapshot", { sessionId: id })).toMatchObject({
      outcome: "plan_limited",
      sessionClosed: true,
    });
  });
});

describe("the ceiling on concurrent browser sessions", () => {
  it("refuses a Free org's second session, and lets it open one again once it closes the first", async () => {
    const org = await browserOrg();
    const first = sessionIdOf(await openBrowser(org));

    expect(await openBrowser(org)).toMatchObject({
      outcome: "plan_limited",
      refusal: { limit: "browserSessions", allowed: 1, pastDue: false },
    });
    // The refusal made no tool call.
    expect((await org.used()).requests).toBe(1);

    await org.call("browser_close", { sessionId: first });
    expect(await openBrowser(org)).toMatchObject({ outcome: "result" });
  });

  it("refuses a Pay-as-you-go org's sixth", async () => {
    const org = await browserOrg("payg");

    for (let opened = 0; opened < 5; opened += 1)
      expect(await openBrowser(org)).toMatchObject({ outcome: "result" });

    expect(await openBrowser(org)).toMatchObject({
      outcome: "plan_limited",
      refusal: { limit: "browserSessions", allowed: 5 },
    });
  });

  it("applies the ceiling a platform admin raised", async () => {
    const org = await browserOrg();

    await org.stub.billing().raiseCeilings({ browserSessions: 2 });

    expect(await openBrowser(org)).toMatchObject({ outcome: "result" });
    expect(await openBrowser(org)).toMatchObject({ outcome: "result" });
    expect(await openBrowser(org)).toMatchObject({ outcome: "plan_limited" });
  });

  it("does not cap an agent run's sessions, nor count them toward its members'", async () => {
    const org = await browserOrg();

    const reach = {
      toolScope: [{ toolkit: "browser", tools: { kind: "all" as const } }],
      asAgent: true,
      usage: { agentId: "ag_shared", runId: "ar_1", starter: "member:m_starter" },
    };

    const runOpens = () =>
      org.stub
        .tools()
        .callTool(
          { admin: false },
          { name: "browser_open", principalId: "run:ar_1", run: reach, planOutcomes: true },
          POLICY,
        );

    for (let opened = 0; opened < 3; opened += 1)
      expect(await runOpens()).toMatchObject({ outcome: "result" });

    // Alice's own first session is within Free's ceiling of one.
    expect(await openBrowser(org)).toMatchObject({ outcome: "result" });
    expect(await openBrowser(org)).toMatchObject({ outcome: "plan_limited" });
  });
});

describe("the computer", () => {
  const open = async (org: Org) => {
    const opened = await org.call("sandbox_open", { computer: true });

    if (opened.outcome !== "result") throw new Error(`the call came to ${opened.outcome}`);

    // SAFETY: `sandbox_open` answers the session in its structured content.
    return (opened.result["structuredContent"] as { session: string }).session;
  };

  const bash = (org: Org, session: string, command: string) =>
    org.call("sandbox_bash", { session, command });

  it("is unavailable on Free: a command that needs it is refused, and just-bash keeps working", async () => {
    const org = await computerOrg();
    const session = await open(org);

    expect(await bash(org, session, ON_COMPUTER)).toMatchObject({
      outcome: "plan_limited",
      refusal: { limit: "computer_hours", allowed: 0 },
    });
    expect(await bash(org, session, "echo hello")).toMatchObject({
      outcome: "result",
      result: { structuredContent: { exit_code: 0, stdout: "hello\n" } },
    });

    // `sandbox_open` and `sandbox_bash` counted; the refused command was taken back.
    expect((await org.used()).requests).toBe(2);
    expect((await org.used()).computerHours).toBe(0);
  });

  it("counts a Pay-as-you-go org's computer time, from the command that starts it to its idle minutes' end", async () => {
    const org = await computerOrg("payg");
    const session = await open(org);

    expect(await bash(org, session, ON_COMPUTER)).toMatchObject({ outcome: "result" });
    await org.advance(5 * MINUTE);
    expect(await org.call("sandbox_list", { session, path: "." })).toMatchObject({
      outcome: "result",
    });

    expect((await org.used()).computerHours).toBeGreaterThan(0);
    expect((await org.used()).computerHours).toBeCloseTo(5 / 60, 4);
  });

  it("counts the computer's last stretch when its member ends the session from the panel", async () => {
    const org = await computerOrg("payg");
    const session = await open(org);

    expect(await bash(org, session, ON_COMPUTER)).toMatchObject({ outcome: "result" });
    await org.advance(MINUTE);
    expect(await org.stub.tools().endSandboxSession(org.alice, session)).toMatchObject({
      ok: true,
    });

    expect((await org.used()).computerHours).toBeCloseTo(MINUTE / HOUR, 6);
  });

  it("counts the computer's idle minutes when its alarm meters them with no call to answer, though they cost nothing", async () => {
    const org = await computerOrg("payg");
    const session = await open(org);

    expect(await bash(org, session, ON_COMPUTER)).toMatchObject({ outcome: "result" });
    await org.advance(COMPUTER_IDLE_MS + MINUTE);
    await runDurableObjectAlarm(env.SANDBOX_SESSION.getByName(`${org.name}:${session}`));

    expect((await org.used()).computerHours).toBeCloseTo(COMPUTER_IDLE_MS / HOUR, 6);
  });

  it("refuses a Pay-as-you-go org's fourth computer, and frees one when its idle minutes end", async () => {
    const org = await computerOrg("payg");
    const sessions: string[] = [];

    for (let started = 0; started < 3; started += 1) {
      const session = await open(org);

      sessions.push(session);
      expect(await bash(org, session, ON_COMPUTER)).toMatchObject({ outcome: "result" });
    }

    const fourth = await open(org);

    expect(await bash(org, fourth, ON_COMPUTER)).toMatchObject({
      outcome: "plan_limited",
      refusal: { limit: "computers", allowed: 3 },
    });
    // Another command of a session whose computer runs is not another computer.
    expect(await bash(org, sessions[0] ?? "", ON_COMPUTER)).toMatchObject({ outcome: "result" });
    // just-bash is not a computer.
    expect(await bash(org, fourth, "echo hello")).toMatchObject({ outcome: "result" });

    await org.advance(COMPUTER_IDLE_MS + MINUTE);

    // A call of each session answers where its computer stands: stopped by its idle minutes.
    for (const session of sessions) {
      await org.call("sandbox_list", { session, path: "." });
    }

    expect(await bash(org, fourth, ON_COMPUTER)).toMatchObject({ outcome: "result" });
  });
});

describe("calls the plan does not count", () => {
  const MCP_TOOLS = [{ name: "create_issue" }, { name: "list_issues" }];

  /** An org of the plain ControlPlane (plans on) with a toolkit `github` whose write tools wait for approval. */
  const approvalOrg = async (approver: "caller" | "bob") => {
    const stub = env.CONTROL_PLANE.getByName(crypto.randomUUID());

    const member = async (email: string, role: string) => {
      const added = await stub.addMember({ email, role }, OWNER, "test");

      if (!added.ok) throw new Error(added.message);

      return { member: added.value.id, admin: role !== "member" };
    };

    const admin = await member("admin@example.com", "admin");
    const alice = await member("alice@example.com", "member");
    const bob = await member("bob@example.com", "member");

    await runInDurableObject(stub, (_instance, state) => state.storage.kv.put(PLANS_ON, true));

    const upstream = fakeMcpServer(
      `https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`,
      {
        tools: MCP_TOOLS,
        call: (name) => ({ content: [{ type: "text", text: `called ${name}` }] }),
      },
    );

    const added = await stub.tools().addToolkit(
      admin,
      {
        source: upstream.url,
        name: "github",
        private: false,
        accepts: "shared",
        credential: { kind: "bearer", token: "shared", subject: { kind: "everyone" } },
      },
      "test",
      POLICY,
    );

    if (!added.ok) throw new Error(added.message);

    const updated = await stub.tools().updateToolkit(
      admin,
      added.value.id,
      added.value.revision,
      {
        approval_rules: {
          writes: approver === "caller" ? {} : { approver: { kind: "members", ids: [bob.member] } },
        },
      },
      "test",
      POLICY,
    );

    if (!updated.ok) throw new Error(updated.message);

    return {
      stub,
      alice,
      bob,
      upstream,
      used: async () => (await stub.billing().usage(Date.now())).used,
      seed: async (requests: number) => {
        const start = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);

        await runInDurableObject(stub, (_instance, state) => {
          state.storage.sql.exec(
            `INSERT INTO billing_usage (month_start, unit, amount) VALUES (?, 'requests', ?)
             ON CONFLICT (month_start, unit) DO UPDATE SET amount = excluded.amount`,
            start,
            requests,
          );
        });
      },
      call: (
        name: string,
        extra: Partial<Parameters<ReturnType<typeof stub.tools>["callTool"]>[1]> = {},
      ) =>
        stub.tools().callTool(
          alice,
          {
            name,
            arguments: { title: "x" },
            principalId: `user:${alice.member}`,
            approvalOutcomes: true,
            planOutcomes: true,
            ...extra,
          },
          POLICY,
        ),
      approvals: async () =>
        await runInDurableObject(
          stub,
          (_instance, state) =>
            state.storage.sql.exec(`SELECT id FROM tool_approvals`).toArray().length,
        ),
    };
  };

  it("an approval-gated call of an org out of free usage is refused before an approval is made", async () => {
    const org = await approvalOrg("bob");

    await org.seed(25_000);

    expect(await org.call("github_create_issue")).toMatchObject({
      outcome: "plan_limited",
      refusal: { limit: "requests" },
    });
    expect(await org.approvals()).toBe(0);
    expect((await org.used()).requests).toBe(25_000);
  });

  it("a call that waits for approval, is denied or is asked on a form counts nothing, and the approved retry counts once", async () => {
    const org = await approvalOrg("bob");
    const pending = await org.call("github_create_issue");

    if (pending.outcome !== "pending") throw new Error(`the call came to ${pending.outcome}`);
    expect((await org.used()).requests).toBe(0);

    // Denied: nothing counted, not by the repeated call that learns of it, nor by the one that waits again.
    await org.stub
      .tools()
      .decideApproval(org.bob, pending.approval.id, "deny", `user:${org.bob.member}`);
    expect((await org.used()).requests).toBe(0);
    expect(await org.call("github_create_issue")).toMatchObject({ outcome: "not_approved" });
    expect((await org.used()).requests).toBe(0);

    const again = await org.call("github_create_issue");

    if (again.outcome !== "pending") throw new Error(`the call came to ${again.outcome}`);
    await org.stub
      .tools()
      .decideApproval(org.bob, again.approval.id, "approve", `user:${org.bob.member}`);
    expect((await org.used()).requests).toBe(0);

    // The approved retry goes through and counts once; the approval is used up.
    expect(await org.call("github_create_issue")).toMatchObject({ outcome: "result" });
    expect((await org.used()).requests).toBe(1);
    expect(await org.call("github_create_issue")).toMatchObject({ outcome: "pending" });
    expect((await org.used()).requests).toBe(1);

    // On a form: asked and declined count nothing; accepted counts once.
    const form = await approvalOrg("caller");
    const asked = await form.call("github_create_issue", { approvalForm: {} });

    if (asked.outcome !== "approve") throw new Error(`the call came to ${asked.outcome}`);
    expect((await form.used()).requests).toBe(0);

    expect(
      await form.call("github_create_issue", {
        approvalForm: { answer: "decline", requestState: asked.requestState },
      }),
    ).toMatchObject({ outcome: "not_approved" });
    expect((await form.used()).requests).toBe(0);

    const again2 = await form.call("github_create_issue", { approvalForm: {} });

    if (again2.outcome !== "approve") throw new Error(`the call came to ${again2.outcome}`);

    expect(
      await form.call("github_create_issue", {
        approvalForm: { answer: "accept", requestState: again2.requestState },
      }),
    ).toMatchObject({ outcome: "result" });
    expect((await form.used()).requests).toBe(1);
  });

  it("a call a Spend limit refuses counts nothing", async () => {
    const org = await browserOrg();

    await org.price(3_600_000_000);
    await org.limit(0);

    expect(await org.call("browser_markdown", PAGE)).toMatchObject({ outcome: "refused" });
    expect((await org.used()).requests).toBe(0);
  });

  it("a call whose credential could not sign in is taken back", async () => {
    const stub = env.CONTROL_PLANE.getByName(crypto.randomUUID());
    const admin = { member: "m-admin", admin: true };

    await runInDurableObject(stub, (_instance, state) => state.storage.kv.put(PLANS_ON, true));

    const auth = fakeHttpServer(`https://auth-${crypto.randomUUID().slice(0, 8)}.example.com`, () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );

    const api = `https://api-${crypto.randomUUID().slice(0, 8)}.example.com`;

    const added = await stub.tools().addToolkit(
      admin,
      {
        kind: "openapi",
        source: "",
        document: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Ops", version: "1" },
          servers: [{ url: api }],
          paths: { "/ping": { get: { operationId: "ping" } } },
        }),
        name: "ops",
        private: false,
        accepts: "shared",
        credential: {
          kind: "token_exchange",
          subject_token: "expired",
          subject: { kind: "everyone" },
        },
        credentialSettings: { token_exchange: { token_url: `${auth.origin}/token` } },
      },
      "test",
      POLICY,
    );

    if (!added.ok) throw new Error(added.message);

    expect(
      await stub
        .tools()
        .callTool(
          { member: "m-alice", admin: false },
          { name: "ops_ping", planOutcomes: true },
          POLICY,
        ),
    ).toMatchObject({ outcome: "connect", reason: "sign_in" });
    expect((await stub.billing().usage(Date.now())).used.requests).toBe(0);
  });

  it("an agent run's own tool calls count, and a model request is refused once tool calls used up the shared counter", async () => {
    const org = await browserOrg();

    const reach = {
      toolScope: [{ toolkit: "browser", tools: { kind: "all" as const } }],
      asAgent: true,
      usage: { agentId: "ag_shared", runId: "ar_1", starter: "member:m_starter" },
    };

    await org.seed("requests", 25_000 - 1);

    expect(
      await org.stub
        .tools()
        .callTool(
          { admin: false },
          { name: "browser_profile_list", principalId: "run:ar_1", run: reach, planOutcomes: true },
          POLICY,
        ),
    ).toMatchObject({ outcome: "result" });
    expect((await org.used()).requests).toBe(25_000);

    // The model routes count through the same part: the next request finds the free usage used up.
    expect(await org.stub.billing().admit(await org.now())).toMatchObject({
      ok: false,
      limit: { limit: "requests", allowed: 25_000 },
    });
  });
});

describe("calls that end a use", () => {
  it("are never refused by the plan: a browser close, and a sandbox close, go through uncounted", async () => {
    const browser = await browserOrg();
    const id = sessionIdOf(await openBrowser(browser));

    await browser.seed("requests", 25_000);
    await browser.seed("browserHours", 1);

    expect(await browser.call("browser_profile_list")).toMatchObject({
      outcome: "plan_limited",
      refusal: { limit: "requests" },
    });
    expect(await browser.call("browser_close", { sessionId: id })).toMatchObject({
      outcome: "result",
    });
    expect((await browser.used()).requests).toBe(25_000);
    expect(await openBrowser(browser)).toMatchObject({ outcome: "plan_limited" });

    const computer = await computerOrg();
    const opened = await computer.call("sandbox_open", { computer: false });

    if (opened.outcome !== "result") throw new Error(`the call came to ${opened.outcome}`);
    // SAFETY: `sandbox_open` answers the session in its structured content.
    const session = (opened.result["structuredContent"] as { session: string }).session;

    await computer.seed("requests", 25_000);
    expect(await computer.call("sandbox_list", { session, path: "." })).toMatchObject({
      outcome: "plan_limited",
    });
    expect(await computer.call("sandbox_close", { session })).toMatchObject({
      outcome: "result",
    });
    expect((await computer.used()).requests).toBe(25_000);
  });
});

describe("calls made at once", () => {
  it("do not both open the last browser session the ceiling leaves", async () => {
    const org = await browserOrg();
    const outcomes = await Promise.all([openBrowser(org), openBrowser(org)]);

    expect(outcomes.filter((outcome) => outcome.outcome === "result")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.outcome === "plan_limited")).toHaveLength(1);
    expect((await org.used()).requests).toBe(1);
  });

  it("do not start more computers than the ceiling allows", async () => {
    const org = await computerOrg("payg");
    const sessions: string[] = [];

    for (let opened = 0; opened < 4; opened += 1) {
      const result = await org.call("sandbox_open", { computer: true });

      if (result.outcome !== "result") throw new Error(`the call came to ${result.outcome}`);
      // SAFETY: `sandbox_open` answers the session in its structured content.
      sessions.push((result.result["structuredContent"] as { session: string }).session);
    }

    const outcomes = await Promise.all(
      sessions.map((session) => org.call("sandbox_bash", { session, command: ON_COMPUTER })),
    );

    expect(outcomes.filter((outcome) => outcome.outcome === "result")).toHaveLength(3);
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        outcome: "plan_limited",
        refusal: expect.objectContaining({ limit: "computers" }),
      }),
    );
  });
});

describe("a computer the plan stops", () => {
  it("is told so in the plan's words, not a Spend limit's", async () => {
    const org = await computerOrg("payg");

    const opened = await org.call("sandbox_open", { computer: true });

    if (opened.outcome !== "result") throw new Error(`the call came to ${opened.outcome}`);
    // SAFETY: `sandbox_open` answers the session in its structured content.
    const session = (opened.result["structuredContent"] as { session: string }).session;

    expect(await org.call("sandbox_bash", { session, command: ON_COMPUTER })).toMatchObject({
      outcome: "result",
    });

    // The billing cap leaves no room for another minute of computer time, though free requests remain.
    await org.stub.billing().setBillingCap(0);

    const listed = await org.call("sandbox_list", { session, path: "." });

    expect(listed.outcome === "result" && JSON.stringify(listed.result)).toContain(
      COMPUTER_STOPPED_BY_PLAN_NOTE,
    );
    expect(await org.call("sandbox_bash", { session, command: ON_COMPUTER })).toMatchObject({
      outcome: "plan_limited",
      refusal: { limit: "billing_cap" },
      computer: "needed",
    });
  });

  it("is stopped by a call the plan refuses outright", async () => {
    const org = await computerOrg("payg");
    const opened = await org.call("sandbox_open", { computer: true });

    if (opened.outcome !== "result") throw new Error(`the call came to ${opened.outcome}`);
    // SAFETY: `sandbox_open` answers the session in its structured content.
    const session = (opened.result["structuredContent"] as { session: string }).session;

    await org.call("sandbox_bash", { session, command: ON_COMPUTER });
    await org.stub.billing().setBillingCap(0);
    await org.seed("requests", 25_000);

    expect(await org.call("sandbox_list", { session, path: "." })).toMatchObject({
      outcome: "plan_limited",
      computer: "stopped",
    });
  });

  it("tells a Free org opening a computer that it has no computer hours", async () => {
    const org = await computerOrg();
    const opened = await org.call("sandbox_open", { computer: true });

    expect(opened.outcome === "result" && textOf(opened.result)).toContain(
      "allows no computer time",
    );
  });
});

describe("an agent run's gated sandbox calls (#230)", () => {
  const reach = {
    toolScope: [{ toolkit: "sandbox", tools: { kind: "all" as const } }],
    asAgent: true,
    starterMember: "m_starter",
    usage: { agentId: "ag_shared", runId: "ar_1", starter: "member:m_starter" },
  };

  const runCall = (org: Org, tool: string, args: Schema.JsonObject, executes = false) =>
    org.stub.tools().callTool(
      { admin: false },
      {
        name: tool,
        arguments: args,
        principalId: "run:ar_1",
        run: reach,
        planOutcomes: true,
        ...(executes ? { executes: true as const } : {}),
        ...(tool === "sandbox_open" ? { runSession: true as const } : {}),
      },
      POLICY,
    );

  const runSession = async (org: Org) => {
    const opened = await runCall(org, "sandbox_open", { computer: true });

    if (opened.outcome !== "result") throw new Error(`the call came to ${opened.outcome}`);

    // SAFETY: `sandbox_open` answers the session in its structured content.
    return (opened.result["structuredContent"] as { session: string }).session;
  };

  const gate = async (org: Org, session: string, tool: string) => {
    const gated = await runCall(org, tool, { session }, true);

    if (gated.outcome !== "gated") throw new Error(`the call came to ${gated.outcome}`);

    return gated.ticket.id;
  };

  const exec = (org: Org, ticket: string, command: string) =>
    org.stub
      .tools()
      .runSandboxOperation("ar_1", ticket, { op: "exec", command, timeoutMs: 10_000 });

  it("cannot start the computer on Free: the command is refused in the plan's words, which settling answers, and it is no tool call", async () => {
    const org = await computerOrg();
    const session = await runSession(org);
    const ticket = await gate(org, session, "sandbox_bash");

    // Opening and gating counted.
    expect((await org.used()).requests).toBe(2);

    expect(await exec(org, ticket, ON_COMPUTER)).toMatchObject({
      ok: false,
      message: expect.stringContaining("plan"),
    });
    // The refused command did no work: the gate's count is taken back, once, however many commands the live ticket
    // has refused.
    expect((await org.used()).requests).toBe(1);
    expect(await exec(org, ticket, ON_COMPUTER)).toMatchObject({ ok: false });
    expect((await org.used()).requests).toBe(1);

    expect(await org.stub.tools().settleRunSandboxCall("ar_1", ticket)).toMatchObject({
      planRefused: true,
      planRefusal: { limit: "computer_hours", allowed: 0 },
    });
    expect((await org.used()).requests).toBe(1);

    // just-bash's commands run on Free.
    const echo = await gate(org, session, "sandbox_bash");

    expect(await exec(org, echo, "echo hello")).toMatchObject({ ok: true });
  });

  it("counts a gated call once, and the computer time of its operations toward computer hours", async () => {
    const org = await computerOrg("payg");
    const session = await runSession(org);
    const ticket = await gate(org, session, "sandbox_bash");

    expect(await exec(org, ticket, ON_COMPUTER)).toMatchObject({ ok: true });
    expect(await exec(org, ticket, ON_COMPUTER)).toMatchObject({ ok: true });
    // The open and the gated call: two tool calls, however many operations the call made.
    expect((await org.used()).requests).toBe(2);

    await org.advance(5 * MINUTE);

    const read = await gate(org, session, "sandbox_read");

    expect(
      await org.stub
        .tools()
        .runSandboxOperation("ar_1", read, { op: "stat", path: "/workspace/a" }),
    ).toMatchObject({ ok: true });
    expect((await org.used()).computerHours).toBeCloseTo(5 / 60, 4);
  });
  it("ends the run's turn in the plan's words when settling the call: its record says refused", async () => {
    const org = await computerOrg();
    const session = await runSession(org);
    const ticket = await gate(org, session, "sandbox_bash");

    expect(await exec(org, ticket, ON_COMPUTER)).toMatchObject({ ok: false });

    const settled = await Effect.runPromise(
      settleRunToolCall("ar_1", ticket, { outcome: "success", responseBytes: 12 }).pipe(
        Effect.provideService(ToolsEnv, {
          ...env,
          CONTROL_PLANE: env.COMPUTER_SANDBOX_CONTROL_PLANE,
        }),
        Effect.provideService(BillingEnv, env),
        // SAFETY: the org's name is a UUID, as an org id is.
        Effect.provideService(CurrentOrg, org.name as OrgId),
      ),
    );

    expect(settled).toMatchObject({ recorded: true });
    expect(settled.refusal).toContain("plan_limit_reached");
    expect(settled.refusal).toContain("no computer hours");
    expect(settled.refusal).toContain("bash was not called");

    const record = await env.USAGE.prepare(
      `SELECT tool_outcome AS outcome FROM usage_records WHERE request_id = ?`,
    )
      .bind(ticket)
      .first<{ outcome: string }>();

    expect(record?.outcome).toBe("refused");
  });
});

describe("a refusal's wire names", () => {
  it("name a ceiling in snake_case, in the `_meta` and in the failed message of an older caller", async () => {
    const org = await browserOrg();

    await openBrowser(org);

    const refused = await openBrowser(org);

    if (refused.outcome !== "plan_limited") throw new Error(`the call came to ${refused.outcome}`);

    expect(planLimitMeta(refused.refusal)).toEqual({
      "commissary.dev/plan_limit": {
        error: "plan_limit_reached",
        limit: "browser_sessions",
        allowed: 1,
      },
    });

    const older = await org.stub
      .tools()
      .callTool(org.alice, { name: "browser_open", principalId: org.principal }, POLICY);

    expect(older).toMatchObject({ outcome: "failed" });
    expect(older.outcome === "failed" && older.message).toContain("browser_sessions");
  });
});

describe("the ceiling on computers counts computers, not the calls in flight", () => {
  const openSession = async (org: Org, computer: boolean) => {
    const opened = await org.call("sandbox_open", { computer });

    if (opened.outcome !== "result") throw new Error(`the call came to ${opened.outcome}`);

    // SAFETY: `sandbox_open` answers the session in its structured content.
    return (opened.result["structuredContent"] as { session: string }).session;
  };

  const bash = (org: Org, session: string, command: string) =>
    org.call("sandbox_bash", { session, command });

  it("lets a 3rd computer start beside a command in a session that has none", async () => {
    const org = await computerOrg("payg");
    const plain = await openSession(org, false);

    const computers = [
      await openSession(org, true),
      await openSession(org, true),
      await openSession(org, true),
    ];

    for (const session of computers.slice(0, 2))
      expect(await bash(org, session, ON_COMPUTER)).toMatchObject({ outcome: "result" });

    const outcomes = await Promise.all([
      bash(org, plain, "sleep 1; echo hi"),
      bash(org, computers[2] ?? "", ON_COMPUTER),
    ]);

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["result", "result"]);
  });

  it("keeps the slot of a command started near the end of its computer's idle minutes, past them", async () => {
    const org = await computerOrg("payg");
    const first = await openSession(org, true);
    const others = [await openSession(org, true), await openSession(org, true)];

    const later = [
      await openSession(org, true),
      await openSession(org, true),
      await openSession(org, true),
    ];

    for (const session of [first, ...others])
      expect(await bash(org, session, ON_COMPUTER)).toMatchObject({ outcome: "result" });

    // Five seconds before the idle minutes end, a command starts on the first computer and runs past them.
    await org.advance(COMPUTER_IDLE_MS - 5_000);

    const running = bash(org, first, "nap 4");

    await new Promise((resolve) => setTimeout(resolve, 300));
    await org.advance(10_000);

    // The other two stopped; the first still holds its slot: two more computers start, the third is refused.
    expect(await bash(org, later[0] ?? "", ON_COMPUTER)).toMatchObject({ outcome: "result" });
    expect(await bash(org, later[1] ?? "", ON_COMPUTER)).toMatchObject({ outcome: "result" });
    expect(await bash(org, later[2] ?? "", ON_COMPUTER)).toMatchObject({
      outcome: "plan_limited",
      refusal: { limit: "computers" },
    });
    expect(await running).toMatchObject({ outcome: "result" });
  });
});
