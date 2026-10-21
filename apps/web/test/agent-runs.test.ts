// The panel's chat and run pages (#234): what the composer does (start a chat, steer a running turn, start a new turn,
// stop), what a run waits on and where its person answers it, the transcript with its child runs, the runs list, the
// retention notice, a `plan_limit_reached` refusal's link, and the links from approvals and browser sessions to their
// runs.
import { Cause, Option } from "effect";
import { ManagementError } from "@commissary/contract/errors";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vitest";
import type { RunDetail, RunView } from "@commissary/contract/agent-runs";
import {
  answeredKeys,
  billingLinkOf,
  composerOf,
  costText,
  filterRuns,
  fromRunLink,
  lastRun,
  pollStep,
  pollsNow,
  prunedText,
  runFilters,
  runProblem,
  runRow,
  sentText,
  transcriptItems,
  waitingText,
  waitsOf,
} from "../src/lib/agent-runs.ts";
import { AGENT_RUNS_PAGE, pageAllowed } from "../src/lib/role.ts";

const NOW = Date.parse("2026-10-11T10:30:00.000Z");

const RUN = `ar_${"a".repeat(32)}`;

const view = (extra: Partial<RunDetail> = {}): RunDetail => ({
  id: RUN,
  agent: { id: "ag_1", name: "support" },
  trigger: "chat",
  starter: { kind: "member", id: "m-alice" },
  state: "idle",
  created_at: "2026-10-11T10:00:00.000Z",
  updated_at: "2026-10-11T10:20:00.000Z",
  access: "starter",
  ...extra,
});

/** A run no one started: a shared agent's trigger's. */
const unstarted = (extra: Partial<RunDetail> = {}): RunDetail => {
  const { starter: _, ...rest } = view(extra);

  return rest;
};

describe("the run pages", () => {
  it("are opened by every member", () => {
    expect(pageAllowed("member", AGENT_RUNS_PAGE)).toBe(true);
    expect(pageAllowed("member", `${AGENT_RUNS_PAGE}/${RUN}`)).toBe(true);
    expect(pageAllowed("member", "/agents/ag_1/chat")).toBe(true);
  });
});

describe("the composer", () => {
  it("steers the running turn while one runs, and stops it", () => {
    expect(composerOf(view({ state: "running" }))).toMatchObject({
      open: true,
      send: "Steer",
      stop: true,
    });
  });

  it("starts a new turn when the run is idle, with nothing to stop", () => {
    expect(composerOf(view({ state: "idle" }))).toMatchObject({
      open: true,
      send: "Send",
      stop: false,
    });
  });

  it("is open to a watcher of a run no one started", () => {
    expect(
      composerOf(unstarted({ access: "watcher", trigger: "schedule", state: "running" })),
    ).toMatchObject({ open: true, stop: true });
  });

  it("is closed on an ended run, which takes no more messages", () => {
    const composer = composerOf(view({ state: "ended" }));

    expect(composer).toMatchObject({ open: false, stop: false });
    expect(composer.open ? undefined : composer.why).toMatch(/ended/);
  });

  it("is closed to an org admin, who sees the metadata only and stops a running turn", () => {
    const composer = composerOf(view({ access: "admin", state: "running" }));

    expect(composer).toMatchObject({ open: false, stop: true });
    expect(composer.open ? undefined : composer.why).toMatch(/metadata/);
  });

  it("says what a sent message did: steering the running turn, or a new turn", () => {
    expect(sentText("steering")).toMatch(/running turn/);
    expect(sentText("turn")).toMatch(/new turn/);
  });
});

describe("an approval or a browser session of a run", () => {
  it("links its run's page, and nothing for any other caller's", () => {
    expect(fromRunLink({ run: RUN })).toEqual({ runId: RUN, text: `From run ${RUN}` });
    expect(fromRunLink({})).toBeUndefined();
  });

  it("decided on the run's page, refetches the run with the approvals", () => {
    expect(answeredKeys(["approvals"])).toEqual(["approvals", "agent-runs"]);
  });
});

describe("what a run waits on", () => {
  const approval = `ap_${"1".repeat(24)}`;
  const session = `bs_${"2".repeat(32)}`;
  const CHILD = `ar_${"c".repeat(32)}`;

  it("is answered here: an approval its person decides, and a handoff", () => {
    const waiting: RunDetail["waiting"] = [
      { kind: "approval", id: approval, until: "2026-10-11T11:20:00.000Z", by_caller: true },
      {
        kind: "handoff",
        id: session,
        until: "2026-10-11T10:50:00.000Z",
        by_caller: true,
        run: CHILD,
      },
    ];

    const waits = waitsOf(view({ state: "running", waiting }), NOW);

    expect(waits).toMatchObject([
      { kind: "approval", id: approval, here: true },
      { kind: "handoff", id: session, here: true, run: CHILD },
    ]);
    expect(waits[0]?.left).toBe("50 min left");
    expect(waits[1]?.left).toBe("20 min left");
    expect(waitingText(view({ waiting }))).toBe("Waits for you: an approval and a handoff");
  });

  it("says when another approver decides an approval, which is not answered here", () => {
    const waiting: RunDetail["waiting"] = [
      { kind: "approval", id: approval, until: "2026-10-11T11:20:00.000Z", by_caller: false },
    ];

    const [wait] = waitsOf(view({ waiting }), NOW);

    expect(wait).toMatchObject({ here: false });
    expect(wait?.title).toMatch(/another approver/);
    expect(waitingText(view({ waiting }))).toBe("Waits for an approver");
  });

  it("is nothing on a run that waits on nothing, or that its person cannot read", () => {
    expect(waitsOf(view(), NOW)).toEqual([]);
    expect(waitingText(view({ waiting: [] }))).toBeUndefined();
  });

  it("is polled while a turn runs or something waits, not while the run is idle", () => {
    expect(pollsNow(view({ state: "running" }))).toBe(true);
    expect(pollsNow(view({ state: "idle" }))).toBe(false);
    expect(pollsNow(view({ state: "ended" }))).toBe(false);
  });

  it("keeps polling from the last run it read when one read fails", () => {
    const running = view({ state: "running" });
    const read = AsyncResult.success(running);

    const failed = AsyncResult.failure(Cause.fail("offline"), {
      previousSuccess: Option.some(read),
    });

    expect(lastRun(read)).toBe(running);
    expect(lastRun(failed)).toBe(running);
    expect(pollsNow(lastRun(failed) ?? view())).toBe(true);
    expect(lastRun(AsyncResult.failure(Cause.fail("offline")))).toBeUndefined();
    expect(lastRun(AsyncResult.initial())).toBeUndefined();
  });

  it("arms no read while one is in flight, and stops once the run is gone", () => {
    const running = view({ state: "running" });

    expect(pollStep(AsyncResult.success(running))).toBe("poll");
    // A slow read is not cut short by the next.
    expect(pollStep(AsyncResult.success(running, { waiting: true }))).toBe("hold");
    expect(pollStep(AsyncResult.success(view({ state: "idle" })))).toBe("stop");
    // A failed read polls on from the run it last read.
    expect(
      pollStep(
        AsyncResult.failure(Cause.fail("offline"), {
          previousSuccess: Option.some(AsyncResult.success(running)),
        }),
      ),
    ).toBe("poll");
    // Deleted (or no longer the caller's): no read brings it back.
    expect(
      pollStep(
        AsyncResult.failure(Cause.fail(new ManagementError({ error: "not_found" })), {
          previousSuccess: Option.some(AsyncResult.success(running)),
        }),
      ),
    ).toBe("gone");
  });
});

describe("the transcript", () => {
  const CHILD = `ar_${"c".repeat(32)}`;

  it("shows the model's text, its tool calls and their results, oldest first", () => {
    const items = transcriptItems([
      { role: "user", text: "Find the weather", at: "2026-10-11T10:00:00.000Z" },
      {
        role: "assistant",
        text: "Looking it up.",
        tool_calls: [{ name: "lookup", arguments: '{"query":"weather"}' }],
        at: "2026-10-11T10:00:01.000Z",
      },
      { role: "tool", tool: "lookup", text: "Sunny", at: "2026-10-11T10:00:02.000Z" },
      {
        role: "tool",
        tool: "lookup",
        text: "Rate limited",
        is_error: true,
        at: "2026-10-11T10:00:03.000Z",
      },
      { role: "assistant", text: "It is sunny.", at: "2026-10-11T10:00:04.000Z" },
    ]);

    expect(items).toMatchObject([
      { kind: "input", text: "Find the weather" },
      { kind: "answer", text: "Looking it up." },
      { kind: "tool_call", tool: "lookup", text: '{\n  "query": "weather"\n}' },
      { kind: "tool_result", tool: "lookup", text: "Sunny", error: false },
      { kind: "tool_result", tool: "lookup", text: "Rate limited", error: true },
      { kind: "answer", text: "It is sunny." },
    ]);
  });

  it("links the child runs a run started, and the results they delivered", () => {
    const items = transcriptItems([
      {
        role: "assistant",
        text: "",
        tool_calls: [{ name: "agents_start", arguments: '{"agent":"helper","input":"go"}' }],
        at: "2026-10-11T10:00:00.000Z",
      },
      {
        role: "tool",
        tool: "agents_start",
        text: JSON.stringify({ run: CHILD, turn: "t1", status: "running" }, null, 2),
        at: "2026-10-11T10:00:01.000Z",
      },
      {
        role: "user",
        text: `[agents] Run ${CHILD} (agent helper), which you started, finished its turn t1. Its answer:\n\nDone`,
        at: "2026-10-11T10:00:05.000Z",
      },
    ]);

    expect(items.map((item) => item.child)).toEqual([undefined, CHILD, CHILD]);
    expect(items[2]).toMatchObject({ kind: "delivery" });
  });

  it("links no child run from a tool that does not start one, or a result that names none", () => {
    const items = transcriptItems([
      { role: "tool", tool: "lookup", text: `{"run":"${CHILD}"}`, at: "2026-10-11T10:00:00.000Z" },
      {
        role: "tool",
        tool: "agents_start",
        text: "Unknown agent x.",
        at: "2026-10-11T10:00:01.000Z",
      },
    ]);

    expect(items.map((item) => item.child)).toEqual([undefined, undefined]);
  });
});

describe("the runs list", () => {
  const runs: ReadonlyArray<RunView> = [
    view({ id: "ar_1", access: "starter", cost_micros: 1_234_567 }),
    unstarted({ id: "ar_2", access: "watcher", trigger: "schedule" }),
    view({
      id: "ar_3",
      access: "admin",
      trigger: "mcp",
      starter: { kind: "member", id: "m-bob" },
      state: "running",
    }),
    view({ id: "ar_4", access: "watcher", starter: { kind: "run", id: "ar_1" }, trigger: "mcp" }),
  ];

  it("shows each run's agent, trigger, starter, status, last activity and cost", () => {
    const emails = new Map([["m-bob", "bob@example.com"]]);

    expect(runs.map((run) => runRow(run, NOW, emails))).toMatchObject([
      { agent: "support", trigger: "Chat", starter: "You", status: "Idle", cost: "$1.23" },
      { trigger: "Schedule", starter: "No one: its trigger", cost: "Not known" },
      {
        trigger: "Agents toolkit",
        starter: "bob@example.com",
        status: "Running",
        cancel: true,
      },
      { starter: "Run ar_1", starterRun: "ar_1", cancel: false },
    ]);
    expect(runRow(runs[0]!, NOW, emails).activity).toBe("10 min ago");
  });

  it("says $0.00 for a run with no priced usage, and Not known only when the costs could not be read", () => {
    expect(costText({ cost_micros: 0 })).toBe("$0.00");
    expect(costText({})).toBe("Not known");
  });

  it("filters by why the caller sees each run, with the counts", () => {
    expect(runFilters(runs, true).map((filter) => [filter.id, filter.count])).toEqual([
      ["all", 4],
      ["started", 1],
      ["watching", 2],
      ["org", 1],
    ]);
    // A plain member has no org's runs to see.
    expect(runFilters(runs, false).map((filter) => filter.id)).toEqual([
      "all",
      "started",
      "watching",
    ]);
    expect(filterRuns(runs, "watching").map((run) => run.id)).toEqual(["ar_2", "ar_4"]);
    expect(filterRuns(runs, "org").map((run) => run.id)).toEqual(["ar_3"]);
  });
});

describe("the retention notice", () => {
  it("says when an idle run is pruned under the org's period", () => {
    expect(prunedText(view({ updated_at: "2026-10-11T10:20:00.000Z" }), 30)).toBe(
      "This run is deleted on Nov 10, 2026, 30 days after its last activity, unless it is active again before. Deleting it now is at once.",
    );
  });

  it("says a running run is never pruned, and a period of none keeps runs", () => {
    expect(prunedText(view({ state: "running" }), 30)).toMatch(/never pruned while a turn runs/);
    expect(prunedText(view(), null)).toMatch(/keeps agent runs until they are deleted/);
  });
});

describe("a run's refusal", () => {
  const owner = { role: "owner" as const, platform_admin: false, deployment: { hosted: true } };

  it("links a plan limit to the Billing page for the org's owners and admins on Commissary Cloud", () => {
    const text = '429 {"error":{"code":"plan_limit_reached","message":"Free usage is used up"}}';

    expect(billingLinkOf(text, owner)).toBe("/billing");
    expect(billingLinkOf(text, { ...owner, role: "admin" })).toBe("/billing");
    expect(billingLinkOf(text, { ...owner, role: "member" })).toBeUndefined();
    expect(billingLinkOf(text, { ...owner, deployment: { hosted: false } })).toBeUndefined();
    expect(billingLinkOf("spend_limit_reached", owner)).toBeUndefined();
  });

  it("says why a message or a start was refused", () => {
    expect(runProblem("run_ended", "x")).toMatch(/ended/);
    expect(runProblem("agent_disabled", "x")).toMatch(/disabled/);
    expect(runProblem("forbidden", "x")).toMatch(/metadata/);
    expect(runProblem("not_found", "x")).toMatch(/gone/);
    expect(runProblem(undefined, "boom", "the server said so")).toBe("The server said so.");
  });
});
